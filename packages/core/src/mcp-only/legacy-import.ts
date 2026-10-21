import { createImportRepository, type Storage } from "@requestport/db";
import { type CommandMeta, DomainError } from "@requestport/domain";
import { LEGACY_PARSER_VERSION } from "@requestport/importer";

import {
  type AgentContext,
  agentContextOf,
  type NetworkCapabilityCall,
  requireProject,
} from "../network-call.js";
import type { RequestPortSecrets } from "../options.js";

/*
  The legacy import tools for an agent (manifest-g.md §2.5, the MCP-only
  capabilities; MCP's `list_legacy_imports`, `get_legacy_import`,
  `analyze_legacy_import`, `apply_legacy_import` and
  `correct_legacy_import`). Moved from the MCP route's inline tools
  (`apps/web/src/app/mcp/route.ts`) in Plan 13, G.6: the analysis in the
  first round, the other four with ruling 137. MCP still decides whether the
  tools exist for a session (an `import:write` grant on no lanes); each tool
  here refuses anything but an agent's call, and the import repository checks
  the agent's import grant on its project, inside the tool's transaction,
  before anything else is read or written.

  The analysis and the apply each commit a dispatch, and start it after the
  commit through the caller's background, bound to the context's
  organisation (`dispatchImportTask`): a dispatch whose start fails stays
  committed for the repair sweep, as every committed dispatch does.
*/

type ImportRepository = ReturnType<typeof createImportRepository>;

/** The import repository, opened on the tool's transaction when asked. */
export interface LegacyImportRepositories {
  imports(): Pick<
    ImportRepository,
    | "requireAgentAccess"
    | "findCaptureForProject"
    | "createRun"
    | "listForProject"
    | "detail"
    | "queueApply"
    | "createCorrectionRun"
  >;
}

/** Opens one transaction, unbound, and runs `work` in it. */
export type LegacyImportTransaction = <T>(
  work: (repositories: LegacyImportRepositories) => Promise<T>,
) => Promise<T>;

/**
 * The import tools' transaction over a storage: one unbound transaction on
 * `storage`, with the import repository opened on it when a tool asks. The
 * handle goes only to `@requestport/db`'s factory.
 */
export function legacyImportTransaction(
  storage: Pick<Storage, "transaction">,
): LegacyImportTransaction {
  return <T>(work: (repositories: LegacyImportRepositories) => Promise<T>) =>
    storage.transaction((tx) =>
      work({ imports: () => createImportRepository(tx) }),
    );
}

export interface LegacyImportAnalysisOptions {
  transaction: LegacyImportTransaction;
  /** `commandFingerprintKey`, raw, keys each run's receipt; read per call. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
  /**
   * Starts a committed import dispatch of an organisation, after its
   * transaction: the caller's background (`BackgroundPort`'s
   * `dispatchImportTask`). Asked only by the analysis and the apply.
   */
  dispatchImportTask?: (
    dispatchId: string,
    organizationId: string,
  ) => Promise<unknown>;
}

/** The import grant the repository checks, read from an agent's context. */
function agentImportAuthorization(
  context: AgentContext,
): Parameters<ImportRepository["requireAgentAccess"]>[0] {
  return {
    organizationId: context.organizationId,
    // A getter, as the MCP route's object had it: reading the project is
    // what refuses a credential bound to none, with `requireProject`'s
    // words, and the repository reads it inside the transaction.
    get projectId() {
      return requireProject(context).projectId;
    },
    agentPrincipalId: context.actor.id,
    // An agent's credential is its authorization: the bearer path gives
    // both fields the authorization's id (`@requestport/auth`).
    authorizationId: context.credentialId,
    delegatedByUserId: context.actor.delegatedBy?.id ?? null,
  };
}

/** A call to a tool that reads or writes nothing of the command envelope. */
type AgentCall = Pick<NetworkCapabilityCall, "context" | "credentialKind">;

export function createLegacyImportAnalysis(
  options: LegacyImportAnalysisOptions,
) {
  /**
   * Queues the analysis of one captured snapshot, for an agent credential
   * holding an import grant on its project, and answers the committed run.
   *
   * Anything but an agent's call is refused before the transaction opens.
   * In the transaction: the repository checks the agent's import grant; the
   * snapshot must be one of the bound project's, or it is `not_found`; and
   * the run is created as the agent, under the parser version this
   * deployment runs, with its receipt keyed by the raw
   * `commandFingerprintKey`.
   */
  async function queueLegacyImportAnalysis(
    input: { sourceId: string; snapshotId: string },
    call: NetworkCapabilityCall,
  ) {
    const agent = agentContextOf(call);
    const authorization = agentImportAuthorization(agent);

    return options.transaction(async (repositories) => {
      const repository = repositories.imports();
      await repository.requireAgentAccess(authorization);
      const capture = await repository.findCaptureForProject({
        organizationId: agent.organizationId,
        projectId: requireProject(agent).projectId,
        sourceId: input.sourceId,
        snapshotId: input.snapshotId,
      });
      if (!capture)
        throw new DomainError("not_found", "Import snapshot was not found");
      return repository.createRun({
        organizationId: agent.organizationId,
        sourceId: input.sourceId,
        snapshotId: input.snapshotId,
        actorType: "agent",
        actorId: agent.actor.id,
        parserVersion: LEGACY_PARSER_VERSION,
        ...call.meta,
        fingerprintSecret: options.secrets.commandFingerprintKey,
      });
    });
  }

  /** The background a committed dispatch is started through, or a fault. */
  function dispatcher() {
    if (!options.dispatchImportTask) {
      throw new Error("no dispatchImportTask was given to start the import");
    }
    return options.dispatchImportTask;
  }

  /**
   * The analysis, as MCP's `analyze_legacy_import` runs it: queued as above,
   * then its committed dispatch started, bound to the context's
   * organisation. Answers the run's id and state.
   */
  async function analyze(
    input: { sourceId: string; snapshotId: string },
    call: NetworkCapabilityCall,
  ) {
    const dispatchImportTask = dispatcher();
    const context = agentContextOf(call);
    const run = await queueLegacyImportAnalysis(input, call);
    await dispatchImportTask(run.dispatchId, context.organizationId);
    return { runId: run.id, state: run.state };
  }

  /**
   * The bound project's import runs, as MCP's `list_legacy_imports` lists
   * them, after the repository has checked the agent's grant.
   */
  async function list(call: AgentCall) {
    const context = agentContextOf(call);
    const authorization = agentImportAuthorization(context);
    return {
      items: await options.transaction(async (repositories) => {
        const repository = repositories.imports();
        await repository.requireAgentAccess(authorization);
        return repository.listForProject(
          context.organizationId,
          requireProject(context).projectId,
        );
      }),
    };
  }

  /**
   * One import run of the bound project, as MCP's `get_legacy_import`
   * answers it: a run outside the project is `not_found`, and each entry's
   * artifact is answered without its content.
   */
  async function detail(runId: string, call: AgentCall) {
    const context = agentContextOf(call);
    const authorization = agentImportAuthorization(context);
    const found = await options.transaction(async (repositories) => {
      const repository = repositories.imports();
      await repository.requireAgentAccess(authorization);
      return repository.detail(context.organizationId, runId);
    });
    if (!found || found.source.projectId !== requireProject(context).projectId)
      throw new DomainError("not_found", "Import run was not found");
    return {
      run: found.run,
      source: found.source,
      snapshot: found.snapshot,
      entries: found.entries.map(({ entry, artifact }) => ({
        entry,
        artifact: {
          id: artifact.id,
          relativePath: artifact.relativePath,
          mediaType: artifact.mediaType,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
          secretScanStatus: artifact.secretScanStatus,
        },
      })),
      conflicts: found.conflicts,
      report: found.report,
    };
  }

  /**
   * Queues the apply of an analysed run, as MCP's `apply_legacy_import`
   * does: the run must be the bound project's, and its manifest hash the one
   * approved. The apply's task acts as the agent, on its grant. Its committed
   * dispatch is started after the transaction, bound to the context's
   * organisation.
   */
  async function apply(
    input: { runId: string; manifestSha256: string },
    call: NetworkCapabilityCall,
  ) {
    const dispatchImportTask = dispatcher();
    const context = agentContextOf(call);
    const authorization = agentImportAuthorization(context);
    const { runId, manifestSha256 } = input;
    const queued = await options.transaction(async (repositories) => {
      const repository = repositories.imports();
      await repository.requireAgentAccess(authorization);
      const found = await repository.detail(context.organizationId, runId);
      if (
        !found ||
        found.source.projectId !== requireProject(context).projectId
      )
        throw new DomainError("not_found", "Import run was not found");
      if (found.run.manifestSha256 !== manifestSha256)
        throw new DomainError(
          "validation_failed",
          "Approved import manifest hash does not match",
        );
      return repository.queueApply({
        organizationId: context.organizationId,
        runId,
        manifestSha256,
        actorType: "agent",
        actorId: context.actor.id,
        taskActor: {
          type: "agent",
          id: context.actor.id,
          authorizationId: context.credentialId,
          delegatedByUserId: context.actor.delegatedBy?.id ?? null,
          projectId: requireProject(context).projectId,
        },
        ...call.meta,
        fingerprintSecret: options.secrets.commandFingerprintKey,
      });
    });
    await dispatchImportTask(queued.dispatchId, context.organizationId);
    return { runId, state: "queued" };
  }

  /**
   * Opens a correction run of an import run of the bound project, as MCP's
   * `correct_legacy_import` does, as the agent, under the context's
   * correlation id.
   */
  async function correct(
    runId: string,
    call: AgentCall & { meta: CommandMeta },
  ) {
    const context = agentContextOf(call);
    const authorization = agentImportAuthorization(context);
    const correction = await options.transaction(async (repositories) => {
      const repository = repositories.imports();
      await repository.requireAgentAccess(authorization);
      const found = await repository.detail(context.organizationId, runId);
      if (
        !found ||
        found.source.projectId !== requireProject(context).projectId
      )
        throw new DomainError("not_found", "Import run was not found");
      return repository.createCorrectionRun({
        organizationId: context.organizationId,
        originalRunId: runId,
        actorType: "agent",
        actorId: context.actor.id,
        correlationId: context.correlationId,
        ...call.meta,
        fingerprintSecret: options.secrets.commandFingerprintKey,
      });
    });
    return { runId: correction.id, state: correction.state };
  }

  return { queueLegacyImportAnalysis, analyze, list, detail, apply, correct };
}

export type LegacyImports = ReturnType<typeof createLegacyImportAnalysis>;
