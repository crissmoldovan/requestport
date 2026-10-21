import { randomUUID } from "node:crypto";

import {
  boundImportTaskDispatchRepository,
  boundOutboxRepository,
  createAgentAuthRepository,
  createAgentQueryRepository,
  createAgentRepository,
  createCommandAuthorizationRepository,
  createFoundationRepository,
  createProjectRegistrationRepository,
  createWebhookRepository,
  type Storage,
} from "@requestport/db";
import type { MigrationReport } from "@requestport/db/migrate";
import {
  BOOTSTRAP_OWNER_ACTOR,
  type BootstrapOwnerInput,
  type BootstrapOwnerResult,
  type Capability,
  capabilityRegistry,
  DomainError,
  bootstrapOwner as domainBootstrapOwner,
  type EnvelopeEncryption,
} from "@requestport/domain";

import {
  type AgentAdministration,
  agentAdministrationTransaction,
  createAgentAdministration,
} from "./agent-administration.js";
import {
  type BackgroundPort,
  createBackgroundPort,
  type PostgresBackground,
  postgresWorkerSettings,
  startPostgresBackground,
} from "./background.js";
import {
  commandTransactions,
  createCommandPorts,
  createCoreCommandBus,
} from "./command-bus.js";
import { type CommandExecution, createCommandExecution } from "./execute.js";
import { createImportSplit, importSplitTransaction } from "./import-split.js";
import {
  createLegacyImportAnalysis,
  legacyImportTransaction,
} from "./mcp-only/legacy-import.js";
import {
  type CreateProjectAsDelegateInput,
  createProjectProvisioning,
  type ProvisionAgentAsDelegateInput,
  projectProvisioningTransaction,
} from "./mcp-only/project-provisioning.js";
import {
  createWebhookManagement,
  createWebhookReplay,
  type WebhookManagementService,
} from "./mcp-only/webhooks.js";
import type {
  LocalCredentialSignIn,
  PersonSession,
  RequestPortLogger,
  RequestPortOptions,
} from "./options.js";
import { type CapabilityCall, createSignIn } from "./person.js";
import { createProjectRegistration } from "./project-registration.js";
import {
  type AgentQueries,
  createAgentQueries,
  createQueryExecution,
  type QueryCall,
  type QueryExecution,
  type QueryParameters,
} from "./query.js";
import {
  commandFingerprintSecret,
  createWorkspaceEncryption,
} from "./secrets.js";
import {
  createSlackConnectionTest,
  slackConnectionTestTransaction,
} from "./slack-connection-test.js";

/**
 * The MCP-only capabilities (manifest-g.md §2.5, §2.6): the tools MCP serves
 * that are not registry entries, so carry no `credentialKinds`. MCP admits
 * them by its own tool registration and scope; each here keeps the checks
 * its tool made, moved with it.
 */
export interface McpOnlyCapabilities {
  /**
   * `create_project`, as the person a provisioning grant delegates to, who
   * must be present: the credential that person acts on, the grant or a live
   * session, is re-checked in the transaction the project is created in,
   * before the role is checked (ruling 230 item 2).
   */
  createProject(
    input: CreateProjectAsDelegateInput,
  ): ReturnType<ReturnType<typeof createProjectProvisioning>["createProject"]>;
  /**
   * `provision_agent`, as that person, minting the agent's key through
   * `betterAuth.createAgentApiKey`; without it, refused before either write.
   */
  provisionAgent(
    input: ProvisionAgentAsDelegateInput,
  ): ReturnType<ReturnType<typeof createProjectProvisioning>["provisionAgent"]>;
  /**
   * The webhook management service, and `replay_webhook_delivery` beside
   * it; `null` without `secrets.webhookKeys`. The web's webhooks page runs
   * the service's five methods for the signed-in person too. Composed when
   * first read, and kept (ruling 140): the key ring's encryption is built
   * then, so a malformed webhook key makes each read of this throw a
   * `configuration_error`, and leaves every other capability composed.
   */
  readonly webhooks:
    | (WebhookManagementService &
        Pick<ReturnType<typeof createWebhookReplay>, "replay">)
    | null;
  /** The five legacy import tools, for an agent. */
  readonly imports: Pick<
    ReturnType<typeof createLegacyImportAnalysis>,
    "analyze" | "list" | "detail" | "apply" | "correct"
  >;
}

/**
 * The handlers off the command bus, as composed over `storage` and
 * `secrets`: the targets `execute` hands the two agent revocations, the
 * import split and the Slack connection test to, and what the web's forms
 * run for the signed-in person (`apps/web/src/lib`'s `server-agent-actions.ts`,
 * `server-import-actions.ts` and `server-slack-actions.ts`). Each takes its
 * caller's context as it is given, admits it by its own checks, and
 * re-checks it in its own transaction (`assertCurrent`) before it reads or
 * writes. Unlike `execute`, nothing here applies the registry's
 * `admitsCredentialKind` or the in-process rule.
 */
export interface OffBusHandlers {
  readonly revokeAgentCredential: AgentAdministration["revokeAgentCredential"];
  readonly revokeAgentOauthGrant: AgentAdministration["revokeAgentOauthGrant"];
  readonly splitImportEntry: ReturnType<
    typeof createImportSplit
  >["splitImportEntry"];
  readonly queueSlackConnectionTest: ReturnType<
    typeof createSlackConnectionTest
  >["queueSlackConnectionTest"];
}

export interface RequestPort {
  /**
   * F.1's capability registry, read-only: the array REST and MCP read,
   * frozen in place the first time it is read here.
   */
  readonly capabilities: readonly Capability[];
  /** Applies every pending migration, on `ownerStorage`; refuses without it. */
  migrate(): Promise<MigrationReport>;
  /**
   * Registers an organisation and its owner, as the operator CLI's
   * `bootstrap-owner` does, on `ownerStorage`; refuses without it.
   */
  bootstrapOwner(input: BootstrapOwnerInput): Promise<BootstrapOwnerResult>;
  /**
   * Signs a person in with D's local credential, through
   * `betterAuth.signInWithLocalCredential`, and answers the session Better
   * Auth wrote (ruling 63). Refuses without it.
   */
  signIn(input: LocalCredentialSignIn): Promise<PersonSession>;
  /**
   * Runs one command over `storage` (`createCommandExecution`). For a
   * network credential's call, the registry command REST knows as `name`,
   * as the REST route does: its admission, its project requirement and its
   * dispatch target, with the fields the registry injects from the
   * credential already written into the input. For a person's call, in
   * process, a command the in-process rule admits (`inProcessPersonCommands`),
   * as the person `signIn` answered.
   */
  execute(
    name: string,
    input: Record<string, unknown>,
    call: CapabilityCall,
  ): Promise<unknown>;
  /**
   * Runs one registry query over `storage` (`createQueryExecution`), for a
   * network credential's call, as the REST route's GET handler does: the
   * entry by its registry name, its admission and its dispatch target, an
   * administration read or one of the agent queries. The REST route finds
   * the name its path names with `resolveRestQuery`.
   */
  query(
    name: string,
    parameters: QueryParameters,
    call: QueryCall,
  ): Promise<unknown>;
  /**
   * The nine agent queries, as composed over `storage`: what `query`
   * dispatches an agent's call to, and what MCP's query tools run, MCP
   * admitting them by its own tool registration and scope (ruling 137).
   * Each refuses a context bound to no project, and then one lacking the
   * scope the registry gives the query it serves, as `query` refuses an
   * agent's call, before it reads (ruling 230). The scopes checked are the
   * ones the context states.
   */
  readonly agentQueries: AgentQueries;
  /** The MCP-only capabilities, as composed over `storage` and `secrets`. */
  readonly mcpOnly: McpOnlyCapabilities;
  /** The handlers off the command bus, as composed (`OffBusHandlers`). */
  readonly handlers: OffBusHandlers;
  /**
   * The tenant command bus, as composed over `storage` and `secrets`: the
   * target `execute` hands a `command-bus` entry to, and the bus MCP's
   * registry tools and the web's server actions run on (ruling 137). Its
   * `execute` re-checks the context on each command's own transaction.
   */
  readonly commandBus: ReturnType<typeof createCoreCommandBus>;
  /**
   * The background port in use: `backgroundPort` where one was given, or
   * the one composed over `storage` and `background`. The bus dispatches its
   * committed events through it, and the off-bus and MCP-only capabilities
   * start their work through it.
   */
  readonly background: BackgroundPort;
  /**
   * Composes RequestPort now, rather than on its first capability, and so
   * starts a `postgres` background's worker at once (ruling 158, item 5):
   * resolves when the worker is ready (`PostgresBackground.ready`: started,
   * and its first outbox tick has reached the database), and rejects if the
   * worker could not start, or if RequestPort cannot be composed. Without a
   * `postgres` background it resolves once composed, and starts nothing.
   * Asked again, it composes nothing more and answers the same worker's
   * readiness. Reading a composed member, or running a capability, still
   * starts the worker as before; `start()` is for a caller that needs to
   * know when it is ready, as `requestport start` does.
   */
  start(): Promise<void>;
  /**
   * Ends what core started: a `postgres` background's worker, if `start()`,
   * a capability or a composed member composed RequestPort and so started it,
   * which is stopped and waited for (`PostgresBackground.stop`). The worker writes whether it
   * drained to the logger (`worker.stopped`); one that did not leaves its
   * worker storages and settings installed for the work still running. It
   * never closes `storage`, `ownerStorage` or the worker storages: those are
   * the caller's.
   */
  close(): Promise<void>;
}

/** What `createRequestPort` composes over its options, on first use. */
export interface RequestPortComposition {
  commandBus: ReturnType<typeof createCoreCommandBus>;
  background: BackgroundPort;
  workspaceEncryption: EnvelopeEncryption | undefined;
  fingerprintSecret: string;
  execute: CommandExecution;
  query: QueryExecution;
  agentQueries: AgentQueries;
  mcpOnly: McpOnlyCapabilities;
  handlers: OffBusHandlers;
  /**
   * A `postgres` background, started with the composition: its worker runs
   * once its modules have loaded (`PostgresBackground.ready`).
   */
  worker: PostgresBackground | undefined;
}

const silentLogger: RequestPortLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const compositions = new WeakMap<RequestPort, () => RequestPortComposition>();

function compose(options: RequestPortOptions): RequestPortComposition {
  const { storage, secrets } = options;
  const { db } = storage;
  if (options.backgroundPort && options.background) {
    throw new DomainError(
      "configuration_error",
      "A RequestPort takes a background or a background port, not both",
    );
  }
  const chosen = options.background ?? { kind: "none" };
  const logger = options.logger ?? silentLogger;
  const background =
    options.backgroundPort ??
    createBackgroundPort({
      background: chosen,
      committedRows: {
        outbox: (organizationId) => boundOutboxRepository(organizationId, db),
        importTaskDispatches: (organizationId) =>
          boundImportTaskDispatchRepository(organizationId, db),
      },
      logger,
    });
  const workspaceEncryption = createWorkspaceEncryption(secrets.workspaceKeys);
  const fingerprintSecret = commandFingerprintSecret(
    secrets.commandFingerprintKey,
  );
  const commandBus = createCoreCommandBus({
    transactions: commandTransactions(db, createCommandPorts(secrets)),
    fingerprintSecret,
    workspaceEncryption,
    metrics: options.metrics,
    // Each event's outbox row, read and dispatched bound to its organisation (D5).
    afterCommit: (events) => background.dispatchCommittedEvents(events),
  });
  // The off-bus targets, over `storage` and `secrets`, neither of which any
  // of them reads until a command runs.
  const projectRegistration = createProjectRegistration({
    repository: () => createProjectRegistrationRepository(db),
    secrets,
  });
  const {
    agentAdministrationHandlers,
    revokeAgentCredential,
    revokeAgentOauthGrant,
  } = createAgentAdministration({
    transaction: agentAdministrationTransaction(storage, secrets),
    secrets,
  });
  const { splitImportEntry } = createImportSplit({
    transaction: importSplitTransaction(storage, secrets),
    secrets,
  });
  const { queueSlackConnectionTest } = createSlackConnectionTest({
    transaction: slackConnectionTestTransaction(storage, secrets),
    secrets,
    startConnectionTest: (operationId) =>
      background.triggerSlackConnectionTest(operationId),
  });
  const execute = createCommandExecution({
    commandBus: (command) => commandBus.execute(command),
    projectRegistration: (context, input, meta) =>
      projectRegistration.register(context, input, meta),
    agentAdministration: (handler, context, input, meta) =>
      agentAdministrationHandlers[handler](context, input, meta),
    importSplit: splitImportEntry,
    slackConnectionTest: queueSlackConnectionTest,
  });
  // The queries, over `storage`'s handle, each building what it reads when
  // it runs.
  const agentQueries = createAgentQueries(() => createAgentQueryRepository(db));
  const query = createQueryExecution({
    agentQueries,
    administrationReading: { database: db, secrets },
  });
  // The MCP-only capabilities, over `storage` and `secrets`, each building
  // its repositories, or opening its transaction, when it runs. The bus's
  // re-check that the key service and the webhook service's methods run for
  // a person (ruling 233 item 2) is built on the storage's handle without the
  // deployment's operator switch: a person's context is never an operator's,
  // and one that claims to be is refused either way.
  const { createProject, provisionAgent } = createProjectProvisioning({
    transaction: projectProvisioningTransaction(storage),
    agentKeyRepositories: () => ({
      authRepository: createAgentAuthRepository(db),
      agentRepository: createAgentRepository(db),
      authorization: createCommandAuthorizationRepository(db),
    }),
    commandBus: (command) => commandBus.execute(command),
    secrets,
    betterAuth: options.betterAuth,
  });
  // The webhook service, composed when `mcpOnly.webhooks` is first read
  // (ruling 140): `createWebhookManagement` builds the key ring's encryption,
  // which refuses a malformed key, so a malformed webhook key fails the
  // webhook capabilities alone. A read that throws keeps nothing, so each
  // later read throws again.
  let webhooks: McpOnlyCapabilities["webhooks"] | undefined;
  const composeWebhooks = (): McpOnlyCapabilities["webhooks"] => {
    if (webhooks !== undefined) return webhooks;
    let webhookService: ReturnType<typeof createWebhookManagement>;
    try {
      webhookService = createWebhookManagement({
        repository: () => createWebhookRepository(db),
        authorization: () => createCommandAuthorizationRepository(db),
        keys: secrets.webhookKeys,
        secrets,
        production: options.environment === "production",
        privateReceivers: options.privateWebhookReceivers === true,
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // A key ring that cannot be built is the operator's configuration, not
      // the caller's credential, so it is raised as `configuration_error`,
      // which MCP answers with 503 rather than an authorization refusal. The
      // key ring's messages describe a key's shape or version, never its value.
      throw new DomainError(
        "configuration_error",
        `The webhook key ring cannot be built: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const { replay } = createWebhookReplay({
      database: db,
      secrets,
      startDelivery: (deliveryId) =>
        background.triggerWebhookDelivery(deliveryId),
    });
    webhooks = webhookService ? { ...webhookService, replay } : null;
    return webhooks;
  };
  const legacyImports = createLegacyImportAnalysis({
    transaction: legacyImportTransaction(storage),
    secrets,
    dispatchImportTask: (dispatchId, organizationId) =>
      background.dispatchImportTask(dispatchId, organizationId),
  });
  const mcpOnly: McpOnlyCapabilities = {
    createProject,
    provisionAgent,
    get webhooks() {
      return composeWebhooks();
    },
    imports: {
      analyze: legacyImports.analyze,
      list: legacyImports.list,
      detail: legacyImports.detail,
      apply: legacyImports.apply,
      correct: legacyImports.correct,
    },
  };

  // Last, once everything above has been composed without throwing: the
  // worker queries as soon as it runs.
  const worker =
    chosen.kind === "postgres"
      ? startPostgresBackground({
          workerStorages: chosen.workerStorages,
          settings: postgresWorkerSettings(options),
          logger,
          runExclusive: chosen.runExclusive,
        })
      : undefined;

  return {
    commandBus,
    background,
    workspaceEncryption,
    fingerprintSecret,
    execute,
    query,
    agentQueries,
    mcpOnly,
    handlers: {
      revokeAgentCredential,
      revokeAgentOauthGrant,
      splitImportEntry,
      queueSlackConnectionTest,
    },
    worker,
  };
}

function requireOwnerStorage(
  ownerStorage: Storage | undefined,
  operation: "migrate" | "bootstrapOwner",
) {
  if (!ownerStorage) {
    throw new DomainError(
      "configuration_error",
      `${operation}() runs on an owner storage, and this RequestPort was created without ownerStorage`,
    );
  }
  return ownerStorage;
}

/**
 * RequestPort over the storages and secrets it is given (manifest-g.md
 * §2.1). Calling it builds nothing, reads none of its options' secrets or
 * storages, and opens no connection: the command bus, its background port,
 * their keys, the targets `execute` and `query` dispatch to, the MCP-only
 * capabilities and a `postgres` background's worker are composed the first
 * time `start()`, a capability, or one of the composed members (`commandBus`,
 * `background`, `agentQueries`, `mcpOnly`, `handlers`), is asked for, and a
 * connection is opened by the first query, or the worker's first tick. The
 * webhook service, and its key ring, wait until `mcpOnly.webhooks` is first
 * read (ruling 140).
 */
export function createRequestPort(options: RequestPortOptions): RequestPort {
  let composed: RequestPortComposition | undefined;
  const composition = () => {
    composed ??= compose(options);
    return composed;
  };
  const port: RequestPort = {
    // Frozen in place when first read through a RequestPort, not as one is
    // created: creating one changes nothing outside it, and the web, which
    // composes one in every process, freezes the registry only if it reads
    // it here, which it does not.
    get capabilities() {
      return Object.freeze(capabilityRegistry);
    },
    async migrate() {
      const ownerStorage = requireOwnerStorage(options.ownerStorage, "migrate");
      // Imported here: nothing that serves requests needs the migrator in
      // its module graph (`@requestport/db/migrate`).
      const { migrate } = await import("@requestport/db/migrate");
      return migrate(ownerStorage);
    },
    async bootstrapOwner(input) {
      const ownerStorage = requireOwnerStorage(
        options.ownerStorage,
        "bootstrapOwner",
      );
      return domainBootstrapOwner(
        createFoundationRepository(ownerStorage.db),
        {
          actor: BOOTSTRAP_OWNER_ACTOR,
          correlationId: `core_${randomUUID()}`,
        },
        input,
      );
    },
    async signIn(input) {
      return createSignIn(options.betterAuth)(input);
    },
    async execute(name, input, call) {
      return composition().execute(name, input, call);
    },
    async query(name, parameters, call) {
      return composition().query(name, parameters, call);
    },
    get agentQueries() {
      return composition().agentQueries;
    },
    get mcpOnly() {
      return composition().mcpOnly;
    },
    get handlers() {
      return composition().handlers;
    },
    get commandBus() {
      return composition().commandBus;
    },
    get background() {
      return composition().background;
    },
    async start() {
      await composition().worker?.ready;
    },
    async close() {
      await composed?.worker?.stop();
    },
  };

  compositions.set(port, composition);
  return port;
}

/**
 * The composition behind `port`, built on the first call and kept. Not
 * exported from the package's entry: core's tests reach it here.
 */
export function requestPortComposition(
  port: RequestPort,
): RequestPortComposition {
  const composition = compositions.get(port);
  if (!composition) {
    throw new Error("not a RequestPort that createRequestPort returned");
  }
  return composition();
}
