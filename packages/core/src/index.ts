/*
  `@requestport/core`'s published entry (Plan 13, G.7a; ruling 142): §2.1's
  API as ruling 140 amends it, every name its declarations reach that no
  other published entry exports, and what it re-exports from
  `@requestport/db` (G.7): Done when 12's `createStorage`, `Storage`,
  `StorageOptions`, `DatabaseDriver` and `MigrationReport` (ruling 139);
  the role guard's `createDatabaseRoleGuard`, `DatabaseSurfaceError`,
  `DatabaseRoleGuard` and `RoleGuardOptions`, which `RequestPortOptions`'
  `ownerStorage` tells a caller to build its guard with (ruling 150); and
  `createWorkerStorages` and `WorkerStorages`, which `RequestPortBackground`'s
  `postgres` kind tells a caller to build its worker storages with (ruling
  151). `migrate` itself is on `./migrate` (`migrate.ts`), so that importing
  `.` does not load the migrator. `published-types.test.ts` holds it to
  exactly that, and the tenant-scope sweep follows `createStorage` and
  `createWorkerStorages` through it
  (`packages/db/src/tenant-scope-sweep.test.ts`, `coreReexports`). The other
  names the repository's web imports are on `./adapters` (`adapters.ts`),
  which is published too, because `@requestport/server` imports it (ruling
  193 item 1), but for `personCommandContext`, which is on
  `./person-context` (`person-context.ts`), which is not (ruling 230 item 3).
*/
export {
  createDatabaseRoleGuard,
  createStorage,
  createWorkerStorages,
  type DatabaseDriver,
  type DatabaseRoleGuard,
  DatabaseSurfaceError,
  type RoleGuardOptions,
  type Storage,
  type StorageOptions,
  type WorkerStorages,
} from "@requestport/db";
export type { MigrationReport } from "@requestport/db/migrate";
export {
  type AgentAdministration,
  type AgentAdministrationHandler,
  type AgentAdministrationHandlers,
  type AgentAdministrationOptions,
  type AgentAdministrationRepositories,
  type AgentAdministrationTransaction,
  createAgentAdministration,
} from "./agent-administration.js";
export {
  type BackgroundPort,
  type BackgroundPortOptions,
  type CommittedRows,
  createBackgroundPort,
} from "./background.js";
export {
  type CoreCommandBusOptions,
  createCoreCommandBus,
} from "./command-bus.js";
export type { BusCommand } from "./execute.js";
export {
  createImportSplit,
  type ImportSplitOptions,
  type ImportSplitRepositories,
  type ImportSplitTransaction,
} from "./import-split.js";
export {
  createLegacyImportAnalysis,
  type LegacyImportAnalysisOptions,
  type LegacyImportRepositories,
  type LegacyImportTransaction,
} from "./mcp-only/legacy-import.js";
export {
  type CreateProjectAsDelegateInput,
  createProjectProvisioning,
  type ProjectProvisioningOptions,
  type ProjectProvisioningRepositories,
  type ProjectProvisioningTransaction,
  type ProvisionAgentAsDelegateInput,
} from "./mcp-only/project-provisioning.js";
export {
  createWebhookReplay,
  type WebhookManagementService,
  type WebhookReplayOptions,
} from "./mcp-only/webhooks.js";
export type { NetworkCapabilityCall } from "./network-call.js";
export type {
  CreateAgentApiKey,
  LocalCredentialSignIn,
  PersonSession,
  RequestPortBackground,
  RequestPortBetterAuth,
  RequestPortKey,
  RequestPortKeyRing,
  RequestPortLogger,
  RequestPortOptions,
  RequestPortSecrets,
} from "./options.js";
export type { CapabilityCall, PersonCapabilityCall } from "./person.js";
export type {
  AgentQueries,
  AgentQueryCaller,
  QueryCall,
  QueryContext,
  QueryParameters,
} from "./query.js";
export {
  createRequestPort,
  type McpOnlyCapabilities,
  type OffBusHandlers,
  type RequestPort,
} from "./request-port.js";
export {
  createSlackConnectionTest,
  type SlackConnectionTestOptions,
  type SlackConnectionTestRepositories,
  type SlackConnectionTestTransaction,
} from "./slack-connection-test.js";
