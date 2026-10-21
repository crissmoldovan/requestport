import { describe, expect, test } from "vitest";

import { agentScopes } from "../agents/agent-types.js";
import {
  type AuthorizedCommandContext,
  actorFingerprint,
} from "../shared/authorization.js";
import { AtomicCommandBus } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import {
  type JsonValue,
  keyedFingerprint,
  normalizedInputHash,
} from "../shared/idempotency.js";
import type { TransactionManager, UnitOfWork } from "../shared/unit-of-work.js";
import {
  findRestCommandTransport,
  requestLifecycleActions,
} from "../transport-metadata.js";
import { createCoreCommandRegistry } from "./core-commands.js";

/*
  Plan 13 F.1, B1's finding 1. `AtomicCommandBus` re-runs a definition's
  `authorize` before it answers from a stored receipt, so that "idempotency
  never bypasses current authorization". `transition_request` checked each
  action's scope only in `execute`, after reading the request, so a replay was
  answered without it. These run the real bus over the real registry; only
  the unit of work is a fake, and it serves no port at all, so any read of the
  request fails the test rather than answering it.
*/

const fingerprintSecret = "f1-step-3-command-fingerprint-secret";
const ids = {
  organization: "018f0000-0000-7000-8000-00000000f301",
  project: "018f0000-0000-7000-8000-00000000f302",
  request: "018f0000-0000-7000-8000-00000000f303",
  related: "018f0000-0000-7000-8000-00000000f304",
  agent: "018f0000-0000-7000-8000-00000000f305",
};
const idempotencyKey = "f1-step-3-replayed-lifecycle-key";

const transitionFixture = {
  requestId: ids.request,
  reason: "A stated reason",
  relatedRequestId: ids.related,
  verificationEvidence: "Checked by hand",
  report: {
    outcomeMd: "Done",
    changedRepositories: [],
    validations: [{ command: "pnpm test", result: "passed" }],
    risksMd: "",
    followupsMd: "",
    verificationStepsMd: "Run the suite",
  },
};

function agentContext(scopes: Iterable<string>): AuthorizedCommandContext {
  return {
    actor: { type: "agent", id: ids.agent },
    organizationId: ids.organization,
    projectId: ids.project,
    scopes: new Set(scopes),
    credentialId: "f1-step-3-credential",
    correlationId: "f1-step-3-correlation",
  };
}

/** The scope the registry gives a lifecycle name. */
function scopeOf(action: string) {
  const scope = findRestCommandTransport(action)?.scope;
  if (scope?.kind !== "fixed") throw new Error(`${action} has no fixed scope`);
  return scope.scope;
}

function inputFor(action: string) {
  return { ...transitionFixture, organizationId: ids.organization, action };
}

/**
 * A unit of work holding one receipt: the one the bus itself would have
 * stored when `context`'s actor first ran `input` under `idempotencyKey`.
 */
function harness(stored?: { input: unknown; result: JsonValue }) {
  const registry = createCoreCommandRegistry();
  const definition = registry.resolve("transition_request");
  if (!definition) throw new Error("transition_request is not registered");
  const portsRead: string[] = [];
  const saved: unknown[] = [];
  const receiptKey = (actor: AuthorizedCommandContext["actor"]) =>
    `${actorFingerprint(actor)}|transition_request|${keyedFingerprint(
      fingerprintSecret,
      idempotencyKey,
    )}`;
  const receipts = new Map<
    string,
    { normalizedInputHash: string; result: JsonValue }
  >();
  const actor = agentContext([]).actor;
  if (stored)
    receipts.set(receiptKey(actor), {
      normalizedInputHash: normalizedInputHash(definition.parse(stored.input)),
      result: stored.result,
    });
  const uow: UnitOfWork = {
    commandReceipts: {
      lock: async () => undefined,
      find: async (key) =>
        receipts.get(
          `${key.actorFingerprint}|${key.commandName}|${key.idempotencyFingerprint}`,
        ) ?? null,
      save: async (row) => {
        saved.push(row);
      },
    },
    domainEvents: { append: async () => undefined },
    port: <T>(name: string): T => {
      portsRead.push(name);
      throw new Error(`RequestPort command port is unavailable: ${name}`);
    },
  };
  const transactions: TransactionManager = { run: (work) => work(uow) };
  const bus = new AtomicCommandBus({
    registry,
    transactions,
    fingerprintSecret,
  });
  return {
    portsRead,
    saved,
    execute: (context: AuthorizedCommandContext, input: unknown) =>
      bus.execute({
        name: "transition_request",
        input,
        context,
        meta: { idempotencyKey, expectedVersion: 1 },
      }),
  };
}

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, and the command was answered");
}

describe("a replayed transition_request, through the real bus", () => {
  test("covers every lifecycle action", () => {
    expect(requestLifecycleActions).toHaveLength(15);
  });

  test.each(requestLifecycleActions.map((action) => [action, scopeOf(action)]))(
    "%s is refused without %s, though its receipt matches",
    async (action, scope) => {
      const input = inputFor(action);
      const run = harness({ input, result: { replayed: action } });

      const error = await refusal(
        run.execute(
          agentContext(agentScopes.filter((held) => held !== scope)),
          input,
        ),
      );

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "forbidden", details: { scope } });
      expect(run.portsRead).toEqual([]);
      expect(run.saved).toEqual([]);
    },
  );

  test.each(requestLifecycleActions.map((action) => [action, scopeOf(action)]))(
    "%s is answered from its receipt holding only %s (the control)",
    async (action, scope) => {
      const input = inputFor(action);
      const run = harness({ input, result: { replayed: action } });

      await expect(run.execute(agentContext([scope]), input)).resolves.toEqual({
        replayed: action,
      });
      expect(run.portsRead).toEqual([]);
    },
  );

  // Declared in track-f1.md §3b: before the fix, a reused key with different
  // input was answered 409 `idempotency_conflict` whatever the caller held,
  // because the receipt was compared before any scope was checked.
  test("a reused key with different input is refused as forbidden without the scope, not as an idempotency conflict", async () => {
    const scope = scopeOf("accept_request");
    const run = harness({
      input: inputFor("accept_request"),
      result: { replayed: "accept_request" },
    });

    const error = await refusal(
      run.execute(agentContext(agentScopes.filter((held) => held !== scope)), {
        ...inputFor("accept_request"),
        reason: "A different reason",
      }),
    );

    expect(error).toMatchObject({ code: "forbidden", details: { scope } });
    expect(run.portsRead).toEqual([]);
  });

  test("a reused key with different input is an idempotency conflict holding the scope (the control)", async () => {
    const run = harness({
      input: inputFor("accept_request"),
      result: { replayed: "accept_request" },
    });

    const error = await refusal(
      run.execute(agentContext([scopeOf("accept_request")]), {
        ...inputFor("accept_request"),
        reason: "A different reason",
      }),
    );

    expect(error).toMatchObject({ code: "idempotency_conflict" });
    expect(run.portsRead).toEqual([]);
  });
});

describe("transition_request's action scope, on a first run", () => {
  test.each(requestLifecycleActions.map((action) => [action, scopeOf(action)]))(
    "%s is refused without %s before the request is read",
    async (action, scope) => {
      const run = harness();

      const error = await refusal(
        run.execute(
          agentContext(agentScopes.filter((held) => held !== scope)),
          inputFor(action),
        ),
      );

      expect(error).toMatchObject({ code: "forbidden", details: { scope } });
      expect(run.portsRead).toEqual([]);
    },
  );

  test("an action with no scope in the table is refused, not let through", async () => {
    // Unreachable through the bus, whose `parse` admits only the fifteen; this
    // calls the registered definition's `authorize` directly to reach it.
    const definition =
      createCoreCommandRegistry().resolve("transition_request");
    const uow = harness();

    const error = await refusal(
      definition?.authorize(
        agentContext(agentScopes),
        { ...inputFor("accept_request"), action: "constructor" },
        {} as UnitOfWork,
      ) ?? Promise.resolve(),
    );

    expect(error).toMatchObject({
      code: "forbidden",
      message: "Required capability is missing",
    });
    // Refused for having no scope to check, not by checking an inherited one.
    expect((error as DomainError).details).toEqual({});
    expect(uow.portsRead).toEqual([]);
  });

  test("a service actor is still refused as one, before any scope is read", async () => {
    const run = harness();

    const error = await refusal(
      run.execute(
        {
          ...agentContext([]),
          actor: { type: "service", id: "f1-step-3-service" },
        },
        inputFor("accept_request"),
      ),
    );

    expect(error).toMatchObject({
      code: "forbidden",
      message: "A user or agent actor is required",
    });
    expect(run.portsRead).toEqual([]);
  });
});
