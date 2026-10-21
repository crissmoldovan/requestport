import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  E2E_SCENARIO_COOKIE,
  forgetE2EScenarioRuns,
  registerE2EScenarioRun,
  releaseE2EScenarioRun,
} from "./e2e-scenario-fault.js";
import {
  applyE2EScenarioBoundary,
  applyE2EScenarioPageEffect,
  isE2EScenarioProviderUnavailable,
  readE2EScenarioRequest,
  scenarioRouteFailure,
} from "./server-scenario-boundary.js";

const namespace = "3f1d2c4b-5a6e-4f70-8912-abcdef012345";
const cookieHeader = `${E2E_SCENARIO_COOKIE}=${namespace}`;

/**
 * The adapters allowed to consult the register, and the two surfaces whose own
 * boundaries can only be reached through it.
 *
 * A closed list rather than a comment: the whole point of routing every fault
 * through a register is that the set of places a synthetic condition can enter
 * the application is small enough to read, and a new importer is a deliberate
 * edit rather than a quiet widening.
 */
const scenarioConsumers = [
  "src/app/(app)/slack/page.tsx",
  "src/app/(auth)/auth-error/page.tsx",
  "src/lib/server-administration-actions.ts",
  "src/lib/server-appearance.ts",
  "src/lib/server-application-context.ts",
  "src/lib/server-scenario-boundary.ts",
  "src/test/e2e-scenarios.ts",
];

const webRoot = resolve(import.meta.dirname, "..", "..");

function sourceModules() {
  return readdirSync(resolve(webRoot, "src"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) =>
      relative(webRoot, resolve(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .filter((file) => !/\.test\.tsx?$/u.test(file))
    .sort();
}

/**
 * The ambient node lane is deliberately *not* the guarded local environment —
 * `route.test.ts` pins that the hook is disabled there — so a register call
 * made under it is a no-op and every hold would resolve at once. Standing the
 * guarded environment up for these cases is what makes the hold observable at
 * all; without it the wait assertion could not fail.
 */
describe("the request-scoped scenario boundary", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("REQUESTPORT_E2E_MODE", "1");
    vi.stubEnv(
      "REQUESTPORT_E2E_TOKEN",
      "scenario-token-that-is-at-least-thirty-two-characters",
    );
    forgetE2EScenarioRuns();
  });

  afterEach(() => {
    forgetE2EScenarioRuns();
    vi.unstubAllEnvs();
  });

  test("answers nothing at all when there is no request to read", async () => {
    // Rendered-to-static-markup suites have no request store, and several
    // surfaces are rendered that way. "There is no run" is the honest answer
    // there; throwing would make consulting the register a change to the
    // surface under test rather than an addition to it.
    registerE2EScenarioRun(namespace, "error");

    expect(await readE2EScenarioRequest()).toEqual({
      cookieHeader: null,
      fault: null,
      isActionDispatch: false,
    });
    await expect(applyE2EScenarioBoundary()).resolves.toBeUndefined();
    await expect(isE2EScenarioProviderUnavailable()).resolves.toBe(false);
  });

  test("raises exactly the fixed failure, carrying nothing else", async () => {
    await expect(
      applyE2EScenarioPageEffect("error", cookieHeader),
    ).rejects.toThrow(
      new RegExp(`^${scenarioRouteFailure.replaceAll(" ", "\\s")}$`, "u"),
    );
  });

  test("answers not-found through the framework's own signal", async () => {
    // `notFound()` throws a tagged error the App Router recognises; a boundary
    // that threw an ordinary error would render the error boundary instead, and
    // the two are different cases in the table.
    await expect(
      applyE2EScenarioPageEffect("not-found", cookieHeader),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  test("does nothing for the effects another adapter owns", async () => {
    for (const effect of ["conflict", "member-denied", "none"] as const) {
      await expect(
        applyE2EScenarioPageEffect(effect, cookieHeader),
      ).resolves.toBeUndefined();
    }
  });

  test("holds until the run that opened the hold is released", async () => {
    registerE2EScenarioRun(namespace, "loading");
    const held = applyE2EScenarioPageEffect("hold", cookieHeader);
    let settled = false;
    void held.then(() => {
      settled = true;
    });

    await new Promise((wake) => setTimeout(wake, 120));
    expect(settled).toBe(false);

    releaseE2EScenarioRun(namespace);
    await expect(held).resolves.toBeUndefined();
  });

  test("holds not at all when nothing opened a run under that cookie", async () => {
    await expect(
      applyE2EScenarioPageEffect("hold", cookieHeader),
    ).resolves.toBeUndefined();
  });

  test("is consulted by exactly the adapters that own a synthetic state", () => {
    const importers = sourceModules().filter((file) => {
      const source = readFileSync(resolve(webRoot, file), "utf8");

      return (
        source.includes("e2e-scenario-fault.js") ||
        source.includes("server-scenario-boundary.js")
      );
    });

    expect(importers).toEqual(scenarioConsumers);
  });
});
