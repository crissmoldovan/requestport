/**
 * The inert stand-in for apps/web's scenario-fault register (Plan 13, H.7;
 * ruling 174). requestport's self-host Next build puts this module where the
 * real one would be (`../web/test-seams.ts`). Here the register refuses
 * every run, as the real one refuses outside E2E mode: silently, holding
 * nothing. So no request is ever inside a fault, and every effect is
 * `none`. Nothing else of the real module is here: no register, no cookie,
 * no list of faults.
 */

/** Refused: this build opens no run. */
export function registerE2EScenarioRun(
  _namespace?: unknown,
  _fault?: unknown,
  _env?: unknown,
): void {}

export function releaseE2EScenarioRun(
  _namespace?: unknown,
  _env?: unknown,
): void {}

export function forgetE2EScenarioRuns(_env?: unknown): void {}

export function isE2EScenarioRunActive(
  _namespace?: unknown,
  _env?: unknown,
): boolean {
  return false;
}

export function e2eScenarioNamespaceFrom(_cookieHeader?: unknown): null {
  return null;
}

export function e2eScenarioFaultFor(_input?: unknown): null {
  return null;
}

export async function waitForE2EScenarioRelease(
  _namespace?: unknown,
  _options?: unknown,
): Promise<"released"> {
  return "released";
}

export function e2eScenarioReadEffect(_input?: unknown): "none" {
  return "none";
}

export function e2eScenarioAppearanceEffect(_fault?: unknown): "none" {
  return "none";
}

export function e2eScenarioProviderEffect(_fault?: unknown): "none" {
  return "none";
}
