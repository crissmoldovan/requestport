import type {
  DomainEvent,
  JsonValue,
  TransactionBinding,
  TransactionManager,
  UnitOfWork,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { commandReceipts, domainEvents, outbox } from "../schema/index.js";
import {
  bindTenant,
  bindUser,
  boundOrganizationIdSql,
} from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { insertCommandReceipt } from "./mutation-receipt.js";

type CommandDatabase = Database | Tx;
export type CommandPortFactory = (
  name: string,
  database: CommandDatabase,
) => unknown;

function eventValues(event: DomainEvent) {
  return {
    id: event.id,
    organizationId: event.organizationId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    type: event.type,
    schemaVersion: event.schemaVersion,
    occurredAt: new Date(event.occurredAt),
    projectId: event.projectId,
    requestId: event.requestId,
    actor: event.actor,
    correlationId: event.correlationId,
    causationId: event.causationId,
    data: event.data,
    links: event.links,
  };
}

function createUnitOfWork(
  database: Tx,
  portFactory: CommandPortFactory,
): UnitOfWork {
  return {
    commandReceipts: {
      async lock(input) {
        const key = `${input.actorFingerprint}:${input.commandName}:${input.idempotencyFingerprint}`;
        await database.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('requestport:command:' || ${key}, 0))`,
        );
      },
      async find(input) {
        const [receipt] = await database
          .select({
            normalizedInputHash: commandReceipts.normalizedInputHash,
            aggregateId: commandReceipts.aggregateId,
            result: commandReceipts.resultJson,
          })
          .from(commandReceipts)
          .where(
            and(
              eq(commandReceipts.actorFingerprint, input.actorFingerprint),
              eq(commandReceipts.commandName, input.commandName),
              eq(
                commandReceipts.idempotencyFingerprint,
                input.idempotencyFingerprint,
              ),
            ),
          )
          .limit(1);
        return receipt
          ? {
              normalizedInputHash: receipt.normalizedInputHash,
              aggregateId: receipt.aggregateId ?? undefined,
              result: receipt.result as JsonValue,
            }
          : null;
      },
      async save(input) {
        // The organisation the transaction is bound to, or NULL for the
        // session-only user bus (manifest-i2.md §2.1). The bus saves after
        // `lock` and `find`, so the key's refusal is a receipt the policy
        // hides, answered as the key's conflict (`insertCommandReceipt`).
        await insertCommandReceipt(() =>
          database.insert(commandReceipts).values({
            organizationId: boundOrganizationIdSql,
            actorFingerprint: input.actorFingerprint,
            commandName: input.commandName,
            idempotencyFingerprint: input.idempotencyFingerprint,
            normalizedInputHash: input.normalizedInputHash,
            aggregateId: input.aggregateId,
            resultJson: input.result,
            expiresAt: input.expiresAt,
          }),
        );
      },
    },
    domainEvents: {
      async append(events) {
        if (events.length === 0) return;
        await database.insert(domainEvents).values(events.map(eventValues));
        await database.insert(outbox).values(
          events.map((event) => ({
            eventId: event.id,
            state: "pending",
          })),
        );
      },
    },
    port<T>(name: string) {
      const port = portFactory(name, database);
      if (port === undefined || port === null) {
        throw new Error(`RequestPort command port is unavailable: ${name}`);
      }
      return port as T;
    },
  };
}

async function bindCommandTransaction(tx: Tx, binding?: TransactionBinding) {
  if (binding?.organizationId !== undefined) {
    await bindTenant(
      tx,
      binding.organizationId,
      binding.userId === undefined ? {} : { userId: binding.userId },
    );
  } else if (binding?.userId !== undefined) {
    await bindUser(tx, binding.userId);
  }
}

/**
 * Every command transaction binds here, before its work runs (manifest-i2.md
 * §2.3 item 1), when the bus passes a binding; its first tenant read is the
 * bus's authorisation, which reads organisation tables.
 */
export function createCommandTransactionManager(
  database: Database,
  portFactory: CommandPortFactory = () => undefined,
): TransactionManager {
  return {
    run<T>(
      work: (uow: UnitOfWork) => Promise<T>,
      binding?: TransactionBinding,
    ) {
      return database.transaction(async (tx) => {
        await bindCommandTransaction(tx, binding);
        return work(createUnitOfWork(tx, portFactory));
      });
    },
  };
}
