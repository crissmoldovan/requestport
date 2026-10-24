import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

/*
 * Starting Next from the self-host build's standalone output depends on a
 * private Next internal (manifest-h.md §2.7.1): the host sets
 * __NEXT_PRIVATE_STANDALONE_CONFIG to required-server-files.json's `config`
 * before it loads `next`, and Next's loadConfig then returns that object
 * instead of reading next.config.ts. Nothing public promises that, so this
 * runs the installed loadConfig, resolved from apps/web as the build resolves
 * it, and fails when the variable stops being read or `next` leaves 16.4.2
 * (the manifest's Re-check when; re-checked at 16.3.8 on 2026-10-09, after
 * #213 moved apps/web from 16.3.1, and at 16.4.2 on 2026-10-23, after ruling
 * 247 moved it from 16.3.8, by the three cases below).
 *
 * `requestport start` also relies on the configuration being cached per
 * phase and directory in the process (`../serve/web.ts`): it loads it once
 * with logging off before Next's router loads it with logging on, so the
 * router writes no "Running next.config took …" line to standard output.
 */
const VARIABLE = "__NEXT_PRIVATE_STANDALONE_CONFIG";
const webRequire = createRequire(
  new URL("../../../web/package.json", import.meta.url),
);

type LoadConfig = (
  phase: string,
  dir: string,
  options?: { silent?: boolean },
) => Promise<Record<string, unknown>>;

const loadConfig = (
  webRequire("next/dist/server/config.js") as { default: LoadConfig }
).default;
const { PHASE_PRODUCTION_SERVER } = webRequire(
  "next/dist/shared/lib/constants.js",
) as { PHASE_PRODUCTION_SERVER: string };

const directories: string[] = [];

// A directory with no next.config of its own, so the only config Next could
// return besides its defaults is the variable's. Each case gets a new one:
// loadConfig caches by directory.
function emptyProjectDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "requestport-standalone-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the private standalone variable, in the installed next", () => {
  test("next is 16.4.2", () => {
    expect(
      (webRequire("next/package.json") as { version: string }).version,
    ).toBe("16.4.2");
  });

  test("loadConfig returns the variable's config as it was given", async () => {
    const config = {
      distDir: ".next-self-host",
      output: "standalone",
      requestportProbe: "the variable's own object",
    };
    vi.stubEnv(VARIABLE, JSON.stringify(config));

    expect(
      await loadConfig(PHASE_PRODUCTION_SERVER, emptyProjectDirectory(), {
        silent: true,
      }),
    ).toStrictEqual(config);
  });

  test("without the variable, the same call answers Next's defaults", async () => {
    vi.stubEnv(VARIABLE, undefined);

    const config = await loadConfig(
      PHASE_PRODUCTION_SERVER,
      emptyProjectDirectory(),
      { silent: true },
    );

    expect(config.distDir).toBe(".next");
    expect(config).not.toHaveProperty("requestportProbe");
  });

  test("a load with logging on writes Running next.config to standard output, and none after a silent load of the same phase and directory", async () => {
    vi.stubEnv(VARIABLE, JSON.stringify({ distDir: ".next-self-host" }));
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const running = () =>
      logged.mock.calls.filter((call) =>
        String(call[0]).includes("Running next.config took"),
      ).length;

    await loadConfig(PHASE_PRODUCTION_SERVER, emptyProjectDirectory(), {
      silent: false,
    });
    expect(running()).toBe(1);

    const primed = emptyProjectDirectory();
    await loadConfig(PHASE_PRODUCTION_SERVER, primed, { silent: true });
    await loadConfig(PHASE_PRODUCTION_SERVER, primed, { silent: false });
    expect(running()).toBe(1);
    logged.mockRestore();
  });
});
