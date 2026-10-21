/**
 * The database side of the `/api/v1` characterisation suites, faked.
 *
 * Plan 13, track B1. The REST route is exercised end to end — its own code,
 * the real web root and the RequestPort composed over it (Plan 13, G.6), the
 * real `AtomicCommandBus`, the real `createCoreCommandRegistry()` and the real
 * rate limiter — with only `@requestport/db` replaced, and the storage the
 * web root asks `@requestport/db/wiring` for (`fakeWiringModule`) in a suite
 * whose cases reach it: a route or a handler that runs on the RequestPort,
 * or the rate limiter, which builds its repository over that storage's
 * handle. Those are where every connection is opened, so replacing them is
 * what lets these suites run with no database at all.
 *
 * What the fake cannot tell you, and must not be read as telling you:
 *
 * - **Any repository's own behaviour.** A port method with no behaviour
 *   configured throws `UnconfiguredPortCall`; one with a behaviour returns
 *   whatever the test put there. A payload that came back from a fake proves
 *   the route passed it through, not that production would produce it.
 * - **Transactions.** `run` calls the work once and counts it. Nothing is
 *   rolled back, locked or isolated.
 * - **`register_project`.** It never reaches the command bus; the
 *   RequestPort hands it straight to `projectRegistrationRepository.register`,
 *   whose scope check, receipt and writes live in `@requestport/db`. Here that
 *   repository is a `vi.fn`.
 *
 * This module must never import `@requestport/db` at runtime: it *is* that
 * module in these suites, and an import would recurse into the mock.
 */
import type {
  CommandReceiptRecord,
  DomainEvent,
  TransactionManager,
  UnitOfWork,
} from "@requestport/domain";
import { vi } from "vitest";

/** A port method was called that the test gave no behaviour to. */
export class UnconfiguredPortCall extends Error {
  constructor(readonly call: string) {
    super(`Fake port reached with no behaviour configured: ${call}`);
    this.name = "UnconfiguredPortCall";
  }
}

type PortBehaviour = Record<string, (...args: never[]) => unknown>;

type ReceiptKey = {
  actorFingerprint: string;
  commandName: string;
  idempotencyFingerprint: string;
};

const defaultPorts = (): Record<string, PortBehaviour> => ({
  // The tenant bus, as the web's RequestPort composes it (Plan 13, G.6),
  // asks this port whether the credential is still current before every
  // command. Answering "yes" is the neutral default; a test that wants a
  // revoked credential replaces it.
  commandAuthorization: { assertCurrent: async () => undefined },
});

export const apiV1 = {
  authenticate: vi.fn(),
  rateLimitConsume: vi.fn(),
  agentQueries: {
    getAgentPolicy: vi.fn(),
    listOrganizations: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    listRequests: vi.fn(),
    getRequest: vi.fn(),
    listTimeline: vi.fn(),
    listOpenQuestions: vi.fn(),
    listEvents: vi.fn(),
  },
  registerProject: vi.fn(),
  /** The administration reads `@requestport/db` exports, by read. */
  administrationReads: {
    projectSettings: vi.fn(),
    // Plan 13, F.2.1.
    routingRules: vi.fn(),
    routeEvaluation: vi.fn(),
    // Plan 13, F.2.2.
    agentPrincipals: vi.fn(),
    agentPrincipal: vi.fn(),
    // Plan 13, F.2.4.
    operations: vi.fn(),
    retentionHolds: vi.fn(),
    // Plan 13, F.2.5.
    slackConfiguration: vi.fn(),
    // Plan 13, F.2.6.
    importRuns: vi.fn(),
    importRun: vi.fn(),
    // Plan 13, F.2.7.
    invitations: vi.fn(),
    organizationAppearance: vi.fn(),
  },
  /**
   * What the bus hands on after a commit. No suite here commits an event,
   * so none asserts it; the organisation each event is dispatched under is
   * `trigger-client.test.ts`'s, and the bus's hand-over
   * `server-core-commands.test.ts`'s.
   */
  dispatchCommittedEvents: vi.fn(),
  /**
   * Plan 13, F.2.5: the operation each Slack connection test starts after its
   * handler's transaction, by id.
   */
  triggerSlackConnectionTest: vi.fn(),
  receipts: {
    lock: vi.fn(async (_key: ReceiptKey) => undefined),
    find: vi.fn(
      async (_key: ReceiptKey): Promise<CommandReceiptRecord | null> => null,
    ),
    save: vi.fn(async (_receipt: ReceiptKey & CommandReceiptRecord) => {}),
  },
  appendedEvents: [] as DomainEvent[],
  ports: defaultPorts(),
  portCalls: [] as string[],
  unconfiguredPortCalls: [] as string[],
  transactionsRun: 0,
  /**
   * The organisation each administration read's transaction was bound to
   * (`withAdministrationReadTransaction`; manifest-i2.md §4 Owns, ruling 50).
   */
  readTransactionOrganizations: [] as string[],
  metrics: [] as Array<{
    kind: "count" | "gauge" | "observe";
    name: string;
    labels?: Record<string, string>;
  }>,
};

/** Every fake back to its neutral state: authenticated nobody, allowed by the limiter. */
export function resetApiV1Fakes() {
  apiV1.authenticate.mockReset();
  apiV1.rateLimitConsume
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 1 });
  for (const query of Object.values(apiV1.agentQueries)) query.mockReset();
  apiV1.registerProject.mockReset();
  for (const read of Object.values(apiV1.administrationReads)) read.mockReset();
  apiV1.dispatchCommittedEvents.mockReset().mockResolvedValue(undefined);
  apiV1.triggerSlackConnectionTest.mockReset().mockResolvedValue(undefined);
  apiV1.receipts.lock.mockReset().mockResolvedValue(undefined);
  apiV1.receipts.find.mockReset().mockResolvedValue(null);
  apiV1.receipts.save.mockReset().mockResolvedValue(undefined);
  apiV1.appendedEvents = [];
  apiV1.ports = defaultPorts();
  apiV1.portCalls = [];
  apiV1.unconfiguredPortCalls = [];
  apiV1.transactionsRun = 0;
  apiV1.readTransactionOrganizations = [];
  apiV1.metrics = [];
}

function fakePort(name: string) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        // Not a method anyone calls: `await port` and `String(port)` probe
        // these, and a function here would make the port look thenable.
        if (typeof property !== "string" || property === "then") {
          return undefined;
        }
        return (...args: never[]) => {
          const call = `${name}.${property}`;
          apiV1.portCalls.push(call);
          const behaviour = apiV1.ports[name]?.[property];
          if (!behaviour) {
            apiV1.unconfiguredPortCalls.push(call);
            throw new UnconfiguredPortCall(call);
          }
          return behaviour(...args);
        };
      },
    },
  );
}

const fakeTransaction = Object.freeze({ fake: "transaction" });

/*
 * The agent queries, the project registration and the rate limit
 * repositories, which the routes and the rate limiter build over the web
 * root's storage (Plan 13, G.3): each method a call on `apiV1`, which a test
 * gives its answer. Their factories, below, answer these same objects
 * whatever handle they are given.
 */
const fakeAgentQueryRepository = {
  getAgentPolicy: (...args: unknown[]) =>
    apiV1.agentQueries.getAgentPolicy(...args),
  listOrganizations: (...args: unknown[]) =>
    apiV1.agentQueries.listOrganizations(...args),
  listProjects: (...args: unknown[]) =>
    apiV1.agentQueries.listProjects(...args),
  getProject: (...args: unknown[]) => apiV1.agentQueries.getProject(...args),
  listRequests: (...args: unknown[]) =>
    apiV1.agentQueries.listRequests(...args),
  getRequest: (...args: unknown[]) => apiV1.agentQueries.getRequest(...args),
  listTimeline: (...args: unknown[]) =>
    apiV1.agentQueries.listTimeline(...args),
  listOpenQuestions: (...args: unknown[]) =>
    apiV1.agentQueries.listOpenQuestions(...args),
  listEvents: (...args: unknown[]) => apiV1.agentQueries.listEvents(...args),
};
const fakeProjectRegistrationRepository = {
  register: (...args: unknown[]) => apiV1.registerProject(...args),
};
const fakeRateLimitRepository = {
  consume: (...args: unknown[]) => apiV1.rateLimitConsume(...args),
};

/**
 * The same contract as `createCommandTransactionManager`: the port factory the
 * web app supplies is consulted by name, and a name it does not know throws
 * the same message the real unit of work throws.
 */
function createFakeTransactionManager(
  _database: unknown,
  portFactory: (name: string, database: unknown) => unknown = () => undefined,
): TransactionManager {
  return {
    async run<T>(work: (uow: UnitOfWork) => Promise<T>) {
      apiV1.transactionsRun += 1;
      const uow: UnitOfWork = {
        commandReceipts: apiV1.receipts,
        domainEvents: {
          async append(events) {
            apiV1.appendedEvents.push(...events);
          },
        },
        port<P>(name: string) {
          const port = portFactory(name, fakeTransaction);
          if (port === undefined || port === null) {
            throw new Error(`RequestPort command port is unavailable: ${name}`);
          }
          return port as P;
        },
      };
      return work(uow);
    },
  };
}

/*
 * The web root's storage's handle (`fakeWiringModule`, below). Its
 * transaction is counted as the unit of work's is: the handlers that open
 * their own — the agent revocations (Plan 13, F.2.2), the Slack connection
 * test (F.2.5), the import split (F.2.6) and the route evaluation (F.2.1) —
 * open it on the web root's storage since G.2, through the RequestPort since
 * G.6.
 */
const fakeRootDatabase = {
  fake: "database",
  transaction: async <T>(work: (tx: unknown) => Promise<T>) => {
    apiV1.transactionsRun += 1;
    return work(fakeTransaction);
  },
};

/** What `vi.mock("@requestport/db", …)` resolves to in these suites. */
export const fakeDatabaseModule = {
  // The repositories above, by their factories (Plan 13, G.3).
  createAgentQueryRepository: () => fakeAgentQueryRepository,
  createProjectRegistrationRepository: () => fakeProjectRegistrationRepository,
  createRateLimitRepository: () => fakeRateLimitRepository,
  createCommandTransactionManager: createFakeTransactionManager,
  createAgentRepository: () => fakePort("agents"),
  createAppearanceRepository: () => fakePort("appearance"),
  createCollaborationRepository: () => fakePort("collaboration"),
  createCommandAuthorizationRepository: () => fakePort("commandAuthorization"),
  createProjectSettingsCommandRepository: () =>
    fakePort("projectSettingsCommands"),
  createOperatorCredentialRepository: () => fakePort("operatorCredentials"),
  createOperationsCommandRepository: () => fakePort("operationsCommands"),
  createRetentionHoldCommandRepository: () => fakePort("retentionHoldCommands"),
  createSlackAdministrationCommandRepository: () =>
    fakePort("slackAdministrationCommands"),
  createImportReviewCommandRepository: () => fakePort("importReviewCommands"),
  createOrganizationManagementRepository: () =>
    fakePort("organizationManagement"),
  createFoundationRepository: () => fakePort("foundation"),
  createRequestRepository: () => fakePort("requests"),
  createRoutingRepository: () => fakePort("routing"),
  createWorkRepository: () => fakePort("work"),
  createWorkspaceRepository: () => fakePort("workspaces"),
  // Plan 13, F.2.0b: the transaction an administration read runs in, counted
  // as the unit of work's is, and the three shared reads, each a call on the
  // fake port `administrationReads`. Plan 13, F.2.3: its read runs in the same
  // transaction, and is a call on `apiV1.administrationReads`, which a test
  // gives its answer.
  withAdministrationReadTransaction: async <T>(
    organizationId: string,
    work: (tx: unknown) => Promise<T>,
  ) => {
    apiV1.transactionsRun += 1;
    apiV1.readTransactionOrganizations.push(organizationId);
    return work(fakeTransaction);
  },
  listAdministrationProjects: (...args: never[]) =>
    (
      fakePort("administrationReads") as PortBehaviour
    ).listAdministrationProjects?.(...args),
  listAdministrationLanes: (...args: never[]) =>
    (
      fakePort("administrationReads") as PortBehaviour
    ).listAdministrationLanes?.(...args),
  listAdministrationMembers: (...args: never[]) =>
    (
      fakePort("administrationReads") as PortBehaviour
    ).listAdministrationMembers?.(...args),
  readProjectSettingsForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.projectSettings(...args),
  // Plan 13, F.2.1: its read and its route evaluation run in the same
  // transaction, each a call on `apiV1.administrationReads`.
  readRoutingRulesForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.routingRules(...args),
  evaluateRouteForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.routeEvaluation(...args),
  // Plan 13, F.2.2: the agent reads, each a call on
  // `apiV1.administrationReads`, and the key and grant revocations'
  // repository, a fake port a test gives its answers.
  readAgentPrincipalsForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.agentPrincipals(...args),
  readAgentPrincipalForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.agentPrincipal(...args),
  createAgentAuthRepository: () => fakePort("agentAuth"),
  // Plan 13, F.2.4: its two reads, each run in that transaction and each a
  // call on `apiV1.administrationReads`, which a test gives its answer.
  readOperationsForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.operations(...args),
  readRetentionHoldsForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.retentionHolds(...args),
  // Plan 13, F.2.5: as F.2.3's, a call on `apiV1.administrationReads`.
  readSlackConfigurationForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.slackConfiguration(...args),
  // Plan 13, F.2.6: its two reads, each a call on `apiV1.administrationReads`.
  readImportRunsForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.importRuns(...args),
  readImportRunForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.importRun(...args),
  // Plan 13, F.2.7: its two reads, in the same transaction, each a call on
  // `apiV1.administrationReads`, which a test gives its answer.
  readInvitationsForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.invitations(...args),
  readOrganizationAppearanceForOperator: (...args: unknown[]) =>
    apiV1.administrationReads.organizationAppearance(...args),
  // Plan 13, F.2.5: the connection test's handler queues through the Slack
  // repository on its own transaction, a fake port a test gives its answer.
  createSlackRepository: () => fakePort("slack"),
};

/**
 * What `vi.mock("@requestport/db/wiring", …)` resolves to (Plan 13, G.6):
 * the application storage the web root asks the wiring for, whose handle
 * here is `fakeRootDatabase`, above. So the web root itself runs: its
 * `webStorage()` answers this storage, its `webDatabase` this handle, and
 * `webRequestPort()` (`server-web-request-port.ts`) composes the web's
 * RequestPort, with the web's own options, over it and over this module's
 * `@requestport/db`. It is for a suite whose cases reach the root: a route
 * or a handler that runs on the RequestPort, or the rate limiter, which
 * builds its repository over the storage's handle.
 */
export const fakeWiringModule = {
  applicationStorageFromEnv: () => ({
    db: fakeRootDatabase,
    transaction: fakeRootDatabase.transaction,
  }),
};

/** What `vi.mock("…/lib/observability.js", …)` resolves to: silent, and recorded. */
export const fakeObservabilityModule = {
  webLogger: { debug() {}, info() {}, warn() {}, error() {} },
  webMetrics: {
    count: (name: string, _value: number, labels?: Record<string, string>) => {
      apiV1.metrics.push({ kind: "count", name, labels });
    },
    gauge: (name: string, _value: number, labels?: Record<string, string>) => {
      apiV1.metrics.push({ kind: "gauge", name, labels });
    },
    observe: (
      name: string,
      _value: number,
      labels?: Record<string, string>,
    ) => {
      apiV1.metrics.push({ kind: "observe", name, labels });
    },
  },
};

/** What `vi.mock("…/lib/trigger-client.js", …)` resolves to: no Trigger.dev. */
export const fakeTriggerClientModule = {
  dispatchCommittedEvents: (...args: unknown[]) =>
    apiV1.dispatchCommittedEvents(...args),
  triggerSlackConnectionTest: (...args: unknown[]) =>
    apiV1.triggerSlackConnectionTest(...args),
};

/**
 * What `vi.mock("@requestport/auth/server", …)` resolves to. The `/api/v1`
 * route authenticates with `authenticateApiBearer` (Plan 13, F.3), which in
 * production hands every credential but an operator key to
 * `authenticateAgentBearer` for the `api` audience; here both answer with
 * whatever context the test signed in as, and the recorded call names the
 * audience the agent path would have been asked for.
 */
export const fakeAuthServerModule = {
  authenticateAgentBearer: (...args: unknown[]) => apiV1.authenticate(...args),
  authenticateApiBearer: (request: Request) =>
    apiV1.authenticate(request, "api"),
};

/**
 * A fixed 32-byte workspace KEK, so `register_machine_workspace` is reachable.
 * Without one the command refuses as `configuration_error` before anything
 * else it does is visible. Test material only; it encrypts nothing real.
 */
const workspaceKek = Buffer.alloc(32, 7).toString("base64url");

export const fakeServerEnv = {
  BETTER_AUTH_SECRET: "b1-characterisation-signing-material-0001",
  BETTER_AUTH_URL: "https://requestport.test",
  REQUESTPORT_WORKSPACE_KEK: workspaceKek,
  REQUESTPORT_WORKSPACE_KEK_VERSION: "b1-test-v1",
  REQUESTPORT_WORKSPACE_KEK_PREVIOUS: undefined,
  REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: undefined,
};

export const fakeServerConfigModule = { serverEnv: fakeServerEnv };
