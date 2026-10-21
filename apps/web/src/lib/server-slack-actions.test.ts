import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `server-slack-actions.ts` (Plan 13, F.2.5): the one handler the Slack
 * connection test has, shared by its form and its REST entry
 * `send_slack_connection_test`, which admits operator credentials alone.
 *
 * What these hold is the composition: who is admitted before any transaction
 * opens (the Slack commands' own target: a person, or an operator bound to no
 * project, acting with its issuing member), the repository opened on the
 * handler's one transaction, the credential re-checked there first by the
 * bus's own `assertCurrent` under the deployment's operator switch, the
 * repository handed the acting member and the context's own actor, and the
 * task dispatched only after the transaction has committed. The handler runs
 * end to end on PostgreSQL, through the route, in
 * `app/(app)/slack/actions.connection-test.database.test.ts`.
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
    queueConnectionTest: vi.fn(),
    triggerSlackConnectionTest: vi.fn(),
    authorizationDatabases: [] as unknown[],
    authorizationOptions: [] as unknown[],
    slackDatabases: [] as unknown[],
    transactions: 0,
  };
});

vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_SECRET: "server-slack-actions-form-secret-value",
    REQUESTPORT_OPERATOR_CREDENTIALS: "enabled",
  },
}));

vi.mock("@requestport/db", async (importOriginal) => ({
  // The web's RequestPort composes its command bus when it is first used,
  // over the package's own port factories and a transaction manager this
  // suite never runs (Plan 13, G.6).
  ...(await importOriginal<Record<string, unknown>>()),
  createCommandTransactionManager: () => ({ run: vi.fn() }),
  createCommandAuthorizationRepository: (
    database: unknown,
    options: unknown,
  ) => {
    mocks.authorizationDatabases.push(database);
    mocks.authorizationOptions.push(options);
    return { assertCurrent: mocks.assertCurrent };
  },
  createSlackRepository: (database: unknown) => {
    mocks.slackDatabases.push(database);
    return {
      queueConnectionTest: async (...args: unknown[]) => {
        mocks.steps.push("queueConnectionTest");
        return mocks.queueConnectionTest(...args);
      },
    };
  },
}));

/*
 * The handler opens its transaction on the web root's storage (Plan 13, G.2),
 * through the web's RequestPort since G.6, which `server-web-request-port.ts`
 * composes over the storage the wiring answers the root (ruling 140). So the
 * wiring hands back a fake handle as that storage's `db`, and its
 * `transaction` as the storage's own, and the cases count its transactions as
 * they always did.
 */
vi.mock("@requestport/db/wiring", () => {
  const db = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      mocks.transactions += 1;
      mocks.steps.push("begin");
      try {
        const result = await work(mocks.tx);
        mocks.steps.push("commit");
        return result;
      } catch (error) {
        mocks.steps.push("rollback");
        throw error;
      }
    },
  };
  return {
    applicationStorageFromEnv: () => ({ db, transaction: db.transaction }),
  };
});

vi.mock("./trigger-client.js", () => ({
  triggerSlackConnectionTest: async (...args: unknown[]) => {
    mocks.steps.push("dispatch");
    return mocks.triggerSlackConnectionTest(...args);
  },
}));

const { queueSlackConnectionTest } = await import("./server-slack-actions.js");

const organizationId = "00000000-0000-4000-8000-0000000000d1";
const installationId = "00000000-0000-4000-8000-000000000201";
const operationId = "00000000-0000-4000-8000-000000000301";
const meta = { expectedVersion: 0, idempotencyKey: "0123456789abcdef0123" };
const input = { organizationId, installationId, channelId: "C012ABCDEF" };

const context: AuthorizedCommandContext = {
  actor: { type: "user", id: "user_signed_in_person" },
  organizationId,
  scopes: new Set(["slack:manage"]),
  credentialId: "session_live",
  correlationId: "00000000-0000-4000-8000-0000000000f1",
};

beforeEach(() => {
  mocks.steps.length = 0;
  mocks.authorizationDatabases.length = 0;
  mocks.authorizationOptions.length = 0;
  mocks.slackDatabases.length = 0;
  mocks.transactions = 0;
  mocks.assertCurrent.mockClear();
  mocks.assertCurrent.mockImplementation(async () => {
    mocks.steps.push("assertCurrent");
  });
  mocks.queueConnectionTest.mockReset();
  mocks.queueConnectionTest.mockResolvedValue({
    id: operationId,
    installationId,
    operationPayload: { channelId: "C012ABCDEF" },
  });
  mocks.triggerSlackConnectionTest.mockReset();
  mocks.triggerSlackConnectionTest.mockResolvedValue(undefined);
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the handler did not refuse");
}

describe("queueing a Slack connection test", () => {
  test("re-checks the credential first, queues on the same transaction, then dispatches after the commit", async () => {
    const result = await queueSlackConnectionTest(context, input, meta);

    expect(result).toEqual({ operationId, dispatched: true });
    expect(mocks.steps).toEqual([
      "begin",
      "assertCurrent",
      "queueConnectionTest",
      "commit",
      "dispatch",
    ]);
    expect(mocks.transactions).toBe(1);
    expect(mocks.assertCurrent).toHaveBeenCalledWith(context);
    expect(mocks.authorizationDatabases).toEqual([mocks.tx]);
    // Built as the bus builds its port, under the deployment's switch.
    expect(mocks.authorizationOptions).toEqual([
      { operatorCredentials: "enabled" },
    ]);
    expect(mocks.slackDatabases).toEqual([mocks.tx]);
    expect(mocks.triggerSlackConnectionTest).toHaveBeenCalledWith(operationId);
  });

  test("hands the repository the person, the key, the version and the form's secret, as the form did", async () => {
    await queueSlackConnectionTest(context, input, meta);

    expect(mocks.queueConnectionTest).toHaveBeenCalledWith({
      organizationId,
      installationId,
      channelId: "C012ABCDEF",
      userId: "user_signed_in_person",
      actor: context.actor,
      idempotencyKey: meta.idempotencyKey,
      expectedVersion: 0,
      fingerprintSecret: "server-slack-actions-form-secret-value",
      correlationId: context.correlationId,
    });
  });

  test("hands the repository an organisation-wide operator's issuing member, and the operator's own actor", async () => {
    const operator: AuthorizedCommandContext = {
      actor: operatorActor({
        lineageId: "00000000-0000-4000-8000-0000000000e1",
        memberUserId: "user_issuing_member",
      }),
      credentialKind: "operator",
      organizationId,
      projectId: null,
      laneIds: new Set(),
      scopes: new Set(["slack:manage"]),
      credentialId: "00000000-0000-4000-8000-0000000000e2",
      correlationId: "00000000-0000-4000-8000-0000000000f2",
    };

    expect(await queueSlackConnectionTest(operator, input, meta)).toEqual({
      operationId,
      dispatched: true,
    });
    expect(mocks.assertCurrent).toHaveBeenCalledWith(operator);
    expect(mocks.queueConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_issuing_member",
        actor: operator.actor,
        correlationId: operator.correlationId,
      }),
    );
  });

  test("refuses an operator bound to a project before any transaction opens", async () => {
    const error = await refusal(
      queueSlackConnectionTest(
        {
          actor: operatorActor({
            lineageId: "00000000-0000-4000-8000-0000000000e1",
            memberUserId: "user_issuing_member",
          }),
          credentialKind: "operator",
          organizationId,
          projectId: "00000000-0000-4000-8000-0000000000e3",
          laneIds: new Set(),
          scopes: new Set(["slack:manage"]),
          credentialId: "00000000-0000-4000-8000-0000000000e2",
          correlationId: "00000000-0000-4000-8000-0000000000f2",
        },
        input,
        meta,
      ),
    );

    expect((error as DomainError).code).toBe("forbidden");
    expect((error as DomainError).message).toBe(
      "Operator project access is denied",
    );
    expect(mocks.transactions).toBe(0);
  });

  test("answers undispatched, not failed, when the dispatch throws: the operation is durable", async () => {
    mocks.triggerSlackConnectionTest.mockRejectedValue(new Error("offline"));

    expect(await queueSlackConnectionTest(context, input, meta)).toEqual({
      operationId,
      dispatched: false,
    });
  });

  test("dispatches nothing when the credential is no longer current", async () => {
    mocks.assertCurrent.mockRejectedValue(
      new DomainError("forbidden", "no longer active"),
    );

    const error = await refusal(queueSlackConnectionTest(context, input, meta));

    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.steps).toEqual(["begin", "rollback"]);
    expect(mocks.queueConnectionTest).not.toHaveBeenCalled();
    expect(mocks.triggerSlackConnectionTest).not.toHaveBeenCalled();
  });

  test("dispatches nothing when the repository refuses", async () => {
    mocks.queueConnectionTest.mockRejectedValue(
      new DomainError("forbidden", "Slack test access is denied"),
    );

    const error = await refusal(queueSlackConnectionTest(context, input, meta));

    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.steps).toEqual([
      "begin",
      "assertCurrent",
      "queueConnectionTest",
      "rollback",
    ]);
    expect(mocks.triggerSlackConnectionTest).not.toHaveBeenCalled();
  });

  test.each([
    ["an agent", { type: "agent", id: "00000000-0000-4000-8000-0000000000a9" }],
    [
      "an operator-shaped service actor in a context that does not say operator",
      {
        type: "service",
        id: "operator:probe",
        originatingActor: { type: "user", id: "someone" },
      },
    ],
  ] as const)("refuses %s before any transaction opens", async (_, actor) => {
    const error = await refusal(
      queueSlackConnectionTest({ ...context, actor }, input, meta),
    );

    expect((error as DomainError).code).toBe("forbidden");
    expect((error as DomainError).message).toBe(
      "Slack administration requires a person or an operator credential",
    );
    expect(mocks.transactions).toBe(0);
  });

  test("refuses a context without slack:manage before any transaction opens, naming that scope", async () => {
    const error = await refusal(
      queueSlackConnectionTest(
        { ...context, scopes: new Set(["org:read", "project:manage"]) },
        input,
        meta,
      ),
    );

    expect((error as DomainError).code).toBe("forbidden");
    expect((error as DomainError).details).toEqual({ scope: "slack:manage" });
    expect(mocks.transactions).toBe(0);
  });

  test("refuses another organisation than the context's before any transaction opens", async () => {
    const error = await refusal(
      queueSlackConnectionTest(
        context,
        { ...input, organizationId: "00000000-0000-4000-8000-0000000000d2" },
        meta,
      ),
    );

    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.transactions).toBe(0);
  });

  test.each([
    ["a malformed installation id", { installationId: "not-an-id" }],
    ["a channel id Slack would not issue", { channelId: "general" }],
  ])("refuses %s before any transaction opens", async (_, change) => {
    await expect(
      queueSlackConnectionTest(context, { ...input, ...change }, meta),
    ).rejects.toThrow();
    expect(mocks.transactions).toBe(0);
  });
});
