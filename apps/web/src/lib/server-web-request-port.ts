import { serverEnv } from "@requestport/config/server";
import {
  type BackgroundPort,
  createRequestPort,
  type RequestPort,
  type RequestPortKeyRing,
} from "@requestport/core";
import { webMetrics } from "./observability.js";
import { webStorage } from "./server-request-port.js";
import {
  dispatchCommittedCorrelation,
  dispatchCommittedEvents,
  dispatchCommittedOutbox,
  dispatchImportTask,
  triggerNotificationDelivery,
  triggerSlackConnectionTest,
  triggerSlackMessageUpdate,
  triggerWebhookDelivery,
} from "./trigger-client.js";

/*
 * The web's RequestPort (Plan 13, G.6; manifest-g.md §2.1, §2.9; rulings 137
 * and 140), in a module of its own, apart from the web root
 * (`server-request-port.ts`). This module imports
 * `@requestport/config/server`, and `observability.ts` and
 * `trigger-client.ts`, which import `@requestport/config`'s root; each parses
 * the server configuration as it loads. The web root imports none of them, so
 * a module that needs only the root's storage, such as the readiness route
 * (`app/api/health/ready/route.ts`), still loads where the configuration does
 * not parse.
 */

/**
 * The web's background port (`trigger-client.ts`), handed to core whole, so
 * that the process holds one: the command bus core composes dispatches its
 * committed events through it, and the capabilities core runs start their
 * work through it, exactly as the web's own modules do. Each member calls
 * `trigger-client.ts`'s function of the same name, with what it is given,
 * when it runs.
 */
const webBackgroundPort: BackgroundPort = {
  dispatchCommittedOutbox: (outboxId, organizationId) =>
    dispatchCommittedOutbox(outboxId, organizationId),
  dispatchImportTask: (dispatchId, organizationId) =>
    dispatchImportTask(dispatchId, organizationId),
  dispatchCommittedEvents: (events) => dispatchCommittedEvents(events),
  dispatchCommittedCorrelation: (correlationId, organizationId) =>
    dispatchCommittedCorrelation(correlationId, organizationId),
  triggerNotificationDelivery: (intentId, channel) =>
    triggerNotificationDelivery(intentId, channel),
  triggerSlackConnectionTest: (operationId) =>
    triggerSlackConnectionTest(operationId),
  triggerSlackMessageUpdate: (operationId) =>
    triggerSlackMessageUpdate(operationId),
  triggerWebhookDelivery: (deliveryId) => triggerWebhookDelivery(deliveryId),
};

/**
 * A key ring from the variables that carry one: the current key under its
 * version, and the previous key only when it and its version are both set.
 */
function keyRing(
  current: { key: string; version: string },
  previousKey: string | undefined,
  previousVersion: string | undefined,
): RequestPortKeyRing {
  return {
    current,
    ...(previousKey && previousVersion
      ? { previous: { version: previousVersion, key: previousKey } }
      : {}),
  };
}

let requestPort: RequestPort | undefined;

/*
 * The host's handoff (Plan 13, H.5; manifest-h.md §2.7.1; rulings 141, 145
 * and 160): `globalThis[Symbol.for("requestport.host")]`, which a host that
 * serves Next's request handler in its own process sets to the storage,
 * Better Auth and RequestPort it built. Vercel never sets it.
 *
 * It is read here, with the rule `hostHandoffMember` applies in
 * `@requestport/db/wiring`, rather than through that reader: the web's
 * suites that run this module replace `@requestport/db/wiring` with a
 * stand-in that carries `applicationStorageFromEnv` alone
 * (`test/api-v1/fake-database.ts`, `fakeWiringModule`, among others).
 */
const HOST_HANDOFF = Symbol.for("requestport.host");

/**
 * The handoff's RequestPort: undefined where no handoff is set, and
 * otherwise the one it carries, or a refusal, named, after one console line
 * (ruling 145), when it carries none (a value that is not an object, or a
 * `requestPort` that is absent or null).
 */
function handedRequestPort(): RequestPort | undefined {
  const handoff: unknown = (globalThis as Record<symbol, unknown>)[
    HOST_HANDOFF
  ];

  if (handoff === undefined) return undefined;
  const handed =
    typeof handoff === "object" && handoff !== null
      ? (handoff as { requestPort?: unknown }).requestPort
      : undefined;

  if (handed !== undefined && handed !== null) return handed as RequestPort;
  const refusal = new Error(
    "RequestPort's webRequestPort() refused: the host's handoff is present, " +
      "and it carries no requestPort. While it is present, the web answers " +
      "the storage, Better Auth and RequestPort it carries and builds none " +
      "of its own (manifest-h.md §2.7.1).",
  );

  refusal.name = "HostHandoffRefusalError";
  console.error(`${refusal.name}: ${refusal.message}`);
  throw refusal;
}

/**
 * The web's RequestPort: core composed over the web root's storage
 * (`webStorage()`), built the first time it is asked for and kept by this
 * copy of the module. The REST route, the MCP route and the web's server
 * actions take its command bus, `execute`, `query`, the handlers off the bus
 * and the MCP-only capabilities from it, so the web composes no command bus,
 * port table or repository set of its own for them.
 *
 * Asking builds no connection: `createRequestPort` reads none of its options
 * until a capability runs, and the storage connects on its first query. It
 * throws as `webStorage()` does in a process that has declared nothing.
 *
 * Its options are what the web held before, read from `serverEnv`:
 * - `BETTER_AUTH_SECRET`, raw, for the off-bus receipts, and the source of
 *   the bus's fingerprint key; read when each is read;
 * - `REQUESTPORT_OPERATOR_CREDENTIALS`, read each time the command
 *   authorisation port opens, and by each administration read;
 * - the workspace key ring, present exactly when `REQUESTPORT_WORKSPACE_KEK`
 *   is set, as `server-core-commands.ts` built it;
 * - the webhook key ring, `REQUESTPORT_WEBHOOK_KEK` or, unset,
 *   `REQUESTPORT_WEBHOOK_SIGNING_KEY` as the current key, under
 *   `REQUESTPORT_WEBHOOK_KEK_VERSION`, as `server-webhooks.ts` built it;
 * - `environment`: `NODE_ENV`, so that the webhook endpoint policy is
 *   production exactly when `NODE_ENV` is, as it has always been here. The
 *   web runs no `postgres` background, so nothing carries it as a label;
 * - `privateWebhookReceivers`: whether `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS`
 *   is `enabled`, read once, as the RequestPort is composed (Plan 13, H.10).
 *   `serverEnv` refuses the switch wherever `VERCEL_ENV` is set, so a Vercel
 *   deployment always passes `false`;
 * - `webMetrics` for the bus, `BETTER_AUTH_URL` as the public URL, the
 *   background port above, and Better Auth's agent key minter, which
 *   `@requestport/auth/server` installs, imported when a key is minted.
 *
 * `server-web-request-port.test.ts` holds each option as `createRequestPort`
 * receives it.
 *
 * While the host's handoff is set, every ask answers the RequestPort it
 * carries, and this copy composes none; a handoff that carries none is
 * refused (`handedRequestPort`, above).
 */
export function webRequestPort(): RequestPort {
  const handed = handedRequestPort();

  if (handed !== undefined) return handed;
  if (requestPort) return requestPort;
  const webhookKey =
    serverEnv.REQUESTPORT_WEBHOOK_KEK ??
    serverEnv.REQUESTPORT_WEBHOOK_SIGNING_KEY;
  requestPort = createRequestPort({
    storage: webStorage(),
    secrets: {
      get commandFingerprintKey() {
        return serverEnv.BETTER_AUTH_SECRET;
      },
      get operatorCredentials() {
        return serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS;
      },
      workspaceKeys: serverEnv.REQUESTPORT_WORKSPACE_KEK
        ? keyRing(
            {
              version: serverEnv.REQUESTPORT_WORKSPACE_KEK_VERSION,
              key: serverEnv.REQUESTPORT_WORKSPACE_KEK,
            },
            serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS,
            serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION,
          )
        : undefined,
      webhookKeys: webhookKey
        ? {
            ...keyRing(
              {
                version: serverEnv.REQUESTPORT_WEBHOOK_KEK_VERSION,
                key: webhookKey,
              },
              serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS,
              serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION,
            ),
            signingKey: serverEnv.REQUESTPORT_WEBHOOK_SIGNING_KEY,
          }
        : undefined,
    },
    backgroundPort: webBackgroundPort,
    publicUrl: serverEnv.BETTER_AUTH_URL,
    environment: serverEnv.NODE_ENV,
    privateWebhookReceivers:
      serverEnv.REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS === "enabled",
    metrics: webMetrics,
    betterAuth: {
      createAgentApiKey: async (input) =>
        (await import("@requestport/auth/server")).createAgentApiKey(input),
    },
  });
  return requestPort;
}
