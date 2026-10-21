import { describe, expect, test } from "vitest";

import { createCoreCommandRegistry } from "../core/core-commands.js";
import type { AuthorizedCommandContext } from "../shared/authorization.js";
import { AtomicCommandBus } from "../shared/command.js";
import { InMemoryAppearanceEnvironment } from "../test-support/appearance-environment.js";
import { appearanceOrganizationCommandName } from "./appearance-commands.js";

/*
  The organisation appearance command requires `members:manage` (Plan 13,
  F.2.7): the scope F.2.0's scope commit named for members, invitations and
  organisation appearance. A person holds it through `humanScopes`; the role
  rule (owner only) still applies on top of it.
*/

const fingerprintSecret = "requestport-appearance-scope-fingerprint-secret";
const userId = "user_01JQ0000000000000000000011";
const sessionId = "session_01JQ0000000000000000000011";
const organizationId = "8f6b0f2a-0000-4000-8000-000000000011";

function environment(role: "owner" | "admin" = "owner") {
  return new InMemoryAppearanceEnvironment({
    activeSessions: [{ userId, credentialId: sessionId }],
    organizations: [{ id: organizationId }],
    memberships: [{ organizationId, userId, role }],
  });
}

function context(scopes: string[]): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(scopes),
    credentialId: sessionId,
    correlationId: "5b1f0f2a-0000-4000-8000-0000000000cc",
  };
}

function update(
  target: InMemoryAppearanceEnvironment,
  scopes: string[],
  key: string,
) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: target.transactions,
    fingerprintSecret,
  }).execute({
    name: appearanceOrganizationCommandName,
    input: { organizationId, theme: "cue", density: "normal", mode: "dark" },
    context: context(scopes),
    meta: { idempotencyKey: `appearance-scope-${key}`, expectedVersion: 1 },
  });
}

// Scopes a person holds, but not the one this command requires.
const otherScopes = [
  "org:read",
  "project:manage",
  "routing:manage",
  "operations:manage",
  "slack:manage",
];

describe("organisation appearance and members:manage", () => {
  test("refuses an owner without members:manage, naming the scope, before the organisation or membership is locked", async () => {
    const target = environment();

    await expect(update(target, otherScopes, "without")).rejects.toMatchObject({
      code: "forbidden",
      message: "Required capability is missing",
      details: { scope: "members:manage" },
    });
    // The bus takes its receipt lock first; the command's own locks never come.
    expect(target.locks.filter((lock) => !lock.startsWith("receipt:"))).toEqual(
      [],
    );
    expect(target.organizationRow(organizationId)?.version).toBe(1);
    expect(target.events).toEqual([]);
    expect(target.audits).toEqual([]);
    expect(target.receipts).toEqual([]);
  });

  test("lets the same owner write once the context holds members:manage", async () => {
    const target = environment();

    await expect(
      update(target, [...otherScopes, "members:manage"], "with"),
    ).resolves.toMatchObject({ version: 2 });
    expect(target.organizationRow(organizationId)?.version).toBe(2);
    expect(target.events).toHaveLength(1);
  });

  test("still refuses an admin who holds members:manage: the owner rule is unchanged", async () => {
    const target = environment("admin");

    await expect(
      update(target, ["members:manage"], "admin"),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Organization appearance ownership is required",
    });
    expect(target.organizationRow(organizationId)?.version).toBe(1);
    expect(target.events).toEqual([]);
  });
});
