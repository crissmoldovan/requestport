import { createHmac } from "node:crypto";

import { serverEnv } from "@requestport/config/server-deferred";
import {
  createWorkerStorages,
  type WorkerStorageRole,
  type WorkerStorages,
} from "@requestport/db";
import { assertDeclaredDatabaseSurface } from "@requestport/db/wiring";

import {
  type WorkerSettings,
  workSweepFingerprintLabel,
} from "./worker-storages.js";

/**
 * The worker's composition root (Plan 13, Track G; manifest-g.md §2.9,
 * §2.10; M2, branch (b)): where the worker's three storages come from, for
 * the Trigger.dev worker and for `requestport-jobs` alike.
 *
 * It first checks that this process has declared the worker surface
 * (`assertDeclaredDatabaseSurface`, which throws otherwise, and passes a
 * Vitest process declared `test`), so nothing is built in a process that has
 * not. It then builds the three storages from `env` with `createWorkerStorages`,
 * asking for neither of its exceptions (Plan 13, I.2b's b5; ruling 214 items
 * 1 and 3): with the three variables set, one pool per role, each opening
 * nothing until first used; with none set, refused, naming the three; a
 * partial set, refused too. It builds no storage of its own. The bound
 * units, the guards and the refusals are `createWorkerStorages`'s.
 */
export function workerStoragesFromRoot(
  env: NodeJS.ProcessEnv,
  options: { poolSizes?: Partial<Record<WorkerStorageRole, number>> } = {},
): WorkerStorages {
  assertDeclaredDatabaseSurface("worker");

  return createWorkerStorages(env, options);
}

/**
 * The worker's settings from this process's configuration, for the
 * Trigger.dev worker and `requestport-jobs` alike: what the job bodies read
 * from it before the settings existed, read the same way and no sooner.
 *
 * - The label is `VERCEL_ENV`, else `NODE_ENV`, read when the settings are
 *   built: in the Trigger.dev worker, the first time a body asks for them;
 *   in `requestport-jobs`, as it starts (`cli.ts`). The six modules that
 *   carry it read it as they loaded, before. The two differ only if a
 *   variable changes after the worker starts, which nothing in the
 *   repository's non-test code does.
 * - The webhook endpoint policy is whether `NODE_ENV` is `"production"`,
 *   read each time it is read, as the webhook delivery body read it for each
 *   delivery before; `VERCEL_ENV` plays no part in it.
 * - Whether the delivery body admits private and loopback receivers is
 *   whether `serverEnv`'s `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS` is
 *   `enabled`, read like the members below; the configuration refuses any
 *   other value, and the switch wherever `VERCEL_ENV` is set or
 *   `REQUESTPORT_JOB_RUNNER` is not `postgres`, as on the Trigger.dev worker.
 * - Every other member reads `serverEnv` (`@requestport/config/server-deferred`)
 *   each time it is read, as the bodies read it themselves, so the
 *   configuration is still parsed, and still refused when it is invalid,
 *   only when a body first reads one of them. Each keeps the conditions the
 *   bodies applied: a key ring only with its current key, its previous key
 *   only beside that key's version, Resend's key and sender only as a pair.
 *
 * It builds no storage, so unlike `workerStoragesFromRoot` it asks for no
 * declared surface.
 */
export function workerSettingsFromRoot(): WorkerSettings {
  return {
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    get productionWebhookEndpoints() {
      return process.env.NODE_ENV === "production";
    },
    get privateWebhookReceivers() {
      return serverEnv.REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS === "enabled";
    },
    get publicUrl() {
      return serverEnv.BETTER_AUTH_URL;
    },
    secrets: {
      get workSweepFingerprintSecret() {
        // Written out rather than through workSweepFingerprintSecret()
        // (`worker-storages.ts`, whose label this takes):
        // trigger/src/config-imports.test.ts admits a read of this secret
        // only beside this keyed derivation. A case in worker-root.test.ts
        // holds the two equal.
        return createHmac("sha256", serverEnv.BETTER_AUTH_SECRET)
          .update(workSweepFingerprintLabel)
          .digest("hex");
      },
      get workspaceKeys() {
        if (!serverEnv.REQUESTPORT_WORKSPACE_KEK) return undefined;
        return {
          current: {
            version: serverEnv.REQUESTPORT_WORKSPACE_KEK_VERSION,
            key: serverEnv.REQUESTPORT_WORKSPACE_KEK,
          },
          previous:
            serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS &&
            serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION
              ? {
                  version: serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION,
                  key: serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS,
                }
              : undefined,
        };
      },
      get slackStateSecret() {
        return serverEnv.REQUESTPORT_SLACK_STATE_SECRET;
      },
      get webhookKeys() {
        const key =
          serverEnv.REQUESTPORT_WEBHOOK_KEK ??
          serverEnv.REQUESTPORT_WEBHOOK_SIGNING_KEY;
        if (!key) return undefined;
        return {
          current: { version: serverEnv.REQUESTPORT_WEBHOOK_KEK_VERSION, key },
          previous:
            serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS &&
            serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION
              ? {
                  version: serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION,
                  key: serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS,
                }
              : undefined,
        };
      },
      get email() {
        return serverEnv.RESEND_API_KEY && serverEnv.RESEND_FROM_EMAIL
          ? {
              apiKey: serverEnv.RESEND_API_KEY,
              from: serverEnv.RESEND_FROM_EMAIL,
            }
          : undefined;
      },
    },
  };
}
