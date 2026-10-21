import { ZodError } from "zod";
import { type MetricSink, noopMetricSink } from "../observability/metrics.js";
import { containsSecretJson } from "../security/sensitive-content.js";
import {
  type ActorRef,
  type AuthorizedCommandContext,
  actorFingerprint,
  type CommandActorContext,
} from "./authorization.js";
import { DomainError } from "./errors.js";
import {
  canonicalJson,
  type JsonObject,
  type JsonValue,
  keyedFingerprint,
  normalizedInputHash,
  validateCommandMeta,
} from "./idempotency.js";
import type {
  TransactionBinding,
  TransactionManager,
  UnitOfWork,
} from "./unit-of-work.js";

export interface CommandMeta {
  idempotencyKey: string;
  expectedVersion: number;
}

export interface DomainEvent<TData extends JsonObject = JsonObject> {
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  organizationId: string;
  projectId?: string;
  requestId?: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  actor: ActorRef;
  correlationId: string;
  causationId: string;
  data: TData;
  links: Record<string, string>;
}

/**
 * `TContext` defaults to the tenant context so every existing command keeps its
 * exact signature. The authenticated-user bus instantiates the same generic
 * with `AuthenticatedUserCommandContext`, which is how both buses run one
 * executor instead of two.
 */
export interface CommandDefinition<
  I,
  O extends JsonValue,
  TContext extends CommandActorContext = AuthorizedCommandContext,
> {
  name: string;
  parse(input: unknown): I;
  authorize(context: TContext, input: I, uow: UnitOfWork): Promise<void>;
  execute(
    uow: UnitOfWork,
    context: TContext,
    input: I,
    meta: CommandMeta,
  ): Promise<{
    result: O;
    aggregateId?: string;
    events: DomainEvent[];
    afterEventsPersisted?: (
      uow: UnitOfWork,
      events: readonly DomainEvent[],
    ) => Promise<void>;
  }>;
}

type AnyCommandDefinition<TContext extends CommandActorContext> =
  CommandDefinition<unknown, JsonValue, TContext>;

export interface CommandBus<
  TContext extends CommandActorContext = AuthorizedCommandContext,
> {
  execute<TInput, TOutput extends JsonValue>(args: {
    name: string;
    input: TInput;
    context: TContext;
    meta: CommandMeta;
  }): Promise<TOutput>;
}

export class CommandRegistry<
  TContext extends CommandActorContext = AuthorizedCommandContext,
> {
  private readonly commands = new Map<string, AnyCommandDefinition<TContext>>();

  register<I, O extends JsonValue>(
    definition: CommandDefinition<I, O, TContext>,
  ) {
    if (this.commands.has(definition.name)) {
      throw new Error(`Duplicate command registration: ${definition.name}`);
    }
    this.commands.set(
      definition.name,
      definition as AnyCommandDefinition<TContext>,
    );
    return this;
  }

  resolve(name: string) {
    return this.commands.get(name);
  }

  names() {
    return [...this.commands.keys()].sort();
  }
}

/**
 * What a command's transaction is bound to before its work runs (Plan 13,
 * Track I.2; manifest-i2.md §2.3 item 1): the context's organisation, with
 * the user when the actor is one, on the tenant bus; the user alone on the
 * session-only user bus, whose context carries no organisation
 * (`assertAuthenticatedUserContext` refuses one). An agent or a service
 * actor binds the organisation only. With neither, the transaction starts
 * unbound.
 */
function commandTransactionBinding(
  context: CommandActorContext,
): TransactionBinding | undefined {
  const organizationId =
    "organizationId" in context && typeof context.organizationId === "string"
      ? context.organizationId
      : undefined;
  const userId = context.actor.type === "user" ? context.actor.id : undefined;
  if (organizationId === undefined && userId === undefined) return undefined;
  return {
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(userId === undefined ? {} : { userId }),
  };
}

export class AtomicCommandBus<
  TContext extends CommandActorContext = AuthorizedCommandContext,
> implements CommandBus<TContext>
{
  constructor(
    private readonly dependencies: {
      registry: CommandRegistry<TContext>;
      transactions: TransactionManager;
      fingerprintSecret: string;
      receiptTtlMs?: number;
      afterCommit?: (events: readonly DomainEvent[]) => Promise<void>;
      metrics?: MetricSink;
      authorizeContext?: (context: TContext, uow: UnitOfWork) => Promise<void>;
    },
  ) {}

  async execute<TInput, TOutput extends JsonValue>(args: {
    name: string;
    input: TInput;
    context: TContext;
    meta: CommandMeta;
  }): Promise<TOutput> {
    const startedAt = performance.now();
    const metrics = this.dependencies.metrics ?? noopMetricSink;
    let status = "ok";
    try {
      validateCommandMeta(args.meta);
      const definition = this.dependencies.registry.resolve(args.name);
      if (!definition) {
        throw new DomainError("not_found", "Command is not available");
      }
      let input: unknown;
      try {
        input = definition.parse(args.input);
      } catch (error) {
        if (error instanceof ZodError) {
          /*
            The field, carried through. Not the value.

            A refusal that says only "input is invalid" leaves the caller — an
            agent, with no debugger — to guess which of a dozen fields it got
            wrong, and leaves nothing in any log either. The issue *path* is a
            field name, which is schema rather than data, and the MCP layer
            already knows how to publish one: `publicDomainDetails` passes a
            `field` detail through after checking it against a strict pattern.
            The message and the value stay here.
          */
          const field = error.issues[0]?.path
            .filter((segment) => typeof segment !== "symbol")
            .join(".");

          throw new DomainError(
            "validation_failed",
            "Command input is invalid",
            typeof field === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(field)
              ? { field }
              : {},
          );
        }
        throw error;
      }
      if (containsSecretJson(input)) {
        throw new DomainError(
          "validation_failed",
          "Command input contains prohibited secret material",
        );
      }
      const inputHash = normalizedInputHash(input);
      const actorKey = actorFingerprint(args.context.actor);
      const idempotencyFingerprint = keyedFingerprint(
        this.dependencies.fingerprintSecret,
        args.meta.idempotencyKey,
      );

      const committed = await this.dependencies.transactions.run(
        async (uow) => {
          const receiptKey = {
            actorFingerprint: actorKey,
            commandName: definition.name,
            idempotencyFingerprint,
          };
          await uow.commandReceipts.lock(receiptKey);
          await this.dependencies.authorizeContext?.(args.context, uow);
          // Idempotency never bypasses current authorization. Re-checking inside
          // the command transaction keeps a revoked human or agent from using an
          // old receipt as a durable read capability after access is removed.
          await definition.authorize(args.context, input, uow);
          const existing = await uow.commandReceipts.find(receiptKey);
          if (existing) {
            if (existing.normalizedInputHash !== inputHash) {
              throw new DomainError(
                "idempotency_conflict",
                "Idempotency key was used with different input",
              );
            }
            return {
              output: JSON.parse(canonicalJson(existing.result)) as TOutput,
              events: [] as DomainEvent[],
            };
          }

          const execution = await definition.execute(
            uow,
            args.context,
            input,
            args.meta,
          );
          await uow.domainEvents.append(execution.events);
          await execution.afterEventsPersisted?.(uow, execution.events);
          await uow.commandReceipts.save({
            ...receiptKey,
            normalizedInputHash: inputHash,
            aggregateId: execution.aggregateId,
            result: execution.result,
            expiresAt: new Date(
              Date.now() +
                (this.dependencies.receiptTtlMs ?? 30 * 24 * 60 * 60 * 1_000),
            ),
          });
          return {
            output: execution.result as TOutput,
            events: execution.events,
          };
        },
        commandTransactionBinding(args.context),
      );
      if (committed.events.length && this.dependencies.afterCommit) {
        try {
          await this.dependencies.afterCommit(committed.events);
        } catch {
          // The outbox rows in the database remain the durable source for
          // scheduled repair.
        }
      }
      return committed.output;
    } catch (error) {
      status = error instanceof DomainError ? error.code : "unexpected_error";
      metrics.count("command.error_total", 1, {
        commandName: args.name,
        errorCode: status,
      });
      if (
        error instanceof DomainError &&
        ["conflict", "idempotency_conflict", "version_conflict"].includes(
          error.code,
        )
      ) {
        metrics.count("command.conflict_total", 1, {
          commandName: args.name,
          errorCode: error.code,
        });
      }
      throw error;
    } finally {
      metrics.observe("command.duration_ms", performance.now() - startedAt, {
        commandName: args.name,
        status,
      });
    }
  }
}
