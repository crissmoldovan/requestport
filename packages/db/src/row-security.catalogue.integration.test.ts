import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "./client.js";
import { inTurn } from "./in-turn.js";
import { tenantWrappingEnabled } from "./tenant-context.js";
import {
  CREDENTIAL_LOCK_DEFINER_GRANTS,
  CREDENTIAL_LOCK_FUNCTIONS,
  PROCESSOR_GRANTS,
  WORKER_DEFINER_GRANTS,
  WORKER_FUNCTIONS,
  workerFunctionAcl,
} from "./test-support/worker-grants.js";
import { openSession, type TestSession } from "./testing.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
 * The row-level security catalogue ratchet (plan 13, Track I.2;
 * manifest-i2.md §2.1, §2.5.0 items 3-4, §2.9, §2.10).
 *
 * It reads the migrated catalogue and holds every table in `public` to one of
 * two shapes. A table with an `organization_id` column, the root and the five
 * indirect tables are tenant-owned: row security enabled, exactly one
 * permissive policy whose expressions are the expected predicate, and the
 * application group's grants exactly as §2.10 derives them. Every other table
 * is in GLOBAL_TABLES with its reason, and carries no policy — except the one
 * user policy of D1. A table that is neither fails, so a track that adds a
 * table after step 1 fails here until it ships its own treatment (ruling 47).
 * `command_receipts` is tenant-owned from step 8 (migration 0024), held to
 * its own expression, as `security_audit_records` is; 0024 forced its row
 * security before step 5. From step 5's contract (migration 0025) every
 * tenant table has row security forced, and no other table does.
 *
 * Every check is also shown failing once, against a catalogue changed inside a
 * transaction that is rolled back, or, for command_receipts' checks and
 * step 5's FORCE check on an existing tenant table, against a copy of the
 * catalogue changed in memory.
 *
 * From I.2b's b1 (migration 0020) it also holds the worker roles' grants:
 * the tenant processor's matrix, and nothing for the dispatcher or the
 * maintenance role, whose grants here are therefore problems like any other
 * role's (manifest-i2.md §5.1). worker-row-security.integration.test.ts
 * checks them from the other side, as the roles. From b5 (migration 0023)
 * each worker function is executable by its group alone: neither the
 * migrating role nor the owner holds an entry on it. From I.2's step 5 (the
 * contract migration) the same holds for the lookups and the two credential
 * locks, and the application group no longer reads signup_allowlist.
 */

afterAll(async () => {
  await suiteStorage.close();
});

const APPLICATION = "requestport_application";
const DEFINER = "requestport_definer";
const DISPATCHER = "requestport_dispatcher";
const PROCESSOR = "requestport_tenant_processor";
const MAINTENANCE = "requestport_maintenance";

const ROOT_TABLE = "organizations";

/** Tenant-owned through a single-column foreign key (§2.1, D2). */
const INDIRECT_TABLES: Record<string, { column: string; parent: string }> = {
  outbox: { column: "event_id", parent: "domain_events" },
  request_acceptance_criteria: { column: "request_id", parent: "requests" },
  request_labels: { column: "request_id", parent: "requests" },
  slack_delivery_operations: {
    column: "installation_id",
    parent: "slack_installations",
  },
  webhook_attempts: { column: "delivery_id", parent: "webhook_deliveries" },
};

/**
 * Tables with no tenant policy, each with its reason (§2.1). An R4 append
 * point (ruling 52): a track that adds a global table appends its line and
 * keeps everyone else's; never sort.
 */
const GLOBAL_TABLES: readonly (readonly [string, string])[] = [
  ["user", "Better Auth identity, read before any organisation is known"],
  ["session", "Better Auth session, looked up by token"],
  ["account", "Better Auth account, looked up by user"],
  ["verification", "Better Auth verification, looked up by identifier"],
  ["jwks", "Better Auth signing keys"],
  ["apikey", "Better Auth API keys, looked up by key"],
  ["oauth_client", "Better Auth OAuth client, looked up by client id"],
  ["oauth_refresh_token", "Better Auth token, looked up by token"],
  ["oauth_access_token", "Better Auth token, looked up by token"],
  ["oauth_consent", "Better Auth consent, keyed by user and client"],
  ["oauth_resource", "Better Auth plugin state (K.2), keyed by identifier"],
  [
    "oauth_client_resource",
    "Better Auth plugin state (K.2), keyed by client and resource",
  ],
  ["oauth_client_assertion", "Better Auth plugin state (K.2), keyed by id"],
  [
    "user_appearance_preferences",
    "one row per user across organisations; carries D1's user policy",
  ],
  [
    "signup_allowlist",
    "addresses allowed to sign up, read at sign-up before any organisation",
  ],
  ["rate_limit_buckets", "counts per principal fingerprint; no tenant content"],
  ["dispatcher_receipts", "outbox id, task and run id; no tenant content"],
  [
    "provider_callback_receipts",
    "provider event ids and body digests; no tenant content",
  ],
];

const bound =
  "( SELECT requestport_private.bound_organization_id() AS bound_organization_id)";
const directPredicate = `(organization_id = ${bound})`;
// pg_get_expr starts a CASE on a line of its own.
const auditWithCheck = `
CASE
    WHEN (NULLIF(current_setting('requestport.organization_id'::text, true), ''::text) IS NOT NULL) THEN (organization_id = (NULLIF(current_setting('requestport.organization_id'::text, true), ''::text))::uuid)
    ELSE ((organization_id IS NULL) AND (actor_type = 'user'::text) AND (actor_id = NULLIF(current_setting('requestport.user_id'::text, true), ''::text)))
END`;
const userPredicate =
  "(user_id = ( SELECT requestport_private.bound_user_id() AS bound_user_id))";
// Step 8 (0024), D1's other nullif arm: the organisation bound, or with none
// bound (the session-only user bus), no organisation. USING and WITH CHECK.
const receiptsPredicate = `
CASE
    WHEN (NULLIF(current_setting('requestport.organization_id'::text, true), ''::text) IS NOT NULL) THEN (organization_id = (NULLIF(current_setting('requestport.organization_id'::text, true), ''::text))::uuid)
    ELSE (organization_id IS NULL)
END`;

function indirectPredicate(table: string) {
  const { column, parent } = INDIRECT_TABLES[table] as {
    column: string;
    parent: string;
  };
  return `(EXISTS ( SELECT 1\n   FROM public.${parent} parent\n  WHERE (parent.id = ${table}.${column})))`;
}

/** The expected policy of a table, or none. */
function expectedPolicy(
  table: string,
  keyed: boolean,
): { name: string; qual: string; withCheck: string } | null {
  if (table === ROOT_TABLE) {
    const predicate = `(id = ${bound})`;
    return {
      name: "requestport_tenant",
      qual: predicate,
      withCheck: predicate,
    };
  }
  if (table in INDIRECT_TABLES) {
    const predicate = indirectPredicate(table);
    return {
      name: "requestport_tenant",
      qual: predicate,
      withCheck: predicate,
    };
  }
  if (table === "user_appearance_preferences") {
    return {
      name: "requestport_user",
      qual: userPredicate,
      withCheck: userPredicate,
    };
  }
  if (table === "security_audit_records") {
    return {
      name: "requestport_tenant",
      qual: directPredicate,
      withCheck: auditWithCheck,
    };
  }
  if (table === "command_receipts") {
    return {
      name: "requestport_tenant",
      qual: receiptsPredicate,
      withCheck: receiptsPredicate,
    };
  }
  if (keyed) {
    return {
      name: "requestport_tenant",
      qual: directPredicate,
      withCheck: directPredicate,
    };
  }
  return null;
}

const S = "SELECT";
const I = "INSERT";
const U = "UPDATE";
const D = "DELETE";
const UID = "UPDATE (id)";
const betterAuth = [S, I, U, D];

/**
 * §2.10: the application group's grants, table by table. A table missing here
 * has no grant; an entry of `UPDATE (id)` is a column grant (D19).
 */
const APPLICATION_GRANTS: Record<string, readonly string[]> = {
  account: betterAuth,
  agent_credentials: [S, I, U],
  agent_installations: [S, I, UID],
  agent_oauth_grants: [S, I, U],
  agent_principals: [S, I, U],
  answers: [S, I],
  apikey: betterAuth,
  artifacts: [S, I, UID],
  command_receipts: [S, I, U, D],
  completion_reports: [S, I],
  domain_events: [S, I, UID],
  email_deliveries: [S, U],
  import_apply_reports: [S],
  import_conflicts: [S, I, U],
  import_manifest_entries: [S, I, U],
  import_runs: [S, I, U],
  import_sources: [S, I, UID],
  import_task_dispatches: [S, I, U],
  invitations: [S, I, U],
  jwks: betterAuth,
  lanes: [S, I, U],
  legacy_aliases: [S],
  legacy_mappings: [S],
  machine_workspaces: [S, I, UID],
  message_mentions: [S, I],
  messages: [S, I],
  notification_intents: [S, U],
  oauth_access_token: betterAuth,
  oauth_client: betterAuth,
  oauth_client_assertion: betterAuth,
  oauth_client_resource: betterAuth,
  oauth_consent: betterAuth,
  oauth_refresh_token: betterAuth,
  oauth_resource: betterAuth,
  operator_credentials: [S, I, U],
  organization_appearance_defaults: [S, U],
  organization_members: [S, I, U],
  organizations: [S, I, UID],
  outbox: [S, I, U],
  project_aliases: [S, I],
  project_members: [S, I, U],
  project_repositories: [S, I, U],
  project_sequences: [S, I, U],
  projects: [S, I, U],
  provider_callback_receipts: [S, I, U],
  questions: [S, I, U],
  rate_limit_buckets: [S, I, U],
  request_acceptance_criteria: [S, I],
  request_labels: [S, I],
  request_relationships: [S, I, D],
  requests: [S, I, U],
  retention_holds: [S, I, U],
  routing_rules: [S, I, U],
  security_audit_records: [I],
  session: betterAuth,
  // D13: step 5's contract revoked its SELECT. The one read is
  // signup_allowlist_eligibility.
  signup_allowlist: [],
  slack_action_tokens: [S, I, U],
  slack_deliveries: [S],
  slack_delivery_operations: [S, I, U],
  slack_installations: [S, I, U],
  slack_oauth_states: [S, I, U],
  slack_routes: [S, I, U],
  slack_user_mappings: [S, I, U],
  source_artifacts: [S, I],
  source_snapshots: [S, I, U],
  state_transitions: [I],
  user: betterAuth,
  user_appearance_preferences: [S, I, U],
  user_request_read_states: [S, I, U],
  verification: betterAuth,
  webhook_attempts: [S],
  webhook_deliveries: [S, I, UID],
  webhook_subscriptions: [S, I, U],
  work_sessions: [S, I, U],
  work_updates: [S, I],
};

/** D3: the definer holds only what 0019's fifteen bodies use… */
const DEFINER_GRANTS_0019: Record<string, readonly string[]> = {
  agent_credentials: [S],
  agent_oauth_grants: [
    S,
    "UPDATE (revoked_at)",
    "UPDATE (status)",
    "UPDATE (updated_at)",
    "UPDATE (version)",
  ],
  agent_principals: [S],
  apikey: [S],
  domain_events: [I],
  email_deliveries: [
    S,
    "UPDATE (last_provider_event_at)",
    "UPDATE (status)",
    "UPDATE (updated_at)",
  ],
  import_runs: [S],
  invitations: [S, "UPDATE (accepted_at)"],
  oauth_client: [S],
  operator_credentials: [S],
  organization_appearance_defaults: [S, I],
  organization_members: [
    S,
    I,
    "UPDATE (joined_at)",
    "UPDATE (role)",
    "UPDATE (status)",
    "UPDATE (updated_at)",
  ],
  organizations: [S, UID],
  outbox: [I],
  project_members: [S],
  projects: [S],
  provider_callback_receipts: [
    S,
    I,
    "UPDATE (outcome)",
    "UPDATE (processed_at)",
  ],
  questions: [S, UID],
  signup_allowlist: [S, UID],
  slack_action_tokens: [S, UID],
  slack_installations: [S, UID],
  slack_oauth_states: [S, "UPDATE (consumed_at)"],
  slack_user_mappings: [S, UID],
};

/** …and what 0020's seventeen add (I.2b, b1), and 0021's two (I.2b, b2). */
const DEFINER_GRANTS: Record<string, readonly string[]> = Object.fromEntries(
  [
    ...new Set([
      ...Object.keys(DEFINER_GRANTS_0019),
      ...Object.keys(WORKER_DEFINER_GRANTS),
      ...Object.keys(CREDENTIAL_LOCK_DEFINER_GRANTS),
    ]),
  ].map((table) => [
    table,
    [
      ...new Set([
        ...(DEFINER_GRANTS_0019[table] ?? []),
        ...(WORKER_DEFINER_GRANTS[table] ?? []),
        ...(CREDENTIAL_LOCK_DEFINER_GRANTS[table] ?? []),
      ]),
    ],
  ]),
);

type WorkerGroup = typeof DISPATCHER | typeof PROCESSOR | typeof MAINTENANCE;

/**
 * Every SECURITY DEFINER function, with the roles that may execute it: a
 * lookup, the application group; a trigger, nobody; a worker function, its
 * one group (0020); a credential lock, the processor and the application
 * group (0021). No other role: 0023 revoked the migrating role's grant and
 * the owner's own entry on each worker function (I.2b b5), and step 5's
 * contract the same on each lookup and credential lock, so the whole ACL of
 * each is its groups' entries, granted by the owner. A trigger's whole ACL
 * is not held: its owner's entry stays, and a trigger fires without EXECUTE
 * (§2.5.0 item 4).
 */
const DEFINER_FUNCTIONS: Record<
  string,
  "lookup" | "trigger" | "credential lock" | WorkerGroup
> = {
  ...WORKER_FUNCTIONS,
  ...Object.fromEntries(
    Object.keys(CREDENTIAL_LOCK_FUNCTIONS).map((signature) => [
      signature,
      "credential lock" as const,
    ]),
  ),
  "requestport_private.active_memberships()": "lookup",
  "requestport_private.consume_slack_oauth_state(p_state_hash text)": "lookup",
  "requestport_private.has_usable_oauth_grant(p_user_id text, p_client_id text)":
    "lookup",
  "requestport_private.invitation_eligibility(p_normalized_email text)":
    "lookup",
  "requestport_private.list_oauth_grant_binding_fingerprints(p_user_id text, p_audience text)":
    "lookup",
  "requestport_private.lock_slack_action_token(p_token_hash text, p_token_type text, p_workspace_id text, p_slack_user_id text)":
    "lookup",
  "requestport_private.record_provider_callback(p_provider text, p_event_id text, p_raw_body text, p_occurred_at timestamp with time zone, p_provider_message_id text, p_status text)":
    "lookup",
  "requestport_private.resolve_api_key_credential(p_api_key_id text, p_audience text)":
    "lookup",
  "requestport_private.resolve_oauth_grant(p_user_id text, p_client_id text, p_audience text)":
    "lookup",
  "requestport_private.resolve_operator_credential(p_api_key_id text)":
    "lookup",
  "requestport_private.revoke_user_client_oauth_grants(p_user_id text, p_client_id text)":
    "lookup",
  "requestport_private.signup_allowlist_eligibility(p_normalized_email text)":
    "lookup",
  "public.requestport_guard_frozen_import_entry()": "trigger",
  "public.requestport_guard_user_signup()": "trigger",
  "public.requestport_initialize_organization_appearance()": "trigger",
};

/** D1: the two binding readers, which are not definers, pinned exactly. */
const BINDING_READERS: Record<string, string> = {
  "requestport_private.bound_organization_id()": `
DECLARE
	bound text := nullif(pg_catalog.current_setting('requestport.organization_id', true), '');
BEGIN
	IF bound IS NULL THEN
		RAISE EXCEPTION 'requestport: no organisation is bound to this transaction'
			USING ERRCODE = '42501';
	END IF;
	RETURN bound::uuid;
END;
`,
  "requestport_private.bound_user_id()": `
DECLARE
	bound text := nullif(pg_catalog.current_setting('requestport.user_id', true), '');
BEGIN
	IF bound IS NULL THEN
		RAISE EXCEPTION 'requestport: no user is bound to this transaction'
			USING ERRCODE = '42501';
	END IF;
	RETURN bound;
END;
`,
};

type Catalogue = {
  migratingRole: string;
  tables: { name: string; rls: boolean; force: boolean; keyed: boolean }[];
  policies: {
    table: string;
    name: string;
    permissive: boolean;
    roles: string;
    command: string;
    qual: string | null;
    withCheck: string | null;
  }[];
  tableGrants: { table: string; grantee: string; privilege: string }[];
  functions: {
    signature: string;
    owner: string;
    definer: boolean;
    config: string[] | null;
    acl: string[] | null;
    language: string;
    volatility: string;
    returns: string;
    source: string;
  }[];
  functionGrants: { signature: string; grantee: string; privilege: string }[];
  schemaGrants: { schema: string; grantee: string; privilege: string }[];
};

/**
 * Reads the catalogue on a session that is already inside a transaction. The
 * path is pinned to pg_catalog for the transaction, so deparsed expressions
 * name every relation with its schema, whatever the session's path was. The
 * session is one connection, so its reads run in turn (X24).
 */
async function readCatalogue(session: TestSession): Promise<Catalogue> {
  await session.query("SET LOCAL search_path TO pg_catalog");
  const role = (column: string) =>
    `case when ${column} = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(${column}) end`;
  const signature = `n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_arguments(p.oid) || ')'`;

  const [migratingRole, tables, policies, tableGrants, columnGrants] =
    await inTurn([
      () => session.query<{ name: string }>("select current_user as name"),
      () =>
        session.query<Catalogue["tables"][number]>(
          `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force,
           exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'organization_id'
                     and not a.attisdropped) as keyed
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p')
         order by c.relname`,
        ),
      () =>
        session.query<Catalogue["policies"][number]>(
          `select c.relname as "table", p.polname as name, p.polpermissive as permissive,
           p.polroles::text as roles, p.polcmd::text as command,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as "withCheck"
         from pg_catalog.pg_policy p
         join pg_catalog.pg_class c on c.oid = p.polrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
         order by 1, 2`,
        ),
      () =>
        session.query<Catalogue["tableGrants"][number]>(
          `select c.relname as "table", ${role("a.grantee")} as grantee, a.privilege_type as privilege
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
         pg_catalog.aclexplode(c.relacl) a
         where n.nspname = 'public' and c.relkind in ('r', 'p') and a.grantee <> c.relowner`,
        ),
      () =>
        session.query<Catalogue["tableGrants"][number]>(
          `select c.relname as "table", ${role("a.grantee")} as grantee,
           a.privilege_type || ' (' || at.attname || ')' as privilege
         from pg_catalog.pg_attribute at
         join pg_catalog.pg_class c on c.oid = at.attrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
         pg_catalog.aclexplode(at.attacl) a
         where n.nspname = 'public' and c.relkind in ('r', 'p')
           and at.attnum > 0 and not at.attisdropped`,
        ),
    ]);
  const [functions, functionGrants, schemaGrants] = await inTurn([
    () =>
      session.query<Catalogue["functions"][number]>(
        `select ${signature} as signature,
         pg_catalog.pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
         p.proconfig as config, p.proacl::text[] as acl, l.lanname as language,
         p.provolatile::text as volatility,
         pg_catalog.format_type(p.prorettype, null) as returns, p.prosrc as source
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_language l on l.oid = p.prolang
       where n.nspname not in ('pg_catalog', 'information_schema')
         and n.nspname not like 'pg_toast%'
         and (p.prosecdef or n.nspname = 'requestport_private')`,
      ),
    () =>
      session.query<Catalogue["functionGrants"][number]>(
        `select ${signature} as signature, ${role("a.grantee")} as grantee,
         a.privilege_type as privilege
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
       pg_catalog.aclexplode(p.proacl) a
       where n.nspname not in ('pg_catalog', 'information_schema')
         and (p.prosecdef or n.nspname = 'requestport_private')
         and a.grantee <> p.proowner`,
      ),
    () =>
      session.query<Catalogue["schemaGrants"][number]>(
        `select n.nspname as schema, ${role("a.grantee")} as grantee, a.privilege_type as privilege
       from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
       where n.nspname in ('public', 'requestport_private') and a.grantee <> n.nspowner`,
      ),
  ]);

  return {
    migratingRole: migratingRole.rows[0]?.name ?? "",
    tables: tables.rows,
    policies: policies.rows,
    tableGrants: [...tableGrants.rows, ...columnGrants.rows],
    functions: functions.rows,
    functionGrants: functionGrants.rows,
    schemaGrants: schemaGrants.rows,
  };
}

function sorted(values: Iterable<string>) {
  return [...values].sort().join(", ");
}

/** Everything wrong with the catalogue; empty when it is as §2 says. */
function catalogueProblems(catalogue: Catalogue): string[] {
  const problems: string[] = [];
  const globals = new Map(GLOBAL_TABLES);

  for (const table of catalogue.tables) {
    const tenant =
      table.name === ROOT_TABLE || table.name in INDIRECT_TABLES || table.keyed;
    if (tenant && globals.has(table.name)) {
      problems.push(`${table.name}: tenant-owned, but in GLOBAL_TABLES`);
    }
    if (!tenant && !globals.has(table.name)) {
      problems.push(
        `${table.name}: unclassified — neither tenant-owned nor in GLOBAL_TABLES`,
      );
    }

    const expected = expectedPolicy(table.name, table.keyed);
    const policies = catalogue.policies.filter(
      (policy) => policy.table === table.name,
    );
    if (expected === null) {
      if (table.rls) problems.push(`${table.name}: row security enabled`);
      if (policies.length > 0) {
        problems.push(`${table.name}: global, but has a policy`);
      }
    } else {
      if (!table.rls) problems.push(`${table.name}: row security disabled`);
      if (policies.length !== 1) {
        problems.push(
          `${table.name}: ${policies.length} policies, expected exactly one`,
        );
      }
      for (const policy of policies) {
        const where = `${table.name}.${policy.name}`;
        if (!policy.permissive) problems.push(`${where}: restrictive`);
        if (policy.name !== expected.name) {
          problems.push(`${where}: expected the name ${expected.name}`);
        }
        if (policy.roles !== "{0}") problems.push(`${where}: has a TO clause`);
        if (policy.command !== "*") problems.push(`${where}: not FOR ALL`);
        if (policy.qual !== expected.qual) {
          problems.push(`${where}: USING is ${policy.qual}`);
        }
        if (policy.withCheck !== expected.withCheck) {
          problems.push(`${where}: WITH CHECK is ${policy.withCheck}`);
        }
      }
    }
    // Step 5's contract (0025): every tenant table forced, and no other
    // table. command_receipts is one, forced since step 8's 0024.
    if (tenant && !table.force) problems.push(`${table.name}: FORCE is off`);
    if (!tenant && table.force) {
      problems.push(`${table.name}: FORCE is on, but it is not tenant-owned`);
    }

    for (const [grantee, expectedGrants] of [
      [APPLICATION, APPLICATION_GRANTS[table.name] ?? []],
      [DEFINER, DEFINER_GRANTS[table.name] ?? []],
      [PROCESSOR, PROCESSOR_GRANTS[table.name] ?? []],
    ] as const) {
      const actual = catalogue.tableGrants
        .filter(
          (grant) => grant.table === table.name && grant.grantee === grantee,
        )
        .map((grant) => grant.privilege);
      if (sorted(actual) !== sorted(expectedGrants)) {
        problems.push(
          `${table.name}: ${grantee} holds [${sorted(actual)}], expected [${sorted(expectedGrants)}]`,
        );
      }
    }
    const others = catalogue.tableGrants.filter(
      (grant) =>
        grant.table === table.name &&
        grant.grantee !== APPLICATION &&
        grant.grantee !== DEFINER &&
        grant.grantee !== PROCESSOR,
    );
    for (const grant of others) {
      problems.push(
        `${table.name}: ${grant.privilege} granted to ${grant.grantee}`,
      );
    }
  }

  // §2.5.0 item 4: every SECURITY DEFINER function, and only the expected ones.
  const definers = catalogue.functions.filter((fn) => fn.definer);
  for (const fn of definers) {
    const kind = DEFINER_FUNCTIONS[fn.signature];
    if (kind === undefined) {
      problems.push(`${fn.signature}: an unlisted SECURITY DEFINER function`);
    }
    if (fn.owner !== DEFINER) {
      problems.push(`${fn.signature}: owned by ${fn.owner}`);
    }
    if (
      fn.config === null ||
      fn.config.length !== 1 ||
      fn.config[0] !== "search_path=pg_catalog, pg_temp"
    ) {
      problems.push(
        `${fn.signature}: proconfig is ${JSON.stringify(fn.config)}`,
      );
    }
    if (fn.acl === null) {
      problems.push(`${fn.signature}: default ACL, which includes PUBLIC`);
    }
    const grants = catalogue.functionGrants.filter(
      (grant) => grant.signature === fn.signature,
    );
    const grantees = sorted(grants.map((grant) => grant.grantee));
    const groups: readonly string[] =
      kind === "trigger" || kind === undefined
        ? []
        : kind === "credential lock"
          ? [...(CREDENTIAL_LOCK_FUNCTIONS[fn.signature] ?? [])]
          : kind === "lookup"
            ? [APPLICATION]
            : [kind];
    const expectedGrantees = sorted(groups);
    if (grantees !== expectedGrantees) {
      problems.push(
        `${fn.signature}: EXECUTE for [${grantees}], expected [${expectedGrantees}]`,
      );
    }
    // The grantees above leave out the owner's own entry. The whole ACL of
    // every function but a trigger is held too, so the owner's entry,
    // through which the migrating role inherits EXECUTE (0019), is a
    // problem: on a worker function since 0023, and on a lookup or a
    // credential lock since step 5's contract.
    if (kind !== "trigger" && kind !== undefined) {
      const expectedAcl =
        kind === DISPATCHER || kind === PROCESSOR || kind === MAINTENANCE
          ? workerFunctionAcl(kind)
          : groups.map((group) => `${group}=X/${DEFINER}`);
      if (sorted(fn.acl ?? []) !== sorted(expectedAcl)) {
        problems.push(
          `${fn.signature}: ACL is ${JSON.stringify(fn.acl)}, expected ${JSON.stringify(expectedAcl)}`,
        );
      }
    }
  }
  for (const signature of Object.keys(DEFINER_FUNCTIONS)) {
    if (!definers.some((fn) => fn.signature === signature)) {
      problems.push(`${signature}: missing, or no longer SECURITY DEFINER`);
    }
  }

  // D1: the binding readers are not definers, so their definitions are pinned.
  for (const [signature, source] of Object.entries(BINDING_READERS)) {
    const fn = catalogue.functions.find((each) => each.signature === signature);
    if (fn === undefined) {
      problems.push(`${signature}: missing`);
      continue;
    }
    if (
      fn.definer ||
      fn.language !== "plpgsql" ||
      fn.volatility !== "s" ||
      fn.owner !== catalogue.migratingRole ||
      JSON.stringify(fn.config) !== '["search_path=pg_catalog, pg_temp"]' ||
      fn.source !== source
    ) {
      problems.push(`${signature}: not the pinned definition`);
    }
    const grantees = sorted(
      catalogue.functionGrants
        .filter((grant) => grant.signature === signature)
        .map((grant) => grant.grantee),
    );
    // Every tenant policy calls bound_organization_id() as the querying
    // role, so the tenant processor executes it too (0020).
    const expectedGrantees =
      signature === "requestport_private.bound_organization_id()"
        ? sorted([APPLICATION, PROCESSOR])
        : APPLICATION;
    if (grantees !== expectedGrantees) {
      problems.push(`${signature}: EXECUTE for [${grantees}]`);
    }
  }

  // §2.5.0 item 3: nobody but the owner creates in a schema the bodies name,
  // and the application and definer groups have USAGE on both (P9).
  for (const schema of ["public", "requestport_private"]) {
    const grants = catalogue.schemaGrants.filter(
      (grant) => grant.schema === schema,
    );
    for (const grant of grants) {
      if (grant.privilege === "CREATE") {
        problems.push(`${schema}: CREATE granted to ${grant.grantee}`);
      }
    }
    // 0020: the worker groups use their functions' schema, and only the
    // processor reads public.
    const usage =
      schema === "public"
        ? [APPLICATION, DEFINER, PROCESSOR]
        : [APPLICATION, DEFINER, DISPATCHER, PROCESSOR, MAINTENANCE];
    for (const grantee of usage) {
      if (
        !grants.some(
          (grant) => grant.grantee === grantee && grant.privilege === "USAGE",
        )
      ) {
        problems.push(`${schema}: no USAGE for ${grantee}`);
      }
    }
  }
  return problems;
}

async function inRolledBackTransaction<T>(
  work: (session: TestSession) => Promise<T>,
): Promise<T> {
  const session = await openSession(suiteStorage);
  try {
    await session.query("BEGIN");
    // No change below alters an existing table: each makes its own probe, or
    // changes a grant or a function. The bound is there should one ever wait.
    await session.query("SET LOCAL lock_timeout = '5s'");
    return await work(session);
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
}

const PROBE_TABLE =
  "create table public.rp_catalogue_probe (id uuid primary key, organization_id uuid not null)";
const PROBE_POLICY =
  "create policy requestport_tenant on public.rp_catalogue_probe using (organization_id = (select requestport_private.bound_organization_id())) with check (organization_id = (select requestport_private.bound_organization_id()))";

/** The problems after `change`, which the rollback then undoes. */
function problemsAfter(change: string) {
  return inRolledBackTransaction(async (session) => {
    await session.query(change);
    return catalogueProblems(await readCatalogue(session));
  });
}

describe.sequential("the row-level security catalogue", () => {
  test("holds every table in public to its classification, policy and grants", async () => {
    const catalogue = await inRolledBackTransaction(readCatalogue);

    expect(catalogueProblems(catalogue)).toEqual([]);

    // With F.3's operator_credentials: 78 tables, 60 tenant-owned (1 root,
    // 54 direct, 5 indirect) and 18 global; 61 tables with row security and
    // 61 policies: step 1's 59 tenant tables and D1's user policy
    // (manifest-i2.md §3 step 1), and command_receipts' from step 8 (0024);
    // the 60 tenant tables forced, command_receipts by 0024 and the other 59
    // by step 5's 0025.
    const keyed = catalogue.tables.filter((table) => table.keyed);
    expect(catalogue.tables).toHaveLength(78);
    expect(keyed).toHaveLength(54);
    expect(GLOBAL_TABLES).toHaveLength(18);
    expect(catalogue.tables.filter((table) => table.rls)).toHaveLength(61);
    expect(catalogue.policies).toHaveLength(61);
    expect(catalogue.tables.filter((table) => table.force)).toHaveLength(60);
  });

  // A case that needs a policy or row security changed does it on a probe
  // table made inside the rolled-back transaction, never on an existing
  // table: CREATE POLICY, DROP POLICY and ALTER TABLE take ACCESS EXCLUSIVE,
  // and a shared track database has other suites reading and writing
  // (docs/implementation/gotchas.md 2026-09-29). The probe carries
  // organization_id, so the checks judge it as a direct tenant table.
  test.each([
    [
      "a tenant table with row security on and no policy",
      `${PROBE_TABLE}; alter table public.rp_catalogue_probe enable row level security`,
      "rp_catalogue_probe: 0 policies, expected exactly one",
    ],
    [
      "a tenant table with its policy and row security off",
      `${PROBE_TABLE}; ${PROBE_POLICY}`,
      "rp_catalogue_probe: row security disabled",
    ],
    [
      "a second permissive policy",
      `${PROBE_TABLE}; alter table public.rp_catalogue_probe enable row level security; ${PROBE_POLICY}; create policy rp_catalogue_second on public.rp_catalogue_probe using (true)`,
      "rp_catalogue_probe: 2 policies, expected exactly one",
    ],
    [
      "an unclassified table",
      "create table public.rp_catalogue_probe (id uuid primary key)",
      "rp_catalogue_probe: unclassified — neither tenant-owned nor in GLOBAL_TABLES",
    ],
    [
      "a derived tenant table without its policy",
      "create table public.rp_catalogue_probe (id uuid primary key, organization_id uuid not null)",
      "rp_catalogue_probe: row security disabled",
    ],
    [
      "a grant outside the matrix",
      "grant delete on public.legacy_aliases to requestport_application",
      "legacy_aliases: requestport_application holds [DELETE, SELECT], expected [SELECT]",
    ],
    [
      "TRUNCATE to anyone",
      "grant truncate on public.legacy_aliases to requestport_application",
      "legacy_aliases: requestport_application holds [SELECT, TRUNCATE], expected [SELECT]",
    ],
    [
      "a definer function owned by another role",
      "alter function requestport_private.invitation_eligibility(text) owner to current_user",
      "requestport_private.invitation_eligibility(p_normalized_email text): owned by",
    ],
    [
      "a definer function without its pinned path",
      "alter function requestport_private.invitation_eligibility(text) reset search_path",
      "requestport_private.invitation_eligibility(p_normalized_email text): proconfig is null",
    ],
    [
      "a definer function PUBLIC may execute",
      "grant execute on function requestport_private.invitation_eligibility(text) to public",
      "requestport_private.invitation_eligibility(p_normalized_email text): EXECUTE for [PUBLIC, ",
    ],
    [
      "CREATE for the application group",
      "grant create on schema requestport_private to requestport_application",
      "requestport_private: CREATE granted to requestport_application",
    ],
    // F.3's table and lookup (R2 of the driver's rulings after the build). No
    // case here alters operator_credentials: a grant and a function change
    // take no lock on the table.
    [
      "a DELETE on operator_credentials outside the matrix",
      "grant delete on public.operator_credentials to requestport_application",
      "operator_credentials: requestport_application holds [DELETE, INSERT, SELECT, UPDATE], expected [INSERT, SELECT, UPDATE]",
    ],
    [
      "the definer without SELECT on operator_credentials",
      "revoke select on public.operator_credentials from requestport_definer",
      "operator_credentials: requestport_definer holds [], expected [SELECT]",
    ],
    [
      "resolve_operator_credential made an invoker",
      "alter function requestport_private.resolve_operator_credential(text) security invoker",
      "requestport_private.resolve_operator_credential(p_api_key_id text): missing, or no longer SECURITY DEFINER",
    ],
    [
      "resolve_operator_credential executable by PUBLIC",
      "grant execute on function requestport_private.resolve_operator_credential(text) to public",
      "requestport_private.resolve_operator_credential(p_api_key_id text): EXECUTE for [PUBLIC, ",
    ],
    // Step 5's contract: every tenant table forced, and no other table.
    [
      "a tenant table with its policy and row security on, not forced",
      `${PROBE_TABLE}; alter table public.rp_catalogue_probe enable row level security; ${PROBE_POLICY}`,
      "rp_catalogue_probe: FORCE is off",
    ],
    [
      "a table forced that is not tenant-owned",
      "create table public.rp_catalogue_probe (id uuid primary key); alter table public.rp_catalogue_probe force row level security",
      "rp_catalogue_probe: FORCE is on, but it is not tenant-owned",
    ],
    // Step 5's contract: the application group reads signup_allowlist only
    // through its definer function, and a lookup or a credential lock is its
    // groups' alone. No case here alters signup_allowlist: a grant takes no
    // lock on the table.
    [
      "the application group with SELECT on signup_allowlist",
      "grant select on public.signup_allowlist to requestport_application",
      "signup_allowlist: requestport_application holds [SELECT], expected []",
    ],
    [
      "resolve_operator_credential executable by the migrating role",
      "grant execute on function requestport_private.resolve_operator_credential(text) to current_user",
      "requestport_private.resolve_operator_credential(p_api_key_id text): EXECUTE for [",
    ],
    [
      "a lookup its owner may execute",
      "grant execute on function requestport_private.invitation_eligibility(text) to requestport_definer",
      'requestport_private.invitation_eligibility(p_normalized_email text): ACL is ["requestport_',
    ],
    [
      "a credential lock the migrating role may execute",
      "grant execute on function requestport_private.lock_live_api_key(text) to current_user",
      "requestport_private.lock_live_api_key(p_api_key_id text): EXECUTE for [",
    ],
    [
      "a credential lock its owner may execute",
      "grant execute on function requestport_private.lock_live_oauth_client(text) to requestport_definer",
      'requestport_private.lock_live_oauth_client(p_client_id text): ACL is ["requestport_',
    ],
    // b5's contract (0023): a worker function is its group's alone.
    [
      "a worker function the migrating role may execute",
      "grant execute on function requestport_private.claim_outbox_batch(integer, integer) to current_user",
      "requestport_private.claim_outbox_batch(p_limit integer, p_lease_seconds integer): EXECUTE for [",
    ],
    [
      "a worker function its owner may execute",
      "grant execute on function requestport_private.resolve_job_organization(text, uuid) to requestport_definer",
      'requestport_private.resolve_job_organization(p_kind text, p_id uuid): ACL is ["requestport_',
    ],
  ])("fails on %s", async (_name, change, expected) => {
    const problems = await problemsAfter(change);

    expect(problems.some((problem) => problem.startsWith(expected))).toBe(true);
  });

  // Step 8's checks on command_receipts (0024), and step 5's FORCE check
  // (0025) on a tenant table that is not command_receipts, each shown
  // failing once. The catalogue is read and then changed in memory, not in
  // the database: ALTER TABLE and DROP POLICY on an existing table take
  // ACCESS EXCLUSIVE (above).
  const receiptsTable = (catalogue: Catalogue) =>
    catalogue.tables.find(
      (table) => table.name === "command_receipts",
    ) as Catalogue["tables"][number];
  const receiptsPolicy = (catalogue: Catalogue) =>
    catalogue.policies.find(
      (policy) => policy.table === "command_receipts",
    ) as Catalogue["policies"][number];
  test.each([
    [
      "command_receipts with FORCE off",
      (catalogue: Catalogue) => {
        receiptsTable(catalogue).force = false;
      },
      "command_receipts: FORCE is off",
    ],
    [
      "command_receipts with row security off",
      (catalogue: Catalogue) => {
        receiptsTable(catalogue).rls = false;
      },
      "command_receipts: row security disabled",
    ],
    [
      "command_receipts with no policy",
      (catalogue: Catalogue) => {
        catalogue.policies = catalogue.policies.filter(
          (policy) => policy.table !== "command_receipts",
        );
      },
      "command_receipts: 0 policies, expected exactly one",
    ],
    [
      "command_receipts with the direct predicate, which raises when no organisation is bound",
      (catalogue: Catalogue) => {
        receiptsPolicy(catalogue).qual = directPredicate;
      },
      `command_receipts.requestport_tenant: USING is ${directPredicate}`,
    ],
    [
      "command_receipts with a WITH CHECK that admits any row",
      (catalogue: Catalogue) => {
        receiptsPolicy(catalogue).withCheck = "true";
      },
      "command_receipts.requestport_tenant: WITH CHECK is true",
    ],
    [
      "another tenant table with FORCE off",
      (catalogue: Catalogue) => {
        (
          catalogue.tables.find(
            (table) => table.name === "requests",
          ) as Catalogue["tables"][number]
        ).force = false;
      },
      "requests: FORCE is off",
    ],
  ])(
    "fails on %s (the catalogue changed in memory)",
    async (_name, change, expected) => {
      const catalogue = structuredClone(
        await inRolledBackTransaction(readCatalogue),
      );
      expect(catalogueProblems(catalogue)).toEqual([]);

      change(catalogue);

      expect(catalogueProblems(catalogue)).toContain(expected);
    },
  );
});
