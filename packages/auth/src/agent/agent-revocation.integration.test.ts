import {
  createAgentApiKeyService,
  createAgentGrantService,
} from "@requestport/core/agent-services";
import {
  createAgentAuthRepository,
  createAgentRepository,
  createCommandAuthorizationRepository,
  createOperatorCredentialRepository,
  createStorage,
  type Tx,
} from "@requestport/db";
import {
  endingEachMethodBinding,
  endTenantBinding,
} from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import {
  type ActorRef,
  type AuthorizedCommandContext,
  actorFingerprint,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

/*
  Plan 13, F.2.2's registry half: revoking an agent's API key and its OAuth
  grant with an operator credential, on PostgreSQL, through the real key and
  grant services on the real repositories. `/api/v1` reaches both through
  `revokeAgentCredential` and `revokeAgentOauthGrant`, core's handlers since
  Plan 13, G.6 (`packages/core/src/agent-administration.ts`), each of which
  runs in one transaction, runs the bus's own `assertCurrent` there under the
  deployment's operator switch, and then calls the service; `revokeKey` and
  `revokeGrant` below are those two handlers' bodies with the transaction
  handed in (a savepoint of each case's rolled-back transaction) and the
  switch on. That the handlers do exactly this is held by
  `packages/core/src/agent-administration.test.ts`, against mocks.

  The operator acts with its issuing member's live authority, under
  `agent:revoke`, held to its project when bound to one, and is recorded as
  the `service` actor it is: on the audit row and in the receipt, which is
  its own and never its member's. The credentials are issued through F.3's
  repository.
*/

const formSecret = "agent-revocation-operator-form-secret-000000";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

afterAll(async () => {
  await suiteStorage.close();
});

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("it was not refused");
}

async function refuseToMint(): Promise<never> {
  throw new Error("Revoking an agent credential never creates an API key");
}

/**
 * The handler's own transaction ends the binding its re-check and
 * repositories take; here, where its body runs in a savepoint whose binding
 * outlives it, the binding is ended when the body settles.
 */
async function endingHandlerBinding<T>(tx: Tx, body: Promise<T>) {
  try {
    return await body;
  } finally {
    await endTenantBinding(tx);
  }
}

/** `revokeAgentCredential`'s body, in a savepoint of `tx`. */
function revokeKey(
  tx: Tx,
  context: AuthorizedCommandContext,
  target: { agentPrincipalId: string; credentialId: string },
  meta: { idempotencyKey?: string; expectedVersion?: number } = {},
) {
  return endingHandlerBinding(
    tx,
    tx.transaction(async (handlerTx) => {
      const authorization = createCommandAuthorizationRepository(handlerTx, {
        operatorCredentials: "enabled",
      });
      const authRepository = createAgentAuthRepository(handlerTx);
      const agentRepository = createAgentRepository(handlerTx);
      await authorization.assertCurrent(context);
      const credential = (
        await authRepository.listCredentials(
          context.organizationId,
          target.agentPrincipalId,
        )
      ).find((candidate) => candidate.id === target.credentialId);
      if (!credential) {
        throw new DomainError("not_found", "Credential was not found");
      }
      return createAgentApiKeyService({
        createApiKey: refuseToMint,
        authRepository,
        agentRepository,
        fingerprintSecret: formSecret,
      }).revoke(context, {
        organizationId: context.organizationId,
        credential,
        meta: {
          idempotencyKey: meta.idempotencyKey ?? idempotencyKey(),
          expectedVersion: meta.expectedVersion ?? 1,
        },
      });
    }),
  );
}

/** `revokeAgentOauthGrant`'s body, in a savepoint of `tx`. */
function revokeGrant(
  tx: Tx,
  context: AuthorizedCommandContext,
  target: { agentPrincipalId: string; grantId: string },
  meta: { idempotencyKey?: string; expectedVersion?: number } = {},
) {
  return endingHandlerBinding(
    tx,
    tx.transaction(async (handlerTx) => {
      const authorization = createCommandAuthorizationRepository(handlerTx, {
        operatorCredentials: "enabled",
      });
      const authRepository = createAgentAuthRepository(handlerTx);
      const agentRepository = createAgentRepository(handlerTx);
      await authorization.assertCurrent(context);
      return createAgentGrantService({
        authRepository,
        agentRepository,
        fingerprintSecret: formSecret,
      }).revokeGrant(context, {
        organizationId: context.organizationId,
        ...target,
        reason: "The laptop holding it was lost",
        idempotencyKey: meta.idempotencyKey ?? idempotencyKey(),
        expectedVersion: meta.expectedVersion ?? 1,
      });
    }),
  );
}

function idempotencyKey() {
  return `agent-revocation-${crypto.randomUUID()}`;
}

async function seedPerson(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Agent revoker', ${email}, now())
  `);
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId}, now() + interval '1 hour',
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  return { userId, sessionId };
}

async function seedTenant(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Agent revocation tenant',
      ${`agent-revocation-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMember(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, 'active')
  `);
}

async function seedProject(tx: Tx, organizationId: string) {
  const id = crypto.randomUUID();
  const suffix = id.slice(0, 8);
  await tx.execute(sql`
    insert into "projects"
      ("id", "organization_id", "name", "slug", "key_prefix", "status")
    values (${id}, ${organizationId}, ${`Revocation ${suffix}`},
      ${`revocation-${suffix}`}, ${`R${suffix.toUpperCase()}`}, 'active')
  `);
  return id;
}

async function seedMaintainer(
  tx: Tx,
  organizationId: string,
  projectId: string,
  userId: string,
) {
  await tx.execute(sql`
    insert into "project_members"
      ("organization_id", "project_id", "user_id", "role", "status")
    values (${organizationId}, ${projectId}, ${userId}, 'maintainer', 'active')
  `);
}

async function seedPrincipal(
  tx: Tx,
  organizationId: string,
  projectId: string | null,
  createdByUserId: string,
) {
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "status", "created_by_user_id")
    values (${id}, ${organizationId}, ${projectId},
      ${`Revoked agent ${id.slice(0, 8)}`}, ${`revoked-${id}`}, 'active',
      ${createdByUserId})
  `);
  return id;
}

async function seedCredential(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string;
    userId: string;
  },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, ${input.userId}, ${`secret_${apiKeyId}`},
      true, now() + interval '1 hour', now(), now())
  `);
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_credentials"
      ("id", "organization_id", "agent_principal_id",
       "better_auth_api_key_id", "name", "prefix", "fingerprint", "audience",
       "project_id", "lane_ids", "scopes", "expires_at", "created_by_user_id")
    values (${id}, ${input.organizationId}, ${input.agentPrincipalId},
      ${apiKeyId}, 'Revoked credential', 'rp_live',
      ${`fingerprint_${id}`}, 'mcp', ${input.projectId},
      '[]'::jsonb, '["request:read"]'::jsonb, now() + interval '30 days',
      ${input.userId})
  `);
  return id;
}

async function seedGrant(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string | null;
    delegatedByUserId: string;
  },
) {
  const clientId = `client_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "redirect_uris", "disabled",
       "token_endpoint_auth_method", "require_pkce")
    values (${clientId}, ${clientId},
      ${sql`array['https://example.invalid/callback']`}, false,
      'none', true)
  `);
  const consentId = `consent_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
    values (${consentId}, ${clientId}, ${input.delegatedByUserId},
      ${sql`array['request:read']`})
  `);
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_oauth_grants"
      ("id", "organization_id", "agent_principal_id", "user_id",
       "oauth_client_id", "provider_grant_id", "refresh_family_id",
       "audience", "project_id", "lane_ids", "scopes", "status",
       "expires_at")
    values (${id}, ${input.organizationId}, ${input.agentPrincipalId},
      ${input.delegatedByUserId}, ${clientId}, ${consentId},
      ${crypto.randomUUID()}, 'mcp', ${input.projectId}, '[]'::jsonb,
      ${input.projectId === null ? sql`'["project:provision"]'::jsonb` : sql`'["request:read"]'::jsonb`},
      'active', now() + interval '30 days')
  `);
  return id;
}

/**
 * An organisation with an owner, two projects P and Q, and in each an agent
 * principal holding one key and one grant, plus an organisation-wide
 * principal holding a key in P and a provisioning grant (no project).
 */
async function seedOrganization(tx: Tx) {
  const organizationId = await seedTenant(tx);
  const owner = await seedPerson(tx);
  await seedMember(tx, organizationId, owner.userId, "owner");
  const projectP = await seedProject(tx, organizationId);
  const projectQ = await seedProject(tx, organizationId);
  const inP = await seedPrincipal(tx, organizationId, projectP, owner.userId);
  const inQ = await seedPrincipal(tx, organizationId, projectQ, owner.userId);
  const wide = await seedPrincipal(tx, organizationId, null, owner.userId);
  const key = (agentPrincipalId: string, projectId: string) =>
    seedCredential(tx, {
      organizationId,
      agentPrincipalId,
      projectId,
      userId: owner.userId,
    }).then((credentialId) => ({ agentPrincipalId, credentialId }));
  const grant = (agentPrincipalId: string, projectId: string | null) =>
    seedGrant(tx, {
      organizationId,
      agentPrincipalId,
      projectId,
      delegatedByUserId: owner.userId,
    }).then((grantId) => ({ agentPrincipalId, grantId }));
  return {
    organizationId,
    owner,
    projectP,
    projectQ,
    keys: {
      inP: await key(inP, projectP),
      inP2: await key(inP, projectP),
      inQ: await key(inQ, projectQ),
      wideInP: await key(wide, projectP),
    },
    grants: {
      inP: await grant(inP, projectP),
      inP2: await grant(inP, projectP),
      inQ: await grant(inQ, projectQ),
      provisioning: await grant(wide, null),
    },
  };
}

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `agent:revoke` unless `scopes` says otherwise, as F.3's repository writes
 * one, with the Better Auth key row it is bound to, and the context
 * `authenticateApiBearer` builds for it.
 */
async function issueOperator(
  tx: Tx,
  input: {
    organizationId: string;
    userId: string;
    projectId?: string | null;
    scopes?: string[];
  },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "config_id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, 'requestport-operator', ${input.userId},
      ${`secret_${crypto.randomUUID()}`}, true, now() + interval '30 days',
      now(), now())
  `);
  // Issuance binds the credential's organisation; ended with the call, as
  // the issuing service's own transaction ends it.
  const credential = await endingEachMethodBinding(
    createOperatorCredentialRepository(tx),
    tx,
  ).createCredential({
    organizationId: input.organizationId,
    memberUserId: input.userId,
    projectId: input.projectId ?? null,
    betterAuthApiKeyId: apiKeyId,
    name: "Agent revocation operator",
    prefix: "rpo_f22",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: input.scopes ?? ["agent:revoke"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  const context: AuthorizedCommandContext = {
    actor: operatorActor({
      lineageId: credential.lineageId,
      memberUserId: credential.memberUserId,
    }),
    credentialKind: "operator",
    organizationId: credential.organizationId,
    projectId: credential.projectId,
    laneIds: new Set(),
    scopes: new Set(credential.scopes),
    credentialId: credential.id,
    correlationId: crypto.randomUUID(),
  };
  return { credential, context, apiKeyId };
}

function personContext(
  person: { userId: string; sessionId: string },
  organizationId: string,
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: new Set(["agent:manage"]),
    credentialId: person.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

async function auditFor(tx: Tx, targetId: string) {
  const result = await tx.execute(sql`
    select "actor_type", "actor_id", "action"
    from "security_audit_records" where "target_id" = ${targetId}
  `);
  return result.rows.map((row) => ({
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
  }));
}

async function receiptsUnder(tx: Tx, actor: ActorRef) {
  const result = await tx.execute(sql`
    select "command_name" from "command_receipts"
    where "actor_fingerprint" = ${actorFingerprint(actor)}
    order by "command_name"
  `);
  return result.rows.map((row) => row.command_name);
}

async function credentialRevoked(tx: Tx, credentialId: string) {
  const result = await tx.execute(sql`
    select "revoked_at" is not null as "revoked", "version"
    from "agent_credentials" where "id" = ${credentialId}
  `);
  return result.rows[0];
}

async function grantRevoked(tx: Tx, grantId: string) {
  const result = await tx.execute(sql`
    select "status", "version" from "agent_oauth_grants" where "id" = ${grantId}
  `);
  return result.rows[0];
}

describe.sequential("revoking an agent's key with an operator credential", () => {
  test("an owner's organisation-wide operator revokes it, recorded as the service it is, under its own receipt", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context, credential } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      expect(await revokeKey(tx, context, seeded.keys.inP)).toEqual({
        id: seeded.keys.inP.credentialId,
        revoked: true,
      });
      expect(await credentialRevoked(tx, seeded.keys.inP.credentialId)).toEqual(
        { revoked: true, version: 2 },
      );
      expect(await auditFor(tx, seeded.keys.inP.credentialId)).toEqual([
        {
          actorType: "service",
          actorId: `operator:${credential.lineageId}`,
          action: "agent.credential_revoked",
        },
      ]);
      expect(await receiptsUnder(tx, context.actor)).toEqual([
        "revoke_agent_credential",
      ]);
      expect(
        await receiptsUnder(tx, { type: "user", id: seeded.owner.userId }),
      ).toEqual([]);
    });
  });

  test("its replay answers the first result; its member's retry under the same key is its own, and meets the version check", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      const key = idempotencyKey();
      const first = await revokeKey(tx, context, seeded.keys.inP, {
        idempotencyKey: key,
      });
      expect(
        await revokeKey(tx, context, seeded.keys.inP, { idempotencyKey: key }),
      ).toEqual(first);
      const member = personContext(seeded.owner, seeded.organizationId);
      const error = await refused(
        tx.transaction(async (handlerTx) => {
          const authRepository = createAgentAuthRepository(handlerTx);
          const credential = (
            await authRepository.listCredentials(
              seeded.organizationId,
              seeded.keys.inP.agentPrincipalId,
            )
          ).find((row) => row.id === seeded.keys.inP.credentialId);
          if (!credential) throw new Error("no credential");
          return createAgentApiKeyService({
            createApiKey: refuseToMint,
            authRepository,
            agentRepository: createAgentRepository(handlerTx),
            fingerprintSecret: formSecret,
          }).revoke(member, {
            organizationId: seeded.organizationId,
            credential,
            meta: { idempotencyKey: key, expectedVersion: 1 },
          });
        }),
      );
      expect(error.code).toBe("version_conflict");
      expect(await auditFor(tx, seeded.keys.inP.credentialId)).toHaveLength(1);
    });
  });

  test("its key reused with another key's revocation is an idempotency_conflict, and nothing more is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      const key = idempotencyKey();
      await revokeKey(tx, context, seeded.keys.inP, { idempotencyKey: key });
      const error = await refused(
        revokeKey(tx, context, seeded.keys.inP2, { idempotencyKey: key }),
      );
      expect(error.code).toBe("idempotency_conflict");
      expect(
        await credentialRevoked(tx, seeded.keys.inP2.credentialId),
      ).toEqual({ revoked: false, version: 1 });
      expect(await auditFor(tx, seeded.keys.inP2.credentialId)).toEqual([]);
      expect(await receiptsUnder(tx, context.actor)).toEqual([
        "revoke_agent_credential",
      ]);
    });
  });

  test("without agent:revoke it is refused naming that scope, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
        scopes: ["project:read"],
      });
      const error = await refused(revokeKey(tx, context, seeded.keys.inP));
      expect(error.code).toBe("forbidden");
      expect(error.details).toEqual({ scope: "agent:revoke" });
      expect(await credentialRevoked(tx, seeded.keys.inP.credentialId)).toEqual(
        { revoked: false, version: 1 },
      );
    });
  });

  test("an operator bound to P revokes a key in P, an organisation-wide principal's included, and is refused a key in Q", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
        projectId: seeded.projectP,
      });
      const error = await refused(revokeKey(tx, context, seeded.keys.inQ));
      expect(error.code).toBe("forbidden");
      expect(error.message).toBe("Operator project access is denied");
      expect(await credentialRevoked(tx, seeded.keys.inQ.credentialId)).toEqual(
        { revoked: false, version: 1 },
      );
      expect(await auditFor(tx, seeded.keys.inQ.credentialId)).toEqual([]);
      for (const target of [seeded.keys.inP, seeded.keys.wideInP])
        expect((await revokeKey(tx, context, target)).revoked).toBe(true);
    });
  });

  test("a maintainer's operator bound to P revokes a key in P", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const maintainer = await seedPerson(tx);
      await seedMember(tx, seeded.organizationId, maintainer.userId, "member");
      await seedMaintainer(
        tx,
        seeded.organizationId,
        seeded.projectP,
        maintainer.userId,
      );
      const { context, credential } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: maintainer.userId,
        projectId: seeded.projectP,
      });
      expect((await revokeKey(tx, context, seeded.keys.inP)).revoked).toBe(
        true,
      );
      expect(await auditFor(tx, seeded.keys.inP.credentialId)).toEqual([
        {
          actorType: "service",
          actorId: `operator:${credential.lineageId}`,
          action: "agent.credential_revoked",
        },
      ]);
    });
  });

  test("an operator issued for one organisation finds no key of another, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganization(tx);
      const foreign = await seedOrganization(tx);
      await seedMember(tx, foreign.organizationId, home.owner.userId, "owner");
      const { context } = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.owner.userId,
      });
      for (const target of [
        foreign.keys.inP,
        {
          agentPrincipalId: home.keys.inP.agentPrincipalId,
          credentialId: foreign.keys.inP.credentialId,
        },
      ])
        expect((await refused(revokeKey(tx, context, target))).code).toBe(
          "not_found",
        );
      expect(
        await credentialRevoked(tx, foreign.keys.inP.credentialId),
      ).toEqual({ revoked: false, version: 1 });
    });
  });
});

describe.sequential("revoking an agent's grant with an operator credential", () => {
  test("an owner's organisation-wide operator revokes it, recorded as the service it is, under its own receipt", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context, credential } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      expect(await revokeGrant(tx, context, seeded.grants.inP)).toEqual({
        id: seeded.grants.inP.grantId,
        revoked: true,
        version: 2,
      });
      expect(await grantRevoked(tx, seeded.grants.inP.grantId)).toEqual({
        status: "revoked",
        version: 2,
      });
      expect(await auditFor(tx, seeded.grants.inP.grantId)).toEqual([
        {
          actorType: "service",
          actorId: `operator:${credential.lineageId}`,
          action: "agent.oauth_grant_revoked",
        },
      ]);
      expect(await receiptsUnder(tx, context.actor)).toEqual([
        "revoke_agent_oauth_grant",
      ]);
      expect(
        await receiptsUnder(tx, { type: "user", id: seeded.owner.userId }),
      ).toEqual([]);
    });
  });

  test("its replay answers the first result; its member's retry under the same key is its own, and meets the version check", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      const key = idempotencyKey();
      const first = await revokeGrant(tx, context, seeded.grants.inP, {
        idempotencyKey: key,
      });
      expect(
        await revokeGrant(tx, context, seeded.grants.inP, {
          idempotencyKey: key,
        }),
      ).toEqual(first);
      const member = personContext(seeded.owner, seeded.organizationId);
      const error = await refused(
        tx.transaction((handlerTx) =>
          createAgentGrantService({
            authRepository: createAgentAuthRepository(handlerTx),
            agentRepository: createAgentRepository(handlerTx),
            fingerprintSecret: formSecret,
          }).revokeGrant(member, {
            organizationId: seeded.organizationId,
            ...seeded.grants.inP,
            reason: "The laptop holding it was lost",
            idempotencyKey: key,
            expectedVersion: 1,
          }),
        ),
      );
      expect(error.code).toBe("version_conflict");
      expect(await auditFor(tx, seeded.grants.inP.grantId)).toHaveLength(1);
    });
  });

  test("its key reused with another grant's revocation is an idempotency_conflict, and nothing more is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      const key = idempotencyKey();
      await revokeGrant(tx, context, seeded.grants.inP, {
        idempotencyKey: key,
      });
      const error = await refused(
        revokeGrant(tx, context, seeded.grants.inP2, { idempotencyKey: key }),
      );
      expect(error.code).toBe("idempotency_conflict");
      expect(await grantRevoked(tx, seeded.grants.inP2.grantId)).toEqual({
        status: "active",
        version: 1,
      });
      expect(await auditFor(tx, seeded.grants.inP2.grantId)).toEqual([]);
      expect(await receiptsUnder(tx, context.actor)).toEqual([
        "revoke_agent_oauth_grant",
      ]);
    });
  });

  test("without agent:revoke it is refused naming that scope, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
        scopes: ["project:read"],
      });
      const error = await refused(revokeGrant(tx, context, seeded.grants.inP));
      expect(error.code).toBe("forbidden");
      expect(error.details).toEqual({ scope: "agent:revoke" });
      expect(await grantRevoked(tx, seeded.grants.inP.grantId)).toEqual({
        status: "active",
        version: 1,
      });
    });
  });

  test("an operator bound to P revokes a grant in P, and is refused a grant in Q and a provisioning grant, which names no project", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
        projectId: seeded.projectP,
      });
      for (const target of [seeded.grants.inQ, seeded.grants.provisioning]) {
        const error = await refused(revokeGrant(tx, context, target));
        expect(error.code, target.grantId).toBe("forbidden");
        expect(error.message, target.grantId).toBe(
          "Operator project access is denied",
        );
        expect(await grantRevoked(tx, target.grantId)).toEqual({
          status: "active",
          version: 1,
        });
        expect(await auditFor(tx, target.grantId)).toEqual([]);
      }
      expect((await revokeGrant(tx, context, seeded.grants.inP)).revoked).toBe(
        true,
      );
    });
  });

  test("an organisation-wide operator of an owner revokes a provisioning grant", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      expect(
        (await revokeGrant(tx, context, seeded.grants.provisioning)).revoked,
      ).toBe(true);
    });
  });

  test("an operator issued for one organisation finds no grant of another, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganization(tx);
      const foreign = await seedOrganization(tx);
      await seedMember(tx, foreign.organizationId, home.owner.userId, "owner");
      const { context } = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.owner.userId,
      });
      for (const target of [
        foreign.grants.inP,
        {
          agentPrincipalId: home.grants.inP.agentPrincipalId,
          grantId: foreign.grants.inP.grantId,
        },
      ])
        expect((await refused(revokeGrant(tx, context, target))).code).toBe(
          "not_found",
        );
      expect(await grantRevoked(tx, foreign.grants.inP.grantId)).toEqual({
        status: "active",
        version: 1,
      });
    });
  });
});

describe.sequential("both revocations, as the credential or its member changes", () => {
  const changes: Array<
    [
      string,
      (
        tx: Tx,
        at: {
          organizationId: string;
          userId: string;
          credentialId: string;
          apiKeyId: string;
        },
      ) => Promise<void>,
    ]
  > = [
    [
      "the credential is revoked",
      async (tx, { credentialId }) => {
        await tx.execute(sql`
          update "operator_credentials" set "revoked_at" = now()
          where "id" = ${credentialId}
        `);
      },
    ],
    [
      "the credential has expired",
      async (tx, { credentialId }) => {
        await tx.execute(sql`
          update "operator_credentials"
          set "created_at" = now() - interval '2 days',
              "expires_at" = now() - interval '1 second'
          where "id" = ${credentialId}
        `);
      },
    ],
    [
      "its key has expired",
      async (tx, { apiKeyId }) => {
        await tx.execute(sql`
          update "apikey" set "expires_at" = now() - interval '1 second'
          where "id" = ${apiKeyId}
        `);
      },
    ],
    [
      "its member is demoted below the rule",
      async (tx, { organizationId, userId }) => {
        await tx.execute(sql`
          update "organization_members" set "role" = 'member'
          where "organization_id" = ${organizationId}
            and "user_id" = ${userId}
        `);
      },
    ],
    [
      "its member's membership is revoked",
      async (tx, { organizationId, userId }) => {
        await tx.execute(sql`
          update "organization_members" set "status" = 'revoked'
          where "organization_id" = ${organizationId}
            and "user_id" = ${userId}
        `);
      },
    ],
    [
      "the organisation is suspended",
      async (tx, { organizationId }) => {
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${organizationId}
        `);
      },
    ],
  ];
  test.each(changes)(
    "are refused once %s, having succeeded before, and write nothing",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedOrganization(tx);
        const { context, credential, apiKeyId } = await issueOperator(tx, {
          organizationId: seeded.organizationId,
          userId: seeded.owner.userId,
        });
        await revokeKey(tx, context, seeded.keys.inP);
        await revokeGrant(tx, context, seeded.grants.inP);
        await change(tx, {
          organizationId: seeded.organizationId,
          userId: seeded.owner.userId,
          credentialId: credential.id,
          apiKeyId,
        });
        expect(
          (await refused(revokeKey(tx, context, seeded.keys.inP2))).code,
        ).toBe("forbidden");
        expect(
          (await refused(revokeGrant(tx, context, seeded.grants.inP2))).code,
        ).toBe("forbidden");
        expect(
          await credentialRevoked(tx, seeded.keys.inP2.credentialId),
        ).toEqual({ revoked: false, version: 1 });
        expect(await grantRevoked(tx, seeded.grants.inP2.grantId)).toEqual({
          status: "active",
          version: 1,
        });
      });
    },
  );

  test("a person's revocations are still recorded as the person, as user, under their own receipt", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganization(tx);
      const member = personContext(seeded.owner, seeded.organizationId);
      // A person's context carries its session, which `assertCurrent` checks.
      await revokeKey(tx, member, seeded.keys.inP);
      await revokeGrant(tx, member, seeded.grants.inP);
      expect(await auditFor(tx, seeded.keys.inP.credentialId)).toEqual([
        {
          actorType: "user",
          actorId: seeded.owner.userId,
          action: "agent.credential_revoked",
        },
      ]);
      expect(await auditFor(tx, seeded.grants.inP.grantId)).toEqual([
        {
          actorType: "user",
          actorId: seeded.owner.userId,
          action: "agent.oauth_grant_revoked",
        },
      ]);
      expect(
        await receiptsUnder(tx, { type: "user", id: seeded.owner.userId }),
      ).toEqual(["revoke_agent_credential", "revoke_agent_oauth_grant"]);
    });
  });
});
