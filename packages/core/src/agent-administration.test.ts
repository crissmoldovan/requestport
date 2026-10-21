import {
  type AuthorizedCommandContext,
  DomainError,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `agent-administration.ts` (Plan 13, F.2.2; in core since G.6, moved here
 * with this suite from `apps/web/src/lib/server-agent-actions.test.ts`): the
 * one handler each of F.2.2's two off-bus revocations has — revoking an
 * agent's API key (`revoke_agent_credential`) and one of its OAuth grants
 * (`revoke_agent_oauth_grant`) — shared by its form and its REST transport,
 * which reaches it through `agentAdministrationHandlers` for an operator
 * credential.
 *
 * What these hold is the composition, built here as `createRequestPort`
 * builds it, over a storage (`agentAdministrationTransaction`): every
 * repository is opened on the handler's one transaction, the credential is
 * re-checked there first by the bus's own `assertCurrent`, and the key and
 * grant services keep the receipt they always kept, keyed with the same
 * secret the forms handed them. The services' own rules are theirs, tested
 * beside them in `./agent-services`, and in `packages/auth`, where
 * `agent-revocation.integration.test.ts` runs the handlers' bodies with the
 * real services on PostgreSQL; the repository writes are tested against
 * PostgreSQL in `packages/db`. The web's RequestPort opens the same
 * transaction on the web root's storage, through `createRequestPort`, and
 * the web's REST and form suites run the handlers there
 * (`apps/web/src/lib/server-agent-actions.ts` hands the forms its
 * `handlers`).
 */

const mocks = vi.hoisted(() => {
  const steps: string[] = [];
  const tx = { name: "the-handler-transaction" };
  return {
    steps,
    tx,
    assertCurrent: vi.fn(async () => {
      steps.push("assertCurrent");
    }),
    listCredentials: vi.fn(),
    agentRepository: { name: "agent-repository" },
    authRepositoryDatabases: [] as unknown[],
    agentRepositoryDatabases: [] as unknown[],
    authorizationDatabases: [] as unknown[],
    authorizationOptions: [] as unknown[],
    keyServices: [] as Array<Record<string, unknown>>,
    grantServices: [] as Array<Record<string, unknown>>,
    revoke: vi.fn(),
    revokeGrant: vi.fn(),
    transactions: 0,
  };
});

vi.mock("@requestport/db", () => ({
  createCommandAuthorizationRepository: (
    database: unknown,
    options: unknown,
  ) => {
    mocks.authorizationDatabases.push(database);
    mocks.authorizationOptions.push(options);
    return { assertCurrent: mocks.assertCurrent };
  },
  createAgentAuthRepository: (database: unknown) => {
    mocks.authRepositoryDatabases.push(database);
    return {
      database,
      listCredentials: async (...args: unknown[]) => {
        mocks.steps.push("listCredentials");
        return mocks.listCredentials(...args);
      },
    };
  },
  createAgentRepository: (database: unknown) => {
    mocks.agentRepositoryDatabases.push(database);
    return { ...mocks.agentRepository, database };
  },
}));

vi.mock("./agent-services/index.js", () => ({
  createAgentApiKeyService: (dependencies: Record<string, unknown>) => {
    mocks.keyServices.push(dependencies);
    return {
      revoke: async (...args: unknown[]) => {
        mocks.steps.push("revoke");
        return mocks.revoke(...args);
      },
    };
  },
  createAgentGrantService: (dependencies: Record<string, unknown>) => {
    mocks.grantServices.push(dependencies);
    return {
      revokeGrant: async (...args: unknown[]) => {
        mocks.steps.push("revokeGrant");
        return mocks.revokeGrant(...args);
      },
    };
  },
}));

const { agentAdministrationTransaction, createAgentAdministration } =
  await import("./agent-administration.js");

/*
 * The handlers over a storage whose transaction is counted, as the cases
 * always counted it, with the secret the forms keyed their receipts with and
 * the operator switch on.
 */
const storage = {
  transaction: async <T>(work: (tx: never) => Promise<T>) => {
    mocks.transactions += 1;
    mocks.steps.push("begin");
    try {
      return await work(mocks.tx as never);
    } finally {
      mocks.steps.push("end");
    }
  },
};
const secrets = {
  commandFingerprintKey: "server-agent-actions-form-secret-value",
  operatorCredentials: "enabled" as const,
};
const {
  agentAdministrationHandlers,
  revokeAgentCredential,
  revokeAgentOauthGrant,
} = createAgentAdministration({
  transaction: agentAdministrationTransaction(storage, secrets),
  secrets,
});

const organizationId = "00000000-0000-4000-8000-0000000000d1";
const otherOrganizationId = "00000000-0000-4000-8000-0000000000d2";
const agentPrincipalId = "00000000-0000-4000-8000-0000000000a1";
const credentialId = "00000000-0000-4000-8000-0000000000c1";
const grantId = "00000000-0000-4000-8000-0000000000e1";
const meta = { expectedVersion: 2, idempotencyKey: "0123456789abcdef0123" };

const context: AuthorizedCommandContext = {
  actor: { type: "user", id: "user_signed_in_person" },
  organizationId,
  scopes: new Set(["agent:manage"]),
  credentialId: "session_live",
  correlationId: "00000000-0000-4000-8000-0000000000f1",
};

const credential = {
  id: credentialId,
  agentPrincipalId,
  projectId: "00000000-0000-4000-8000-0000000000b1",
};

beforeEach(() => {
  mocks.steps.length = 0;
  mocks.authRepositoryDatabases.length = 0;
  mocks.agentRepositoryDatabases.length = 0;
  mocks.authorizationDatabases.length = 0;
  mocks.authorizationOptions.length = 0;
  mocks.keyServices.length = 0;
  mocks.grantServices.length = 0;
  mocks.transactions = 0;
  mocks.assertCurrent.mockClear();
  mocks.assertCurrent.mockImplementation(async () => {
    mocks.steps.push("assertCurrent");
  });
  mocks.listCredentials.mockReset();
  mocks.listCredentials.mockResolvedValue([
    { ...credential, id: "00000000-0000-4000-8000-0000000000c9" },
    credential,
  ]);
  mocks.revoke.mockReset();
  mocks.revoke.mockResolvedValue({ id: credentialId, revoked: true });
  mocks.revokeGrant.mockReset();
  mocks.revokeGrant.mockResolvedValue({
    id: grantId,
    revoked: true,
    version: 3,
  });
});

/** The one service a handler built, which each call builds exactly once. */
function only(services: Array<Record<string, unknown>>) {
  expect(services).toHaveLength(1);
  return services[0] as Record<string, unknown>;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the handler was not refused");
}

describe("revoking an agent credential", () => {
  test("re-checks the credential in its transaction before it reads or writes anything", async () => {
    const result = await revokeAgentCredential(
      context,
      { organizationId, agentPrincipalId, credentialId },
      meta,
    );

    expect(result).toEqual({ id: credentialId, revoked: true });
    expect(mocks.transactions).toBe(1);
    expect(mocks.steps).toEqual([
      "begin",
      "assertCurrent",
      "listCredentials",
      "revoke",
      "end",
    ]);
    expect(mocks.assertCurrent).toHaveBeenCalledWith(context);
    expect(mocks.listCredentials).toHaveBeenCalledWith(
      organizationId,
      agentPrincipalId,
    );
    expect(mocks.revoke).toHaveBeenCalledWith(context, {
      organizationId,
      credential,
      meta,
    });
  });

  test("opens every repository on that one transaction, and keeps the form's receipt secret", async () => {
    await revokeAgentCredential(
      context,
      { organizationId, agentPrincipalId, credentialId },
      meta,
    );

    expect(mocks.authorizationDatabases).toEqual([mocks.tx]);
    expect(mocks.authRepositoryDatabases).toEqual([mocks.tx]);
    expect(mocks.agentRepositoryDatabases).toEqual([mocks.tx]);
    const service = only(mocks.keyServices);
    expect(service.fingerprintSecret).toBe(
      "server-agent-actions-form-secret-value",
    );
    expect((service.authRepository as { database: unknown }).database).toBe(
      mocks.tx,
    );
    expect((service.agentRepository as { database: unknown }).database).toBe(
      mocks.tx,
    );
    // A revocation never mints: the service's key factory refuses outright.
    await expect(
      (service.createApiKey as () => Promise<unknown>)(),
    ).rejects.toThrow();
  });

  test("a refused re-check reads and writes nothing", async () => {
    mocks.assertCurrent.mockRejectedValue(
      new DomainError(
        "forbidden",
        "Current human authorization is no longer active",
      ),
    );

    const error = await refusal(
      revokeAgentCredential(
        context,
        { organizationId, agentPrincipalId, credentialId },
        meta,
      ),
    );

    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.steps).toEqual(["begin", "end"]);
    expect(mocks.listCredentials).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  test("a credential the principal does not hold is not found, and nothing is revoked", async () => {
    mocks.listCredentials.mockResolvedValue([]);

    const error = await refusal(
      revokeAgentCredential(
        context,
        { organizationId, agentPrincipalId, credentialId },
        meta,
      ),
    );

    expect((error as DomainError).code).toBe("not_found");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  test("another organisation in the input is refused before any transaction opens", async () => {
    const error = await refusal(
      revokeAgentCredential(
        context,
        {
          organizationId: otherOrganizationId,
          agentPrincipalId,
          credentialId,
        },
        meta,
      ),
    );

    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.transactions).toBe(0);
  });

  test("an input that is not the schema's is refused before any transaction opens", async () => {
    const error = await refusal(
      revokeAgentCredential(
        context,
        { organizationId, agentPrincipalId, credentialId: "not-a-uuid" },
        meta,
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect(mocks.transactions).toBe(0);
  });
});

describe("revoking an agent OAuth grant", () => {
  const input = {
    organizationId,
    agentPrincipalId,
    grantId,
    reason: "The laptop holding it was lost",
  };

  test("re-checks the credential in its transaction, then revokes through the grant service", async () => {
    const result = await revokeAgentOauthGrant(context, input, meta);

    expect(result).toEqual({ id: grantId, revoked: true, version: 3 });
    expect(mocks.transactions).toBe(1);
    expect(mocks.steps).toEqual([
      "begin",
      "assertCurrent",
      "revokeGrant",
      "end",
    ]);
    expect(mocks.revokeGrant).toHaveBeenCalledWith(context, {
      ...input,
      ...meta,
    });
  });

  test("opens every repository on that one transaction, and keeps the form's receipt secret", async () => {
    await revokeAgentOauthGrant(context, input, meta);

    expect(mocks.authorizationDatabases).toEqual([mocks.tx]);
    expect(mocks.authRepositoryDatabases).toEqual([mocks.tx]);
    expect(mocks.agentRepositoryDatabases).toEqual([mocks.tx]);
    const service = only(mocks.grantServices);
    expect(service.fingerprintSecret).toBe(
      "server-agent-actions-form-secret-value",
    );
    expect((service.authRepository as { database: unknown }).database).toBe(
      mocks.tx,
    );
  });

  test("a refused re-check writes nothing", async () => {
    mocks.assertCurrent.mockRejectedValue(
      new DomainError(
        "forbidden",
        "Current human authorization is no longer active",
      ),
    );

    const error = await refusal(revokeAgentOauthGrant(context, input, meta));

    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.revokeGrant).not.toHaveBeenCalled();
  });

  test("another organisation in the input is refused before any transaction opens", async () => {
    const error = await refusal(
      revokeAgentOauthGrant(
        context,
        { ...input, organizationId: otherOrganizationId },
        meta,
      ),
    );

    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.transactions).toBe(0);
  });
});

/*
  Plan 13, F.2.2's registry half: `/api/v1` reaches the same two handlers,
  by the name each REST command dispatches under, and an operator's
  re-check runs under the deployment's switch, as the bus's does.
*/
describe("the handlers as REST reaches them", () => {
  test("each is named by the REST command that dispatches to it", () => {
    expect(agentAdministrationHandlers).toEqual({
      revoke_agent_credential: revokeAgentCredential,
      revoke_agent_oauth_grant: revokeAgentOauthGrant,
    });
  });

  test("each opens assertCurrent's repository with the deployment's operator switch", async () => {
    await revokeAgentCredential(
      context,
      { organizationId, agentPrincipalId, credentialId },
      meta,
    );
    await revokeAgentOauthGrant(
      context,
      {
        organizationId,
        agentPrincipalId,
        grantId,
        reason: "The laptop holding it was lost",
      },
      meta,
    );
    expect(mocks.authorizationOptions).toEqual([
      { operatorCredentials: "enabled" },
      { operatorCredentials: "enabled" },
    ]);
  });
});
