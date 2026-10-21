import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AtomicCommandBus,
  type AuthenticatedUserCommandContext,
  type AuthorizedCommandContext,
  actorFingerprint,
  appearancePersonalCommandName,
  CommandRegistry,
  createAuthenticatedUserCommandRegistry,
  createCoreCommandRegistry,
  DomainError,
  type JsonObject,
  keyedFingerprint,
  normalizedInputHash,
  operatorApiKeyConfigId,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type TestContext,
  test,
} from "vitest";

import {
  createStorage,
  type Database,
  type Storage,
  storageOptionsFromEnv,
} from "./client.js";
import { APPLICATION_DATABASE_URL_VARIABLE } from "./database-url.js";
import {
  getAdministrationAgentPrincipal,
  listAdministrationAgentPrincipals,
} from "./queries/administration/agent-reads.js";
import {
  getAdministrationImportRun,
  listAdministrationImportRuns,
} from "./queries/administration/import-reads.js";
import {
  getAdministrationOrganizationAppearance,
  listAdministrationInvitations,
} from "./queries/administration/member-reads.js";
import {
  listAdministrationOperations,
  listAdministrationRetentionHolds,
} from "./queries/administration/operations-reads.js";
import {
  listAdministrationLanes,
  listAdministrationMembers,
  listAdministrationProjects,
} from "./queries/administration/organization-reads.js";
import { getAdministrationProjectSettings } from "./queries/administration/project-settings-reads.js";
import { listAdministrationRoutingRules } from "./queries/administration/routing-reads.js";
import { getAdministrationSlackConfiguration } from "./queries/administration/slack-reads.js";
import { createAgentManagementRepository } from "./queries/agent-management-repository.js";
import { createProjectSettingsCommandRepository } from "./queries/project-settings-repository.js";
import { createAgentAuthRepository } from "./repositories/agent-auth-repository.js";
import { createAppearanceRepository } from "./repositories/appearance-repository.js";
import { createCommandAuthorizationRepository } from "./repositories/command-authorization.js";
import { createCommandTransactionManager } from "./repositories/command-repository.js";
import { createFoundationQueryRepository } from "./repositories/foundation-query.js";
import { createFoundationRepository } from "./repositories/foundation-repository.js";
import {
  boundImportTaskDispatchRepository,
  createImportRepository,
  createImportReviewCommandRepository,
} from "./repositories/import-repository.js";
import {
  lockMutationReceipt,
  type MutationReceiptKey,
  saveMutationReceipt,
  updateMutationReceipt,
} from "./repositories/mutation-receipt.js";
import {
  createNotificationRepository,
  providerStatusRank,
} from "./repositories/notification-repository.js";
import { createOperationsCommandRepository } from "./repositories/operations-repository.js";
import {
  createOperatorCredentialRepository,
  revokeOperatorCredentialsIssuedBy,
} from "./repositories/operator-credential-repository.js";
import { createOrganizationManagementRepository } from "./repositories/organization-management-repository.js";
import { boundOutboxRepository } from "./repositories/outbox-repository.js";
import { createRetentionHoldCommandRepository } from "./repositories/retention-hold-repository.js";
import {
  createSlackAdministrationCommandRepository,
  createSlackRepository,
} from "./repositories/slack-repository.js";
import { kind as hostedDeploymentKind } from "./shared-databases.js";
import { createSignupEligibilityRepository } from "./signup-eligibility.js";
import {
  bindTenant,
  TenantBindingError,
  tenantWrappingEnabled,
  withAdministrationReadTransaction,
  withIsolatedTenantBinding,
} from "./tenant-context.js";
import {
  createTestStorage,
  endingEachCommandBinding,
  endingEachMethodBinding,
  openSession,
  rawQuery,
  type TestSession,
} from "./testing.js";
import type { Tx } from "./transaction.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
 * Row-level security (plan 13, Track I.2; manifest-i2.md §2.7, §2.9).
 *
 * Every case runs in one transaction on one session and is rolled back, so it
 * leaves nothing behind in the shared track database: seeded rows, and the
 * probe roles a case creates, go with the rollback.
 */

afterAll(async () => {
  await suiteStorage.close();
});

async function inRolledBackTransaction<T>(
  work: (session: TestSession) => Promise<T>,
): Promise<T> {
  const session = await openSession(suiteStorage);
  try {
    await session.query("BEGIN");
    // Bound any lock a case waits for behind another suite's transaction.
    await session.query("SET LOCAL lock_timeout = '5s'");
    return await work(session);
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
}

/**
 * Runs one statement that must fail, inside a savepoint so the transaction
 * survives it, and returns the error for the case to judge.
 */
async function failure(
  session: TestSession,
  text: string,
  values: unknown[] = [],
): Promise<{ code?: string; message?: string }> {
  await session.query("SAVEPOINT expected_failure");
  try {
    await session.query(text, values);
  } catch (error) {
    await session.query("ROLLBACK TO SAVEPOINT expected_failure");
    return error as { code?: string; message?: string };
  }
  await session.query("RELEASE SAVEPOINT expected_failure");
  throw new Error(`expected this statement to fail: ${text}`);
}

const sha = (character: string) => character.repeat(64);

/**
 * One organisation's import graph, down to a manifest entry of a run in
 * `state`: organisation, project, source, snapshot, artifact, run, entry.
 */
async function seedImportEntry(session: TestSession, state: string) {
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const snapshotId = randomUUID();
  const artifactId = randomUUID();
  const runId = randomUUID();
  const entryId = randomUUID();
  const slug = `rls-${organizationId.slice(0, 8)}`;

  await session.query(
    `insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [organizationId, slug, slug],
  );
  await session.query(
    `insert into public.projects (id, organization_id, name, slug, key_prefix, status)
     values ($1, $2, 'Imports', 'imports', 'IMP', 'active')`,
    [projectId, organizationId],
  );
  await session.query(
    `insert into public.import_sources (id, organization_id, project_id, created_by)
     values ($1, $2, $3, 'owner-test')`,
    [sourceId, organizationId, projectId],
  );
  await session.query(
    `insert into public.source_snapshots (id, organization_id, import_source_id, manifest_sha256)
     values ($1, $2, $3, $4)`,
    [snapshotId, organizationId, sourceId, sha("a")],
  );
  await session.query(
    `insert into public.source_artifacts
       (id, organization_id, import_source_id, source_snapshot_id, relative_path,
        media_type, byte_size, sha256, exact_bytes)
     values ($1, $2, $3, $4, 'README.md', 'text/markdown', 1, $5, '\\x61')`,
    [artifactId, organizationId, sourceId, snapshotId, sha("b")],
  );
  await session.query(
    `insert into public.import_runs
       (id, organization_id, import_source_id, source_snapshot_id,
        requested_by_type, requested_by_id, state, parser_version)
     values ($1, $2, $3, $4, 'user', 'owner-test', $5, 'test')`,
    [runId, organizationId, sourceId, snapshotId, state],
  );
  await session.query(
    `insert into public.import_manifest_entries
       (id, organization_id, import_run_id, source_artifact_id, record_index,
        proposed_kind, parsed_json)
     values ($1, $2, $3, $4, 0, 'request', '{}'::jsonb)`,
    [entryId, organizationId, runId, artifactId],
  );
  return { organizationId, runId, entryId };
}

describe.sequential("the frozen import entry guard, under the owner connection", () => {
  /*
   * manifest-i2.md §2.7 and A24: the guard's body is rewritten by the expand
   * migration, and before this case no test fired its refusal at all. So it
   * is pinned here first, under the connection every suite uses today.
   */
  test("refuses to change or delete an entry of an approved run", async () => {
    await inRolledBackTransaction(async (session) => {
      const { entryId } = await seedImportEntry(session, "approved");

      const update = await failure(
        session,
        `update public.import_manifest_entries set decision = 'skip' where id = $1`,
        [entryId],
      );
      expect(update).toMatchObject({
        code: "55000",
        message: "approved import manifest entries are immutable",
      });

      const remove = await failure(
        session,
        `delete from public.import_manifest_entries where id = $1`,
        [entryId],
      );
      expect(remove).toMatchObject({
        code: "55000",
        message: "approved import manifest entries are immutable",
      });
    });
  });

  test("lets an entry of a run still in review change", async () => {
    await inRolledBackTransaction(async (session) => {
      const { entryId } = await seedImportEntry(session, "reviewing");

      const updated = await session.query(
        `update public.import_manifest_entries set decision = 'skip' where id = $1`,
        [entryId],
      );
      expect(updated.rowCount).toBe(1);
    });
  });
});

const APPLICATION = "requestport_application";

/** Arguments are passed as parameters; this only builds a role's name. */
async function probeRoleName(session: TestSession, suffix: string) {
  const { rows } = await session.query<{ name: string }>(
    "select left(current_database(), 40) || $1 as name",
    [suffix],
  );
  return (rows[0] as { name: string }).name;
}

type DefinerFixture = Awaited<ReturnType<typeof seedDefinerFixture>>;

/**
 * One organisation holding a row for every definer lookup: an owner, a
 * project, an agent with an OAuth grant and an API-key credential, an
 * operator credential under the operator key configuration (and a second one
 * bound to the agent's key, whose configuration is not the operator's), a Slack
 * installation with a mapped user, a question, an action token and an OAuth
 * state, an e-mail delivery, an invitation and an allowlist entry. Seeded as
 * the superuser with triggers off (the signup guard would refuse the owner),
 * and with every id consistent, so no foreign key is left dangling.
 */
async function seedDefinerFixture(session: TestSession) {
  const tag = randomUUID().slice(0, 8);
  const fixture = {
    organizationId: randomUUID(),
    userId: `rls-owner-${tag}`,
    secondUserId: `rls-second-${tag}`,
    projectId: randomUUID(),
    principalId: randomUUID(),
    clientId: `rls-client-${tag}`,
    grantId: randomUUID(),
    refreshFamilyId: `rls-family-${tag}`,
    apiKeyId: `rls-key-${tag}`,
    credentialId: randomUUID(),
    credentialFingerprint: `rls-fingerprint-${tag}`,
    operatorApiKeyId: `rls-operator-key-${tag}`,
    operatorCredentialId: randomUUID(),
    operatorFingerprint: `rls-operator-fingerprint-${tag}`,
    misconfiguredOperatorCredentialId: randomUUID(),
    installationId: randomUUID(),
    workspaceId: `T${tag}`,
    slackUserId: `U${tag}`,
    questionId: randomUUID(),
    tokenId: randomUUID(),
    tokenHash: `rls-token-${tag}`,
    stateHash: `rls-state-${tag}`,
    intentId: randomUUID(),
    providerMessageId: `rls-message-${tag}`,
    invitationId: randomUUID(),
    invitedEmail: `rls-invitee-${tag}@example.test`,
    allowedEmail: `rls-allowed-${tag}@example.test`,
    slug: `rls-${tag}`,
  };
  const f = fixture;
  const future = "clock_timestamp() + interval '1 day'";

  await session.query("SET LOCAL session_replication_role = replica");
  const rows: [string, unknown[]][] = [
    [
      `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active')`,
      [f.organizationId, f.slug],
    ],
    [
      `insert into public."user" (id, name, email) values ($1, 'Owner', $2), ($3, 'Second', $4)`,
      [
        f.userId,
        `${f.userId}@example.test`,
        f.secondUserId,
        `${f.secondUserId}@example.test`,
      ],
    ],
    [
      `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
      [f.organizationId, f.userId],
    ],
    [
      `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'P', 'p', 'P', 'active')`,
      [f.projectId, f.organizationId],
    ],
    [
      `insert into public.oauth_client (id, client_id, redirect_uris, disabled) values ($1, $1, '{https://client.example.test/callback}', false)`,
      [f.clientId],
    ],
    [
      `insert into public.oauth_consent (id, client_id, user_id, scopes) values ($1, $2, $3, '{mcp}')`,
      [`consent-${f.slug}`, f.clientId, f.userId],
    ],
    [
      `insert into public.agent_principals (id, organization_id, display_name, slug, status, created_by_user_id) values ($1, $2, 'Agent', $3, 'active', $4)`,
      [f.principalId, f.organizationId, f.slug, f.userId],
    ],
    [
      `insert into public.agent_oauth_grants (id, organization_id, agent_principal_id, user_id, oauth_client_id, provider_grant_id, refresh_family_id, audience, project_id, lane_ids, scopes, status, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'mcp', $8, '[]', '["requests:read"]', 'active', ${future})`,
      [
        f.grantId,
        f.organizationId,
        f.principalId,
        f.userId,
        f.clientId,
        `consent-${f.slug}`,
        f.refreshFamilyId,
        f.projectId,
      ],
    ],
    [
      `insert into public.apikey (id, reference_id, key, enabled, expires_at, created_at, updated_at) values ($1, $2, 'hashed', true, ${future}, now(), now())`,
      [f.apiKeyId, f.userId],
    ],
    [
      `insert into public.agent_credentials (id, organization_id, agent_principal_id, better_auth_api_key_id, name, prefix, fingerprint, audience, project_id, lane_ids, scopes, expires_at, created_by_user_id)
       values ($1, $2, $3, $4, 'key', 'rp_', $5, 'api', $6, '[]', '["requests:read"]', ${future}, $7)`,
      [
        f.credentialId,
        f.organizationId,
        f.principalId,
        f.apiKeyId,
        f.credentialFingerprint,
        f.projectId,
        f.userId,
      ],
    ],
    [
      // The configuration id the migration's lookup names as a literal.
      `insert into public.apikey (id, reference_id, key, enabled, expires_at, config_id, created_at, updated_at) values ($1, $2, 'hashed', true, ${future}, $3, now(), now())`,
      [f.operatorApiKeyId, f.userId, operatorApiKeyConfigId],
    ],
    [
      `insert into public.operator_credentials (id, organization_id, member_user_id, project_id, better_auth_api_key_id, lineage_id, name, prefix, fingerprint, scopes, expires_at)
       values ($1, $2, $3, null, $4, $1, 'operator', 'rpo_', $5, '["requests:read"]', ${future}),
              ($6, $2, $3, null, $7, $6, 'misconfigured', 'rpo_', $8, '["requests:read"]', ${future})`,
      [
        f.operatorCredentialId,
        f.organizationId,
        f.userId,
        f.operatorApiKeyId,
        f.operatorFingerprint,
        f.misconfiguredOperatorCredentialId,
        f.apiKeyId,
        `${f.operatorFingerprint}-misconfigured`,
      ],
    ],
    [
      // A well-formed envelope, which the modal's installation read parses.
      `insert into public.slack_installations (id, organization_id, workspace_id, workspace_name, bot_token_ciphertext, bot_user_id, status, installed_by_user_id)
       values ($1, $2, $3, 'Workspace', '{"ciphertext":"AA","nonce":"AA","wrappedDek":"AA","kekVersion":"v1"}', 'B1', 'active', $4)`,
      [f.installationId, f.organizationId, f.workspaceId, f.userId],
    ],
    [
      `insert into public.slack_user_mappings (organization_id, installation_id, slack_user_id, user_id, status, verified_at) values ($1, $2, $3, $4, 'active', now())`,
      [f.organizationId, f.installationId, f.slackUserId, f.userId],
    ],
    [
      `insert into public.questions (id, organization_id, subject_type, subject_id, audience_type, body_md, answer_mode, allow_free_text, state, asked_by_type, asked_by_id)
       values ($1, $2, 'evaluation_run', $1, 'requester', 'Which?', 'single', true, 'open', 'user', $3)`,
      [f.questionId, f.organizationId, f.userId],
    ],
    [
      `insert into public.slack_action_tokens (id, organization_id, question_id, installation_id, token_type, token_hash, expires_at) values ($1, $2, $3, $4, 'answer', $5, ${future})`,
      [
        f.tokenId,
        f.organizationId,
        f.questionId,
        f.installationId,
        f.tokenHash,
      ],
    ],
    [
      `insert into public.slack_oauth_states (organization_id, user_id, state_hash, redirect_uri, expires_at) values ($1, $2, $3, 'https://app.example.test/slack', ${future})`,
      [f.organizationId, f.userId, f.stateHash],
    ],
    [
      `insert into public.notification_intents (id, organization_id, channel, recipient_ref, template, dedupe_key, view_model, status) values ($1, $2, 'email', 'owner', 'question', $3, '{}', 'pending')`,
      [f.intentId, f.organizationId, `dedupe-${f.slug}`],
    ],
    [
      `insert into public.email_deliveries (organization_id, notification_intent_id, provider_message_id, idempotency_key, status) values ($1, $2, $3, $3, 'sent')`,
      [f.organizationId, f.intentId, f.providerMessageId],
    ],
    [
      `insert into public.invitations (id, organization_id, normalized_email, role, token_hash, expires_at, created_by_user_id) values ($1, $2, $3, 'member', $4, ${future}, $5)`,
      [
        f.invitationId,
        f.organizationId,
        f.invitedEmail,
        `invitation-${f.slug}`,
        f.userId,
      ],
    ],
    [
      `insert into public.signup_allowlist (normalized_email, status) values ($1, 'active')`,
      [f.allowedEmail],
    ],
  ];
  for (const [text, values] of rows) await session.query(text, values);
  await session.query("SET LOCAL session_replication_role = origin");
  return fixture;
}

/**
 * The owner-shaped role (§2.9): a stand-in for production's owner, the
 * migrating role, holding a subset of what it holds. It is a BYPASSRLS
 * non-superuser that owns nothing, granted every table privilege and USAGE
 * on both schemas (the owner has these by owning them), exactly the EXECUTE
 * the migrating role holds in requestport_private by its own entries, copied
 * from the functions' ACLs rather than assumed, and the migrating role's one
 * inheriting membership: requestport_definer, WITH INHERIT TRUE, SET TRUE, as
 * 0019 grants it and as production's owner holds it (ruling 215 items 2 and
 * 3). Without that membership the probe would be refused a function whose
 * owner's own entry production's owner still inherits, a refusal production
 * would not have. Production's owner holds more: it owns the tables, schemas
 * and binding readers, and holds ADMIN, without INHERIT or SET, on the groups
 * (PostgreSQL 16's automatic grant to a CREATEROLE creator). So what this
 * probe can do, production's owner can too; the reverse is not tested here.
 * The local role is a superuser, which passes every privilege check, so it
 * cannot stand in for this.
 */
async function becomeOwnerShaped(session: TestSession) {
  const role = await probeRoleName(session, "_owner_probe");
  await session.query(
    `select pg_catalog.set_config('requestport.test_probe_role', $1, true)`,
    [role],
  );
  await session.query(`
    do $$
    declare
      probe text := current_setting('requestport.test_probe_role');
      fn regprocedure;
    begin
      execute format('create role %I nologin nosuperuser bypassrls', probe);
      execute format('grant usage on schema public, requestport_private to %I', probe);
      execute format('grant all on all tables in schema public to %I', probe);
      for fn in
        select p.oid::regprocedure
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
        pg_catalog.aclexplode(p.proacl) a
        where n.nspname = 'requestport_private'
          and a.grantee = (select oid from pg_catalog.pg_roles where rolname = current_user)
          and a.privilege_type = 'EXECUTE'
      loop
        execute format('grant execute on function %s to %I', fn, probe);
      end loop;
      execute format('grant requestport_definer to %I with inherit true, set true', probe);
    end $$`);
  const { rows } = await session.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    memberships: string;
    owns: string;
  }>(
    `select r.rolsuper, r.rolbypassrls,
       (select count(*) from pg_catalog.pg_auth_members m where m.member = r.oid)::text as memberships,
       (select count(*) from pg_catalog.pg_class c where c.relowner = r.oid)::text as owns
     from pg_catalog.pg_roles r where r.rolname = $1`,
    [role],
  );
  expect(rows[0]).toEqual({
    rolsuper: false,
    rolbypassrls: true,
    memberships: "1",
    owns: "0",
  });
  await session.query(`SET LOCAL ROLE "${role}"`);
  return role;
}

async function bind(
  session: TestSession,
  binding: { organizationId?: string; userId?: string },
) {
  await session.query(
    `select pg_catalog.set_config('requestport.organization_id', $1, true),
            pg_catalog.set_config('requestport.user_id', $2, true)`,
    [binding.organizationId ?? "", binding.userId ?? ""],
  );
}

const columns = (rows: Record<string, unknown>[]) =>
  rows.length === 0 ? [] : Object.keys(rows[0] as object);

/**
 * Calls every definer lookup once with a right input and once with a wrong
 * one, as whoever the session now is. Its reads of what a call wrote are of a
 * global table, and of email_deliveries bound to the fixture's organisation,
 * so a role under the policies reads them too.
 */
async function callEveryDefinerLookup(session: TestSession, f: DefinerFixture) {
  const call = (text: string, values: unknown[]) =>
    session.query<Record<string, unknown>>(text, values);

  const grant = await call(
    "select * from requestport_private.resolve_oauth_grant($1, $2, $3)",
    [f.userId, f.clientId, "mcp"],
  );
  expect(columns(grant.rows)).toEqual([
    "authorization_id",
    "organization_id",
    "agent_principal_id",
    "delegated_by_user_id",
    "audience",
    "project_id",
    "lane_ids",
    "scopes",
    "refresh_family_id",
  ]);
  expect(grant.rows).toEqual([
    {
      authorization_id: f.grantId,
      organization_id: f.organizationId,
      agent_principal_id: f.principalId,
      delegated_by_user_id: f.userId,
      audience: "mcp",
      project_id: f.projectId,
      lane_ids: [],
      scopes: ["requests:read"],
      refresh_family_id: f.refreshFamilyId,
    },
  ]);
  for (const audience of ["api", "MCP", "", null]) {
    const wrong = await call(
      "select * from requestport_private.resolve_oauth_grant($1, $2, $3)",
      [f.userId, f.clientId, audience],
    );
    expect(wrong.rows, String(audience)).toEqual([]);
  }

  const families = await call(
    "select * from requestport_private.list_oauth_grant_binding_fingerprints($1, $2)",
    [f.userId, "mcp"],
  );
  expect(families.rows).toEqual([
    { client_id: f.clientId, refresh_family_id: f.refreshFamilyId },
  ]);
  expect(
    (
      await call(
        "select * from requestport_private.list_oauth_grant_binding_fingerprints($1, $2)",
        [f.secondUserId, "mcp"],
      )
    ).rows,
  ).toEqual([]);

  const usable = await call(
    "select requestport_private.has_usable_oauth_grant($1, $2) as usable",
    [f.userId, f.clientId],
  );
  expect(usable.rows).toEqual([{ usable: true }]);
  expect(
    (
      await call(
        "select requestport_private.has_usable_oauth_grant($1, $2) as usable",
        [f.secondUserId, f.clientId],
      )
    ).rows,
  ).toEqual([{ usable: false }]);

  const credential = await call(
    "select * from requestport_private.resolve_api_key_credential($1, $2)",
    [f.apiKeyId, "api"],
  );
  expect(credential.rows).toEqual([
    {
      authorization_id: f.credentialId,
      organization_id: f.organizationId,
      agent_principal_id: f.principalId,
      audience: "api",
      project_id: f.projectId,
      lane_ids: [],
      scopes: ["requests:read"],
      credential_fingerprint: f.credentialFingerprint,
    },
  ]);
  expect(
    (
      await call(
        "select * from requestport_private.resolve_api_key_credential($1, $2)",
        [f.apiKeyId, "mcp"],
      )
    ).rows,
  ).toEqual([]);

  const operator = await call(
    "select * from requestport_private.resolve_operator_credential($1)",
    [f.operatorApiKeyId],
  );
  expect(columns(operator.rows)).toEqual([
    "credential_id",
    "lineage_id",
    "organization_id",
    "member_user_id",
    "project_id",
    "scopes",
    "credential_fingerprint",
  ]);
  expect(operator.rows).toEqual([
    {
      credential_id: f.operatorCredentialId,
      lineage_id: f.operatorCredentialId,
      organization_id: f.organizationId,
      member_user_id: f.userId,
      project_id: null,
      scopes: ["requests:read"],
      credential_fingerprint: f.operatorFingerprint,
    },
  ]);
  // The agent's key has an operator binding too, but its plugin row is in the
  // default configuration, not the operator's, so it resolves nothing.
  for (const key of [f.apiKeyId, "", null]) {
    const wrong = await call(
      "select * from requestport_private.resolve_operator_credential($1)",
      [key],
    );
    expect(wrong.rows, String(key)).toEqual([]);
  }

  const token = await call(
    "select * from requestport_private.lock_slack_action_token($1, $2, $3, $4)",
    [f.tokenHash, "answer", f.workspaceId, f.slackUserId],
  );
  expect(token.rows).toEqual([
    {
      token_id: f.tokenId,
      organization_id: f.organizationId,
      question_id: f.questionId,
      installation_id: f.installationId,
      action_payload: {},
      answer_id: null,
      consumed_at: null,
      consumed_by_user_id: null,
      slack_user_id: null,
      user_id: f.userId,
      question_version: 1,
    },
  ]);
  for (const type of ["modal_launch", "answer ", "unlisted", null]) {
    const wrong = await call(
      "select * from requestport_private.lock_slack_action_token($1, $2, $3, $4)",
      [f.tokenHash, type, f.workspaceId, f.slackUserId],
    );
    expect(wrong.rows, String(type)).toEqual([]);
  }

  const state = await call(
    "select * from requestport_private.consume_slack_oauth_state($1)",
    [f.stateHash],
  );
  expect(state.rows).toEqual([
    {
      organization_id: f.organizationId,
      user_id: f.userId,
      redirect_uri: "https://app.example.test/slack",
    },
  ]);
  // Consumed: the same state is not handed out twice.
  expect(
    (
      await call(
        "select * from requestport_private.consume_slack_oauth_state($1)",
        [f.stateHash],
      )
    ).rows,
  ).toEqual([]);

  // The digest is computed in SQL; it must be the one Node computes over the
  // same UTF-8 string, or a replayed callback would read as a conflict.
  const body = '{"type":"email.delivered","note":"héllo ✓"}';
  const event = `evt-${f.slug}`;
  const occurred = new Date();
  const record = (raw: string, status: string) =>
    call(
      "select requestport_private.record_provider_callback($1, $2, $3, $4, $5, $6) as outcome",
      ["resend", event, raw, occurred, f.providerMessageId, status],
    );
  expect((await record(body, "delivered")).rows).toEqual([
    { outcome: "processed" },
  ]);
  const receipt = await call(
    "select body_sha256, outcome from public.provider_callback_receipts where provider = 'resend' and provider_event_id = $1",
    [event],
  );
  expect(receipt.rows).toEqual([
    {
      body_sha256: createHash("sha256").update(body).digest("hex"),
      outcome: "processed",
    },
  ]);
  await bind(session, { organizationId: f.organizationId });
  const delivery = await call(
    "select status from public.email_deliveries where provider_message_id = $1",
    [f.providerMessageId],
  );
  expect(delivery.rows).toEqual([{ status: "delivered" }]);
  await bind(session, {});
  expect((await record(body, "delivered")).rows).toEqual([
    { outcome: "duplicate" },
  ]);
  expect((await record(`${body} `, "delivered")).rows).toEqual([
    { outcome: "conflict" },
  ]);

  const invitations = await call(
    "select * from requestport_private.invitation_eligibility($1)",
    [f.invitedEmail],
  );
  expect(columns(invitations.rows)).toEqual([
    "invitation_id",
    "accepted_at",
    "revoked_at",
    "expires_at",
  ]);
  expect(invitations.rows.map((row) => row.invitation_id)).toEqual([
    f.invitationId,
  ]);
  expect(
    (
      await call(
        "select * from requestport_private.invitation_eligibility($1)",
        [f.allowedEmail],
      )
    ).rows,
  ).toEqual([]);

  const allowlist = await call(
    "select * from requestport_private.signup_allowlist_eligibility($1)",
    [f.allowedEmail],
  );
  expect(allowlist.rows).toEqual([{ status: "active", expires_at: null }]);
  expect(
    (
      await call(
        "select * from requestport_private.signup_allowlist_eligibility($1)",
        [f.invitedEmail],
      )
    ).rows,
  ).toEqual([]);

  await bind(session, { userId: f.userId });
  const memberships = await call(
    "select * from requestport_private.active_memberships()",
    [],
  );
  expect(memberships.rows).toEqual([
    {
      organization_id: f.organizationId,
      organization_name: f.slug,
      organization_slug: f.slug,
      role: "owner",
    },
  ]);
  await bind(session, { organizationId: f.organizationId, userId: f.userId });
  expect(
    await failure(
      session,
      "select * from requestport_private.active_memberships()",
    ),
  ).toMatchObject({ code: "42501" });
  await bind(session, {});
  expect(
    await failure(
      session,
      "select * from requestport_private.active_memberships()",
    ),
  ).toMatchObject({ code: "42501" });

  // Last, because it spends the grant the lookups above read.
  await call(
    "select requestport_private.revoke_user_client_oauth_grants($1, $2)",
    [f.userId, f.clientId],
  );
  expect(
    (
      await call(
        "select requestport_private.has_usable_oauth_grant($1, $2) as usable",
        [f.userId, f.clientId],
      )
    ).rows,
  ).toEqual([{ usable: false }]);
}

/** §2.7's three trigger paths, run as whoever the session now is. */
async function fireEveryTriggerPath(
  session: TestSession,
  f: DefinerFixture,
  entryId: string,
) {
  // An invited sign-up activates its membership. The address is written in
  // mixed case: the guard lowers it before comparing (§2.5.0 item 2).
  const invitee = `rls-invitee-user-${f.slug}`;
  await session.query(
    `insert into public."user" (id, name, email) values ($1, 'Invitee', $2)`,
    [invitee, f.invitedEmail.toUpperCase()],
  );
  // An owner membership becoming active seeds the organisation's appearance.
  await session.query(
    `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
    [f.organizationId, f.secondUserId],
  );
  // A frozen import entry still refuses change.
  expect(
    await failure(
      session,
      `update public.import_manifest_entries set decision = 'skip' where id = $1`,
      [entryId],
    ),
  ).toMatchObject({
    code: "55000",
    message: "approved import manifest entries are immutable",
  });

  const { rows } = await session.query<{
    membership: string | null;
    accepted: boolean;
    defaults: string;
    events: string;
    outbox: string;
  }>(
    `select
       (select m.role || '/' || m.status from public.organization_members m
         where m.organization_id = $1 and m.user_id = $2) as membership,
       (select i.accepted_at is not null from public.invitations i where i.id = $3) as accepted,
       (select count(*) from public.organization_appearance_defaults d
         where d.organization_id = $1)::text as defaults,
       (select count(*) from public.domain_events e
         where e.organization_id = $1
           and e.type = 'appearance.organization_defaults_initialized.v1')::text as events,
       (select count(*) from public.outbox o
         join public.domain_events e on e.id = o.event_id
         where e.organization_id = $1)::text as outbox`,
    [f.organizationId, invitee, f.invitationId],
  );
  expect(rows[0]).toEqual({
    membership: "member/active",
    accepted: true,
    defaults: "1",
    events: "1",
    outbox: "1",
  });
}

/**
 * The fourteen functions that 0019 and 0021 granted the migrating role until
 * step 5, and that step 5's contract migration revokes from it and from
 * their owner: each called with arguments of its signature, and the groups
 * that keep EXECUTE on it.
 */
const CONTRACT_FUNCTIONS: readonly {
  name: string;
  call: string;
  groups: readonly string[];
}[] = [
  ...(
    [
      ["resolve_oauth_grant", "('u', 'c', 'mcp')"],
      ["list_oauth_grant_binding_fingerprints", "('u', 'mcp')"],
      ["has_usable_oauth_grant", "('u', 'c')"],
      ["revoke_user_client_oauth_grants", "('u', 'c')"],
      ["resolve_api_key_credential", "('k', 'api')"],
      ["resolve_operator_credential", "('k')"],
      ["consume_slack_oauth_state", "('s')"],
      ["lock_slack_action_token", "('t', 'answer', 'w', 'u')"],
      [
        "record_provider_callback",
        "('resend', 'e', '{}', now(), 'm', 'delivered')",
      ],
      ["invitation_eligibility", "('a@example.invalid')"],
      ["signup_allowlist_eligibility", "('a@example.invalid')"],
      ["active_memberships", "()"],
    ] as const
  ).map(([name, args]) => ({
    name,
    call: `select * from requestport_private.${name}${args}`,
    groups: [APPLICATION],
  })),
  ...(["lock_live_api_key", "lock_live_oauth_client"] as const).map((name) => ({
    name,
    call: `select requestport_private.${name}('k')`,
    groups: ["requestport_tenant_processor", APPLICATION],
  })),
];

/**
 * The contract migration's last statement, its postcondition, read from the
 * file whatever number it carries.
 */
function contractPostcondition(): string {
  const folder = new URL("../migrations/", import.meta.url);
  const names = readdirSync(folder).filter((name) =>
    name.endsWith("_row_security_contract.sql"),
  );
  expect(names).toHaveLength(1);
  const chunks = readFileSync(new URL(names[0] as string, folder), "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim());
  const check = chunks.at(-1) ?? "";
  expect(check).toMatch(/^-- The postcondition\.[\s\S]*\nEND \$\$;$/u);
  return check;
}

describe.sequential("every definer lookup, called directly as the application group (§2.5.0 items 5 and 6)", () => {
  test("answers for a right input and nothing for a wrong one", async () => {
    await inRolledBackTransaction(async (session) => {
      const fixture = await seedDefinerFixture(session);
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);

      await callEveryDefinerLookup(session, fixture);
    });
  });
});

describe.sequential("the owner-shaped lane (manifest §2.9)", () => {
  test("is refused each of the fourteen functions step 5's contract revoked, by its own entries and its membership in requestport_definer alike, while their groups keep them (42501)", async () => {
    await inRolledBackTransaction(async (session) => {
      const role = await becomeOwnerShaped(session);

      for (const fn of CONTRACT_FUNCTIONS) {
        expect(await failure(session, fn.call), fn.name).toMatchObject({
          code: "42501",
          message: `permission denied for function ${fn.name}`,
        });
      }

      await session.query("RESET ROLE");
      const { rows } = await session.query<{
        name: string;
        owner: boolean;
        application: boolean;
        processor: boolean;
      }>(
        `select p.proname as name,
           pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') as owner,
           pg_catalog.has_function_privilege('requestport_application', p.oid, 'EXECUTE') as application,
           pg_catalog.has_function_privilege('requestport_tenant_processor', p.oid, 'EXECUTE') as processor
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'requestport_private' and p.proname = any($2)`,
        [role, CONTRACT_FUNCTIONS.map((fn) => fn.name)],
      );
      expect(
        Object.fromEntries(rows.map(({ name, ...allowed }) => [name, allowed])),
      ).toEqual(
        Object.fromEntries(
          CONTRACT_FUNCTIONS.map((fn) => [
            fn.name,
            {
              owner: false,
              application: true,
              processor: fn.groups.includes("requestport_tenant_processor"),
            },
          ]),
        ),
      );
    });
  });

  /*
   * The contract's postcondition, run as this role, which stands where the
   * migrating role does. It passes for the role as production's owner holds
   * the application group (ADMIN alone, ruling 215 item 2), and refuses it
   * once it inherits that group, which is what a server whose
   * createrole_self_grant includes inherit gives a role creating the group
   * (ruling 215 item 10).
   */
  test("the contract's postcondition passes for this role, and refuses it once it inherits the application group", async () => {
    const check = contractPostcondition();
    await inRolledBackTransaction(async (session) => {
      const role = await becomeOwnerShaped(session);
      await session.query("RESET ROLE");
      await session.query(
        `grant ${APPLICATION} to "${role}" with admin true, inherit false, set false`,
      );
      await session.query(`SET LOCAL ROLE "${role}"`);

      await session.query(check);

      await session.query("RESET ROLE");
      await session.query(
        `grant ${APPLICATION} to "${role}" with inherit true`,
      );
      await session.query(`SET LOCAL ROLE "${role}"`);
      expect(await failure(session, check)).toMatchObject({
        code: "P0001",
        message: `requestport: the migrating role ${role} can still execute requestport_private.resolve_oauth_grant(text,text,text), through an inheriting membership in one of {requestport_application}. A server whose createrole_self_grant includes inherit gives a role that is not a superuser such a membership in each role it creates: take the inherit option off it, or migrate as a role without one.`,
      });
    });
  });

  // The postcondition's other three refusals, each against a catalogue
  // changed in a transaction that is rolled back. None alters an existing
  // table: the probe table is made here, and a grant takes no table lock.
  test.each([
    [
      "an owner's entry on a lookup",
      "grant execute on function requestport_private.resolve_operator_credential(text) to requestport_definer",
      "requestport: requestport_private.resolve_operator_credential(text) is executable by ",
    ],
    [
      "a tenant table left unforced",
      "create table public.rp_contract_probe (id uuid primary key, organization_id uuid not null); alter table public.rp_contract_probe enable row level security; create policy requestport_tenant on public.rp_contract_probe using (organization_id = (select requestport_private.bound_organization_id()))",
      "requestport: tenant tables with row security not forced: rp_contract_probe",
    ],
    [
      "the application group's SELECT on signup_allowlist",
      "grant select on public.signup_allowlist to requestport_application",
      "requestport: requestport_application can still read public.signup_allowlist directly",
    ],
  ])(
    "the contract's postcondition refuses %s",
    async (_name, change, expected) => {
      const check = contractPostcondition();
      await inRolledBackTransaction(async (session) => {
        await session.query(check);
        await session.query(change);

        const { message } = await failure(session, check);
        expect(message?.slice(0, expected.length)).toBe(expected);
      });
    },
  );

  /*
   * F.3's revocation by issuer (F3-13, F3-15) stays on the owner, guarded by
   * row_security_active. With operator_credentials now under a policy, the
   * guard must still let the owner's kind of role through, and still refuse a
   * role the policy applies to, before it writes anything.
   */
  test("revokes by issuer as that role, and refuses under the application role (F3-15)", async () => {
    await inRolledBackTransaction(async (session) => {
      const f = await seedDefinerFixture(session);
      const actor = { actorType: "system" as const, actorId: "rls-bootstrap" };
      const revoked = () =>
        session.query<{ id: string; revoked: boolean }>(
          `select id, revoked_at is not null as revoked
           from public.operator_credentials
           where member_user_id = $1 order by id`,
          [f.userId],
        );
      const active = () =>
        session.query<{ active: boolean }>(
          "select row_security_active('public.operator_credentials') as active",
        );

      await session.query(`SET LOCAL ROLE ${APPLICATION}`);
      await bind(session, {
        organizationId: f.organizationId,
        userId: f.userId,
      });
      expect((await active()).rows).toEqual([{ active: true }]);
      await expect(
        revokeOperatorCredentialsIssuedBy(session.db, {
          userId: f.userId,
          actor,
          correlationId: `rls-refused-${f.slug}`,
        }),
      ).rejects.toMatchObject({ code: "configuration_error" });
      await session.query("RESET ROLE");
      expect((await revoked()).rows.map((row) => row.revoked)).toEqual([
        false,
        false,
      ]);

      await bind(session, {});
      await becomeOwnerShaped(session);
      expect((await active()).rows).toEqual([{ active: false }]);
      await expect(
        revokeOperatorCredentialsIssuedBy(session.db, {
          userId: f.userId,
          actor,
          correlationId: `rls-owner-${f.slug}`,
        }),
      ).resolves.toBe(2);
      expect((await revoked()).rows.map((row) => row.revoked)).toEqual([
        true,
        true,
      ]);
    });
  });

  test("fires the three trigger paths as that role", async () => {
    await inRolledBackTransaction(async (session) => {
      const fixture = await seedDefinerFixture(session);
      const { entryId } = await seedImportEntry(session, "approved");
      await becomeOwnerShaped(session);

      await fireEveryTriggerPath(session, fixture, entryId);
    });
  });
});

describe.sequential("the trigger paths under the application role (manifest §2.7)", () => {
  test("an invited sign-up activates, an owner activation seeds appearance, a frozen entry refuses", async () => {
    await inRolledBackTransaction(async (session) => {
      const fixture = await seedDefinerFixture(session);
      const entry = await seedImportEntry(session, "approved");
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);
      // Bound to the entry's own organisation, so the policy admits the row
      // and the refusal is the trigger's.
      await bind(session, {
        organizationId: entry.organizationId,
        userId: fixture.userId,
      });
      expect(
        await failure(
          session,
          `update public.import_manifest_entries set decision = 'skip' where id = $1`,
          [entry.entryId],
        ),
      ).toMatchObject({ code: "55000" });

      // Better Auth inserts the user before any organisation is known, so
      // the sign-up runs with nothing bound; as an invoker the guard would
      // read no invitation, or raise on the unbound policy.
      await bind(session, {});
      const invitee = `rls-app-invitee-${fixture.slug}`;
      await session.query(
        `insert into public."user" (id, name, email) values ($1, 'Invitee', $2)`,
        [invitee, fixture.invitedEmail],
      );
      await bind(session, {
        organizationId: fixture.organizationId,
        userId: fixture.userId,
      });
      await session.query(
        `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
        [fixture.organizationId, fixture.secondUserId],
      );
      const { rows } = await session.query<{
        membership: string | null;
        defaults: string;
      }>(
        `select
           (select m.role || '/' || m.status from public.organization_members m
             where m.organization_id = $1 and m.user_id = $2) as membership,
           (select count(*) from public.organization_appearance_defaults d
             where d.organization_id = $1)::text as defaults`,
        [fixture.organizationId, invitee],
      );
      expect(rows[0]).toEqual({ membership: "member/active", defaults: "1" });
    });
  });
});

class LaneRollback extends Error {}

/**
 * Seeds the definer fixture and takes on `role` inside one Drizzle
 * transaction on one session, hands that transaction to `work`, and rolls
 * everything back. The seed runs through the session's own client, which is
 * the connection the transaction holds.
 */
async function asRoleInTransaction(
  role: "owner-shaped" | "application",
  work: (
    tx: Tx,
    fixture: DefinerFixture,
    session: TestSession,
  ) => Promise<void>,
) {
  const session = await openSession(suiteStorage);
  try {
    await expect(
      session.db.transaction(async (tx) => {
        const fixture = await seedDefinerFixture(session);
        if (role === "owner-shaped") await becomeOwnerShaped(session);
        else await session.query(`SET LOCAL ROLE ${APPLICATION}`);
        await work(tx, fixture, session);
        throw new LaneRollback();
      }),
    ).rejects.toBeInstanceOf(LaneRollback);
  } finally {
    session.release();
  }
}

/**
 * Runs `work` as the session's login (the superuser), then takes back the
 * role the case was acting as.
 */
async function asSessionLogin(session: TestSession, work: () => Promise<void>) {
  const { rows } = await session.query<{ role: string }>(
    "select current_user as role",
  );
  const role = (rows[0] as { role: string }).role;
  await session.query("RESET ROLE");
  await work();
  await session.query(`SET LOCAL ROLE "${role}"`);
}

async function boundOrganization(tx: Tx) {
  const { rows } = await tx.execute(
    sql`select nullif(current_setting('requestport.organization_id', true), '') as organization_id`,
  );
  return (rows[0] as { organization_id: string | null }).organization_id;
}

const bindingFingerprint = (clientId: string, family: string) =>
  createHash("sha256")
    .update(clientId)
    .update("\0")
    .update(family)
    .digest("base64url");

/*
 * Since step 5's contract only the application group executes the definer
 * functions these methods call. The owner-shaped role is refused each, which
 * the describe after the next one shows.
 */
describe.sequential.each(["application"] as const)(
  "the definer-calling repository methods, as the %s role with nothing bound (§2.5, Done when 8)",
  (role) => {
    test("the credential and identity lookups answer for a right input, and nothing for a wrong one", async () => {
      await asRoleInTransaction(role, async (tx, f) => {
        const auth = createAgentAuthRepository(tx);

        expect(
          await auth.resolveOAuthGrant({
            userId: f.userId,
            clientId: f.clientId,
            audience: "mcp",
          }),
        ).toEqual({
          authorizationId: f.grantId,
          organizationId: f.organizationId,
          agentPrincipalId: f.principalId,
          delegatedByUserId: f.userId,
          audience: "mcp",
          projectId: f.projectId,
          laneIds: [],
          scopes: ["requests:read"],
          credentialFingerprint: `oauth:${f.grantId}:${f.refreshFamilyId}`,
          oauthTokenBindingFingerprint: bindingFingerprint(
            f.clientId,
            f.refreshFamilyId,
          ),
        });
        expect(
          await auth.resolveOAuthGrant({
            userId: f.userId,
            clientId: f.clientId,
            audience: "api",
          }),
        ).toBeNull();

        expect(
          await auth.listOAuthGrantBindingFingerprints({
            userId: f.userId,
            audience: "mcp",
          }),
        ).toEqual({
          fingerprints: [bindingFingerprint(f.clientId, f.refreshFamilyId)],
          truncated: false,
        });
        expect(
          await auth.listOAuthGrantBindingFingerprints({
            userId: f.secondUserId,
            audience: "mcp",
          }),
        ).toEqual({ fingerprints: [], truncated: false });

        expect(
          await auth.resolveApiKeyCredential({
            apiKeyId: f.apiKeyId,
            audience: "api",
          }),
        ).toEqual({
          authorizationId: f.credentialId,
          organizationId: f.organizationId,
          agentPrincipalId: f.principalId,
          delegatedByUserId: null,
          audience: "api",
          projectId: f.projectId,
          laneIds: [],
          scopes: ["requests:read"],
          credentialFingerprint: f.credentialFingerprint,
        });
        expect(
          await auth.resolveApiKeyCredential({
            apiKeyId: f.apiKeyId,
            audience: "mcp",
          }),
        ).toBeNull();

        // A usable grant exists, so the repair leaves the consent alone.
        await auth.invalidateUnboundOAuthProviderAuthorization({
          userId: f.userId,
          clientId: f.clientId,
        });
        const consent = await tx.execute(
          sql`select scopes from public.oauth_consent where client_id = ${f.clientId} and user_id = ${f.userId}`,
        );
        expect(consent.rows).toEqual([{ scopes: ["mcp"] }]);

        const eligibility = createSignupEligibilityRepository(tx);
        const invitations = await eligibility.findInvitations(f.invitedEmail);
        expect(invitations).toEqual([
          {
            id: f.invitationId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: expect.any(Date),
          },
        ]);
        expect(await eligibility.findInvitations(f.allowedEmail)).toEqual([]);
        expect(await eligibility.findAllowlistEntries(f.allowedEmail)).toEqual([
          { status: "active", expiresAt: null },
        ]);
        expect(await eligibility.findAllowlistEntries(f.invitedEmail)).toEqual(
          [],
        );

        // Nothing above bound the transaction.
        expect(await boundOrganization(tx)).toBeNull();
      });
    });

    test("F.3's operator key lookup answers for a right key, and nothing for a wrong one (R2)", async () => {
      await asRoleInTransaction(role, async (tx, f) => {
        const operators = createOperatorCredentialRepository(tx);

        expect(
          await operators.resolveApiKeyCredential({
            apiKeyId: f.operatorApiKeyId,
          }),
        ).toEqual({
          credentialId: f.operatorCredentialId,
          lineageId: f.operatorCredentialId,
          organizationId: f.organizationId,
          memberUserId: f.userId,
          projectId: null,
          scopes: ["requests:read"],
          credentialFingerprint: f.operatorFingerprint,
        });
        // The agent's key has an operator binding too, but its plugin row is
        // in the default configuration, not the operator's.
        for (const apiKeyId of [f.apiKeyId, ""]) {
          expect(
            await operators.resolveApiKeyCredential({ apiKeyId }),
            apiKeyId,
          ).toBeNull();
        }
        // Nothing above bound the transaction.
        expect(await boundOrganization(tx)).toBeNull();
      });
    });

    test("the provider callback is recorded, and a replay is a duplicate or a conflict", async () => {
      await asRoleInTransaction(role, async (tx, f) => {
        const notifications = createNotificationRepository(tx);
        const callback = (rawBody: string) =>
          notifications.recordProviderCallback({
            provider: "resend",
            eventId: `evt-repo-${f.slug}`,
            rawBody,
            occurredAt: new Date(),
            providerMessageId: f.providerMessageId,
            status: "delivered",
          });
        const body = '{"type":"email.delivered","note":"héllo ✓"}';

        expect(await callback(body)).toEqual({
          duplicate: false,
          conflict: false,
        });
        expect(await callback(body)).toEqual({
          duplicate: true,
          conflict: false,
        });
        expect(await callback(`${body} `)).toEqual({
          duplicate: true,
          conflict: true,
        });
        expect(await boundOrganization(tx)).toBeNull();
      });
    });

    test("the Slack lookups bind the transaction to the organisation they find (D11)", async () => {
      await asRoleInTransaction(role, async (tx, f) => {
        const slack = createSlackRepository(tx);

        await expect(
          slack.lockActionToken({
            tokenHash: f.tokenHash,
            tokenType: "modal_launch",
            workspaceId: f.workspaceId,
            slackUserId: f.slackUserId,
          }),
        ).rejects.toMatchObject({ code: "forbidden" });
        expect(await boundOrganization(tx)).toBeNull();

        expect(
          await slack.lockActionToken({
            tokenHash: f.tokenHash,
            tokenType: "answer",
            workspaceId: f.workspaceId,
            slackUserId: f.slackUserId,
          }),
        ).toEqual({
          id: f.tokenId,
          organizationId: f.organizationId,
          questionId: f.questionId,
          installationId: f.installationId,
          tokenType: "answer",
          actionPayload: {},
          answerId: null,
          consumedAt: null,
          consumedByUserId: null,
          slackUserId: null,
          userId: f.userId,
          questionVersion: 1,
        });
        expect(await boundOrganization(tx)).toBe(f.organizationId);

        expect(await slack.consumeOauthState(f.stateHash)).toEqual({
          organizationId: f.organizationId,
          userId: f.userId,
          redirectUri: "https://app.example.test/slack",
        });
        // Consumed: the same state is refused the second time.
        await expect(
          slack.consumeOauthState(f.stateHash),
        ).rejects.toMatchObject({
          code: "forbidden",
        });
        expect(await boundOrganization(tx)).toBe(f.organizationId);
      });
    });

    test("a state whose user no longer manages Slack is refused, and stays unconsumed (D11)", async () => {
      await asRoleInTransaction(role, async (tx, f, session) => {
        const { rows } = await session.query<{ role: string }>(
          "select current_user as role",
        );
        const current = rows[0]?.role;
        /** Steps out to the session's superuser for `work`, and back in. */
        const outsideTheRole = async <T>(work: () => Promise<T>) => {
          await session.query("RESET ROLE");
          try {
            return await work();
          } finally {
            await session.query(`SET LOCAL ROLE "${current}"`);
          }
        };
        // Demoted between createOauthState and the provider's callback.
        await outsideTheRole(() =>
          session.query(
            `update public.organization_members set role = 'member'
             where organization_id = $1 and user_id = $2`,
            [f.organizationId, f.userId],
          ),
        );

        await expect(
          createSlackRepository(tx).consumeOauthState(f.stateHash),
        ).rejects.toMatchObject({ code: "forbidden" });

        // The savepoint rolled back the function's consumption and the
        // binding with it.
        expect(await boundOrganization(tx)).toBeNull();
        const state = await outsideTheRole(() =>
          session.query<{ consumed_at: Date | null }>(
            "select consumed_at from public.slack_oauth_states where state_hash = $1",
            [f.stateHash],
          ),
        );
        expect(state.rows).toEqual([{ consumed_at: null }]);
      });
    });
  },
);

describe.sequential.each(["owner-shaped", "application"] as const)(
  "the repository methods that bind the organisation they are handed, calling no definer function, as the %s role (D15)",
  (role) => {
    test("a resolved credential is stamped bound to the organisation its lookup found, and only there (D15)", async () => {
      const stamped = async (session: TestSession, table: string, id: string) =>
        (
          await session.query<{ stamped: boolean }>(
            `select last_used_at is not null as stamped from public.${table} where id = $1`,
            [id],
          )
        ).rows[0]?.stamped;

      await asRoleInTransaction(role, async (tx, f, session) => {
        await createAgentAuthRepository(tx).touchCredential(
          f.credentialId,
          f.organizationId,
        );
        await createOperatorCredentialRepository(tx).touchCredential(
          f.operatorCredentialId,
          f.organizationId,
        );
        expect(await boundOrganization(tx)).toBe(f.organizationId);
        expect(
          await stamped(session, "agent_credentials", f.credentialId),
        ).toBe(true);
        expect(
          await stamped(
            session,
            "operator_credentials",
            f.operatorCredentialId,
          ),
        ).toBe(true);
      });

      // Named with another organisation, the stamp binds that one and
      // touches nothing: the credential is not in it.
      await asRoleInTransaction(role, async (tx, f, session) => {
        const elsewhere = randomUUID();
        await createAgentAuthRepository(tx).touchCredential(
          f.credentialId,
          elsewhere,
        );
        await createOperatorCredentialRepository(tx).touchCredential(
          f.operatorCredentialId,
          elsewhere,
        );
        expect(await boundOrganization(tx)).toBe(elsewhere);
        await session.query("RESET ROLE");
        expect(
          await stamped(session, "agent_credentials", f.credentialId),
        ).toBe(false);
        expect(
          await stamped(
            session,
            "operator_credentials",
            f.operatorCredentialId,
          ),
        ).toBe(false);
      });
    });

    test("the Slack modal's installation read binds the organisation it names", async () => {
      await asRoleInTransaction(role, async (tx, f) => {
        const installation = await createSlackRepository(tx).loadInstallation(
          f.organizationId,
          f.installationId,
        );
        expect(installation).toMatchObject({
          id: f.installationId,
          organizationId: f.organizationId,
        });
        expect(await boundOrganization(tx)).toBe(f.organizationId);
      });
    });
  },
);

describe.sequential("the definer-calling repository methods, as the owner-shaped role: each refused since step 5's contract (42501)", () => {
  /*
   * Each method of the application-role describe above that calls one of
   * the fourteen, called once as the owner-shaped role, in a savepoint of
   * its own so the transaction survives the refusal. Each is refused by
   * PostgreSQL's privilege check on the function, before its body runs.
   */
  const methods: readonly [
    string,
    string,
    (tx: Tx, f: DefinerFixture) => Promise<unknown>,
  ][] = [
    [
      "resolveOAuthGrant",
      "resolve_oauth_grant",
      (tx, f) =>
        createAgentAuthRepository(tx).resolveOAuthGrant({
          userId: f.userId,
          clientId: f.clientId,
          audience: "mcp",
        }),
    ],
    [
      "listOAuthGrantBindingFingerprints",
      "list_oauth_grant_binding_fingerprints",
      (tx, f) =>
        createAgentAuthRepository(tx).listOAuthGrantBindingFingerprints({
          userId: f.userId,
          audience: "mcp",
        }),
    ],
    [
      "resolveApiKeyCredential",
      "resolve_api_key_credential",
      (tx, f) =>
        createAgentAuthRepository(tx).resolveApiKeyCredential({
          apiKeyId: f.apiKeyId,
          audience: "api",
        }),
    ],
    [
      "invalidateUnboundOAuthProviderAuthorization",
      "has_usable_oauth_grant",
      (tx, f) =>
        createAgentAuthRepository(
          tx,
        ).invalidateUnboundOAuthProviderAuthorization({
          userId: f.userId,
          clientId: f.clientId,
        }),
    ],
    [
      "findInvitations",
      "invitation_eligibility",
      (tx, f) =>
        createSignupEligibilityRepository(tx).findInvitations(f.invitedEmail),
    ],
    [
      "findAllowlistEntries",
      "signup_allowlist_eligibility",
      (tx, f) =>
        createSignupEligibilityRepository(tx).findAllowlistEntries(
          f.allowedEmail,
        ),
    ],
    [
      "the operator key lookup, resolveApiKeyCredential",
      "resolve_operator_credential",
      (tx, f) =>
        createOperatorCredentialRepository(tx).resolveApiKeyCredential({
          apiKeyId: f.operatorApiKeyId,
        }),
    ],
    [
      "recordProviderCallback",
      "record_provider_callback",
      (tx, f) =>
        createNotificationRepository(tx).recordProviderCallback({
          provider: "resend",
          eventId: `evt-refused-${f.slug}`,
          rawBody: "{}",
          occurredAt: new Date(),
          providerMessageId: f.providerMessageId,
          status: "delivered",
        }),
    ],
    [
      "lockActionToken",
      "lock_slack_action_token",
      (tx, f) =>
        createSlackRepository(tx).lockActionToken({
          tokenHash: f.tokenHash,
          tokenType: "answer",
          workspaceId: f.workspaceId,
          slackUserId: f.slackUserId,
        }),
    ],
    [
      "consumeOauthState",
      "consume_slack_oauth_state",
      (tx, f) => createSlackRepository(tx).consumeOauthState(f.stateHash),
    ],
  ];

  test("each method is refused EXECUTE on the function it calls, and binds nothing", async () => {
    await asRoleInTransaction("owner-shaped", async (tx, f) => {
      for (const [method, name, call] of methods) {
        const refusal = await tx
          .transaction((savepoint) => call(savepoint as Tx, f))
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(refusal, method).toMatchObject({
          cause: {
            code: "42501",
            message: `permission denied for function ${name}`,
          },
        });
      }
      expect(await boundOrganization(tx)).toBeNull();
    });
  });
});

describe.sequential("F.3's operator credential methods bind their own transactions (§2.3 item 2)", () => {
  /*
   * The issuing service (packages/auth) calls these on the pool, each in a
   * transaction of its own; handed the case's transaction here, each binds
   * a savepoint instead. As the application group, nothing bound: every one
   * must bind the credential's organisation before its first read.
   */
  test("reserve, create, list, overlap and compensate, as the application group with nothing bound", async () => {
    await asRoleInTransaction("application", async (tx, f, session) => {
      const sessionId = `rls-session-${f.slug}`;
      const newApiKeyId = `rls-issued-key-${f.slug}`;
      await session.query("RESET ROLE");
      await session.query(
        `insert into public.session (id, token, expires_at, user_id, updated_at)
         values ($1, $1, clock_timestamp() + interval '1 hour', $2, now())`,
        [sessionId, f.userId],
      );
      await session.query(
        `insert into public.apikey (id, reference_id, key, enabled, expires_at, config_id, created_at, updated_at)
         values ($1, $2, 'hashed', true, clock_timestamp() + interval '1 day', $3, now(), now())`,
        [newApiKeyId, f.userId, operatorApiKeyConfigId],
      );
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);
      expect(await boundOrganization(tx)).toBeNull();
      const operators = createOperatorCredentialRepository(tx);

      const receipt = await operators.reserveIssuance({
        actorUserId: f.userId,
        sessionId,
        organizationId: f.organizationId,
        projectId: null,
        commandName: "issue_operator_credential",
        idempotencyKey: `rls-issue-${f.slug}`,
        fingerprintSecret: "rls-operator-issuance-fingerprint-secret-0001",
        normalizedInput: { name: "Issued" },
      });
      expect(receipt.reserved).toBe(true);
      expect(await boundOrganization(tx)).toBe(f.organizationId);

      const created = await operators.createCredential({
        organizationId: f.organizationId,
        memberUserId: f.userId,
        projectId: null,
        betterAuthApiKeyId: newApiKeyId,
        name: "Issued",
        prefix: "rpo_",
        fingerprint: `rls-issued-fingerprint-${f.slug}`,
        scopes: ["operator:revoke"],
        expiresInDays: 30,
        correlationId: randomUUID(),
        issuanceReceipt: receipt,
      });
      expect(created.organizationId).toBe(f.organizationId);

      expect(
        (await operators.listCredentials(f.organizationId))
          .map((credential) => credential.id)
          .sort(),
      ).toEqual(
        [
          created.id,
          f.operatorCredentialId,
          f.misconfiguredOperatorCredentialId,
        ].sort(),
      );

      expect(
        await operators.setCredentialOverlap({
          organizationId: f.organizationId,
          credentialId: f.operatorCredentialId,
          expectedVersion: 1,
          overlapExpiresAt: new Date(Date.now() + 30 * 60_000),
          actorUserId: f.userId,
          correlationId: randomUUID(),
        }),
      ).toEqual({ id: f.operatorCredentialId, version: 2 });

      expect(
        await operators.revokeCredentialForCompensation({
          organizationId: f.organizationId,
          credentialId: created.id,
          actorUserId: f.userId,
          correlationId: randomUUID(),
          reason: "Compensated in the row-security suite",
        }),
      ).toMatchObject({ id: created.id, organizationId: f.organizationId });
      expect(await boundOrganization(tx)).toBe(f.organizationId);
    });
  });
});

describe.sequential("the credential re-check binds the transaction it runs in (§2.3 item 5)", () => {
  /*
   * F.2's handlers that stay off the bus — the agent key and grant
   * revocations, route evaluation, the Slack connection test, the import
   * split — and the administration reads each open a transaction of their
   * own and run `assertCurrent` first, then repositories that read as their
   * opener bound them. The bus binds before `assertCurrent` runs; these do
   * not. So the re-check binds the context's organisation itself: idempotent
   * on the bus, the first binding elsewhere.
   */
  async function withSession(session: TestSession, f: DefinerFixture) {
    const sessionId = `rls-recheck-${f.slug}`;
    await session.query("RESET ROLE");
    await session.query(
      `insert into public.session (id, token, expires_at, user_id, updated_at)
       values ($1, $1, clock_timestamp() + interval '1 hour', $2, now())`,
      [sessionId, f.userId],
    );
    await session.query(`SET LOCAL ROLE ${APPLICATION}`);
    return sessionId;
  }

  const person = (
    f: DefinerFixture,
    sessionId: string,
    organizationId = f.organizationId,
  ): AuthorizedCommandContext => ({
    actor: { type: "user", id: f.userId },
    organizationId,
    scopes: new Set(["project:read"]),
    credentialId: sessionId,
    correlationId: randomUUID(),
  });

  test("a person's re-check binds its organisation, and what the handler reads next is that organisation's", async () => {
    await asRoleInTransaction("application", async (tx, f, session) => {
      const sessionId = await withSession(session, f);
      expect(await boundOrganization(tx)).toBeNull();

      await createCommandAuthorizationRepository(tx).assertCurrent(
        person(f, sessionId),
      );
      expect(await boundOrganization(tx)).toBe(f.organizationId);
      expect(
        (
          await createFoundationQueryRepository(tx).listOrganizationProjects(
            f.userId,
            f.organizationId,
          )
        ).map((project) => project.id),
      ).toEqual([f.projectId]);
    });
  });

  test("an agent's re-check binds its organisation", async () => {
    await asRoleInTransaction("application", async (tx, f) => {
      await createCommandAuthorizationRepository(tx).assertCurrent({
        actor: { type: "agent", id: f.principalId },
        organizationId: f.organizationId,
        projectId: f.projectId,
        laneIds: new Set(),
        scopes: new Set(["requests:read"]),
        credentialId: f.credentialId,
        correlationId: randomUUID(),
      });
      expect(await boundOrganization(tx)).toBe(f.organizationId);
    });
  });

  test("a re-check for another organisation than the one the transaction serves is refused", async () => {
    await asRoleInTransaction("application", async (tx, f, session) => {
      const sessionId = await withSession(session, f);
      await createCommandAuthorizationRepository(tx).assertCurrent(
        person(f, sessionId),
      );
      await expect(
        createCommandAuthorizationRepository(tx).assertCurrent(
          person(f, sessionId, randomUUID()),
        ),
      ).rejects.toBeInstanceOf(TenantBindingError);
      expect(await boundOrganization(tx)).toBe(f.organizationId);
    });
  });
});

describe.sequential("F.2's administration reads in the transaction bound for them (ruling 50)", () => {
  /*
   * Every read F.2 wrote takes the caller's transaction and filters by the
   * scope it is handed. The web opens that transaction through
   * `withAdministrationReadTransaction`, bound to the credential's
   * organisation, in core's dispatch
   * (`packages/core/src/administration-reads.ts`), which reaches each of the
   * fourteen, directly or through its `read…ForOperator`. As the
   * application group, each of the fourteen answers its organisation's rows
   * in that bound transaction; each is refused unbound, by the policy
   * (42501, raised by the first tenant table it reads); and each, bound to A
   * and asked about B, is refused.
   *
   * B is seeded so that nothing but the binding stands between the reader
   * and B's rows: the same person is B's active owner, and B holds the
   * project, the agent principal, the import run and the appearance defaults
   * the reads name. Bound to B, every read answers B (the control). Bound to
   * A, the policy hides B's rows, and the refusal each read then returns is
   * its own check's, answering what the policy left it: every one of the
   * fourteen checks the member's standing in B (B's organisation and
   * membership rows, now invisible) before it reads B's data, and answers
   * `forbidden` there. `refusalsOfAnotherOrganisation` records it per read. Unbound, no read's own check answers first: each one's first
   * statement reads a tenant table. As the owner-shaped role, which bypasses
   * the policies, the unbound reads answer and the reads bound to A answer
   * B's rows, so both loops fail there.
   */
  type ReadTarget = {
    organizationId: string;
    projectId: string;
    principalId: string;
    runId: string;
  };

  const reads = (read: Tx, memberUserId: string, target: ReadTarget) => {
    const scope = {
      memberUserId,
      organizationId: target.organizationId,
      credentialProjectId: null,
    };
    return {
      projects: () => listAdministrationProjects(read, scope),
      lanes: () => listAdministrationLanes(read, { ...scope, projectId: null }),
      members: () => listAdministrationMembers(read, scope),
      projectSettings: () =>
        getAdministrationProjectSettings(read, {
          ...scope,
          projectId: target.projectId,
        }),
      routingRules: () => listAdministrationRoutingRules(read, scope),
      agentPrincipals: () => listAdministrationAgentPrincipals(read, scope),
      agentPrincipal: () =>
        getAdministrationAgentPrincipal(read, {
          ...scope,
          agentPrincipalId: target.principalId,
        }),
      importRuns: () => listAdministrationImportRuns(read, scope),
      importRun: () =>
        getAdministrationImportRun(read, { ...scope, runId: target.runId }),
      invitations: () => listAdministrationInvitations(read, scope),
      appearance: () => getAdministrationOrganizationAppearance(read, scope),
      operations: () => listAdministrationOperations(read, scope),
      retentionHolds: () => listAdministrationRetentionHolds(read, scope),
      slack: () => getAdministrationSlackConfiguration(read, scope),
    };
  };

  type ReadName = keyof ReturnType<typeof reads>;

  /** Bound to A and asked about B: the refusal each read's own check returns. */
  const refusalsOfAnotherOrganisation: Record<ReadName, string> = {
    projects: "forbidden",
    lanes: "forbidden",
    members: "forbidden",
    projectSettings: "forbidden",
    routingRules: "forbidden",
    agentPrincipals: "forbidden",
    agentPrincipal: "forbidden",
    importRuns: "forbidden",
    importRun: "forbidden",
    invitations: "forbidden",
    appearance: "forbidden",
    operations: "forbidden",
    retentionHolds: "forbidden",
    slack: "forbidden",
  };

  /** B: the fixture's owner is its active owner too, and it holds a row for each read. */
  async function seedAnotherOrganisation(
    session: TestSession,
    f: DefinerFixture,
  ): Promise<ReadTarget> {
    const b = {
      organizationId: randomUUID(),
      projectId: randomUUID(),
      principalId: randomUUID(),
      runId: randomUUID(),
    };
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const slug = `${f.slug}-b`;
    const rows: [string, unknown[]][] = [
      [
        `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active')`,
        [b.organizationId, slug],
      ],
      [
        `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
        [b.organizationId, f.userId],
      ],
      [
        `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'B', 'b', 'B', 'active')`,
        [b.projectId, b.organizationId],
      ],
      [
        `insert into public.agent_principals (id, organization_id, display_name, slug, status, created_by_user_id) values ($1, $2, 'Agent B', $3, 'active', $4)`,
        [b.principalId, b.organizationId, slug, f.userId],
      ],
      [
        `insert into public.import_sources (id, organization_id, project_id, created_by) values ($1, $2, $3, $4)`,
        [sourceId, b.organizationId, b.projectId, f.userId],
      ],
      [
        `insert into public.source_snapshots (id, organization_id, import_source_id, manifest_sha256) values ($1, $2, $3, $4)`,
        [snapshotId, b.organizationId, sourceId, sha("c")],
      ],
      [
        `insert into public.import_runs (id, organization_id, import_source_id, source_snapshot_id, requested_by_type, requested_by_id, state, parser_version)
         values ($1, $2, $3, $4, 'user', $5, 'reviewing', 'test')`,
        [b.runId, b.organizationId, sourceId, snapshotId, f.userId],
      ],
      [
        `insert into public.organization_appearance_defaults (organization_id, theme, density, mode, last_updated_by_user_id) values ($1, 'requestport', 'normal', 'system', $2)`,
        [b.organizationId, f.userId],
      ],
    ];
    await asSessionLogin(session, async () => {
      await session.query("SET LOCAL session_replication_role = replica");
      for (const [text, values] of rows) await session.query(text, values);
      await session.query("SET LOCAL session_replication_role = origin");
    });
    return b;
  }

  /** What a read answered, or the code it was refused with. */
  async function outcome(read: () => Promise<unknown>) {
    try {
      return { answered: await read() };
    } catch (error) {
      if (error instanceof DomainError) return { refused: error.code };
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== undefined) return { refused: code };
      throw error;
    }
  }

  test("each of the fourteen reads answers bound, is refused unbound, and refuses another organisation", async () => {
    await asRoleInTransaction("application", async (tx, f, session) => {
      const b = await seedAnotherOrganisation(session, f);
      const a: ReadTarget = {
        organizationId: f.organizationId,
        projectId: f.projectId,
        principalId: f.principalId,
        runId: randomUUID(),
      };
      const names = Object.keys(reads(tx, f.userId, a)) as ReadName[];
      expect(names).toHaveLength(14);
      expect(Object.keys(refusalsOfAnotherOrganisation).sort()).toEqual(
        [...names].sort(),
      );

      // Unbound: each read, in a savepoint of its own, is refused by the policy.
      const unbound: Record<string, unknown> = {};
      for (const name of names) {
        unbound[name] = await outcome(() =>
          tx.transaction<unknown>((savepoint) =>
            reads(savepoint, f.userId, a)[name](),
          ),
        );
      }
      expect
        .soft(unbound)
        .toEqual(
          Object.fromEntries(names.map((name) => [name, { refused: "42501" }])),
        );

      // The control: bound to B, in a savepoint rolled back afterwards, every
      // read answers B.
      const control: Record<string, unknown> = {};
      await withIsolatedTenantBinding(
        b.organizationId,
        async (bound) => {
          for (const name of names) {
            control[name] = await outcome(reads(bound, f.userId, b)[name]);
          }
        },
        { database: tx, readOnly: false },
      );
      for (const name of names) {
        expect(control[name], name).toHaveProperty("answered");
      }
      expect(
        (control.projects as { answered: { id: string }[] }).answered.map(
          (project) => project.id,
        ),
      ).toEqual([b.projectId]);
      expect(control.importRun).toMatchObject({ answered: { id: b.runId } });

      // Bound to A: A's rows, and B refused, read by read.
      const answers: Record<string, unknown> = {};
      const refusals: Record<string, unknown> = {};
      await withAdministrationReadTransaction(
        f.organizationId,
        async (bound) => {
          for (const name of names) {
            answers[name] = await outcome(reads(bound, f.userId, a)[name]);
          }
          for (const name of names) {
            refusals[name] = await outcome(reads(bound, f.userId, b)[name]);
          }
        },
        { database: tx as unknown as Database },
      );
      expect
        .soft(refusals)
        .toEqual(
          Object.fromEntries(
            names.map((name) => [
              name,
              { refused: refusalsOfAnotherOrganisation[name] },
            ]),
          ),
        );

      const answered = (name: string) =>
        (answers[name] as { answered: unknown }).answered;
      expect(
        (answered("projects") as { id: string }[]).map((project) => project.id),
      ).toEqual([f.projectId]);
      expect(
        (answered("members") as { userId: string }[]).map(
          (member) => member.userId,
        ),
      ).toEqual([f.userId]);
      expect(answered("projectSettings")).toMatchObject({ id: f.projectId });
      expect(answered("agentPrincipal")).toMatchObject({ id: f.principalId });
      // A run that does not exist is not found, in the bound organisation.
      expect(answers.importRun).toEqual({ refused: "not_found" });
      for (const name of [
        "lanes",
        "routingRules",
        "agentPrincipals",
        "importRuns",
        "invitations",
        "retentionHolds",
      ]) {
        expect(Array.isArray(answered(name)), name).toBe(true);
      }
      expect(answered("operations")).toEqual({
        outbox: expect.any(Array),
        notificationIntents: expect.any(Array),
        slackOperations: expect.any(Array),
        importDispatches: expect.any(Array),
      });
      // The fixture is seeded with triggers off, so A has no appearance
      // defaults row: found missing, under the binding.
      expect(answers.appearance).toEqual({ refused: "not_found" });
      expect(answers.slack).toHaveProperty("answered");
    });
  });
});

describe.sequential("F.2's and F.3's commands on the tenant bus, as the application group (R7)", () => {
  /*
   * The merges added eight ports to the tenant bus: F.2.3's
   * `projectSettingsCommands`, F.3's `operatorCredentials`, F.2.4's
   * `operationsCommands` and `retentionHoldCommands`, F.2.5's
   * `slackAdministrationCommands`, F.2.6's `importReviewCommands`, and
   * F.2.7's `organizationManagement` and `foundation`. One command per
   * port below, eight commands, each asserted to reach its port; every one
   * also runs `commandAuthorization`, the re-check, which the bus had before
   * the merges and F.3 extended.
   *
   * The first case runs each through the real bus, the real core registry
   * and the real ports, with the re-check, as the application group with
   * nothing bound: the bus binds its transaction to the context's
   * organisation before the re-check reads (`commandTransactionBinding`),
   * the re-check binds it again, and the receipt records it. With the bus's
   * binding and the re-check's both removed, all eight are refused; with
   * either alone removed they pass, because each binds before the first
   * tenant read.
   *
   * So the second case sets both aside — its manager drops the binding the
   * bus hands it, and it runs no re-check — and each port's own binding is
   * then the first. Seven ports bind the transaction they are handed before
   * their first tenant read (`authorize`, or for `foundation`,
   * `findOrganizationAuthorization`, which `requireInvitationAuthority`
   * calls first; `organizationManagement`'s in a savepoint whose binding the
   * enclosing transaction keeps), and with that binding removed the
   * command is refused. `operatorCredentials` binds nothing of its own:
   * its methods read in the transaction as the bus bound it, and a person's
   * revocation reads `lockMemberRole` first, which the policy refuses on the
   * second case's unbound transaction.
   * So `revoke_operator_credential` is left out of the second case.
   */
  const ports: Record<string, (database: Database | Tx) => unknown> = {
    commandAuthorization: (database) =>
      createCommandAuthorizationRepository(database, {
        operatorCredentials: "enabled",
      }),
    foundation: (database) => createFoundationRepository(database),
    importReviewCommands: (database) =>
      createImportReviewCommandRepository(database),
    operationsCommands: (database) =>
      createOperationsCommandRepository(database as Database),
    operatorCredentials: (database) =>
      createOperatorCredentialRepository(database),
    organizationManagement: (database) =>
      createOrganizationManagementRepository(database),
    projectSettingsCommands: (database) =>
      createProjectSettingsCommandRepository(database as Database),
    retentionHoldCommands: (database) =>
      createRetentionHoldCommandRepository(database as Database),
    slackAdministrationCommands: (database) =>
      createSlackAdministrationCommandRepository(database),
  };

  const fingerprintSecret = "rls-tenant-bus-fingerprint-secret-000000000001";

  /** The ports, recording each one a command asks for. */
  const portFactory =
    (requested: Set<string>) => (name: string, database: Database | Tx) => {
      requested.add(name);
      return ports[name]?.(database);
    };

  function tenantBus(tx: Tx, requested: Set<string>) {
    return new AtomicCommandBus({
      registry: createCoreCommandRegistry(),
      transactions: createCommandTransactionManager(
        tx as unknown as Database,
        portFactory(requested),
      ),
      fingerprintSecret,
      authorizeContext: (context, uow) =>
        uow
          .port<ReturnType<typeof createCommandAuthorizationRepository>>(
            "commandAuthorization",
          )
          .assertCurrent(context),
    });
  }

  /** The bus with its binding and the re-check set aside: the ports bind first. */
  function portsOnlyBus(tx: Tx, requested: Set<string>) {
    const manager = createCommandTransactionManager(
      tx as unknown as Database,
      portFactory(requested),
    );
    return new AtomicCommandBus({
      registry: createCoreCommandRegistry(),
      // The binding the bus hands `run` is dropped.
      transactions: { run: (work) => manager.run(work) },
      fingerprintSecret,
    });
  }

  /** Rows a command acts on, beyond the fixture: seeded as the superuser. */
  type Seed = (
    session: TestSession,
    f: DefinerFixture,
  ) => Promise<Record<string, string>>;

  /** A dead-lettered outbox row of the fixture's organisation, three attempts in. */
  const deadLetteredOutbox: Seed = async (session, f) => {
    const eventId = randomUUID();
    const outboxId = randomUUID();
    await session.query(
      `insert into public.domain_events (id, organization_id, aggregate_type, aggregate_id, aggregate_version, type, schema_version, actor, correlation_id, causation_id, data)
       values ($1, $2, 'organization', $2, 1, 'rls.bus_case.v1', 1, '{}'::jsonb, 'rls', 'rls', '{}'::jsonb)`,
      [eventId, f.organizationId],
    );
    await session.query(
      `insert into public.outbox (id, event_id, state, attempt_count) values ($1, $2, 'dead_letter', 3)`,
      [outboxId, eventId],
    );
    return { outboxId };
  };

  /** A reviewing import run of the fixture's project, with one entry at version 1. */
  const reviewingImportEntry: Seed = async (session, f) => {
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const artifactId = randomUUID();
    const runId = randomUUID();
    const entryId = randomUUID();
    await session.query(
      `insert into public.import_sources (id, organization_id, project_id, created_by) values ($1, $2, $3, $4)`,
      [sourceId, f.organizationId, f.projectId, f.userId],
    );
    await session.query(
      `insert into public.source_snapshots (id, organization_id, import_source_id, manifest_sha256) values ($1, $2, $3, $4)`,
      [snapshotId, f.organizationId, sourceId, sha("d")],
    );
    await session.query(
      `insert into public.source_artifacts (id, organization_id, import_source_id, source_snapshot_id, relative_path, media_type, byte_size, sha256, exact_bytes)
       values ($1, $2, $3, $4, 'README.md', 'text/markdown', 1, $5, '\\x61')`,
      [artifactId, f.organizationId, sourceId, snapshotId, sha("e")],
    );
    await session.query(
      `insert into public.import_runs (id, organization_id, import_source_id, source_snapshot_id, requested_by_type, requested_by_id, state, parser_version)
       values ($1, $2, $3, $4, 'user', $5, 'reviewing', 'test')`,
      [runId, f.organizationId, sourceId, snapshotId, f.userId],
    );
    await session.query(
      `insert into public.import_manifest_entries (id, organization_id, import_run_id, source_artifact_id, record_index, proposed_kind, parsed_json)
       values ($1, $2, $3, $4, 0, 'request', '{}'::jsonb)`,
      [entryId, f.organizationId, runId, artifactId],
    );
    return { runId, entryId };
  };

  /** A command, the port it writes through, its input, version and seed. */
  const commands: Array<
    [
      string,
      string,
      (
        f: DefinerFixture,
        seeded: Record<string, string>,
      ) => Record<string, unknown>,
      number,
      Seed | undefined,
    ]
  > = [
    [
      "create_retention_hold",
      "retentionHoldCommands",
      (f) => ({
        organizationId: f.organizationId,
        category: "all",
        reason: "Held by the row-security suite",
      }),
      0,
      undefined,
    ],
    [
      "set_slack_route",
      "slackAdministrationCommands",
      (f) => ({
        organizationId: f.organizationId,
        projectId: null,
        mode: "channel",
        channelId: "C0RLSTEST",
        fallback: "none",
      }),
      0,
      undefined,
    ],
    [
      "add_project_alias",
      "projectSettingsCommands",
      (f) => ({
        organizationId: f.organizationId,
        projectId: f.projectId,
        alias: `rls-alias-${f.slug}`,
      }),
      1,
      undefined,
    ],
    [
      "revoke_operator_credential",
      "operatorCredentials",
      (f) => ({
        organizationId: f.organizationId,
        credentialId: f.operatorCredentialId,
      }),
      1,
      undefined,
    ],
    [
      "revoke_organization_invitation",
      "organizationManagement",
      (f) => ({
        organizationId: f.organizationId,
        invitationId: f.invitationId,
      }),
      1,
      undefined,
    ],
    [
      "requeue_outbox",
      "operationsCommands",
      (f, seeded) => ({
        organizationId: f.organizationId,
        outboxId: seeded.outboxId,
      }),
      3,
      deadLetteredOutbox,
    ],
    [
      "review_legacy_import_entry",
      "importReviewCommands",
      (f, seeded) => ({
        organizationId: f.organizationId,
        runId: seeded.runId,
        entryId: seeded.entryId,
        decision: "skip",
      }),
      1,
      reviewingImportEntry,
    ],
    [
      "invite_organization_member",
      "foundation",
      (f) => ({
        organizationId: f.organizationId,
        email: `rls-bus-invitee-${f.slug}@example.test`,
        role: "member",
      }),
      0,
      undefined,
    ],
  ];

  /**
   * Runs one command as the fixture's owner on `bus`, checks it reached its
   * port, and answers its receipt's organisation.
   */
  async function runCommand(
    bus: (tx: Tx, requested: Set<string>) => AtomicCommandBus,
    [name, port, input, expectedVersion, seed]: (typeof commands)[number],
    tx: Tx,
    f: DefinerFixture,
    session: TestSession,
  ) {
    const sessionId = `rls-bus-${f.slug}`;
    let seeded: Record<string, string> = {};
    await asSessionLogin(session, async () => {
      await session.query(
        `insert into public.session (id, token, expires_at, user_id, updated_at)
         values ($1, $1, clock_timestamp() + interval '1 hour', $2, now())`,
        [sessionId, f.userId],
      );
      if (seed !== undefined) seeded = await seed(session, f);
    });
    const requested = new Set<string>();

    await bus(tx, requested).execute({
      name,
      context: {
        actor: { type: "user", id: f.userId },
        organizationId: f.organizationId,
        scopes: new Set([
          "operations:manage",
          "slack:manage",
          "project:manage",
          "operator:manage",
          "members:manage",
          "import:write",
        ]),
        credentialId: sessionId,
        correlationId: randomUUID(),
      },
      input: input(f, seeded),
      meta: { expectedVersion, idempotencyKey: `rls-bus-${name}-${f.slug}` },
    });
    expect(requested).toContain(port);

    const receipt = await session.query<{
      organization_id: string | null;
    }>(
      `select organization_id from public.command_receipts where command_name = $1
         and created_at >= now() order by created_at desc limit 1`,
      [name],
    );
    return receipt.rows;
  }

  test("one command per port the merges added: eight ports, eight commands", () => {
    expect(commands.map(([, port]) => port).sort()).toEqual(
      Object.keys(ports)
        .filter((port) => port !== "commandAuthorization")
        .sort(),
    );
  });

  test.each(commands)(
    "%s commits bound to its organisation, and its receipt records it",
    async (...command) => {
      await asRoleInTransaction("application", async (tx, f, session) => {
        expect(await runCommand(tenantBus, command, tx, f, session)).toEqual([
          { organization_id: f.organizationId },
        ]);
      });
    },
  );

  test.each(commands.filter(([name]) => name !== "revoke_operator_credential"))(
    "%s's port binds the transaction it is handed, with the bus's binding and the re-check set aside",
    async (...command) => {
      await asRoleInTransaction("application", async (tx, f, session) => {
        expect(await runCommand(portsOnlyBus, command, tx, f, session)).toEqual(
          [{ organization_id: f.organizationId }],
        );
      });
    },
  );
});

describe.sequential("the grant family claim, now in its definer function (§2.5.0)", () => {
  /*
   * packages/auth's agent-grant-family-claim.test.ts pinned these on the
   * Drizzle query this method used to build; the query is now the body of
   * requestport_private.list_oauth_grant_binding_fingerprints, so they are
   * held here, against the function, through the repository.
   */
  async function seedGrants(session: TestSession, f: DefinerFixture) {
    // A hundred more grants for the fixture's owner, each a second newer
    // than the last and all newer than the fixture's own, on clients of
    // their own (one active grant per user and client).
    await session.query("SET LOCAL session_replication_role = replica");
    await session.query(
      `insert into public.oauth_client (id, client_id, redirect_uris, disabled)
       select 'c-' || $1 || '-' || i, 'c-' || $1 || '-' || i, '{https://client.example.test/callback}', false
       from generate_series(1, 100) i`,
      [f.slug],
    );
    await session.query(
      `insert into public.agent_oauth_grants
         (id, organization_id, agent_principal_id, user_id, oauth_client_id,
          provider_grant_id, refresh_family_id, audience, project_id, lane_ids,
          scopes, status, expires_at, created_at)
       select gen_random_uuid(), $2, $3, $4, 'c-' || $1 || '-' || i,
              'consent-' || $1, 'fam-' || $1 || '-' || i, 'mcp', $5, '[]',
              '["requests:read"]', 'active', clock_timestamp() + interval '1 day',
              now() + make_interval(secs => i)
       from generate_series(1, 100) i`,
      [f.slug, f.organizationId, f.principalId, f.userId, f.projectId],
    );
    await session.query("SET LOCAL session_replication_role = origin");
  }

  test("keeps the newest hundred, newest first, and reports the grant it dropped", async () => {
    await asRoleInTransaction("application", async (tx, f, session) => {
      await session.query("RESET ROLE");
      await seedGrants(session, f);
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);

      const claim = await createAgentAuthRepository(
        tx,
      ).listOAuthGrantBindingFingerprints({
        userId: f.userId,
        audience: "mcp",
      });

      expect(claim.truncated).toBe(true);
      expect(claim.fingerprints).toEqual(
        Array.from({ length: 100 }, (_unused, index) =>
          bindingFingerprint(
            `c-${f.slug}-${100 - index}`,
            `fam-${f.slug}-${100 - index}`,
          ),
        ),
      );
      // The oldest, the fixture's own grant, is the one dropped.
      expect(claim.fingerprints).not.toContain(
        bindingFingerprint(f.clientId, f.refreshFamilyId),
      );
    });
  });

  test("reports no truncation when the cap is exactly met, and breaks a tie by id", async () => {
    await asRoleInTransaction("application", async (tx, f, session) => {
      await session.query("RESET ROLE");
      await seedGrants(session, f);
      // Exactly a hundred usable: the fixture's grant revoked.
      await session.query(
        `update public.agent_oauth_grants set status = 'revoked', revoked_at = now() where id = $1`,
        [f.grantId],
      );
      // The two newest share a moment; the higher id comes first.
      const { rows } = await session.query<{ id: string; family: string }>(
        `update public.agent_oauth_grants set created_at = now() + interval '1 hour'
         where refresh_family_id in ($1, $2)
         returning id::text, refresh_family_id as family`,
        [`fam-${f.slug}-1`, `fam-${f.slug}-2`],
      );
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);

      const claim = await createAgentAuthRepository(
        tx,
      ).listOAuthGrantBindingFingerprints({
        userId: f.userId,
        audience: "mcp",
      });

      expect(claim.truncated).toBe(false);
      expect(claim.fingerprints).toHaveLength(100);
      const [higher, lower] = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1));
      const family = (row: { family: string } | undefined) =>
        (row?.family ?? "").replace("fam-", "c-");
      expect(claim.fingerprints.slice(0, 2)).toEqual([
        bindingFingerprint(family(higher), higher?.family ?? ""),
        bindingFingerprint(family(lower), lower?.family ?? ""),
      ]);
    });
  });
});

describe.sequential("the web's own transactions bind through the first method they call (§2.3 item 5)", () => {
  test("an import transaction binds to its organisation, reads under it, and refuses another", async () => {
    await asRoleInTransaction("application", async (tx, f) => {
      const imports = createImportRepository(tx);

      await imports.requireManagerAccess(f.organizationId, f.userId);
      expect(await boundOrganization(tx)).toBe(f.organizationId);
      expect(await imports.list(f.organizationId)).toEqual([]);
      expect(await imports.listCaptures(f.organizationId)).toEqual([]);
      expect(await imports.detail(f.organizationId, randomUUID())).toBeNull();
      await expect(imports.list(randomUUID())).rejects.toBeInstanceOf(
        TenantBindingError,
      );
    });
  });

  test("the Slack callback's second transaction binds through the installation lock", async () => {
    await asRoleInTransaction("application", async (tx, f) => {
      const slack = createSlackRepository(tx);

      expect(
        await slack.lockInstallationIdForWorkspace(
          f.organizationId,
          f.workspaceId,
          randomUUID(),
        ),
      ).toBe(f.installationId);
      expect(await boundOrganization(tx)).toBe(f.organizationId);
    });
  });

  test("every method those transactions call binds, or runs where one already has (a source ratchet)", () => {
    const source = (file: string) =>
      readFileSync(new URL(`./repositories/${file}`, import.meta.url), "utf8");
    const bindsFirst = (text: string, method: string) =>
      new RegExp(
        // The signature may span lines, but not past the method's own end.
        `\\n    (async )?${method}\\((?:(?!\\n    \\},)[^])*?\\)(?:: [^\\n]+)? \\{\\n      return (forOrganization|withSlackTransaction|inTenantTransaction)\\(`,
        "u",
      ).test(text);
    const imports = source("import-repository.ts");
    const slack = source("slack-repository.ts");
    // §2.3 item 5's twenty-two (track-i2.md §6): sixteen import methods —
    // splitEntry and reviewEntry now in createImportReviewCommandRepository,
    // where F.2.6 moved them, beside its authorize (ruling 14) …
    for (const method of [
      "appendCaptureArtifacts",
      "authorize",
      "beginCapture",
      "createCorrectionRun",
      "createRun",
      "detail",
      "finalizeCapture",
      "findCaptureForProject",
      "freeze",
      "list",
      "listCaptures",
      "listForProject",
      "queueApply",
      "requireAgentAccess",
      "requireManagerAccess",
      "reviewEntry",
      "splitEntry",
    ]) {
      expect(bindsFirst(imports, method), method).toBe(true);
    }
    // … and six Slack ones: three bind their input's organisation, two bind
    // the one their definer function finds (D11, tested above), and
    // consumeActionToken names none and runs after lockActionToken. F.2.5's
    // createSlackAdministrationCommandRepository binds too: its authorize,
    // and the three writes it took from this repository (ruling 14).
    for (const method of [
      "createActionToken",
      "lockInstallationIdForWorkspace",
      "upsertInstallation",
      "consumeOauthState",
      "lockActionToken",
      "authorize",
      "setInstallationStatus",
      "setRoute",
      "upsertMapping",
    ]) {
      expect(bindsFirst(slack, method), method).toBe(true);
    }
    expect(bindsFirst(slack, "consumeActionToken")).toBe(false);
  });

  test("F.2.6's run-in-bound-project check runs only inside the two writes that bind first (a source ratchet)", () => {
    // `requireRunInBoundProject` (Plan 13, F.2.6) reads the run's import
    // source, a tenant table, for an operator bound to a project. It is
    // module-level, not a method the ratchet above can name, so it is held
    // here to its callers: `splitEntry` and `reviewEntry`, both of which the
    // ratchet above holds to bind first.
    const imports = readFileSync(
      new URL("./repositories/import-repository.ts", import.meta.url),
      "utf8",
    );
    const body = (method: string) =>
      new RegExp(
        `\\n    (?:async )?${method}\\((?:(?!\\n    \\},)[^])*?\\n    \\},`,
        "u",
      ).exec(imports)?.[0] ?? "";
    const calls = (text: string) =>
      text.split("await requireRunInBoundProject(").length - 1;
    expect(calls(body("splitEntry"))).toBe(1);
    expect(calls(body("reviewEntry"))).toBe(1);
    expect(calls(imports)).toBe(2);
  });
});

describe.sequential("the foundation adapter binds before its first statement, under the application group (D10, §2.3 item 2)", () => {
  /*
   * The web creates organisations and projects through the foundation
   * repository that server-administration-actions.ts builds over the web
   * root's storage, in a transaction it opens with nothing bound. Here that
   * transaction is a savepoint of the lane's, under the application group,
   * so an adapter method that forgot to bind raises 42501 on its first
   * statement.
   */
  test("createOrganization binds the id it generates before the insert, and RETURNING reads it back", async () => {
    await asRoleInTransaction("application", async (tx, f) => {
      const slug = `rls-new-${f.slug}`;
      const created = await createFoundationRepository(tx).transaction(
        async (adapter) => {
          const organization = await adapter.createOrganization({
            name: "New",
            slug,
          });
          expect(await boundOrganization(tx)).toBe(organization.id);
          return organization;
        },
      );
      expect(created).toMatchObject({ name: "New", slug, status: "active" });
    });
  });

  test("findOrganizationAuthorization binds the organisation it authorises before reading it", async () => {
    await asRoleInTransaction("application", async (tx, f) => {
      const found = await createFoundationRepository(tx).transaction(
        async (adapter) => {
          const authorization = await adapter.findOrganizationAuthorization(
            f.organizationId,
            f.userId,
          );
          expect(await boundOrganization(tx)).toBe(f.organizationId);
          return authorization;
        },
      );
      expect(found.organization?.id).toBe(f.organizationId);
      expect(found.membership).toMatchObject({
        organizationId: f.organizationId,
        userId: f.userId,
        role: "owner",
      });
    });
  });
});

describe("the application surface binds before its first read (§2.3 items 2 and 3, §2.4; a source ratchet)", () => {
  /*
   * Most of these methods have no case that runs them under the
   * application role until the application-role lane (§2.9). Until then,
   * unwrapping one leaves every test green while it would raise 42501 once
   * the variable is set; so the source is held here: each method's first
   * `await` or `return` must be a call to a helper that binds, and each such
   * helper must be the binding it claims.
   */
  const binder =
    /^(?:return(?: await)?|await) (forOrganization|withTenantReadOn|withTenantRead|withTenant|inTenantTransaction|mutate|withActiveAuthorization)\(/u;

  /** The lines of `name`'s body, a method of an object literal at four spaces. */
  function methodBody(text: string, name: string) {
    const lines = text.split("\n");
    const starts = lines.flatMap((line, index) =>
      new RegExp(`^ {4}(?:async )?${name}(?:<[^>]*>)?\\(`, "u").test(line)
        ? [index]
        : [],
    );
    if (starts.length !== 1) return undefined;
    let open = starts[0] as number;
    while (
      open < lines.length &&
      !/\)(?:: [^{]+)? \{$/u.test(lines[open] ?? "")
    )
      open += 1;
    let close = open + 1;
    while (close < lines.length && !/^ {4}\},?$/u.test(lines[close] ?? ""))
      close += 1;
    return lines.slice(open + 1, close).map((line) => line.trim());
  }

  const firstAwaitOrReturn = (body: string[]) =>
    body.find((line) => /^(?:return|await)\b|= await\b/u.test(line));

  const surface: Record<string, string[]> = {
    "queries/agent-management-repository.ts": ["listAgents", "getAgent"],
    "queries/agent-query-repository.ts": [
      "getAgentPolicy",
      "listOrganizations",
      "listProjects",
      "getProject",
      "listRequests",
      "getRequest",
      "listTimeline",
      "listOpenQuestions",
      "listEvents",
    ],
    "queries/operations-query-repository.ts": ["summary", "details"],
    "queries/project-settings-repository.ts": [
      "authorize",
      "listManageableProjects",
      "getProject",
      "addAlias",
      "addRepository",
      "setDefaultRepository",
      "setRepositoryStatus",
      "addLane",
      "setDefaultLane",
      "setLaneStatus",
      "setMember",
      "setWorkPolicy",
      "updateMetadata",
      "setProjectStatus",
    ],
    "queries/request-query-repository.ts": [
      "listRequests",
      "listTimeline",
      "listOrganizationActivity",
      "listOpenQuestions",
    ],
    "queries/search-repository.ts": ["search"],
    "repositories/agent-auth-repository.ts": [
      "reserveCredentialIssuance",
      // Step 8 (0024): the receipt it removes is under the receipts policy.
      "cancelCredentialIssuance",
      "bindOAuthConsent",
      "createCredential",
      "revokeOAuthGrant",
      "revokeCredential",
      "setCredentialOverlap",
      "revokeCredentialForCompensation",
      "listCredentials",
      "touchCredential",
    ],
    "repositories/agent-repository.ts": ["canManage", "findPrincipal"],
    "repositories/foundation-query.ts": [
      "findActiveOrganizationForUser",
      "listOrganizationProjects",
      "listOrganizationLanes",
      "listOrganizationMembers",
      "listPendingInvitations",
    ],
    "repositories/notification-repository.ts": ["listQuestionDeliveries"],
    // The merges since the branch's base (track-i2.md §21): F.3's operator
    // credential methods the issuing service and the bearer path call.
    "repositories/operator-credential-repository.ts": [
      "reserveIssuance",
      // Step 8 (0024): the receipt it removes is under the receipts policy.
      "cancelIssuance",
      "createCredential",
      "setCredentialOverlap",
      "revokeCredentialForCompensation",
      "listCredentials",
      "touchCredential",
    ],
    "repositories/operations-repository.ts": [
      "authorize",
      "requeueOutbox",
      "requeueNotification",
      "requeueSlackOperation",
      "requeueImportDispatch",
    ],
    "repositories/organization-management-repository.ts": [
      "authorizeMemberChange",
      "authorizeInvitationRevocation",
      "setMember",
      "revokeInvitation",
    ],
    "repositories/outbox-repository.ts": [
      "listWebhookOperations",
      "createWebhookReplay",
    ],
    "repositories/project-registration-repository.ts": ["register"],
    "repositories/retention-hold-repository.ts": [
      "authorize",
      "list",
      "create",
      "release",
    ],
    "repositories/routing-repository.ts": [
      "canManage",
      "listRules",
      "listRulesForMember",
      "listRulesForManager",
      "createRule",
      "updateRule",
      "disableRule",
    ],
    "repositories/slack-repository.ts": [
      "createOauthState",
      "list",
      "loadInstallation",
      "setInstallationStatus",
      "upsertMapping",
      "setRoute",
      "queueConnectionTest",
    ],
    "repositories/webhook-repository.ts": [
      "canManage",
      "validateScope",
      "create",
      "find",
      "list",
      "listForProject",
      "markVerified",
      "setStatus",
      "setNextSecret",
      "promoteSecret",
    ],
    "repositories/workspace-repository.ts": ["revealAuthorized"],
  };
  const source = (file: string) =>
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  test("each method's first await or return calls a helper that binds", () => {
    // The detector fires on the reviewer's mutation: listOpenQuestions
    // reading the pool straight.
    expect(
      firstAwaitOrReturn(
        methodBody(
          "\n    async listOpenQuestions(input) {\n      return database.select();\n    },\n",
          "listOpenQuestions",
        ) ?? [],
      ),
    ).not.toMatch(binder);

    for (const [file, methods] of Object.entries(surface)) {
      const text = source(file);
      for (const method of methods) {
        const body = methodBody(text, method);
        expect(body, `${file} › ${method}: found once`).toBeDefined();
        expect(
          firstAwaitOrReturn(body ?? []) ?? "",
          `${file} › ${method}`,
        ).toMatch(binder);
      }
    }
  });

  test("each helper those methods call is the binding it names", () => {
    const localRead =
      /const (forOrganization|withTenantReadOn) = <T>\([\s\S]*?\) => withTenantRead\(organizationId, work, \{ database, readOnly \}\);/u;
    for (const file of [
      "queries/agent-management-repository.ts",
      "queries/project-settings-repository.ts",
      "queries/request-query-repository.ts",
      "repositories/agent-auth-repository.ts",
      "repositories/agent-repository.ts",
      "repositories/foundation-query.ts",
      "repositories/webhook-repository.ts",
    ]) {
      expect(localRead.test(source(file)), file).toBe(true);
    }
    // Project settings' mutations open their transaction bound.
    expect(source("queries/project-settings-repository.ts")).toMatch(
      /\n {4}return await inTenantTransaction\(\n {6}database,\n {6}context\.organizationId,/u,
    );
    // The agent queries' one transaction helper binds.
    expect(source("queries/agent-query-repository.ts")).toMatch(
      /async function withActiveAuthorization<T>\([\s\S]*?\) \{\n {2}return inTenantTransaction\(/u,
    );
    // The two reads bound some other way: the membership listing in user
    // mode, and the appearance snapshot under the organisation named.
    expect(
      firstAwaitOrReturn(
        methodBody(
          source("repositories/foundation-query.ts"),
          "listActiveOrganizationsForUser",
        ) ?? [],
      ),
    ).toMatch(/^const rows = await withUserBinding\(/u);
    expect(
      methodBody(
        source("repositories/appearance-repository.ts"),
        "readAppearanceSnapshot",
      ),
    ).toContain("return withTenantRead(input.organizationId, read, {");
  });
});

describe("each operator read re-checks the credential, and so binds, before its first read (track-i2.md §21; a source ratchet)", () => {
  /*
   * The F.2 registry halves' operator reads — each `read…ForOperator`, and
   * F.2.1's `evaluateRouteForOperator` — take the transaction `/api/v1`
   * hands them, which `withAdministrationReadTransaction` opened and bound
   * to the credential's organisation (core's `administration-reads.ts`,
   * ruling 50). Each re-checks the credential first, through F.3's
   * `assertCurrent`, which binds the context's organisation before it reads
   * a tenant table: idempotently in that transaction, and first in one it is
   * handed unbound, as each function's own suite hands it. So nothing may
   * run before the re-check but the refusals that read nothing. The source
   * is held here: each function's first statement that awaits or returns
   * awaits the re-check before anything else, directly or through its
   * file's one helper — as the argument of the one call it returns, which
   * runs only once its arguments are evaluated — and that helper's first
   * such statement is the re-check.
   */
  const operatorReads: Record<string, { helper?: string; reads: string[] }> = {
    // F.2.3's, on `main` before the registry halves' stack.
    "queries/administration/project-settings-reads.ts": {
      reads: ["readProjectSettingsForOperator"],
    },
    // Plan 13, F.2.1.
    "queries/administration/routing-reads.ts": {
      helper: "currentOperatorMember",
      reads: ["readRoutingRulesForOperator", "evaluateRouteForOperator"],
    },
    // Plan 13, F.2.2.
    "queries/administration/agent-reads.ts": {
      helper: "operatorReadInput",
      reads: [
        "readAgentPrincipalsForOperator",
        "readAgentPrincipalForOperator",
      ],
    },
    // Plan 13, F.2.4.
    "queries/administration/operations-reads.ts": {
      helper: "operatorReadInput",
      reads: ["readOperationsForOperator", "readRetentionHoldsForOperator"],
    },
    // Plan 13, F.2.5.
    "queries/administration/slack-reads.ts": {
      reads: ["readSlackConfigurationForOperator"],
    },
    // Plan 13, F.2.6.
    "queries/administration/import-reads.ts": {
      helper: "operatorReader",
      reads: ["readImportRunsForOperator", "readImportRunForOperator"],
    },
    // Plan 13, F.2.7.
    "queries/administration/member-reads.ts": {
      helper: "operatorReadInput",
      reads: [
        "readInvitationsForOperator",
        "readOrganizationAppearanceForOperator",
      ],
    },
  };

  /** The lines of the top-level function `name`'s body, trimmed. */
  function functionBody(text: string, name: string) {
    const lines = text.split("\n");
    const starts = lines.flatMap((line, index) =>
      new RegExp(`^(?:export )?async function ${name}\\b`, "u").test(line)
        ? [index]
        : [],
    );
    if (starts.length !== 1) return undefined;
    let open = starts[0] as number;
    while (
      open < lines.length &&
      !/^(?:(?:export )?async function .*|\))(?:: [^{]+)? \{$/u.test(
        lines[open] ?? "",
      )
    )
      open += 1;
    let close = open + 1;
    while (close < lines.length && lines[close] !== "}") close += 1;
    return lines.slice(open + 1, close).map((line) => line.trim());
  }

  /**
   * The body's first statement that awaits or returns, its trimmed lines
   * joined: from the first line that awaits or returns to the line that ends
   * the statement.
   */
  function firstStatement(body: string[]) {
    const first = body.findIndex((line) =>
      /^(?:return|await)\b|\bawait\b/u.test(line),
    );
    if (first < 0) return "";
    let last = first;
    while (last < body.length - 1 && !(body[last] ?? "").endsWith(";"))
      last += 1;
    return body.slice(first, last + 1).join("\n");
  }

  /** F.3's re-check on the context, as a statement of its own. */
  const reCheck =
    /^await createCommandAuthorizationRepository\(tx, \{\noperatorCredentials(?:: input\.operatorCredentials)?,\n\}\)\.assertCurrent\(context\);$/u;

  /**
   * What may come before that statement's first `await`: nothing, a binding
   * of its result, or the opening of the one call it returns, whose first
   * argument is the transaction.
   */
  const beforeFirstAwait =
    /^(?:(?:return|const [^=\n]+=) )?(?:[A-Za-z]+\(\n?tx,[ \n](?:\{\n\.\.\.\()?)?$/u;

  /**
   * Whether the body's first statement that awaits or returns awaits the
   * re-check before anything else: the re-check itself, or `helper`'s
   * result.
   */
  function awaitsReCheckFirst(body: string[], helper?: string) {
    const statement = firstStatement(body);
    if (reCheck.test(statement)) return true;
    const at = statement.indexOf("await ");
    return (
      helper !== undefined &&
      at >= 0 &&
      beforeFirstAwait.test(statement.slice(0, at)) &&
      statement.startsWith(`await ${helper}(`, at)
    );
  }

  const source = (file: string) =>
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  test("each operator read's first statement that awaits or returns awaits the re-check", () => {
    // The detector fires on a read placed before the re-check, and passes
    // the same body without it; and on a returned call handed another read's
    // result before the helper's.
    const mutated =
      functionBody(
        [
          "export async function readSomethingForOperator(",
          "  tx: Tx,",
          ") {",
          "  const rows = await tx.select().from(projects);",
          "  await createCommandAuthorizationRepository(tx, {",
          "    operatorCredentials,",
          "  }).assertCurrent(context);",
          "}",
        ].join("\n"),
        "readSomethingForOperator",
      ) ?? [];
    expect(mutated).toHaveLength(4);
    expect(awaitsReCheckFirst(mutated)).toBe(false);
    expect(awaitsReCheckFirst(mutated.slice(1))).toBe(true);
    expect(
      awaitsReCheckFirst(
        ["return listSomething(tx, await readOther(tx), await check(tx));"],
        "check",
      ),
    ).toBe(false);

    for (const [file, { helper, reads }] of Object.entries(operatorReads)) {
      const text = source(file);
      for (const read of reads) {
        const body = functionBody(text, read) ?? [];
        expect(body.length, `${file} › ${read}: found once`).toBeGreaterThan(0);
        expect(
          awaitsReCheckFirst(body, helper),
          `${file} › ${read}: ${firstStatement(body)}`,
        ).toBe(true);
      }
      if (helper === undefined) continue;
      const body = functionBody(text, helper) ?? [];
      expect(body.length, `${file} › ${helper}: found once`).toBeGreaterThan(0);
      expect(awaitsReCheckFirst(body), `${file} › ${helper}`).toBe(true);
    }
  });
});

/**
 * Organisations A, B and C, whose slugs sort in that order. U is the owner of
 * A, a member of B, and a revoked owner of C, and a maintainer of each
 * organisation's project; V is an admin of B only. Each organisation has a project, an agent principal
 * and a lane. A public OAuth client, as dynamic registration writes one.
 */
async function seedTwoModes(session: TestSession) {
  const tag = randomUUID().slice(0, 8);
  const organization = (letter: string) => ({
    id: randomUUID(),
    slug: `rls-2m-${tag}-${letter}`,
    projectId: randomUUID(),
    principalId: randomUUID(),
    laneId: randomUUID(),
  });
  const seeded = {
    a: organization("a"),
    b: organization("b"),
    c: organization("c"),
    u: `rls-2m-u-${tag}`,
    v: `rls-2m-v-${tag}`,
    clientId: `rls-2m-client-${tag}`,
  };
  await session.query("SET LOCAL session_replication_role = replica");
  await session.query(
    `insert into public."user" (id, name, email) values ($1, 'U', $1 || '@example.test'), ($2, 'V', $2 || '@example.test')`,
    [seeded.u, seeded.v],
  );
  await session.query(
    `insert into public.oauth_client (id, client_id, name, redirect_uris, disabled, token_endpoint_auth_method)
     values ($1, $1, 'Agent', '{https://client.example.test/callback}', false, 'none')`,
    [seeded.clientId],
  );
  for (const org of [seeded.a, seeded.b, seeded.c]) {
    await session.query(
      `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active')`,
      [org.id, org.slug],
    );
    await session.query(
      `insert into public.projects (id, organization_id, name, slug, key_prefix, status)
       values ($1, $2, $3, 'p', 'P', 'active')`,
      [org.projectId, org.id, `Project ${org.slug}`],
    );
    await session.query(
      `insert into public.agent_principals (id, organization_id, display_name, slug, status, created_by_user_id)
       values ($1, $2, $3, 'agent', 'active', $4)`,
      [org.principalId, org.id, `Agent ${org.slug}`, seeded.u],
    );
    await session.query(
      `insert into public.lanes (id, organization_id, project_id, name, slug, status)
       values ($1, $2, $3, $4, 'lane', 'active')`,
      [org.laneId, org.id, org.projectId, `Lane ${org.slug}`],
    );
  }
  const members: [string, string, string, string][] = [
    [seeded.a.id, seeded.u, "owner", "active"],
    [seeded.b.id, seeded.u, "member", "active"],
    [seeded.c.id, seeded.u, "owner", "revoked"],
    [seeded.b.id, seeded.v, "admin", "active"],
  ];
  for (const [organizationId, userId, role, status] of members) {
    await session.query(
      `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, $3, $4)`,
      [organizationId, userId, role, status],
    );
  }
  for (const org of [seeded.a, seeded.b, seeded.c]) {
    await session.query(
      `insert into public.project_members (organization_id, project_id, user_id, role, status)
       values ($1, $2, $3, 'maintainer', 'active')`,
      [org.id, org.projectId, seeded.u],
    );
  }
  await session.query("SET LOCAL session_replication_role = origin");
  return seeded;
}

/** 42501 from the unbound policy, or the empty answer every binding would give (P2). */
async function refusedOrEmpty(session: TestSession, text: string) {
  await session.query("SAVEPOINT refused_or_empty");
  try {
    const { rows } = await session.query(text);
    await session.query("RELEASE SAVEPOINT refused_or_empty");
    return rows.length === 0 ? "empty" : rows;
  } catch (error) {
    await session.query("ROLLBACK TO SAVEPOINT refused_or_empty");
    return (error as { code?: string }).code;
  }
}

describe.sequential("the two modes, with a user in two organisations (§2.9, Done when 9)", () => {
  test("bound to A, U reads only A; in user mode, the membership listing is U's A and B and nothing else", async () => {
    const session = await openSession(suiteStorage);
    try {
      await expect(
        session.db.transaction(async (tx) => {
          const t = await seedTwoModes(session);
          await session.query(`SET LOCAL ROLE ${APPLICATION}`);
          const ids = (rows: { id?: string; organization_id?: string }[]) =>
            rows.map((row) => row.organization_id ?? row.id).sort();

          // Organisation mode, A and U, with no predicate in any query.
          await bind(session, { organizationId: t.a.id, userId: t.u });
          expect(
            ids(
              (await session.query("select id from public.organizations")).rows,
            ),
          ).toEqual([t.a.id]);
          for (const table of [
            "organization_members",
            "projects",
            "project_members",
            "agent_principals",
            "lanes",
          ]) {
            const { rows } = await session.query(
              `select organization_id from public.${table}`,
            );
            expect(rows.length, table).toBeGreaterThan(0);
            expect(new Set(ids(rows)), table).toEqual(new Set([t.a.id]));
          }
          expect(
            await failure(
              session,
              "select * from requestport_private.active_memberships()",
            ),
          ).toMatchObject({ code: "42501" });

          // User mode: U alone. No tenant row, whatever the table.
          await bind(session, { userId: t.u });
          for (const table of ["organizations", "organization_members"]) {
            expect(["42501", "empty"], table).toContain(
              await refusedOrEmpty(session, `select * from public.${table}`),
            );
          }
          const listing = await session.query(
            "select * from requestport_private.active_memberships()",
          );
          expect(listing.rows).toEqual([
            {
              organization_id: t.a.id,
              organization_name: t.a.slug,
              organization_slug: t.a.slug,
              role: "owner",
            },
            {
              organization_id: t.b.id,
              organization_name: t.b.slug,
              organization_slug: t.b.slug,
              role: "member",
            },
          ]);

          await bind(session, { userId: t.v });
          expect(
            ids(
              (
                await session.query(
                  "select * from requestport_private.active_memberships()",
                )
              ).rows,
            ),
          ).toEqual([t.b.id]);

          await bind(session, {});
          expect(
            await failure(
              session,
              "select * from requestport_private.active_memberships()",
            ),
          ).toMatchObject({ code: "42501" });

          // The real reads, handed this unbound transaction.
          expect(
            await createFoundationQueryRepository(
              tx,
            ).listActiveOrganizationsForUser(t.u),
          ).toEqual([
            { id: t.a.id, name: t.a.slug, slug: t.a.slug, role: "owner" },
            { id: t.b.id, name: t.b.slug, slug: t.b.slug, role: "member" },
          ]);
          const options = await createAgentManagementRepository(
            tx,
          ).getConsentOptions(t.u, t.clientId);
          expect(options?.client).toMatchObject({ clientId: t.clientId });
          // A as its owner; in B, the project U maintains; nothing of C.
          expect(options?.projects.map((project) => project.id).sort()).toEqual(
            [t.a.projectId, t.b.projectId].sort(),
          );
          expect(options?.agents.map((agent) => agent.id).sort()).toEqual(
            [t.a.principalId, t.b.principalId].sort(),
          );
          expect(options?.lanes.map((lane) => lane.id).sort()).toEqual(
            [t.a.laneId, t.b.laneId].sort(),
          );
          expect(options?.organizations).toEqual([
            { id: t.a.id, name: t.a.slug },
          ]);
          // Neither read left a binding behind on the transaction it was handed.
          expect(await boundOrganization(tx)).toBeNull();
          throw new LaneRollback();
        }),
      ).rejects.toBeInstanceOf(LaneRollback);
    } finally {
      session.release();
    }
  });
});

describe.sequential("consent's order across organisations (the driver's ruling R6)", () => {
  test("projects, agents and lanes come by name across organisations, as the single query ordered them", async () => {
    const session = await openSession(suiteStorage);
    try {
      await expect(
        session.db.transaction(async (tx) => {
          const t = await seedTwoModes(session);
          // A sorts before B by slug, so grouping by organisation would put
          // A's rows first. Each name below sorts B's row first, in the C
          // collation and in a linguistic one alike; A's two projects differ
          // in case, so the two collations order them differently, and the
          // expected order is read from PostgreSQL rather than written here.
          const secondProjectId = randomUUID();
          await session.query("SET LOCAL session_replication_role = replica");
          await session.query(
            `insert into public.projects (id, organization_id, name, slug, key_prefix, status)
             values ($1, $2, 'mike project', 'p2', 'Q', 'active')`,
            [secondProjectId, t.a.id],
          );
          await session.query("SET LOCAL session_replication_role = origin");
          const rename = async (
            table: string,
            column: string,
            names: [string, string][],
          ) => {
            for (const [id, name] of names) {
              await session.query(
                `update public.${table} set ${column} = $2 where id = $1`,
                [id, name],
              );
            }
          };
          await rename("projects", "name", [
            [t.a.projectId, "Zulu project"],
            [t.b.projectId, "Bravo project"],
          ]);
          await rename("agent_principals", "display_name", [
            [t.a.principalId, "Yankee agent"],
            [t.b.principalId, "Alpha agent"],
          ]);
          await rename("lanes", "name", [
            [t.a.laneId, "x-ray lane"],
            [t.b.laneId, "Echo lane"],
          ]);
          // The order the single query gave: PostgreSQL's, over both
          // organisations at once, read as the superuser.
          const byName = async (table: string, column: string, ids: string[]) =>
            (
              await session.query<{ id: string }>(
                `select id::text from public.${table} where id = any($1::uuid[]) order by ${column}`,
                [ids],
              )
            ).rows.map((row) => row.id);
          const expectedProjects = await byName("projects", "name", [
            t.a.projectId,
            secondProjectId,
            t.b.projectId,
          ]);
          const expectedAgents = await byName(
            "agent_principals",
            "display_name",
            [t.a.principalId, t.b.principalId],
          );
          const expectedLanes = await byName("lanes", "name", [
            t.a.laneId,
            t.b.laneId,
          ]);
          await session.query(`SET LOCAL ROLE ${APPLICATION}`);

          const options = await createAgentManagementRepository(
            tx,
          ).getConsentOptions(t.u, t.clientId);

          expect(options?.projects.map((project) => project.id)).toEqual(
            expectedProjects,
          );
          expect(options?.agents.map((agent) => agent.id)).toEqual(
            expectedAgents,
          );
          expect(options?.lanes.map((lane) => lane.id)).toEqual(expectedLanes);
          // Not the grouped order, which puts A's rows first.
          expect(expectedProjects[0]).toBe(t.b.projectId);
          expect(expectedAgents[0]).toBe(t.b.principalId);
          expect(expectedLanes[0]).toBe(t.b.laneId);
          expect(await boundOrganization(tx)).toBeNull();
          throw new LaneRollback();
        }),
      ).rejects.toBeInstanceOf(LaneRollback);
    } finally {
      session.release();
    }
  });
});

/**
 * One organisation with a project, a draft request and a label on it: a
 * direct tenant table (`projects`) and an indirect one (`request_labels`,
 * whose policy asks for the parent request). Seeded as the superuser.
 */
async function seedTenant(session: TestSession) {
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const requestId = randomUUID();
  const slug = `rls-t-${organizationId.slice(0, 8)}`;
  await session.query(
    `insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [organizationId, slug, slug],
  );
  await session.query(
    `insert into public.projects (id, organization_id, name, slug, key_prefix, status)
     values ($1, $2, 'Tenant', 'tenant', 'TEN', 'active')`,
    [projectId, organizationId],
  );
  await session.query(
    `insert into public.requests
       (id, organization_id, source_kind, target_project_id, type, title,
        description_md, reporter_type, reporter_id)
     values ($1, $2, 'human_direct', $3, 'bug', 'Tenant', '', 'user', 'rls-reporter')`,
    [requestId, organizationId, projectId],
  );
  await session.query(
    `insert into public.request_labels (request_id, label) values ($1, 'seeded')`,
    [requestId],
  );
  return { organizationId, projectId, requestId };
}

/**
 * An operator credential issued in `organizationId` by a member seeded with
 * it. Seeded as the superuser, with triggers off: the signup guard would
 * refuse the member.
 */
async function seedOperatorCredential(
  session: TestSession,
  organizationId: string,
) {
  const userId = `rls-operator-member-${randomUUID().slice(0, 8)}`;
  const credentialId = randomUUID();
  await session.query("SET LOCAL session_replication_role = replica");
  await session.query(
    `insert into public."user" (id, name, email) values ($1, 'Member', $2)`,
    [userId, `${userId}@example.test`],
  );
  await session.query(
    `insert into public.operator_credentials
       (id, organization_id, member_user_id, lineage_id, name, prefix, fingerprint, expires_at)
     values ($1, $2, $3, $1, 'operator', 'rpo_', $4, now() + interval '1 day')`,
    [credentialId, organizationId, userId, `rls-fingerprint-${credentialId}`],
  );
  await session.query("SET LOCAL session_replication_role = origin");
  return { userId, credentialId };
}

describe.sequential("the policies under the application role (manifest §2.9, until the login-role suite)", () => {
  /*
   * The catalogue compares the policy and binding texts; these cases hold
   * their meaning, so a change that keeps the text and alters the semantics
   * still fails somewhere. The login-role negative suite (Done when 1) is a
   * later step and goes further.
   */
  test("an unbound transaction raises on a direct and an indirect table", async () => {
    await inRolledBackTransaction(async (session) => {
      await seedTenant(session);
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);
      await bind(session, {});
      for (const table of ["projects", "request_labels"]) {
        expect(
          await failure(session, `select count(*) from public.${table}`),
          table,
        ).toMatchObject({
          code: "42501",
          message: "requestport: no organisation is bound to this transaction",
        });
      }
    });
  });

  test("bound to A, B's rows are invisible, untouchable and cannot be written", async () => {
    await inRolledBackTransaction(async (session) => {
      const a = await seedTenant(session);
      const b = await seedTenant(session);
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);
      await bind(session, { organizationId: a.organizationId });

      const projects = await session.query<{ id: string }>(
        `select id from public.projects where id = any($1::uuid[])`,
        [[a.projectId, b.projectId]],
      );
      expect(projects.rows).toEqual([{ id: a.projectId }]);
      const labels = await session.query<{ request_id: string }>(
        `select request_id from public.request_labels where request_id = any($1::uuid[])`,
        [[a.requestId, b.requestId]],
      );
      expect(labels.rows).toEqual([{ request_id: a.requestId }]);

      const renamed = await session.query(
        `update public.projects set name = 'Taken' where id = $1`,
        [b.projectId],
      );
      expect(renamed.rowCount).toBe(0);

      expect(
        await failure(
          session,
          `insert into public.projects (organization_id, name, slug, key_prefix, status)
           values ($1, 'Planted', 'planted', 'PLA', 'active')`,
          [b.organizationId],
        ),
      ).toMatchObject({
        code: "42501",
        message:
          'new row violates row-level security policy for table "projects"',
      });
      expect(
        await failure(
          session,
          `insert into public.request_labels (request_id, label) values ($1, 'planted')`,
          [b.requestId],
        ),
      ).toMatchObject({
        code: "42501",
        message:
          'new row violates row-level security policy for table "request_labels"',
      });

      // The positive control: the same writes on A's own rows succeed.
      const own = await session.query(
        `insert into public.request_labels (request_id, label) values ($1, 'own')`,
        [a.requestId],
      );
      expect(own.rowCount).toBe(1);
      const ownRename = await session.query(
        `update public.projects set name = 'Renamed' where id = $1`,
        [a.projectId],
      );
      expect(ownRename.rowCount).toBe(1);
    });
  });

  test("bound to A, B's operator credentials are invisible, untouchable and cannot be written", async () => {
    await inRolledBackTransaction(async (session) => {
      const a = await seedTenant(session);
      const b = await seedTenant(session);
      const ownCredential = await seedOperatorCredential(
        session,
        a.organizationId,
      );
      const otherCredential = await seedOperatorCredential(
        session,
        b.organizationId,
      );
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);
      await bind(session, { organizationId: a.organizationId });

      const visible = await session.query<{ id: string }>(
        `select id from public.operator_credentials where id = any($1::uuid[])`,
        [[ownCredential.credentialId, otherCredential.credentialId]],
      );
      expect(visible.rows).toEqual([{ id: ownCredential.credentialId }]);

      const revoked = await session.query(
        `update public.operator_credentials set revoked_at = now() where id = $1`,
        [otherCredential.credentialId],
      );
      expect(revoked.rowCount).toBe(0);

      const plant = `insert into public.operator_credentials
          (id, organization_id, member_user_id, lineage_id, name, prefix, fingerprint, expires_at)
        values ($1, $2, $3, $1, 'planted', 'rpo_', $4, now() + interval '1 day')`;
      const planted = (organizationId: string, userId: string) => {
        const id = randomUUID();
        return [id, organizationId, userId, `rls-planted-${id}`];
      };
      expect(
        await failure(
          session,
          plant,
          planted(b.organizationId, otherCredential.userId),
        ),
      ).toMatchObject({
        code: "42501",
        message:
          'new row violates row-level security policy for table "operator_credentials"',
      });

      // The positive control: the same writes on A's own rows succeed.
      const own = await session.query(
        plant,
        planted(a.organizationId, ownCredential.userId),
      );
      expect(own.rowCount).toBe(1);
      const ownRevoked = await session.query(
        `update public.operator_credentials set revoked_at = now() where id = $1`,
        [ownCredential.credentialId],
      );
      expect(ownRevoked.rowCount).toBe(1);
    });
  });
});

/*
 * Receipts record the organisation they were written for (manifest-i2.md
 * §2.1, §3 steps 2 and 8). Step 2 merges only once 0019 is recorded applied,
 * so every insert names `organization_id`, taking it from the transaction's
 * binding: the organisation for a tenant command, and NULL for the
 * session-only user bus, which binds a user alone. Step 8's policy hides a
 * tenant command's receipt that has none, so every writer has to bind.
 */
function receiptKey(): MutationReceiptKey {
  const tag = randomUUID();
  return {
    actorFingerprint: `rls-actor-${tag}`,
    commandName: "rls.receipt",
    idempotencyFingerprint: `rls-idempotency-${tag}`,
    normalizedInputHash: `rls-input-${tag}`,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  };
}

class ReceiptRollback extends Error {}

async function receiptOrganization(tx: Tx, key: MutationReceiptKey) {
  const { rows } = await tx.execute(
    sql`select organization_id from public.command_receipts
        where actor_fingerprint = ${key.actorFingerprint}
          and command_name = ${key.commandName}
          and idempotency_fingerprint = ${key.idempotencyFingerprint}`,
  );
  expect(rows).toHaveLength(1);
  return (rows[0] as { organization_id: string | null }).organization_id;
}

async function withSeededOrganization<T>(
  work: (tx: Tx, organizationId: string) => Promise<T>,
) {
  await expect(
    suiteStorage.db.transaction(async (tx) => {
      // Bound any lock a case waits for behind another suite's transaction.
      await tx.execute(sql`set local lock_timeout = '5s'`);
      const organizationId = randomUUID();
      await tx.execute(
        sql`insert into public.organizations (id, name, slug, status)
            values (${organizationId}, 'Receipts', ${`rls-r-${organizationId.slice(0, 8)}`}, 'active')`,
      );
      await work(tx, organizationId);
      throw new ReceiptRollback();
    }),
  ).rejects.toBeInstanceOf(ReceiptRollback);
}

describe.sequential("receipts record the bound organisation (§2.1)", () => {
  test("the mutation receipt helpers save the transaction's organisation, and NULL when none is bound", async () => {
    await withSeededOrganization(async (tx, organizationId) => {
      const unbound = receiptKey();
      await saveMutationReceipt(tx, unbound, { result: { saved: true } });
      expect(await receiptOrganization(tx, unbound)).toBeNull();

      await bindTenant(tx, organizationId);
      const bound = receiptKey();
      expect(await lockMutationReceipt(tx, bound)).toBeNull();
      await saveMutationReceipt(tx, bound, { result: { saved: true } });
      await updateMutationReceipt(tx, bound, { result: { updated: true } });
      expect(await lockMutationReceipt(tx, bound)).toEqual({
        aggregateId: null,
        result: { updated: true },
      });
      expect(await receiptOrganization(tx, bound)).toBe(organizationId);
    });
  });

  test("the command transaction binds before its work runs, and its receipt carries that binding", async () => {
    await withSeededOrganization(async (outer, organizationId) => {
      const manager = createCommandTransactionManager(
        outer as unknown as Database,
        (_name, database) => database,
      );
      const tenant = receiptKey();
      await manager.run(
        async (uow) => {
          const tx = uow.port<Tx>("transaction");
          const { rows } = await tx.execute(
            sql`select requestport_private.bound_organization_id()::text as organization_id,
                       requestport_private.bound_user_id() as user_id`,
          );
          expect(rows).toEqual([
            { organization_id: organizationId, user_id: "rls-human" },
          ]);
          await uow.commandReceipts.lock(tenant);
          expect(await uow.commandReceipts.find(tenant)).toBeNull();
          await uow.commandReceipts.save({
            ...tenant,
            result: { saved: true },
          });
          expect(await uow.commandReceipts.find(tenant)).toEqual({
            normalizedInputHash: tenant.normalizedInputHash,
            aggregateId: undefined,
            result: { saved: true },
          });
        },
        { organizationId, userId: "rls-human" },
      );
      expect(await receiptOrganization(outer, tenant)).toBe(organizationId);
    });
  });

  test("the session-only user bus binds a user alone, and its receipt carries no organisation", async () => {
    await withSeededOrganization(async (outer) => {
      const manager = createCommandTransactionManager(
        outer as unknown as Database,
        (_name, database) => database,
      );
      const personal = receiptKey();
      await manager.run(
        async (uow) => {
          const tx = uow.port<Tx>("transaction");
          const { rows } = await tx.execute(
            sql`select requestport_private.bound_user_id() as user_id`,
          );
          expect(rows).toEqual([{ user_id: "rls-person" }]);
          await uow.commandReceipts.save({
            ...personal,
            result: { saved: true },
          });
        },
        { userId: "rls-person" },
      );
      expect(await receiptOrganization(outer, personal)).toBeNull();
    });
  });
});

const repositoryRoot = new URL("../../../", import.meta.url);

/**
 * The workspaces `pnpm-workspace.yaml` declares, as J.0 defines them
 * (manifest-j.md §2.2 and §2.4 item 6; ruling 92): each directory one of its
 * `packages:` globs names, one level deep for `dir/*`, that holds a
 * `package.json`. A glob whose directory is absent names none, as in the
 * public seed, which keeps this file and fewer workspaces; an entry of
 * another shape is refused rather than read wrongly.
 */
function declaredWorkspaces(root: string): string[] {
  const lines = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split(
    /\r?\n/u,
  );
  const start = lines.findIndex((line) => /^packages:[ \t]*$/u.test(line));
  const globs: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue;
    if (!/^[ \t]+-/u.test(line)) break;
    const entry =
      /^[ \t]+-[ \t]+(["']?)([\w.-]+(?:\/[\w.-]+)*(?:\/\*)?)\1[ \t]*(?:#.*)?$/u.exec(
        line,
      );
    if (!entry) {
      throw new Error(
        `pnpm-workspace.yaml: an entry this sweep cannot read: ${line.trim()}`,
      );
    }
    globs.push(entry[2]);
  }
  if (globs.length === 0) {
    throw new Error(
      "pnpm-workspace.yaml: no packages: list this sweep can read",
    );
  }
  return globs
    .flatMap((glob) => {
      if (!glob.endsWith("/*")) return [glob];
      const parent = glob.slice(0, -2);
      return existsSync(join(root, parent))
        ? readdirSync(join(root, parent), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${parent}/${entry.name}`)
        : [];
    })
    .filter((directory) => existsSync(join(root, directory, "package.json")))
    .sort();
}

/**
 * Every non-test TypeScript source in the workspaces the tree declares
 * (ruling 92). Each must hold some, so a sweep over them cannot pass by
 * finding nothing.
 */
function sourceFiles(): string[] {
  const roots = declaredWorkspaces(repositoryRoot.pathname);
  expect(roots).toEqual(expect.arrayContaining(["apps/web", "packages/db"]));
  const found: string[] = [];
  const walk = (directory: URL) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.name === "dist" || entry.name === "coverage") continue;
      const path = new URL(
        entry.isDirectory() ? `${entry.name}/` : entry.name,
        directory,
      );
      if (entry.isDirectory()) walk(path);
      else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
      ) {
        found.push(path.pathname);
      }
    }
  };
  for (const root of roots) {
    const before = found.length;
    walk(new URL(`${root}/`, repositoryRoot));
    expect(
      found.length - before,
      `${root} holds source this sweep reads`,
    ).toBeGreaterThan(0);
  }
  return found;
}

const receiptInsert = /\.insert\(\s*commandReceipts\s*\)/g;
const organizationFromBinding = /organizationId:\s*boundOrganizationIdSql\b/g;

describe("the trusted boundary (§2.3, ruling 44)", () => {
  /*
   * The stated limit, recorded rather than fixed: the binding is a setting any
   * role may set, so the database is not what keeps a session to one
   * organisation. tenant-context.ts refuses the transition; a direct
   * `set_config` from code running as the application role is not refused,
   * and a sweep (tenant-context.test.ts) keeps every such call out of the
   * source instead.
   */
  test("a session of the application group that calls set_config itself can move from A to B", async () => {
    await inRolledBackTransaction(async (session) => {
      const a = await seedTenant(session);
      const b = await seedTenant(session);
      await session.query(`SET LOCAL ROLE ${APPLICATION}`);

      const tx = session.db as unknown as Tx;
      await bindTenant(tx, a.organizationId);
      await expect(bindTenant(tx, b.organizationId)).rejects.toBeInstanceOf(
        TenantBindingError,
      );

      const visible = () =>
        session.query<{ id: string }>(
          `select id from public.projects where id = any($1::uuid[])`,
          [[a.projectId, b.projectId]],
        );
      expect((await visible()).rows).toEqual([{ id: a.projectId }]);

      await session.query(
        `select pg_catalog.set_config('requestport.organization_id', $1, true)`,
        [b.organizationId],
      );
      expect((await visible()).rows).toEqual([{ id: b.projectId }]);
    });
  });
});

describe("every receipt insert writes the binding (§2.1)", () => {
  test("names organization_id from the binding once per insert, and the pre-expand projection is gone", () => {
    // The detectors fire on the shapes they count.
    expect(
      "await tx.insert(commandReceipts).values".match(receiptInsert),
    ).toHaveLength(1);
    expect(
      "{ organizationId: boundOrganizationIdSql, }".match(
        organizationFromBinding,
      ),
    ).toHaveLength(1);
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const counts = files
      .map((file) => {
        const text = readFileSync(file, "utf8");
        return {
          file: file.slice(repositoryRoot.pathname.length),
          inserts: text.match(receiptInsert)?.length ?? 0,
          fromBinding: text.match(organizationFromBinding)?.length ?? 0,
          projection: text.includes("receiptsBeforeExpand"),
        };
      })
      .filter((row) => row.inserts > 0 || row.projection);
    expect(counts.map((row) => row.file).sort()).toEqual([
      "packages/db/src/repositories/command-repository.ts",
      "packages/db/src/repositories/mutation-receipt.ts",
      "packages/db/src/repositories/project-registration-repository.ts",
    ]);
    for (const row of counts) {
      expect(row, row.file).toMatchObject({
        projection: false,
        fromBinding: row.inserts,
      });
    }
  });
});

describe("record_provider_callback's ranks (§2.5.0)", () => {
  test("are notification-repository.ts's providerStatusRank, for the stored status and the incoming one", () => {
    const migration = readFileSync(
      new URL("../migrations/0019_row_security_expand.sql", import.meta.url),
      "utf8",
    );
    const start = migration.indexOf(
      "CREATE OR REPLACE FUNCTION requestport_private.record_provider_callback(",
    );
    const body = migration.slice(start, migration.indexOf("$$;", start));
    const cases = [
      ...body.matchAll(/CASE [^\n]+\n((?:\s+WHEN '[a-z_]+' THEN \d+\n)+)/g),
    ].map(
      (match) =>
        new Map(
          [...(match[1] ?? "").matchAll(/WHEN '([a-z_]+)' THEN (\d+)/g)].map(
            (when) => [when[1], Number(when[2])],
          ),
        ),
    );

    expect(start).toBeGreaterThan(-1);
    expect(cases).toHaveLength(2);
    for (const ranks of cases)
      expect(ranks).toEqual(new Map(providerStatusRank));
  });
});

/*
 * The application's login role (§2.9, Done when 1 and 2): a real LOGIN role,
 * a member of requestport_application and nothing else, stored with one
 * SCRAM iteration, named from this database so tracks sharing the server
 * never collide. Created before the suite and dropped after it; its
 * attributes are read from the catalogue, not assumed.
 */
const login = {
  name: "",
  password: randomUUID().replaceAll("-", ""),
  url: "",
  storage: undefined as Storage | undefined,
};

async function createLoginRole() {
  const session = await openSession(suiteStorage);
  try {
    login.name = await probeRoleName(session, "_app_login");
    await session.query(
      `select pg_catalog.set_config('requestport.test_login_role', $1, false),
              pg_catalog.set_config('requestport.test_login_password', $2, false)`,
      [login.name, login.password],
    );
    await session.query("SET scram_iterations = 1");
    await session.query(`
      do $$
      declare
        probe text := current_setting('requestport.test_login_role');
      begin
        if exists (select 1 from pg_catalog.pg_roles where rolname = probe) then
          execute format('drop role %I', probe);
        end if;
        execute format(
          'create role %I login password %L nosuperuser nobypassrls nocreatedb nocreaterole noreplication in role requestport_application',
          probe, current_setting('requestport.test_login_password'));
      end $$`);
    await session.query("RESET scram_iterations");
    await session.query(
      `select pg_catalog.set_config('requestport.test_login_password', '', false)`,
    );
  } finally {
    session.release();
  }
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = login.name;
  url.password = login.password;
  login.url = url.toString();
  login.storage = createTestStorage({
    driver: "pg",
    connectionString: login.url,
    pool: {
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    },
  });
}

/**
 * A storage as the application's login, built as a composition root builds
 * its own (`wiring.ts`): with the tenantBinding the application variable
 * gives when it is built (ruling 17), read once, then. The cases that switch
 * the variable build one on each side of the switch, and close it.
 */
function loginStorageAsARootBuildsIt(): Storage {
  return createTestStorage({
    driver: "pg",
    connectionString: login.url,
    pool: {
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    },
    tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
  });
}

async function dropLoginRole() {
  await login.storage?.close();
  if (!login.name) return;
  const session = await openSession(suiteStorage);
  try {
    await session.query(
      `select pg_catalog.set_config('requestport.test_login_role', $1, false)`,
      [login.name],
    );
    await session.query(`
      do $$
      begin
        execute format('drop role if exists %I', current_setting('requestport.test_login_role'));
      end $$`);
  } finally {
    session.release();
  }
}

/** The five tables that have no organisation column, and whose parent owns them (§2.1). */
const INDIRECT: Record<string, { parent: string; key: string }> = {
  outbox: { parent: "domain_events", key: "event_id" },
  request_acceptance_criteria: { parent: "requests", key: "request_id" },
  request_labels: { parent: "requests", key: "request_id" },
  slack_delivery_operations: {
    parent: "slack_installations",
    key: "installation_id",
  },
  webhook_attempts: { parent: "webhook_deliveries", key: "delivery_id" },
};

/** `t`'s rows that belong to the organisation in parameter `$n`. */
function belongsTo(table: string, parameter: string) {
  if (table === "organizations") return `t.id = ${parameter}`;
  const indirect = INDIRECT[table];
  if (indirect) {
    return `exists (select 1 from public.${indirect.parent} p where p.id = t.${indirect.key} and p.organization_id = ${parameter})`;
  }
  return `t.organization_id = ${parameter}`;
}

/** A request with a label and an acceptance criterion, in `project`. */
async function seedRequest(
  session: TestSession,
  organizationId: string,
  projectId: string,
) {
  const requestId = randomUUID();
  await session.query(
    `insert into public.requests
       (id, organization_id, source_kind, target_project_id, type, title,
        description_md, reporter_type, reporter_id)
     values ($1, $2, 'human_direct', $3, 'bug', 'Seeded', '', 'user', 'rls-reporter')`,
    [requestId, organizationId, projectId],
  );
  await session.query(
    `insert into public.request_labels (request_id, label) values ($1, 'seeded')`,
    [requestId],
  );
  await session.query(
    `insert into public.request_acceptance_criteria (request_id, position, text) values ($1, 0, 'Seeded')`,
    [requestId],
  );
  return requestId;
}

/** An event with its outbox row, and a webhook subscription, delivery and attempt, and a Slack operation. */
async function seedEventsAndWebhooks(session: TestSession, f: DefinerFixture) {
  const eventId = randomUUID();
  const subscriptionId = randomUUID();
  const deliveryId = randomUUID();
  await session.query("SET LOCAL session_replication_role = replica");
  const rows: [string, unknown[]][] = [
    [
      `insert into public.domain_events
         (id, organization_id, aggregate_type, aggregate_id, aggregate_version, type,
          schema_version, actor, correlation_id, causation_id, data)
       values ($1, $2, 'organization', $2, 1, 'rls.seeded.v1', 1, '{}', 'rls', 'rls', '{}')`,
      [eventId, f.organizationId],
    ],
    [
      `insert into public.outbox (event_id, state) values ($1, 'pending')`,
      [eventId],
    ],
    [
      `insert into public.webhook_subscriptions
         (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, created_by)
       values ($1, $2, 'Seeded', 'https://hooks.example.test/in', '{}', 'k1', $3)`,
      [subscriptionId, f.organizationId, f.userId],
    ],
    [
      `insert into public.webhook_deliveries (id, organization_id, subscription_id, event_id) values ($1, $2, $3, $4)`,
      [deliveryId, f.organizationId, subscriptionId, eventId],
    ],
    [
      `insert into public.webhook_attempts (delivery_id, attempt_number, request_timestamp, signing_key_id)
       values ($1, 1, now(), 'k1')`,
      [deliveryId],
    ],
    [
      `insert into public.slack_delivery_operations (installation_id, operation_key, operation_type)
       values ($1, $2, 'connection_test')`,
      [f.installationId, `rls-op-${f.slug}`],
    ],
  ];
  for (const [text, values] of rows) await session.query(text, values);
  await session.query("SET LOCAL session_replication_role = origin");
  return { eventId, deliveryId };
}

/** Runs `text` in a savepoint; its row count, or the SQLSTATE it failed with. */
async function attempt(
  session: TestSession,
  text: string,
  values: unknown[] = [],
): Promise<{ rowCount: number | null; count?: string } | { code: string }> {
  await session.query("SAVEPOINT attempt");
  try {
    const result = await session.query<{ count?: string }>(text, values);
    await session.query("RELEASE SAVEPOINT attempt");
    return { rowCount: result.rowCount, count: result.rows[0]?.count };
  } catch (error) {
    await session.query("ROLLBACK TO SAVEPOINT attempt");
    return { code: String((error as { code?: string }).code) };
  }
}

describe.sequential("as the application's login role (§2.9, Done when 1 and 2)", () => {
  beforeAll(createLoginRole);
  afterAll(dropLoginRole);

  test("is a login role asserted not to be a superuser, not BYPASSRLS, owning nothing, in the application group only", async () => {
    const session = await openSession(suiteStorage);
    try {
      const { rows } = await session.query(
        `select r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
           split_part(a.rolpassword, ':', 1) as scram,
           (select array_agg(g.rolname::text order by g.rolname) from pg_catalog.pg_auth_members m
              join pg_catalog.pg_roles g on g.oid = m.roleid where m.member = r.oid) as groups,
           (select count(*) from pg_catalog.pg_class c where c.relowner = r.oid)::text as owns
         from pg_catalog.pg_roles r join pg_catalog.pg_authid a on a.oid = r.oid
         where r.rolname = $1`,
        [login.name],
      );
      expect(rows).toEqual([
        {
          rolcanlogin: true,
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          scram: "SCRAM-SHA-256$1",
          groups: [APPLICATION],
          owns: "0",
        },
      ]);
    } finally {
      session.release();
    }
    const connected = await rawQuery(
      login.storage as Storage,
      "select current_user as role, session_user as login",
    );
    expect(connected.rows).toEqual([{ role: login.name, login: login.name }]);
  });

  test("bound to A with no predicate, every tenant table refuses B's rows to select, update, delete and insert; unbound, it raises, answers nothing, or (command_receipts) answers only the rows with no organisation", async () => {
    const session = await openSession(suiteStorage);
    try {
      // One snapshot for the whole case. Every other organisation's rows are
      // read before and after each table's attempts, and a gate runs other
      // packages' suites against this database at the same time: under READ
      // COMMITTED a row they commit in between shows up in `after` and fails
      // the comparison (X22). REPEATABLE READ hides those commits and still
      // shows this transaction's own writes.
      await session.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const a = await seedDefinerFixture(session);
      const b = await seedDefinerFixture(session);
      const aRequest = await seedRequest(
        session,
        a.organizationId,
        a.projectId,
      );
      const bRequest = await seedRequest(
        session,
        b.organizationId,
        b.projectId,
      );
      await seedEventsAndWebhooks(session, a);
      const bEvents = await seedEventsAndWebhooks(session, b);
      await seedImportEntry(session, "reviewing");
      // command_receipts' rows: A's, B's and one with no organisation, which
      // only a transaction with no organisation bound may see (0024).
      await seedReceipt(session, a.organizationId);
      await seedReceipt(session, b.organizationId);
      await seedReceipt(session, null);
      expect(aRequest).not.toBe(bRequest);

      const tables = (
        await session.query<{ relname: string; pk: string }>(
          `select c.relname,
             (select a.attname from pg_catalog.pg_index i
                join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
               where i.indrelid = c.oid and i.indisprimary) as pk
           from pg_catalog.pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and c.relrowsecurity and c.relname <> 'user_appearance_preferences'
           order by c.relname`,
        )
      ).rows;
      // The 59 tenant tables of manifest-i2.md §2.1 that step 1 enabled,
      // F.3's operator_credentials among them (0019), and command_receipts,
      // step 8's (0024). With no organisation bound, command_receipts
      // answers its rows that have none, by design, rather than raising.
      expect(tables).toHaveLength(60);

      const bParent: Record<string, string> = {
        outbox: bEvents.eventId,
        request_acceptance_criteria: bRequest,
        request_labels: bRequest,
        slack_delivery_operations: b.installationId,
        webhook_attempts: bEvents.deliveryId,
      };
      const outcomes: Record<string, unknown> = {};

      for (const { relname: table, pk } of tables) {
        const others = async () =>
          (
            await session.query<{ count: string; digest: string | null }>(
              `select count(*)::text as count, md5(string_agg(t.ctid::text, ',' order by t.ctid)) as digest
               from public."${table}" t where (${belongsTo(table, "$1")}) is not true`,
              [a.organizationId],
            )
          ).rows[0];
        const own = (
          await session.query<{ count: string }>(
            `select count(*)::text as count from public."${table}" t where ${belongsTo(table, "$1")}`,
            [a.organizationId],
          )
        ).rows[0]?.count;
        const before = await others();

        await session.query("SAVEPOINT per_table");
        await session.query(`SET LOCAL ROLE "${login.name}"`);
        await bind(session, { organizationId: a.organizationId });
        const read = await attempt(
          session,
          `select count(*)::text as count from public."${table}"`,
        );
        const planted =
          table === "organizations"
            ? await attempt(
                session,
                `insert into public.organizations (name, slug) values ('Planted', $1)`,
                [`rls-planted-${randomUUID().slice(0, 8)}`],
              )
            : INDIRECT[table]
              ? await attempt(
                  session,
                  `insert into public."${table}" (${INDIRECT[table]?.key}) values ($1)`,
                  [bParent[table]],
                )
              : await attempt(
                  session,
                  `insert into public."${table}" (organization_id) values ($1)`,
                  [b.organizationId],
                );
        const updated = await attempt(
          session,
          `update public."${table}" set "${pk}" = "${pk}"`,
        );
        const deleted = await attempt(session, `delete from public."${table}"`);
        await bind(session, {});
        const unbound = await attempt(
          session,
          `select count(*)::text as count from public."${table}"`,
        );
        const unboundWithOrganization =
          table === "command_receipts"
            ? await attempt(
                session,
                "select count(*)::text as count from public.command_receipts where organization_id is not null",
              )
            : undefined;
        await session.query("RESET ROLE");
        const after = await others();
        await session.query("ROLLBACK TO SAVEPOINT per_table");

        outcomes[table] = { read, planted, updated, deleted, unbound };
        // Select: A's rows and nothing else, or refused by privilege.
        if ("code" in read) expect(read.code, table).toBe("42501");
        else expect(read.count, table).toBe(own);
        // Insert of a B row: refused, by the policy or by privilege.
        expect(planted, table).toEqual({ code: "42501" });
        // Update and delete, with no predicate: at most A's rows, or refused
        // (by privilege, by a trigger on A's rows, or by a foreign key).
        for (const [name, outcome] of [
          ["update", updated],
          ["delete", deleted],
        ] as const) {
          if ("code" in outcome) {
            expect(["42501", "55000", "23503"], `${table} ${name}`).toContain(
              outcome.code,
            );
          } else {
            expect(
              outcome.rowCount ?? 0,
              `${table} ${name}`,
            ).toBeLessThanOrEqual(Number(own));
          }
        }
        // Nothing of any other organisation changed: its rows, their count
        // and their physical versions are what they were.
        expect(after, table).toEqual(before);
        // Unbound: raised, or the answer every binding gives for a table
        // with no row at all (P2); command_receipts answers exactly its rows
        // with no organisation (the user-mode arm), and none of A's or B's.
        if ("code" in unbound) expect(unbound.code, table).toBe("42501");
        else if (table === "command_receipts") {
          const withoutOrganization = (
            await session.query<{ count: string }>(
              "select count(*)::text as count from public.command_receipts where organization_id is null",
            )
          ).rows[0]?.count;
          expect(Number(withoutOrganization)).toBeGreaterThan(0);
          expect(unbound.count, table).toBe(withoutOrganization);
          expect(unboundWithOrganization, table).toMatchObject({ count: "0" });
        } else {
          const total = (
            await session.query<{ count: string }>(
              `select count(*)::text as count from public."${table}"`,
            )
          ).rows[0]?.count;
          expect({ table, unbound: unbound.count }).toEqual({
            table,
            unbound: "0",
          });
          expect(total, table).toBe("0");
        }
      }
      expect(Object.keys(outcomes)).toHaveLength(60);
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      session.release();
    }
  }, 120_000);

  test("a real repository read handed B's id, in a transaction bound to A, finds nothing", async () => {
    const session = await openSession(suiteStorage);
    try {
      await expect(
        session.db.transaction(async (tx) => {
          const a = await seedDefinerFixture(session);
          const b = await seedDefinerFixture(session);
          await session.query(`SET LOCAL ROLE "${login.name}"`);
          await bindTenant(tx, a.organizationId);
          const foundation = createFoundationQueryRepository(tx);

          // The positive control, then B's organisation and B's member.
          expect(
            await foundation.findActiveOrganizationForUser(
              a.userId,
              a.organizationId,
            ),
          ).toMatchObject({ id: a.organizationId });
          expect(
            await foundation.findActiveOrganizationForUser(
              b.userId,
              b.organizationId,
            ),
          ).toBeNull();
          expect(
            await foundation.listOrganizationProjects(
              b.userId,
              b.organizationId,
            ),
          ).toEqual([]);
          throw new LaneRollback();
        }),
      ).rejects.toBeInstanceOf(LaneRollback);
    } finally {
      session.release();
    }
  });

  test("a connection reused after a transaction bound to B carries nothing of B (a pool of one)", async () => {
    const storage = login.storage as Storage;
    const b = randomUUID();
    await rawQuery(
      suiteStorage,
      `insert into public.organizations (id, name, slug, status) values ($1, 'Reused', $2, 'active')`,
      [b, `rls-reuse-${b.slice(0, 8)}`],
    );
    try {
      const pid = async () =>
        (
          await rawQuery<{ pid: number }>(
            storage,
            "select pg_backend_pid() as pid",
          )
        ).rows[0]?.pid;
      const first = await pid();
      const seen = await storage.transaction(async (tx) => {
        await bindTenant(tx, b);
        return (
          await tx.execute(
            sql`select count(*)::int as count from public.organizations where id = ${b}`,
          )
        ).rows;
      });
      expect(seen).toEqual([{ count: 1 }]);
      expect(await pid()).toBe(first);
      const setting = async () =>
        (
          await rawQuery<{ bound: string | null }>(
            storage,
            "select current_setting('requestport.organization_id', true) as bound",
          )
        ).rows[0]?.bound;
      // Unbound: '' after the bound transaction ended (P1), or NULL.
      const afterCommit = await setting();
      expect(["", null], String(afterCommit)).toContain(afterCommit);
      await expect(
        rawQuery(
          storage,
          "select count(*) from public.organizations where id = $1",
          [b],
        ),
      ).rejects.toMatchObject({
        code: "42501",
        message: "requestport: no organisation is bound to this transaction",
      });
      // Measured 2026-09-29: '' after the commit, as P1 found, and NULL
      // after the refused statement. D1's reader treats both as unbound.
      const afterRefusal = await setting();
      expect(["", null], String(afterRefusal)).toContain(afterRefusal);
    } finally {
      await rawQuery(
        suiteStorage,
        "delete from public.organizations where id = $1",
        [b],
      );
    }
  });

  test("a wrapped pool read answers as this role only once the application variable is set (ruling 17)", async () => {
    const built: Storage[] = [];
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const userId = `rls-wrapped-${organizationId.slice(0, 8)}`;
    const previous = process.env[APPLICATION_DATABASE_URL_VARIABLE];
    const seed: [string, unknown[]][] = [
      [
        `insert into public."user" (id, name, email) values ($1, 'Wrapped', $1 || '@example.test')`,
        [userId],
      ],
      [
        `insert into public.organizations (id, name, slug, status) values ($1, 'Wrapped', $2, 'active')`,
        [organizationId, `rls-w-${organizationId.slice(0, 8)}`],
      ],
      [
        `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'admin', 'active')`,
        [organizationId, userId],
      ],
      [
        `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'Wrapped', 'wrapped', 'WRP', 'active')`,
        [projectId, organizationId],
      ],
    ];
    const session = await openSession(suiteStorage);
    try {
      await session.query("BEGIN");
      await session.query("SET LOCAL session_replication_role = replica");
      for (const [text, values] of seed) await session.query(text, values);
      await session.query("COMMIT");

      // Off: on a storage built while the variable is unset, the read runs
      // on the pool, unbound, and the policy raises.
      delete process.env[APPLICATION_DATABASE_URL_VARIABLE];
      built.push(loginStorageAsARootBuildsIt());
      const off = createFoundationQueryRepository((built[0] as Storage).db);
      await expect(
        off.listOrganizationProjects(userId, organizationId),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      // On: on one built once it is set, the same read runs in a transaction
      // bound to its organisation. The variable names the suite's own
      // database, so this suite's pool keeps connecting as it always did.
      process.env[APPLICATION_DATABASE_URL_VARIABLE] = process.env.DATABASE_URL;
      built.push(loginStorageAsARootBuildsIt());
      const on = createFoundationQueryRepository((built[1] as Storage).db);
      expect(
        (await on.listOrganizationProjects(userId, organizationId)).map(
          (project) => project.id,
        ),
      ).toEqual([projectId]);
    } finally {
      if (previous === undefined)
        delete process.env[APPLICATION_DATABASE_URL_VARIABLE];
      else process.env[APPLICATION_DATABASE_URL_VARIABLE] = previous;
      await Promise.all(built.map((storage) => storage.close()));
      await session.query("ROLLBACK").catch(() => undefined);
      await session.query("BEGIN");
      await session.query("SET LOCAL session_replication_role = replica");
      await session.query("delete from public.projects where id = $1", [
        projectId,
      ]);
      await session.query(
        "delete from public.organization_members where organization_id = $1",
        [organizationId],
      );
      await session.query("delete from public.organizations where id = $1", [
        organizationId,
      ]);
      await session.query(`delete from public."user" where id = $1`, [userId]);
      await session.query("COMMIT");
      session.release();
    }
  });
});

describe.sequential("dispatch after commit, bound to the command's organisation (D5, as this role)", () => {
  /*
   * The web claims and accepts outbox rows and import dispatches through
   * `boundOutboxRepository` and `boundImportTaskDispatchRepository`, handed
   * the command's organisation. As the application's login, through a
   * storage built with the variable set, each call is a short transaction
   * bound to it; through one built with it unset, it runs on the pool
   * exactly as before, where this role is refused. Seeded and removed as the
   * superuser, with triggers off.
   */
  beforeAll(createLoginRole);
  afterAll(dropLoginRole);

  test("claims and accepts A's rows, and reads A's ids, only once the variable is set", async () => {
    const built: Storage[] = [];
    const organizationId = randomUUID();
    const eventId = randomUUID();
    const outboxId = randomUUID();
    const dispatchId = randomUUID();
    const correlationId = `rls-dispatch-${organizationId.slice(0, 8)}`;
    const previous = process.env[APPLICATION_DATABASE_URL_VARIABLE];
    const session = await openSession(suiteStorage);
    const inReplica = async (statements: [string, unknown[]][]) => {
      await session.query("BEGIN");
      await session.query("SET LOCAL session_replication_role = replica");
      for (const [text, values] of statements) {
        await session.query(text, values);
      }
      await session.query("COMMIT");
    };
    try {
      await inReplica([
        [
          `insert into public.organizations (id, name, slug, status) values ($1, 'Dispatch', $2, 'active')`,
          [organizationId, `rls-d-${organizationId.slice(0, 8)}`],
        ],
        [
          `insert into public.domain_events
             (id, organization_id, aggregate_type, aggregate_id, aggregate_version,
              type, schema_version, actor, correlation_id, causation_id, data)
           values ($1, $2, 'request', $3, 1, 'request.created', 1,
                   '{"type":"user","id":"x"}'::jsonb, $4, $4, '{}'::jsonb)`,
          [eventId, organizationId, randomUUID(), correlationId],
        ],
        [
          `insert into public.outbox (id, event_id) values ($1, $2)`,
          [outboxId, eventId],
        ],
        [
          `insert into public.import_task_dispatches
             (id, organization_id, import_run_id, task_kind, task_payload)
           values ($1, $2, $3, 'analyze', '{}'::jsonb)`,
          [dispatchId, organizationId, randomUUID()],
        ],
      ]);

      // Off: on a storage built while the variable is unset, on the pool,
      // unbound, and the policies refuse this role.
      delete process.env[APPLICATION_DATABASE_URL_VARIABLE];
      built.push(loginStorageAsARootBuildsIt());
      const off = (built[0] as Storage).db;
      await expect(
        boundOutboxRepository(organizationId, off).idsForEvents([eventId]),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(
        boundImportTaskDispatchRepository(organizationId, off).claimOne(
          dispatchId,
          "web-import:rls",
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });

      // On: on one built once it is set, each call is its own transaction,
      // bound to A.
      process.env[APPLICATION_DATABASE_URL_VARIABLE] = process.env.DATABASE_URL;
      built.push(loginStorageAsARootBuildsIt());
      const storage = built[1] as Storage;
      const outbox = boundOutboxRepository(organizationId, storage.db);
      const dispatches = boundImportTaskDispatchRepository(
        organizationId,
        storage.db,
      );
      expect(await outbox.idsForEvents([eventId])).toEqual([{ id: outboxId }]);
      expect(await outbox.idsForCorrelation(correlationId)).toEqual([
        { id: outboxId },
      ]);
      expect(await outbox.loadWebhookDelivery(randomUUID())).toBeNull();
      expect(await outbox.claimOne(outboxId, "web:rls")).toMatchObject({
        id: outboxId,
        eventId,
        attemptCount: 1,
      });
      await outbox.markAccepted(outboxId, "web:rls", "run_rls");
      expect(
        await dispatches.claimOne(dispatchId, "web-import:rls"),
      ).toMatchObject({ id: dispatchId, taskKind: "analyze", attemptCount: 1 });
      await dispatches.markAccepted(dispatchId, "web-import:rls", "run_rls_i");

      const states = await rawQuery<{ state: string; trigger_run_id: string }>(
        suiteStorage,
        `select state, trigger_run_id from public.outbox where id = $1
         union all
         select state, trigger_run_id from public.import_task_dispatches where id = $2`,
        [outboxId, dispatchId],
      );
      expect(states.rows).toEqual([
        { state: "accepted", trigger_run_id: "run_rls" },
        { state: "accepted", trigger_run_id: "run_rls_i" },
      ]);

      // Bound to another organisation, A's rows are not there to claim.
      const other = boundOutboxRepository(randomUUID(), storage.db);
      expect(await other.idsForEvents([eventId])).toEqual([]);
    } finally {
      if (previous === undefined)
        delete process.env[APPLICATION_DATABASE_URL_VARIABLE];
      else process.env[APPLICATION_DATABASE_URL_VARIABLE] = previous;
      await Promise.all(built.map((storage) => storage.close()));
      await session.query("ROLLBACK").catch(() => undefined);
      await inReplica([
        ["delete from public.outbox where id = $1", [outboxId]],
        ["delete from public.domain_events where id = $1", [eventId]],
        [
          "delete from public.import_task_dispatches where id = $1",
          [dispatchId],
        ],
        ["delete from public.organizations where id = $1", [organizationId]],
      ]);
      session.release();
    }
  });
});

describe("a definer function that writes runs only in a transaction (§2.5.0 item 7, D16)", () => {
  /*
   * The pool's read retry would take `select requestport_private.x(…)` for a
   * read and could send it twice; the write is in the function's body, where
   * the retry's text check cannot see it. So each writing function is called
   * inside a transaction its method opens, or in a savepoint of the one it
   * is handed.
   */
  const writing = [
    "consume_slack_oauth_state",
    "lock_slack_action_token",
    "record_provider_callback",
    "revoke_user_client_oauth_grants",
  ];
  const opensATransaction =
    /(?:\.transaction\(|withSlackTransaction\(|inTenantTransaction\()/u;

  /** Each call's enclosing method, from its `    async` line to the call. */
  function callers(text: string, name: string) {
    const found: string[] = [];
    let at = text.indexOf(`requestport_private.${name}(`);
    while (at !== -1) {
      found.push(text.slice(text.lastIndexOf("\n    async ", at), at));
      at = text.indexOf(`requestport_private.${name}(`, at + 1);
    }
    return found;
  }

  test("each is called inside a transaction its method opens", () => {
    // The detector fires on a call made straight on the pool.
    expect(
      callers(
        "\n    async bad() {\n      await database.execute(sql`select requestport_private.record_provider_callback(1)`);",
        "record_provider_callback",
      ).every((method) => opensATransaction.test(method)),
    ).toBe(false);

    const files = sourceFiles().filter((file) =>
      file.includes("/packages/db/src/"),
    );
    for (const name of writing) {
      const methods = files.flatMap((file) =>
        callers(readFileSync(file, "utf8"), name),
      );
      expect(methods.length, name).toBeGreaterThan(0);
      for (const method of methods) {
        expect(
          opensATransaction.test(method),
          `${name}: ${method.slice(0, 80)}`,
        ).toBe(true);
      }
    }
  });
});

/*
 * Step 8, the receipts contract (manifest-i2.md §2.1, §2.3, §2.9 "Receipts",
 * §3 step 8; r9-rulings.md 220). 0024 gives command_receipts one policy that
 * reads the binding as security_audit_records' WITH CHECK reads it (0019,
 * D12): with an organisation bound, a receipt is that organisation's; with
 * none bound, a receipt has no organisation. Then ENABLE and FORCE.
 *
 * The first case reads the catalogue on a session of the suite's storage,
 * with no transaction. Each case after it is one transaction on such a
 * session, rolled back: the rows are seeded as that storage's role, and the
 * case then acts, by SET LOCAL ROLE, as the application's login role, which
 * `asLoginInTransaction` asserts is neither a superuser nor BYPASSRLS (its
 * membership of the application group alone is how `createLoginRole` makes
 * it), or as the role the case names: requestport_maintenance for
 * retention, a BYPASSRLS probe role for the owner-shaped case. The bus cases
 * run the real AtomicCommandBus over the real command transaction manager,
 * the cancels run the repositories' own methods, and the mutation-receipt
 * case calls the receipt functions in savepoints it binds. Each command's
 * or method's binding ends with it, as its own transaction's would.
 */
const RECEIPT_SECRET = "rls-step8-receipt-fingerprint-secret-00000001";
const PROBE_COMMAND = "rls.receipt_probe";

/** A tenant command that answers its input, counting its executions. */
function receiptProbeRegistry(executions: { count: number }) {
  return new CommandRegistry().register<{ value: string }, JsonObject>({
    name: PROBE_COMMAND,
    parse: (input) => input as { value: string },
    async authorize() {},
    async execute(_uow, _context, input) {
      executions.count += 1;
      return {
        result: { value: input.value, execution: executions.count },
        events: [],
      };
    },
  });
}

/** The tenant bus, its binding taken from the context as production's is. */
function receiptProbeBus(tx: Tx, executions: { count: number }) {
  return new AtomicCommandBus({
    registry: receiptProbeRegistry(executions),
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(tx as unknown as Database),
      tx,
    ),
    fingerprintSecret: RECEIPT_SECRET,
  });
}

/** The same bus with the binding it hands its manager dropped: a receipt with no organisation. */
function unboundProbeBus(tx: Tx, executions: { count: number }) {
  const manager = createCommandTransactionManager(tx as unknown as Database);
  return new AtomicCommandBus({
    registry: receiptProbeRegistry(executions),
    transactions: endingEachCommandBinding(
      { run: (work) => manager.run(work) },
      tx,
    ),
    fingerprintSecret: RECEIPT_SECRET,
  });
}

function probeContext(
  organizationId: string,
  userId: string,
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set<string>(),
    credentialId: `rls-step8-${userId}`,
    correlationId: randomUUID(),
  };
}

/** The receipt the bus keys `idempotencyKey` to, for this actor and command. */
function probeReceiptKey(userId: string, idempotencyKey: string) {
  return {
    actorFingerprint: actorFingerprint({ type: "user", id: userId }),
    commandName: PROBE_COMMAND,
    idempotencyFingerprint: keyedFingerprint(RECEIPT_SECRET, idempotencyKey),
  };
}

/** `find`, in a command transaction bound as `binding` says. */
function findReceipt(
  tx: Tx,
  key: ReturnType<typeof probeReceiptKey>,
  binding: { organizationId?: string; userId?: string },
) {
  return endingEachCommandBinding(
    createCommandTransactionManager(tx as unknown as Database),
    tx,
  ).run((uow) => uow.commandReceipts.find(key), binding);
}

/** The SQLSTATE of a query error, as drizzle wraps it or bare. */
function sqlState(error: unknown) {
  const wrapped = error as { code?: unknown; cause?: { code?: unknown } };
  return String(wrapped.cause?.code ?? wrapped.code);
}

/** Two active organisations, and a user, seeded as the suite's storage. */
async function seedReceiptTenants(session: TestSession) {
  const tag = randomUUID().slice(0, 8);
  const a = randomUUID();
  const b = randomUUID();
  await session.query(
    `insert into public.organizations (id, name, slug, status)
     values ($1, $3, $3, 'active'), ($2, $4, $4, 'active')`,
    [a, b, `rls-s8a-${tag}`, `rls-s8b-${tag}`],
  );
  return { a, b, userId: `rls-s8-user-${tag}`, tag };
}

/** A receipt seeded as the suite's storage, with `organizationId` or none. */
async function seedReceipt(
  session: TestSession,
  organizationId: string | null,
  options: { expired?: boolean } = {},
) {
  const tag = randomUUID();
  const { rows } = await session.query<{ id: string }>(
    `insert into public.command_receipts
       (actor_fingerprint, command_name, idempotency_fingerprint,
        normalized_input_hash, result_json, expires_at, organization_id)
     values ($1, 'rls.seeded', $1, 'h', '{"seeded": true}'::jsonb,
             clock_timestamp() + ($2 || ' hours')::interval, $3)
     returning id::text as id`,
    [`rls-s8-${tag}`, options.expired ? "-1" : "1", organizationId],
  );
  return (rows[0] as { id: string }).id;
}

/** Whether the receipts policy applies to the session's current role. */
async function receiptsPolicyApplies(session: TestSession) {
  const { rows } = await session.query<{ active: boolean }>(
    "select row_security_active('public.command_receipts') as active",
  );
  return (rows[0] as { active: boolean }).active;
}

/** How many of `ids` the session's current role and binding can see. */
async function visibleReceipts(session: TestSession, ids: string[]) {
  const { rows } = await session.query<{ n: number }>(
    "select count(*)::int as n from public.command_receipts where id = any($1::uuid[])",
    [ids],
  );
  return (rows[0] as { n: number }).n;
}

/** The organisation each receipt was saved with, read as the suite's storage. */
async function receiptOrganizations(
  session: TestSession,
  key: ReturnType<typeof probeReceiptKey>,
) {
  let organizations: (string | null)[] = [];
  await asSessionLogin(session, async () => {
    const { rows } = await session.query<{ organization_id: string | null }>(
      `select organization_id from public.command_receipts
        where actor_fingerprint = $1 and command_name = $2 and idempotency_fingerprint = $3`,
      [key.actorFingerprint, key.commandName, key.idempotencyFingerprint],
    );
    organizations = rows.map((row) => row.organization_id);
  });
  return organizations;
}

/**
 * Runs `work` in a transaction that is rolled back: `seed` as the suite's
 * storage, then the rest as the application's login role, asserted to be
 * neither a superuser nor BYPASSRLS. Nothing is bound when `work` starts.
 */
async function asLoginInTransaction<S>(
  seed: (session: TestSession) => Promise<S>,
  work: (tx: Tx, seeded: S, session: TestSession) => Promise<void>,
) {
  const session = await openSession(suiteStorage);
  try {
    const ended = await session.db
      .transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        const seeded = await seed(session);
        await session.query(`SET LOCAL ROLE "${login.name}"`);
        const { rows } = await session.query(
          `select current_user = $1 as login, r.rolsuper, r.rolbypassrls
             from pg_catalog.pg_roles r where r.rolname = current_user`,
          [login.name],
        );
        expect(rows).toEqual([
          { login: true, rolsuper: false, rolbypassrls: false },
        ]);
        expect(await boundOrganization(tx)).toBeNull();
        await work(tx, seeded, session);
        throw new LaneRollback();
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // The case's own failure, unwrapped, when it is not the rollback.
    if (!(ended instanceof LaneRollback)) throw ended;
  } finally {
    session.release();
  }
}

describe.sequential("the receipts contract, as the application's login role (§3 step 8, ruling 220)", () => {
  beforeAll(createLoginRole);
  afterAll(dropLoginRole);

  test("command_receipts has row security enabled and forced, and one policy", async () => {
    const session = await openSession(suiteStorage);
    try {
      const { rows } = await session.query(
        `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
           (select count(*)::int from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies
         from pg_catalog.pg_class c where c.oid = 'public.command_receipts'::regclass`,
      );
      expect(rows).toEqual([{ enabled: true, forced: true, policies: 1 }]);
    } finally {
      session.release();
    }
  });

  test("bound to its organisation, the tenant bus saves its receipt with that organisation, finds it, and replays it", async () => {
    await asLoginInTransaction(seedReceiptTenants, async (tx, s, session) => {
      expect(await receiptsPolicyApplies(session)).toBe(true);
      const executions = { count: 0 };
      const bus = receiptProbeBus(tx, executions);
      const idempotencyKey = `rls-s8-own-${s.tag}`;
      const run = () =>
        bus.execute({
          name: PROBE_COMMAND,
          input: { value: "own" },
          context: probeContext(s.a, s.userId),
          meta: { idempotencyKey, expectedVersion: 0 },
        });

      expect(await run()).toEqual({ value: "own", execution: 1 });
      const key = probeReceiptKey(s.userId, idempotencyKey);
      expect(await receiptOrganizations(session, key)).toEqual([s.a]);
      expect(
        await findReceipt(tx, key, { organizationId: s.a, userId: s.userId }),
      ).toEqual({
        normalizedInputHash: normalizedInputHash({ value: "own" }),
        aggregateId: undefined,
        result: { value: "own", execution: 1 },
      });
      // The replay answers the stored result; the command does not run again.
      expect(await run()).toEqual({ value: "own", execution: 1 });
      expect(executions.count).toBe(1);
    });
  });

  test("bound to another organisation, a receipt is invisible and its replay misses: the command runs, and the global key's refusal answers idempotency_conflict", async () => {
    await asLoginInTransaction(seedReceiptTenants, async (tx, s, session) => {
      const executions = { count: 0 };
      const bus = receiptProbeBus(tx, executions);
      const idempotencyKey = `rls-s8-other-${s.tag}`;
      const key = probeReceiptKey(s.userId, idempotencyKey);
      const run = (organizationId: string) =>
        bus.execute({
          name: PROBE_COMMAND,
          input: { value: "b's" },
          context: probeContext(organizationId, s.userId),
          meta: { idempotencyKey, expectedVersion: 0 },
        });

      expect(await run(s.b)).toEqual({ value: "b's", execution: 1 });
      expect(await receiptOrganizations(session, key)).toEqual([s.b]);
      // With nothing bound (the user-mode arm), B's receipt is not visible
      // either: only receipts with no organisation are.
      const unbound = await session.query(
        "select 1 from public.command_receipts where idempotency_fingerprint = $1",
        [key.idempotencyFingerprint],
      );
      expect(unbound.rowCount).toBe(0);

      expect(
        await findReceipt(tx, key, { organizationId: s.a, userId: s.userId }),
      ).toBeNull();
      // B's stored result is never the answer under A: the bus misses the
      // receipt, runs the command, and the unique key, which no policy
      // narrows, refuses the second receipt (manifest-i2.md §2.1). `save`
      // answers that refusal as the key's conflict, not as a raw 23505, and
      // the command's transaction rolls back.
      const refused = await run(s.a).then(
        () => "answered",
        (error: unknown) =>
          error instanceof DomainError ? error.code : sqlState(error),
      );
      expect(refused).toBe("idempotency_conflict");
      expect(executions.count).toBe(2);
      expect(await receiptOrganizations(session, key)).toEqual([s.b]);
    });
  });

  test("a tenant receipt saved with no organisation is invisible to the bus bound to an organisation, which runs the command again and is answered idempotency_conflict by the key (§2.1, the reason for gate (ii))", async () => {
    await asLoginInTransaction(seedReceiptTenants, async (tx, s, session) => {
      const executions = { count: 0 };
      const idempotencyKey = `rls-s8-legacy-${s.tag}`;
      const key = probeReceiptKey(s.userId, idempotencyKey);
      const request = (organizationId: string) => ({
        name: PROBE_COMMAND,
        input: { value: "legacy" },
        context: probeContext(organizationId, s.userId),
        meta: { idempotencyKey, expectedVersion: 0 },
      });

      // A receipt as one written before step 2's code: no organisation.
      expect(
        await unboundProbeBus(tx, executions).execute(request(s.a)),
      ).toEqual({ value: "legacy", execution: 1 });
      expect(await receiptOrganizations(session, key)).toEqual([null]);

      // Not the replay the same input would have had before the policy.
      const retried = await receiptProbeBus(tx, executions)
        .execute(request(s.a))
        .then(
          () => "replayed",
          (error: unknown) =>
            error instanceof DomainError ? error.code : sqlState(error),
        );
      expect(retried).toBe("idempotency_conflict");
      expect(executions.count).toBe(2);
      expect(await receiptOrganizations(session, key)).toEqual([null]);
    });
  });

  test("a mutation receipt saved under one organisation is invisible under another, and saving its key there answers idempotency_conflict", async () => {
    await asLoginInTransaction(seedReceiptTenants, async (tx, s, session) => {
      const key: MutationReceiptKey = {
        actorFingerprint: actorFingerprint({ type: "user", id: s.userId }),
        commandName: "rls.mutation_probe",
        idempotencyFingerprint: keyedFingerprint(
          RECEIPT_SECRET,
          `rls-s8-mutation-${s.tag}`,
        ),
        normalizedInputHash: normalizedInputHash({ value: "mutation" }),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      };
      // Each in a savepoint of `tx`, as a repository method handed a
      // transaction opens one, bound to `organizationId`; the binding ends
      // when the savepoint settles.
      const asOrganization = async <T>(
        organizationId: string,
        work: (inner: Tx) => Promise<T>,
      ) => {
        try {
          return await tx.transaction(async (inner) => {
            await bind(session, { organizationId });
            return work(inner as Tx);
          });
        } finally {
          await bind(session, {});
        }
      };

      await asOrganization(s.a, async (inner) => {
        expect(await lockMutationReceipt(inner, key)).toBeNull();
        await saveMutationReceipt(inner, key, { result: { saved: "a" } });
      });
      expect(await receiptOrganizations(session, key)).toEqual([s.a]);

      const saved = await asOrganization(s.b, async (inner) => {
        expect(await lockMutationReceipt(inner, key)).toBeNull();
        await saveMutationReceipt(inner, key, { result: { saved: "b" } });
      }).then(
        () => "saved",
        (error: unknown) =>
          error instanceof DomainError ? error.code : sqlState(error),
      );
      expect(saved).toBe("idempotency_conflict");
      expect(await receiptOrganizations(session, key)).toEqual([s.a]);
    });
  });

  test("the user bus, with no organisation bound, saves a receipt with none, finds it and replays it, and cannot see a tenant receipt", async () => {
    await asLoginInTransaction(
      async (session) => {
        const tenants = await seedReceiptTenants(session);
        const sessionId = `rls-s8-session-${tenants.tag}`;
        // The signup guard would refuse a user nobody invited.
        await session.query("SET LOCAL session_replication_role = replica");
        await session.query(
          `insert into public."user" (id, name, email) values ($1, 'Person', $2)`,
          [tenants.userId, `${tenants.userId}@example.test`],
        );
        await session.query("SET LOCAL session_replication_role = origin");
        await session.query(
          `insert into public.session (id, token, expires_at, user_id, updated_at)
           values ($1, $1, clock_timestamp() + interval '1 hour', $2, now())`,
          [sessionId, tenants.userId],
        );
        const tenantReceipt = await seedReceipt(session, tenants.a);
        return { ...tenants, sessionId, tenantReceipt };
      },
      async (tx, s, session) => {
        const bus = new AtomicCommandBus<AuthenticatedUserCommandContext>({
          registry: createAuthenticatedUserCommandRegistry(),
          transactions: endingEachCommandBinding(
            createCommandTransactionManager(
              tx as unknown as Database,
              (name, database) => {
                if (name === "appearance")
                  return createAppearanceRepository(database);
                if (name === "commandAuthorization")
                  return createCommandAuthorizationRepository(database);
                return undefined;
              },
            ),
            tx,
          ),
          fingerprintSecret: RECEIPT_SECRET,
        });
        const idempotencyKey = `rls-s8-personal-${s.tag}`;
        const run = () =>
          bus.execute({
            name: appearancePersonalCommandName,
            input: { theme: "hivehub", density: "large", mode: "light" },
            context: {
              actor: { type: "user", id: s.userId },
              credentialId: s.sessionId,
              correlationId: randomUUID(),
            },
            meta: { idempotencyKey, expectedVersion: 0 },
          });

        const first = await run();
        expect(first).toMatchObject({ version: 1, theme: "hivehub" });
        const key = {
          actorFingerprint: actorFingerprint({ type: "user", id: s.userId }),
          commandName: appearancePersonalCommandName,
          idempotencyFingerprint: keyedFingerprint(
            RECEIPT_SECRET,
            idempotencyKey,
          ),
        };
        expect(await receiptOrganizations(session, key)).toEqual([null]);
        expect(await findReceipt(tx, key, { userId: s.userId })).toMatchObject({
          result: first,
        });
        // The replay answers the stored result: no second version.
        expect(await run()).toEqual(first);

        await bind(session, { userId: s.userId });
        expect(await visibleReceipts(session, [s.tenantReceipt])).toBe(0);
        await bind(session, {});
      },
    );
  });

  test("bound to an organisation, another organisation's receipt and a receipt with none are invisible and cannot be updated or deleted; with none bound, neither can any organisation's", async () => {
    await asLoginInTransaction(
      async (session) => {
        const tenants = await seedReceiptTenants(session);
        return {
          ...tenants,
          personal: await seedReceipt(session, null),
          own: await seedReceipt(session, tenants.a),
          other: await seedReceipt(session, tenants.b),
        };
      },
      async (_tx, s, session) => {
        // Each receipt's physical version, read as the suite's storage.
        const versions = async () => {
          let rows: { id: string; ctid: string }[] = [];
          await asSessionLogin(session, async () => {
            rows = (
              await session.query<{ id: string; ctid: string }>(
                `select id::text as id, ctid::text as ctid from public.command_receipts
                  where id = any($1::uuid[]) order by id`,
                [[s.personal, s.own, s.other]],
              )
            ).rows;
          });
          return rows;
        };
        const update = (id: string) =>
          attempt(
            session,
            `update public.command_receipts set result_json = '{"planted": true}'::jsonb where id = $1`,
            [id],
          );
        const remove = (id: string) =>
          attempt(
            session,
            "delete from public.command_receipts where id = $1",
            [id],
          );
        const before = await versions();
        expect(before).toHaveLength(3);

        await bind(session, { organizationId: s.a, userId: s.userId });
        expect(await visibleReceipts(session, [s.personal])).toBe(0);
        expect(await visibleReceipts(session, [s.other])).toBe(0);
        expect(await visibleReceipts(session, [s.own])).toBe(1);
        for (const id of [s.other, s.personal]) {
          expect(await update(id)).toMatchObject({ rowCount: 0 });
          expect(await remove(id)).toMatchObject({ rowCount: 0 });
        }
        await bind(session, { userId: s.userId });
        expect(await visibleReceipts(session, [s.personal])).toBe(1);
        expect(await visibleReceipts(session, [s.own, s.other])).toBe(0);
        for (const id of [s.own, s.other]) {
          expect(await update(id)).toMatchObject({ rowCount: 0 });
          expect(await remove(id)).toMatchObject({ rowCount: 0 });
        }
        await bind(session, {});
        // Not one receipt the attempts above could not see has changed.
        expect(await versions()).toEqual(before);

        // The control: bound to A, A's own receipt is updated.
        await bind(session, { organizationId: s.a, userId: s.userId });
        expect(await update(s.own)).toMatchObject({ rowCount: 1 });
        await bind(session, {});
      },
    );
  });

  test("a write that names another organisation, or the other mode's, is refused by WITH CHECK", async () => {
    await asLoginInTransaction(
      async (session) => {
        const tenants = await seedReceiptTenants(session);
        return { ...tenants, own: await seedReceipt(session, tenants.a) };
      },
      async (_tx, s, session) => {
        const insert = (organizationId: string | null) =>
          attempt(
            session,
            `insert into public.command_receipts
               (actor_fingerprint, command_name, idempotency_fingerprint,
                normalized_input_hash, result_json, expires_at, organization_id)
             values (gen_random_uuid()::text, 'rls.planted', gen_random_uuid()::text,
                     'h', '{}'::jsonb, clock_timestamp() + interval '1 hour', $1)`,
            [organizationId],
          );

        await bind(session, { organizationId: s.a, userId: s.userId });
        expect(await insert(s.b)).toEqual({ code: "42501" });
        expect(await insert(null)).toEqual({ code: "42501" });
        expect(
          await attempt(
            session,
            "update public.command_receipts set organization_id = $2 where id = $1",
            [s.own, s.b],
          ),
        ).toEqual({ code: "42501" });
        expect(await insert(s.a)).toMatchObject({ rowCount: 1 });

        await bind(session, { userId: s.userId });
        expect(await insert(s.a)).toEqual({ code: "42501" });
        expect(await insert(null)).toMatchObject({ rowCount: 1 });
        await bind(session, {});
      },
    );
  });

  test("retention's definer function still deletes expired receipts of every organisation, and of none", async () => {
    await asLoginInTransaction(
      async (session) => {
        const tenants = await seedReceiptTenants(session);
        return {
          ...tenants,
          expired: [
            await seedReceipt(session, tenants.a, { expired: true }),
            await seedReceipt(session, tenants.b, { expired: true }),
            await seedReceipt(session, null, { expired: true }),
          ],
          live: await seedReceipt(session, tenants.a),
        };
      },
      async (_tx, s, session) => {
        // As the login, bound to A, one of the three expired receipts is
        // visible. The function runs as requestport_definer, which has
        // BYPASSRLS, so neither a binding nor FORCE narrows what it selects.
        await bind(session, { organizationId: s.a });
        expect(await visibleReceipts(session, s.expired)).toBe(1);
        await bind(session, {});
        await session.query("RESET ROLE");
        await session.query("SET LOCAL ROLE requestport_maintenance");
        const { rows } = await session.query<{ deleted: number }>(
          "select deleted from requestport_private.retention_cleanup('command_receipt', 1000)",
        );
        expect(Number(rows[0]?.deleted)).toBeGreaterThanOrEqual(3);
        await session.query("RESET ROLE");
        expect(await visibleReceipts(session, s.expired)).toBe(0);
        expect(await visibleReceipts(session, [s.live])).toBe(1);
      },
    );
  });

  /*
   * The two issuance cancels open a transaction of their own, as the issuing
   * services call them on the pool (packages/core's api-key-service,
   * packages/auth's operator-credential-service), and find the pending
   * receipt their reservation saved under its organisation. Unbound, the
   * policy shows them only receipts with no organisation, so the pending one
   * would stay and the issuance could not be retried for the receipt's 30
   * days. Each binds the organisation the reservation carries.
   */
  test("cancelling an agent credential issuance, with nothing bound, removes the pending receipt its reservation saved", async () => {
    await asLoginInTransaction(seedDefinerFixture, async (tx, f, session) => {
      expect(await receiptsPolicyApplies(session)).toBe(true);
      const auth = endingEachMethodBinding(createAgentAuthRepository(tx), tx);
      const receipt = await auth.reserveCredentialIssuance({
        actorUserId: f.userId,
        organizationId: f.organizationId,
        projectId: f.projectId,
        idempotencyKey: `rls-s8-agent-${f.slug}`,
        expectedVersion: 0,
        fingerprintSecret: RECEIPT_SECRET,
        normalizedInput: { name: "Cancelled" },
      });
      expect(receipt).toMatchObject({
        reserved: true,
        result: { status: "pending" },
      });
      expect(await boundOrganization(tx)).toBeNull();
      expect(await receiptOrganizations(session, receipt.key)).toEqual([
        f.organizationId,
      ]);

      await auth.cancelCredentialIssuance(receipt);
      expect(await boundOrganization(tx)).toBeNull();
      expect(await receiptOrganizations(session, receipt.key)).toEqual([]);
    });
  });

  test("cancelling an operator credential issuance, with nothing bound, removes the pending receipt its reservation saved", async () => {
    await asLoginInTransaction(
      async (session) => {
        const f = await seedDefinerFixture(session);
        const sessionId = `rls-s8-operator-session-${f.slug}`;
        await session.query(
          `insert into public.session (id, token, expires_at, user_id, updated_at)
           values ($1, $1, clock_timestamp() + interval '1 hour', $2, now())`,
          [sessionId, f.userId],
        );
        return { ...f, sessionId };
      },
      async (tx, f, session) => {
        expect(await receiptsPolicyApplies(session)).toBe(true);
        const operators = endingEachMethodBinding(
          createOperatorCredentialRepository(tx),
          tx,
        );
        const receipt = await operators.reserveIssuance({
          actorUserId: f.userId,
          sessionId: f.sessionId,
          organizationId: f.organizationId,
          projectId: null,
          commandName: "issue_operator_credential",
          idempotencyKey: `rls-s8-operator-${f.slug}`,
          fingerprintSecret: RECEIPT_SECRET,
          normalizedInput: { name: "Cancelled" },
        });
        expect(receipt).toMatchObject({
          reserved: true,
          result: { status: "pending" },
        });
        expect(await boundOrganization(tx)).toBeNull();
        expect(await receiptOrganizations(session, receipt.key)).toEqual([
          f.organizationId,
        ]);

        await operators.cancelIssuance(receipt);
        expect(await boundOrganization(tx)).toBeNull();
        expect(await receiptOrganizations(session, receipt.key)).toEqual([]);
      },
    );
  });

  test("the owner-shaped lane, BYPASSRLS, sees every receipt whatever is bound", async () => {
    await asLoginInTransaction(
      async (session) => {
        const tenants = await seedReceiptTenants(session);
        return {
          ...tenants,
          ids: [
            await seedReceipt(session, tenants.a),
            await seedReceipt(session, tenants.b),
            await seedReceipt(session, null),
          ],
        };
      },
      async (_tx, s, session) => {
        await bind(session, { organizationId: s.a });
        expect(await visibleReceipts(session, s.ids)).toBe(1);
        await bind(session, {});
        await session.query("RESET ROLE");
        await becomeOwnerShaped(session);
        expect(await visibleReceipts(session, s.ids)).toBe(3);
        await bind(session, { organizationId: s.a });
        expect(await visibleReceipts(session, s.ids)).toBe(3);
        await bind(session, { userId: s.userId });
        expect(await visibleReceipts(session, s.ids)).toBe(3);
        await bind(session, {});
      },
    );
  });
});

/**
 * Skips the running case, naming `paths`, when the tree declares itself
 * public (manifest-j.md §2.4 item 6, Appendix A.3; ruling 92):
 * `./shared-databases.js`'s `kind` is "public" there, as the seed's
 * substitution makes it, and the seed does not carry `paths`.
 * `scripts/workspace-contract.test.mjs` fails if that `kind` differs from
 * `scripts/hosted-deployment.mjs`'s, the marker the scripts' cases read. In
 * this private tree it skips nothing, so a missing path still fails the case,
 * and `scripts/private-paths.test.mjs` fails if a path named here is gone.
 */
function skipInPublicTree(ctx: TestContext, ...paths: string[]) {
  ctx.skip(
    hostedDeploymentKind === "public",
    `the public tree does not carry ${paths.join(", ")} (packages/db/src/shared-databases.ts declares kind "public")`,
  );
}

describe("step 2's merge preconditions (manifest-i2.md §3 step 2, §4 Merges after) — red on purpose until each is met", () => {
  /*
   * This code needs 0019's schema, and the bus's binding, before it may
   * deploy: without the first, every receipt insert, the agent credential
   * lookups and the membership listing fail in production (they name the
   * column and the requestport_private functions 0019 creates); without the
   * second, every bus-run tenant command writes a NULL receipt organisation
   * into the rows step 8's gate counts. Vercel deploys on merge and the
   * owner applies migrations afterwards (R2), so nothing else stops a merge
   * that comes too early. Each case turns green by itself once its
   * precondition is met on the branch this merges from.
   */
  const repositoryRoot = new URL("../../../", import.meta.url);

  test("the expand migration is recorded applied in production-migration-state.json", (ctx) => {
    skipInPublicTree(
      ctx,
      "docs/implementation/production-migration-state.json",
    );
    const journal = JSON.parse(
      readFileSync(
        new URL("packages/db/migrations/meta/_journal.json", repositoryRoot),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const expand = journal.entries.find((entry) =>
      entry.tag.endsWith("_row_security_expand"),
    );
    expect(expand, "the expand migration is in the journal").toBeDefined();
    const state = JSON.parse(
      readFileSync(
        new URL(
          "docs/implementation/production-migration-state.json",
          repositoryRoot,
        ),
        "utf8",
      ),
    ) as { tag: string };
    const applied = Number(/^applied=(\d+)$/u.exec(state.tag)?.[1] ?? "0");
    expect(
      applied,
      `production has ${applied} migrations applied; ${expand?.tag} is number ${(expand?.idx ?? 0) + 1}`,
    ).toBeGreaterThan(expand?.idx ?? Number.POSITIVE_INFINITY);
  });

  test("the command bus passes its binding to the transaction manager (F.1's hand-over)", () => {
    const text = readFileSync(
      new URL("packages/domain/src/shared/command.ts", repositoryRoot),
      "utf8",
    );
    const call = "this.dependencies.transactions.run(";
    const start = text.indexOf(call);
    expect(start, "the bus's transactions.run call").toBeGreaterThan(-1);
    // The call's top-level arguments, counted by commas outside brackets and
    // strings: the work alone is one; the work and a binding are two.
    let depth = 0;
    let quote: string | undefined;
    let commas = 0;
    let at = start + call.length;
    for (; at < text.length; at += 1) {
      const character = text[at] as string;
      if (quote) {
        if (character === "\\") at += 1;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'" || character === "`")
        quote = character;
      else if ("([{".includes(character)) depth += 1;
      else if (")]}".includes(character)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === "," && depth === 0) commas += 1;
    }
    const trailing = /,\s*$/u.test(text.slice(start + call.length, at));
    expect(
      commas - (trailing ? 1 : 0),
      "arguments after the work: a binding",
    ).toBeGreaterThanOrEqual(1);
  });
});
