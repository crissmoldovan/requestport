import path from "node:path";

import {
  type ClaimSettlement,
  createImportRepository,
  createImportTaskDispatchRepository,
} from "@requestport/db";
import {
  analyzeLegacyRecord,
  parseLegacyArtifact,
} from "@requestport/importer";
import { z } from "zod";

import {
  observeTaskResult,
  triggerMetrics,
  workerLogger,
} from "../observability.js";
import { SettlementPendingError, superseded } from "../settlement.js";
import { inUnit, workerStorages } from "../worker-storages.js";

const logger = workerLogger("trigger-import-analyze");

/**
 * Analyses one import run's artefacts. The payload is parsed strictly here
 * rather than trusted from the caller's type, as it always was: it arrives
 * from a queue.
 *
 * It settles the dispatch under `settlement`, the claim that started it
 * (manifest-i2.md §5.1), read before any effect. Its steps (track-i2.md,
 * "I.2b design" §3): the dispatch's organisation from the resolver, a miss
 * being `suppressed`; a unit that reads the standing and loads the dispatch,
 * and completes it there when its run is no longer analysing; a unit that
 * lists the artefacts; the parse between units; a unit that looks up the
 * mappings and saves the analysis; a unit that completes the dispatch.
 */
export const runImportAnalyze = (
  unknownPayload: unknown,
  settlement: ClaimSettlement,
) =>
  observeTaskResult("legacy-import-analyze", async () => {
    const { dispatchId, attemptCount } = z
      .object({
        dispatchId: z.uuid(),
        attemptCount: z.number().int().positive(),
      })
      .strict()
      .parse(unknownPayload);
    const organizationId = await workerStorages().resolveJobOrganization(
      "import_task_dispatch",
      dispatchId,
    );
    if (organizationId === null) return { status: "suppressed" as const };
    const complete = () =>
      inUnit(organizationId, (database) =>
        createImportTaskDispatchRepository(database).markCompleted(
          dispatchId,
          attemptCount,
          settlement,
        ),
      );
    const refused = () => {
      logger.warn("import.settlement_refused", {
        dispatchId,
        status: "superseded",
        taskKind: "analyze",
      });
      return superseded();
    };

    const opened = await inUnit(organizationId, async (database) => {
      const dispatches = createImportTaskDispatchRepository(database);
      const standing = await dispatches.claimStanding(
        dispatchId,
        attemptCount,
        settlement,
      );
      if (standing !== "held") return { kind: "standing" as const, standing };
      const loaded = await dispatches.load(dispatchId);
      if (!loaded) return { kind: "suppressed" as const };
      if (
        loaded.dispatch.attemptCount !== attemptCount ||
        !["leased", "accepted"].includes(loaded.dispatch.state)
      ) {
        return { kind: "standing" as const, standing: "superseded" as const };
      }
      const payload = z
        .object({ kind: z.literal("analyze"), runId: z.uuid() })
        .strict()
        .parse(loaded.dispatch.taskPayload);
      if (
        loaded.dispatch.taskKind !== "analyze" ||
        loaded.dispatch.importRunId !== payload.runId
      ) {
        throw new Error("Import analysis dispatch binding is invalid");
      }
      if (loaded.runState !== "analyzing") {
        const settled = await dispatches.markCompleted(
          dispatchId,
          attemptCount,
          settlement,
        );
        return { kind: "finished" as const, settled };
      }
      return { kind: "held" as const, runId: payload.runId };
    });
    if (opened.kind === "standing") {
      if (opened.standing === "pending_acceptance") {
        throw new SettlementPendingError();
      }
      return superseded();
    }
    if (opened.kind === "suppressed") return { status: "suppressed" as const };
    if (opened.kind === "finished") {
      return opened.settled ? { status: "suppressed" as const } : refused();
    }
    const { runId } = opened;
    const rows = await inUnit(organizationId, (database) =>
      createImportRepository(database).listAnalyzableArtifacts(runId),
    );
    const parsed = rows.flatMap(({ artifact }) => {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        artifact.exactBytes,
      );
      return parseLegacyArtifact(text).map((record) => ({
        artifact,
        record,
      }));
    });
    const basenameCounts = new Map<string, number>();
    const keyCounts = new Map<string, number>();
    for (const item of parsed) {
      const basename = path.posix
        .basename(item.artifact.relativePath)
        .toLowerCase();
      basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
      const key = item.record.legacyKey?.normalizedKey;
      if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    const entries = await inUnit(organizationId, async (database) => {
      const imports = createImportRepository(database);
      const analysed = [];
      for (const item of parsed) {
        const existing = await imports.findMapping(
          item.artifact.id,
          item.record.recordIndex,
        );
        const analysis = analyzeLegacyRecord({
          record: item.record,
          relativePath: item.artifact.relativePath,
          sameBasenameCount: basenameCounts.get(
            path.posix.basename(item.artifact.relativePath).toLowerCase(),
          ),
          sameKeyCount: item.record.legacyKey
            ? keyCounts.get(item.record.legacyKey.normalizedKey)
            : 0,
          alreadyMapped: Boolean(existing),
        });
        analysed.push({
          sourceArtifactId: item.artifact.id,
          recordIndex: item.record.recordIndex,
          ...analysis,
        });
      }
      await imports.saveAnalysis({ runId, entries: analysed });
      return analysed;
    });
    if (!(await complete())) return refused();
    const blockingConflicts = entries
      .flatMap((entry) => entry.conflicts)
      .filter((conflict) => conflict.severity === "blocking").length;
    triggerMetrics.gauge("import.conflict_total", blockingConflicts, {
      status: "blocking",
      taskId: "legacy-import-analyze",
    });
    return {
      status: "completed" as const,
      runId,
      artifacts: rows.length,
      entries: entries.length,
      blockingConflicts,
    };
  });
