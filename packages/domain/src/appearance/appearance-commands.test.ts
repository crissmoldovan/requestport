import { beforeEach, describe, expect, test } from "vitest";

import {
  createAuthenticatedUserCommandRegistry,
  createCoreCommandRegistry,
  createCoreEventSchemaRegistry,
} from "../core/core-commands.js";
import { EventFactory } from "../events/event-factory.js";
import type {
  ActorRef,
  AuthenticatedUserCommandContext,
  AuthorizedCommandContext,
} from "../shared/authorization.js";
import { AtomicCommandBus } from "../shared/command.js";
import { InMemoryAppearanceEnvironment } from "../test-support/appearance-environment.js";
import {
  appearanceOrganizationCommandName,
  appearanceOrganizationDefaultsUpdatedEvent,
  appearancePersonalCommandName,
} from "./appearance-commands.js";

const fingerprintSecret = "requestport-appearance-fingerprint-secret";
const userId = "user_01JQ0000000000000000000001";
const otherUserId = "user_01JQ0000000000000000000002";
const sessionId = "session_01JQ0000000000000000000001";
const organizationId = "8f6b0f2a-0000-4000-8000-000000000001";
const otherOrganizationId = "8f6b0f2a-0000-4000-8000-000000000002";

function key(suffix: string) {
  return `appearance-idempotency-${suffix}`;
}

function userContext(
  overrides: Partial<AuthenticatedUserCommandContext> = {},
): AuthenticatedUserCommandContext {
  return {
    actor: { type: "user", id: userId },
    credentialId: sessionId,
    correlationId: "5b1f0f2a-0000-4000-8000-0000000000aa",
    ...overrides,
  };
}

function tenantContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["members:manage"]),
    credentialId: sessionId,
    correlationId: "5b1f0f2a-0000-4000-8000-0000000000bb",
    ...overrides,
  };
}

function personalBus(environment: InMemoryAppearanceEnvironment) {
  return new AtomicCommandBus<AuthenticatedUserCommandContext>({
    registry: createAuthenticatedUserCommandRegistry(),
    transactions: environment.transactions,
    fingerprintSecret,
  });
}

function tenantBus(environment: InMemoryAppearanceEnvironment) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: environment.transactions,
    fingerprintSecret,
  });
}

type CommandResult = {
  version: number;
  theme: string | null;
  density: string | null;
  mode: string | null;
  changedFields: string[];
  aggregateId: string | null;
};

describe("personal appearance command registration", () => {
  test("is present only on the session-only authenticated-user registry", () => {
    expect(createAuthenticatedUserCommandRegistry().names()).toEqual([
      appearancePersonalCommandName,
    ]);
    expect(createCoreCommandRegistry().names()).not.toContain(
      appearancePersonalCommandName,
    );
    expect(createCoreCommandRegistry().names()).toContain(
      appearanceOrganizationCommandName,
    );
  });

  test("is unavailable through the tenant bus with a fixed error", async () => {
    const environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
    });

    await expect(
      tenantBus(environment).execute({
        name: appearancePersonalCommandName,
        input: { theme: "cue", density: null, mode: null },
        context: tenantContext(),
        meta: { idempotencyKey: key("absent"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Command is not available",
    });
  });
});

describe("personal appearance writes", () => {
  let environment: InMemoryAppearanceEnvironment;

  beforeEach(() => {
    environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
    });
  });

  test("creates the first row at version one and audits only field names", async () => {
    const result = (await personalBus(environment).execute({
      name: appearancePersonalCommandName,
      input: { theme: "venu", density: null, mode: "dark" },
      context: userContext(),
      meta: { idempotencyKey: key("create"), expectedVersion: 0 },
    })) as CommandResult;

    expect(result).toMatchObject({
      version: 1,
      theme: "venu",
      density: null,
      mode: "dark",
      changedFields: ["mode", "theme"],
    });
    expect(environment.userRow(userId)).toMatchObject({
      theme: "venu",
      density: null,
      mode: "dark",
      version: 1,
    });
    expect(environment.audits).toHaveLength(1);
    expect(environment.audits[0]).toEqual({
      organizationId: null,
      actor: { type: "user", userId },
      action: "appearance.personal_preferences_updated",
      targetType: "user_appearance",
      targetId: `user-aggregate-${userId}`,
      reason: "Personal appearance preferences were updated",
      fieldNames: ["mode", "theme"],
      correlationId: userContext().correlationId,
    });
    // Personal preferences follow the user across organizations, so they never
    // enter the tenant-scoped event or outbox stream.
    expect(environment.events).toEqual([]);
    expect(environment.outbox).toEqual([]);
  });

  test("locks the receipt, the session, and only then the preference row", async () => {
    await personalBus(environment).execute({
      name: appearancePersonalCommandName,
      input: { theme: "cue", density: null, mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("locks"), expectedVersion: 0 },
    });

    const receipt = environment.locks.findIndex((lock) =>
      lock.startsWith("receipt:"),
    );
    const session = environment.locks.indexOf(`session:${sessionId}`);
    const row = environment.locks.indexOf(`user-appearance:${userId}`);
    expect(receipt).toBe(0);
    expect(session).toBeGreaterThan(receipt);
    expect(row).toBeGreaterThan(session);
    expect(
      environment.locks.some((lock) => lock.startsWith("organization")),
    ).toBe(false);
  });

  test("leaves a never-written user at version zero when nothing changes", async () => {
    const result = (await personalBus(environment).execute({
      name: appearancePersonalCommandName,
      input: { theme: null, density: null, mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("noop-create"), expectedVersion: 0 },
    })) as CommandResult;

    expect(result).toMatchObject({ version: 0, changedFields: [] });
    expect(environment.userRow(userId)).toBeNull();
    expect(environment.audits).toEqual([]);
  });

  test("keeps version and audit unchanged for an identical same-value write", async () => {
    const bus = personalBus(environment);
    await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "cue", density: "large", mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("same-1"), expectedVersion: 0 },
    });
    const result = (await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "cue", density: "large", mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("same-2"), expectedVersion: 1 },
    })) as CommandResult;

    expect(result).toMatchObject({ version: 1, changedFields: [] });
    expect(environment.userRow(userId)?.version).toBe(1);
    expect(environment.audits).toHaveLength(1);
  });

  test("retains an all-null tombstone with a stable aggregate across reset", async () => {
    const bus = personalBus(environment);
    await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "terminal", density: "normal", mode: "light" },
      context: userContext(),
      meta: { idempotencyKey: key("tombstone-1"), expectedVersion: 0 },
    });
    const created = environment.userRow(userId);
    const reset = (await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: null, density: null, mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("tombstone-2"), expectedVersion: 1 },
    })) as CommandResult;

    expect(reset).toMatchObject({
      version: 2,
      theme: null,
      density: null,
      mode: null,
      changedFields: ["density", "mode", "theme"],
    });
    expect(environment.userRow(userId)).toMatchObject({
      version: 2,
      aggregateId: created?.aggregateId,
    });

    // Recreating over the retained tombstone must not be able to reuse version
    // zero: that is exactly the ABA the tombstone exists to prevent.
    await expect(
      bus.execute({
        name: appearancePersonalCommandName,
        input: { theme: "cue", density: null, mode: null },
        context: userContext(),
        meta: { idempotencyKey: key("tombstone-3"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({
      code: "version_conflict",
      message: "Appearance preferences changed in another session",
    });
  });

  test("rejects an ancient expected version and a stale compare-and-swap", async () => {
    const bus = personalBus(environment);
    for (const [index, theme] of ["cue", "venu", "dusk"].entries()) {
      await bus.execute({
        name: appearancePersonalCommandName,
        input: { theme, density: null, mode: null },
        context: userContext(),
        meta: {
          idempotencyKey: key(`ancient-${index}`),
          expectedVersion: index,
        },
      });
    }
    expect(environment.userRow(userId)?.version).toBe(3);

    await expect(
      bus.execute({
        name: appearancePersonalCommandName,
        input: { theme: "luma", density: null, mode: null },
        context: userContext(),
        meta: { idempotencyKey: key("ancient-stale"), expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(environment.userRow(userId)?.version).toBe(3);
  });

  test("replays one receipt and refuses the same key with different input", async () => {
    const bus = personalBus(environment);
    const first = await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "signal", density: null, mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("replay"), expectedVersion: 0 },
    });
    const replay = await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "signal", density: null, mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("replay"), expectedVersion: 0 },
    });

    expect(replay).toEqual(first);
    expect(environment.audits).toHaveLength(1);
    expect(environment.userRow(userId)?.version).toBe(1);

    await expect(
      bus.execute({
        name: appearancePersonalCommandName,
        input: { theme: "hivehub", density: null, mode: null },
        context: userContext(),
        meta: { idempotencyKey: key("replay"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("reauthorizes before replaying a receipt for a revoked session", async () => {
    const bus = personalBus(environment);
    await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "snuffle", density: null, mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("revoked"), expectedVersion: 0 },
    });
    environment.revokeSession(sessionId);

    await expect(
      bus.execute({
        name: appearancePersonalCommandName,
        input: { theme: "snuffle", density: null, mode: null },
        context: userContext(),
        meta: { idempotencyKey: key("revoked"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Current human authorization is no longer active",
    });
  });

  test("refuses a session that belongs to another user", async () => {
    await expect(
      personalBus(environment).execute({
        name: appearancePersonalCommandName,
        input: { theme: "cue", density: null, mode: null },
        context: userContext({ actor: { type: "user", id: otherUserId } }),
        meta: { idempotencyKey: key("mismatch"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(environment.userRow(otherUserId)).toBeNull();
  });

  test("rejects a non-human actor and an organization-bearing context", async () => {
    const agent: ActorRef = { type: "agent", id: "agent_1" };

    await expect(
      personalBus(environment).execute({
        name: appearancePersonalCommandName,
        input: { theme: "cue", density: null, mode: null },
        context: userContext({ actor: agent as never }),
        meta: { idempotencyKey: key("agent"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(
      personalBus(environment).execute({
        name: appearancePersonalCommandName,
        input: { theme: "cue", density: null, mode: null },
        context: {
          ...userContext(),
          organizationId,
        } as AuthenticatedUserCommandContext,
        meta: { idempotencyKey: key("org-context"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("rejects malformed values and client-supplied identity fields", async () => {
    for (const input of [
      { theme: "midnight", density: null, mode: null },
      { theme: null, density: "cosy", mode: null },
      { theme: null, density: null, mode: "auto" },
      { theme: null, density: null },
      { theme: null, density: null, mode: null, userId },
      { theme: null, density: null, mode: null, organizationId },
      "cue",
    ]) {
      await expect(
        personalBus(environment).execute({
          name: appearancePersonalCommandName,
          input,
          context: userContext(),
          meta: {
            idempotencyKey: key(`invalid-${JSON.stringify(input)}`),
            expectedVersion: 0,
          },
        }),
        JSON.stringify(input),
      ).rejects.toMatchObject({
        code: "validation_failed",
        message: "Command input is invalid",
      });
    }
    expect(environment.userRow(userId)).toBeNull();
  });

  test("works with no organization and with every organization suspended", async () => {
    const suspended = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [{ id: organizationId, status: "suspended" }],
      memberships: [{ organizationId, userId }],
    });
    const bus = personalBus(suspended);
    const written = (await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "dusk", density: null, mode: null },
      context: userContext(),
      meta: { idempotencyKey: key("suspended"), expectedVersion: 0 },
    })) as CommandResult;

    expect(written.version).toBe(1);
    expect(
      await bus.execute({
        name: appearancePersonalCommandName,
        input: { theme: "dusk", density: null, mode: null },
        context: userContext(),
        meta: { idempotencyKey: key("suspended"), expectedVersion: 0 },
      }),
    ).toEqual(written);
    expect(suspended.audits[0]).toMatchObject({ organizationId: null });
  });

  test("shares one global receipt for the same actor and key across organizations", async () => {
    const bus = personalBus(environment);
    const first = await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "luma", density: null, mode: null },
      context: userContext({
        correlationId: "5b1f0f2a-0000-4000-8000-00000000c1",
      }),
      meta: { idempotencyKey: key("cross-org"), expectedVersion: 0 },
    });
    const second = await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "luma", density: null, mode: null },
      context: userContext({
        correlationId: "5b1f0f2a-0000-4000-8000-00000000c2",
      }),
      meta: { idempotencyKey: key("cross-org"), expectedVersion: 0 },
    });

    expect(second).toEqual(first);
    expect(environment.audits).toHaveLength(1);
  });

  test.each([
    "lockUserPreferences",
    "createUserPreferences",
    "appendAuditRecord",
    "receipts.save",
  ] as const)("rolls the whole write back when %s fails", async (failure) => {
    environment.failOn = failure;

    await expect(
      personalBus(environment).execute({
        name: appearancePersonalCommandName,
        input: { theme: "cue", density: null, mode: null },
        context: userContext(),
        meta: {
          idempotencyKey: key(`rollback-${failure}`),
          expectedVersion: 0,
        },
      }),
    ).rejects.toThrow(`fixed appearance failure: ${failure}`);

    expect(environment.userRow(userId)).toBeNull();
    expect(environment.audits).toEqual([]);
    expect(environment.receipts).toEqual([]);
  });
});

describe("organization appearance defaults", () => {
  let environment: InMemoryAppearanceEnvironment;

  beforeEach(() => {
    environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [{ id: organizationId }, { id: otherOrganizationId }],
      memberships: [
        { organizationId, userId },
        { organizationId: otherOrganizationId, userId },
      ],
    });
  });

  function organizationInput(overrides: Record<string, unknown> = {}) {
    return {
      organizationId,
      theme: "cue",
      density: "normal",
      mode: "dark",
      ...overrides,
    };
  }

  test("emits one contiguous safe event per changed update", async () => {
    const bus = tenantBus(environment);
    const first = (await bus.execute({
      name: appearanceOrganizationCommandName,
      input: organizationInput(),
      context: tenantContext(),
      meta: { idempotencyKey: key("org-1"), expectedVersion: 1 },
    })) as CommandResult;

    expect(first).toMatchObject({
      version: 2,
      theme: "cue",
      density: "normal",
      mode: "dark",
      changedFields: ["density", "mode", "theme"],
    });
    expect(environment.events).toHaveLength(1);
    expect(environment.events[0]).toMatchObject({
      type: appearanceOrganizationDefaultsUpdatedEvent,
      schemaVersion: 1,
      organizationId,
      aggregateType: "organization_appearance",
      aggregateId: `aggregate-${organizationId}`,
      aggregateVersion: 2,
      actor: { type: "user", id: userId },
      data: {
        organizationId,
        changedFields: ["density", "mode", "theme"],
        before: {
          theme: "requestport",
          density: "ultra-compact",
          mode: "system",
        },
        after: { theme: "cue", density: "normal", mode: "dark" },
      },
    });
    expect(environment.outbox).toHaveLength(1);
    expect(environment.audits[0]).toEqual({
      organizationId,
      actor: { type: "user", userId },
      action: "appearance.organization_defaults_updated",
      targetType: "organization_appearance",
      targetId: `aggregate-${organizationId}`,
      reason: "Organization appearance defaults were updated",
      fieldNames: ["density", "mode", "theme"],
      correlationId: tenantContext().correlationId,
    });

    const second = (await bus.execute({
      name: appearanceOrganizationCommandName,
      input: organizationInput({ theme: "venu" }),
      context: tenantContext(),
      meta: { idempotencyKey: key("org-2"), expectedVersion: 2 },
    })) as CommandResult;
    expect(second.version).toBe(3);
    expect(environment.events.map((event) => event.aggregateVersion)).toEqual([
      2, 3,
    ]);
  });

  test("emits nothing for an identical same-value write", async () => {
    const bus = tenantBus(environment);
    await bus.execute({
      name: appearanceOrganizationCommandName,
      input: organizationInput(),
      context: tenantContext(),
      meta: { idempotencyKey: key("org-same-1"), expectedVersion: 1 },
    });
    const result = (await bus.execute({
      name: appearanceOrganizationCommandName,
      input: organizationInput(),
      context: tenantContext(),
      meta: { idempotencyKey: key("org-same-2"), expectedVersion: 2 },
    })) as CommandResult;

    expect(result).toMatchObject({ version: 2, changedFields: [] });
    expect(environment.events).toHaveLength(1);
    expect(environment.audits).toHaveLength(1);
  });

  test("locks the receipt, organization, membership, and row in that order", async () => {
    await tenantBus(environment).execute({
      name: appearanceOrganizationCommandName,
      input: organizationInput(),
      context: tenantContext(),
      meta: { idempotencyKey: key("org-locks"), expectedVersion: 1 },
    });

    const receipt = environment.locks.findIndex((lock) =>
      lock.startsWith("receipt:"),
    );
    const organization = environment.locks.indexOf(
      `organization:${organizationId}`,
    );
    const membership = environment.locks.indexOf(
      `membership:${organizationId}:${userId}`,
    );
    const row = environment.locks.indexOf(
      `organization-appearance:${organizationId}`,
    );

    expect(receipt).toBe(0);
    expect(organization).toBeGreaterThan(receipt);
    expect(membership).toBeGreaterThan(organization);
    expect(row).toBeGreaterThan(membership);
  });

  // Ruling 255, item 7: "If I am the org administrator, that will apply to
  // that organisation." An admin changes the defaults as an owner does.
  test("lets an admin change the defaults, recorded as the admin who did (ruling 255)", async () => {
    const scoped = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [{ id: organizationId }],
      memberships: [{ organizationId, userId, role: "admin" }],
    });

    await expect(
      tenantBus(scoped).execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput(),
        context: tenantContext(),
        meta: { idempotencyKey: key("org-role-admin"), expectedVersion: 1 },
      }),
    ).resolves.toMatchObject({ version: 2, theme: "cue", mode: "dark" });
    expect(scoped.organizationRow(organizationId)).toMatchObject({
      version: 2,
      lastUpdatedByUserId: userId,
    });
    expect(scoped.events).toHaveLength(1);
    expect(scoped.events[0]?.actor).toEqual({ type: "user", id: userId });
  });

  test("denies a member, who is neither an owner nor an admin", async () => {
    const scoped = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [{ id: organizationId }],
      memberships: [{ organizationId, userId, role: "member" }],
    });

    await expect(
      tenantBus(scoped).execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput(),
        context: tenantContext(),
        meta: { idempotencyKey: key("org-role-member"), expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message:
        "An owner or admin is required to change the organization's appearance",
    });
    expect(scoped.organizationRow(organizationId)?.version).toBe(1);
    expect(scoped.events).toEqual([]);
  });

  test.each([
    ["suspended organization", "suspend"],
    ["revoked membership", "revoke"],
  ] as const)("denies a write for a %s", async (_label, action) => {
    if (action === "suspend") environment.suspendOrganization(organizationId);
    else environment.revokeMembership(organizationId, userId);

    await expect(
      tenantBus(environment).execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput(),
        context: tenantContext(),
        meta: { idempotencyKey: key(`org-${action}`), expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(environment.events).toEqual([]);
  });

  test("denies every actor that is neither a person nor an operator credential, with a fixed error", async () => {
    for (const actor of [
      { type: "agent", id: "agent_1" },
      {
        type: "agent",
        id: "agent_1",
        delegatedBy: { type: "user", id: userId },
      },
      { type: "service", id: "requestport-appearance-default-initializer" },
    ] as ActorRef[]) {
      await expect(
        tenantBus(environment).execute({
          name: appearanceOrganizationCommandName,
          input: organizationInput(),
          context: tenantContext({ actor }),
          meta: {
            idempotencyKey: key(`org-actor-${actor.type}-${actor.id}`),
            expectedVersion: 1,
          },
        }),
        actor.type,
      ).rejects.toMatchObject({
        code: "forbidden",
        message:
          "Organization appearance defaults require a person or an operator credential",
      });
    }
    expect(environment.events).toEqual([]);
  });

  test("refuses an organization id that disagrees with the authenticated context", async () => {
    await expect(
      tenantBus(environment).execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput({ organizationId: otherOrganizationId }),
        context: tenantContext(),
        meta: { idempotencyKey: key("org-mismatch"), expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Organization access is denied",
    });
    expect(environment.organizationRow(otherOrganizationId)?.version).toBe(1);
  });

  test("binds the receipt input to the tenant so one key cannot cross organizations", async () => {
    const bus = tenantBus(environment);
    await bus.execute({
      name: appearanceOrganizationCommandName,
      input: organizationInput(),
      context: tenantContext(),
      meta: { idempotencyKey: key("org-tenant-bind"), expectedVersion: 1 },
    });

    await expect(
      bus.execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput({ organizationId: otherOrganizationId }),
        context: tenantContext({ organizationId: otherOrganizationId }),
        meta: { idempotencyKey: key("org-tenant-bind"), expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(environment.organizationRow(otherOrganizationId)?.version).toBe(1);
  });

  test("rejects a stale expected version without touching the row", async () => {
    const bus = tenantBus(environment);
    await bus.execute({
      name: appearanceOrganizationCommandName,
      input: organizationInput(),
      context: tenantContext(),
      meta: { idempotencyKey: key("org-stale-1"), expectedVersion: 1 },
    });

    await expect(
      bus.execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput({ theme: "dusk" }),
        context: tenantContext(),
        meta: { idempotencyKey: key("org-stale-2"), expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(environment.organizationRow(organizationId)?.version).toBe(2);
  });

  test("refuses to invent a version-one aggregate for an uninitialized tenant", async () => {
    const bootstrap = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [{ id: organizationId, defaults: false }],
      memberships: [{ organizationId, userId }],
    });

    await expect(
      tenantBus(bootstrap).execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput(),
        context: tenantContext(),
        meta: { idempotencyKey: key("org-uninitialized"), expectedVersion: 0 },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Organization appearance defaults are not initialized",
    });
    expect(bootstrap.events).toEqual([]);
  });

  test("rejects inherit values and malformed input on the organization axis", async () => {
    for (const input of [
      organizationInput({ theme: null }),
      organizationInput({ density: null }),
      organizationInput({ mode: null }),
      organizationInput({ theme: "midnight" }),
      { theme: "cue", density: "normal", mode: "dark" },
      organizationInput({ lastUpdatedByUserId: otherUserId }),
    ]) {
      await expect(
        tenantBus(environment).execute({
          name: appearanceOrganizationCommandName,
          input,
          context: tenantContext(),
          meta: {
            idempotencyKey: key(`org-invalid-${JSON.stringify(input)}`),
            expectedVersion: 1,
          },
        }),
        JSON.stringify(input),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
  });

  test.each([
    "lockOrganizationDefaults",
    "updateOrganizationDefaults",
    "appendAuditRecord",
    "events.append",
    "receipts.save",
  ] as const)("rolls the tenant write back when %s fails", async (failure) => {
    environment.failOn = failure;

    await expect(
      tenantBus(environment).execute({
        name: appearanceOrganizationCommandName,
        input: organizationInput(),
        context: tenantContext(),
        meta: {
          idempotencyKey: key(`org-rollback-${failure}`),
          expectedVersion: 1,
        },
      }),
    ).rejects.toThrow(`fixed appearance failure: ${failure}`);

    expect(environment.organizationRow(organizationId)?.version).toBe(1);
    expect(environment.audits).toEqual([]);
    expect(environment.events).toEqual([]);
    expect(environment.outbox).toEqual([]);
    expect(environment.receipts).toEqual([]);
  });

  test("passes the update envelope through the shared event sanitizer", () => {
    const registry = createCoreEventSchemaRegistry();

    expect(
      registry.parse(appearanceOrganizationDefaultsUpdatedEvent, {
        organizationId,
        changedFields: ["theme"],
        before: {
          theme: "requestport",
          density: "ultra-compact",
          mode: "system",
        },
        after: { theme: "cue", density: "ultra-compact", mode: "system" },
      }),
    ).toMatchObject({ changedFields: ["theme"] });

    for (const invalid of [
      {
        organizationId,
        changedFields: ["theme"],
        before: { theme: "midnight", density: "normal", mode: "dark" },
        after: { theme: "cue", density: "normal", mode: "dark" },
      },
      {
        organizationId,
        changedFields: ["theme"],
        after: { theme: "cue", density: "normal", mode: "dark" },
      },
      {
        organizationId: "not-a-uuid",
        changedFields: [],
        before: { theme: "cue", density: "normal", mode: "dark" },
        after: { theme: "cue", density: "normal", mode: "dark" },
      },
    ]) {
      expect(() =>
        registry.parse(appearanceOrganizationDefaultsUpdatedEvent, invalid),
      ).toThrow();
    }
  });

  test("uses the event factory so unsupported actors never reach the stream", () => {
    const events = new EventFactory(createCoreEventSchemaRegistry());

    expect(() =>
      events.create(tenantContext({ actor: { type: "user", id: "" } }), {
        type: appearanceOrganizationDefaultsUpdatedEvent,
        schemaVersion: 1,
        aggregateType: "organization_appearance",
        aggregateId: organizationId,
        aggregateVersion: 2,
        causationId: tenantContext().correlationId,
        data: {
          organizationId,
          changedFields: [],
          before: { theme: "cue", density: "normal", mode: "dark" },
          after: { theme: "cue", density: "normal", mode: "dark" },
        },
      }),
    ).toThrow();
  });
});
