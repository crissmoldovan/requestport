import { createHmac } from "node:crypto";

import type { Database, WorkerStorages } from "@requestport/db";

/*
 * The worker's three storages, as the job bodies reach them (Plan 13, Track
 * I.2b, step b2; manifest-i2.md §5.1 "Processing"; track-i2.md, "I.2b design
 * (2026-09-30)" §3).
 *
 * A body claims, accepts, releases and discovers on the dispatcher's
 * storage, runs the maintenance bodies on maintenance's, and does everything
 * else in processing units: `inUnit(organizationId, work)`, one transaction
 * on the tenant processor's storage whose first statement binds the
 * organisation. External calls — a runner's `enqueue`, a webhook POST, a
 * Resend or Slack call — happen between units, never inside one.
 *
 * The worker root builds the three from the three variables only, and
 * refuses when none is set (`worker-root.ts`; Plan 13, I.2b's b5, ruling 214
 * item 1). On either of `createWorkerStorages`' two exceptions, asked for in
 * code by `requestport start` on PGlite and by a suite in a process declared
 * `test`, all three are the handle of the storage the caller gave, and a
 * unit is no transaction at all: `work` receives that handle. Either way the
 * claims go through their functions, settlement is b2's, and a processing
 * body resolves its organisation first. track-i2.md lists what b2 changed,
 * in "b2, the packages/jobs and trigger half", under "Production changes
 * (b2)".
 *
 * Installed by an entry point, or else built the first time a body asks by
 * the worker root that this package's own module registers
 * (`registerWorkerRoot`, below). This module imports no other module of the
 * repository's but as types, and so not the root (Plan 13, G.7a; ruling 139,
 * option (b)): a process that loads it without that module, as core's
 * `postgres` background does, has no root registered here.
 * - The Trigger.dev worker has no entry file to install from, and its indexer
 *   imports every task module where no database is reachable. Its task
 *   modules reach this package only through `@requestport/jobs` itself,
 *   which registers the worker root as it loads (`index.ts`), so it builds on
 *   first use, from `process.env` (`workerStoragesFromRoot`,
 *   `worker-root.ts`). The root refuses a process that has not declared the
 *   worker surface (M2, branch (b); manifest-g.md §2.10).
 * - `requestport-jobs` installs its own (`cli.ts`, through the same root,
 *   with its own pool sizes), and never loads that module.
 * - Core's `postgres` background installs its caller's
 *   (`@requestport/core`). The tests install stand-ins, or load that module.
 * With nothing installed and no root registered, `workerStorages()` refuses,
 * and builds nothing.
 *
 * With nothing installed while the host's handoff is set
 * (`globalThis[Symbol.for("requestport.host")]`; Plan 13, H.5;
 * manifest-h.md §2.7.1; rulings 145 and 160), it refuses too, with one
 * console line, and asks no root to build: a host composes the worker's
 * storages itself and installs them in its own copy of this module, through
 * core's `postgres` background, so a copy with none installed, such as one
 * Next's build carries, builds none. It reads the symbol itself, since it
 * imports nothing of the repository's but types. Where nothing sets the
 * handoff, as in the Trigger.dev worker, the root fills the holder as before.
 */

let current: WorkerStorages | undefined;

const HOST_HANDOFF = Symbol.for("requestport.host");

/** Throws, after its console line, while the host's handoff is set. */
function refuseWhileTheHostHandoffIsSet(): void {
  if ((globalThis as Record<symbol, unknown>)[HOST_HANDOFF] === undefined) {
    return;
  }
  const refusal = new Error(
    "RequestPort's workerStorages() refused: the host's handoff is " +
      "present, and no worker storages are installed in this copy of the " +
      "holder. While it is present, the web answers the storage, Better " +
      "Auth and RequestPort it carries and builds none of its own " +
      "(manifest-h.md §2.7.1).",
  );

  refusal.name = "HostHandoffRefusalError";
  console.error(`${refusal.name}: ${refusal.message}`);
  throw refusal;
}

/**
 * This process's worker storages: the installed ones, or else those the
 * registered worker root builds and installs on the first ask, unless the
 * host's handoff is set (above).
 */
export function workerStorages(): WorkerStorages {
  if (current === undefined) {
    refuseWhileTheHostHandoffIsSet();
    registeredRoot("storages").installStorages();
  }
  if (current === undefined) {
    throw new Error("The registered worker root installed no worker storages.");
  }
  return current;
}

/**
 * Installs `storages` as this process's, or with `undefined` forgets them, so
 * the next `workerStorages()` asks the registered worker root again. It does
 * not close what it replaces.
 */
export function useWorkerStorages(storages: WorkerStorages | undefined): void {
  current = storages;
}

/**
 * What fills the holder when nothing is installed: each member builds what it
 * names and installs it, through `useWorkerStorages` or `useWorkerSettings`.
 * The two fill apart, as they always have: the settings build no storage, and
 * so ask for no declared surface.
 */
export interface WorkerRootRegistration {
  installStorages(): void;
  installSettings(): void;
}

let root: WorkerRootRegistration | undefined;

/**
 * Registers what `workerStorages()` and `workerSettings()` fill from when
 * nothing is installed, in place of any registered before.
 * `@requestport/jobs`' own module (`index.ts`) registers the worker root's as
 * it loads.
 */
export function registerWorkerRoot(registration: WorkerRootRegistration): void {
  root = registration;
}

/** The registered root, or a refusal that says what would fill the holder. */
function registeredRoot(
  missing: "storages" | "settings",
): WorkerRootRegistration {
  if (root) return root;
  const install =
    missing === "storages" ? "useWorkerStorages" : "useWorkerSettings";
  throw new Error(
    `This process has no worker ${missing} installed, and no worker root registered to build them: install them with ${install}, or load @requestport/jobs, whose module registers the worker root.`,
  );
}

/** A key and its version, as the `*_KEK` and `*_KEK_VERSION` variables carry them. */
export interface WorkerKey {
  version: string;
  /** Base64. */
  key: string;
}

/** The key that wraps, and the one before it, which still unwraps. */
export interface WorkerKeyRing {
  current: WorkerKey;
  previous?: WorkerKey;
}

/**
 * The secrets the job bodies read. Each but the sweep's key is absent where
 * its variables are unset.
 */
export interface WorkerSecrets {
  /**
   * The key the stale-session sweep's command bus fingerprints with: the
   * authentication secret's HMAC under the sweep's own label
   * (`workSweepFingerprintSecret`), never the secret itself.
   */
  readonly workSweepFingerprintSecret: string;
  /** The Slack installations' envelope keys (`REQUESTPORT_WORKSPACE_KEK*`). */
  readonly workspaceKeys: WorkerKeyRing | undefined;
  /** What Slack tokens are hashed with (`REQUESTPORT_SLACK_STATE_SECRET`). */
  readonly slackStateSecret: string | undefined;
  /**
   * The webhook secrets' envelope keys. The worker root makes
   * `REQUESTPORT_WEBHOOK_KEK`, or `REQUESTPORT_WEBHOOK_SIGNING_KEY` in its
   * place, the current key.
   */
  readonly webhookKeys: WorkerKeyRing | undefined;
  /** Resend's key and sender, present only as a pair (`RESEND_*`). */
  readonly email: { apiKey: string; from: string } | undefined;
}

/**
 * Whose service names the job bodies' log lines and the metric sink carry
 * (`observability.ts`; ruling 158, item 9): `"trigger"`, the names they have
 * always carried, which the Trigger.dev worker and `requestport-jobs` log
 * under (`requestport-trigger` for the metric sink, `trigger-retention` and
 * the rest for the bodies), or `"self-host"`, the self-host's own
 * (`requestport-worker`, `requestport-retention` and the rest).
 */
export type WorkerServiceNames = "trigger" | "self-host";

/**
 * What the job bodies read besides their storages (manifest-g.md §2.3;
 * ruling 65's hand-over of the bodies, for the label and the secrets only;
 * ruling 158, item 9, for the service names).
 */
export interface WorkerSettings {
  /**
   * The label the bodies' log lines and the metric sink carry. Absent, each
   * keeps the default it always had: `"unknown"` for the bodies' loggers,
   * `"development"` for the metric sink (`observability.ts`).
   */
  readonly environment: string | undefined;
  /**
   * Whose service names the bodies' log lines and the metric sink carry
   * (`WorkerServiceNames`). Absent, `"trigger"`: the worker root's settings
   * name none, so the Trigger.dev worker and `requestport-jobs` keep the
   * names they have always logged under. Core's `postgres` background, which
   * `requestport start` runs in its own process, and `requestport worker`
   * install `"self-host"`.
   */
  readonly serviceNames?: WorkerServiceNames;
  /** The origin notification links are written against (`BETTER_AUTH_URL`). */
  readonly publicUrl: string;
  /**
   * Whether the webhook delivery body holds each endpoint to the production
   * policy (`deliverWebhook`'s `production`, `@requestport/webhooks`): `https`
   * on port 443 only; otherwise plain `http` on any port is admitted too. The
   * worker root answers whether `NODE_ENV` is `"production"`, read each time
   * it is read, as the body read it before; core's `postgres` background
   * answers whether its `environment` option is `"production"`.
   */
  readonly productionWebhookEndpoints: boolean;
  /**
   * Whether the webhook delivery body admits private and loopback receivers
   * (`deliverWebhook`'s `privateReceivers`, `@requestport/webhooks`; Plan 13,
   * H.10). The worker root answers whether the configuration's
   * `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS` is `enabled`; core's `postgres`
   * background answers whether its `privateWebhookReceivers` option is
   * `true`.
   */
  readonly privateWebhookReceivers: boolean;
  readonly secrets: WorkerSecrets;
}

/*
 * This process's settings, kept beside its storages and filled the same way:
 * installed, or else built by the registered worker root, from the process's
 * own configuration (`workerSettingsFromRoot`), the first time a body asks.
 * The Trigger.dev worker installs nothing and takes the root's;
 * `requestport-jobs` installs the root's at its start (`cli.ts`); core's
 * Postgres background installs what its caller gave it
 * (`@requestport/core`). The root reads nothing until it is asked, and a
 * secret only when a body reads it, so importing a body still reads nothing.
 * With nothing installed and no root registered, `workerSettings()` refuses.
 */
let settings: WorkerSettings | undefined;

/**
 * This process's settings: the installed ones, or else those the registered
 * worker root builds and installs on the first ask.
 */
export function workerSettings(): WorkerSettings {
  if (settings === undefined) registeredRoot("settings").installSettings();
  if (settings === undefined) {
    throw new Error("The registered worker root installed no worker settings.");
  }
  return settings;
}

/**
 * Installs `next` as this process's settings, or with `undefined` forgets
 * them, so the next `workerSettings()` asks the registered worker root again.
 */
export function useWorkerSettings(next: WorkerSettings | undefined): void {
  settings = next;
}

/**
 * The label the stale-session sweep's fingerprint key is derived under. The
 * worker root takes it from here (`worker-root.ts`).
 */
export const workSweepFingerprintLabel = "requestport-work-sweep-v1";

/**
 * The key the stale-session sweep's command bus fingerprints actors and
 * idempotency keys with: HMAC-SHA256 keyed by the authentication secret over
 * `"requestport-work-sweep-v1"`, in hex. The web's buses derive theirs from
 * the same secret under another label, so a receipt one writes is never
 * found by the other. Defined here, which reaches no root, so that core's
 * `postgres` background derives its settings' key with it
 * (`@requestport/core`'s `worker-holder.ts`) without loading the worker root
 * (Plan 13, G.7a; ruling 144). The worker root writes the same derivation out
 * under the same label (`workerSettingsFromRoot`, `worker-root.ts`), and a
 * case in worker-root.test.ts holds the two equal.
 */
export function workSweepFingerprintSecret(
  authenticationSecret: string,
): string {
  return createHmac("sha256", authenticationSecret)
    .update(workSweepFingerprintLabel)
    .digest("hex");
}

/**
 * One processing unit for `organizationId` on the processor's storage
 * (`WorkerStorages.withTenant`), handing `work` a handle the repository
 * factories take: the bound transaction, or, on one of
 * `createWorkerStorages`' two exceptions (above), the handle of the storage
 * its caller gave.
 */
export function inUnit<T>(
  organizationId: string,
  work: (database: Database) => Promise<T>,
): Promise<T> {
  // A bound transaction is a Drizzle `PgTransaction`, which the factories
  // accept as they accept the pool (packages/db casts it the same way in
  // `boundOutboxRepository`).
  return workerStorages().withTenant(organizationId, (database) =>
    work(database as Database),
  );
}
