import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  attachLaneDiagnostics,
  diagnosticLine,
  laneDiagnosticsEnabled,
} from "../../tests/fixtures/lane-diagnostics.js";

/**
 * The lane's own account of what happened to the document.
 *
 * Every listener the module attaches is an observer, and this suite holds it to
 * that: the fake page below records what was subscribed to and nothing is asked
 * of it beyond subscribing. A diagnostic that changed the document's behaviour
 * would be worse than none, because the run it explained would no longer be the
 * run the lane was meant to be having — which is exactly how the previous
 * attempt at this failed.
 */

type Listener = (argument: never) => void;

function fakePage() {
  const listeners = new Map<string, Listener[]>();

  return {
    events: () => [...listeners.keys()].sort(),
    emit(event: string, argument: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (value: unknown) => void)(argument);
      }
    },
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    url: () => "http://127.0.0.1:3100/settings/appearance",
  };
}

describe("what a lane records about the document", () => {
  test("is off unless the run asks for it", () => {
    expect(laneDiagnosticsEnabled({})).toBe(false);
    expect(laneDiagnosticsEnabled({ REQUESTPORT_E2E_DIAGNOSTICS: "0" })).toBe(
      false,
    );
    expect(
      laneDiagnosticsEnabled({ REQUESTPORT_E2E_DIAGNOSTICS: "true" }),
    ).toBe(false);
    expect(laneDiagnosticsEnabled({ REQUESTPORT_E2E_DIAGNOSTICS: "1" })).toBe(
      true,
    );
  });

  test("subscribes to nothing at all when it is off", () => {
    const page = fakePage();
    const written: string[] = [];

    attachLaneDiagnostics(
      page as unknown as Parameters<typeof attachLaneDiagnostics>[0],
      (line) => written.push(line),
      false,
    );

    expect(page.events()).toEqual([]);
    expect(written).toEqual([]);
  });

  test("watches the document's own loads, and only observes", () => {
    const page = fakePage();
    const written: string[] = [];

    attachLaneDiagnostics(
      page as unknown as Parameters<typeof attachLaneDiagnostics>[0],
      (line) => written.push(line),
      true,
    );

    // The load of the main frame is the one that places a reload against the
    // step that failed, so it is the one this must never stop recording.
    expect(page.events()).toEqual([
      "close",
      "console",
      "load",
      "pageerror",
      "response",
    ]);

    page.emit("load", undefined);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("load:");
    expect(written[0]).toContain("/settings/appearance");
  });

  test("records a failure and a refusal, and stays quiet otherwise", () => {
    const page = fakePage();
    const written: string[] = [];

    attachLaneDiagnostics(
      page as unknown as Parameters<typeof attachLaneDiagnostics>[0],
      (line) => written.push(line),
      true,
    );

    page.emit("console", { text: () => "chatter", type: () => "log" });
    expect(written).toEqual([]);

    page.emit("console", { text: () => "refused", type: () => "error" });
    page.emit("pageerror", { message: "broke" });

    expect(written).toHaveLength(2);
    expect(written[0]).toContain("console:error: refused");
    expect(written[1]).toContain("pageerror: broke");
  });

  test("counts the policy's refusals instead of repeating them", () => {
    const page = fakePage();
    const written: string[] = [];

    attachLaneDiagnostics(
      page as unknown as Parameters<typeof attachLaneDiagnostics>[0],
      (line) => written.push(line),
      true,
    );

    // One local run produced 5,607 of these. Repeating each would bury the
    // loads this exists to show; dropping them without saying so would leave a
    // reader believing the document had been quiet.
    for (let index = 0; index < 3; index += 1) {
      page.emit("console", {
        text: () =>
          "Applying inline style violates the following Content Security Policy directive",
        type: () => "error",
      });
    }

    expect(written).toEqual([]);

    page.emit("close", undefined);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("content-security-refusals: 3");
  });

  test("says nothing about refusals when the policy refused nothing", () => {
    const page = fakePage();
    const written: string[] = [];

    attachLaneDiagnostics(
      page as unknown as Parameters<typeof attachLaneDiagnostics>[0],
      (line) => written.push(line),
      true,
    );

    page.emit("close", undefined);

    expect(written).toEqual([]);
  });

  test("names the request behind a refusal the console leaves anonymous", () => {
    const page = fakePage();
    const written: string[] = [];

    attachLaneDiagnostics(
      page as unknown as Parameters<typeof attachLaneDiagnostics>[0],
      (line) => written.push(line),
      true,
    );

    const response = (status: number) => ({
      request: () => ({ method: () => "POST" }),
      status: () => status,
      url: () => "http://127.0.0.1:3100/settings/projects/new",
    });

    // An answer is only worth a line when it is a refusal; a lane that logged
    // every response would log every asset on every page.
    page.emit("response", response(200));
    page.emit("response", response(304));
    expect(written).toEqual([]);

    page.emit("response", response(400));

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("response:400");
    expect(written[0]).toContain(
      "POST http://127.0.0.1:3100/settings/projects/new",
    );
  });

  test("stamps every line so it reads against the server's output", () => {
    expect(diagnosticLine("load", "/")).toMatch(
      /^\[lane-diagnostic \d{4}-\d{2}-\d{2}T[\d:.]+Z\] load: \/$/u,
    );
  });

  test("watches every page a fixture opens, not only the one specs are handed", () => {
    // The diagnostics were installed on the fixture that hands a spec its page,
    // and the tenant every appearance case runs against is built on a page a
    // fixture opens for itself. CI run 33506245529 lost sixteen WebKit cases to
    // that page and recorded nothing about any of them, because nothing was
    // watching it — the lane's whole account of the failure was two console
    // lines from the two cases that got far enough to use a watched page.
    const fixtureRoot = resolve(import.meta.dirname, "../../tests");
    const opensAPage = (source: string) =>
      /await [\w.?]*newPage\(\)/u.test(source);
    const files = readdirSync(fixtureRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name));
    const sources = files.map(
      (file) => [file, readFileSync(file, "utf8")] as const,
    );
    const opening = sources.filter(([, source]) => opensAPage(source));
    const unwatched = opening
      .filter(([, source]) => !source.includes("attachLaneDiagnostics"))
      .map(([file]) => file.slice(fixtureRoot.length + 1));

    // Planted: a scan that found no page-opening module would report nothing
    // missing and mean nothing.
    expect(opening.length).toBeGreaterThan(0);
    expect(unwatched).toEqual([]);
  });
});
