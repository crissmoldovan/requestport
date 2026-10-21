import { serverEnv } from "@requestport/config/server";
import type { WebhookManagementService } from "@requestport/core";
import { DomainError } from "@requestport/domain";
import { webRequestPort } from "./server-web-request-port.js";

/**
 * The composed service, as the web's RequestPort holds it
 * (`mcpOnly.webhooks`). It is present exactly when a webhook key is
 * configured, which is when `webhookManagementService` below is not `null`;
 * a RequestPort composed without one answers no service, refused as the
 * configuration error it is.
 */
function service(): WebhookManagementService {
  const webhooks = webRequestPort().mcpOnly.webhooks;
  if (!webhooks) {
    throw new DomainError(
      "configuration_error",
      "Webhooks are not configured in this environment",
    );
  }
  return webhooks;
}

/**
 * The webhook management service, which the webhooks page and the MCP
 * route's subscription tools run: core's (`createWebhookManagement`,
 * `packages/core/src/mcp-only/webhooks.ts`; Plan 13, G.6), as the web's
 * RequestPort composes it (`webRequestPort().mcpOnly.webhooks`; ruling 137)
 * from what `serverEnv` holds: the key ring (`REQUESTPORT_WEBHOOK_KEK`, or
 * `REQUESTPORT_WEBHOOK_SIGNING_KEY` where it is unset, under
 * `REQUESTPORT_WEBHOOK_KEK_VERSION`, and the previous key when it and its
 * version are both set), `BETTER_AUTH_SECRET` for its receipts, and the
 * endpoint policy, production exactly when `NODE_ENV` is (the RequestPort's
 * `environment`), admitting private and loopback receivers exactly when
 * `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS` is `enabled` (its
 * `privateWebhookReceivers`). It is `null` when no webhook key is
 * configured, decided from `serverEnv` as this module loads, as it always
 * was. Each method asks the RequestPort for the service when it is called,
 * and the service is built over the web root's storage when its method runs,
 * so loading this composes nothing.
 */
export const webhookManagementService: WebhookManagementService | null =
  (serverEnv.REQUESTPORT_WEBHOOK_KEK ??
  serverEnv.REQUESTPORT_WEBHOOK_SIGNING_KEY)
    ? {
        list: (context, organizationId) =>
          service().list(context, organizationId),
        create: (context, input, meta) =>
          service().create(context, input, meta),
        verify: (context, input, meta) =>
          service().verify(context, input, meta),
        rotate: (context, input, meta) =>
          service().rotate(context, input, meta),
        setStatus: (context, input, meta) =>
          service().setStatus(context, input, meta),
      }
    : null;
