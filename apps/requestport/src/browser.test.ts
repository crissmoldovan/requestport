import { type SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, test } from "vitest";

import {
  browserCommand,
  browserOpenerFor,
  NO_BROWSER_VARIABLE,
  openBrowser,
} from "./browser.js";

const url =
  "https://rp.example/api/auth/oauth2/authorize?client_id=c&state=s&scope=a%20b";

/** A `spawn` that records each launch and hands back a child it controls. */
function fakeSpawn() {
  const launches: {
    command: string;
    args: readonly string[];
    options: SpawnOptions;
    child: EventEmitter & { unrefs: number; unref(): void };
  }[] = [];
  return {
    launches,
    spawn: (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      const child = Object.assign(new EventEmitter(), {
        unrefs: 0,
        unref() {
          child.unrefs += 1;
        },
      });
      launches.push({ command, args, options, child });
      return child;
    },
  };
}

describe("the program each platform hands a URL to", () => {
  test("open on macOS, rundll32 on Windows, xdg-open elsewhere, the URL one argument", () => {
    expect(browserCommand(url, "darwin")).toEqual({
      command: "open",
      args: [url],
    });
    expect(browserCommand(url, "win32")).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(browserCommand(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
    });
    expect(browserCommand(url, "freebsd")?.command).toBe("xdg-open");
  });

  test("only an http or https URL is handed over", () => {
    for (const refused of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "vscode://extension/run",
      "not a url",
      "",
    ]) {
      expect(browserCommand(refused, "darwin"), refused).toBeUndefined();
    }
    expect(browserCommand("http://127.0.0.1:4000/x", "darwin")).toBeDefined();
  });
});

describe("opening", () => {
  test("launches the program detached, its output ignored, and does not wait for it", () => {
    const fake = fakeSpawn();

    openBrowser(url, { platform: "darwin", spawn: fake.spawn });

    expect(fake.launches).toHaveLength(1);
    const [launch] = fake.launches;
    expect(launch?.command).toBe("open");
    expect(launch?.args).toEqual([url]);
    expect(launch?.options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(launch?.child.unrefs).toBe(1);
  });

  test("a launch that fails, by event or by throwing, is not reported", () => {
    const fake = fakeSpawn();
    openBrowser(url, { platform: "linux", spawn: fake.spawn });

    expect(() =>
      fake.launches[0]?.child.emit("error", new Error(`spawn xdg-open ${url}`)),
    ).not.toThrow();
    expect(() =>
      openBrowser(url, {
        platform: "linux",
        spawn: () => {
          throw new Error("EAGAIN");
        },
      }),
    ).not.toThrow();
  });

  test("a program that does not exist, launched for real, fails quietly", async () => {
    // The real `spawn`, of a program no machine has: Node reports ENOENT as
    // an `error` event, which would end this process if nothing listened.
    openBrowser(url, {
      platform: "linux",
      spawn: (_command, args, options) =>
        spawn("requestport-no-such-browser-program", [...args], options),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  test("a URL it refuses launches nothing", () => {
    const fake = fakeSpawn();

    openBrowser("file:///etc/passwd", {
      platform: "darwin",
      spawn: fake.spawn,
    });

    expect(fake.launches).toEqual([]);
  });
});

describe("the opener a command uses", () => {
  test("none with --no-browser, or with REQUESTPORT_NO_BROWSER set", () => {
    expect(browserOpenerFor({}, true)).toBeUndefined();
    expect(browserOpenerFor({ [NO_BROWSER_VARIABLE]: "1" }, false)).toBe(
      undefined,
    );
  });

  test("openBrowser otherwise, the variable empty included", () => {
    const fake = fakeSpawn();
    const opener = browserOpenerFor({ [NO_BROWSER_VARIABLE]: "" }, false, {
      platform: "darwin",
      spawn: fake.spawn,
    });

    opener?.(url);

    expect(fake.launches.map((launch) => launch.args)).toEqual([[url]]);
  });
});
