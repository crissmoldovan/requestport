import type { Storage, WorkerStorages } from "@requestport/db";
import type { MetricSink } from "@requestport/domain";
import type { StartTriggerTask } from "@requestport/jobs/dispatch";

import type { createAgentApiKeyService } from "./agent-services/index.js";
import type { BackgroundPort } from "./background.js";

/*
 * What `createRequestPort` is built from (manifest-g.md §2.1, §2.3, §2.4;
 * the types G.0a fixed in track-g.md). Core reads no environment variable:
 * every secret, URL, label and switch arrives here, and the repository's own
 * surfaces build these options in their roots.
 */

export interface RequestPortOptions {
  /**
   * The storage commands and reads run on (E's contract). Its tenant binding
   * is the storage's own (`createStorage`'s `tenantBinding`). Core never
   * closes it.
   */
  storage: Storage;
  /**
   * The owner-shaped storage `migrate()` and `bootstrapOwner()` run on.
   * Absent, both refuse. Core builds no role guard and cannot see a
   * storage's surface (a `Storage` exposes its driver, `db`, `transaction`,
   * `ready` and `close`), so the caller declares this storage's surface where
   * it builds it (ruling 66): `createStorage({ …, guard:
   * createDatabaseRoleGuard({ surface: () => "operator" }) })`. Core never
   * closes it.
   */
  ownerStorage?: Storage;
  secrets: RequestPortSecrets;
  /** Default `{ kind: "none" }`. Not with `backgroundPort`. */
  background?: RequestPortBackground;
  /**
   * A background port the caller composed (`createBackgroundPort`), used in
   * place of the one RequestPort would compose over `background`, so that a
   * process whose own direct starts already go through a port holds one.
   * The web passes its own (`apps/web/src/lib/trigger-client.ts`): its runner
   * follows `REQUESTPORT_JOB_RUNNER` on every dispatch, and its committed rows
   * are read over the web root's storage, bound to their organisation.
   * RequestPort refuses, as it composes, to be given both this and a
   * `background`.
   */
  backgroundPort?: BackgroundPort;
  /**
   * Today's `BETTER_AUTH_URL`, for the links RequestPort writes: the job
   * bodies a `postgres` background runs write notification links against it.
   */
  publicUrl: string;
  /**
   * The label the job bodies' log lines and metrics carry under a `postgres`
   * background, which the Trigger.dev worker reads from
   * `VERCEL_ENV ?? NODE_ENV`. Default `"unknown"`, for the metrics too.
   *
   * It also chooses the webhook endpoint policy, by whether it is
   * `"production"`: the webhook management service's (`mcpOnly.webhooks`)
   * and, under a `postgres` background, the webhook delivery body's. Under
   * `"production"` an endpoint must be `https` on port 443; under any other
   * label, the default included, plain `http` on any port is admitted too
   * (`resolveWebhookEndpoint`, `@requestport/webhooks`).
   */
  environment?: string;
  /**
   * The operator's opt-in for private and loopback webhook receivers
   * (Plan 13, H.10; rulings 175 and 176), handed to the webhook management
   * service (`mcpOnly.webhooks`) and, under a `postgres` background, to the
   * webhook delivery body, as the endpoint policy's `privateReceivers`
   * (`@requestport/webhooks`). Default `false`. `true` admits receivers in
   * the loopback, RFC 1918, shared and unique-local ranges, less the cloud
   * metadata addresses the policy names there, and under `"production"`
   * plain `http` to a receiver whose every address is in them; never
   * link-local. The web and `requestport start` pass whether
   * `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS` is `enabled`
   * (`apps/web/src/lib/server-web-request-port.ts`,
   * `apps/requestport/src/serve/serve.ts`), which `@requestport/config`
   * refuses wherever `VERCEL_ENV` is set and unless `REQUESTPORT_JOB_RUNNER`
   * is `postgres`.
   */
  privateWebhookReceivers?: boolean;
  /**
   * Where the background port's dispatch writes its lines, and a `postgres`
   * background's worker its own. Default: silent. The job bodies write theirs
   * through `@requestport/config`'s logger, as they always have.
   */
  logger?: RequestPortLogger;
  /**
   * What the command bus records each command to. Default: records nothing.
   * The job bodies a `postgres` background runs record theirs through
   * `@requestport/config`'s metric sink, labelled with `environment`, as the
   * Trigger.dev worker's do.
   */
  metrics?: MetricSink;
  /**
   * Better Auth's acts, taken as functions, because core imports neither
   * `@requestport/auth` nor `better-auth` (manifest-g.md §2.5.1).
   * `signIn()` calls `signInWithLocalCredential`, and
   * `mcpOnly.provisionAgent` mints the agent's key through
   * `createAgentApiKey`; each refuses without its function.
   */
  betterAuth?: RequestPortBetterAuth;
}

export interface RequestPortKey {
  /** As the `*_KEK_VERSION` variables carry it, e.g. `"local-v1"`. */
  version: string;
  /** Base64, as the `*_KEK` variables carry it. */
  key: string;
}

export interface RequestPortKeyRing {
  current: RequestPortKey;
  previous?: RequestPortKey;
}

/**
 * The secrets and switches core takes in place of `serverEnv`. Each member
 * names the variable it replaces. The command bus reads a key derived from
 * `commandFingerprintKey`, `operatorCredentials` and `workspaceKeys`; the
 * capabilities off the bus key their receipts with `commandFingerprintKey`
 * itself, and re-check their caller under `operatorCredentials`, the
 * administration reads included; the webhook management service wraps its
 * secrets with `webhookKeys`. A `postgres` background hands the job bodies a
 * key derived from `commandFingerprintKey`, and `workspaceKeys`,
 * `webhookKeys`, `slackStateSecret` and `email` as given. Nothing reads
 * `webhookKeys.signingKey`.
 */
export interface RequestPortSecrets {
  /**
   * `BETTER_AUTH_SECRET` today, raw. The command buses fingerprint with a key
   * derived from it (`commandFingerprintSecret`), and a `postgres`
   * background's stale-session sweep with another
   * (`workSweepFingerprintSecret`), never with it directly.
   */
  commandFingerprintKey: string;
  /**
   * `REQUESTPORT_OPERATOR_CREDENTIALS` today: a switch, not a secret.
   * Operator contexts pass the bus only while it is `"enabled"`; absent or
   * `"disabled"` refuses them, as an unset variable does. Read each time the
   * command authorisation port opens.
   */
  operatorCredentials?: "enabled" | "disabled";
  /**
   * `REQUESTPORT_WORKSPACE_KEK`, `_VERSION`, `_PREVIOUS` and
   * `_PREVIOUS_VERSION` today. Absent, the bus is composed with no workspace
   * encryption, as it is when the variable is unset.
   */
  workspaceKeys?: RequestPortKeyRing;
  /**
   * `REQUESTPORT_WEBHOOK_KEK*` and `REQUESTPORT_WEBHOOK_SIGNING_KEY` today.
   * The ring's current key is the one that wraps. Where the web and the
   * Trigger.dev worker fall back to the signing key, they build their ring
   * with it as the current key (the web's RequestPort,
   * `apps/web/src/lib/server-web-request-port.ts`; `packages/jobs`' worker
   * root). Absent, `mcpOnly.webhooks` is `null`. `signingKey`,
   * `REQUESTPORT_WEBHOOK_SIGNING_KEY` where it is set, is read by nothing.
   */
  webhookKeys?: RequestPortKeyRing & { signingKey?: string };
  /** `REQUESTPORT_SLACK_STATE_SECRET` today. */
  slackStateSecret?: string;
  /** `RESEND_API_KEY` and `RESEND_FROM_EMAIL` today. */
  email?: { apiKey: string; from: string };
}

/**
 * Where committed background work goes (manifest-g.md §2.4).
 *
 * - `none`: nothing is started. The rows a command commits stay committed
 *   for whatever drains them, nothing is claimed, and a direct start is
 *   refused with `JobDeferredToWorkerError` — exactly what the web does
 *   today while `REQUESTPORT_JOB_RUNNER` selects the Postgres worker.
 * - `postgres`: C's Postgres job worker, run in this process over the three
 *   worker storages the caller built (`createWorkerStorages`, which core
 *   never calls), with the job bodies reading this RequestPort's options in
 *   place of the environment, the webhook body's endpoint policy included
 *   (`environment`). Committed rows wait for its pollers, and a direct start
 *   is refused with `JobDeferredToWorkerError`, as under `none`. The first
 *   capability that composes RequestPort starts it, and so does `start()`,
 *   which a caller awaits to know the worker is ready: once its modules have
 *   loaded, it installs the storages and the bodies' settings and starts the
 *   worker.
 *   `close()` stops it, and forgets what it installed once the worker has
 *   drained. The storages stay the caller's, open. What it installs is
 *   process-wide (`@requestport/jobs`), so a second such background refuses
 *   to start while one runs, or after one stopped undrained.
 *   `runExclusive` is the worker's exclusive runner: each of its loops and
 *   schedules runs a tick only while the runner holds the tick's key, and
 *   skips the tick when it answers `{ acquired: false }`. Absent, it is
 *   `createAdvisoryExclusiveRunner` over the dispatcher's storage
 *   (`@requestport/db`), a transaction-scoped advisory lock per tick, as
 *   `requestport-jobs` runs it. Written out structurally, as the shape of
 *   `@requestport/jobs`' `ExclusiveRunner`, so that it names no type this
 *   package does not publish.
 * - `trigger`: Trigger.dev, through the start function the caller holds,
 *   since core does not depend on `@trigger.dev/sdk`.
 */
export type RequestPortBackground =
  | { kind: "none" }
  | {
      kind: "postgres";
      workerStorages: WorkerStorages;
      runExclusive?: <T>(
        key: string,
        run: () => Promise<T>,
      ) => Promise<{ acquired: true; value: T } | { acquired: false }>;
    }
  | { kind: "trigger"; startTask: StartTriggerTask };

/** Structural, so that the option names no logger package. */
export interface RequestPortLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * A person's live Better Auth session (ruling 63): the session's id and its
 * user's. Core holds no Better Auth type, so it takes these two fields in
 * place of the web's session object.
 */
export interface PersonSession {
  id: string;
  userId: string;
}

export interface LocalCredentialSignIn {
  email: string;
  credential: string;
}

/** The `createApiKey` that `createAgentApiKeyService` takes. */
export type CreateAgentApiKey = Parameters<
  typeof createAgentApiKeyService
>[0]["createApiKey"];

export interface RequestPortBetterAuth {
  /** Signs a person in with D's local credential (ruling 63). */
  signInWithLocalCredential?: (
    input: LocalCredentialSignIn,
  ) => Promise<PersonSession>;
  /** Mints an agent API key under the `requestport-agent` configuration. */
  createAgentApiKey?: CreateAgentApiKey;
}
