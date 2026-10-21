import { describe, expect, test } from "vitest";

import { createCoreCommandRegistry } from "../core/core-commands.js";
import { operatorActor } from "../operators/operator-types.js";
import type {
  ActorRef,
  AuthorizedCommandContext,
} from "../shared/authorization.js";
import { AtomicCommandBus } from "../shared/command.js";
import { InMemoryAppearanceEnvironment } from "../test-support/appearance-environment.js";
import { appearanceOrganizationCommandName } from "./appearance-commands.js";

/*
  Plan 13, F.2.7's registry half: the organisation appearance command takes
  the acting member from `memberAuthority(context)` (F3-2). An operator
  credential acts with its issuing member's live role, so only an owner's
  operator writes; its audit row records it as the service it is, and its
  event carries its actor. The defaults row names the member as its last
  updater, because that column references the organisation's memberships.
  Every row here is the organisation's, so a context bound to a project is
  refused before the organisation or membership is locked.
*/

const fingerprintSecret = "requestport-appearance-operator-fingerprint-secret";
const memberUserId = "user_01JQ0000000000000000000021";
const organizationId = "8f6b0f2a-0000-4000-8000-000000000021";
const lineageId = "8f6b0f2a-0000-4000-8000-000000000022";

function environment(role: "owner" | "admin" = "owner") {
  return new InMemoryAppearanceEnvironment({
    organizations: [{ id: organizationId }],
    memberships: [{ organizationId, userId: memberUserId, role }],
  });
}

function operatorContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    laneIds: new Set(),
    scopes: new Set(["members:manage"]),
    credentialId: "8f6b0f2a-0000-4000-8000-000000000023",
    correlationId: "8f6b0f2a-0000-4000-8000-000000000024",
    ...overrides,
  };
}

function update(
  target: InMemoryAppearanceEnvironment,
  context: AuthorizedCommandContext,
  key: string,
) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: target.transactions,
    fingerprintSecret,
  }).execute({
    name: appearanceOrganizationCommandName,
    input: { organizationId, theme: "cue", density: "normal", mode: "dark" },
    context,
    meta: { idempotencyKey: `appearance-operator-${key}`, expectedVersion: 1 },
  });
}

/** The command's own locks: everything but the bus's receipt lock. */
function commandLocks(target: InMemoryAppearanceEnvironment) {
  return target.locks.filter((lock) => !lock.startsWith("receipt:"));
}

describe("organisation appearance, for an operator credential", () => {
  test("an owner's operator writes under its member's role, recorded as the service it is", async () => {
    const target = environment("owner");
    const context = operatorContext();

    await expect(update(target, context, "owner")).resolves.toMatchObject({
      version: 2,
    });
    expect(commandLocks(target)).toContain(
      `membership:${organizationId}:${memberUserId}`,
    );
    const row = target.organizationRow(organizationId);
    expect(row?.version).toBe(2);
    expect(row?.lastUpdatedByUserId).toBe(memberUserId);
    expect(target.audits).toEqual([
      expect.objectContaining({
        organizationId,
        actor: { type: "service", id: `operator:${lineageId}` },
        action: "appearance.organization_defaults_updated",
      }),
    ]);
    expect(target.events).toHaveLength(1);
    expect(target.events[0]?.actor).toEqual(context.actor);
  });

  test("an admin's operator is refused, as its member is", async () => {
    const target = environment("admin");

    await expect(
      update(target, operatorContext(), "admin"),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Organization appearance ownership is required",
    });
    expect(target.organizationRow(organizationId)?.version).toBe(1);
    expect(target.events).toEqual([]);
    expect(target.audits).toEqual([]);
  });

  test("an operator bound to a project is refused before the organisation or membership is locked", async () => {
    const target = environment("owner");

    await expect(
      update(
        target,
        operatorContext({ projectId: "8f6b0f2a-0000-4000-8000-000000000025" }),
        "bound",
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message:
        "Organization appearance defaults require a credential bound to no project",
    });
    expect(commandLocks(target)).toEqual([]);
    expect(target.organizationRow(organizationId)?.version).toBe(1);
    expect(target.receipts).toEqual([]);
  });

  test("an operator without members:manage is refused, naming the scope", async () => {
    const target = environment("owner");

    await expect(
      update(
        target,
        operatorContext({ scopes: new Set(["project:manage"]) }),
        "scope",
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      details: { scope: "members:manage" },
    });
    expect(commandLocks(target)).toEqual([]);
  });

  test("a context that claims the operator kind without an operator's shape is refused as no person", async () => {
    const target = environment("owner");
    for (const actor of [
      { type: "service", id: `operator:${lineageId}` },
      {
        type: "agent",
        id: "agent_1",
        delegatedBy: { type: "user", id: memberUserId },
      },
    ] as ActorRef[]) {
      await expect(
        update(target, operatorContext({ actor }), `shape-${actor.type}`),
        actor.type,
      ).rejects.toMatchObject({
        code: "forbidden",
        message:
          "Organization appearance defaults require a person or an operator credential",
      });
    }
    expect(commandLocks(target)).toEqual([]);
    expect(target.events).toEqual([]);
  });
});
