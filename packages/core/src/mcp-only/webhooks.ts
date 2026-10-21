import {
  boundOutboxRepository,
  type createCommandAuthorizationRepository,
  createOutboxRepository,
  type createWebhookRepository,
  type Database,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  type CommandMeta,
  DomainError,
  requireScope,
} from "@requestport/domain";
import { createWebhookManagementService } from "@requestport/webhooks";

import {
  agentContextOf,
  type NetworkCapabilityCall,
  requireProject,
} from "../network-call.js";
import type { RequestPortKeyRing, RequestPortSecrets } from "../options.js";
import { createKeyRingEncryption } from "../secrets.js";

/*
  The webhook management service (manifest-g.md §2.5, the MCP-only
  capabilities): list, create, verify, rotate and set the status of an event
  subscription. Moved from `apps/web/src/lib/server-webhooks.ts` in Plan 13,
  G.6. The MCP route's five subscription tools run it for an agent, and the
  web's webhooks page runs it for the signed-in person; the service checks
  each caller itself (`@requestport/webhooks`). For a person's context, each
  method here first runs the bus's own re-check of a person (`assertCurrent`),
  which the service does not (ruling 233 item 2). Replaying a delivery is not
  the service's: `createWebhookReplay`, below, moved from the MCP route's
  inline `replay_webhook_delivery` tool with ruling 137, writes it for an
  agent.
*/

export type WebhookManagementService = ReturnType<
  typeof createWebhookManagementService
>;

export interface WebhookManagementOptions {
  /** The repository the service runs over, built each time a method runs. */
  repository(): ReturnType<typeof createWebhookRepository>;
  /**
   * The bus's own re-check (`assertCurrent`), built each time a person's call
   * runs, before the service is. A RequestPort builds it on its storage's
   * handle, where it runs in a transaction of its own (or, with the tenant
   * binding off, on the handle itself), which ends before the service runs.
   */
  authorization(): Pick<
    ReturnType<typeof createCommandAuthorizationRepository>,
    "assertCurrent"
  >;
  /**
   * The webhook key ring: in the web, `REQUESTPORT_WEBHOOK_KEK`, or
   * `REQUESTPORT_WEBHOOK_SIGNING_KEY` where the KEK is unset, under
   * `REQUESTPORT_WEBHOOK_KEK_VERSION`, with the previous key and version when
   * both are set. Absent: there is no service.
   */
  keys: RequestPortKeyRing | undefined;
  /** `commandFingerprintKey`, raw, keys the service's receipts. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
  /**
   * The switch the endpoint policy reads (`resolveWebhookEndpoint`,
   * `@requestport/webhooks`): `true` refuses an endpoint that is not
   * `https`, and any port but 443; `false` also admits plain `http`, on any
   * port. Every other check of the policy applies either way. A RequestPort
   * passes whether its `environment` option is `"production"`.
   */
  production: boolean;
  /**
   * The endpoint policy's other switch, `privateReceivers`: `true` admits
   * private and loopback receivers, as `@requestport/webhooks` defines them.
   * A RequestPort passes whether its `privateWebhookReceivers` option is
   * `true`.
   */
  privateReceivers: boolean;
}

/**
 * The management service, or `null` when no webhook key ring is given. The
 * ring's encryption is built here, once; the fingerprint key is read here
 * too. Each method builds the service over `repository()` when it is
 * called, so composing this opens nothing and builds no repository.
 *
 * A person's context (a `user` actor) is first re-checked as the bus
 * re-checks a person, by `authorization().assertCurrent`, and its refusal is
 * the call's, before the service or its repository is built (ruling 233
 * item 2): the context's `credentialId` must name an unexpired session of
 * that person while they are an active member of the active organisation,
 * or an active organisation-wide provisioning grant they delegated, while
 * they are an active owner or admin of the organisation (the role is read at
 * the re-check, not at delegation). The service then checks the role
 * (`canManage`), as before, and its writes check it again under lock. The
 * re-check's locks are not held into the service's own transactions, as the
 * bus holds them into a command's. Any other context reaches the service as
 * before, which refuses all but an agent's, and re-reads an agent's
 * credential.
 */
export function createWebhookManagement(
  options: WebhookManagementOptions,
): WebhookManagementService | null {
  if (!options.keys) return null;
  const encryption = createKeyRingEncryption(options.keys);
  const fingerprintSecret = options.secrets.commandFingerprintKey;
  const { production, privateReceivers } = options;
  const service = () =>
    createWebhookManagementService({
      repository: options.repository(),
      encryption,
      fingerprintSecret,
      production,
      privateReceivers,
    });
  const admitted = async (context: AuthorizedCommandContext) => {
    if (context.actor.type === "user") {
      await options.authorization().assertCurrent(context);
    }
  };

  return {
    list: async (context, organizationId) => {
      await admitted(context);
      return service().list(context, organizationId);
    },
    create: async (context, rawInput, meta) => {
      await admitted(context);
      return service().create(context, rawInput, meta);
    },
    verify: async (context, input, meta) => {
      await admitted(context);
      return service().verify(context, input, meta);
    },
    rotate: async (context, input, meta) => {
      await admitted(context);
      return service().rotate(context, input, meta);
    },
    setStatus: async (context, input, meta) => {
      await admitted(context);
      return service().setStatus(context, input, meta);
    },
  };
}

export interface WebhookReplayOptions {
  /**
   * The handle the delivery is read on, bound to the agent's organisation,
   * and the replay written on: a RequestPort's storage's.
   */
  database: Database;
  /** `commandFingerprintKey`, raw, keys the replay's receipt; read per call. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
  /**
   * Starts the replayed delivery, after the replay is written: the caller's
   * background (`BackgroundPort`'s `triggerWebhookDelivery`).
   */
  startDelivery: (deliveryId: string) => Promise<unknown>;
}

/**
 * Replaying one webhook delivery for an agent, as MCP's
 * `replay_webhook_delivery` does. MCP offers the tool only beside the
 * management service, to a grant holding `webhook:manage`, and the replay
 * checks that scope itself too (ruling 230), for a caller of the published
 * API that reaches it without MCP.
 */
export function createWebhookReplay(options: WebhookReplayOptions) {
  /**
   * Replays `deliveryId`, for an agent's call, and answers the replay's id.
   *
   * Anything but an agent's call is refused first, then a context lacking
   * `webhook:manage`, with the management service's own check
   * (`requireScope`), before anything is read. The scope checked is the one
   * the context states; the repository below re-checks that the agent's
   * authorization is active, not which scopes it holds. The delivery is read
   * bound to the agent's organisation; one outside that organisation, or of
   * a subscription outside the agent's project, is `not_found`, as one that
   * does not exist is. The replay is written as the agent, on its grant and
   * lanes, keyed by the raw `commandFingerprintKey`; a replay the repository
   * does not write is `not_found` too. Its delivery is then started: a start
   * that fails is swallowed, because the delivery row is canonical, and the
   * webhook repair schedule submits any still-pending delivery with the same
   * idempotency key.
   */
  async function replay(
    deliveryId: string,
    call: Pick<NetworkCapabilityCall, "context" | "credentialKind"> & {
      meta: CommandMeta;
    },
  ) {
    const context = agentContextOf(call);
    requireScope(context, "webhook:manage");
    const { meta } = call;
    const source = await boundOutboxRepository(
      context.organizationId,
      options.database,
    ).loadWebhookDelivery(deliveryId);
    if (
      !source ||
      source.delivery.organizationId !== context.organizationId ||
      source.subscription.projectId !== requireProject(context).projectId
    )
      throw new DomainError("not_found", "Webhook delivery was not found");
    const written = await createOutboxRepository(
      options.database,
    ).createWebhookReplay({
      organizationId: context.organizationId,
      deliveryId,
      actorType: "agent",
      actorId: context.actor.id,
      correlationId: context.correlationId,
      expectedVersion: meta.expectedVersion,
      fingerprintSecret: options.secrets.commandFingerprintKey,
      idempotencyKey: meta.idempotencyKey,
      authorization: {
        projectId: requireProject(context).projectId,
        laneIds: [...(context.laneIds ?? [])],
        // An agent's credential is its authorization: the bearer path gives
        // both fields the authorization's id (`@requestport/auth`).
        authorizationId: context.credentialId,
        delegatedByUserId: context.actor.delegatedBy?.id ?? null,
      },
    });
    if (!written)
      throw new DomainError("not_found", "Webhook delivery was not found");
    try {
      await options.startDelivery(written.id);
    } catch {
      // The delivery row is canonical. The webhook repair schedule submits
      // any still-pending delivery with the same idempotency key.
    }
    return { deliveryId: written.id };
  }

  return { replay };
}
