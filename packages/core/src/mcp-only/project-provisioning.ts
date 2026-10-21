import {
  type createAgentAuthRepository,
  type createAgentRepository,
  createCommandAuthorizationRepository,
  createFoundationRepository,
  type Storage,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  DomainError,
  ProjectService,
} from "@requestport/domain";
import { z } from "zod";

import { createAgentApiKeyService } from "../agent-services/index.js";
import { humanScopes } from "../command-bus.js";
import type { BusCommand } from "../execute.js";
import type { RequestPortBetterAuth, RequestPortSecrets } from "../options.js";

/*
  Provisioning from a delegated grant (manifest-g.md §2.5, the MCP-only
  capabilities): MCP's `create_project` and `provision_agent`, which an agent
  reaches only through a consented, exclusively-provisioning grant
  (`project:provision`). Moved from `apps/web/src/lib/server-project-provisioning.ts`
  in Plan 13, G.6, with the delegated context `provision_agent` acts in, which
  the MCP route built until then.

  Each is a person's act. The grant records the human who consented, and the
  consent screen told that human exactly this, so the agent is the mechanism
  and the person is the actor: the audit trail names them, not the principal.
  Without a delegating person each refuses, because there is nobody to act as.

  Each also has the credential that person acts on re-checked as the bus
  re-checks a person's (`assertCurrent`): `provision_agent` on the bus, which
  runs `create_agent_principal` with the grant as its credential, and again
  in the agent key service, before the key is minted (ruling 233 item 2);
  `create_project` in the transaction it opens, before `ProjectService`
  checks the role (ruling 230 item 2), with the grant over MCP or the
  person's session in process.

  `provision_agent` mints the agent's key through the caller's
  `betterAuth.createAgentApiKey`: the key is Better Auth's, and core imports
  no Better Auth (§2.5.1).
*/

type FoundationRepository = ConstructorParameters<typeof ProjectService>[0];

/**
 * The shape the agent key service holds `issuedByGrantId` to
 * (`../agent-services/api-key-service.ts`), which is also the type of a
 * grant's id (`agent_oauth_grants.id`, a `uuid`).
 */
const grantIdShape = z.uuid();

/**
 * The repositories `create_project` opens on its transaction, each opened
 * when it asks for it.
 */
export interface ProjectProvisioningRepositories {
  /** The bus's own re-check, run for the delegating person. */
  authorization(): Pick<
    ReturnType<typeof createCommandAuthorizationRepository>,
    "assertCurrent"
  >;
  /**
   * The repository `ProjectService` runs over, whose `transaction` must run
   * its work in this same transaction, so that the re-check's locks hold
   * until the project is written.
   */
  foundation(): FoundationRepository;
}

/**
 * Opens one transaction, unbound, and runs `work` in it with the repositories
 * opened on that transaction.
 */
export type ProjectProvisioningTransaction = <T>(
  work: (repositories: ProjectProvisioningRepositories) => Promise<T>,
) => Promise<T>;

/**
 * `create_project`'s transaction over a storage: one unbound transaction on
 * `storage`, with each repository opened on it when asked. The foundation
 * repository runs `ProjectService`'s work on that transaction itself, so the
 * re-check's locks are held until the project is written. The context the
 * re-check is given is always a person's, which the deployment's operator
 * switch does not govern, so the switch is not passed.
 */
export function projectProvisioningTransaction(
  storage: Pick<Storage, "transaction">,
): ProjectProvisioningTransaction {
  return <T>(
    work: (repositories: ProjectProvisioningRepositories) => Promise<T>,
  ) =>
    storage.transaction((tx) =>
      work({
        authorization: () => createCommandAuthorizationRepository(tx),
        foundation: () => createFoundationRepository(tx, (run) => run(tx)),
      }),
    );
}

export interface ProjectProvisioningOptions {
  /**
   * The transaction a project is created in: the delegating person is
   * re-checked on it, and then `ProjectService` runs on it.
   */
  transaction: ProjectProvisioningTransaction;
  /**
   * The repositories the agent key service runs over, built when a key is
   * issued, after the principal is written: with them the bus's own re-check
   * (`assertCurrent`), which the key service runs for the delegated person
   * before it reads or mints anything (ruling 233 item 2).
   */
  agentKeyRepositories(): {
    authRepository: ReturnType<typeof createAgentAuthRepository>;
    agentRepository: ReturnType<typeof createAgentRepository>;
    authorization: Pick<
      ReturnType<typeof createCommandAuthorizationRepository>,
      "assertCurrent"
    >;
  };
  /** The tenant command bus `create_agent_principal` runs on. */
  commandBus(command: BusCommand): Promise<unknown>;
  /** `commandFingerprintKey`, raw, keys the key issuance's receipt. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
  /** Absent, or without `createAgentApiKey`: `provisionAgent` refuses. */
  betterAuth?: Pick<RequestPortBetterAuth, "createAgentApiKey">;
}

export interface CreateProjectAsDelegateInput {
  correlationId: string;
  /** The person the grant delegates to; absent for a credential with none. */
  delegatedByUserId: string | undefined;
  /**
   * The credential that person acts on, re-checked as the bus re-checks a
   * person's (`assertCurrent`). One of two: the id of a provisioning grant,
   * as MCP passes, which passes while it is an active, organisation-wide
   * grant that person delegated, and while that person is an active owner or
   * admin of the active organisation (the role is read at the re-check, not
   * at delegation); or the id of that person's session, as an in-process
   * caller holds, which passes while the session is live and the person an
   * active member of the active organisation. Absent, the call is refused.
   */
  credentialId: string | undefined;
  organizationId: string;
  project: {
    description?: string;
    keyPrefix: string;
    name: string;
    repositoryUrl?: string;
    slug: string;
  };
}

export interface ProvisionAgentAsDelegateInput {
  /**
   * The call's idempotency key. It keys both writes, the principal's and the
   * key's, and is the correlation id of both.
   */
  idempotencyKey: string;
  /** The person the grant delegates to; absent for a credential with none. */
  delegatedByUserId: string | undefined;
  /**
   * The provisioning grant itself, recorded on the key it mints. Its id is a
   * UUID; absent, or anything else, the call is refused before either write.
   */
  issuingGrantId: string | undefined;
  organizationId: string;
  provision: {
    displayName: string;
    laneIds?: string[];
    projectId: string;
    scopes: string[];
    slug: string;
    softwareName?: string;
  };
}

export function createProjectProvisioning(options: ProjectProvisioningOptions) {
  /**
   * Creates a project in the organisation, as the human who delegated the
   * grant.
   *
   * `ProjectService` requires an actor of type `user` and then checks that
   * person is an active `owner` or `admin`. Neither rule is relaxed here, and
   * neither should be: they are what make every project in the audit trail
   * attributable to a named person.
   *
   * The role says the person may; the credential shows the person is there.
   * In the one transaction `ProjectService` opens, after it has validated the
   * input and before it reads the organisation and the membership, the
   * credential the person acts on is re-checked as the bus re-checks a
   * person's (`assertCurrent`), which refuses "Current human authorization is
   * no longer active". A call that names no credential is refused before
   * anything is opened.
   */
  async function createProject(input: CreateProjectAsDelegateInput) {
    if (!input.delegatedByUserId) {
      // An API key has no consenting human, so there is nobody this could act
      // as. The scope is already refused on API keys; this is the second wall,
      // here because the first one lives in a different package and could be
      // widened without anyone reading this file.
      throw new DomainError(
        "forbidden",
        "Creating a project requires a delegated grant, so that the act is attributable to a person",
      );
    }
    if (!input.credentialId) {
      throw new DomainError(
        "forbidden",
        "Creating a project requires the credential the delegating person acts on, a provisioning grant or a live session",
      );
    }
    // The person as the bus's re-check reads them: what a signed-in person
    // carries (`humanScopes`), with the credential they act on.
    const delegated: AuthorizedCommandContext = {
      actor: { type: "user", id: input.delegatedByUserId },
      organizationId: input.organizationId,
      scopes: humanScopes,
      credentialId: input.credentialId,
      correlationId: input.correlationId,
    };
    const foundation: FoundationRepository = {
      transaction: (run) =>
        options.transaction(async (repositories) => {
          await repositories.authorization().assertCurrent(delegated);
          return repositories.foundation().transaction(run);
        }),
    };

    return new ProjectService(foundation).create(
      {
        actor: { type: "user", userId: input.delegatedByUserId },
        correlationId: input.correlationId,
      },
      { organizationId: input.organizationId, ...input.project },
    );
  }

  /**
   * Creates an agent principal in a project and issues its first key, as the
   * human who delegated the grant.
   *
   * Two writes, deliberately not one transaction: the principal is a durable
   * identity and the key is a secret revealed once. A retry that found the
   * principal already there should still be able to obtain a key, and a
   * failure after the principal exists should leave something a person can
   * see in the UI rather than nothing at all.
   *
   * Both run in the delegated context: the delegating person, carrying what
   * a signed-in person carries in the UI (`humanScopes`), whose credential is
   * the grant. Over MCP, only a grant holding `project:provision`, which is
   * exclusive, reaches this; in process, any caller holding a `RequestPort`
   * or this factory does (ruling 63). Either way the bus re-checks the
   * credential as it re-checks a person's (`assertCurrent`): a grant passes
   * while it is active and organisation-wide, this person delegated it, and
   * this person is an active owner or admin. `create_agent_principal`'s own
   * check then requires that the person manage the project's agents: an
   * owner or admin, or an active maintainer of the project. The key service
   * re-checks the same context with the re-check `agentKeyRepositories`
   * carries before it reads or mints anything (ruling 233 item 2), so a
   * grant that stopped being active after the principal was written mints
   * nothing. The grant is recorded on the key, so revoking it revokes the
   * key too.
   *
   * The bus's re-check also admits a live session of this person, while an
   * active member, named in the grant's place, as it does for any person's
   * command. So a grant id that is not a UUID is refused here, before either
   * write: the key service refuses one as its `issuedByGrantId`, but only
   * after the principal is written, which left a principal with no key
   * (J.10's F9). The sessions in this repository are Better Auth's, and no
   * id generator is configured for them, so their ids are Better Auth's
   * default, 32 letters and digits, never a UUID. A session id that were a
   * UUID would pass this refusal and the re-check; db's `createCredential`
   * would then refuse it, as no active grant of the organisation, after the
   * principal is written.
   *
   * The four refusals this function makes come before either write.
   */
  async function provisionAgent(input: ProvisionAgentAsDelegateInput) {
    if (!input.delegatedByUserId) {
      throw new DomainError(
        "forbidden",
        "Provisioning an agent requires a delegated grant, so that the act is attributable to a person",
      );
    }
    if (!input.issuingGrantId) {
      // Without a grant to record, the key would be indistinguishable from
      // one a human issued in the UI — and would therefore survive the
      // revocation of the authority that actually created it. Refusing is the
      // only honest option: minting something unrevokable is worse than
      // minting nothing.
      throw new DomainError(
        "forbidden",
        "The issuing grant could not be identified, so this credential could not be revoked with it",
      );
    }
    if (!grantIdShape.safeParse(input.issuingGrantId).success) {
      // A grant's id is a UUID, and the key service records only a UUID as
      // the issuing grant (`issuedByGrantId`). Refused here, before either
      // write: the bus's re-check admits a live session of this person named
      // in the grant's place, so a session's id, which is not a UUID, would
      // have the principal written and the key then refused (J.10's F9).
      throw new DomainError(
        "forbidden",
        "The issuing grant id is not a UUID, so it names no grant this credential could be revoked with",
      );
    }
    const createApiKey = options.betterAuth?.createAgentApiKey;
    if (!createApiKey) {
      throw new DomainError(
        "configuration_error",
        "Provisioning an agent mints its key through Better Auth, and no betterAuth.createAgentApiKey was given",
      );
    }
    const { delegatedByUserId, idempotencyKey, issuingGrantId, provision } =
      input;
    const delegatedContext = () => ({
      actor: { type: "user" as const, id: delegatedByUserId },
      organizationId: input.organizationId,
      scopes: humanScopes,
      credentialId: issuingGrantId,
      correlationId: idempotencyKey,
    });

    const principal = (await options.commandBus({
      name: "create_agent_principal",
      context: delegatedContext(),
      meta: { expectedVersion: 0, idempotencyKey },
      input: {
        displayName: provision.displayName,
        organizationId: input.organizationId,
        projectId: provision.projectId,
        slug: provision.slug,
        ...(provision.softwareName
          ? { softwareName: provision.softwareName }
          : {}),
      },
    })) as { id: string };

    return createAgentApiKeyService({
      createApiKey,
      ...options.agentKeyRepositories(),
      fingerprintSecret: options.secrets.commandFingerprintKey,
    }).issue(
      delegatedContext(),
      {
        agentPrincipalId: principal.id,
        audience: "mcp",
        issuedByGrantId: issuingGrantId,
        laneIds: provision.laneIds ?? [],
        name: provision.displayName,
        organizationId: input.organizationId,
        projectId: provision.projectId,
        scopes: provision.scopes,
      },
      { expectedVersion: 0, idempotencyKey },
    );
  }

  return { createProject, provisionAgent };
}
