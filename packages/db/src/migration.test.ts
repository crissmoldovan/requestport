import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import * as domain from "@requestport/domain";
import { expect, test } from "vitest";

const migrations = new URL("../migrations/", import.meta.url);

async function file(name: string) {
  return readFile(new URL(name, migrations), "utf8");
}

async function sha256(name: string) {
  return createHash("sha256")
    .update(await file(name))
    .digest("hex");
}

// Every applied migration and its snapshot is immutable. Recording only the
// two foundation files left eleven applied migrations free to be edited or
// renamed without a single test noticing.
const immutableHashes = new Map([
  [
    "0000_foundation.sql",
    "59cd251d0646bcd0c04b0c0c6acce39692d94a06363a2941db46e511b47b1489",
  ],
  [
    "0001_optional_repository_slug.sql",
    "8d15e8dd133347a79e248a4f6342354d01919c58ef0ae231c3b4cb21d3c5f6da",
  ],
  [
    "0002_better_auth.sql",
    "04d321dcc53bb7bcf8ffd2eebc2ec5d0fda63b4aedb21efc53ca1c45842633c5",
  ],
  [
    "0003_signup_eligibility_guard.sql",
    "88c91ecf3413fb9c44e255de5fe0151cfafde94feab986babab3b2a61832cc3e",
  ],
  [
    "0004_signup_eligibility_post_lock_recheck.sql",
    "156442855611ff9fc475628174508865a68e3e00f947d769a59b1ef260011130",
  ],
  [
    "0005_invitation_membership_activation.sql",
    "5bd4cb284724f50a4e4bc9a7386763c42fe3d1b423b19c808066da859771db2a",
  ],
  [
    "0006_stale_ogun.sql",
    "7ee1c7be2857e198b92001d64d21fb59d55dbe255aa444168900af7447575f8c",
  ],
  [
    "0007_even_post.sql",
    "6beec21aa9039ea40c0d70f433d0dfafa00e7bc27ef73abf9897a13aff35a7e1",
  ],
  [
    "0008_short_cassandra_nova.sql",
    "c0bb32a0a6e209ee9b9fb46c5ffe5bf4c132464e0b3cf338f36d3ce46aa859dc",
  ],
  [
    "0009_smooth_randall_flagg.sql",
    "d13a693906704b63d88d4262788c4a20ab8ae492f241cb38042105583afa7512",
  ],
  [
    "0010_exotic_darwin.sql",
    "0b1a465864c9743a491d1380c269c36bc59b8050ac9b3b8987712b2cd2de8bc9",
  ],
  [
    "0011_wet_inhumans.sql",
    "4c1086a61f878c4e48e0e55dd6072806cd5c1dfa502ffb423069c597feec9dda",
  ],
  [
    "0012_next_deathstrike.sql",
    "6b788282ed65521c9c48aaef8de61824348f5ccc4ec080de8d07f02a78b682bd",
  ],
  [
    "0013_mean_hobgoblin.sql",
    "985a0eebe9ae619b0aa255b7f9f7a4d757e0ffc745d8c8401d1b0ae5ed6b0e69",
  ],
  [
    "0014_requestport_appearance.sql",
    "02aee38d2ee6fc8e59d112645fdc1d3bebe63fb59f05a9d7e77447f4019467f8",
  ],
  [
    "0016_hot_randall.sql",
    "49f152050288b847c972aaf6975ca96a7275d1f4fa9ee119b8da1ea2abbed30e",
  ],
  [
    "0015_fluffy_dorian_gray.sql",
    "eee9f04f3915afb9e3e211df62796a2b97be81a827862351db78adb4a7d43a91",
  ],
  [
    "0017_better_auth_1_7_expand.sql",
    "fe9efabfe3c5ca6c171511ff0dd3aa3e2332f88357ed6dea14e450c8d71a7ac9",
  ],
  [
    "0018_operator_credentials.sql",
    "92cc9c56cc5eb45cf0244c8c6bacf49e77641d906f96ac68eeaab74cafe80fb5",
  ],
  [
    "0019_row_security_expand.sql",
    "a5bb8fb9b437aa3c0eaa70c6f1a873ed5be9c4dc6da741051df1700fededaf47",
  ],
  [
    "0020_worker_row_security.sql",
    "c6a74d1c91d4e7f17e6dfc2ab5489f8e13484067c1d9a943c760078e664b079a",
  ],
  [
    "0021_live_credential_locks.sql",
    "fe0bfd7b45146134f8e961416f7b370714c5d92d3811f8cbe801ff8502bd6314",
  ],
  [
    "0022_better_auth_1_7_contract.sql",
    "37fa01ee2c65063f58a54e9dd93628e126a0bbd205e66454a7380f4fe3b98ecf",
  ],
  [
    "0023_worker_execute_contract.sql",
    "90cdd0b187f626a4d06e56d948215c7d26d471ee11be3a279e2b97ff72172e76",
  ],
  [
    "0024_command_receipts_row_security.sql",
    "d85941ceb6a19ab5673717ee265ba851c52c9e40924b2623fa687d084b110b91",
  ],
  [
    "0025_row_security_contract.sql",
    "224e64885e030e50b002939eea176feb6996ee8e1c4255271523e5166deffa1b",
  ],
  [
    "0026_requestport_appearance_six_axes.sql",
    "65710f45cf6782b8b4f5ecced0b1453774bb99ae24fb13cde34ff856e9c0dcdc",
  ],
  [
    "0027_agent_oauth_grant_last_used.sql",
    "87068fe58b0bb78a3095e8ad1fddd68604ddd590d9650bcc0298a1f5a63a74ec",
  ],
  [
    "meta/0000_snapshot.json",
    "8fbfa4ca3eb1bb5286eff7fee229a83a892faf637e0a47f2afdb2d286707c904",
  ],
  [
    "meta/0001_snapshot.json",
    "25bdfc5a1c93bd5ee7495766d143635df27b2afa414663615f0a38a192e21f0f",
  ],
  [
    "meta/0002_snapshot.json",
    "c7a1c860880f07a80869bfb5a8e4085e76ea5e0c515caa56c7f8b51f4d33516f",
  ],
  [
    "meta/0003_snapshot.json",
    "4ddec28ce58041bab2691838ff14cb07e18c904c9fc0cb08f263bc9c0d72c3ea",
  ],
  [
    "meta/0004_snapshot.json",
    "aee87c83b6c6fd1700e86cc3cfe64caf8ebe090fdd06910b861db95ebf35ce44",
  ],
  [
    "meta/0005_snapshot.json",
    "a20e3a9ab6006f8a8a47c6b1e0f1ad3f004e61943ae2ada8199c6e61ea914908",
  ],
  [
    "meta/0006_snapshot.json",
    "5345f757803bb39578a09f0369573d421516296bab5b269aa3c7b82dd3a4cfbe",
  ],
  [
    "meta/0007_snapshot.json",
    "976797900861836a0ed5fcecc5e61b2386f49083228873e5cccc5f58d4f3a01c",
  ],
  [
    "meta/0008_snapshot.json",
    "9bc4a6cd6dc43c89290a11a0ac5f111453b5d0ae5cbbc18ffdac5cc2d4ca6026",
  ],
  [
    "meta/0009_snapshot.json",
    "ff3c2b57767a5f8f9ccb983e353b136a31f70876d5cab57407ca2e1a62c337c3",
  ],
  [
    "meta/0010_snapshot.json",
    "862d0b5c5bcbf2090c8a03623ef66fe5634fe6bdf68935e984a09627293e70ae",
  ],
  [
    "meta/0011_snapshot.json",
    "5222d82ddefbd2ab510c2ca5a07bdbfb25c467323f14a6e508c840c324d6d2ac",
  ],
  [
    "meta/0012_snapshot.json",
    "60fc0e31984ad01c2c04c8b4330318aa9b24da56960f01fad80541392a226d0c",
  ],
  [
    "meta/0013_snapshot.json",
    "12799d2530e8a94158d7606e26ac874d35931b3a278f8d4f34268cca45c24518",
  ],
  [
    "meta/0014_snapshot.json",
    "1382487988c66651539330227ec6956ef3eda2f5b6f6a7ddb732d5ce6206c23a",
  ],
  [
    "meta/0016_snapshot.json",
    "f1b941bb1d5c443a3e790cefb3de17682a6faf420d39963e9c847ca22ef734d3",
  ],
  [
    "meta/0015_snapshot.json",
    "ebe1567846062e559c49e16d6dc78be7b0c147cdab98ec2bc6dbea1993c2beb8",
  ],
  [
    "meta/0017_snapshot.json",
    "03b74f3feeef1a9eacae25e90700f97c89da30613aed32751d70e206767bd9b7",
  ],
  [
    "meta/0018_snapshot.json",
    "fff3d3ef642a63d548bfae2604031661e0ab42648c24be7c76839ce7226f2ee9",
  ],
  [
    "meta/0019_snapshot.json",
    "f8de5ee42077c3fd5604fe1635d4c4c573360089e173838e64dbc2ae501e15bd",
  ],
  [
    "meta/0020_snapshot.json",
    "6b83a41379af33e5ad1dadf7aa3ae4345ff3620ca3e8357b6102174cbbc526e7",
  ],
  [
    "meta/0021_snapshot.json",
    "8c76681611f902cc755f35838d9fc42e2338840f6a1e96a2f8da4c357267c0f7",
  ],
  [
    "meta/0022_snapshot.json",
    "a33e357f47dec10623881eb3cba36aefd5a0a711aee4a2ef311114fef9823d60",
  ],
  [
    "meta/0023_snapshot.json",
    "9ad6db4cf5aef494f0460a5bef435c5814f8fe2e3e7e1528b9f790b18d2db26e",
  ],
  [
    "meta/0024_snapshot.json",
    "f896dc47ed0b5b60d7c6a9ac4a88c5767707e737a5a37a96b27d44aa5774df89",
  ],
  [
    "meta/0025_snapshot.json",
    "1d0b3d893e56b046c2da089fc4fcfbd91085afd60aca93a692ec48e2d145faf9",
  ],
  [
    "meta/0026_snapshot.json",
    "4c8b2523ec643bdc104f89653a23422d661010698672e6184f4243e9179da011",
  ],
  [
    "meta/0027_snapshot.json",
    "0556cefb25b65aad659eaaf2e733f93c2f6a94e799af3cdf43713839fac50570",
  ],
]);

const journalTags = [
  "0000_foundation",
  "0001_optional_repository_slug",
  "0002_better_auth",
  "0003_signup_eligibility_guard",
  "0004_signup_eligibility_post_lock_recheck",
  "0005_invitation_membership_activation",
  "0006_stale_ogun",
  "0007_even_post",
  "0008_short_cassandra_nova",
  "0009_smooth_randall_flagg",
  "0010_exotic_darwin",
  "0011_wet_inhumans",
  "0012_next_deathstrike",
  "0013_mean_hobgoblin",
  "0014_requestport_appearance",
  "0015_fluffy_dorian_gray",
  "0016_hot_randall",
  "0017_better_auth_1_7_expand",
  "0018_operator_credentials",
  "0019_row_security_expand",
  "0020_worker_row_security",
  "0021_live_credential_locks",
  "0022_better_auth_1_7_contract",
  "0023_worker_execute_contract",
  "0024_command_receipts_row_security",
  "0025_row_security_contract",
  "0026_requestport_appearance_six_axes",
  "0027_agent_oauth_grant_last_used",
];

test("creates citext before the Better Auth identity tables without destructive SQL", async () => {
  const sql = await file("0002_better_auth.sql");

  expect(sql).toMatch(/^CREATE EXTENSION IF NOT EXISTS "citext";/u);
  expect(sql).toContain('CREATE TABLE "user"');
  expect(sql).toContain('"email" "citext" NOT NULL');
  expect(sql).toContain('CREATE INDEX "invitations_normalized_email_ci_idx"');
  expect(sql).not.toMatch(/(?:^|\n)\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b)/iu);
});

test("preserves immutable foundation history and appends every v1 migration in order", async () => {
  for (const [name, expectedHash] of immutableHashes) {
    expect(await sha256(name), name).toBe(expectedHash);
  }

  const journal = JSON.parse(await file("meta/_journal.json"));
  expect(
    journal.entries.map((entry: { idx: number; tag: string }) => [
      entry.idx,
      entry.tag,
    ]),
  ).toEqual(journalTags.map((tag, index) => [index, tag]));
});

test("rejects a renamed, added, or removed migration or snapshot file", async () => {
  const [sqlFiles, metaFiles] = await Promise.all([
    readdir(migrations),
    readdir(new URL("meta/", migrations)),
  ]);

  // A hash map only protects the files it lists. Pinning the directory listing
  // is what turns a rename or an unrecorded extra migration into a failure
  // rather than a silent history rewrite.
  expect(sqlFiles.filter((name) => name.endsWith(".sql")).toSorted()).toEqual(
    journalTags.map((tag) => `${tag}.sql`),
  );
  expect(metaFiles.toSorted()).toEqual(
    [
      "_journal.json",
      ...journalTags.map((tag) => `${tag.slice(0, 4)}_snapshot.json`),
    ].toSorted(),
  );
  expect([...immutableHashes.keys()].toSorted()).toEqual(
    [
      ...journalTags.map((tag) => `${tag}.sql`),
      ...journalTags.map((tag) => `meta/${tag.slice(0, 4)}_snapshot.json`),
    ].toSorted(),
  );
});

test("adds the final v1 leases and integrity constraints without destructive data SQL", async () => {
  const sql = await file("0013_mean_hobgoblin.sql");

  expect(sql).toContain('CREATE TABLE "import_task_dispatches"');
  expect(sql).toContain('CONSTRAINT "import_task_dispatches_lease_check"');
  expect(sql).toContain('CONSTRAINT "notification_intents_lease_check"');
  expect(sql).toContain('CONSTRAINT "slack_delivery_operations_lease_check"');
  expect(sql).toContain(
    'CONSTRAINT "webhook_subscriptions_verification_check"',
  );
  expect(sql).toContain('CONSTRAINT "webhook_subscriptions_rotation_check"');
  expect(sql).toContain('CONSTRAINT "questions_closed_actor_check"');
  expect(sql).toContain('CONSTRAINT "requests_resume_state_lifecycle_check"');
  expect(sql).toContain('CONSTRAINT "requests_sensitive_visibility_check"');
  expect(sql).toContain('CONSTRAINT "work_sessions_terminal_timestamp_check"');
  expect(sql).not.toMatch(
    /(?:^|\n)\s*(?:DROP\s+TABLE\b|DELETE\s+FROM\b|TRUNCATE\b)/iu,
  );
});

test("creates composite referenced keys before the pending foreign keys that use them", async () => {
  const workSql = await file("0008_short_cassandra_nova.sql");
  const requestKey =
    'ALTER TABLE "requests" ADD CONSTRAINT "requests_organization_id_id_unique" UNIQUE("organization_id","id")';
  const workSessionRequestForeignKey =
    'ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id")';

  expect(workSql.indexOf(requestKey)).toBeGreaterThanOrEqual(0);
  expect(workSql.indexOf(requestKey)).toBeLessThan(
    workSql.indexOf(workSessionRequestForeignKey),
  );

  const integritySql = await file("0012_next_deathstrike.sql");
  const firstCompositeForeignKey = integritySql.search(
    /FOREIGN KEY \("[^"]+","[^"]+"\)/u,
  );
  const compositeUniqueConstraints = [
    ...integritySql.matchAll(
      /ADD CONSTRAINT "[^"]+" UNIQUE\("[^"]+","[^"]+"\)/gu,
    ),
  ];

  expect(firstCompositeForeignKey).toBeGreaterThanOrEqual(0);
  expect(compositeUniqueConstraints.length).toBeGreaterThan(0);
  for (const constraint of compositeUniqueConstraints) {
    expect(constraint.index).toBeLessThan(firstCompositeForeignKey);
  }
});

test("guards user inserts with serialized current eligibility", async () => {
  const sql = await file("0003_signup_eligibility_guard.sql");

  expect(sql).toContain("requestport_guard_user_signup");
  expect(sql).toContain('BEFORE INSERT ON "user"');
  expect(sql).toMatch(/FOR UPDATE/u);
  expect(sql).toMatch(/FOR SHARE/u);
  expect(sql).toMatch(/clock_timestamp\(\)/u);
  expect(sql).toContain("requestport_signup_disabled");
  expect(sql).toContain("requestport_user_signup_eligibility_guard");
  expect(sql).not.toMatch(/^\s*FOR KEY SHARE\b/mu);
});

test("rechecks volatile expiry time after acquiring eligibility locks", async () => {
  const sql = await file("0004_signup_eligibility_post_lock_recheck.sql");

  expect(sql).toContain(
    'CREATE OR REPLACE FUNCTION "public"."requestport_guard_user_signup"',
  );
  expect(sql).toMatch(/FOR active_invitation_id IN[\s\S]*FOR UPDATE/u);
  expect(sql).toMatch(/FOR SHARE;[\s\S]*IF FOUND THEN[\s\S]*clock_timestamp/u);
  expect(sql).toContain("does not re-evaluate a volatile time predicate");
  expect(sql).not.toMatch(/^\s*FOR KEY SHARE\b/mu);
});

test("accepts every current invitation and activates its exact membership atomically", async () => {
  const sql = await file("0005_invitation_membership_activation.sql");

  expect(sql).toMatch(/FOR active_invitation IN[\s\S]*FOR UPDATE/u);
  expect(sql).toContain('INSERT INTO "public"."organization_members"');
  expect(sql).toContain('ON CONFLICT ("organization_id", "user_id")');
  expect(sql).toMatch(/SET "accepted_at" = membership_accepted_at/u);
  expect(sql).toMatch(/IF accepted_invitation THEN[\s\S]*RETURN NEW/u);
  expect(sql).toMatch(/FOR SHARE;[\s\S]*clock_timestamp/u);
  expect(sql).toContain("requestport_signup_disabled");
  expect(sql).not.toMatch(/^\s*FOR KEY SHARE\b/mu);
  expect(sql).not.toMatch(/(?:^|\n)\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b)/iu);
});

test("expands for Better Auth 1.7 without contracting, granting or enabling row security", async () => {
  const sql = await file("0017_better_auth_1_7_expand.sql");

  // Its first statement bounds every lock it waits for: the tables it alters
  // are on the OAuth path, and an unbounded wait would queue that path behind
  // any long transaction for as long as it ran.
  expect(sql.split("--> statement-breakpoint")[0]).toMatch(
    /^(?:--[^\n]*\n)*SET LOCAL lock_timeout = '5s';$/u,
  );

  // R2.1: merged code deploys before this is applied, so it may only add.
  expect(sql).toContain('CREATE TABLE "oauth_resource"');
  expect(sql).toContain('CREATE TABLE "oauth_client_resource"');
  expect(sql).toContain('CREATE TABLE "oauth_client_assertion"');
  expect(sql).not.toMatch(
    /(?:^|\n)\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b|ALTER\s+TABLE\s+"[^"]+"\s+(?:DROP|RENAME|ALTER\s+COLUMN)\b)/iu,
  );
  expect(sql).not.toMatch(/\bSET\s+NOT\s+NULL\b/iu);
  // Every column it adds to an existing table is nullable.
  const added = [...sql.matchAll(/ALTER TABLE "[^"]+" ADD COLUMN [^;]+;/gu)];
  expect(added.length).toBeGreaterThan(0);
  for (const [statement] of added) {
    expect(statement).not.toContain("NOT NULL");
  }

  // Scope K.2 item 5, the first branch: I.2's expand was not in the journal
  // when K.2 took the migration token, so the three new tables get their
  // grants and their place in the global list from I.2's step 1, not here.
  expect(sql).not.toMatch(/\bGRANT\b/iu);
  expect(sql).not.toMatch(/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/iu);
  expect(sql).not.toMatch(/\bCREATE\s+POLICY\b/iu);
});

test("adds operator credentials and widens the audit actor CHECK, expand-only (Plan 13, F.3)", async () => {
  const sql = await file("0018_operator_credentials.sql");

  // Its first statement bounds every lock it waits for, as 0014 and 0017 do:
  // the audit CHECK it replaces is on a table many write paths append to.
  expect(sql.split("--> statement-breakpoint")[0]).toMatch(
    /^(?:--[^\n]*\n)*SET LOCAL lock_timeout = '5s';$/u,
  );

  expect(sql).toContain('CREATE TABLE "operator_credentials"');
  expect(sql).toContain('CONSTRAINT "operator_credentials_scopes_check"');
  expect(sql).toContain('CONSTRAINT "operator_credentials_expiry_check"');
  // The key reference outlives its key (F3-6), and the issuer is never deleted
  // from under a credential.
  expect(sql).toMatch(
    /"better_auth_api_key_id"\) REFERENCES "public"\."apikey"\("id"\) ON DELETE set null/u,
  );
  expect(sql).toMatch(
    /"member_user_id"\) REFERENCES "public"\."user"\("id"\) ON DELETE restrict/u,
  );

  // Expand-only (R2 rule 1): nothing is dropped, deleted, truncated, renamed or
  // tightened on an existing column.
  expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|INDEX|TYPE|FUNCTION)\b/iu);
  expect(sql).not.toMatch(/(?:^|\n)\s*(?:DELETE\s+FROM|TRUNCATE)\b/iu);
  expect(sql).not.toMatch(/\bRENAME\b/iu);
  expect(sql).not.toMatch(/\bSET\s+NOT\s+NULL\b/iu);

  // Its one DROP CONSTRAINT is the audit CHECK, re-added wider under the same
  // name: NOT VALID, then validated (ruling 10).
  const dropped = [...sql.matchAll(/DROP\s+CONSTRAINT\s+"([^"]+)"/giu)].map(
    (match) => match[1],
  );
  expect(dropped).toEqual(["security_audit_records_actor_type_check"]);
  const drop = sql.indexOf(
    'DROP CONSTRAINT "security_audit_records_actor_type_check"',
  );
  const add = sql.indexOf(
    `ADD CONSTRAINT "security_audit_records_actor_type_check" CHECK ("security_audit_records"."actor_type" in ('user', 'agent', 'service', 'system')) NOT VALID;`,
  );
  const validate = sql.indexOf(
    'VALIDATE CONSTRAINT "security_audit_records_actor_type_check"',
  );
  expect(drop).toBeGreaterThanOrEqual(0);
  expect(add).toBeGreaterThan(drop);
  expect(validate).toBeGreaterThan(add);

  // F.3 lands before I.2's step 1 (ruling 47, first order): no row-level
  // security, no policy, no grant and no definer function here; I.2 writes them.
  expect(sql).not.toMatch(
    /ROW\s+LEVEL\s+SECURITY|CREATE\s+POLICY|SECURITY\s+DEFINER|\bGRANT\b|\bREVOKE\b/iu,
  );
});

test("expands row security without contracting, forcing or touching command_receipts' policy", async () => {
  const sql = await file("0019_row_security_expand.sql");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim());
  const code = sql.replace(/^\s*--[^\n]*$/gmu, "");

  // Sixty-one tables take ACCESS EXCLUSIVE here, on production's request
  // path, so every lock it waits for is bounded, and bounded below
  // PostgreSQL's default deadlock_timeout (1s): a request that waits behind
  // this migration and closes a cycle with it runs its deadlock check that
  // long after it began to wait, and this migration, which rolls back whole,
  // must have given up first (track-i2.md §13). Its own table locks are not
  // waited for at all (next test). All of that is true only while 0019 is the
  // last migration applied in its transaction: Drizzle applies every pending
  // migration in one, so a later one would inherit this lock_timeout and
  // could wait for a lock while these 61 are held (track-i2.md §14). Its
  // header marker keeps it last through two guards, both reading the marker
  // through scripts/migration-support.mjs: run-production-migrations.mjs
  // refuses to apply it with a migration pending after it, and the gate's
  // migration-state step fails while the journal has an entry after it and
  // production is not recorded as given it.
  const timeout = /^(?:--[^\n]*\n)*SET LOCAL lock_timeout = '(\d+)ms';$/u.exec(
    statements[0] ?? "",
  );
  expect(timeout, "0019's first statement").not.toBeNull();
  expect(Number(timeout?.[1])).toBe(100);
  expect(Number(timeout?.[1])).toBeLessThan(1000);

  // R2.1: merged code deploys before this is applied, so it may only add.
  expect(code).not.toMatch(
    /(?:^|\n)\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b|ALTER\s+TABLE\s+(?:public\.)?"[^"]+"\s+(?:DROP|RENAME|ALTER\s+COLUMN)\b)/iu,
  );
  expect(code).not.toMatch(/\bSET\s+NOT\s+NULL\b/iu);
  expect(code).toContain(
    'ALTER TABLE public."command_receipts" ADD COLUMN "organization_id" uuid;',
  );
  // The column comes after every ENABLE and policy; only table grants, which
  // take no lock, follow it. (The chunk it is in, and the one statement that
  // takes all of the block's table locks first, are pinned by the next test.)
  const lastChunk = statements.at(-1) ?? "";
  const column = lastChunk.indexOf(
    'ALTER TABLE public."command_receipts" ADD COLUMN "organization_id" uuid;',
  );
  expect(column).toBeGreaterThan(0);
  expect(lastChunk.slice(column + 1)).not.toMatch(
    /\b(?:ALTER\s+TABLE|CREATE\s+POLICY)\b/iu,
  );

  // FORCE is the contract release's (step 5), and command_receipts' policy
  // waits for its own release (step 8).
  expect(code).not.toMatch(/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/iu);
  expect(code).not.toMatch(/ON\s+public\."command_receipts"\s+ENABLE/iu);
  expect(code).not.toMatch(/POLICY\s+\S+\s+ON\s+public\."command_receipts"/iu);

  // The group roles are created only when absent, never with a login or a
  // password, and never altered: a CREATEROLE non-superuser (production's
  // migrating role) may not say NOSUPERUSER or NOREPLICATION in ALTER ROLE
  // (track-i2.md, I.2.2 P12), so their attributes are asserted by a check.
  expect(code).toMatch(
    /IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'requestport_application'\)/u,
  );
  expect(code).toMatch(
    /IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'requestport_definer'\)/u,
  );
  expect(code).not.toMatch(/\bALTER\s+ROLE\b/iu);
  expect(code).not.toMatch(/\bPASSWORD\b/iu);
  expect(code).not.toMatch(/\bCREATE\s+ROLE\s+\S+\s+(?:[A-Z]+\s+)*LOGIN\b/u);
  expect(code).toContain(
    "GRANT requestport_definer TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;",
  );

  // §2.5.0: every SECURITY DEFINER body pins its path, and loses PUBLIC's
  // EXECUTE in this migration; syntax built-ins are never qualified (P8a).
  const definers = [
    ...code.matchAll(
      /CREATE OR REPLACE FUNCTION ([a-z_."]+)\([^)]*\)[\s\S]*?\$\$;/gu,
    ),
  ].filter(([body]) => /\bSECURITY DEFINER\b/u.test(body));
  expect(definers.length).toBe(15);
  for (const [body, name] of definers) {
    expect(body, name).toContain("SET search_path = pg_catalog, pg_temp");
    expect(code, name).toContain(`REVOKE EXECUTE ON FUNCTION ${name}(`);
  }
  expect(code).not.toMatch(
    /pg_catalog\.(?:nullif|coalesce|greatest|least)\b/iu,
  );

  // The definer's CREATE, needed only while ownership moves, is taken back.
  expect(code).toMatch(
    /GRANT CREATE ON SCHEMA requestport_private, public TO requestport_definer;[\s\S]*ALTER FUNCTION[\s\S]*REVOKE CREATE ON SCHEMA requestport_private, public FROM requestport_definer;/u,
  );
  expect(code).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC;");
});

test("changes every table in 0019's last chunk, one statement that every driver sends as one query", async () => {
  const sql = await file("0019_row_security_expand.sql");
  const withoutComments = (text: string) =>
    text.replace(/^\s*--[^\n]*$/gmu, "").trim();
  const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
  const chunks = sql.split("--> statement-breakpoint").map(withoutComments);
  const last = chunks.at(-1) ?? "";

  // Drizzle's migrator sends each chunk as its own query, inside one
  // transaction, so whatever chunk n does to a table lasts for every round
  // trip from n to the commit: at most 77 of them (its 75 chunks, the journal
  // insert and the commit, while 0019 is the last migration in its
  // transaction), at 117 ms each against production from the launcher
  // (track-i2.md §11). Two kinds of statement matter:
  // - those that lock a table more strongly than a read, a row lock or a
  //   write does;
  // - a GRANT or REVOKE on a table. It takes no lock, but it rewrites the
  //   table's pg_class row, and a VACUUM or ANALYZE that then reaches its own
  //   update of that row waits for this transaction while holding SHARE
  //   UPDATE EXCLUSIVE, so a later ENABLE on that table deadlocks with it
  //   (§12).
  // No breakpoint may follow the first of either.
  const tableGrant =
    /\b(?:GRANT|REVOKE)\b[^;]*?\bON\s+(?!(?:FUNCTION|PROCEDURE|ROUTINE|SCHEMA|SEQUENCE|DATABASE|DOMAIN|FOREIGN|LANGUAGE|LARGE|PARAMETER|TABLESPACE|TYPE|ALL\s+(?:FUNCTIONS|PROCEDURES|ROUTINES|SEQUENCES))\b)/iu;
  const tableLock = new RegExp(
    [
      String.raw`\bALTER\s+(?:TABLE|INDEX|POLICY|MATERIALIZED\s+VIEW|VIEW)\b`,
      String.raw`\bCREATE\s+(?:POLICY|RULE|STATISTICS)\b`,
      String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\b`,
      String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b`,
      String.raw`\bLOCK\s+(?:TABLE\b|ONLY\b|public\.|")`,
      String.raw`\b(?:TRUNCATE|VACUUM|ANALYZE|CLUSTER|REINDEX|DROP)\b`,
      String.raw`\bREFRESH\s+MATERIALIZED\b`,
      String.raw`\bCOMMENT\s+ON\s+(?:TABLE|COLUMN|POLICY|TRIGGER|INDEX|CONSTRAINT|RULE)\b`,
      String.raw`\bSECURITY\s+LABEL\b`,
    ].join("|"),
    "iu",
  );
  const changesATable = (chunk: string) =>
    tableLock.test(chunk) || tableGrant.test(chunk);
  expect(chunks.findIndex(changesATable)).toBe(chunks.length - 1);
  expect(chunks.slice(0, -1).filter((chunk) => tableGrant.test(chunk))).toEqual(
    [],
  );

  // Before it, one statement per chunk, and only of the kinds that take no
  // lock conflicting with a read, a row lock or a write (§11's lock probe:
  // GRANT and REVOKE on roles, schemas and functions, and ALTER FUNCTION, take
  // none on a table; a LANGUAGE sql body is checked with at most ROW
  // EXCLUSIVE).
  const early = chunks.slice(0, -1);
  for (const chunk of early) {
    expect(chunk).toMatch(
      /^(?:DO \$\$|(?:SET LOCAL lock_timeout|GRANT|REVOKE|CREATE SCHEMA IF NOT EXISTS|CREATE OR REPLACE FUNCTION|ALTER FUNCTION)\b)/u,
    );
    if (!/^(?:DO|CREATE OR REPLACE FUNCTION)\b/u.test(chunk)) {
      expect(chunk.split(/;\s*\n/u)).toHaveLength(1);
    }
  }

  // The two DO blocks before it are pinned to what they do: create the two
  // group roles when absent, then refuse either if it has other attributes or
  // a membership, reading only the catalogue. Nothing else can hide in them.
  const earlyBlocks = early.filter((chunk) => chunk.startsWith("DO $$"));
  expect(earlyBlocks).toHaveLength(2);
  expect(oneLine(earlyBlocks[0] ?? "")).toMatch(
    /^DO \$\$ BEGIN (?:IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = '(requestport_(?:application|definer))'\) THEN CREATE ROLE \1 NOLOGIN NOSUPERUSER (?:NO)?BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; ){2}END \$\$;$/u,
  );
  const checks = oneLine(earlyBlocks[1] ?? "");
  expect(checks).toMatch(
    /^DO \$\$ BEGIN (?:IF EXISTS \( SELECT 1 FROM [^;]*? \) THEN RAISE EXCEPTION '[^';]*' USING ERRCODE = '55000'; END IF; ){2}END \$\$;$/u,
  );
  const read = [...checks.matchAll(/\b(?:FROM|JOIN)\s+(\S+)/gu)].map(
    (match) => match[1],
  );
  expect(read).toEqual([
    "pg_catalog.pg_roles",
    "pg_catalog.pg_auth_members",
    "pg_catalog.pg_roles",
  ]);
  expect(checks).not.toMatch(/\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY|KEY)\b/iu);

  // The last chunk is one DO block: a single statement, so the server drivers send
  // it as one simple query and PGlite, whose extended protocol refuses a
  // string of several commands, as one prepared one (§11).
  //
  // It opens by taking every table lock it needs in one LOCK TABLE, NOWAIT,
  // retried after a short random pause for at most 20 seconds, holding
  // nothing between tries (the failed try's subtransaction releases what it
  // took). So this migration never waits for a lock on a table: no request
  // queues behind a waiting ACCESS EXCLUSIVE, and no request can close a
  // deadlock cycle with it, whatever order the request takes its locks in
  // (track-i2.md §13: an INSERT into a tenant table, whose foreign key check
  // takes ROW SHARE on organizations after locking the child, did).
  const prologue =
    /^DO \$\$ DECLARE gives_up_at timestamptz := pg_catalog\.clock_timestamp\(\) \+ interval '20 seconds'; BEGIN LOOP BEGIN LOCK TABLE ([^;]+) IN ACCESS EXCLUSIVE MODE NOWAIT; EXIT; EXCEPTION WHEN lock_not_available THEN IF pg_catalog\.clock_timestamp\(\) >= gives_up_at THEN RAISE EXCEPTION '[^']*' USING ERRCODE = '55P03'; END IF; PERFORM pg_catalog\.pg_sleep\(0\.01 \+ pg_catalog\.random\(\) \* 0\.09\); END; END LOOP; /u.exec(
      oneLine(last),
    );
  expect(
    prologue,
    "the last chunk takes its locks first, NOWAIT",
  ).not.toBeNull();
  const locked = (prologue?.[1] ?? "").split(/\s*,\s*/u);
  const block = /\bEND LOOP;\s*([\s\S]*?)\s*END \$\$;$/u.exec(last);
  expect(block, "the last chunk is one DO block").not.toBeNull();

  // Then: sixty ENABLEs, each followed by its table's one policy, then the
  // receipt column; then the table grants, and nothing else.
  const statements = (block?.[1] ?? "")
    .split(/;\s*(?:\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (let index = 0; index < 120; index += 2) {
    const table =
      /^ALTER TABLE public\."([a-z_]+)" ENABLE ROW LEVEL SECURITY$/u.exec(
        statements[index] ?? "",
      )?.[1];
    expect(table, `statement ${index}`).toBeDefined();
    expect(statements[index + 1], `statement ${index + 1}`).toMatch(
      new RegExp(
        `^CREATE POLICY requestport_(?:tenant|user) ON public\\."${table}"\\s`,
        "u",
      ),
    );
  }
  expect(statements[120]).toBe(
    'ALTER TABLE public."command_receipts" ADD COLUMN "organization_id" uuid',
  );

  // The LOCK names exactly the tables the block alters, in its order, and
  // every table a policy reads is one of them, so nothing after it waits for
  // a table lock. Every ALTER names its table as the LOCK does, public."…",
  // so an unqualified one is not counted and fails the length below.
  const altered = statements
    .slice(0, 121)
    .map(
      (statement) => /^ALTER TABLE public\."([a-z_]+)"/u.exec(statement)?.[1],
    )
    .filter((table): table is string => table !== undefined);
  expect(altered).toHaveLength(61);
  expect(locked).toEqual(altered.map((table) => `public."${table}"`));
  const policiesRead = statements
    .slice(0, 120)
    .flatMap((statement) =>
      [...statement.matchAll(/\bFROM\s+public\.([a-z_]+)/gu)].map(
        (match) => `public."${match[1]}"`,
      ),
    );
  expect(policiesRead.length).toBeGreaterThan(0);
  for (const table of policiesRead) expect(locked).toContain(table);

  const grants = statements.slice(121);
  expect(grants).toHaveLength(85);
  for (const grant of grants) {
    expect(oneLine(grant)).toMatch(
      /^GRANT [A-Z, ()a-z_]+ ON public\.[^;]+ TO requestport_(?:application|definer)$/u,
    );
    expect(grant).not.toMatch(tableLock);
  }
});

test("adds the worker's groups, the processor's grants and seventeen functions as an expand that locks no table that existed before it (I.2b, b1)", async () => {
  const sql = await file("0020_worker_row_security.sql");
  const code = sql.replace(/^\s*--[^\n]*$/gmu, "");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim());

  // What the migration itself runs: everything but the function bodies,
  // which run only when called (retention's deletes are one of them).
  const outsideBodies = code.replace(/\bAS \$\$[\s\S]*?\$\$;/gu, "AS;");

  // Merged code deploys before this is applied, and nothing calls it until
  // b2: it may only add.
  expect(outsideBodies).not.toMatch(
    /(?:^|\n)\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b|ALTER\s+TABLE\b|UPDATE\b)/iu,
  );
  expect(code).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+POLICY\b/iu);
  expect(code).not.toMatch(/\bROW\s+LEVEL\s+SECURITY\b/iu);

  // No statement locks an existing table more strongly than a read, so no
  // request queues behind this migration, and it needs neither 0019's
  // NOWAIT loop nor its lock_timeout (track-i2.md, "b1 built": the lock
  // probe and the traffic runs). Every function is PL/pgSQL, whose body is
  // parsed but not planned, and so locks nothing, when it is created; the
  // one table it creates is new.
  //
  // It does carry 0019's last-in-transaction marker, as its first line. Its
  // table GRANTs rewrite pg_class rows, so a VACUUM or ANALYZE of a granted
  // table waits for this migration's commit holding SHARE UPDATE EXCLUSIVE;
  // a later migration in the same transaction that altered that table would
  // wait on the vacuum and close a cycle (track-i2.md, "b1 built", and the
  // review fixes). The marker is what the launcher and the gate read to keep
  // anything from following it in one run.
  expect(sql.split("\n")[0]).toBe(
    "-- requestport: this migration must be the last one applied in its transaction",
  );
  expect(code).not.toMatch(/\bSET\s+(?:LOCAL\s+)?lock_timeout\b/iu);
  expect(outsideBodies).not.toMatch(
    /\bLOCK\s+TABLE\b|\b(?:VACUUM|ANALYZE|CLUSTER|REINDEX|REFRESH)\b|\bCREATE\s+(?:UNIQUE\s+)?INDEX\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/iu,
  );
  expect(code).not.toMatch(/\bLANGUAGE\s+sql\b/iu);
  // A days interval is calendar days in the caller's session time zone, and
  // a SECURITY DEFINER body does not pin TimeZone, so a daylight-saving
  // change would move a window or a cutoff by an hour. Durations here are
  // fixed: retention's ages are milliseconds, the reminders' window 168 hours
  // (today's query adds 7 * 24 * 60 * 60_000 ms).
  expect(code).not.toMatch(/interval\s+'[^']*\bdays?\b[^']*'/iu);
  const created = [...code.matchAll(/\bCREATE\s+TABLE\s+(\S+)/giu)].map(
    (match) => match[1],
  );
  expect(created).toEqual(["requestport_private.retention_ages"]);

  // The three groups are created only when absent, as NOLOGIN with no
  // password, never altered, and checked when they exist (0019's pattern).
  for (const role of [
    "requestport_dispatcher",
    "requestport_tenant_processor",
    "requestport_maintenance",
  ]) {
    expect(code).toContain(
      `IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN\n\t\tCREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;`,
    );
  }
  expect(code).not.toMatch(/\bALTER\s+ROLE\b/iu);
  expect(code).not.toMatch(/\bPASSWORD\b/iu);
  expect(code).not.toMatch(/\bCREATE\s+ROLE\s+\S+\s+(?:[A-Z]+\s+)*LOGIN\b/u);
  expect(code).not.toMatch(/\bGRANT\s+requestport_[a-z_]+\s+TO\b/u);

  // §2.5.0: every function is a SECURITY DEFINER with the pinned path, loses
  // PUBLIC's EXECUTE, moves to the definer, and only then is granted to its
  // one role and to the migrating role; syntax built-ins are never qualified.
  const functions = [
    ...code.matchAll(
      /CREATE OR REPLACE FUNCTION requestport_private\.([a-z_]+)\([^)]*\)[\s\S]*?\$\$;/gu,
    ),
  ];
  expect(functions.map((match) => match[1])).toHaveLength(17);
  for (const [body, name] of functions) {
    expect(body, name).toMatch(/\bLANGUAGE plpgsql\b/u);
    expect(body, name).toContain("SECURITY DEFINER");
    expect(body, name).toContain("SET search_path = pg_catalog, pg_temp");
    const revoke = code.indexOf(
      `REVOKE EXECUTE ON FUNCTION requestport_private.${name}(`,
    );
    const owner = code.indexOf(`ALTER FUNCTION requestport_private.${name}(`);
    const grant = code.indexOf(
      `GRANT EXECUTE ON FUNCTION requestport_private.${name}(`,
    );
    expect(revoke, name).toBeGreaterThan(0);
    expect(owner, name).toBeGreaterThan(revoke);
    expect(grant, name).toBeGreaterThan(owner);
    expect(code.slice(grant).split(";")[0], name).toMatch(
      /TO requestport_(?:dispatcher|tenant_processor|maintenance), CURRENT_USER$/u,
    );
  }
  expect(code).not.toMatch(
    /pg_catalog\.(?:nullif|coalesce|greatest|least)\b/iu,
  );
  expect(code).toMatch(
    /GRANT CREATE ON SCHEMA requestport_private TO requestport_definer;[\s\S]*ALTER FUNCTION[\s\S]*REVOKE CREATE ON SCHEMA requestport_private FROM requestport_definer;/u,
  );

  // Every chunk is one statement: a DO block, a function, or one GRANT,
  // REVOKE, ALTER FUNCTION, CREATE TABLE or INSERT.
  for (const chunk of chunks) {
    expect(chunk).toMatch(
      /^(?:DO \$\$\s|(?:CREATE OR REPLACE FUNCTION|GRANT|REVOKE|ALTER FUNCTION|CREATE TABLE|INSERT INTO requestport_private\.retention_ages)\b)/u,
    );
  }
  // The processor is never given DELETE, TRUNCATE, REFERENCES or TRIGGER,
  // and nothing on the Better Auth tables §5.1 refuses it.
  const processorGrants = chunks.filter((chunk) =>
    /\bTO requestport_tenant_processor;?$/u.test(chunk),
  );
  for (const grant of processorGrants) {
    expect(grant).not.toMatch(
      /\b(?:DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b/u,
    );
    expect(grant).not.toMatch(
      /public\.(?:"?account"?|apikey|jwks|oauth_client|oauth_consent|"?session"?|verification|oauth_access_token|oauth_refresh_token)\b/u,
    );
  }
});

test("adds the two live-credential locks as an expand that rewrites no existing table's pg_class row, so it carries no marker (I.2b, b2; the driver's ruling of 2026-09-30)", async () => {
  const sql = await file("0021_live_credential_locks.sql");
  const code = sql.replace(/^\s*--[^\n]*$/gmu, "");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim());
  const outsideBodies = code.replace(/\bAS \$\$[\s\S]*?\$\$;/gu, "AS;");

  // It may only add: no table, role, policy or row-security change.
  expect(outsideBodies).not.toMatch(
    /(?:^|\n)\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b|ALTER\s+TABLE\b|UPDATE\b|INSERT\b)/iu,
  );
  expect(code).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+POLICY\b/iu);
  expect(code).not.toMatch(/\bROW\s+LEVEL\s+SECURITY\b/iu);
  expect(code).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+ROLE\b/iu);
  expect(code).not.toMatch(/\bCREATE\s+TABLE\b/iu);
  expect(code).not.toMatch(/\bSET\s+(?:LOCAL\s+)?lock_timeout\b/iu);
  expect(outsideBodies).not.toMatch(
    /\bLOCK\s+TABLE\b|\b(?:VACUUM|ANALYZE|CLUSTER|REINDEX|REFRESH)\b|\bCREATE\s+(?:UNIQUE\s+)?INDEX\b|\bTRIGGER\b/iu,
  );
  expect(code).not.toMatch(/\bLANGUAGE\s+sql\b/iu);

  // No last-in-transaction marker (track-i2.md, "b2, the packages/db half":
  // the lock probe). 0020 needed one because its table GRANTs rewrite
  // pg_class rows, which a VACUUM or ANALYZE then waits on; 0021's one table
  // privilege is a column grant, which rewrites pg_attribute rows and leaves
  // pg_class alone, and nothing else here touches an existing table. The
  // test holds the migration to that shape, so the reason stays true.
  expect(sql.split("\n")[0]).not.toBe(
    "-- requestport: this migration must be the last one applied in its transaction",
  );
  expect(sql).not.toContain("must be the last one applied");
  const tableGrants = chunks.filter((chunk) =>
    /^GRANT\b[^;]*\bON\s+public\./u.test(chunk),
  );
  expect(tableGrants).toEqual([
    "GRANT UPDATE (id) ON public.apikey, public.oauth_client TO requestport_definer;",
  ]);

  // The two functions of §5.1 rows 18 and 19, exactly.
  const functions = [
    ...code.matchAll(
      /CREATE OR REPLACE FUNCTION requestport_private\.([a-z_]+)\(([^)]*)\)\s+RETURNS (\S+)[\s\S]*?\$\$;/gu,
    ),
  ];
  expect(functions.map((match) => [match[1], match[2], match[3]])).toEqual([
    ["lock_live_api_key", "p_api_key_id text", "boolean"],
    ["lock_live_oauth_client", "p_client_id text", "boolean"],
  ]);
  for (const [body, name] of functions) {
    expect(body, name).toMatch(/\bLANGUAGE plpgsql\b/u);
    expect(body, name).toMatch(/\bVOLATILE\b/u);
    expect(body, name).toContain("SECURITY DEFINER");
    expect(body, name).toContain("SET search_path = pg_catalog, pg_temp");
    expect(body, name).toMatch(/\bFOR SHARE;/u);
    expect(body, name).not.toMatch(/\bEXECUTE\b|\bformat\s*\(/u);
    const revoke = code.indexOf(
      `REVOKE EXECUTE ON FUNCTION requestport_private.${name}(`,
    );
    const owner = code.indexOf(
      `ALTER FUNCTION requestport_private.${name}(text) OWNER TO requestport_definer;`,
    );
    const grant = code.indexOf(
      `GRANT EXECUTE ON FUNCTION requestport_private.${name}(text) TO requestport_tenant_processor, requestport_application, CURRENT_USER;`,
    );
    expect(revoke, name).toBeGreaterThan(0);
    expect(owner, name).toBeGreaterThan(revoke);
    expect(grant, name).toBeGreaterThan(owner);
  }
  // Today's join predicates (agent-authorization.ts), and nothing else.
  const [apiKey, client] = functions.map((match) =>
    (match[0].split("BEGIN")[1] ?? "").replace(/\s+/gu, " ").trim(),
  );
  expect(apiKey).toBe(
    "PERFORM 1 FROM public.apikey k WHERE k.id = p_api_key_id AND k.enabled = true AND k.expires_at > clock_timestamp() FOR SHARE; RETURN FOUND; END; $$;",
  );
  expect(client).toBe(
    "PERFORM 1 FROM public.oauth_client c WHERE c.client_id = p_client_id AND c.disabled = false FOR SHARE; RETURN FOUND; END; $$;",
  );
  expect(code).toMatch(
    /GRANT CREATE ON SCHEMA requestport_private TO requestport_definer;[\s\S]*ALTER FUNCTION[\s\S]*REVOKE CREATE ON SCHEMA requestport_private FROM requestport_definer;/u,
  );
  for (const chunk of chunks) {
    expect(chunk).toMatch(
      /^(?:CREATE OR REPLACE FUNCTION|GRANT|REVOKE|ALTER FUNCTION)\b/u,
    );
  }
});

test("contracts oauth_client by the two columns Better Auth 1.7.6 has no field for, and nothing else (Plan 13, K.4)", async () => {
  const sql = await file("0022_better_auth_1_7_contract.sql");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim())
    .filter((chunk) => chunk.length > 0);

  // Its first statement bounds the lock it waits for, as 0017's does on the
  // same table: DROP COLUMN takes ACCESS EXCLUSIVE on oauth_client, which
  // every OAuth request reads.
  expect(sql.split("--> statement-breakpoint")[0]).toMatch(
    /^(?:--[^\n]*\n)*SET LOCAL lock_timeout = '5s';$/u,
  );
  // Then the two drops, exactly, and nothing else: no data statement, no
  // other table, and no CASCADE, so an object that still depended on either
  // column would stop the apply rather than go with it.
  expect(chunks).toEqual([
    "SET LOCAL lock_timeout = '5s';",
    'ALTER TABLE "oauth_client" DROP COLUMN "public";',
    'ALTER TABLE "oauth_client" DROP COLUMN "type";',
  ]);
  expect(chunks.join("\n")).not.toMatch(/\bCASCADE\b/iu);
  // No last-in-transaction marker. 0020 carries one because a table GRANT
  // leaves a VACUUM of that table waiting on the migration's transaction,
  // where a later migration in it could wait on the VACUUM. The only table
  // this one locks is oauth_client, in ACCESS EXCLUSIVE until commit, so no
  // VACUUM of it can start while the transaction is open.
  expect(sql).not.toContain("must be the last one applied");

  // The snapshot says the same: everything as 0021's snapshot holds it, and
  // oauth_client less those two columns.
  type Snapshot = {
    id: string;
    prevId: string;
    tables: Record<string, { columns: Record<string, unknown> }>;
  };
  const snapshot = async (tag: string) =>
    JSON.parse(await file(`meta/${tag}_snapshot.json`)) as Snapshot;
  const before = await snapshot("0021");
  const after = await snapshot("0022");
  expect(after.prevId).toBe(before.id);
  const {
    public: dropped,
    type: alsoDropped,
    ...kept
  } = before.tables["public.oauth_client"]?.columns ?? {};
  expect([dropped, alsoDropped]).toEqual([
    { name: "public", type: "boolean", primaryKey: false, notNull: false },
    { name: "type", type: "text", primaryKey: false, notNull: false },
  ]);
  expect(after.tables["public.oauth_client"]?.columns).toEqual(kept);
  const withoutClientColumns = (whole: Snapshot) => ({
    ...whole,
    id: undefined,
    prevId: undefined,
    tables: {
      ...whole.tables,
      "public.oauth_client": {
        ...whole.tables["public.oauth_client"],
        columns: undefined,
      },
    },
  });
  expect(withoutClientColumns(after)).toEqual(withoutClientColumns(before));
});

test("contracts the worker's seventeen functions to their groups: 0020's grant to the migrating role and the owner's own entry revoked, then checked (I.2b b5; ruling 214 item 4)", async () => {
  const sql = await file("0023_worker_execute_contract.sql");
  const code = sql.replace(/^\s*--[^\n]*$/gmu, "");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim())
    .filter((chunk) => chunk.length > 0);

  // The seventeen exactly as 0020 granted them to the migrating role, each
  // with its group: the revokes name each function the way 0020's grant did,
  // and CURRENT_USER, whatever the migrating role is called.
  const granted = [
    ...(await file("0020_worker_row_security.sql")).matchAll(
      /^GRANT EXECUTE ON FUNCTION (requestport_private\.[a-z_]+\([^)]*\)) TO (requestport_[a-z_]+), CURRENT_USER;/gmu,
    ),
  ].map(([, signature, group]) => [signature, group]);
  expect(granted).toHaveLength(17);

  // Seventeen from the migrating role, then seventeen from the owner, whose
  // own entry the migrating role inherits through 0019's membership; then
  // the postcondition, and nothing else. No CASCADE: no entry here carries a
  // grant option, and one that had passed it on would stop the apply.
  expect(chunks).toHaveLength(35);
  expect(chunks.slice(0, 34)).toEqual([
    ...granted.map(
      ([signature]) =>
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM CURRENT_USER;`,
    ),
    ...granted.map(
      ([signature]) =>
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM requestport_definer;`,
    ),
  ]);
  expect(code).not.toMatch(/\b(?:CASCADE|GRANT)\b/u);

  // The postcondition lists the same seventeen with the same groups, and
  // raises, rolling the apply back, on either half: an ACL that is not
  // exactly its group's entry, or a migrating role that is not a superuser
  // and can still execute one by any path (a REVOKE it cannot act on only
  // warns).
  const check = chunks[34] ?? "";
  expect(check).toMatch(/^DO \$\$\n[\s\S]*\nEND \$\$;$/u);
  expect(
    [
      ...check.matchAll(
        /\('(requestport_private\.[a-z_]+\([^)]*\))', '(requestport_[a-z_]+)'\)/gu,
      ),
    ].map(([, signature, group]) => [signature, group]),
  ).toEqual(granted);
  expect(check).toContain(
    "IF acl IS DISTINCT FROM ARRAY[worker.grp || '=X/requestport_definer'] THEN",
  );
  expect(check).toContain(
    "IF NOT migrating_superuser\n\t\t\tAND pg_catalog.has_function_privilege(current_user, worker.fn, 'EXECUTE') THEN",
  );
  expect(check.match(/\bRAISE EXCEPTION\b/gu)).toHaveLength(2);
  // The second refusal names the setting that gives a role creating the
  // groups an inheriting membership in each, the one way it is met on a
  // server whose ACLs are exactly its groups' (ruling 215 item 10).
  expect(check).toContain(
    "RAISE EXCEPTION 'requestport: the migrating role % can still execute %, through an inheriting membership in its group %. A server whose createrole_self_grant includes inherit gives a role that is not a superuser such a membership in each role it creates: take the inherit option off it, or migrate as a role without one.', current_user, worker.fn, worker.grp;",
  );

  // It changes ACLs on functions only: no table is named, so no table's
  // pg_class row is rewritten, and 0020's reason for the
  // last-in-transaction marker does not apply; nor does a lock_timeout.
  expect(code).not.toMatch(/\bpublic\./u);
  expect(code).not.toMatch(/\bSET\s+(?:LOCAL\s+)?lock_timeout\b/iu);
  expect(sql).not.toContain("must be the last one applied");

  // The snapshot is 0022's: no table, column or index changes.
  type Snapshot = { id: string; prevId: string };
  const snapshot = async (tag: string) =>
    JSON.parse(await file(`meta/${tag}_snapshot.json`)) as Snapshot;
  const before = await snapshot("0022");
  const after = await snapshot("0023");
  expect(after.prevId).toBe(before.id);
  expect({ ...after, id: undefined, prevId: undefined }).toEqual({
    ...before,
    id: undefined,
    prevId: undefined,
  });
});

test("gives command_receipts its one policy, reading the binding as 0019's user-mode arm does, then enables and forces row security; it changes no row and drops nothing (I.2 step 8; ruling 220)", async () => {
  const sql = await file("0024_command_receipts_row_security.sql");
  const code = sql.replace(/^\s*--[^\n]*$/gmu, "");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim())
    .filter((chunk) => chunk.length > 0);

  // The binding, read as security_audit_records' WITH CHECK reads it in
  // 0019 (D12), and as every receipt insert writes organization_id
  // (boundOrganizationIdSql): nullif, so that with no organisation bound the
  // arm is "no organisation" rather than bound_organization_id()'s 42501,
  // which would refuse the session-only user bus (track-i2.md D1).
  const bound =
    "nullif(pg_catalog.current_setting('requestport.organization_id', true), '')";
  expect(await file("0019_row_security_expand.sql")).toContain(
    `THEN organization_id = ${bound}::uuid`,
  );
  expect(
    await readFile(new URL("./tenant-context.ts", import.meta.url), "utf8"),
  ).toContain(`\`${bound}::uuid\``);
  const arm = [
    "\t\tCASE",
    `\t\t\tWHEN ${bound} IS NOT NULL`,
    `\t\t\t\tTHEN organization_id = ${bound}::uuid`,
    "\t\t\tELSE organization_id IS NULL",
    "\t\tEND",
  ].join("\n");

  // A bounded lock wait, the policy for every role (no TO clause, FOR ALL,
  // permissive, as each of 0019's is), then ENABLE and FORCE: each its own
  // statement, which PGlite's extended protocol needs.
  expect(chunks).toEqual([
    "SET LOCAL lock_timeout = '5s';",
    `CREATE POLICY requestport_tenant ON public."command_receipts"\n\tUSING (\n${arm}\n\t)\n\tWITH CHECK (\n${arm}\n\t);`,
    'ALTER TABLE public."command_receipts" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public."command_receipts" FORCE ROW LEVEL SECURITY;',
  ]);
  expect(code).not.toMatch(
    /\b(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|CASCADE|GRANT|REVOKE|DISABLE)\b/iu,
  );

  // Its ACCESS EXCLUSIVE lock on command_receipts is held from the policy to
  // the commit, so it is the last migration applied in its transaction
  // (scripts/migration-support.mjs): no later one inherits its lock_timeout
  // or runs under that lock.
  expect(sql.split("\n")[0]).toBe(
    "-- requestport: this migration must be the last one applied in its transaction",
  );

  // The snapshot is 0023's: policies are hand-written (track-i2.md D7), so
  // the schema Drizzle compares has not changed.
  type Snapshot = { id: string; prevId: string };
  const snapshot = async (tag: string) =>
    JSON.parse(await file(`meta/${tag}_snapshot.json`)) as Snapshot;
  const before = await snapshot("0023");
  const after = await snapshot("0024");
  expect(after.prevId).toBe(before.id);
  expect({ ...after, id: undefined, prevId: undefined }).toEqual({
    ...before,
    id: undefined,
    prevId: undefined,
  });
});

test("contracts row-level security: the fourteen functions 0019 and 0021 granted the migrating role revoked from it and from the owner, FORCE on 0019's 59 tenant tables under 0019's locks, and signup_allowlist's SELECT revoked from the application group, then checked (I.2 step 5; rulings 215 item 11 and 221 item 3)", async () => {
  const sql = await file("0025_row_security_contract.sql");
  const code = sql.replace(/^\s*--[^\n]*$/gmu, "");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim())
    .filter((chunk) => chunk.length > 0);

  // The fourteen exactly as 0019 and 0021 granted them to the migrating role
  // "until step 5", each with the groups that keep it: the revokes name each
  // function the way the grant did, and CURRENT_USER, whatever the
  // migrating role is called.
  const grantToMigratingRole =
    /^GRANT EXECUTE ON FUNCTION (requestport_private\.[a-z_]+\([^)]*\)) TO ((?:requestport_[a-z_]+, )+)CURRENT_USER;/gmu;
  const granted = [
    ...(await file("0019_row_security_expand.sql")).matchAll(
      grantToMigratingRole,
    ),
    ...(await file("0021_live_credential_locks.sql")).matchAll(
      grantToMigratingRole,
    ),
  ].map(([, signature, groups]) => [
    signature as string,
    (groups as string).split(", ").filter((group) => group !== ""),
  ]);
  expect(granted).toHaveLength(14);

  // 0019's tenant tables: every table 0019 enabled row security on, less
  // D1's user table, which is global (manifest-i2.md §2.1). The sixtieth,
  // command_receipts, 0024 (step 8) enabled and forced, so this migration
  // neither locks nor forces it.
  const tenant = [
    ...(await file("0019_row_security_expand.sql")).matchAll(
      /^\tALTER TABLE public\."([a-z_]+)" ENABLE ROW LEVEL SECURITY;$/gmu,
    ),
  ]
    .map(([, table]) => table as string)
    .filter((table) => table !== "user_appearance_preferences");
  expect(tenant).toHaveLength(59);

  // A bounded lock wait; fourteen revokes from the migrating role, then
  // fourteen from the owner, whose own entry the migrating role inherits
  // through 0019's membership; the lock block; the postcondition; nothing
  // else.
  expect(chunks).toHaveLength(31);
  expect(chunks[0]).toBe("SET LOCAL lock_timeout = '100ms';");
  expect(chunks.slice(1, 29)).toEqual([
    ...granted.map(
      ([signature]) =>
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM CURRENT_USER;`,
    ),
    ...granted.map(
      ([signature]) =>
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM requestport_definer;`,
    ),
  ]);

  // The lock block, 0019's pattern: the 59 locked in its first statement,
  // NOWAIT, retried after a pause rather than waited for, so the migration
  // never queues behind a request's lock; then FORCE on the same 59 in the
  // same order, and the one table revoke after the locks; nothing else.
  const block = chunks[29] ?? "";
  expect(block).toMatch(/^DO \$\$\n[\s\S]*\nEND \$\$;$/u);
  const locked =
    /^\t\t\tLOCK TABLE\n([\s\S]*?)\n\t\t\t\tIN ACCESS EXCLUSIVE MODE NOWAIT;$/mu.exec(
      block,
    )?.[1] ?? "";
  expect(locked.trim().split(/,\s*/u)).toEqual(
    tenant.map((table) => `public."${table}"`),
  );
  expect(block).toContain("EXCEPTION WHEN lock_not_available THEN");
  expect(block).toContain(
    "PERFORM pg_catalog.pg_sleep(0.01 + pg_catalog.random() * 0.09);",
  );
  expect(block).toContain("USING ERRCODE = '55P03';");
  const afterTheLocks = (block.split("\tEND LOOP;\n")[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "END $$;");
  expect(afterTheLocks).toEqual([
    ...tenant.map(
      (table) => `ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY;`,
    ),
    "REVOKE SELECT ON public.signup_allowlist FROM requestport_application;",
  ]);
  expect(code.match(/\bALTER TABLE\b/gu)).toHaveLength(59);

  // The postcondition lists the same fourteen with the same groups, and
  // raises, rolling the apply back, on any of four: an ACL that is not
  // exactly its groups' entries, granted by the owner; a migrating role that
  // is not a superuser and can still execute one by any path (a REVOKE it
  // cannot act on only warns); a table with a tenant policy left unforced;
  // and the application group able to read signup_allowlist directly.
  const check = chunks[30] ?? "";
  expect(check).toMatch(/^DO \$\$\n[\s\S]*\nEND \$\$;$/u);
  expect(
    [
      ...check.matchAll(
        /\('(requestport_private\.[a-z_]+\([^)]*\))', ARRAY\[([^\]]*)\]\)/gu,
      ),
    ].map(([, signature, groups]) => [
      signature,
      (groups as string)
        .split(", ")
        .map((group) => group.replace(/^'|'$/gu, "")),
    ]),
  ).toEqual(granted);
  expect(check).toContain(
    "SELECT pg_catalog.array_agg(g || '=X/requestport_definer') INTO expected",
  );
  expect(check).toContain(
    "IF acl IS NULL OR NOT (acl @> expected AND acl <@ expected) THEN",
  );
  expect(check).toContain(
    "IF NOT migrating_superuser\n\t\t\tAND pg_catalog.has_function_privilege(current_user, contract.fn, 'EXECUTE') THEN",
  );
  expect(check).toContain(
    "RAISE EXCEPTION 'requestport: the migrating role % can still execute %, through an inheriting membership in one of %. A server whose createrole_self_grant includes inherit gives a role that is not a superuser such a membership in each role it creates: take the inherit option off it, or migrate as a role without one.', current_user, contract.fn, contract.groups;",
  );
  expect(check).toContain("AND NOT c.relforcerowsecurity");
  expect(check).toContain(
    "WHERE p.polrelid = c.oid AND p.polname = 'requestport_tenant'",
  );
  expect(check).toContain(
    "IF pg_catalog.has_table_privilege('requestport_application', 'public.signup_allowlist', 'SELECT')\n\t\tOR pg_catalog.has_any_column_privilege('requestport_application', 'public.signup_allowlist', 'SELECT') THEN",
  );
  expect(check.match(/\bRAISE EXCEPTION\b/gu)).toHaveLength(4);

  // Nothing is granted, dropped, disabled or written, and no revoke cascades.
  expect(code).not.toMatch(
    /\b(?:GRANT|CASCADE|DROP|DELETE|TRUNCATE|INSERT|UPDATE|DISABLE)\b|\bNO\s+FORCE\b/iu,
  );

  // Its 59 ACCESS EXCLUSIVE locks are held to the commit, so it is the last
  // migration applied in its transaction (scripts/migration-support.mjs): no
  // later one inherits its lock_timeout or runs under those locks.
  expect(sql.split("\n")[0]).toBe(
    "-- requestport: this migration must be the last one applied in its transaction",
  );

  // The snapshot is 0024's, which is 0023's: FORCE, policies and privileges
  // are not in the schema Drizzle compares.
  type Snapshot = { id: string; prevId: string };
  const snapshot = async (tag: string) =>
    JSON.parse(await file(`meta/${tag}_snapshot.json`)) as Snapshot;
  const before = await snapshot("0024");
  const after = await snapshot("0025");
  expect(after.prevId).toBe(before.id);
  expect({ ...after, id: undefined, prevId: undefined }).toEqual({
    ...before,
    id: undefined,
    prevId: undefined,
  });
});

test("expands appearance to six axes: three columns per table with their checks, the theme and density checks widened under their names, the trigger's seed and a backfill of the untouched 0014 seed, and nothing removed (ruling 255)", async () => {
  const sql = await file("0026_requestport_appearance_six_axes.sql");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim())
    .filter((chunk) => chunk.length > 0);

  // It holds its locks to the commit, so it must be last in its transaction.
  expect(sql.split("\n")[0]).toBe(
    "-- requestport: this migration must be the last one applied in its transaction",
  );
  // Bounded waits, then the membership lock 0014 took, before any table change.
  expect(chunks[0]).toBe("SET LOCAL lock_timeout = '5s';");
  expect(chunks[1]).toBe(
    'LOCK TABLE "public"."organization_members" IN SHARE ROW EXCLUSIVE MODE;',
  );

  // Expand-only: no table, column or row removed; the only DROPs are the two
  // theme checks and the two density checks, each re-added at once under the
  // same name, wider.
  expect(sql).not.toMatch(
    /\b(?:DROP\s+(?:TABLE|COLUMN|TRIGGER|FUNCTION|POLICY|INDEX)|DELETE\s+FROM|TRUNCATE)\b/iu,
  );
  const drops = chunks.filter((chunk) => /\bDROP\b/u.test(chunk));
  expect(drops).toEqual([
    'ALTER TABLE "organization_appearance_defaults" DROP CONSTRAINT "organization_appearance_defaults_theme_check";',
    'ALTER TABLE "user_appearance_preferences" DROP CONSTRAINT "user_appearance_preferences_theme_check";',
    'ALTER TABLE "organization_appearance_defaults" DROP CONSTRAINT "organization_appearance_defaults_density_check";',
    'ALTER TABLE "user_appearance_preferences" DROP CONSTRAINT "user_appearance_preferences_density_check";',
  ]);
  for (const drop of drops) {
    const next = chunks[chunks.indexOf(drop) + 1] ?? "";
    const name = /DROP CONSTRAINT ("[a-z_]+")/u.exec(drop)?.[1] ?? "";
    expect(next).toContain(`ADD CONSTRAINT ${name} CHECK`);
  }

  // Three columns on each table.
  for (const axis of ["font", "look", "paint"]) {
    expect(chunks).toContain(
      `ALTER TABLE "organization_appearance_defaults" ADD COLUMN "${axis}" text DEFAULT 'match' NOT NULL;`,
    );
    expect(chunks).toContain(
      `ALTER TABLE "user_appearance_preferences" ADD COLUMN "${axis}" text;`,
    );
  }

  // Each check 0026 adds names exactly the domain's vocabulary for its axis,
  // in the domain's order: every theme, every density (`compact` among them),
  // and `match` with every typeface, Look and surface. A person's column also
  // admits NULL. A later migration that widens one of these checks moves this
  // comparison to that migration.
  const checkValues = (table: string, axis: string) => {
    const column = `"${table}"."${axis}"`;
    const nullable = table === "user_appearance_preferences";
    const check = chunks.filter((chunk) =>
      chunk.includes(`ADD CONSTRAINT "${table}_${axis}_check" CHECK (`),
    );
    expect(check, `${table}_${axis}_check`).toHaveLength(1);
    const prefix = `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${axis}_check" CHECK (${
      nullable ? `${column} is null or ` : ""
    }${column} in (`;
    const statement = check[0] ?? "";
    expect(statement.startsWith(prefix), `${table}_${axis}_check`).toBe(true);
    expect(statement.endsWith("));"), `${table}_${axis}_check`).toBe(true);
    return statement
      .slice(prefix.length, -"));".length)
      .split(", ")
      .map((value) => /^'([a-z-]+)'$/u.exec(value)?.[1] ?? `<${value}>`);
  };
  for (const table of [
    "organization_appearance_defaults",
    "user_appearance_preferences",
  ]) {
    expect(checkValues(table, "theme"), `${table} theme`).toEqual([
      ...domain.appearanceThemes,
    ]);
    expect(checkValues(table, "density"), `${table} density`).toEqual([
      ...domain.appearanceDensities,
    ]);
    expect(checkValues(table, "font"), `${table} font`).toEqual([
      ...domain.appearanceFonts,
    ]);
    expect(checkValues(table, "look"), `${table} look`).toEqual([
      ...domain.appearanceLooks,
    ]);
    expect(checkValues(table, "paint"), `${table} paint`).toEqual([
      ...domain.appearancePaints,
    ]);
  }

  // The trigger function keeps 0019's definer shape and seeds the new values.
  const body = chunks.find((chunk) =>
    chunk.startsWith(
      "CREATE OR REPLACE FUNCTION public.requestport_initialize_organization_appearance()",
    ),
  );
  expect(body).toBeDefined();
  expect(body).toContain("SECURITY DEFINER");
  expect(body).toContain("SET search_path = pg_catalog, pg_temp");
  expect(body).toContain(
    "(NEW.\"organization_id\", 'cue', 'normal', 'system', 'match', 'match',",
  );
  expect(body).not.toMatch(/'requestport'|'ultra-compact'/u);
  expect(sql).not.toMatch(
    /\bCREATE\s+TRIGGER\b|\bALTER\s+FUNCTION\b|\bGRANT\b|\bREVOKE\b/u,
  );

  // The backfill moves only a version-1 row still exactly 0014's seed, the
  // way the command writes an update: version + 1, one event, one outbox row.
  const backfill = chunks.at(-1) ?? "";
  expect(backfill).toMatch(
    /^WITH "reseeded" AS \(\s*UPDATE "public"\."organization_appearance_defaults"/u,
  );
  expect(backfill.replace(/\s+/gu, " ")).toContain(
    `WHERE "d"."version" = 1 AND "d"."theme" = 'requestport' AND "d"."density" = 'ultra-compact' AND "d"."mode" = 'system' AND "d"."font" = 'match' AND "d"."look" = 'match' AND "d"."paint" = 'match' AND NOT EXISTS (`,
  );
  // A stream already past version 1 is left alone: its version-2 event would
  // collide with the one there.
  expect(backfill.replace(/\s+/gu, " ")).toContain(
    `AND "e"."aggregate_version" > 1)`,
  );
  expect(backfill).toContain('"version" = "d"."version" + 1');
  expect(backfill).toContain("'appearance.organization_defaults_updated.v1'");
  expect(backfill).toContain('INSERT INTO "public"."outbox" ("event_id")');
  expect(backfill).not.toContain("user_appearance_preferences");
});

test("adds agent_oauth_grants.last_used_at, nullable and without a default, behind a lock bound, and nothing else (ruling 261)", async () => {
  const sql = await file("0027_agent_oauth_grant_last_used.sql");
  const chunks = sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gmu, "").trim())
    .filter((chunk) => chunk.length > 0);

  // Its first statement bounds the lock it waits for, as 0017's and 0022's
  // do: ADD COLUMN takes ACCESS EXCLUSIVE on agent_oauth_grants, which every
  // OAuth request reads.
  expect(sql.split("--> statement-breakpoint")[0]).toMatch(
    /^(?:--[^\n]*\n)*SET LOCAL lock_timeout = '5s';$/u,
  );
  // Then the one column, nullable and with no default, so no row is
  // rewritten; no data statement, no other table, no grant.
  expect(chunks).toEqual([
    "SET LOCAL lock_timeout = '5s';",
    'ALTER TABLE "agent_oauth_grants" ADD COLUMN "last_used_at" timestamp with time zone;',
  ]);
  // No last-in-transaction marker: the one table it locks it holds in
  // ACCESS EXCLUSIVE until commit, as 0022 does.
  expect(sql).not.toContain("must be the last one applied");

  // The snapshot says the same: 0026's, and agent_oauth_grants with one more
  // column.
  type Snapshot = {
    id: string;
    prevId: string;
    tables: Record<string, { columns: Record<string, unknown> }>;
  };
  const snapshot = async (tag: string) =>
    JSON.parse(await file(`meta/${tag}_snapshot.json`)) as Snapshot;
  const before = await snapshot("0026");
  const after = await snapshot("0027");
  expect(after.prevId).toBe(before.id);
  const { last_used_at: added, ...kept } =
    after.tables["public.agent_oauth_grants"]?.columns ?? {};
  expect(added).toEqual({
    name: "last_used_at",
    type: "timestamp with time zone",
    primaryKey: false,
    notNull: false,
  });
  expect(kept).toEqual(before.tables["public.agent_oauth_grants"]?.columns);
  const withoutGrantColumns = (whole: Snapshot) => ({
    ...whole,
    id: undefined,
    prevId: undefined,
    tables: {
      ...whole.tables,
      "public.agent_oauth_grants": {
        ...whole.tables["public.agent_oauth_grants"],
        columns: undefined,
      },
    },
  });
  expect(withoutGrantColumns(after)).toEqual(withoutGrantColumns(before));
});
