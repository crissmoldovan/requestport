import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import * as hostedDeployment from "./hosted-deployment.mjs";
import {
  databaseHostDigest,
  refuseUnapprovedProductionDatabase,
  SHARED_DATABASE_LIST_MALFORMED,
  sharedDatabasesOf,
} from "./production-database-guard.mjs";

/*
 * Every case that judges a connection string hands the guard a synthetic list
 * through its second parameter, so this file names no shared database's host.
 * The hosts lie under the reserved `example.test`, shaped as a hosted database
 * spells its two names for one database: a pooled first label ending
 * `-pooler`, and the same label without it. Three cases read the list the
 * guard defaults to instead, and judge only which list it is and the shape of
 * its digests.
 */
const PRODUCTION_OPT_IN = "REQUESTPORT_PRODUCTION_DATABASE";
const STAGING_OPT_IN = "REQUESTPORT_STAGING_DATABASE";
const PRODUCTION_HOST = "db-production-pooler.region-1.example.test";
const STAGING_HOST = "db-staging-pooler.region-1.example.test";
const STAGING_DATABASE = "staging_app";
const hex = (digest) => digest.toString("hex");

/** A list shaped as `scripts/hosted-deployment.mjs` is, naming the hosts above. */
const SYNTHETIC = Object.freeze({
  kind: "private",
  sharedDatabases: Object.freeze([
    Object.freeze({
      name: "production",
      hostSha256: hex(databaseHostDigest(PRODUCTION_HOST)),
      databaseNameSha256: null,
      optIn: PRODUCTION_OPT_IN,
    }),
    Object.freeze({
      name: "staging",
      hostSha256: hex(databaseHostDigest(STAGING_HOST)),
      databaseNameSha256: createHash("sha256")
        .update(STAGING_DATABASE)
        .digest("hex"),
      optIn: STAGING_OPT_IN,
    }),
  ]),
  migrationState: "state.json",
});
const refuse = (environment) =>
  refuseUnapprovedProductionDatabase(environment, SYNTHETIC);

const PRODUCTION = `postgres://u:p@${PRODUCTION_HOST}/appdb`;
/**
 * The same database, spelled the way its service spells it for migrations.
 *
 * A hosted database answers on two hostnames: the pooled one above, and this
 * direct one, which differs only by the `-pooler` suffix on the first label.
 * The console offers the direct string for DDL and drizzle-kit's own guidance
 * asks for it, so reaching for it is the ordinary next step rather than an
 * unusual one — and this repository's `.env.prod` carries it under both
 * `DATABASE_URL_UNPOOLED` and `POSTGRES_URL_NON_POOLING`.
 */
const PRODUCTION_DIRECT =
  "postgres://u:p@db-production.region-1.example.test/appdb";
/** The same host again, as a fully qualified name. Resolves identically. */
const PRODUCTION_FQDN = `postgres://u:p@${PRODUCTION_HOST}./appdb`;
/**
 * Staging, which this guard used to call somebody else's database.
 *
 * It was the fixture for "says nothing about any other database", which is
 * exactly the assumption that let a checkout point at it. It is shared, the
 * acceptance chain counted its rows, and the integrity gate tolerated a pinned
 * residue there — so it is guarded now, and the unrelated-database fixture
 * below is a database that really is unrelated.
 */
const STAGING = `postgres://u:p@${STAGING_HOST}/${STAGING_DATABASE}`;
const STAGING_DIRECT = `postgres://u:p@db-staging.region-1.example.test/${STAGING_DATABASE}`;
const UNRELATED =
  "postgres://u:p@db-unrelated-pooler.region-1.example.test/appdb";

/**
 * Why this exists, in one sentence: on 2026-09-07 a repository checkout's
 * `.env.local` named the production database, so every integration test and
 * every `drizzle-kit migrate` run in this worktree wrote to production —
 * creating a hundred test organizations and applying half a migration pair.
 *
 * The runbook already said to use a target-bound operator context. Prose did
 * not stop it, so this does.
 */
test("refuses production when nothing opted in", () => {
  assert.throws(
    () => refuse({ DATABASE_URL: PRODUCTION }),
    /production database/iu,
  );
});

test("names the variable that would authorize it", () => {
  assert.throws(
    () => refuse({ DATABASE_URL: PRODUCTION }),
    new RegExp(PRODUCTION_OPT_IN, "u"),
  );
});

test("allows production when the opt-in says exactly approved", () => {
  assert.doesNotThrow(() =>
    refuse({
      DATABASE_URL: PRODUCTION,
      [PRODUCTION_OPT_IN]: "approved",
    }),
  );
});

test("refuses an opt-in that is not the exact word", () => {
  for (const value of ["", "true", "1", "yes", "Approved", " approved"]) {
    assert.throws(
      () =>
        refuse({
          DATABASE_URL: PRODUCTION,
          [PRODUCTION_OPT_IN]: value,
        }),
      /production database/iu,
      `opt-in ${JSON.stringify(value)} should not authorize production`,
    );
  }
});

/**
 * The hole this pair closes.
 *
 * The guard pinned one digest of one hostname and treated every other host as
 * somebody else's database — so the direct endpoint, which is the one an
 * operator is told to use for migrations, was waved straight through. That is
 * the 2026-09-07 incident exactly: `drizzle-kit migrate` in a worktree, against
 * production, with the guard reporting nothing at all.
 */
test("refuses production by its direct hostname too", () => {
  assert.throws(
    () => refuse({ DATABASE_URL: PRODUCTION_DIRECT }),
    /production database/iu,
  );
});

test("refuses production written as a fully qualified name", () => {
  assert.throws(
    () => refuse({ DATABASE_URL: PRODUCTION_FQDN }),
    /production database/iu,
  );
});

/**
 * A hostname is case-insensitive, and `new URL()` does not lowercase one for
 * `postgres:`. WHATWG URL folds case only for its special schemes (`http:`,
 * `https:` and the rest); every other scheme keeps the host as written. So an
 * upper-case spelling of production reached this guard with its case intact,
 * hashed to a different digest, and was waved through — while DNS resolved it
 * to production exactly as the lower-case one.
 */
test("refuses production spelled with upper-case letters", () => {
  for (const url of [
    PRODUCTION.toUpperCase().replace("POSTGRES://U:P@", "postgres://u:p@"),
    PRODUCTION_DIRECT.replace("db-production", "DB-Production"),
  ]) {
    assert.equal(
      new URL(url).hostname === new URL(url).hostname.toLowerCase(),
      false,
      "the fixture must reach the guard with its case intact",
    );
    assert.throws(() => refuse({ DATABASE_URL: url }), /production database/iu);
  }
});

/**
 * pg (and the hosted driver) read a `host` in the query in place of the
 * authority's, and pg-connection-string percent-decodes the authority's host
 * while `new URL()` leaves a `postgres:` host encoded. So a string whose
 * authority is loopback, or whose host is percent-encoded, can still reach
 * production — and a guard that judged only `new URL(url).hostname` passed
 * both. Found by Track E.2's review, whose `packages/db` refusal already
 * judges every host a driver reads.
 */
test("refuses production named in the query, where the driver reads its host", () => {
  const url = `postgres://u:p@127.0.0.1:55432/appdb?host=${PRODUCTION_HOST}`;
  assert.equal(new URL(url).hostname, "127.0.0.1");
  assert.throws(() => refuse({ DATABASE_URL: url }), /production database/iu);
});

test("refuses production whose host is percent-encoded", () => {
  const url = PRODUCTION.replace(
    "db-production-pooler",
    "db%2Dproduction%2Dpooler",
  );
  assert.match(
    new URL(url).hostname,
    /%2D/iu,
    "the fixture must reach the guard encoded",
  );
  assert.throws(() => refuse({ DATABASE_URL: url }), /production database/iu);
});

test("refuses staging named in the query too", () => {
  const staging = new URL(STAGING);
  const url = `postgres://u:p@127.0.0.1:55432${staging.pathname}?host=${staging.hostname}`;
  assert.equal(new URL(url).hostname, "127.0.0.1");
  assert.throws(() => refuse({ DATABASE_URL: url }), /staging database/iu);
});

test("the opt-in still authorizes every spelling of production", () => {
  for (const url of [PRODUCTION, PRODUCTION_DIRECT, PRODUCTION_FQDN]) {
    assert.doesNotThrow(() =>
      refuse({
        DATABASE_URL: url,
        [PRODUCTION_OPT_IN]: "approved",
      }),
    );
  }
});

test("says nothing about any other database", () => {
  assert.doesNotThrow(() => refuse({ DATABASE_URL: UNRELATED }));
  // Normalising the pooler suffix must not make a neighbour look like either
  // guarded database.
  assert.doesNotThrow(() =>
    refuse({
      DATABASE_URL: "postgres://u:p@db-unrelated.region-1.example.test/appdb",
    }),
  );
  assert.doesNotThrow(() => refuse({}));
});

test("never puts the connection string in the refusal", () => {
  try {
    refuse({ DATABASE_URL: PRODUCTION });
    assert.fail("expected a refusal");
  } catch (error) {
    const text = String(error.message);
    assert.equal(text.includes("p@"), false);
    assert.equal(text.includes(PRODUCTION), false);
    assert.equal(text.includes(PRODUCTION_HOST), false);
  }
});

/*
 * Over the list the guard reads when none is handed in: production and
 * staging in the private tree, which private-paths.test.mjs pins by name, and
 * none in the public seed.
 */
test("the recorded digest is a sha256 of a hostname, not a hostname", () => {
  for (const { hostSha256 } of sharedDatabasesOf()) {
    assert.match(hostSha256, /^[0-9a-f]{64}$/u);
  }
});

/**
 * Why staging is guarded at all.
 *
 * The guard was written after a checkout's `.env.local` named production. It
 * pinned production and stopped, so the same accident against staging stayed
 * open — and on 2026-09-14 a day of local `turbo run test` runs, integration
 * suites included, executed against the database the staging gate measured.
 * Lower cost than production, but not no cost: the acceptance chain counted
 * those rows.
 */
test("refuses staging by either of the names it answers to", () => {
  for (const url of [STAGING, STAGING_DIRECT]) {
    assert.throws(() => refuse({ DATABASE_URL: url }), /staging database/iu);
  }
});

test("names the variable that would authorize staging", () => {
  assert.throws(
    () => refuse({ DATABASE_URL: STAGING }),
    new RegExp(STAGING_OPT_IN, "u"),
  );
});

test("allows staging when its own opt-in says exactly approved", () => {
  assert.doesNotThrow(() =>
    refuse({
      DATABASE_URL: STAGING,
      [STAGING_OPT_IN]: "approved",
    }),
  );
});

/**
 * The two opt-ins are not interchangeable.
 *
 * Somebody who approved production once, in a shell they kept, must not find
 * that it also waves staging through — and the reverse matters more, because
 * staging is the one a person has a routine reason to approve.
 */
test("one database's approval does not authorize the other", () => {
  assert.throws(
    () =>
      refuse({
        DATABASE_URL: STAGING,
        [PRODUCTION_OPT_IN]: "approved",
      }),
    /staging database/iu,
  );
  assert.throws(
    () =>
      refuse({
        DATABASE_URL: PRODUCTION,
        [STAGING_OPT_IN]: "approved",
      }),
    /production database/iu,
  );
});

test("the staging digest is a sha256, and not production's", () => {
  const digests = sharedDatabasesOf().map(({ hostSha256 }) => hostSha256);
  for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/u);
  // No two recorded databases share a host digest, so none is refused as
  // another: staging's is not production's.
  assert.equal(new Set(digests).size, digests.length);
});

/**
 * The run this must never refuse.
 *
 * A CI run built its database URL by taking a branch's connection string and
 * replacing only the database name, so if a branch endpoint ever shared
 * staging's host, a host-only rule would have refused every verification in
 * the repository. Requiring the name too means only staging's own database is
 * refused and a per-run one passes — which is what this asserts, on the
 * staging entry's exact host.
 */
test("allows a per-run database that merely shares staging's endpoint", () => {
  for (const name of [
    "requestport_ci_1234_1_normal",
    "requestport_ci_1234_1_race",
  ]) {
    assert.doesNotThrow(() =>
      refuse({ DATABASE_URL: `postgres://u:p@${STAGING_HOST}/${name}` }),
    );
  }
});

test("still refuses staging's own database on that endpoint", () => {
  assert.throws(() => refuse({ DATABASE_URL: STAGING }), /staging database/iu);
});

/*
 * The list itself (ruling 91, option (d)): read from
 * `scripts/hosted-deployment.mjs` unless a caller hands one in, checked on
 * every call, and refusing everything when it is wrong.
 */

test("reads the hosted deployment's list when no list is handed in", () => {
  assert.equal(sharedDatabasesOf(), hostedDeployment.sharedDatabases);
  assert.equal(sharedDatabasesOf(SYNTHETIC), SYNTHETIC.sharedDatabases);
});

test("a public list, with no shared database, refuses nothing", () => {
  const publicList = {
    kind: "public",
    sharedDatabases: [],
    migrationState: null,
  };
  for (const url of [PRODUCTION, STAGING, "postgres://u@127.0.0.1:5432/app"]) {
    assert.doesNotThrow(() =>
      refuseUnapprovedProductionDatabase({ DATABASE_URL: url }, publicList),
    );
  }
});

const PRODUCTION_ENTRY = SYNTHETIC.sharedDatabases[0];
const STAGING_ENTRY = SYNTHETIC.sharedDatabases[1];
const withEntry = (changes) => ({
  kind: "private",
  sharedDatabases: [{ ...PRODUCTION_ENTRY, ...changes }],
});
const withoutKey = (key) => {
  const entry = { ...PRODUCTION_ENTRY };
  delete entry[key];
  return { kind: "private", sharedDatabases: [entry] };
};

/** One list per way a list can be wrong; each must refuse everything. */
const MALFORMED = [
  ["no list at all", null],
  ["a list that is not an object", "private"],
  ["no kind", { sharedDatabases: [PRODUCTION_ENTRY] }],
  ["an unknown kind", { kind: "hosted", sharedDatabases: [PRODUCTION_ENTRY] }],
  [
    "a kind in another case",
    { kind: "Private", sharedDatabases: [PRODUCTION_ENTRY] },
  ],
  ["a private list with no entry", { kind: "private", sharedDatabases: [] }],
  [
    "a public list with an entry",
    { kind: "public", sharedDatabases: [PRODUCTION_ENTRY] },
  ],
  [
    "entries that are not an array",
    { kind: "private", sharedDatabases: { production: PRODUCTION_ENTRY } },
  ],
  ["no entries", { kind: "private" }],
  [
    "an entry that is not an object",
    { kind: "private", sharedDatabases: [null] },
  ],
  ["an entry with no name", withoutKey("name")],
  ["an entry with no host digest", withoutKey("hostSha256")],
  [
    "an entry with no database-name digest, not even null",
    withoutKey("databaseNameSha256"),
  ],
  ["an entry with no opt-in", withoutKey("optIn")],
  [
    "an entry with a key the list does not define",
    withEntry({ host: "db.example.test" }),
  ],
  ["a name that is not a lower-case word", withEntry({ name: "Production" })],
  [
    "a name used twice",
    {
      kind: "private",
      sharedDatabases: [
        PRODUCTION_ENTRY,
        { ...STAGING_ENTRY, name: "production" },
      ],
    },
  ],
  [
    "a host digest one character short",
    withEntry({ hostSha256: PRODUCTION_ENTRY.hostSha256.slice(1) }),
  ],
  [
    "a host digest in upper case",
    withEntry({ hostSha256: PRODUCTION_ENTRY.hostSha256.toUpperCase() }),
  ],
  ["a host digest that is not a string", withEntry({ hostSha256: 42 })],
  [
    "a database-name digest that is neither null nor 64 hex",
    withEntry({ databaseNameSha256: "" }),
  ],
  [
    "an opt-in not named REQUESTPORT_<…>_DATABASE",
    withEntry({ optIn: "PRODUCTION_DATABASE" }),
  ],
  [
    "an opt-in in lower case",
    withEntry({ optIn: "requestport_production_database" }),
  ],
];

test("each malformed list refuses a loopback URL, and a command with no DATABASE_URL", () => {
  for (const [what, list] of MALFORMED) {
    for (const environment of [
      { DATABASE_URL: "postgres://u@127.0.0.1:5432/app" },
      {},
    ]) {
      assert.throws(
        () => refuseUnapprovedProductionDatabase(environment, list),
        (error) => error.message === SHARED_DATABASE_LIST_MALFORMED,
        `${what}: ${JSON.stringify(environment)}`,
      );
    }
  }
  assert.match(
    SHARED_DATABASE_LIST_MALFORMED,
    /the shared-database list is malformed/u,
  );
});

test("the well-formed list these cases use passes the same check, so each malformed one fails for its own fault", () => {
  assert.doesNotThrow(() => sharedDatabasesOf(SYNTHETIC));
  assert.doesNotThrow(() =>
    refuseUnapprovedProductionDatabase(
      { DATABASE_URL: "postgres://u@127.0.0.1:5432/app" },
      withEntry({}),
    ),
  );
});
