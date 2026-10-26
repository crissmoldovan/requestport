import { describe, expect, test, vi } from "vitest";

import { agentScopes } from "../agents/agent-types.js";
import {
  appearanceCommandInputSchemas,
  appearanceOrganizationCommandName,
} from "../appearance/appearance-commands.js";
import {
  coreCommandInputSchemas,
  createCoreCommandRegistry,
} from "../core/core-commands.js";
import { operatorActor, operatorScopes } from "../operators/operator-types.js";
import type { AuthorizedCommandContext } from "../shared/authorization.js";
import {
  AtomicCommandBus,
  type CommandMeta,
  type DomainEvent,
} from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject, JsonValue } from "../shared/idempotency.js";
import type {
  CommandReceiptRecord,
  TransactionManager,
  UnitOfWork,
} from "../shared/unit-of-work.js";
import { InMemoryFoundationRepository } from "../test-support/foundation-repository.js";
import {
  administrationBasePath,
  capabilityRegistry,
  findMcpToolTransport,
  findQueryCapability,
  findRestCommandTransport,
  restApiBasePath,
  restQueryTransports,
} from "../transport-metadata.js";
import {
  createOrganizationAdministrationCommandDefinitions,
  inviteOrganizationMemberCommandName,
  membersScope,
  type OrganizationManagementPort,
  organizationAdministrationCommandInputSchemas,
  organizationFoundationPortName,
  organizationManagementPortName,
  resendOrganizationInvitationCommandName,
  revokeOrganizationInvitationCommandName,
  setOrganizationMemberCommandName,
} from "./organization-administration-commands.js";

/*
  Plan 13, F.2.7: the organisation administration commands, against fakes.
  What only a real database can show — the locks, the role rules the
  repository applies, receipts and replays under the real `assertCurrent` —
  is in `packages/db`'s `organization-management-repository.integration.test.ts`.
  Here: which checks run, in which order, before any port is asked; what each
  command hands its port; and that the invitation's event passes the real
  event schema.
*/

const organizationId = "00000000-0000-4000-8000-0000000000d1";
const otherOrganizationId = "00000000-0000-4000-8000-0000000000d2";
const invitationId = "00000000-0000-4000-8000-0000000000e1";
const person = "user_actor";

function context(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: person },
    organizationId,
    scopes: new Set([membersScope]),
    credentialId: "session_1",
    correlationId: "00000000-0000-4000-8000-0000000000c1",
    ...overrides,
  };
}

const inputs: Record<string, Record<string, unknown>> = {
  [inviteOrganizationMemberCommandName]: {
    organizationId,
    email: "Person@Example.com",
    role: "member",
  },
  [setOrganizationMemberCommandName]: {
    organizationId,
    userId: "user_target",
    role: "admin",
    status: "active",
  },
  [revokeOrganizationInvitationCommandName]: { organizationId, invitationId },
  [resendOrganizationInvitationCommandName]: { organizationId, invitationId },
};
const names = Object.keys(inputs);

/** The expiry the fake port answers a resend with. */
const resentExpiry = new Date("2026-11-01T12:00:00.000Z");

function fakeManagement(): OrganizationManagementPort & {
  calls: Array<[string, unknown[]]>;
} {
  const calls: Array<[string, unknown[]]> = [];
  const record =
    <T>(name: string, answer: T) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      return answer;
    };
  return {
    calls,
    authorizeMemberChange: record("authorizeMemberChange", undefined),
    authorizeInvitationRevocation: record(
      "authorizeInvitationRevocation",
      undefined,
    ),
    setMember: record("setMember", {
      id: "00000000-0000-4000-8000-0000000000f1",
      role: "admin",
      status: "active",
      version: 4,
    }),
    revokeInvitation: record("revokeInvitation", {
      id: invitationId,
      version: 2,
    }),
    authorizeInvitationResend: record("authorizeInvitationResend", undefined),
    resendInvitation: record("resendInvitation", {
      id: invitationId,
      role: "member" as const,
      expiresAt: resentExpiry,
      version: 2,
    }),
  };
}

/**
 * The in-memory foundation repository, except that a created invitation gets
 * a UUID, as the database gives it: the invitation event's schema requires
 * one, and the shared fake names them `invitation_<n>`. It also records each
 * created and each renewed invitation's `createdByUserId`.
 */
function seededFoundation(
  role: "owner" | "admin" | "member" = "owner",
  status: "active" | "revoked" = "active",
) {
  const repository = Object.assign(seededFoundationState(role, status), {
    /** Each created invitation's `createdByUserId`, in order. */
    createdBy: [] as string[],
    /** Each renewed invitation's `createdByUserId`, in order. */
    renewedBy: [] as string[],
  });
  const transaction = repository.transaction.bind(repository);
  repository.transaction = (run) =>
    transaction((tx) =>
      run(
        Object.assign(Object.create(tx) as typeof tx, {
          async createInvitation(
            input: Parameters<typeof tx.createInvitation>[0],
          ) {
            repository.createdBy.push(input.createdByUserId);
            const invitation = await tx.createInvitation(input);
            invitation.id = crypto.randomUUID();
            return invitation;
          },
          async renewInvitation(
            input: Parameters<typeof tx.renewInvitation>[0],
          ) {
            repository.renewedBy.push(input.createdByUserId);
            return tx.renewInvitation(input);
          },
        }),
      ),
    );
  return repository;
}

function seededFoundationState(
  role: "owner" | "admin" | "member",
  status: "active" | "revoked",
) {
  return new InMemoryFoundationRepository({
    state: {
      organizations: [
        { id: organizationId, name: "CUE++", slug: "cue", status: "active" },
      ],
      memberships: [
        {
          id: "membership_1",
          organizationId,
          userId: person,
          role,
          status,
        },
      ],
    },
  });
}

/** A unit of work over the given ports, keeping receipts and events in memory. */
function memoryTransactions(ports: Record<string, unknown>) {
  const receipts = new Map<string, CommandReceiptRecord>();
  const events: DomainEvent[] = [];
  const transactions: TransactionManager = {
    async run(work) {
      const uow: UnitOfWork = {
        commandReceipts: {
          lock: async () => {},
          find: async (key) => receipts.get(JSON.stringify(key)) ?? null,
          save: async ({ expiresAt: _expiresAt, ...record }) => {
            const { actorFingerprint, commandName, idempotencyFingerprint } =
              record;
            receipts.set(
              JSON.stringify({
                actorFingerprint,
                commandName,
                idempotencyFingerprint,
              }),
              {
                normalizedInputHash: record.normalizedInputHash,
                aggregateId: record.aggregateId,
                result: record.result,
              },
            );
          },
        },
        domainEvents: {
          append: async (appended) => {
            events.push(...appended);
          },
        },
        port<T>(name: string) {
          if (!(name in ports)) throw new Error(`no port ${name}`);
          return ports[name] as T;
        },
      };
      return work(uow);
    },
  };
  return { transactions, receipts, events };
}

function bus(ports: Record<string, unknown>) {
  const memory = memoryTransactions(ports);
  return {
    ...memory,
    bus: new AtomicCommandBus({
      registry: createCoreCommandRegistry(),
      transactions: memory.transactions,
      fingerprintSecret: "organization-administration-test-secret",
    }),
  };
}

function meta(overrides: Partial<CommandMeta> = {}): CommandMeta {
  return {
    idempotencyKey: `organization-administration-${crypto.randomUUID()}`,
    expectedVersion: 0,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the command was not refused");
}

describe("the organisation administration commands", () => {
  test("are registered on the core registry, and their schema map names exactly them", () => {
    const registry = createCoreCommandRegistry();
    expect(
      Object.keys(organizationAdministrationCommandInputSchemas).sort(),
    ).toEqual([...names].sort());
    for (const name of names) expect(registry.resolve(name)).toBeDefined();
    expect(
      createOrganizationAdministrationCommandDefinitions({
        events: undefined as never,
      }).map((definition) => definition.name),
    ).toEqual(names);
  });

  test.each(names)(
    "%s refuses an agent and a service actor holding members:manage, before any port is asked",
    async (name) => {
      for (const actor of [
        { type: "agent" as const, id: "00000000-0000-4000-8000-0000000000a1" },
        { type: "service" as const, id: "operator:lineage" },
      ]) {
        const management = fakeManagement();
        const foundation = seededFoundation();
        const transaction = vi.spyOn(foundation, "transaction");
        const { bus: commands } = bus({
          [organizationManagementPortName]: management,
          [organizationFoundationPortName]: foundation,
        });
        const error = await refusal(
          commands.execute({
            name,
            context: context({ actor }),
            input: inputs[name],
            meta: meta({
              expectedVersion:
                name === inviteOrganizationMemberCommandName ? 0 : 3,
            }),
          }),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({
          code: "forbidden",
          message:
            "Organization administration requires a person or an operator credential",
        });
        expect(management.calls).toEqual([]);
        expect(transaction).not.toHaveBeenCalled();
      }
    },
  );

  test.each(names)(
    "%s refuses a context without members:manage, naming the scope",
    async (name) => {
      const management = fakeManagement();
      const { bus: commands } = bus({
        [organizationManagementPortName]: management,
        [organizationFoundationPortName]: seededFoundation(),
      });
      const error = await refusal(
        commands.execute({
          name,
          context: context({ scopes: new Set(["org:read"]) }),
          input: inputs[name],
          meta: meta(),
        }),
      );
      expect(error).toMatchObject({
        code: "forbidden",
        details: { scope: membersScope },
      });
      expect(management.calls).toEqual([]);
    },
  );

  test.each(names)(
    "%s refuses another organisation in its input",
    async (name) => {
      const management = fakeManagement();
      const { bus: commands } = bus({
        [organizationManagementPortName]: management,
        [organizationFoundationPortName]: seededFoundation(),
      });
      const error = await refusal(
        commands.execute({
          name,
          context: context(),
          input: { ...inputs[name], organizationId: otherOrganizationId },
          meta: meta(),
        }),
      );
      expect(error).toMatchObject({
        code: "forbidden",
        message: "Organization access is denied",
      });
      expect(management.calls).toEqual([]);
    },
  );

  test.each(names)("%s refuses a field it does not take", async (name) => {
    const { bus: commands } = bus({
      [organizationManagementPortName]: fakeManagement(),
      [organizationFoundationPortName]: seededFoundation(),
    });
    await expect(
      commands.execute({
        name,
        context: context(),
        input: { ...inputs[name], actorUserId: "user_other" },
        meta: meta(),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("set_organization_member and revoke_organization_invitation", () => {
  test("ask the port about the person, authorise before the write, and answer what it wrote", async () => {
    const management = fakeManagement();
    const { bus: commands, events } = bus({
      [organizationManagementPortName]: management,
    });
    const target = { organizationId, userId: person };

    await expect(
      commands.execute<unknown, JsonValue>({
        name: setOrganizationMemberCommandName,
        context: context(),
        input: inputs[setOrganizationMemberCommandName],
        meta: meta({ expectedVersion: 3 }),
      }),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-0000000000f1",
      role: "admin",
      status: "active",
      version: 4,
    });
    await expect(
      commands.execute<unknown, JsonValue>({
        name: revokeOrganizationInvitationCommandName,
        context: context(),
        input: inputs[revokeOrganizationInvitationCommandName],
        meta: meta({ expectedVersion: 1 }),
      }),
    ).resolves.toEqual({ id: invitationId, version: 2 });

    expect(management.calls).toEqual([
      [
        "authorizeMemberChange",
        [target, { userId: "user_target", role: "admin" }],
      ],
      [
        "setMember",
        [
          {
            ...target,
            correlationId: context().correlationId,
            expectedVersion: 3,
            actor: { type: "user", id: person },
          },
          { userId: "user_target", role: "admin", status: "active" },
        ],
      ],
      ["authorizeInvitationRevocation", [target, invitationId]],
      [
        "revokeInvitation",
        [
          {
            ...target,
            correlationId: context().correlationId,
            expectedVersion: 1,
            actor: { type: "user", id: person },
          },
          invitationId,
        ],
      ],
    ]);
    // The repository writes its own event and outbox row; the bus gets none.
    expect(events).toEqual([]);
  });

  test("a refusal from the port's authorisation writes nothing", async () => {
    const management = fakeManagement();
    management.authorizeMemberChange = async () => {
      throw new DomainError("forbidden", "Only an owner may manage owners");
    };
    const { bus: commands, receipts } = bus({
      [organizationManagementPortName]: management,
    });
    await expect(
      commands.execute({
        name: setOrganizationMemberCommandName,
        context: context(),
        input: inputs[setOrganizationMemberCommandName],
        meta: meta({ expectedVersion: 3 }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(management.calls).toEqual([]);
    expect(receipts.size).toBe(0);
  });
});

describe("resend_organization_invitation", () => {
  test("asks the port about the person, authorises before the write, hands it a fresh token hash and a new invitation's lifetime, and the bus records the invitation's own event at the new version", async () => {
    const management = fakeManagement();
    const { bus: commands, events } = bus({
      [organizationManagementPortName]: management,
    });
    const target = { organizationId, userId: person };

    for (const _press of [1, 2]) {
      await expect(
        commands.execute<unknown, JsonValue>({
          name: resendOrganizationInvitationCommandName,
          context: context(),
          input: inputs[resendOrganizationInvitationCommandName],
          meta: meta({ expectedVersion: 1 }),
        }),
      ).resolves.toEqual({
        id: invitationId,
        role: "member",
        expiresAt: resentExpiry.toISOString(),
        version: 2,
      });
    }

    const mutation = {
      ...target,
      correlationId: context().correlationId,
      expectedVersion: 1,
      actor: { type: "user", id: person },
    };
    expect(management.calls).toEqual([
      ["authorizeInvitationResend", [target, invitationId]],
      [
        "resendInvitation",
        [
          mutation,
          invitationId,
          {
            tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
            // Seven days: what an invitation from the members page gets.
            expiresInSeconds: 604_800,
          },
        ],
      ],
      ["authorizeInvitationResend", [target, invitationId]],
      [
        "resendInvitation",
        [mutation, invitationId, expect.objectContaining({})],
      ],
    ]);
    // Each resend is a new token, never one the earlier issue held.
    const hashes = management.calls
      .filter(([name]) => name === "resendInvitation")
      .map(([, args]) => (args[2] as { tokenHash: string }).tokenHash);
    expect(new Set(hashes).size).toBe(2);
    // The event a new invitation's email is sent for, at the invitation's
    // new version, with exactly a new invitation's payload: every worker
    // already deployed sends for it, and it carries no token.
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        type: "organization.invitation_created.v1",
        schemaVersion: 1,
        aggregateType: "invitation",
        aggregateId: invitationId,
        aggregateVersion: 2,
      });
      expect(event.data).toEqual({
        invitationId,
        role: "member",
        expiresAt: resentExpiry.toISOString(),
      });
    }
  });

  test("a refusal from the port's authorisation writes nothing", async () => {
    const management = fakeManagement();
    management.authorizeInvitationResend = async () => {
      throw new DomainError(
        "forbidden",
        "Only an owner may resend an owner invitation",
      );
    };
    const {
      bus: commands,
      receipts,
      events,
    } = bus({
      [organizationManagementPortName]: management,
    });
    await expect(
      commands.execute({
        name: resendOrganizationInvitationCommandName,
        context: context(),
        input: inputs[resendOrganizationInvitationCommandName],
        meta: meta({ expectedVersion: 1 }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(management.calls).toEqual([]);
    expect(receipts.size).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("invite_organization_member", () => {
  test.each([
    ["owner", "owner"],
    ["owner", "admin"],
    ["owner", "member"],
    ["admin", "admin"],
    ["admin", "member"],
  ] as const)(
    "lets an active %s invite %s, and records the event the email is sent from",
    async (actorRole, role) => {
      const foundation = seededFoundation(actorRole);
      const { bus: commands, events } = bus({
        [organizationFoundationPortName]: foundation,
      });
      const result = await commands.execute<unknown, JsonObject>({
        name: inviteOrganizationMemberCommandName,
        context: context(),
        input: { organizationId, email: "  INVITÉ@Example.COM ", role },
        meta: meta(),
      });

      const [invitation] = foundation.state.invitations;
      expect(invitation).toMatchObject({
        normalizedEmail: "invité@example.com",
        role,
      });
      expect(result).toEqual({
        id: invitation?.id,
        role,
        expiresAt: invitation?.expiresAt.toISOString(),
        created: true,
      });
      expect(JSON.stringify(result)).not.toContain("example.com");
      expect(foundation.state.audits).toEqual([
        {
          organizationId,
          actor: { type: "user", userId: person },
          action: "organization.invitation_created",
          targetType: "invitation",
          targetId: invitation?.id,
          reason: "Organization invitation created",
          fieldNames: ["normalizedEmail", "role", "expiresAt"],
          correlationId: context().correlationId,
        },
      ]);
      // The bus appends this event (and its outbox row), so its after-commit
      // dispatch sends the invitation's email as the form's did.
      expect(foundation.state.events).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "organization.invitation_created.v1",
        organizationId,
        aggregateType: "invitation",
        aggregateId: invitation?.id,
        aggregateVersion: 1,
        actor: { type: "user", id: person },
        correlationId: context().correlationId,
        causationId: context().correlationId,
        data: {
          invitationId: invitation?.id,
          role,
          expiresAt: invitation?.expiresAt.toISOString(),
        },
      });
    },
  );

  test.each([
    ["admin", "owner", "active"],
    ["member", "member", "active"],
    ["owner", "member", "revoked"],
  ] as const)(
    "refuses an %s inviting %s (membership %s), writing nothing",
    async (actorRole, role, status) => {
      const foundation = seededFoundation(actorRole, status);
      const {
        bus: commands,
        events,
        receipts,
      } = bus({
        [organizationFoundationPortName]: foundation,
      });
      await expect(
        commands.execute({
          name: inviteOrganizationMemberCommandName,
          context: context(),
          input: { organizationId, email: "person@example.com", role },
          meta: meta(),
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(foundation.state.invitations).toEqual([]);
      expect(foundation.state.audits).toEqual([]);
      expect(events).toEqual([]);
      expect(receipts.size).toBe(0);
    },
  );

  test("answers an active matching invitation with created false and no event", async () => {
    const foundation = seededFoundation();
    const { bus: commands, events } = bus({
      [organizationFoundationPortName]: foundation,
    });
    const first = await commands.execute<unknown, JsonObject>({
      name: inviteOrganizationMemberCommandName,
      context: context(),
      input: { organizationId, email: "person@example.com", role: "member" },
      meta: meta(),
    });
    const again = await commands.execute<unknown, JsonObject>({
      name: inviteOrganizationMemberCommandName,
      context: context(),
      input: { organizationId, email: " Person@Example.com", role: "member" },
      meta: meta(),
    });

    expect(again).toEqual({ ...first, created: false });
    expect(foundation.state.invitations).toHaveLength(1);
    expect(foundation.state.audits).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("renews a revoked invitation, and the bus records its event at the invitation's new version, with renewedFrom (X15)", async () => {
    const foundation = seededFoundation();
    const { bus: commands, events } = bus({
      [organizationFoundationPortName]: foundation,
    });
    const input = {
      organizationId,
      email: "person@example.com",
      role: "member",
    };
    const first = await commands.execute<unknown, JsonObject>({
      name: inviteOrganizationMemberCommandName,
      context: context(),
      input,
      meta: meta(),
    });
    const [stored] = foundation.state.invitations;
    if (!stored) throw new Error("Missing test invitation");
    stored.revokedAt = foundation.now();
    stored.version = 2;

    const renewed = await commands.execute<unknown, JsonObject>({
      name: inviteOrganizationMemberCommandName,
      context: context(),
      input: { ...input, role: "admin" },
      meta: meta(),
    });

    expect(renewed).toEqual({
      id: first.id,
      role: "admin",
      expiresAt: expect.any(String),
      created: true,
    });
    expect(foundation.state.invitations).toEqual([
      expect.objectContaining({ id: first.id, revokedAt: null, version: 3 }),
    ]);
    expect(foundation.state.audits.map((audit) => audit.action)).toEqual([
      "organization.invitation_created",
      "organization.invitation_renewed",
    ]);
    expect(foundation.state.audits[1]).toMatchObject({
      actor: { type: "user", userId: person },
      reason: "Organization invitation renewed after it was revoked",
    });
    expect(foundation.state.events).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "organization.invitation_created.v1",
      aggregateId: first.id,
      aggregateVersion: 3,
      data: {
        invitationId: first.id,
        role: "admin",
        expiresAt: renewed.expiresAt,
        renewedFrom: "revoked",
      },
    });
  });

  test.each([
    ["an address that has an account", "existing_account"],
    ["an active member's address", "already_member"],
  ] as const)(
    "refuses %s on email (%s), with no invitation, audit row, event or receipt",
    async (_label, reason) => {
      const foundation = seededFoundation();
      foundation.state.users.push({
        id: "user_person",
        normalizedEmail: "person@example.com",
      });
      if (reason === "already_member") {
        foundation.state.memberships.push({
          id: "membership_person",
          organizationId,
          userId: "user_person",
          role: "member",
          status: "active",
        });
      }
      const {
        bus: commands,
        events,
        receipts,
      } = bus({
        [organizationFoundationPortName]: foundation,
      });
      await expect(
        commands.execute({
          name: inviteOrganizationMemberCommandName,
          context: context(),
          input: {
            organizationId,
            email: "Person@Example.com",
            role: "member",
          },
          meta: meta(),
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason },
      });
      expect(foundation.state.invitations).toEqual([]);
      expect(foundation.state.audits).toEqual([]);
      expect(events).toEqual([]);
      expect(receipts.size).toBe(0);
    },
  );

  test("a new invitation expects version 0", async () => {
    const foundation = seededFoundation();
    const { bus: commands } = bus({
      [organizationFoundationPortName]: foundation,
    });
    await expect(
      commands.execute({
        name: inviteOrganizationMemberCommandName,
        context: context(),
        input: { organizationId, email: "person@example.com", role: "member" },
        meta: meta({ expectedVersion: 1 }),
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(foundation.state.invitations).toEqual([]);
  });

  test.each([
    [{ email: "not-an-email" }, "email"],
    [{ expiresInSeconds: 59 }, "expiresInSeconds"],
    [{ expiresInSeconds: 2_592_001 }, "expiresInSeconds"],
    [{ role: "superuser" }, "role"],
  ])("refuses %j, naming %s", async (change, field) => {
    const foundation = seededFoundation();
    const { bus: commands } = bus({
      [organizationFoundationPortName]: foundation,
    });
    await expect(
      commands.execute({
        name: inviteOrganizationMemberCommandName,
        context: context(),
        input: {
          organizationId,
          email: "person@example.com",
          role: "member",
          ...change,
        },
        meta: meta(),
      }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field } });
    expect(foundation.state.invitations).toEqual([]);
  });

  test("a replay after the person is demoted is refused, not answered", async () => {
    const foundation = seededFoundation("owner");
    const { bus: commands } = bus({
      [organizationFoundationPortName]: foundation,
    });
    const replayed = meta();
    const input = {
      organizationId,
      email: "person@example.com",
      role: "owner",
    };
    await commands.execute({
      name: inviteOrganizationMemberCommandName,
      context: context(),
      input,
      meta: replayed,
    });
    const membership = foundation.state.memberships[0];
    if (!membership) throw new Error("no membership");
    membership.role = "admin";

    await expect(
      commands.execute({
        name: inviteOrganizationMemberCommandName,
        context: context(),
        input,
        meta: replayed,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Only an owner may invite another owner",
    });
  });
});

/*
  Plan 13, F.2.7's registry half: the three commands take the acting member
  from `memberAuthority(context)` (F3-2), so an operator credential acts with
  its issuing member's live role and a person with their own, and nothing else
  is admitted. Every row they touch is the organisation's, so a context bound
  to a project is refused. The write is handed the context's actor, which is
  what its audit row and event record: an operator as the service it is.
*/
describe("an operator credential", () => {
  const lineageId = "00000000-0000-4000-8000-0000000000b7";

  function operatorContext(
    overrides: Partial<AuthorizedCommandContext> = {},
  ): AuthorizedCommandContext {
    return {
      actor: operatorActor({ lineageId, memberUserId: person }),
      credentialKind: "operator",
      organizationId,
      projectId: null,
      laneIds: new Set(),
      scopes: new Set([membersScope]),
      credentialId: "00000000-0000-4000-8000-0000000000b8",
      correlationId: "00000000-0000-4000-8000-0000000000c7",
      ...overrides,
    };
  }

  test("set member and revoke ask the port about the operator's member, and hand the write the operator's actor", async () => {
    const management = fakeManagement();
    const { bus: commands } = bus({
      [organizationManagementPortName]: management,
    });
    const context = operatorContext();
    const target = { organizationId, userId: person };
    await commands.execute({
      name: setOrganizationMemberCommandName,
      context,
      input: inputs[setOrganizationMemberCommandName],
      meta: meta({ expectedVersion: 3 }),
    });
    await commands.execute({
      name: revokeOrganizationInvitationCommandName,
      context,
      input: inputs[revokeOrganizationInvitationCommandName],
      meta: meta({ expectedVersion: 1 }),
    });
    expect(management.calls).toEqual([
      [
        "authorizeMemberChange",
        [target, { userId: "user_target", role: "admin" }],
      ],
      [
        "setMember",
        [
          {
            ...target,
            correlationId: context.correlationId,
            expectedVersion: 3,
            actor: context.actor,
          },
          { userId: "user_target", role: "admin", status: "active" },
        ],
      ],
      ["authorizeInvitationRevocation", [target, invitationId]],
      [
        "revokeInvitation",
        [
          {
            ...target,
            correlationId: context.correlationId,
            expectedVersion: 1,
            actor: context.actor,
          },
          invitationId,
        ],
      ],
    ]);
  });

  test("invite runs under the member's role, records the operator as the service it is, and names the member as the invitation's creator", async () => {
    const foundation = seededFoundation("owner");
    const { bus: commands, events } = bus({
      [organizationFoundationPortName]: foundation,
    });
    const context = operatorContext();
    await commands.execute({
      name: inviteOrganizationMemberCommandName,
      context,
      input: { organizationId, email: "person@example.com", role: "owner" },
      meta: meta(),
    });
    const [invitation] = foundation.state.invitations;
    expect(foundation.createdBy).toEqual([person]);
    expect(foundation.state.audits).toEqual([
      {
        organizationId,
        actor: { type: "service", id: `operator:${lineageId}` },
        action: "organization.invitation_created",
        targetType: "invitation",
        targetId: invitation?.id,
        reason: "Organization invitation created",
        fieldNames: ["normalizedEmail", "role", "expiresAt"],
        correlationId: context.correlationId,
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toEqual(context.actor);
  });

  // The registry halves' stack: X15's renewal (on `main`) and this group's
  // actor meet in `createOrganizationInvitation`, so an operator's renewal is
  // recorded as the service it is, as its creation is.
  test("invite renews a revoked invitation for an operator, recording the operator on the renewal's audit row and naming the member its creator", async () => {
    const foundation = seededFoundation("owner");
    const { bus: commands, events } = bus({
      [organizationFoundationPortName]: foundation,
    });
    const context = operatorContext();
    const input = {
      organizationId,
      email: "person@example.com",
      role: "member",
    };
    const first = await commands.execute<unknown, JsonObject>({
      name: inviteOrganizationMemberCommandName,
      context,
      input,
      meta: meta(),
    });
    const [stored] = foundation.state.invitations;
    if (!stored) throw new Error("Missing test invitation");
    stored.revokedAt = foundation.now();
    stored.version = 2;

    const renewed = await commands.execute<unknown, JsonObject>({
      name: inviteOrganizationMemberCommandName,
      context,
      input: { ...input, role: "admin" },
      meta: meta(),
    });

    expect(renewed).toMatchObject({
      id: first.id,
      role: "admin",
      created: true,
    });
    const service = { type: "service", id: `operator:${lineageId}` };
    expect(
      foundation.state.audits.map((audit) => [audit.action, audit.actor]),
    ).toEqual([
      ["organization.invitation_created", service],
      ["organization.invitation_renewed", service],
    ]);
    expect(foundation.createdBy).toEqual([person]);
    expect(foundation.renewedBy).toEqual([person]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      actor: context.actor,
      aggregateVersion: 3,
      data: { renewedFrom: "revoked", role: "admin" },
    });
  });

  test("invite follows the member's role: an admin's operator may not invite an owner", async () => {
    const foundation = seededFoundation("admin");
    const { bus: commands, receipts } = bus({
      [organizationFoundationPortName]: foundation,
    });
    await expect(
      commands.execute({
        name: inviteOrganizationMemberCommandName,
        context: operatorContext(),
        input: { organizationId, email: "person@example.com", role: "owner" },
        meta: meta(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Only an owner may invite another owner",
    });
    expect(foundation.state.invitations).toEqual([]);
    expect(receipts.size).toBe(0);
  });

  test.each(names)(
    "%s refuses an operator bound to a project before any port is asked",
    async (name) => {
      const management = fakeManagement();
      const foundation = seededFoundation();
      const transaction = vi.spyOn(foundation, "transaction");
      const { bus: commands } = bus({
        [organizationManagementPortName]: management,
        [organizationFoundationPortName]: foundation,
      });
      const error = await refusal(
        commands.execute({
          name,
          context: operatorContext({
            projectId: "00000000-0000-4000-8000-0000000000b9",
          }),
          input: inputs[name],
          meta: meta({
            expectedVersion:
              name === inviteOrganizationMemberCommandName ? 0 : 3,
          }),
        }),
      );
      expect(error).toMatchObject({
        code: "forbidden",
        message:
          "Organization administration requires a credential bound to no project",
      });
      expect(management.calls).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  test.each(names)(
    "%s refuses an operator without members:manage, naming the scope",
    async (name) => {
      const management = fakeManagement();
      const { bus: commands } = bus({
        [organizationManagementPortName]: management,
        [organizationFoundationPortName]: seededFoundation(),
      });
      const error = await refusal(
        commands.execute({
          name,
          context: operatorContext({ scopes: new Set(["project:manage"]) }),
          input: inputs[name],
          meta: meta(),
        }),
      );
      expect(error).toMatchObject({
        code: "forbidden",
        details: { scope: membersScope },
      });
      expect(management.calls).toEqual([]);
    },
  );

  test.each(names)(
    "%s refuses a context that claims the operator kind without an operator's shape",
    async (name) => {
      const management = fakeManagement();
      const foundation = seededFoundation();
      const transaction = vi.spyOn(foundation, "transaction");
      const { bus: commands } = bus({
        [organizationManagementPortName]: management,
        [organizationFoundationPortName]: foundation,
      });
      for (const actor of [
        // The worker's own service actor: no origin.
        { type: "service" as const, id: `operator:${lineageId}` },
        // An agent that says it was delegated by the member.
        {
          type: "agent" as const,
          id: "00000000-0000-4000-8000-0000000000a1",
          delegatedBy: { type: "user" as const, id: person },
        },
      ]) {
        const error = await refusal(
          commands.execute({
            name,
            context: operatorContext({ actor }),
            input: inputs[name],
            meta: meta({
              expectedVersion:
                name === inviteOrganizationMemberCommandName ? 0 : 3,
            }),
          }),
        );
        expect(error, actor.type).toMatchObject({
          code: "forbidden",
          message:
            "Organization administration requires a person or an operator credential",
        });
      }
      expect(management.calls).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});

/*
  The registry entries (Plan 13, F.2.7's registry half, as the port half's log
  lists them, and ruling 263's resend beside revoke): the four commands and
  the organisation appearance command are REST commands an operator alone
  reaches, with no MCP tool (ruling 2), bound to the credential's
  organisation by the route, and checking `members:manage`, which an operator
  may carry and no agent grant can. The two reads that supply their
  identifiers and versions are REST only, under the administration prefix,
  operator only, and bound to the organisation.
*/
describe("the registry entries", () => {
  const commandNames = [
    inviteOrganizationMemberCommandName,
    setOrganizationMemberCommandName,
    revokeOrganizationInvitationCommandName,
    resendOrganizationInvitationCommandName,
    appearanceOrganizationCommandName,
  ] as const;
  const schemas: Record<string, unknown> = {
    ...organizationAdministrationCommandInputSchemas,
    ...appearanceCommandInputSchemas,
  };

  test.each(commandNames)(
    "%s is a REST command an operator alone reaches, with no MCP tool",
    (name) => {
      const transport = findRestCommandTransport(name);
      expect(transport).toEqual({
        name,
        method: "POST",
        path: `${restApiBasePath}/commands/${name}`,
        dispatch: { to: "command-bus", commandName: name },
        inputSchema: coreCommandInputSchemas[name],
        injectedFields: [
          { field: "organizationId", from: "credential.organizationId" },
        ],
        scope: { kind: "fixed", scope: membersScope, checkedBy: "command" },
        routeRequiresProject: false,
        rateLimitClass: "mutation",
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(transport?.inputSchema).toBe(schemas[name]);
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test.each([
    ["list_administration_invitations", "/invitations"],
    ["get_administration_organization_appearance", "/appearance"],
  ] as const)(
    "%s is REST only, under the administration prefix, for an operator holding members:manage, bound to the organisation",
    (name, path) => {
      expect(findQueryCapability(name)).toEqual({
        kind: "query",
        name,
        dispatch: { to: "administration-read", method: name },
        binding: "organization",
        scope: membersScope,
        rest: {
          method: "GET",
          path: `${administrationBasePath}${path}`,
          pathParameters: [],
          queryParameters: [],
          routeRequiresProject: false,
          rateLimitClass: "token",
        },
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(
        restQueryTransports.filter((transport) => transport.name === name),
      ).toHaveLength(1);
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test("members:manage is a scope an operator may carry and no agent grant can", () => {
    expect(operatorScopes).toContain(membersScope);
    expect(agentScopes as readonly string[]).not.toContain(membersScope);
  });

  test("the entries sit together after the agent reads, the commands in this order, then the two reads", () => {
    const at = (name: string) =>
      capabilityRegistry.findIndex((entry) => entry.name === name);
    const positions = [
      ...commandNames,
      "list_administration_invitations",
      "get_administration_organization_appearance",
    ].map(at);
    expect(positions.every((position) => position > at("list_events"))).toBe(
      true,
    );
    expect(positions).toEqual(
      positions.map((_, index) => (positions[0] ?? 0) + index),
    );
  });
});
