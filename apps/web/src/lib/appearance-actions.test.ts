import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  type AppearanceActionState,
  appearanceActionMessages,
  appearanceDefaultDestination,
  appearanceInheritValue,
} from "../app/(app)/settings/appearance/action-state.js";
import {
  type AppearanceActionDependencies,
  createAppearanceActions,
} from "./appearance-actions.js";

const userId = "user_01HZY0000000000000000000";
const organizationId = "00000000-0000-4000-8000-000000000001";
const idempotencyKey = "appearance-personal-render-nonce-0001";

function formData(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

function personalForm(overrides: Record<string, string> = {}) {
  return formData({
    density: appearanceInheritValue,
    expectedVersion: "0",
    idempotencyKey,
    mode: appearanceInheritValue,
    renderContext: "v1.personal.token",
    returnTo: "/requests?view=inbox",
    theme: "cue",
    ...overrides,
  });
}

function organizationForm(overrides: Record<string, string> = {}) {
  return formData({
    density: "normal",
    expectedVersion: "1",
    idempotencyKey,
    mode: "dark",
    renderContext: "v1.organization.token",
    returnTo: "/settings/appearance",
    theme: "cue",
    ...overrides,
  });
}

type Harness = {
  actions: ReturnType<typeof createAppearanceActions>;
  dependencies: {
    [K in keyof AppearanceActionDependencies]: ReturnType<typeof vi.fn>;
  };
};

function harness(
  overrides: Partial<AppearanceActionDependencies> = {},
): Harness {
  const dependencies = {
    enforceRateLimit: vi.fn(async () => {}),
    loadActor: vi.fn(async () => ({ organizationId, userId })),
    revalidate: vi.fn(() => {}),
    updateOrganizationDefaults: vi.fn(async () => {}),
    updatePersonalPreferences: vi.fn(async () => {}),
    verifyFormContext: vi.fn(() => true),
    ...overrides,
  } as unknown as Harness["dependencies"];

  return {
    actions: createAppearanceActions(
      dependencies as unknown as AppearanceActionDependencies,
    ),
    dependencies,
  };
}

function expectGlobalError(
  state: AppearanceActionState,
  code: string,
): asserts state is Extract<AppearanceActionState, { status: "global_error" }> {
  expect(state.status).toBe("global_error");
  expect(state.status === "global_error" && state.code).toBe(code);
}

describe("personal appearance action", () => {
  test("submits the validated triple, metadata, and destination", async () => {
    const { actions, dependencies } = harness();

    const state = await actions.updatePersonalPreferences(personalForm());

    expect(state).toEqual({
      destination: "/requests?view=inbox",
      status: "success",
    });
    expect(dependencies.updatePersonalPreferences).toHaveBeenCalledWith({
      meta: { expectedVersion: 0, idempotencyKey },
      overrides: { density: null, mode: null, theme: "cue" },
      userId,
    });
    expect(dependencies.revalidate).toHaveBeenCalledTimes(1);
  });

  test("accepts a reset that clears every axis to inherit", async () => {
    const { actions, dependencies } = harness();

    const state = await actions.updatePersonalPreferences(
      personalForm({
        expectedVersion: "3",
        theme: appearanceInheritValue,
      }),
    );

    expect(state.status).toBe("success");
    expect(dependencies.updatePersonalPreferences).toHaveBeenCalledWith({
      meta: { expectedVersion: 3, idempotencyKey },
      overrides: { density: null, mode: null, theme: null },
      userId,
    });
  });

  test("never trusts a user or organization identifier from the form", async () => {
    const { actions, dependencies } = harness();

    await actions.updatePersonalPreferences(
      personalForm({
        organizationId: "00000000-0000-4000-8000-0000000000ff",
        userId: "user_attacker",
      }),
    );

    expect(dependencies.updatePersonalPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
    );
    expect(
      JSON.stringify(dependencies.updatePersonalPreferences.mock.calls),
    ).not.toContain("user_attacker");
  });

  test("verifies the render context against the freshly resolved actor", async () => {
    const { actions, dependencies } = harness();

    await actions.updatePersonalPreferences(personalForm());

    expect(dependencies.verifyFormContext).toHaveBeenCalledWith({
      expected: { actorId: userId, organizationId: null },
      token: "v1.personal.token",
    });
  });

  test("writes nothing when the render context fails", async () => {
    const { actions, dependencies } = harness({
      verifyFormContext: () => false,
    });

    const state = await actions.updatePersonalPreferences(personalForm());

    expect(state).toEqual({
      message: appearanceActionMessages.context_conflict,
      status: "context_conflict",
    });
    expect(dependencies.updatePersonalPreferences).not.toHaveBeenCalled();
    expect(dependencies.revalidate).not.toHaveBeenCalled();
  });

  test("stays valid when the current organization changed under it", async () => {
    const { actions } = harness({
      loadActor: async () => ({
        organizationId: "00000000-0000-4000-8000-00000000000f",
        userId,
      }),
    });

    const state = await actions.updatePersonalPreferences(personalForm());

    expect(state.status).toBe("success");
  });

  test("works for a signed-in user with no organization at all", async () => {
    const { actions, dependencies } = harness({
      loadActor: async () => ({ organizationId: null, userId }),
    });

    const state = await actions.updatePersonalPreferences(personalForm());

    expect(state.status).toBe("success");
    expect(dependencies.updatePersonalPreferences).toHaveBeenCalledTimes(1);
  });

  test("maps an unsupported axis value to a field error on that axis", async () => {
    const { actions, dependencies } = harness();

    const state = await actions.updatePersonalPreferences(
      personalForm({ density: "microscopic" }),
    );

    expect(state).toEqual({
      field: "density",
      message: appearanceActionMessages.field,
      status: "field_error",
    });
    expect(dependencies.updatePersonalPreferences).not.toHaveBeenCalled();
  });

  test("maps malformed metadata to a fixed global error", async () => {
    const { actions } = harness();

    const state = await actions.updatePersonalPreferences(
      personalForm({ expectedVersion: "-2" }),
    );

    expectGlobalError(state, "invalid_request");
    expect(state.message).toBe(appearanceActionMessages.invalid_request);
  });

  test("maps a stale expected version to a version conflict", async () => {
    const { actions, dependencies } = harness({
      updatePersonalPreferences: async () => {
        throw new DomainError("version_conflict", "stale");
      },
    });

    const state = await actions.updatePersonalPreferences(personalForm());

    expect(state).toEqual({
      message: appearanceActionMessages.version_conflict,
      status: "version_conflict",
    });
    expect(dependencies.revalidate).not.toHaveBeenCalled();
  });

  test("maps the pre-migration missing-schema failure to a temporary outage", async () => {
    const missingTable = Object.assign(new Error("Failed query"), {
      cause: {
        code: "42P01",
        message: 'relation "user_appearance_preferences" does not exist',
      },
    });
    const { actions } = harness({
      updatePersonalPreferences: async () => {
        throw missingTable;
      },
    });

    const state = await actions.updatePersonalPreferences(personalForm());

    expectGlobalError(state, "temporarily_unavailable");
  });

  test("maps every other unknown failure to a fixed unexpected error", async () => {
    const { actions } = harness({
      updatePersonalPreferences: async () => {
        throw new Error("connection string postgres://secret@host/db");
      },
    });

    const state = await actions.updatePersonalPreferences(personalForm());

    expectGlobalError(state, "unexpected_error");
    expect(JSON.stringify(state)).not.toContain("postgres://");
  });

  test("maps a rate-limited write to a fixed global error", async () => {
    const { actions, dependencies } = harness({
      enforceRateLimit: async () => {
        throw new DomainError("rate_limited", "slow down");
      },
    });

    const state = await actions.updatePersonalPreferences(personalForm());

    expectGlobalError(state, "rate_limited");
    expect(dependencies.updatePersonalPreferences).not.toHaveBeenCalled();
  });

  test("returns only a validated same-origin destination", async () => {
    const { actions } = harness();

    for (const returnTo of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/\\evil.example",
      "javascript:alert(1)",
      "",
      "not-a-path",
    ]) {
      const state = await actions.updatePersonalPreferences(
        personalForm({ returnTo }),
      );

      expect(state).toEqual({
        destination: appearanceDefaultDestination,
        status: "success",
      });
    }
  });
});

describe("organization appearance action", () => {
  test("submits the server-derived tenant with the validated triple", async () => {
    const { actions, dependencies } = harness();

    const state = await actions.updateOrganizationDefaults(organizationForm());

    expect(state).toEqual({
      destination: appearanceDefaultDestination,
      status: "success",
    });
    expect(dependencies.updateOrganizationDefaults).toHaveBeenCalledWith({
      defaults: { density: "normal", mode: "dark", theme: "cue" },
      meta: { expectedVersion: 1, idempotencyKey },
      organizationId,
      userId,
    });
    expect(dependencies.revalidate).toHaveBeenCalledTimes(1);
  });

  test("ignores an organization identifier supplied by the form", async () => {
    const { actions, dependencies } = harness();

    await actions.updateOrganizationDefaults(
      organizationForm({
        organizationId: "00000000-0000-4000-8000-0000000000ff",
      }),
    );

    expect(dependencies.updateOrganizationDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
    );
  });

  test("refuses inherit values for a tenant default", async () => {
    const { actions, dependencies } = harness();

    const state = await actions.updateOrganizationDefaults(
      organizationForm({ theme: appearanceInheritValue }),
    );

    expect(state).toEqual({
      field: "theme",
      message: appearanceActionMessages.field,
      status: "field_error",
    });
    expect(dependencies.updateOrganizationDefaults).not.toHaveBeenCalled();
  });

  test("denies the write when no organization is active", async () => {
    const { actions, dependencies } = harness({
      loadActor: async () => ({ organizationId: null, userId }),
    });

    const state = await actions.updateOrganizationDefaults(organizationForm());

    expectGlobalError(state, "forbidden");
    expect(dependencies.updateOrganizationDefaults).not.toHaveBeenCalled();
  });

  test("binds the render context to the freshly resolved tenant", async () => {
    const { actions, dependencies } = harness();

    await actions.updateOrganizationDefaults(organizationForm());

    expect(dependencies.verifyFormContext).toHaveBeenCalledWith({
      expected: { actorId: userId, organizationId },
      token: "v1.organization.token",
    });
  });

  test("returns a context conflict when the tenant changed under the form", async () => {
    const { actions, dependencies } = harness({
      verifyFormContext: () => false,
    });

    const state = await actions.updateOrganizationDefaults(organizationForm());

    expect(state.status).toBe("context_conflict");
    expect(dependencies.updateOrganizationDefaults).not.toHaveBeenCalled();
  });

  test("maps a member attempt to a fixed permission error", async () => {
    const { actions } = harness({
      updateOrganizationDefaults: async () => {
        throw new DomainError("forbidden", "owner required");
      },
    });

    const state = await actions.updateOrganizationDefaults(organizationForm());

    expectGlobalError(state, "forbidden");
    expect(state.message).toBe(appearanceActionMessages.forbidden);
  });

  test("maps uninitialized defaults to a fixed global error", async () => {
    const { actions } = harness({
      updateOrganizationDefaults: async () => {
        throw new DomainError("conflict", "not initialized");
      },
    });

    expectGlobalError(
      await actions.updateOrganizationDefaults(organizationForm()),
      "not_initialized",
    );
  });

  test("requires a positive expected version", async () => {
    const { actions } = harness();

    expectGlobalError(
      await actions.updateOrganizationDefaults(
        organizationForm({ expectedVersion: "0" }),
      ),
      "invalid_request",
    );
  });

  test("rate limits personal and organization writes separately", async () => {
    const { actions, dependencies } = harness();

    await actions.updatePersonalPreferences(personalForm());
    await actions.updateOrganizationDefaults(organizationForm());

    expect(dependencies.enforceRateLimit.mock.calls).toEqual([
      [{ scope: "personal", userId }],
      [{ scope: "organization", userId }],
    ]);
  });
});

/**
 * `loadActor` is `getApplicationContext()` in production, and that boundary
 * signs an expired session out by calling `redirect("/sign-in")` — which Next
 * implements by throwing a digest-carrying error. A catch-all that mapped it
 * would replace the navigation with a permanent "could not be saved" banner, so
 * these prove the framework's control flow leaves the action untouched, exactly
 * as `administration-actions.test.ts` proves for the redirect it owns.
 */
describe("framework control flow", () => {
  function frameworkError(digest: string) {
    return Object.assign(new Error(digest.split(";")[0] as string), { digest });
  }

  const controlFlow = [
    ["a redirect", () => frameworkError("NEXT_REDIRECT;replace;/sign-in;307;")],
    ["a not-found", () => frameworkError("NEXT_HTTP_ERROR_FALLBACK;404")],
  ] as const;

  const surfaces = [
    [
      "personal",
      (dependencies: Partial<AppearanceActionDependencies>) =>
        harness(dependencies).actions.updatePersonalPreferences(personalForm()),
    ],
    [
      "organization",
      (dependencies: Partial<AppearanceActionDependencies>) =>
        harness(dependencies).actions.updateOrganizationDefaults(
          organizationForm(),
        ),
    ],
  ] as const;

  for (const [surface, run] of surfaces) {
    for (const [name, build] of controlFlow) {
      test(`lets ${name} thrown while loading the actor escape the ${surface} action`, async () => {
        const thrown = build();

        await expect(
          run({
            loadActor: async () => {
              throw thrown;
            },
          }),
        ).rejects.toBe(thrown);
      });

      test(`lets ${name} thrown by revalidation escape the committed ${surface} write`, async () => {
        const thrown = build();

        await expect(
          run({
            revalidate: () => {
              throw thrown;
            },
          }),
        ).rejects.toBe(thrown);
      });
    }

    test(`still redacts a non-framework ${surface} failure`, async () => {
      const state = await run({
        loadActor: async () => {
          throw new Error("connection string postgres://secret@host/db");
        },
      });

      expectGlobalError(state, "unexpected_error");
      expect(JSON.stringify(state)).not.toContain("postgres://");
    });
  }
});
