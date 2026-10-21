import { DomainError, type JsonValue } from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";

import { commandReceipts } from "../schema/index.js";
import { boundOrganizationIdSql } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

export type MutationReceiptKey = {
  actorFingerprint: string;
  commandName: string;
  idempotencyFingerprint: string;
  normalizedInputHash: string;
  expiresAt: Date;
};

export async function lockMutationReceipt(tx: Tx, key: MutationReceiptKey) {
  const lockKey = `${key.actorFingerprint}:${key.commandName}:${key.idempotencyFingerprint}`;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('requestport:command:' || ${lockKey}, 0))`,
  );
  const [existing] = await tx
    .select({
      aggregateId: commandReceipts.aggregateId,
      normalizedInputHash: commandReceipts.normalizedInputHash,
      result: commandReceipts.resultJson,
    })
    .from(commandReceipts)
    .where(
      and(
        eq(commandReceipts.actorFingerprint, key.actorFingerprint),
        eq(commandReceipts.commandName, key.commandName),
        eq(commandReceipts.idempotencyFingerprint, key.idempotencyFingerprint),
      ),
    )
    .limit(1);
  if (existing && existing.normalizedInputHash !== key.normalizedInputHash) {
    throw new DomainError(
      "idempotency_conflict",
      "Idempotency key was used with different input",
    );
  }
  return existing
    ? {
        aggregateId: existing.aggregateId,
        result: existing.result as JsonValue,
      }
    : null;
}

/** The unique key every receipt is saved under; no row policy narrows it. */
const RECEIPT_KEY_CONSTRAINT = "command_receipts_actor_command_key_unique";

/**
 * Whether `error` is the receipts' unique key refusing an insert. The driver
 * error arrives wrapped, so the chain is walked a bounded way, and only that
 * one constraint counts.
 */
function isReceiptKeyTaken(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "23505") {
      return candidate.constraint === RECEIPT_KEY_CONSTRAINT;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Inserts a receipt, answering the unique key's refusal as the key's
 * conflict. Every caller saves after the read that follows its receipt lock
 * (`lockMutationReceipt`, or the command bus's `lock` and `find`), and that
 * read finds the key's receipt whenever the row policy lets it see one. So a
 * refusal here is a receipt the policy hides from this transaction: the same
 * actor, command and key saved with an organisation, or with none, other
 * than the one this transaction is bound to (0024; manifest-i2.md §2.1).
 * The refusal has already failed the statement, so the transaction cannot
 * commit. The answer is the one a visible receipt with other input gets, and
 * names nothing the actor's own key does not.
 */
export async function insertCommandReceipt(
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (isReceiptKeyTaken(error)) {
      throw new DomainError(
        "idempotency_conflict",
        "Idempotency key was used with different input",
      );
    }
    throw error;
  }
}

export async function saveMutationReceipt(
  tx: Tx,
  key: MutationReceiptKey,
  input: { aggregateId?: string | null; result: JsonValue },
) {
  // The organisation `tx` is bound to (manifest-i2.md §2.1).
  await insertCommandReceipt(() =>
    tx.insert(commandReceipts).values({
      organizationId: boundOrganizationIdSql,
      actorFingerprint: key.actorFingerprint,
      commandName: key.commandName,
      idempotencyFingerprint: key.idempotencyFingerprint,
      normalizedInputHash: key.normalizedInputHash,
      aggregateId: input.aggregateId ?? null,
      resultJson: input.result,
      expiresAt: key.expiresAt,
    }),
  );
}

export async function updateMutationReceipt(
  tx: Tx,
  key: MutationReceiptKey,
  input: { aggregateId?: string | null; result: JsonValue },
) {
  const [updated] = await tx
    .update(commandReceipts)
    .set({
      aggregateId: input.aggregateId ?? null,
      resultJson: input.result,
    })
    .where(
      and(
        eq(commandReceipts.actorFingerprint, key.actorFingerprint),
        eq(commandReceipts.commandName, key.commandName),
        eq(commandReceipts.idempotencyFingerprint, key.idempotencyFingerprint),
        eq(commandReceipts.normalizedInputHash, key.normalizedInputHash),
      ),
    )
    .returning({ id: commandReceipts.id });
  if (!updated) {
    throw new DomainError("not_found", "Command receipt was not found");
  }
}
