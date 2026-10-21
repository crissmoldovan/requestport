import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The Slack connection test through core, over a storage, as
 * `createRequestPort` composes it (`slackConnectionTestTransaction`;
 * manifest-g.md §2.5's `slack-connection-test` row): the Slack commands' own
 * target is checked before any transaction opens; one transaction on the
 * storage, with both repositories opened on it and the bus's own re-check run
 * there first, under the operator switch it was given; the operation keyed
 * with the raw `commandFingerprintKey`, read when the call runs; and the task
 * started only after that transaction has committed, through the start it was
 * given (the background port's). A start that fails leaves the operation
 * pending, answered as not started. The web runs the same handler, which its
 * RequestPort composes the same way over the web root's storage;
 * `apps/web/src/lib/server-slack-actions.test.ts` holds the web's handler
 * export over it, `queueSlackConnectionTest`, which the form calls.
 */

const mocks = vi.hoisted(() => {
  const steps: string[] = [];
  const tx = { name: "the-connection-test-transaction" };
  return {
    steps,
    tx,
    builtOn: [] as Array<[string, unknown]>,
    authorizationOptions: [] as unknown[],
    queueConnectionTest: vi.fn(),
    start: vi.fn(),
    transactions: 0,
  };
});

vi.mock("@requestport/db", () => ({
  createCommandAuthorizationRepository: (tx: unknown, options: unknown) => {
    mocks.builtOn.push(["authorization", tx]);
    mocks.authorizationOptions.push(options);
    return {
      assertCurrent: async () => {
        mocks.steps.push("assertCurrent");
      },
    };
  },
  createSlackRepository: (tx: unknown) => {
    mocks.builtOn.push(["slack", tx]);
    return {
      queueConnectionTest: async (input: unknown) => {
        mocks.steps.push("queueConnectionTest");
        return mocks.queueConnectionTest(input);
      },
    };
  },
}));

const { createSlackConnectionTest, slackConnectionTestTransaction } =
  await import("./slack-connection-test.js");

const organizationId = "018f0000-0000-7000-8000-0000000c1101";
const installationId = "018f0000-0000-7000-8000-0000000c1102";
const operationId = "018f0000-0000-7000-8000-0000000c1103";
const meta = {
  idempotencyKey: "core-slack-test-idempotency",
  expectedVersion: 0,
};
const input = { organizationId, installationId, channelId: "C012ABCDEF" };

const storage = {
  transaction: async <T>(work: (tx: never) => Promise<T>) => {
    mocks.transactions += 1;
    mocks.steps.push("begin");
    try {
      const result = await work(mocks.tx as never);
      mocks.steps.push("commit");
      return result;
    } catch (error) {
      mocks.steps.push("rollback");
      throw error;
    }
  },
};

function connectionTest(read: string[] = []) {
  const secrets = {
    get commandFingerprintKey() {
      read.push("commandFingerprintKey");
      return "core-slack-test-signing-material";
    },
    operatorCredentials: "enabled" as const,
  };
  return createSlackConnectionTest({
    transaction: slackConnectionTestTransaction(storage, secrets),
    secrets,
    startConnectionTest: async (id) => {
      mocks.steps.push("start");
      return mocks.start(id);
    },
  }).queueSlackConnectionTest;
}

function operator(project: string | null = null): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000c1104",
      memberUserId: "018f0000-0000-7000-8000-0000000c1105",
    }),
    credentialKind: "operator",
    organizationId,
    projectId: project,
    scopes: new Set(["slack:manage"]),
    credentialId: "core-slack-test-operator",
    correlationId: "018f0000-0000-7000-8000-0000000c1106",
  };
}

beforeEach(() => {
  mocks.steps.length = 0;
  mocks.builtOn.length = 0;
  mocks.authorizationOptions.length = 0;
  mocks.transactions = 0;
  mocks.queueConnectionTest.mockReset();
  mocks.queueConnectionTest.mockResolvedValue({ id: operationId });
  mocks.start.mockReset();
  mocks.start.mockResolvedValue(undefined);
});

describe("the Slack connection test over a storage", () => {
  test("queues in one transaction, re-checked first, keyed with the secret read then, and starts the task after the commit", async () => {
    const read: string[] = [];
    const context = operator();

    await expect(connectionTest(read)(context, input, meta)).resolves.toEqual({
      operationId,
      dispatched: true,
    });

    expect(mocks.transactions).toBe(1);
    expect(mocks.steps).toEqual([
      "begin",
      "assertCurrent",
      "queueConnectionTest",
      "commit",
      "start",
    ]);
    expect(mocks.builtOn).toEqual([
      ["authorization", mocks.tx],
      ["slack", mocks.tx],
    ]);
    expect(mocks.authorizationOptions).toEqual([
      { operatorCredentials: "enabled" },
    ]);
    expect(mocks.queueConnectionTest).toHaveBeenCalledWith({
      organizationId,
      installationId,
      channelId: "C012ABCDEF",
      userId: "018f0000-0000-7000-8000-0000000c1105",
      actor: context.actor,
      idempotencyKey: "core-slack-test-idempotency",
      expectedVersion: 0,
      fingerprintSecret: "core-slack-test-signing-material",
      correlationId: context.correlationId,
    });
    expect(mocks.start).toHaveBeenCalledWith(operationId);
    expect(read).toEqual(["commandFingerprintKey"]);
  });

  test("a start that fails leaves the operation pending, answered as not started", async () => {
    mocks.start.mockRejectedValue(new Error("job_deferred_to_worker"));

    await expect(connectionTest()(operator(), input, meta)).resolves.toEqual({
      operationId,
      dispatched: false,
    });
    expect(mocks.steps.at(-1)).toBe("start");
  });

  test("an operator bound to a project is refused before any transaction opens", async () => {
    const error = await connectionTest()(
      operator("018f0000-0000-7000-8000-0000000c1107"),
      input,
      meta,
    ).catch((refused: unknown) => refused);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.transactions).toBe(0);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  test("a queue the repository refuses starts nothing", async () => {
    mocks.queueConnectionTest.mockRejectedValue(
      new DomainError("not_found", "Installation was not found"),
    );

    await expect(
      connectionTest()(operator(), input, meta),
    ).rejects.toBeInstanceOf(DomainError);
    expect(mocks.steps).toEqual([
      "begin",
      "assertCurrent",
      "queueConnectionTest",
      "rollback",
    ]);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
