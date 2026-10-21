import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  developmentFastRefreshFailure,
  developmentStyleRefusal,
  enginePrefetchRefusal,
} from "../../tests/fixtures/acceptance-run.js";

/**
 * What the console-hygiene case is allowed to forgive.
 *
 * The claim it makes is about the *application*: nothing this product renders
 * writes an error, a hydration complaint, or a Content Security Policy refusal
 * to the console. It makes that claim against `next dev`, which writes to the
 * console about itself — it serves every stylesheet as an injected `<style>`
 * the page's own policy refuses, and it keeps a Fast Refresh client that talks
 * to the build over resources no production build has.
 *
 * So there are exactly two tolerances, each narrow, and this is where they are
 * held to being narrow. Each line says whether it was seen or composed. The
 * refusals, the blocked connections and the bare resource failure were
 * reproduced on `2026-08-31` under Playwright `1.62.1` against a page serving
 * shape of policy this application serves; the Fast Refresh line is the one CI
 * run 33355052056 failed the WebKit lane on; the rest are written here to probe
 * edges no run has crossed yet. The distinction is asserted rather than left to
 * the reader, because a tolerance argued entirely from lines its author
 * invented is a tolerance argued from nothing.
 *
 * The two engines say the same thing in different words, and that is the whole
 * reason the tolerance had to grow: it was written in Chromium's, and WebKit
 * had never run. It has not been widened past that. A refusal naming any other
 * directive, and a failure naming any other resource, still fails the case.
 */

type ConsoleBucket = "csp" | "errors";

type ObservedLine = Readonly<{
  bucket: ConsoleBucket;
  engine: "chromium" | "webkit";
  /** Whether this exact line was seen, rather than composed to probe an edge. */
  seen: boolean;
  /** Whether this line is the development server talking about itself. */
  tolerated: boolean;
  text: string;
  why: string;
}>;

const observed: readonly ObservedLine[] = [
  {
    bucket: "csp",
    engine: "chromium",
    seen: true,
    text: "Applying inline style violates the following Content Security Policy directive 'style-src-elem 'self' 'nonce-abc''. Either the 'unsafe-inline' keyword, a hash ('sha256-iEVGxKLx+0na6M5/ZMcf4NsQvcN7WlHucqi4A0LN7IM='), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked.",
    tolerated: true,
    why: "the development server's own injected stylesheet, in Chromium's words",
  },
  {
    bucket: "csp",
    engine: "webkit",
    seen: true,
    text: "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
    tolerated: true,
    why: "the same stylesheet, in WebKit's words",
  },
  {
    bucket: "csp",
    engine: "webkit",
    seen: true,
    text: "Refused to execute a script because its hash, its nonce, or 'unsafe-inline' appears in neither the script-src directive nor the default-src directive of the Content Security Policy.",
    tolerated: false,
    why: "a script refusal is the application's, however similar the sentence",
  },
  {
    bucket: "csp",
    engine: "webkit",
    seen: true,
    text: "Refused to connect to http://127.0.0.1:3400/blocked because it does not appear in the connect-src directive of the Content Security Policy.",
    tolerated: false,
    why: "a connection the document was refused is the application's",
  },
  {
    bucket: "csp",
    engine: "chromium",
    seen: true,
    text: "Connecting to 'http://127.0.0.1:3400/blocked' violates the following Content Security Policy directive: \"connect-src 'self'\". The action has been blocked.",
    tolerated: false,
    why: "the same refusal in Chromium's words, and equally the application's",
  },
  {
    bucket: "csp",
    engine: "chromium",
    seen: false,
    text: "Applying inline style violates the following Content Security Policy directive 'style-src-attr 'none''. The action has been blocked.",
    tolerated: false,
    why: "a style *attribute* is written by the page, not injected by the server",
  },
  {
    bucket: "errors",
    engine: "webkit",
    seen: true,
    text: "/127.0.0.1:3100/_next/static/webpack/1db7049696b5d83e.webpack.hot-update.json due to access control checks.",
    tolerated: true,
    why: "the Fast Refresh transport, which only `next dev --webpack` serves",
  },
  {
    bucket: "errors",
    engine: "chromium",
    seen: false,
    text: "Failed to load resource: the server responded with a status of 404 (Not Found) http://127.0.0.1:3100/_next/static/webpack/1db7049696b5d83e.webpack.hot-update.js",
    tolerated: true,
    why: "the same transport failing the other way, after a restart changed the build",
  },
  {
    bucket: "errors",
    engine: "webkit",
    seen: false,
    text: "/127.0.0.1:3100/api/v1/whoami due to access control checks.",
    tolerated: false,
    why: "the same wording about one of the application's own routes",
  },
  {
    bucket: "errors",
    engine: "chromium",
    seen: true,
    text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
    tolerated: false,
    why: "a resource the page asked for and did not get, naming nothing dev-only",
  },
  {
    bucket: "errors",
    engine: "chromium",
    seen: false,
    text: "TypeError: Cannot read properties of undefined (reading 'organizationId')",
    tolerated: false,
    why: "the application throwing, which is the whole point of the case",
  },
  {
    bucket: "errors",
    engine: "webkit",
    seen: false,
    text: "/127.0.0.1:3100/_next/static/chunks/app/layout.js due to access control checks.",
    tolerated: false,
    why: "a chunk the application itself loads, dev-only path or not",
  },
  {
    bucket: "errors",
    engine: "webkit",
    seen: true,
    text: "/127.0.0.1:3100/agents?_rsc=tXyZJ52UQVBCVsD3 due to access control checks.",
    tolerated: true,
    why: "a route prefetch the engine refused before it left the browser",
  },
  {
    bucket: "errors",
    engine: "webkit",
    seen: false,
    text: "/127.0.0.1:3100/agents?_rsc=tXyZJ52UQVBCVsD3 failed with status 500",
    tolerated: false,
    why: "a prefetch that did reach the server and was answered badly",
  },
  {
    bucket: "errors",
    engine: "chromium",
    seen: false,
    text: "/127.0.0.1:3100/agents due to access control checks.",
    tolerated: false,
    why: "the refusal wording about an address that is not a prefetch",
  },
];

const tolerates: Readonly<Record<ConsoleBucket, (text: string) => boolean>> = {
  csp: developmentStyleRefusal,
  errors: (text) =>
    developmentFastRefreshFailure(text) || enginePrefetchRefusal(text),
};

const driverSource = readFileSync(
  resolve(
    import.meta.dirname,
    "../../tests/fixtures/acceptance-appearance-drivers.ts",
  ),
  "utf8",
);

describe("what the console-hygiene case forgives the development server", () => {
  test("reads each engine's words for the same condition, and nothing else", () => {
    // Planted in both directions on purpose. A tolerance that answered `true`
    // to everything would make the case unable to fail at all, and one that
    // answered `false` to everything is what the lane had — the reason a run on
    // an engine that had never run reported the development server's own
    // stylesheet refusals, and its Fast Refresh failure, against a product that
    // caused neither.
    expect(
      observed.map((line) => ({
        engine: line.engine,
        tolerated: tolerates[line.bucket](line.text),
        why: line.why,
      })),
    ).toEqual(
      observed.map((line) => ({
        engine: line.engine,
        tolerated: line.tolerated,
        why: line.why,
      })),
    );
  });

  test("argues each tolerance from at least one line something really said", () => {
    // The guard on the table itself. Every row could be composed and every
    // reading above would still agree with every expectation above — a closed
    // loop proving only that the author is consistent with himself. So each
    // bucket has to carry a tolerated line that was actually seen, and so does
    // the refusing side, in each engine that has run.
    for (const bucket of Object.keys(tolerates) as ConsoleBucket[]) {
      const seen = observed.filter(
        (line) => line.bucket === bucket && line.seen,
      );

      expect({
        bucket,
        forgiven: seen.some((line) => line.tolerated),
        refused: seen.some((line) => !line.tolerated),
      }).toEqual({ bucket, forgiven: true, refused: true });
    }

    for (const engine of ["chromium", "webkit"] as const) {
      expect({
        engine,
        seen: observed.some((line) => line.engine === engine && line.seen),
      }).toEqual({ engine, seen: true });
    }
  });

  test("keeps a tolerance for each bucket the console is judged in", () => {
    // The tolerances only mean anything where they are applied, and the case
    // asserts on two buckets. Taking either filter back out leaves every
    // reading above unchanged and the case failing on the development server
    // again, so the driver is read for both.
    const applied = Object.keys(tolerates).filter((bucket) =>
      new RegExp(
        String.raw`consoleLog\.${bucket}[\s\S]{0,120}?development\w+\s*\(`,
        "u",
      ).test(driverSource),
    );

    expect(applied.sort()).toEqual(Object.keys(tolerates).sort());
  });
});
