import { z } from "zod";

import { memberAuthority } from "../operators/operator-types.js";
import {
  type RetentionHoldCategory,
  retentionHoldCategories,
} from "../retention/retention-service.js";
import {
  type ActorRef,
  type AuthorizedCommandContext,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition, CommandMeta } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import { utf16Max, utf16Min } from "../shared/zod-compat.js";

/*
  Delivery recovery and retention holds, as commands on the tenant bus (Plan
  13, F.2.4). The six operations forms dispatch these, and so does `/api/v1`,
  for an operator credential only: each has a capability registry entry
  naming `credentialKinds: ["operator"]` and no MCP tool. Each one checks
  `operations:manage`, the organisation, the member whose authority it runs
  with (`memberAuthority`: the signed-in person, or an operator's issuing
  member) and that the context is bound to no project, since every row these
  act on belongs to the organisation. It then asks its port whether that
  member may operate the organisation — an active owner or admin of the
  active organisation, the rule each write applies again — before the bus
  answers a replay or runs the write.

  The repository does the write, in its own savepoint inside the bus's
  transaction, with its audit row there; a hold's write also records its
  `retention.hold_changed.v1` event and outbox row. The commands return no
  events of their own, so the bus's after-commit dispatch does not fire for
  these. The forms start the requeued task themselves once the command has
  committed, as they did before; any other caller leaves it to the scheduled
  repair runs (ruling 7).
*/

/** The scope every operations command requires. */
export const operationsScope = "operations:manage";

/** The unit-of-work port the four requeues write through. */
export const operationsPortName = "operationsCommands";

/** The unit-of-work port the two retention hold commands write through. */
export const retentionHoldPortName = "retentionHoldCommands";

const organization = z.object({ organizationId: z.uuid() });
const outboxInput = organization.extend({ outboxId: z.uuid() });
const notificationInput = organization.extend({
  notificationIntentId: z.uuid(),
});
const slackOperationInput = organization.extend({ operationId: z.uuid() });
const importDispatchInput = organization.extend({ dispatchId: z.uuid() });
const holdCreateInput = organization.extend({
  category: z.enum(retentionHoldCategories),
  reason: z.string().trim().check(utf16Min(8)).check(utf16Max(500)),
});
const holdReleaseInput = organization.extend({ holdId: z.uuid() });

/**
 * The input schema each operations command parses with, by command name.
 * These are the same objects the definitions below call `parse` on. The
 * operations forms parse their submissions with the same fields
 * (`settings/operations/actions.ts`).
 */
export const operationsCommandInputSchemas = {
  requeue_outbox: outboxInput,
  requeue_notification: notificationInput,
  requeue_slack_operation: slackOperationInput,
  requeue_import_dispatch: importDispatchInput,
  create_retention_hold: holdCreateInput,
  release_retention_hold: holdReleaseInput,
} as const;

export type OperationsCommandName = keyof typeof operationsCommandInputSchemas;

/** Whose authority a write runs under, in which organisation. */
export interface OperationsOperator {
  userId: string;
  organizationId: string;
}

/**
 * A write: its operator, the version it expects — a requeue's row's attempt
 * count, a hold's version, or zero for a new hold — its correlation, and the
 * context's actor. `userId` is the member whose authority the write runs
 * with, and whom a hold records as its creator or releaser; `actor` is who
 * acts — that member for a person, the `service` actor `operator:<lineage>`
 * for an operator — and is what the audit row and a hold's event record.
 */
export interface OperationsMutation extends OperationsOperator {
  correlationId: string;
  expectedVersion: number;
  actor: ActorRef;
}

/**
 * The operations repository, as the requeues reach it through the unit of
 * work. `authorize` throws unless `userId` is an active owner or admin of the
 * active organisation. Every requeue checks the same again, then the row's
 * organisation, its attempt count and its state, before it writes.
 */
export interface OperationsPort {
  authorize(operator: OperationsOperator): Promise<void>;
  requeueOutbox(
    mutation: OperationsMutation,
    outboxId: string,
  ): Promise<{ outboxId: string; eventId: string }>;
  requeueNotification(
    mutation: OperationsMutation,
    notificationIntentId: string,
  ): Promise<{ notificationIntentId: string }>;
  requeueSlackOperation(
    mutation: OperationsMutation,
    operationId: string,
  ): Promise<{
    operationId: string;
    operationType: "message_update" | "connection_test";
  }>;
  requeueImportDispatch(
    mutation: OperationsMutation,
    dispatchId: string,
  ): Promise<{ dispatchId: string }>;
}

/**
 * The retention hold repository, as the hold commands reach it. `authorize`
 * throws unless `userId` is an active owner or admin of the active
 * organisation, and both writes check the same again.
 */
export interface RetentionHoldPort {
  authorize(operator: OperationsOperator): Promise<void>;
  create(
    mutation: OperationsMutation,
    input: { category: RetentionHoldCategory; reason: string },
  ): Promise<{ id: string; version: number }>;
  release(
    mutation: OperationsMutation,
    holdId: string,
  ): Promise<{ id: string; version: number }>;
}

/**
 * The member an operations command acts for: the one whose role authorises
 * it, and whom the repository's checks and a hold's creator and releaser
 * name. It is `memberAuthority(context)` (Plan 13, F.3, F3-2): the person for
 * a `user` actor, the issuing member for a well-formed operator context, and
 * nobody — so `forbidden` before any repository runs — for an agent, for any
 * other service actor, and for a context that claims to be an operator's
 * without being one.
 *
 * A `user` actor is taken as the person it names. That includes the MCP
 * route's provisioning delegation, which presents the delegating person as a
 * `user` actor holding `humanScopes` (so `operations:manage`); it cannot reach
 * these commands because no MCP tool names them (each registry entry's
 * `mcpTool` is null), and `/api/v1` authenticates no `user` actor.
 */
function operatingMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Operations require a person or an operator credential",
    );
  return member.userId;
}

/**
 * Every row these commands act on — an outbox row, a notification intent, a
 * Slack operation, an import dispatch, a retention hold — belongs to the
 * organisation, not to a project, so a context bound to a project is refused,
 * as the two operations reads refuse one (`organization`-bound,
 * `manifest-f2.md` §4.1). A person's context carries no project.
 */
function requireOrganizationWide(context: AuthorizedCommandContext) {
  if (context.projectId)
    throw new DomainError(
      "forbidden",
      "Operations require a credential bound to no project",
    );
}

/**
 * The operator a command runs as, after the checks that need no repository:
 * the scope, the organisation, the acting member, and that the context is
 * bound to no project.
 */
function operator(
  context: AuthorizedCommandContext,
  input: { organizationId: string },
): OperationsOperator {
  requireScope(context, operationsScope);
  requireOrganization(context, input.organizationId);
  const userId = operatingMember(context);
  requireOrganizationWide(context);
  return { userId, organizationId: input.organizationId };
}

interface OperationsPortAccess {
  authorize(operator: OperationsOperator): Promise<void>;
}

function operationsCommand<
  TSchema extends z.ZodType<{ organizationId: string }>,
  TPort extends OperationsPortAccess,
>(
  name: OperationsCommandName,
  schema: TSchema,
  portName: string,
  write: (
    port: TPort,
    mutation: OperationsMutation,
    input: z.output<TSchema>,
  ) => Promise<{ result: JsonObject; aggregateId: string }>,
): CommandDefinition<unknown, JsonObject> {
  const port = (uow: UnitOfWork) => uow.port<TPort>(portName);
  return {
    name,
    parse: (input) => schema.parse(input),
    async authorize(context, rawInput, uow) {
      const input = schema.parse(rawInput);
      await port(uow).authorize(operator(context, input));
    },
    async execute(uow, context, rawInput, meta: CommandMeta) {
      const input = schema.parse(rawInput);
      const mutation: OperationsMutation = {
        ...operator(context, input),
        correlationId: context.correlationId,
        expectedVersion: meta.expectedVersion,
        actor: context.actor,
      };
      const { result, aggregateId } = await write(port(uow), mutation, input);
      return { result, aggregateId, events: [] };
    },
  };
}

export function createOperationsCommandDefinitions(): Array<
  CommandDefinition<unknown, JsonObject>
> {
  return [
    operationsCommand<typeof outboxInput, OperationsPort>(
      "requeue_outbox",
      outboxInput,
      operationsPortName,
      async (port, mutation, input) => {
        const result = await port.requeueOutbox(mutation, input.outboxId);
        return {
          result: { outboxId: result.outboxId, eventId: result.eventId },
          aggregateId: result.outboxId,
        };
      },
    ),
    operationsCommand<typeof notificationInput, OperationsPort>(
      "requeue_notification",
      notificationInput,
      operationsPortName,
      async (port, mutation, input) => {
        const result = await port.requeueNotification(
          mutation,
          input.notificationIntentId,
        );
        return {
          result: { notificationIntentId: result.notificationIntentId },
          aggregateId: result.notificationIntentId,
        };
      },
    ),
    operationsCommand<typeof slackOperationInput, OperationsPort>(
      "requeue_slack_operation",
      slackOperationInput,
      operationsPortName,
      async (port, mutation, input) => {
        const result = await port.requeueSlackOperation(
          mutation,
          input.operationId,
        );
        return {
          result: {
            operationId: result.operationId,
            operationType: result.operationType,
          },
          aggregateId: result.operationId,
        };
      },
    ),
    operationsCommand<typeof importDispatchInput, OperationsPort>(
      "requeue_import_dispatch",
      importDispatchInput,
      operationsPortName,
      async (port, mutation, input) => {
        const result = await port.requeueImportDispatch(
          mutation,
          input.dispatchId,
        );
        return {
          result: { dispatchId: result.dispatchId },
          aggregateId: result.dispatchId,
        };
      },
    ),
    operationsCommand<typeof holdCreateInput, RetentionHoldPort>(
      "create_retention_hold",
      holdCreateInput,
      retentionHoldPortName,
      async (port, mutation, input) => {
        const result = await port.create(mutation, {
          category: input.category,
          reason: input.reason,
        });
        return {
          result: { id: result.id, version: result.version },
          aggregateId: result.id,
        };
      },
    ),
    operationsCommand<typeof holdReleaseInput, RetentionHoldPort>(
      "release_retention_hold",
      holdReleaseInput,
      retentionHoldPortName,
      async (port, mutation, input) => {
        const result = await port.release(mutation, input.holdId);
        return {
          result: { id: result.id, version: result.version },
          aggregateId: result.id,
        };
      },
    ),
  ];
}
