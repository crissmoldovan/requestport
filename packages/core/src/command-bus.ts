import { randomUUID } from "node:crypto";

import {
  type CommandPortFactory,
  createAgentRepository,
  createAppearanceRepository,
  createCollaborationRepository,
  createCommandAuthorizationRepository,
  createCommandTransactionManager,
  createFoundationRepository,
  createImportReviewCommandRepository,
  createOperationsCommandRepository,
  createOperatorCredentialRepository,
  createOrganizationManagementRepository,
  createProjectSettingsCommandRepository,
  createRequestRepository,
  createRetentionHoldCommandRepository,
  createRoutingRepository,
  createSlackAdministrationCommandRepository,
  createWorkRepository,
  createWorkspaceRepository,
  type Database,
} from "@requestport/db";
import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  type DomainEvent,
  type EnvelopeEncryption,
  importReviewPortName,
  type MetricSink,
  operationsPortName,
  organizationFoundationPortName,
  organizationManagementPortName,
  projectSettingsPortName,
  retentionHoldPortName,
  slackAdministrationPortName,
  type TransactionManager,
} from "@requestport/domain";

import type { PersonSession, RequestPortSecrets } from "./options.js";

/*
 * The tenant command bus, composed in core (manifest-g.md §2.5's
 * `command-bus` row): its registry, its unit-of-work ports, its context
 * re-check and its fingerprint key, and what a signed-in person carries
 * into it. No bus, port table or transaction manager is built as the module
 * loads: each is built by the function that returns it. `humanScopes`, a
 * constant set of scope names, is the one value built at load.
 */

type CommandPort = (database: Parameters<CommandPortFactory>[1]) => unknown;

/**
 * The repository each unit-of-work port name opens, on the transaction the
 * command runs in. Any other name opens nothing, and the unit of work refuses
 * it. One line per port: an R4 append point (Plan 13, ruling 8), where two
 * appends keep both lines and are never sorted. The web holds no table of
 * its own: its bus is the one its RequestPort composes over this one
 * (`apps/web/src/lib/server-web-request-port.ts`), and `command-bus.test.ts`
 * fails if a port line reappears in `apps/web/src/lib/server-core-commands.ts`.
 */
export function createCommandPorts(
  secrets: Pick<RequestPortSecrets, "operatorCredentials">,
): ReadonlyMap<string, CommandPort> {
  return new Map<string, CommandPort>([
    ["agents", createAgentRepository],
    ["appearance", createAppearanceRepository],
    // Operator contexts pass only while the switch is `enabled` (Plan 13,
    // F.3, F3-14); absent or `disabled` refuses them. Read as the port opens.
    [
      "commandAuthorization",
      (database) =>
        createCommandAuthorizationRepository(database, {
          operatorCredentials: secrets.operatorCredentials,
        }),
    ],
    ["requests", createRequestRepository],
    ["routing", createRoutingRepository],
    ["workspaces", createWorkspaceRepository],
    ["work", createWorkRepository],
    ["collaboration", createCollaborationRepository],
    [projectSettingsPortName, createProjectSettingsCommandRepository],
    ["operatorCredentials", createOperatorCredentialRepository],
    [operationsPortName, createOperationsCommandRepository],
    [retentionHoldPortName, createRetentionHoldCommandRepository],
    [slackAdministrationPortName, createSlackAdministrationCommandRepository],
    [importReviewPortName, createImportReviewCommandRepository],
    [organizationManagementPortName, createOrganizationManagementRepository],
    [organizationFoundationPortName, createFoundationRepository],
  ]);
}

/**
 * The bus's transaction manager: each command's unit of work runs in a
 * transaction on `database`, opening its ports from `ports`.
 */
export function commandTransactions(
  database: Database,
  ports: ReadonlyMap<string, CommandPort>,
): TransactionManager {
  return createCommandTransactionManager(database, (name, transaction) =>
    ports.get(name)?.(transaction),
  );
}

export interface CoreCommandBusOptions {
  transactions: TransactionManager;
  /** `commandFingerprintSecret(secrets.commandFingerprintKey)`. */
  fingerprintSecret: string;
  /** The registry's workspace encryption, when a key ring was given. */
  workspaceEncryption?: EnvelopeEncryption;
  metrics?: MetricSink;
  /** Hands the events each command committed on, after its transaction. */
  afterCommit?: (events: readonly DomainEvent[]) => Promise<void>;
}

/**
 * The tenant command bus over the core command registry. Before each command
 * it re-checks the context on the command's own transaction, through the
 * `commandAuthorization` port (`assertCurrent`).
 */
export function createCoreCommandBus(options: CoreCommandBusOptions) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry({
      workspaceEncryption: options.workspaceEncryption,
    }),
    transactions: options.transactions,
    fingerprintSecret: options.fingerprintSecret,
    metrics: options.metrics,
    authorizeContext: (context, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
    afterCommit: options.afterCommit,
  });
}

/**
 * What a signed-in person carries into a command.
 *
 * Exported so a delegated MCP session can act as the human it names with the
 * same standing that human would have in the UI, rather than a hand-copied
 * subset that drifts from this one.
 *
 * Written out rather than derived from the capability registry: it also holds
 * scopes no registry entry requires yet (the UI's own commands), and what a
 * person may do is a decision, not a consequence of adding an entry.
 * `command-bus.test.ts` fails when an entry requires a scope missing here.
 * One line per scope: an R4 append point (Plan 13, ruling 8), where two
 * appends keep both lines and are never sorted.
 */
export const humanScopes = new Set([
  "org:read",
  "project:read",
  "project:manage",
  "request:create",
  "request:read",
  "request:write",
  "request:triage",
  "request:complete",
  "request:verify",
  "routing:manage",
  "work:claim",
  "work:update",
  "question:answer",
  "agent:manage",
  "agent:register",
  "workspace:telemetry:reveal",
  "webhook:manage",
  "import:write",
  "operator:manage",
  // Plan 13, F.2.0's scope commit: one scope each for the groups whose
  // capabilities check none today — operations (F.2.4), Slack administration
  // (F.2.5) and organisation membership (F.2.7). A person holds them all;
  // no agent key or grant can (`agentScopes` names none of them), and an
  // operator only once its group's registry entries admit it.
  "operations:manage",
  "slack:manage",
  "members:manage",
]);

/**
 * A signed-in person's command context in `organizationId`: a `user` actor,
 * the human scopes, and the session's id as the credential, which the bus's
 * `assertCurrent` requires to be a live session.
 */
export function personCommandContext(
  person: PersonSession,
  organizationId: string,
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: humanScopes,
    credentialId: person.id,
    correlationId: randomUUID(),
  };
}
