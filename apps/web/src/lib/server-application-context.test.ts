import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

/**
 * The one conflict adapter that is not reached through the shared context.
 *
 * `raiseScenarioConflict` is called by the administration action wiring, whose
 * commands resolve their own session, and until now nothing asserted anything
 * about it: the browser case that was supposed to be its proof passed with the
 * raise removed, because it drove a form whose *genuine* refusal printed the
 * same sentence.
 *
 * The module reaches the database and the request store at import, so both are
 * replaced here. What is under test is the decision, which is pure.
 */
vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({}),
}));
// The web root, whose storage its reads build their repository over (Plan 13,
// G.3).
vi.mock("./server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));
vi.mock("@requestport/auth/server", () => ({
  requireHumanSession: async () => {
    throw new Error("unused");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => new Map(),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("unused");
  },
}));

const { raiseScenarioConflict } = await import(
  "./server-application-context.js"
);

describe("the administration conflict adapter", () => {
  test("raises the fixed conflict for an open conflict run", () => {
    // The once-per-request marker is a React request cache, which memoises
    // nothing outside a request, so the *second* raise is the browser case's
    // to prove: a conflict raised on the action and again on the re-render
    // puts the surface on its error boundary instead of drawing the receipt.
    let raised: unknown;
    try {
      raiseScenarioConflict("conflict");
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(DomainError);
    // The closed code the action modules map, and a fixed message naming no
    // case, no surface and no value.
    expect({
      code: (raised as DomainError).code,
      message: (raised as DomainError).message,
    }).toEqual({ code: "conflict", message: "E2E scenario conflicting write" });
  });

  test("raises nothing for a request that is inside no run", () => {
    expect(() => raiseScenarioConflict(null)).not.toThrow();
  });

  test("raises nothing for a fault another adapter owns", () => {
    for (const fault of [
      "error",
      "global_error",
      "loading",
      "member_denied",
      "none",
      "not_found",
      "provider_unavailable",
    ] as const) {
      expect(() => raiseScenarioConflict(fault)).not.toThrow();
    }
  });
});
