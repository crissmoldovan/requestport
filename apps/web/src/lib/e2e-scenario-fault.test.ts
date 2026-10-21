import { beforeEach, describe, expect, test } from "vitest";

import {
  E2E_SCENARIO_COOKIE,
  e2eScenarioAppearanceEffect,
  e2eScenarioFaultFor,
  e2eScenarioFaults,
  e2eScenarioProviderEffect,
  e2eScenarioReadEffect,
  forgetE2EScenarioRuns,
  isE2EScenarioRunActive,
  registerE2EScenarioRun,
  releaseE2EScenarioRun,
  waitForE2EScenarioRelease,
} from "./e2e-scenario-fault.js";

const namespace = "3f1d2c4b-5a6e-4f70-8912-abcdef012345";
const guarded = {
  NODE_ENV: "test",
  REQUESTPORT_E2E_MODE: "1",
  REQUESTPORT_E2E_TOKEN:
    "scenario-token-that-is-at-least-thirty-two-characters",
};

function cookie(value: string) {
  return `theme=dark; ${E2E_SCENARIO_COOKIE}=${value}; other=1`;
}

describe("the scenario fault registry", () => {
  beforeEach(() => {
    forgetE2EScenarioRuns(guarded);
  });

  test("declares the same closed fault vocabulary the catalogue uses", () => {
    expect([...e2eScenarioFaults]).toEqual([...e2eScenarioFaults].sort());
    expect(e2eScenarioFaults).toContain("none");
  });

  test("answers a registered namespace with the fault it was opened for", () => {
    registerE2EScenarioRun(namespace, "loading", guarded);

    expect(
      e2eScenarioFaultFor({ cookieHeader: cookie(namespace), env: guarded }),
    ).toBe("loading");
    expect(isE2EScenarioRunActive(namespace, guarded)).toBe(true);
  });

  test("answers nothing at all once the run is released", () => {
    registerE2EScenarioRun(namespace, "error", guarded);
    releaseE2EScenarioRun(namespace, guarded);

    expect(
      e2eScenarioFaultFor({ cookieHeader: cookie(namespace), env: guarded }),
    ).toBeNull();
    expect(isE2EScenarioRunActive(namespace, guarded)).toBe(false);
  });

  test("makes the cookie value inert on its own", () => {
    // The value a browser carries is a UUID and nothing else. What gives it a
    // meaning is a run the *guarded* hook opened in this process; a cookie
    // naming a namespace nothing opened is the same as no cookie, which is what
    // keeps this from being a general fault-injection primitive.
    for (const value of [
      namespace,
      "__proto__",
      "constructor",
      "loading",
      "11111111-2222-4333-8444-555555555555",
      "",
    ]) {
      expect({
        fault: e2eScenarioFaultFor({
          cookieHeader: cookie(value),
          env: guarded,
        }),
        value,
      }).toEqual({ fault: null, value });
    }
  });

  test("reads no fault out of an absent or malformed cookie header", () => {
    registerE2EScenarioRun(namespace, "not_found", guarded);

    for (const header of [
      null,
      "",
      "=",
      "theme=dark",
      `${E2E_SCENARIO_COOKIE}`,
      `${E2E_SCENARIO_COOKIE}=`,
      `not-${E2E_SCENARIO_COOKIE}=${namespace}`,
    ]) {
      expect({
        fault: e2eScenarioFaultFor({ cookieHeader: header, env: guarded }),
        header,
      }).toEqual({ fault: null, header });
    }
  });

  test("refuses to register a run outside the guarded local environment", () => {
    for (const env of [
      { ...guarded, NODE_ENV: "production" },
      { ...guarded, REQUESTPORT_E2E_MODE: undefined },
      { ...guarded, REQUESTPORT_E2E_TOKEN: "short" },
    ]) {
      registerE2EScenarioRun(namespace, "error", env);

      expect({
        env: env.NODE_ENV,
        registered: isE2EScenarioRunActive(namespace, guarded),
      }).toEqual({ env: env.NODE_ENV, registered: false });
    }
  });

  test("answers nothing in a production deployment that somehow holds a run", () => {
    registerE2EScenarioRun(namespace, "error", guarded);

    for (const env of [
      { ...guarded, NODE_ENV: "production" },
      { ...guarded, REQUESTPORT_E2E_MODE: "0" },
      { ...guarded, REQUESTPORT_E2E_TOKEN: undefined },
    ]) {
      expect({
        fault: e2eScenarioFaultFor({
          cookieHeader: cookie(namespace),
          env,
        }),
        mode: env.REQUESTPORT_E2E_MODE,
        node: env.NODE_ENV,
      }).toEqual({
        fault: null,
        mode: env.REQUESTPORT_E2E_MODE,
        node: env.NODE_ENV,
      });
    }
  });

  test("registers nothing for a namespace that is not a generated one", () => {
    for (const rejected of ["", "not-a-uuid", `${namespace} `, "SELECT 1"]) {
      registerE2EScenarioRun(rejected, "error", guarded);

      expect({
        registered: e2eScenarioFaultFor({
          cookieHeader: cookie(rejected),
          env: guarded,
        }),
        rejected,
      }).toEqual({ registered: null, rejected });
    }
  });

  test("waits for a held run to be released, and gives up on its own", async () => {
    registerE2EScenarioRun(namespace, "loading", guarded);
    const held = waitForE2EScenarioRelease(namespace, {
      env: guarded,
      capMs: 5_000,
      pollMs: 10,
    });
    let settled = false;
    void held.then(() => {
      settled = true;
    });

    await new Promise((wake) => setTimeout(wake, 50));
    expect(settled).toBe(false);

    releaseE2EScenarioRun(namespace, guarded);
    expect(await held).toBe("released");

    registerE2EScenarioRun(namespace, "loading", guarded);
    expect(
      await waitForE2EScenarioRelease(namespace, {
        env: guarded,
        capMs: 30,
        pollMs: 10,
      }),
    ).toBe("capped");
  });
});

describe("what one fault asks an adapter to do", () => {
  test("routes every fault to exactly one adapter", () => {
    // Each fault is owned by one adapter and is inert in the others, so a
    // surface cannot be put into two synthetic states at once and no adapter
    // has to know what the others do with a value it ignores.
    const routed = e2eScenarioFaults.map((fault) => ({
      appearance: e2eScenarioAppearanceEffect(fault),
      context: e2eScenarioReadEffect({ fault, isActionDispatch: false }),
      fault,
      provider: e2eScenarioProviderEffect(fault),
    }));

    expect(routed).toEqual([
      {
        appearance: "none",
        context: "none",
        fault: "conflict",
        provider: "none",
      },
      {
        appearance: "none",
        context: "error",
        fault: "error",
        provider: "none",
      },
      {
        appearance: "global-error",
        context: "none",
        fault: "global_error",
        provider: "none",
      },
      {
        appearance: "none",
        context: "hold",
        fault: "loading",
        provider: "none",
      },
      {
        appearance: "none",
        context: "member-denied",
        fault: "member_denied",
        provider: "none",
      },
      { appearance: "none", context: "none", fault: "none", provider: "none" },
      {
        appearance: "none",
        context: "not-found",
        fault: "not_found",
        provider: "none",
      },
      {
        appearance: "none",
        context: "none",
        fault: "provider_unavailable",
        provider: "unavailable",
      },
    ]);
  });

  test("raises a conflict only where a write is actually being dispatched", () => {
    // The same adapter answers a rendered document and a dispatched Server
    // Action, and a conflict is a *write* outcome: raising one while a page was
    // being read would put the surface on its error boundary and prove nothing
    // about the receipt a conflicting write draws.
    expect(
      e2eScenarioReadEffect({ fault: "conflict", isActionDispatch: true }),
    ).toBe("conflict");
    expect(
      e2eScenarioReadEffect({ fault: "conflict", isActionDispatch: false }),
    ).toBe("none");
    expect(
      e2eScenarioReadEffect({ fault: "error", isActionDispatch: true }),
    ).toBe("error");
  });

  test("asks for nothing at all when no run is open", () => {
    expect(e2eScenarioReadEffect({ fault: null, isActionDispatch: true })).toBe(
      "none",
    );
    expect(e2eScenarioAppearanceEffect(null)).toBe("none");
    expect(e2eScenarioProviderEffect(null)).toBe("none");
  });
});
