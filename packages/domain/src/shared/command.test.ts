import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { MetricSink } from "../observability/metrics.js";
import type {
  AuthenticatedUserCommandContext,
  AuthorizedCommandContext,
  CommandActorContext,
} from "./authorization.js";
import {
  AtomicCommandBus,
  type CommandDefinition,
  CommandRegistry,
  type DomainEvent,
} from "./command.js";
import type { JsonObject, JsonValue } from "./idempotency.js";
import type {
  TransactionBinding,
  TransactionManager,
  UnitOfWork,
} from "./unit-of-work.js";

const fingerprintSecret = "requestport-shared-command-secret-value";
const userId = "user_01JQ0000000000000000000009";
const organizationId = "8f6b0f2a-0000-4000-8000-0000000000ff";

type ReceiptRow = {
  normalizedInputHash: string;
  result: JsonValue;
  expiresAt: number;
};

/**
 * The smallest unit of work that still exercises the real receipt algorithm.
 * Both bus flavours are pointed at it so any divergence between the tenant and
 * the authenticated-user path shows up as a behavioural difference here rather
 * than as a second, weaker implementation.
 */
function harness() {
  const receipts = new Map<string, ReceiptRow>();
  const events: DomainEvent[] = [];
  const locks: string[] = [];
  let now = Date.now();
  const uow: UnitOfWork = {
    commandReceipts: {
      lock: async (key) => {
        locks.push(
          `${key.actorFingerprint}|${key.commandName}|${key.idempotencyFingerprint}`,
        );
      },
      find: async (key) => {
        const stored = receipts.get(
          `${key.actorFingerprint}|${key.commandName}|${key.idempotencyFingerprint}`,
        );
        if (!stored || stored.expiresAt <= now) return null;
        return {
          normalizedInputHash: stored.normalizedInputHash,
          result: stored.result,
        };
      },
      save: async (input) => {
        receipts.set(
          `${input.actorFingerprint}|${input.commandName}|${input.idempotencyFingerprint}`,
          {
            normalizedInputHash: input.normalizedInputHash,
            result: input.result,
            expiresAt: input.expiresAt.getTime(),
          },
        );
      },
    },
    domainEvents: {
      append: async (appended) => {
        events.push(...appended);
      },
    },
    port: () => {
      throw new Error("RequestPort command port is unavailable");
    },
  };
  const transactions: TransactionManager = { run: (work) => work(uow) };
  return {
    events,
    locks,
    receipts,
    transactions,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    get now() {
      return now;
    },
  };
}

const inputSchema = z.strictObject({ value: z.string().min(1) });

function echoCommand<TContext extends CommandActorContext>(
  name: string,
): CommandDefinition<unknown, JsonObject, TContext> {
  let executions = 0;
  return {
    name,
    parse: (input) => inputSchema.parse(input),
    authorize: async () => undefined,
    execute: async (_uow, _context, rawInput) => {
      executions += 1;
      const input = inputSchema.parse(rawInput);
      return {
        result: { value: input.value, executions },
        aggregateId: undefined,
        events: [],
      };
    },
  };
}

function metricSink() {
  const counts: Array<{ name: string; labels: Record<string, string> }> = [];
  const observations: string[] = [];
  const sink: MetricSink = {
    count: (name, _value, labels) => {
      counts.push({ name, labels: labels ?? {} });
    },
    observe: (name) => {
      observations.push(name);
    },
    gauge: () => undefined,
  };
  return { counts, observations, sink };
}

function tenantContext(): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set<string>(),
    credentialId: "session_1",
    correlationId: "correlation-1",
  };
}

function userContext(): AuthenticatedUserCommandContext {
  return {
    actor: { type: "user", id: userId },
    credentialId: "session_1",
    correlationId: "correlation-1",
  };
}

describe("shared atomic command execution", () => {
  /**
   * That both buses are the same implementation, asserted against something
   * that could be otherwise.
   *
   * This used to build an `AtomicCommandBus` and assert it was an
   * `AtomicCommandBus` — true of the constructor by definition, and true with
   * the whole class body deleted. What it was reaching for is that the
   * authenticated-user bus and the tenant bus are not two implementations
   * whose behaviour could drift apart, so the property worth pinning is that
   * the two share their method table, not that each is an instance of the
   * class it was constructed from.
   */
  test("runs the authenticated-user bus on exactly the tenant implementation", () => {
    const environment = harness();
    const userBus = new AtomicCommandBus<AuthenticatedUserCommandContext>({
      registry: new CommandRegistry<AuthenticatedUserCommandContext>(),
      transactions: environment.transactions,
      fingerprintSecret,
    });
    const tenantBus = new AtomicCommandBus<AuthorizedCommandContext>({
      registry: new CommandRegistry<AuthorizedCommandContext>(),
      transactions: environment.transactions,
      fingerprintSecret,
    });

    expect(Object.getPrototypeOf(userBus)).toBe(
      Object.getPrototypeOf(tenantBus),
    );
    // And that the shared table is not empty, so a class whose body was
    // removed could not satisfy the line above by having nothing to share.
    const shared = Object.getOwnPropertyNames(
      Object.getPrototypeOf(userBus),
    ).filter((name) => name !== "constructor");
    expect(shared).toContain("execute");
    expect(shared.length).toBeGreaterThan(0);
  });

  test.each(["tenant", "user"] as const)(
    "validates metadata, locks the receipt, and replays on the %s bus",
    async (flavour) => {
      const environment = harness();
      const registry = new CommandRegistry<CommandActorContext>();
      registry.register(echoCommand<CommandActorContext>("echo"));
      const bus = new AtomicCommandBus<CommandActorContext>({
        registry,
        transactions: environment.transactions,
        fingerprintSecret,
        receiptTtlMs: 60_000,
      });
      const context: CommandActorContext =
        flavour === "tenant" ? tenantContext() : userContext();

      await expect(
        bus.execute({
          name: "echo",
          input: { value: "one" },
          context,
          meta: { idempotencyKey: "short", expectedVersion: 0 },
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });

      const first = await bus.execute({
        name: "echo",
        input: { value: "one" },
        context,
        meta: { idempotencyKey: "shared-command-key-one", expectedVersion: 0 },
      });
      const replay = await bus.execute({
        name: "echo",
        input: { value: "one" },
        context,
        meta: { idempotencyKey: "shared-command-key-one", expectedVersion: 0 },
      });

      expect(first).toEqual({ value: "one", executions: 1 });
      expect(replay).toEqual(first);
      // Invalid metadata is rejected before the transaction opens, so only the
      // two accepted executions take the receipt lock — and both take the same
      // one, which is what makes the replay path serialize.
      expect(environment.locks).toHaveLength(2);
      expect(environment.locks[0]).toBe(environment.locks[1]);

      await expect(
        bus.execute({
          name: "echo",
          input: { value: "two" },
          context,
          meta: {
            idempotencyKey: "shared-command-key-one",
            expectedVersion: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      await expect(
        bus.execute({
          name: "echo",
          input: { value: "" },
          context,
          meta: {
            idempotencyKey: "shared-command-key-two",
            expectedVersion: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });

      await expect(
        bus.execute({
          name: "missing",
          input: { value: "one" },
          context,
          meta: {
            idempotencyKey: "shared-command-key-three",
            expectedVersion: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    },
  );

  test.each(["tenant", "user"] as const)(
    "rejects secret material in %s bus input before authorization",
    async (flavour) => {
      const environment = harness();
      const registry = new CommandRegistry<CommandActorContext>();
      const passthrough: CommandDefinition<
        unknown,
        JsonObject,
        CommandActorContext
      > = {
        name: "secretish",
        parse: (input) => input,
        authorize: async () => {
          throw new Error("authorization must not run");
        },
        execute: async () => ({ result: {}, events: [] }),
      };
      registry.register(passthrough);
      const bus = new AtomicCommandBus<CommandActorContext>({
        registry,
        transactions: environment.transactions,
        fingerprintSecret,
      });
      const context: CommandActorContext =
        flavour === "tenant" ? tenantContext() : userContext();

      await expect(
        bus.execute({
          name: "secretish",
          // The field name alone is prohibited, so the case needs no
          // credential-shaped literal to prove the boundary rejects it.
          input: { token: "placeholder" },
          context,
          meta: {
            idempotencyKey: "shared-command-secret-key",
            expectedVersion: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    },
  );

  /**
   * A refusal an agent can act on.
   *
   * The bus wraps a schema failure into `validation_failed` and used to discard
   * the issue with it, so a caller learned only that its input was invalid —
   * across a command with a dozen fields, and with nothing written to any log
   * either. The issue *path* is a field name, which is schema rather than data,
   * and the MCP layer already publishes a `field` detail after checking it
   * against a strict pattern. The value and the message stay inside.
   */
  test("names the field a refused input failed on", async () => {
    const environment = harness();
    const registry = new CommandRegistry<CommandActorContext>();
    registry.register(echoCommand<CommandActorContext>("echo"));
    const bus = new AtomicCommandBus<CommandActorContext>({
      registry,
      transactions: environment.transactions,
      fingerprintSecret,
    });

    await expect(
      bus.execute({
        name: "echo",
        input: { value: "" },
        context: tenantContext(),
        meta: {
          idempotencyKey: "shared-command-key-field",
          expectedVersion: 0,
        },
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "value" },
    });
  });

  /**
   * A free-form input's bound, carried through (ruling 237 item 3). The bus
   * publishes a custom issue's `params.bound` and `params.maximum` as the
   * refusal's `bound` and `maximum` details when the bound is one of the
   * three `freeFormJsonRefusal` names and the maximum a positive integer;
   * anything else in `params`, and a `params` that fails either check, stays
   * inside.
   */
  test.each([
    {
      params: { bound: "elements", maximum: 3, extra: "kept inside" },
      details: { field: "value", bound: "elements", maximum: 3 },
    },
    {
      params: { bound: "depth", maximum: 8 },
      details: { field: "value", bound: "depth", maximum: 8 },
    },
    {
      params: { bound: "bytes", maximum: 65_536 },
      details: { field: "value", bound: "bytes", maximum: 65_536 },
    },
    { params: { bound: "keys", maximum: 3 }, details: { field: "value" } },
    { params: { bound: "elements", maximum: 0 }, details: { field: "value" } },
    {
      params: { bound: "elements", maximum: 2.5 },
      details: { field: "value" },
    },
    {
      params: { bound: "elements", maximum: "3" },
      details: { field: "value" },
    },
    { params: { maximum: 3 }, details: { field: "value" } },
    { params: undefined, details: { field: "value" } },
  ])(
    "publishes the bound a refusal's params name, checked: $params",
    async ({ params, details }) => {
      const environment = harness();
      const registry = new CommandRegistry<CommandActorContext>();
      const bounded = z.object({
        value: z.string().superRefine((_value, context) => {
          context.addIssue({
            code: "custom",
            message: "internal wording",
            ...(params === undefined ? {} : { params }),
          });
        }),
      });
      registry.register({
        ...echoCommand<CommandActorContext>("bounded"),
        parse: (input) => bounded.parse(input),
      });
      const bus = new AtomicCommandBus<CommandActorContext>({
        registry,
        transactions: environment.transactions,
        fingerprintSecret,
      });

      const refused = await bus
        .execute({
          name: "bounded",
          input: { value: "x" },
          context: tenantContext(),
          meta: {
            idempotencyKey: "shared-command-key-bound",
            expectedVersion: 0,
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error as { code?: string; details?: unknown },
        );
      expect({ code: refused?.code, details: refused?.details }).toEqual({
        code: "validation_failed",
        details,
      });
    },
  );

  test("a refusal by a schema's built-in check names the field alone", async () => {
    const environment = harness();
    const registry = new CommandRegistry<CommandActorContext>();
    registry.register(echoCommand<CommandActorContext>("echo"));
    const bus = new AtomicCommandBus<CommandActorContext>({
      registry,
      transactions: environment.transactions,
      fingerprintSecret,
    });

    const refused = await bus
      .execute({
        name: "echo",
        input: { value: "" },
        context: tenantContext(),
        meta: {
          idempotencyKey: "shared-command-key-no-bound",
          expectedVersion: 0,
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error as { details?: unknown },
      );
    expect(refused?.details).toEqual({ field: "value" });
  });

  test("keeps receipt time-to-live and metrics identical on both buses", async () => {
    const environment = harness();
    const metrics = metricSink();
    const registry = new CommandRegistry<AuthenticatedUserCommandContext>();
    registry.register(echoCommand<AuthenticatedUserCommandContext>("echo"));
    const bus = new AtomicCommandBus<AuthenticatedUserCommandContext>({
      registry,
      transactions: environment.transactions,
      fingerprintSecret,
      receiptTtlMs: 1_000,
      metrics: metrics.sink,
    });

    const first = await bus.execute({
      name: "echo",
      input: { value: "ttl" },
      context: userContext(),
      meta: { idempotencyKey: "shared-command-ttl-key", expectedVersion: 0 },
    });
    expect(first).toEqual({ value: "ttl", executions: 1 });

    environment.advance(2_000);
    const afterExpiry = await bus.execute({
      name: "echo",
      input: { value: "ttl" },
      context: userContext(),
      meta: { idempotencyKey: "shared-command-ttl-key", expectedVersion: 0 },
    });
    expect(afterExpiry).toEqual({ value: "ttl", executions: 2 });

    await expect(
      bus.execute({
        name: "echo",
        input: { value: "" },
        context: userContext(),
        meta: {
          idempotencyKey: "shared-command-ttl-key-2",
          expectedVersion: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(metrics.counts.map((entry) => entry.name)).toContain(
      "command.error_total",
    );
    expect(metrics.observations).toContain("command.duration_ms");
  });

  test("fingerprints the actor so two users never share one receipt", async () => {
    const environment = harness();
    const registry = new CommandRegistry<AuthenticatedUserCommandContext>();
    registry.register(echoCommand<AuthenticatedUserCommandContext>("echo"));
    const bus = new AtomicCommandBus<AuthenticatedUserCommandContext>({
      registry,
      transactions: environment.transactions,
      fingerprintSecret,
    });

    await bus.execute({
      name: "echo",
      input: { value: "mine" },
      context: userContext(),
      meta: { idempotencyKey: "shared-command-actor-key", expectedVersion: 0 },
    });
    const other = await bus.execute({
      name: "echo",
      input: { value: "theirs" },
      context: {
        ...userContext(),
        actor: { type: "user", id: "user_01JQ000000000000000000000B" },
      },
      meta: { idempotencyKey: "shared-command-actor-key", expectedVersion: 0 },
    });

    expect(other).toEqual({ value: "theirs", executions: 2 });
    expect(environment.receipts.size).toBe(2);
  });
});

describe("the binding the bus hands its transaction (manifest-i2.md §2.3 item 1)", () => {
  /*
   * The command transaction manager binds what it is handed before the work
   * runs (packages/db's `createCommandTransactionManager`), so what the bus
   * hands it decides which organisation every tenant read in a command sees
   * and which organisation its receipt records. Recorded here from the
   * manager's second argument, once per execution.
   */
  function recordingEnvironment() {
    const environment = harness();
    const bindings: Array<TransactionBinding | undefined> = [];
    const transactions: TransactionManager = {
      run: (work, binding) => {
        bindings.push(binding);
        return environment.transactions.run(work);
      },
    };
    return { bindings, transactions };
  }

  test.each([
    [
      "a user, on the tenant bus: the organisation and the user",
      tenantContext(),
      { organizationId, userId },
    ],
    [
      "an agent, on the tenant bus: the organisation alone",
      {
        ...tenantContext(),
        actor: {
          type: "agent",
          id: "agent_1",
          delegatedBy: { type: "user", id: userId },
        },
      } satisfies AuthorizedCommandContext,
      { organizationId },
    ],
    [
      "a service, on the tenant bus: the organisation alone",
      {
        ...tenantContext(),
        actor: { type: "service", id: "requestport-work-sweep" },
      } satisfies AuthorizedCommandContext,
      { organizationId },
    ],
    [
      "a user, on the session-only user bus: the user alone",
      userContext(),
      { userId },
    ],
  ] as const)("%s", async (_name, context, expected) => {
    const { bindings, transactions } = recordingEnvironment();
    const registry = new CommandRegistry<CommandActorContext>();
    registry.register(echoCommand<CommandActorContext>("echo"));
    const bus = new AtomicCommandBus<CommandActorContext>({
      registry,
      transactions,
      fingerprintSecret,
    });

    await bus.execute({
      name: "echo",
      input: { value: "bound" },
      context,
      meta: { idempotencyKey: "shared-command-binding", expectedVersion: 0 },
    });

    expect(bindings).toEqual([expected]);
  });

  test("a context with neither an organisation nor a user starts unbound", async () => {
    const { bindings, transactions } = recordingEnvironment();
    const registry = new CommandRegistry<CommandActorContext>();
    registry.register(echoCommand<CommandActorContext>("echo"));
    const bus = new AtomicCommandBus<CommandActorContext>({
      registry,
      transactions,
      fingerprintSecret,
    });

    await bus.execute({
      name: "echo",
      input: { value: "unbound" },
      context: {
        actor: { type: "service", id: "requestport-probe" },
        credentialId: "service_1",
        correlationId: "correlation-1",
      },
      meta: { idempotencyKey: "shared-command-unbound", expectedVersion: 0 },
    });

    expect(bindings).toEqual([undefined]);
  });
});
