import { randomUUID } from "node:crypto";

import {
  type CommandPortFactory,
  createCommandTransactionManager,
  createRequestRepository,
  createWorkRepository,
  createWorkSweepRepository,
} from "@requestport/db";
import {
  AtomicCommandBus,
  createCoreCommandRegistry,
  DomainError,
  type TransactionManager,
} from "@requestport/domain";

import { observeTaskResult, triggerMetrics } from "../observability.js";
import { inUnit, workerSettings, workerStorages } from "../worker-storages.js";
import {
  type WorkSessionSweepCommand,
  workSessionSweepInput,
} from "./stale-session-input.js";

const sweepPorts: CommandPortFactory = (name, database) => {
  if (name === "requests") return createRequestRepository(database);
  if (name === "work") return createWorkRepository(database);
  return undefined;
};

/**
 * The bus's transactions as processing units (track-i2.md, "I.2b design"
 * §3): each command's transaction runs inside a unit bound to the
 * organisation the bus binds it to, a savepoint there. On one of
 * `createWorkerStorages`' two exceptions, the unit is the handle of the
 * storage its caller gave (`inUnit`, `worker-storages.ts`), and this is the
 * command transaction on it, as before b2. The sweep's commands always
 * carry an organisation.
 */
const processorTransactions: TransactionManager = {
  run(work, binding) {
    const organizationId = binding?.organizationId;
    if (organizationId === undefined) {
      return Promise.reject(
        new Error("A work-session sweep command runs bound to an organisation"),
      );
    }
    return inUnit(organizationId, (database) =>
      createCommandTransactionManager(database, sweepPorts).run(work, binding),
    );
  },
};

/**
 * The bus, built the first time a sweep needs one.
 *
 * Its fingerprint secret is derived from this application's authentication
 * secret, and is read from the worker settings (`worker-storages.ts`) here,
 * not at module scope: reading it there meant importing this file required
 * holding the secret. A deploy imports every module to discover the tasks in
 * it, and has no business holding that secret — so the deploy refused, which
 * is the right answer to the wrong question. The bus keeps the key it was
 * built with.
 */
let bus: AtomicCommandBus | undefined;

function commandBus(): AtomicCommandBus {
  bus ??= new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: processorTransactions,
    fingerprintSecret: workerSettings().secrets.workSweepFingerprintSecret,
    metrics: triggerMetrics,
  });

  return bus;
}

async function sweep(
  command: WorkSessionSweepCommand,
  rows: Array<{ id: string; organizationId: string; version: number }>,
) {
  let changed = 0;
  for (const row of rows) {
    try {
      await commandBus().execute({
        name: command,
        input: workSessionSweepInput(command, row),
        context: {
          actor: { type: "service", id: "trigger:work-session-sweep" },
          organizationId: row.organizationId,
          scopes: new Set(["work:sweep"]),
          credentialId: "trigger:work-session-sweep",
          correlationId: randomUUID(),
        },
        meta: {
          expectedVersion: row.version,
          idempotencyKey: `${command}:${row.id}:${row.version}`,
        },
      });
      changed += 1;
    } catch (error) {
      if (
        !(
          error instanceof DomainError &&
          ["invalid_transition", "version_conflict", "not_found"].includes(
            error.code,
          )
        )
      )
        throw error;
    }
  }
  return changed;
}

export const sweepStaleWorkSessions = () =>
  observeTaskResult("stale-work-sessions", async () => {
    // Functions 10 and 11, on the dispatcher's storage; each command then
    // runs in a unit bound to its session's organisation.
    const sessions = createWorkSweepRepository(workerStorages().dispatcher);
    const expired = await sessions.listLeaseExpired();
    const stale = await sweep("mark_work_session_stale", expired);
    const graceExpired = await sessions.listGraceExpired();
    const abandoned = await sweep("abandon_work_session", graceExpired);
    triggerMetrics.gauge("work_session.stale_total", stale, {
      status: "stale",
      taskId: "stale-work-sessions",
    });
    return {
      considered: expired.length + graceExpired.length,
      stale,
      abandoned,
    };
  });
