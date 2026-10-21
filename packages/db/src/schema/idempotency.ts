import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/*
  The receipt of one idempotent command (plan 13, I.2; manifest-i2.md §2.1).

  `organization_id` was added by 0019, and every insert writes it from the
  transaction's binding (`boundOrganizationIdSql` in tenant-context.ts): the
  organisation bound when the receipt is saved, and NULL when none is. The
  session-only user bus binds a user and no organisation, because its
  commands belong to none. The command bus hands `TransactionManager.run`
  the context's organisation (`commandTransactionBinding` in
  `packages/domain/src/shared/command.ts`), so a tenant command's receipt
  records it. A transaction the manager runs without a binding records
  what a port bound before the receipt was saved, or NULL if none did: the
  Slack answer (`answerSlackQuestion`) saves one after `lockActionToken` has
  bound the organisation its token names. The worker's import apply is also
  handed no binding by its manager, so its ports bind each transaction
  (track-i2.md §21, R6 (a)), and it saves no receipt. The row
  policy that relies on this column is §3 step 8's (migration 0024): with
  an organisation bound, a transaction sees and writes only that
  organisation's receipts; with none bound, only receipts with no
  organisation. Row security is forced on the table, and the unique key
  below still spans every organisation.
*/
export const commandReceipts = pgTable(
  "command_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorFingerprint: text("actor_fingerprint").notNull(),
    commandName: text("command_name").notNull(),
    idempotencyFingerprint: text("idempotency_fingerprint").notNull(),
    normalizedInputHash: text("normalized_input_hash").notNull(),
    aggregateId: uuid("aggregate_id"),
    resultJson: jsonb("result_json").$type<unknown>().notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    /**
     * The organisation bound to the transaction that saved the receipt, or
     * NULL when none was bound. Nullable for good: the session-only user bus
     * runs commands that belong to no organisation (manifest-i2.md §2.1).
     */
    organizationId: uuid("organization_id"),
  },
  (table) => [
    uniqueIndex("command_receipts_actor_command_key_unique").on(
      table.actorFingerprint,
      table.commandName,
      table.idempotencyFingerprint,
    ),
    index("command_receipts_expires_at_idx").on(table.expiresAt),
    index("command_receipts_aggregate_id_idx").on(table.aggregateId),
  ],
);
