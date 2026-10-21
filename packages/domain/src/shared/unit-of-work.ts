import type { DomainEvent } from "./command.js";
import type { JsonValue } from "./idempotency.js";

export interface CommandReceiptRecord {
  normalizedInputHash: string;
  aggregateId?: string;
  result: JsonValue;
}

export interface CommandReceiptStore {
  lock(args: {
    actorFingerprint: string;
    commandName: string;
    idempotencyFingerprint: string;
  }): Promise<void>;
  find(args: {
    actorFingerprint: string;
    commandName: string;
    idempotencyFingerprint: string;
  }): Promise<CommandReceiptRecord | null>;
  save(args: {
    actorFingerprint: string;
    commandName: string;
    idempotencyFingerprint: string;
    normalizedInputHash: string;
    aggregateId?: string;
    result: JsonValue;
    expiresAt: Date;
  }): Promise<void>;
}

export interface DomainEventStore {
  append(events: readonly DomainEvent[]): Promise<void>;
}

export interface UnitOfWork {
  commandReceipts: CommandReceiptStore;
  domainEvents: DomainEventStore;
  port<T>(name: string): T;
}

/**
 * What a command transaction serves, bound before `work` runs (Plan 13,
 * Track I.2; manifest-i2.md §2.3 item 1): an organisation, with the human
 * acting in it when there is one, or a user alone for the session-only user
 * bus. Omitted, the transaction starts unbound.
 */
export interface TransactionBinding {
  organizationId?: string;
  userId?: string;
}

export interface TransactionManager {
  run<T>(
    work: (uow: UnitOfWork) => Promise<T>,
    binding?: TransactionBinding,
  ): Promise<T>;
}
