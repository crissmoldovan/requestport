import type {
  ClaimedImportTaskDispatch,
  ClaimLease,
  createImportTaskDispatchRepository,
} from "@requestport/db";

import type { JobHandlers } from "../catalogue.js";
import { timedOut, within } from "./within.js";

export type ImportDispatchPollerEvent =
  | {
      type: "import.dispatch_failed";
      dispatchId: string;
      attempt: number;
      errorMessage: string;
    }
  | {
      type: "import.dispatch_timed_out";
      dispatchId: string;
      timeoutMs: number;
    };

export type ImportDispatchPollerOptions = {
  repository: Pick<
    ReturnType<typeof createImportTaskDispatchRepository>,
    "claimBatch"
  >;
  handlers: Pick<JobHandlers, "legacy-import-analyze" | "legacy-import-apply">;
  batchSize: number;
  /** The lease each claim asks for; function 4 clamps it to 60-1 800 s. */
  leaseMs: number;
  jobTimeoutMs: number;
  onEvent?: (event: ImportDispatchPollerEvent) => void;
};

export type ImportDrainReport = {
  claimed: number;
  ran: number;
  failed: number;
  timedOut: number;
};

/**
 * Runs queued import analyses and applications without Trigger.dev: claims
 * through function 4 on the dispatcher's storage, which leases each dispatch
 * under a lease id the database generates, and hands the body that lease to
 * settle under (manifest-i2.md §5.1 "Settlement").
 *
 * Unlike the outbox, the dispatch repository has no retry or dead-letter
 * call, and this adds none. It does not need one: function 4 claims a
 * dispatch again once its lease has run out, and dead-letters it once its
 * attempts are spent. So a failure here is recorded and left leased, and the
 * lease is what spaces the attempts. The body reads its standing first and
 * does nothing for a lease that no longer holds or an attempt that is no
 * longer current.
 */
export function createImportDispatchPoller(
  options: ImportDispatchPollerOptions,
) {
  const emit = options.onEvent ?? (() => undefined);
  const leaseSeconds = Math.ceil(options.leaseMs / 1_000);

  async function settle(
    dispatch: Omit<ClaimedImportTaskDispatch, "taskPayload"> & ClaimLease,
    report: ImportDrainReport,
  ) {
    const handler =
      dispatch.taskKind === "analyze"
        ? options.handlers["legacy-import-analyze"]
        : options.handlers["legacy-import-apply"];
    try {
      const outcome = await within(
        handler(
          {
            dispatchId: dispatch.id,
            attemptCount: dispatch.attemptCount,
          },
          { kind: "lease", leaseId: dispatch.leaseId },
        ),
        options.jobTimeoutMs,
      );
      if (outcome === timedOut) {
        report.timedOut += 1;
        emit({
          type: "import.dispatch_timed_out",
          dispatchId: dispatch.id,
          timeoutMs: options.jobTimeoutMs,
        });
        return;
      }
      report.ran += 1;
    } catch (error) {
      report.failed += 1;
      emit({
        type: "import.dispatch_failed",
        dispatchId: dispatch.id,
        attempt: dispatch.attemptCount,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    async drainOnce(): Promise<ImportDrainReport> {
      const claimed = await options.repository.claimBatch(
        options.batchSize,
        leaseSeconds,
      );
      const report: ImportDrainReport = {
        claimed: claimed.length,
        ran: 0,
        failed: 0,
        timedOut: 0,
      };
      await Promise.all(claimed.map((dispatch) => settle(dispatch, report)));
      return report;
    },
  };
}
