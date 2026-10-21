import { randomUUID } from "node:crypto";

import { createLogger } from "@requestport/config/logger";
import { createOutboxRepository } from "@requestport/db";
import { inUnit } from "@requestport/jobs";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";

import type { outboxDelivery } from "./outbox-delivery.js";

const logger = createLogger({
  service: "trigger-dispatcher",
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
});

/**
 * Claims one committed outbox row of `organizationId` and starts its
 * `outbox-delivery` run: reached from `legacy-import-apply`, between its
 * units, through the Trigger job runner's `dispatchOutbox`. The claim and the
 * acceptance are each a processing unit bound to that organisation, as the
 * tenant processor (manifest-i2.md §5.1; track-i2.md, "I.2b design" §3), with
 * the run started between them. The acceptance records the id `trigger()`
 * returned, which is the run's `ctx.run.id` and what it settles under.
 */
export async function dispatchCommittedOutbox(
  outboxId: string,
  organizationId: string,
) {
  const owner = `web:${randomUUID()}`;
  const claimed = await inUnit(organizationId, (database) =>
    createOutboxRepository(database).claimOne(outboxId, owner),
  );
  if (!claimed) return { accepted: false as const };
  try {
    const handle = await tasks.trigger<typeof outboxDelivery>(
      "outbox-delivery",
      { outboxId },
      {
        idempotencyKey: await idempotencyKeys.create(
          `outbox:${outboxId}:${claimed.attemptCount}`,
          { scope: "global" },
        ),
        idempotencyKeyTTL: "30d",
      },
    );
    const accepted = await inUnit(organizationId, (database) =>
      createOutboxRepository(database).markAccepted(outboxId, owner, handle.id),
    );
    if (!accepted) {
      // The lease ran out before the acceptance: the run cannot settle this
      // row, and the row is claimed again when due.
      logger.warn("outbox.acceptance_refused", {
        outboxId,
        runId: handle.id,
        status: "lease_expired",
      });
      return { accepted: false as const };
    }
    logger.info("outbox.accepted", {
      outboxId,
      runId: handle.id,
      status: "accepted",
    });
    return { accepted: true as const, runId: handle.id };
  } catch {
    logger.warn("outbox.dispatch_failed", {
      outboxId,
      status: "failed",
      errorCode: "trigger_dispatch_failed",
    });
    return { accepted: false as const };
  }
}
