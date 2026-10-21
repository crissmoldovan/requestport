import {
  createAgentAuthRepository,
  createAgentRepository,
  createCommandAuthorizationRepository,
  type Storage,
} from "@requestport/db";
import {
  type AgentAdministrationHandlerName,
  type AuthorizedCommandContext,
  agentAdministrationInputSchemas,
  type CommandMeta,
  DomainError,
  requireOrganization,
} from "@requestport/domain";

import {
  createAgentApiKeyService,
  createAgentGrantService,
} from "./agent-services/index.js";
import type { RequestPortSecrets } from "./options.js";

/*
  The two agent administration capabilities that stay off the command bus
  (Plan 13, F.2.2; `manifest-f2.md` §4, Scope 1): revoking an agent's API key
  and revoking its OAuth grant. Each has one handler, here (Plan 13, G.6;
  manifest-g.md §2.5's `agent-administration` row). The web's revocation forms
  call it as the signed-in person, and `execute` reaches it for an operator
  credential through `agentAdministrationHandlers` below: each has a
  capability registry entry dispatched to `agent-administration` that admits
  operators only (ruling 25).

  They stay off the bus because the key and grant services keep their own
  receipts (§2.4): `revoke_agent_credential` and `revoke_agent_oauth_grant`,
  written by the agent auth repository and keyed with the raw
  `commandFingerprintKey` (`BETTER_AUTH_SECRET` in the web), as the forms
  keyed them before the handlers existed. The receipt is not moved, so a form
  submitted before a deploy and retried after it with the same key is still
  answered from it.

  What the bus would have given them, each handler does itself (§2.3): it
  runs in one transaction, which `transaction` opens with every repository
  the handler uses opened on it, and runs the bus's own `assertCurrent` there
  before any other query — for a person, the same lock on the session, the
  membership and the organisation; for an operator, F.3's re-check of the
  credential, its member and the organisation, which refuses while the
  deployment's operator switch is not `enabled`, as the bus's does. The
  repository's write then runs in a savepoint inside it.
  `agentAdministrationTransaction` opens that transaction on a storage, for
  `createRequestPort`. The web's RequestPort opens it on the web root's
  storage, and the web's forms run these handlers through it (`handlers`;
  `apps/web/src/lib/server-agent-actions.ts`).

  Who may act, and as whom, is the services' (`./agent-services`): a person
  with `agent:manage`, or an operator with `agent:revoke` for its member, held
  to its project when bound to one; an operator is recorded as the `service`
  actor it is, under a receipt of its own.
*/

/**
 * The repositories a handler opens on its transaction, each opened when the
 * handler asks for it.
 */
export interface AgentAdministrationRepositories {
  /** The bus's own re-check, under the deployment's operator switch. */
  authorization(): Pick<
    ReturnType<typeof createCommandAuthorizationRepository>,
    "assertCurrent"
  >;
  authRepository(): ReturnType<typeof createAgentAuthRepository>;
  agentRepository(): ReturnType<typeof createAgentRepository>;
}

/**
 * Opens one transaction, unbound, and runs `work` in it with the repositories
 * opened on that transaction.
 */
export type AgentAdministrationTransaction = <T>(
  work: (repositories: AgentAdministrationRepositories) => Promise<T>,
) => Promise<T>;

export interface AgentAdministrationOptions {
  transaction: AgentAdministrationTransaction;
  /** `commandFingerprintKey` is read when each call runs. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
}

export type AgentAdministrationHandler = (
  context: AuthorizedCommandContext,
  rawInput: unknown,
  meta: CommandMeta,
) => Promise<unknown>;

/**
 * The two handlers by the name their REST command dispatches under
 * (`{ to: "agent-administration", handler }` in the capability registry).
 */
export type AgentAdministrationHandlers = {
  readonly [name in AgentAdministrationHandlerName]: AgentAdministrationHandler;
};

export type AgentAdministration = ReturnType<typeof createAgentAdministration>;

/** A revocation never mints a key, so the service is handed a factory that refuses. */
async function refuseToMint(): Promise<never> {
  throw new Error("Revoking an agent credential never creates an API key");
}

export function createAgentAdministration(options: AgentAdministrationOptions) {
  /**
   * Revoke one of an agent principal's API keys.
   *
   * The input names the organisation, the principal and the credential;
   * `meta` carries the credential's expected version and the idempotency
   * key. The organisation must be the context's. The credential is looked up
   * among the principal's, in the transaction, and `not_found` when the
   * principal holds no such credential. `revoke`'s rules then apply
   * unchanged.
   */
  async function revokeAgentCredential(
    context: AuthorizedCommandContext,
    rawInput: unknown,
    meta: CommandMeta,
  ) {
    const input =
      agentAdministrationInputSchemas.revoke_agent_credential.parse(rawInput);
    requireOrganization(context, input.organizationId);
    return options.transaction(async (repositories) => {
      const authorization = repositories.authorization();
      const authRepository = repositories.authRepository();
      const agentRepository = repositories.agentRepository();
      await authorization.assertCurrent(context);
      const credential = (
        await authRepository.listCredentials(
          input.organizationId,
          input.agentPrincipalId,
        )
      ).find((candidate) => candidate.id === input.credentialId);
      if (!credential) {
        throw new DomainError("not_found", "Credential was not found");
      }
      return createAgentApiKeyService({
        createApiKey: refuseToMint,
        authRepository,
        agentRepository,
        fingerprintSecret: options.secrets.commandFingerprintKey,
      }).revoke(context, {
        organizationId: input.organizationId,
        credential,
        meta,
      });
    });
  }

  /**
   * Revoke one of an agent principal's OAuth grants.
   *
   * The input names the organisation, the principal, the grant and the
   * reason recorded in the audit; `meta` carries the grant's expected version
   * and the idempotency key. The organisation must be the context's.
   * `revokeGrant`'s rules then apply unchanged.
   */
  async function revokeAgentOauthGrant(
    context: AuthorizedCommandContext,
    rawInput: unknown,
    meta: CommandMeta,
  ) {
    const input =
      agentAdministrationInputSchemas.revoke_agent_oauth_grant.parse(rawInput);
    requireOrganization(context, input.organizationId);
    return options.transaction(async (repositories) => {
      const authorization = repositories.authorization();
      const authRepository = repositories.authRepository();
      const agentRepository = repositories.agentRepository();
      await authorization.assertCurrent(context);
      return createAgentGrantService({
        authRepository,
        agentRepository,
        fingerprintSecret: options.secrets.commandFingerprintKey,
      }).revokeGrant(context, { ...input, ...meta });
    });
  }

  const agentAdministrationHandlers: AgentAdministrationHandlers = {
    revoke_agent_credential: revokeAgentCredential,
    revoke_agent_oauth_grant: revokeAgentOauthGrant,
  };
  return {
    revokeAgentCredential,
    revokeAgentOauthGrant,
    agentAdministrationHandlers,
  };
}

/**
 * The handlers' transaction on `storage`: one transaction, and each
 * repository opened on it when the handler asks, the re-check's under
 * `secrets.operatorCredentials`, read as that repository opens.
 */
export function agentAdministrationTransaction(
  storage: Pick<Storage, "transaction">,
  secrets: Pick<RequestPortSecrets, "operatorCredentials">,
): AgentAdministrationTransaction {
  return <T>(
    work: (repositories: AgentAdministrationRepositories) => Promise<T>,
  ) =>
    storage.transaction((tx) =>
      work({
        authorization: () =>
          createCommandAuthorizationRepository(tx, {
            operatorCredentials: secrets.operatorCredentials,
          }),
        authRepository: () => createAgentAuthRepository(tx),
        agentRepository: () => createAgentRepository(tx),
      }),
    );
}
