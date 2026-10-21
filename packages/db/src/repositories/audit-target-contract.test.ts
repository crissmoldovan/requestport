import {
  type AuditRecordInput,
  auditActions,
  auditActionTargets,
  auditTargetTypes,
  DomainError,
} from "@requestport/domain";
import { describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import type { Tx } from "../transaction.js";
import { createAppearanceRepository } from "./appearance-repository.js";
import { createFoundationRepository } from "./foundation-repository.js";

/**
 * The sentinel a stub insert raises. `mapFoundationDatabaseError` passes a
 * `DomainError` through untouched, so one sentinel works for both repositories
 * and reaching it proves the guard let the write past.
 */
const insertReached = new DomainError("conflict", "AUDIT INSERT REACHED");

/**
 * A database that never reaches PostgreSQL. Every append that survives the
 * shared guard ends at the sentinel, so this suite is a pure contract check on
 * the two `appendAuditRecord` implementations rather than a live test.
 */
function stubDatabase() {
  return {
    insert: () => ({
      values: () => Promise.reject(insertReached),
    }),
  } as unknown as Database;
}

function appendFromFoundation(input: AuditRecordInput) {
  return createFoundationRepository(stubDatabase(), (run) =>
    run(stubDatabase() as unknown as Tx),
  ).transaction((tx) => tx.appendAuditRecord(input));
}

function appendFromAppearance(input: AuditRecordInput) {
  return createAppearanceRepository(stubDatabase()).appendAuditRecord(input);
}

const appenders = [
  { name: "foundation", append: appendFromFoundation },
  { name: "appearance", append: appendFromAppearance },
] as const;

function auditInput(
  overrides: Partial<AuditRecordInput> &
    Pick<AuditRecordInput, "action" | "targetType">,
): AuditRecordInput {
  return {
    organizationId: null,
    actor: { type: "user", userId: "user_1" },
    targetId: "target_1",
    reason: "Fixed reason",
    fieldNames: [],
    correlationId: "correlation_1",
    ...overrides,
  };
}

describe.each(appenders)("$name audit append", ({ append }) => {
  test("accepts every action filed under its own target", async () => {
    for (const action of auditActions) {
      await expect(
        append(auditInput({ action, targetType: auditActionTargets[action] })),
      ).rejects.toBe(insertReached);
    }
  });

  test("rejects every action filed under another action's target", async () => {
    for (const action of auditActions) {
      for (const targetType of auditTargetTypes) {
        if (targetType === auditActionTargets[action]) continue;
        // Both writers share one guard, so neither can be the one that files an
        // appearance action under `organization` and leaves an append-only row
        // nobody can query by target.
        await expect(
          append(auditInput({ action, targetType })),
        ).rejects.toMatchObject({ code: "validation_failed" });
      }
    }
  });

  test("refuses an unauthenticated actor", async () => {
    await expect(
      append(
        auditInput({
          action: "project.created",
          targetType: "project",
          actor: { type: "unauthenticated" },
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
