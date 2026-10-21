import { describe, expect, test } from "vitest";

import {
  coreCommandInputSchemas,
  createCoreCommandRegistry,
} from "../core/core-commands.js";
import type { AuthorizedCommandContext } from "../shared/authorization.js";
import { AtomicCommandBus } from "../shared/command.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import {
  type OperatorCredentialPort,
  operatorCredentialsPortName,
  revokeOperatorCredentialCommandName,
} from "./operator-commands.js";
import { operatorActor } from "./operator-types.js";

/*
  Plan 13, F.3 (F3-9): revoke_operator_credential. A person holding
  operator:manage revokes any credential in the organisation as an owner or
  admin, and only their own otherwise. A credential revokes itself without a
  scope. Another credential needs operator:revoke, and a project-bound one
  reaches only credentials bound to its project. No other actor revokes.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f3b01";
const otherOrganizationId = "018f0000-0000-7000-8000-0000000f3b02";
const projectP = "018f0000-0000-7000-8000-0000000f3b03";
const projectQ = "018f0000-0000-7000-8000-0000000f3b04";
const owner = "user_f3_owner";
const member = "user_f3_member";

type Credential = {
  id: string;
  organizationId: string;
  memberUserId: string;
  projectId: string | null;
  lineageId: string;
  version: number;
  revokedAt: Date | null;
};

function credential(
  id: string,
  overrides: Partial<Credential> = {},
): Credential {
  return {
    id,
    organizationId,
    memberUserId: owner,
    projectId: null,
    lineageId: id,
    version: 1,
    revokedAt: null,
    ...overrides,
  };
}

const ids = {
  orgWide: "018f0000-0000-7000-8000-0000000f3c01",
  boundP: "018f0000-0000-7000-8000-0000000f3c02",
  boundQ: "018f0000-0000-7000-8000-0000000f3c03",
  members: "018f0000-0000-7000-8000-0000000f3c04",
};

function fakePort(credentials: Credential[]) {
  const revocations: Array<{
    credentialId: string;
    actorType: string;
    actorId: string;
  }> = [];
  const port: OperatorCredentialPort = {
    async lockCredential(input) {
      return (
        credentials.find(
          (row) =>
            row.organizationId === input.organizationId &&
            row.id === input.credentialId,
        ) ?? null
      );
    },
    async lockMemberRole(input) {
      if (input.organizationId !== organizationId) return null;
      if (input.userId === owner) return { role: "owner" };
      if (input.userId === member) return { role: "member" };
      return null;
    },
    async revokeCredential(input) {
      const row = credentials.find((each) => each.id === input.credentialId);
      if (!row || row.revokedAt || row.version !== input.expectedVersion) {
        throw Object.assign(new Error("changed"), { code: "version_conflict" });
      }
      row.revokedAt = new Date();
      row.version += 1;
      revocations.push({
        credentialId: input.credentialId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
      });
      return { id: row.id, revoked: true as const, version: row.version };
    },
  };
  return { port, revocations };
}

function busFor(port: OperatorCredentialPort) {
  const receipts = new Map<
    string,
    { normalizedInputHash: string; result: never }
  >();
  const uow: UnitOfWork = {
    commandReceipts: {
      async lock() {},
      async find(key) {
        return receipts.get(JSON.stringify(key)) ?? null;
      },
      async save(input) {
        const { normalizedInputHash, result, ...key } = input;
        receipts.set(
          JSON.stringify({
            actorFingerprint: key.actorFingerprint,
            commandName: key.commandName,
            idempotencyFingerprint: key.idempotencyFingerprint,
          }),
          { normalizedInputHash, result: result as never },
        );
      },
    },
    domainEvents: { async append() {} },
    port<T>(name: string) {
      if (name !== operatorCredentialsPortName) {
        throw new Error(`unexpected port ${name}`);
      }
      return port as T;
    },
  };
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: { run: (work) => work(uow) },
    fingerprintSecret: "operator-command-test-fingerprint-secret-0001",
  });
}

function person(
  userId: string,
  scopes = ["operator:manage"],
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(scopes),
    credentialId: "session_1",
    correlationId: "018f0000-0000-7000-8000-0000000f3d01",
  };
}

function operator(
  self: Credential,
  scopes: string[] = ["operator:revoke"],
): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: self.lineageId,
      memberUserId: self.memberUserId,
    }),
    credentialKind: "operator",
    organizationId,
    projectId: self.projectId,
    laneIds: new Set(),
    scopes: new Set(scopes),
    credentialId: self.id,
    correlationId: "018f0000-0000-7000-8000-0000000f3d02",
  };
}

function revoke(
  context: AuthorizedCommandContext,
  credentialId: string,
  input: { organizationId?: string; expectedVersion?: number } = {},
) {
  return {
    name: revokeOperatorCredentialCommandName,
    input: {
      organizationId: input.organizationId ?? organizationId,
      credentialId,
    },
    context,
    meta: {
      idempotencyKey: `idempotency-${crypto.randomUUID()}`,
      expectedVersion: input.expectedVersion ?? 1,
    },
  };
}

function fixtures() {
  return [
    credential(ids.orgWide),
    credential(ids.boundP, { projectId: projectP }),
    credential(ids.boundQ, { projectId: projectQ }),
    credential(ids.members, { memberUserId: member }),
  ];
}

describe("revoke_operator_credential", () => {
  test("is registered, with a strict input schema the registry publishes", () => {
    expect(createCoreCommandRegistry().names()).toContain(
      revokeOperatorCredentialCommandName,
    );
    const schema = coreCommandInputSchemas[revokeOperatorCredentialCommandName];
    expect(
      schema.safeParse({ organizationId, credentialId: ids.orgWide }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        organizationId,
        credentialId: ids.orgWide,
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("lets an owner holding operator:manage revoke any credential, recorded as the person", async () => {
    const { port, revocations } = fakePort(fixtures());
    await expect(
      busFor(port).execute(revoke(person(owner), ids.members)),
    ).resolves.toEqual({ id: ids.members, revoked: true, version: 2 });
    expect(revocations).toEqual([
      { credentialId: ids.members, actorType: "user", actorId: owner },
    ]);
  });

  test("lets a member revoke only their own, and refuses a person without operator:manage", async () => {
    const { port } = fakePort(fixtures());
    const bus = busFor(port);
    await expect(
      bus.execute(revoke(person(member), ids.orgWide)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bus.execute(revoke(person(member), ids.members)),
    ).resolves.toMatchObject({ revoked: true });
    await expect(
      bus.execute(revoke(person(owner, []), ids.orgWide)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("lets a credential revoke itself with no scope, recorded as the service it is", async () => {
    const credentials = fixtures();
    const { port, revocations } = fakePort(credentials);
    const self = credentials[1] as Credential;
    await expect(
      busFor(port).execute(revoke(operator(self, []), self.id)),
    ).resolves.toMatchObject({ revoked: true });
    expect(revocations).toEqual([
      {
        credentialId: self.id,
        actorType: "service",
        actorId: `operator:${self.lineageId}`,
      },
    ]);
  });

  test("needs operator:revoke to revoke another credential of its own lineage", async () => {
    // A rotation (F3-8) shares its predecessor's lineage, and so its actor,
    // for the overlap. "Itself" is the credential, not the lineage: without
    // the scope, neither revokes the other.
    const replaced = credential(ids.orgWide);
    const replacement = credential("018f0000-0000-7000-8000-0000000f3c05", {
      lineageId: replaced.lineageId,
    });
    const { port, revocations } = fakePort([replaced, replacement]);
    const bus = busFor(port);
    await expect(
      bus.execute(revoke(operator(replaced, []), replacement.id)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bus.execute(revoke(operator(replacement, []), replaced.id)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(revocations).toEqual([]);
    await expect(
      bus.execute(revoke(operator(replaced), replacement.id)),
    ).resolves.toMatchObject({ revoked: true });
  });

  test("needs operator:revoke to revoke another credential", async () => {
    const credentials = fixtures();
    const { port } = fakePort(credentials);
    const bus = busFor(port);
    const orgWide = credentials[0] as Credential;
    await expect(
      bus.execute(revoke(operator(orgWide, []), ids.boundQ)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bus.execute(revoke(operator(orgWide), ids.boundQ)),
    ).resolves.toMatchObject({ revoked: true });
  });

  test("confines a project-bound credential to credentials bound to its project", async () => {
    const credentials = [
      ...fixtures(),
      credential("018f0000-0000-7000-8000-0000000f3c05", {
        projectId: projectP,
      }),
    ];
    const { port } = fakePort(credentials);
    const bus = busFor(port);
    const boundP = credentials[1] as Credential;
    await expect(
      bus.execute(revoke(operator(boundP), ids.boundQ)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bus.execute(revoke(operator(boundP), ids.orgWide)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bus.execute(
        revoke(operator(boundP), "018f0000-0000-7000-8000-0000000f3c05"),
      ),
    ).resolves.toMatchObject({ revoked: true });
  });

  test("refuses an agent and the worker's service actor", async () => {
    const { port } = fakePort(fixtures());
    const bus = busFor(port);
    for (const actor of [
      { type: "agent" as const, id: "agent_1" },
      { type: "service" as const, id: "trigger:work-session-sweep" },
    ]) {
      await expect(
        bus.execute(
          revoke(
            {
              ...person(owner),
              actor,
              scopes: new Set(["operator:revoke", "operator:manage"]),
            },
            ids.orgWide,
          ),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  test("refuses another organisation's input, and finds no other organisation's credential", async () => {
    const { port } = fakePort([
      ...fixtures(),
      credential("018f0000-0000-7000-8000-0000000f3c06", {
        organizationId: otherOrganizationId,
      }),
    ]);
    const bus = busFor(port);
    await expect(
      bus.execute(
        revoke(person(owner), ids.orgWide, {
          organizationId: otherOrganizationId,
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bus.execute(
        revoke(person(owner), "018f0000-0000-7000-8000-0000000f3c06"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("answers a stale version and a revoked credential as a version conflict", async () => {
    const { port } = fakePort(fixtures());
    const bus = busFor(port);
    await expect(
      bus.execute(revoke(person(owner), ids.orgWide, { expectedVersion: 2 })),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      bus.execute(revoke(person(owner), ids.orgWide)),
    ).resolves.toMatchObject({ version: 2 });
    await expect(
      bus.execute(revoke(person(owner), ids.orgWide, { expectedVersion: 2 })),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });
});
