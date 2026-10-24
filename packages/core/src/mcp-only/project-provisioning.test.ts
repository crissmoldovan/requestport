import {
  type AuthorizedCommandContext,
  DomainError,
} from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import { humanScopes } from "../command-bus.js";
import type { BusCommand } from "../execute.js";
import {
  createProjectProvisioning,
  type ProjectProvisioningOptions,
  type ProjectProvisioningRepositories,
  type ProjectProvisioningTransaction,
} from "./project-provisioning.js";

/*
 * Provisioning from a delegated grant (manifest-g.md §2.5): MCP's
 * `create_project` and `provision_agent`, moved into core. Each acts as the
 * person the grant delegates to and refuses without one. `create_project`
 * also refuses without the credential that person acts on, before anything
 * is opened, and otherwise re-checks it with the bus's re-check in the
 * transaction it opens, before `ProjectService` reads the organisation
 * (ruling 230 item 2). `provision_agent` also refuses without the grant to
 * record on the key, with a grant id that is not a UUID, and without the
 * caller's Better Auth minter, before either write, and otherwise reads its
 * grant (`provisioningGrant`'s `assertProvisioningGrant`), whose refusal is
 * the call's before either write (ruling 233 item 4), then runs
 * `create_agent_principal` on the bus and issues the key through the agent
 * key service with that minter, which first re-checks the delegated context
 * with the re-check the key repositories carry (ruling 233 item 2). The
 * repositories are stand-ins that record what reached them, so nothing here
 * opens a database.
 */

const organizationId = "018f0000-0000-7000-8000-0000000c4001";
const projectId = "018f0000-0000-7000-8000-0000000c4002";
const userId = "018f0000-0000-7000-8000-0000000c4003";
const grantId = "018f0000-0000-7000-8000-0000000c4004";
const principalId = "018f0000-0000-7000-8000-0000000c4005";
const idempotencyKey = "018f0000-0000-7000-8000-0000000c4006";
const sessionId = "project-provisioning-test-session";
const secret = "project-provisioning-test-signing-material-0001";

/**
 * `recheck`, when given, is what the bus's re-check throws in
 * `create_project`'s transaction; `keyRecheck`, what the re-check the key
 * repositories carry throws when the key service asks it; `grantRead`, what
 * `provisionAgent`'s read of its grant (`assertProvisioningGrant`) throws.
 * Absent, each passes.
 */
function recordingOptions(
  overrides: Partial<ProjectProvisioningOptions> = {},
  recheck?: Error,
  keyRecheck?: Error,
  grantRead?: Error,
) {
  const calls: string[] = [];
  const assertCurrent = vi.fn(async (context: AuthorizedCommandContext) => {
    calls.push(`assertCurrent ${context.actor.id} ${context.credentialId}`);
    if (recheck) throw recheck;
  });
  const assertProvisioningGrant = vi.fn(
    async (context: AuthorizedCommandContext) => {
      calls.push(`grant ${context.actor.id} ${context.credentialId}`);
      if (grantRead) throw grantRead;
    },
  );
  const provisioningGrant = vi.fn(() => {
    calls.push("provisioningGrant");
    return { assertProvisioningGrant };
  });
  const keyAssertCurrent = vi.fn(async (context: AuthorizedCommandContext) => {
    calls.push(`key assertCurrent ${context.actor.id} ${context.credentialId}`);
    if (keyRecheck) throw keyRecheck;
  });
  // One transaction, its repositories opened on it when asked: the re-check,
  // and the foundation repository whose own `transaction` runs its work in
  // this one.
  const transaction: ProjectProvisioningTransaction = async <T>(
    work: (repositories: ProjectProvisioningRepositories) => Promise<T>,
  ) => {
    calls.push("transaction");
    return work({
      authorization: () => {
        calls.push("authorization");
        return { assertCurrent };
      },
      foundation: () => {
        calls.push("foundation");
        return {
          transaction: async (run: (tx: unknown) => Promise<unknown>) =>
            run({
              findOrganizationAuthorization: async (
                organization: string,
                user: string,
              ) => {
                calls.push(
                  `findOrganizationAuthorization ${organization} ${user}`,
                );
                return { organization: null, membership: null };
              },
            }),
        } as never;
      },
    });
  };
  const commandBus = vi.fn(async (_command: BusCommand) => {
    calls.push("commandBus");
    return { id: principalId };
  });
  const authRepository = {
    reserveCredentialIssuance: vi.fn(async () => {
      calls.push("reserveCredentialIssuance");
      return { reserved: true, result: null };
    }),
    createCredential: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("createCredential");
      return {
        id: "018f0000-0000-7000-8000-0000000c4007",
        name: input.name,
        prefix: input.prefix,
        fingerprint: input.fingerprint,
        audience: input.audience,
        projectId: input.projectId,
        laneIds: input.laneIds,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      };
    }),
    deleteOrphanApiKey: vi.fn(),
    cancelCredentialIssuance: vi.fn(),
  };
  const agentRepository = {
    canManage: vi.fn(async () => {
      calls.push("canManage");
      return true;
    }),
    findPrincipal: vi.fn(async () => ({
      status: "active",
      projectId,
    })),
  };
  const agentKeyRepositories = vi.fn(() => {
    calls.push("agentKeyRepositories");
    return {
      authRepository,
      agentRepository,
      authorization: { assertCurrent: keyAssertCurrent },
    } as never;
  });
  const createAgentApiKey = vi.fn(async (_input: object) => {
    calls.push("createAgentApiKey");
    return {
      id: "better-auth-key-1",
      key: "rp_plaintext-key",
      prefix: "rp_",
      start: "plai",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    };
  });
  const options: ProjectProvisioningOptions = {
    transaction,
    provisioningGrant,
    agentKeyRepositories,
    commandBus,
    secrets: { commandFingerprintKey: secret },
    betterAuth: { createAgentApiKey },
    ...overrides,
  };
  return {
    options,
    calls,
    assertCurrent,
    assertProvisioningGrant,
    keyAssertCurrent,
    commandBus,
    createAgentApiKey,
    authRepository,
    agentRepository,
  };
}

const provision = {
  displayName: "Build agent",
  laneIds: [],
  projectId,
  scopes: ["request:read"],
  slug: "build-agent",
};

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the call was not refused");
}

describe("createProject", () => {
  const project = { name: "Core", slug: "core", keyPrefix: "CORE" };
  const correlationId = "018f0000-0000-7000-8000-0000000c4008";

  test("refuses without a delegating person, before any repository is built", async () => {
    const { options, calls } = recordingOptions();

    const error = await refusal(
      createProjectProvisioning(options).createProject({
        correlationId,
        delegatedByUserId: undefined,
        credentialId: grantId,
        organizationId,
        project,
      }),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "forbidden",
      message:
        "Creating a project requires a delegated grant, so that the act is attributable to a person",
    });
    expect(calls).toEqual([]);
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
  ] as const)(
    "refuses without the credential the delegating person acts on (%s), before any transaction is opened (ruling 230 item 2)",
    async (_, credentialId) => {
      const { options, calls } = recordingOptions();

      const error = await refusal(
        createProjectProvisioning(options).createProject({
          correlationId,
          delegatedByUserId: userId,
          credentialId,
          organizationId,
          project,
        }),
      );

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        code: "forbidden",
        message:
          "Creating a project requires the credential the delegating person acts on, a provisioning grant or a live session",
      });
      expect(calls).toEqual([]);
    },
  );

  test("re-checks the delegating person's credential with the bus's re-check, in the transaction it opens, and stops there when that refuses: the foundation repository ProjectService reads and writes through is never opened (ruling 230 item 2)", async () => {
    const stale = new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );
    const { options, calls, assertCurrent } = recordingOptions({}, stale);

    const error = await refusal(
      createProjectProvisioning(options).createProject({
        correlationId,
        delegatedByUserId: userId,
        credentialId: sessionId,
        organizationId,
        project,
      }),
    );

    expect(error).toBe(stale);
    expect(calls).toEqual([
      "transaction",
      "authorization",
      `assertCurrent ${userId} ${sessionId}`,
    ]);
    // The person, as the bus re-checks a person: a user actor carrying what
    // a signed-in person carries, with the credential the call names.
    expect(assertCurrent.mock.calls).toEqual([
      [
        {
          actor: { type: "user", id: userId },
          organizationId,
          scopes: humanScopes,
          credentialId: sessionId,
          correlationId,
        },
      ],
    ]);
  });

  test.each([
    ["a provisioning grant's id, as MCP passes", grantId],
    ["a session's id, as an in-process caller holds", sessionId],
  ] as const)(
    "when the re-check admits the credential (%s), ProjectService runs over the foundation repository opened on the same transaction, as the delegating person",
    async (_, credentialId) => {
      const { options, calls } = recordingOptions();

      // The stand-in answers no active organisation, so ProjectService
      // refuses once it has asked, as the person, in the organisation given.
      await expect(
        createProjectProvisioning(options).createProject({
          correlationId,
          delegatedByUserId: userId,
          credentialId,
          organizationId,
          project,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "An active organization is required",
      });
      expect(calls).toEqual([
        "transaction",
        "authorization",
        `assertCurrent ${userId} ${credentialId}`,
        "foundation",
        `findOrganizationAuthorization ${organizationId} ${userId}`,
      ]);
    },
  );

  test("validates its input before it opens the transaction, as ProjectService does", async () => {
    const { options, calls } = recordingOptions();

    await expect(
      createProjectProvisioning(options).createProject({
        correlationId,
        delegatedByUserId: userId,
        credentialId: grantId,
        organizationId: "not-an-organization-id",
        project,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(calls).toEqual([]);
  });
});

describe("provisionAgent", () => {
  test.each([
    [
      "a delegating person",
      { delegatedByUserId: undefined },
      {},
      "forbidden",
      "Provisioning an agent requires a delegated grant, so that the act is attributable to a person",
    ],
    [
      "an issuing grant",
      { issuingGrantId: undefined },
      {},
      "forbidden",
      "The issuing grant could not be identified, so this credential could not be revoked with it",
    ],
    [
      "betterAuth",
      {},
      { betterAuth: undefined },
      "configuration_error",
      "Provisioning an agent mints its key through Better Auth, and no betterAuth.createAgentApiKey was given",
    ],
    [
      "betterAuth.createAgentApiKey",
      {},
      { betterAuth: {} },
      "configuration_error",
      "Provisioning an agent mints its key through Better Auth, and no betterAuth.createAgentApiKey was given",
    ],
  ] as const)(
    "refuses without %s, before either write",
    async (_, input, overrides, code, message) => {
      const { options, calls } = recordingOptions(overrides);

      const error = await refusal(
        createProjectProvisioning(options).provisionAgent({
          idempotencyKey,
          delegatedByUserId: userId,
          issuingGrantId: grantId,
          organizationId,
          provision,
          ...input,
        }),
      );

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code, message });
      expect(calls).toEqual([]);
    },
  );

  /*
   * J.10's F9: the bus's re-check admits a live session of the delegating
   * person named in the grant's place, and the key service records only a
   * UUID as the issuing grant. Without this refusal the principal was written
   * on the bus and the key then refused, leaving a principal with no key.
   */
  test.each([
    ["a session's id", sessionId],
    [
      "an id in Better Auth's default shape, 32 letters and digits",
      "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f",
    ],
    [
      "a UUID's hex digits without their hyphens",
      "018f00000000700080000000000c4004",
    ],
  ] as const)(
    "refuses an issuing grant id that is not a UUID, %s, before either write: the bus is never called, so no principal is written",
    async (_, issuingGrantId) => {
      const { options, calls, commandBus, createAgentApiKey } =
        recordingOptions();

      const error = await refusal(
        createProjectProvisioning(options).provisionAgent({
          idempotencyKey,
          delegatedByUserId: userId,
          issuingGrantId,
          organizationId,
          provision,
        }),
      );

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        code: "forbidden",
        message:
          "The issuing grant id is not a UUID, so it names no grant this credential could be revoked with",
      });
      expect(commandBus).not.toHaveBeenCalled();
      expect(createAgentApiKey).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    },
  );

  test("reads its grant first, then creates the principal on the bus as the delegating person, then issues its key through the caller's minter, the key service re-checking the grant with the re-check the key repositories carry and its reservation reading it again, recording the grant", async () => {
    const {
      options,
      calls,
      assertProvisioningGrant,
      keyAssertCurrent,
      commandBus,
      createAgentApiKey,
      authRepository,
      agentRepository,
    } = recordingOptions();
    const delegatedContext = {
      actor: { type: "user", id: userId },
      organizationId,
      scopes: humanScopes,
      credentialId: grantId,
      correlationId: idempotencyKey,
    };

    const result = await createProjectProvisioning(options).provisionAgent({
      idempotencyKey,
      delegatedByUserId: userId,
      issuingGrantId: grantId,
      organizationId,
      provision: { ...provision, softwareName: "CI" },
    });

    expect(calls).toEqual([
      "provisioningGrant",
      `grant ${userId} ${grantId}`,
      "commandBus",
      "agentKeyRepositories",
      `key assertCurrent ${userId} ${grantId}`,
      "canManage",
      "reserveCredentialIssuance",
      "createAgentApiKey",
      "createCredential",
    ]);
    expect(assertProvisioningGrant.mock.calls).toEqual([[delegatedContext]]);
    expect(commandBus.mock.calls).toEqual([
      [
        {
          name: "create_agent_principal",
          context: delegatedContext,
          meta: { expectedVersion: 0, idempotencyKey },
          input: {
            displayName: "Build agent",
            organizationId,
            projectId,
            slug: "build-agent",
            softwareName: "CI",
          },
        },
      ],
    ]);
    expect(keyAssertCurrent.mock.calls).toEqual([[delegatedContext]]);
    expect(agentRepository.canManage).toHaveBeenCalledWith({
      organizationId,
      projectId,
      actor: { type: "user", id: userId },
    });
    expect(authRepository.reserveCredentialIssuance).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: userId,
        personCredentialId: grantId,
        expectedVersion: 0,
        idempotencyKey,
        fingerprintSecret: secret,
      }),
    );
    expect(createAgentApiKey.mock.calls).toEqual([
      [{ name: "Build agent", userId, expiresIn: 90 * 24 * 60 * 60 }],
    ]);
    expect(authRepository.createCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPrincipalId: principalId,
        betterAuthApiKeyId: "better-auth-key-1",
        audience: "mcp",
        issuedByGrantId: grantId,
        createdByUserId: userId,
        correlationId: idempotencyKey,
      }),
    );
    expect(result).toMatchObject({ plaintextKey: "rp_plaintext-key" });
  });

  test("mints nothing when the re-check the key repositories carry refuses the delegated context after the bus answered the principal, and the refusal is the re-check's", async () => {
    const refusal = new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );
    const { options, calls, createAgentApiKey, authRepository } =
      recordingOptions({}, undefined, refusal);

    await expect(
      createProjectProvisioning(options).provisionAgent({
        idempotencyKey,
        delegatedByUserId: userId,
        issuingGrantId: grantId,
        organizationId,
        provision,
      }),
    ).rejects.toBe(refusal);
    expect(calls).toEqual([
      "provisioningGrant",
      `grant ${userId} ${grantId}`,
      "commandBus",
      "agentKeyRepositories",
      `key assertCurrent ${userId} ${grantId}`,
    ]);
    expect(createAgentApiKey).not.toHaveBeenCalled();
    expect(authRepository.reserveCredentialIssuance).not.toHaveBeenCalled();
    expect(authRepository.createCredential).not.toHaveBeenCalled();
  });

  /*
   * J.10's F9, its remainder (ruling 233 item 4): the bus's re-check admits
   * a live session of the delegating person in the grant's place, so the
   * grant itself is read before either write, and its refusal is the call's.
   * db's `assertProvisioningGrant` refuses anything but an active
   * organisation-wide provisioning grant of this person while they are an
   * active owner or admin; here it is a stand-in that refuses in its words.
   */
  test("refuses before either write when the read of its grant refuses: the bus is never called, no key repository is built, and nothing is minted", async () => {
    const refusal = new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );
    const { options, calls, commandBus, createAgentApiKey, authRepository } =
      recordingOptions({}, undefined, undefined, refusal);

    await expect(
      createProjectProvisioning(options).provisionAgent({
        idempotencyKey,
        delegatedByUserId: userId,
        issuingGrantId: grantId,
        organizationId,
        provision,
      }),
    ).rejects.toBe(refusal);
    expect(calls).toEqual(["provisioningGrant", `grant ${userId} ${grantId}`]);
    expect(commandBus).not.toHaveBeenCalled();
    expect(createAgentApiKey).not.toHaveBeenCalled();
    expect(authRepository.reserveCredentialIssuance).not.toHaveBeenCalled();
  });

  test("leaves the software name out of the principal's input when none is given", async () => {
    const { options, commandBus } = recordingOptions();

    await createProjectProvisioning(options).provisionAgent({
      idempotencyKey,
      delegatedByUserId: userId,
      issuingGrantId: grantId,
      organizationId,
      provision,
    });

    expect(commandBus.mock.calls.map(([command]) => command.input)).toEqual([
      {
        displayName: "Build agent",
        organizationId,
        projectId,
        slug: "build-agent",
      },
    ]);
  });
});

/*
 * J.10's done-when 2 (ruling 230 item 2): each delegated command refuses a
 * person who is not a member of the organisation, and a member without the
 * role the command needs, as the session path refuses them.
 *
 * `create_project` is run over a stand-in for one active organisation, with
 * the real `ProjectService`. `members` is its membership and `sessions` its
 * live sessions. The re-check stand-in admits what db's re-check admits for a
 * session (`assertCurrentPerson`): a live session of the context's user,
 * while that user is an active member. The foundation stand-in answers the
 * organisation as active and the person's membership, and records each write
 * `ProjectService` makes.
 *
 * `provision_agent`'s two refusals are the bus's, and here the bus is a
 * stand-in that throws them: the re-check refuses the person who is not a
 * member, and `create_agent_principal`'s own check refuses the member who
 * cannot manage the project's agents. What is pinned is that nothing runs
 * after the bus refuses.
 */
describe("a delegated command, for a person who is not a member or lacks the role (J.10, done-when 2)", () => {
  const correlationId = "018f0000-0000-7000-8000-0000000c4009";
  const outsiderId = "018f0000-0000-7000-8000-0000000c4010";
  const memberId = "018f0000-0000-7000-8000-0000000c4011";
  const adminId = "018f0000-0000-7000-8000-0000000c4012";
  const sessions = new Map([
    ["project-provisioning-test-outsider-session", outsiderId],
    ["project-provisioning-test-member-session", memberId],
    ["project-provisioning-test-admin-session", adminId],
  ]);
  const members = new Map([
    [memberId, { status: "active", role: "member" }],
    [adminId, { status: "active", role: "admin" }],
  ]);
  const sessionOf = (userId: string) =>
    [...sessions].find(([, user]) => user === userId)?.[0];

  function organisation() {
    const calls: string[] = [];
    const writes: string[] = [];
    const transaction: ProjectProvisioningTransaction = async <T>(
      work: (repositories: ProjectProvisioningRepositories) => Promise<T>,
    ) => {
      calls.push("transaction");
      return work({
        authorization: () => ({
          assertCurrent: async (context: AuthorizedCommandContext) => {
            calls.push(`assertCurrent ${context.actor.id}`);
            const user = sessions.get(context.credentialId);
            if (
              user !== context.actor.id ||
              members.get(user)?.status !== "active"
            ) {
              throw new DomainError(
                "forbidden",
                "Current human authorization is no longer active",
              );
            }
          },
        }),
        foundation: () => {
          calls.push("foundation");
          const tx = {
            findOrganizationAuthorization: async (
              organization: string,
              user: string,
            ) => {
              calls.push(`findOrganizationAuthorization ${user}`);
              return {
                organization: { id: organization, status: "active" },
                membership: members.get(user) ?? null,
              };
            },
            createProject: async (input: Record<string, unknown>) => {
              writes.push(`project ${String(input.slug)}`);
              return { ...input, id: projectId, status: "active", version: 1 };
            },
            appendAuditRecord: async (record: {
              actor: { userId: string };
            }) => {
              writes.push(`audit ${record.actor.userId}`);
            },
            appendDomainEvent: async (event: { actor: { id: string } }) => {
              writes.push(`event ${event.actor.id}`);
            },
          };
          return {
            transaction: async (run: (tx: unknown) => Promise<unknown>) =>
              run(tx),
          } as never;
        },
      });
    };
    const { options } = recordingOptions({ transaction });
    return { calls, writes, provisioning: createProjectProvisioning(options) };
  }

  const createAs = (
    provisioning: ReturnType<typeof createProjectProvisioning>,
    userId: string,
  ) =>
    provisioning.createProject({
      correlationId,
      delegatedByUserId: userId,
      credentialId: sessionOf(userId),
      organizationId,
      project: { name: "Core", slug: "core", keyPrefix: "CORE" },
    });

  test("createProject refuses a person who is not a member, with their own live session, at the re-check: ProjectService never opens the foundation repository, and nothing is written", async () => {
    const { calls, writes, provisioning } = organisation();

    await expect(createAs(provisioning, outsiderId)).rejects.toMatchObject({
      code: "forbidden",
      message: "Current human authorization is no longer active",
    });
    expect(calls).toEqual(["transaction", `assertCurrent ${outsiderId}`]);
    expect(writes).toEqual([]);
  });

  test("createProject refuses a member without the owner or admin role, with their own live session, at ProjectService's role check after the re-check admits them, and nothing is written", async () => {
    const { calls, writes, provisioning } = organisation();

    await expect(createAs(provisioning, memberId)).rejects.toMatchObject({
      code: "forbidden",
      message: "Organization administration is required",
    });
    expect(calls).toEqual([
      "transaction",
      `assertCurrent ${memberId}`,
      "foundation",
      `findOrganizationAuthorization ${memberId}`,
    ]);
    expect(writes).toEqual([]);
  });

  test("createProject, for an admin with their own live session, writes the project, its audit record and its event as that person (the control for the two refusals above)", async () => {
    const { calls, writes, provisioning } = organisation();

    await expect(createAs(provisioning, adminId)).resolves.toMatchObject({
      project: { id: projectId, slug: "core" },
    });
    expect(calls).toEqual([
      "transaction",
      `assertCurrent ${adminId}`,
      "foundation",
      `findOrganizationAuthorization ${adminId}`,
    ]);
    expect(writes).toEqual([
      "project core",
      `audit ${adminId}`,
      `event ${adminId}`,
    ]);
  });

  /*
   * What these two pin is what follows a refusal on the bus, whoever it
   * refuses: the bus here is a stand-in that refuses every call with the
   * words given, so neither case depends on membership or role. That the
   * real bus refuses a non-member and a member who cannot manage the
   * project's agents is shown against a database by J.10's probe
   * (`track-j.md`, the done-whens), not here.
   */
  test.each([
    ["the bus's re-check", "Current human authorization is no longer active"],
    ["create_agent_principal's own check", "Agent management access is denied"],
  ] as const)(
    "provisionAgent, whatever the bus refuses (here in the words of %s), opens no key repository and mints nothing",
    async (_, message) => {
      const refusalOnTheBus = new DomainError("forbidden", message);
      const { options, calls, createAgentApiKey, authRepository } =
        recordingOptions({
          commandBus: vi.fn(async () => {
            throw refusalOnTheBus;
          }),
        });

      const error = await refusal(
        createProjectProvisioning(options).provisionAgent({
          idempotencyKey,
          delegatedByUserId: memberId,
          issuingGrantId: grantId,
          organizationId,
          provision,
        }),
      );

      expect(error).toBe(refusalOnTheBus);
      // Only the read of the grant, which the stand-in admits, ran before.
      expect(calls).toEqual([
        "provisioningGrant",
        `grant ${memberId} ${grantId}`,
      ]);
      expect(createAgentApiKey).not.toHaveBeenCalled();
      expect(authRepository.createCredential).not.toHaveBeenCalled();
    },
  );
});
