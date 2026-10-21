import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  APPLICATION_DATABASE_URL_VARIABLE,
  applicationDatabaseUrlSelected,
  isolatedPgConnectionString,
  readApplicationDatabaseUrl,
  readDatabaseUrl,
  refuseUnapprovedSharedPgDatabase,
  refuseUnoverridablePgVariables,
  SHARED_DATABASE_LIST_MALFORMED,
  type SharedDatabaseList,
  sharedDatabasesOf,
  UNOVERRIDABLE_PG_VARIABLES,
} from "./database-url.js";
import * as sharedDatabases from "./shared-databases.js";

/*
 * The pg path's connection parameters (track-e.md, contract §3.4). The
 * client-level proof — a real `pg` client constructed under hostile `PG*`
 * values — is in client.test.ts; these pin the two rules it is built from.
 */

const SENTINEL = "sentinel-value-that-must-not-leak";

describe("readDatabaseUrl, unchanged", () => {
  test("still picks the preview variable only under VERCEL_ENV=preview", () => {
    expect(
      readDatabaseUrl({
        DATABASE_URL: "postgresql://u:p@main.example/main",
        REQUESTPORT_PREVIEW_DATABASE_URL:
          "postgresql://u:p@preview.example/preview",
        VERCEL_ENV: "preview",
      }),
    ).toBe("postgresql://u:p@preview.example/preview");
    expect(
      readDatabaseUrl({
        DATABASE_URL: "postgresql://u:p@main.example/main",
        REQUESTPORT_PREVIEW_DATABASE_URL:
          "postgresql://u:p@preview.example/preview",
      }),
    ).toBe("postgresql://u:p@main.example/main");
  });

  test("still accepts a URL without a user, because the hosted driver's path is unchanged", () => {
    // Contract §3.4's refusals apply to the opt-in pg path only; the hosted
    // driver's path keeps passing exactly what it passes today (wave-one
    // ruling 3).
    expect(readDatabaseUrl({ DATABASE_URL: "postgresql://h.example/d" })).toBe(
      "postgresql://h.example/d",
    );
  });
});

describe("the application's own connection string (manifest-i2.md §1, §2.8 item 2)", () => {
  const OWNER = "postgresql://owner:pw@main.example/main";
  const APPLICATION = "postgresql://app:pw@main.example/main";
  const PREVIEW = "postgresql://u:p@preview.example/preview";

  test("is named REQUESTPORT_APPLICATION_DATABASE_URL", () => {
    expect(APPLICATION_DATABASE_URL_VARIABLE).toBe(
      "REQUESTPORT_APPLICATION_DATABASE_URL",
    );
  });

  test("is read when set, in place of DATABASE_URL", () => {
    const env = {
      DATABASE_URL: OWNER,
      [APPLICATION_DATABASE_URL_VARIABLE]: APPLICATION,
    };

    expect(applicationDatabaseUrlSelected(env)).toBe(true);
    expect(readApplicationDatabaseUrl(env)).toBe(APPLICATION);
    // The migrator's reader is untouched: it still names the owner.
    expect(readDatabaseUrl(env)).toBe(OWNER);
  });

  /** What `read` throws, as a string; a read that answers fails the case. */
  function refusalOf(read: () => unknown): string {
    try {
      read();
    } catch (error) {
      return String(error);
    }
    throw new Error("expected a refusal, and the read answered");
  }

  test("refuses when unset or blank, naming the variable, and never reads DATABASE_URL in its place (I.2 step 5)", () => {
    for (const value of [undefined, "", "   "]) {
      const env = {
        DATABASE_URL: `postgresql://owner:${SENTINEL}@main.example/main`,
        [APPLICATION_DATABASE_URL_VARIABLE]: value,
      };
      const refusal = refusalOf(() => readApplicationDatabaseUrl(env));

      expect(applicationDatabaseUrlSelected(env)).toBe(false);
      expect(refusal, JSON.stringify(value)).toContain(
        "RequestPort database configuration is invalid.",
      );
      expect(refusal, JSON.stringify(value)).toContain(
        "REQUESTPORT_APPLICATION_DATABASE_URL is not set",
      );
      expect(refusal, JSON.stringify(value)).not.toContain(SENTINEL);
      expect(refusal, JSON.stringify(value)).not.toContain("main.example");
    }
  });

  test("is never read by a preview, which keeps its own variable", () => {
    const env = {
      DATABASE_URL: OWNER,
      REQUESTPORT_PREVIEW_DATABASE_URL: PREVIEW,
      [APPLICATION_DATABASE_URL_VARIABLE]: APPLICATION,
      VERCEL_ENV: "preview",
    };

    expect(applicationDatabaseUrlSelected(env)).toBe(false);
    expect(readApplicationDatabaseUrl(env)).toBe(PREVIEW);
  });

  test("in a preview without its own variable, refuses naming REQUESTPORT_PREVIEW_DATABASE_URL, and reads neither DATABASE_URL nor the application variable", () => {
    for (const value of [undefined, "", "   "]) {
      const env = {
        DATABASE_URL: `postgresql://owner:${SENTINEL}@main.example/main`,
        [APPLICATION_DATABASE_URL_VARIABLE]: `postgresql://app:${SENTINEL}@app.example/main`,
        REQUESTPORT_PREVIEW_DATABASE_URL: value,
        VERCEL_ENV: "preview",
      };
      const refusal = refusalOf(() => readApplicationDatabaseUrl(env));

      expect(refusal, JSON.stringify(value)).toContain(
        "REQUESTPORT_PREVIEW_DATABASE_URL is not set",
      );
      expect(refusal, JSON.stringify(value)).not.toContain(SENTINEL);
      expect(refusal, JSON.stringify(value)).not.toContain(".example");
    }
  });

  test("refuses a malformed value, naming the variable and never echoing the value", () => {
    for (const [env, name] of [
      [
        {
          DATABASE_URL: OWNER,
          [APPLICATION_DATABASE_URL_VARIABLE]: `mysql://${SENTINEL}@h/d`,
        },
        "REQUESTPORT_APPLICATION_DATABASE_URL",
      ],
      [
        {
          DATABASE_URL: OWNER,
          REQUESTPORT_PREVIEW_DATABASE_URL: `mysql://${SENTINEL}@h/d`,
          VERCEL_ENV: "preview",
        },
        "REQUESTPORT_PREVIEW_DATABASE_URL",
      ],
    ] as const) {
      const refusal = refusalOf(() => readApplicationDatabaseUrl(env));

      expect(refusal, name).toContain(
        "RequestPort database configuration is invalid.",
      );
      expect(refusal, name).toContain(
        `${name} is not a postgres URL naming a host and a database`,
      );
      expect(refusal, name).not.toContain(SENTINEL);
    }
  });
});

describe("the connection string the pg path hands its driver", () => {
  test("writes out the port when the URL names none", () => {
    // pg-connection-string turns a missing port into "", which pg treats as
    // absent and fills from PGPORT.
    const normalised = isolatedPgConnectionString(
      "postgresql://someone:pw@db.example/app",
    );

    expect(new URL(normalised).port).toBe("5432");
    expect(new URL(normalised).hostname).toBe("db.example");
    expect(new URL(normalised).pathname).toBe("/app");
    expect(new URL(normalised).username).toBe("someone");
    expect(new URL(normalised).password).toBe("pw");
  });

  test("keeps a port the URL names", () => {
    expect(
      new URL(
        isolatedPgConnectionString(
          "postgresql://someone:pw@db.example:55432/app",
        ),
      ).port,
    ).toBe("55432");
  });

  test("keeps the query string, sslmode included", () => {
    expect(
      new URL(
        isolatedPgConnectionString(
          "postgresql://someone:pw@db.example/app?sslmode=require",
        ),
      ).searchParams.get("sslmode"),
    ).toBe("require");
  });

  test("refuses a query parameter that would replace the host, port, user or password", () => {
    /*
     * pg-connection-string copies every query parameter into the config and
     * lets `host`, `port`, `user` and `password` there win over the
     * authority's, so `…@127.0.0.1/app?host=elsewhere` dials elsewhere while
     * every check that reads the URL's host sees loopback. `hostaddr` is
     * libpq's, which pg does not read today; it is refused all the same.
     */
    for (const name of ["host", "hostaddr", "port", "user", "password"]) {
      const url = `postgresql://someone:pw@127.0.0.1:55432/app?sslmode=disable&${name}=${SENTINEL}`;

      expect(() => isolatedPgConnectionString(url), name).toThrow(
        `query parameter "${name}"`,
      );
      expect(() => isolatedPgConnectionString(url), name).not.toThrow(SENTINEL);
    }
  });

  test("refuses a URL without a user, and never echoes it", () => {
    const url = `postgresql://:${SENTINEL}@db.example/app`;

    expect(() => isolatedPgConnectionString(url)).toThrow(/user/u);
    expect(() => isolatedPgConnectionString(url)).not.toThrow(SENTINEL);
    expect(() =>
      isolatedPgConnectionString("postgresql://db.example/app"),
    ).toThrow(/user/u);
  });

  test("refuses a user with no password, and one with an empty password", () => {
    for (const url of [
      "postgresql://someone@db.example/app",
      "postgresql://someone:@db.example/app",
    ]) {
      expect(() => isolatedPgConnectionString(url), url).toThrow(/password/u);
    }
  });

  test("accepts a user with no password when a password function is supplied", () => {
    expect(
      new URL(
        isolatedPgConnectionString("postgresql://someone@db.example/app", {
          password: () => "from-a-function",
        }),
      ).username,
    ).toBe("someone");
  });

  test("applies the same scheme, host and database rules as readDatabaseUrl", () => {
    for (const url of [
      "",
      "not a url",
      `mysql://someone:${SENTINEL}@db.example/app`,
      `postgresql://someone:${SENTINEL}@db.example`,
      `postgresql://someone:${SENTINEL}@db.example/`,
    ]) {
      expect(() => isolatedPgConnectionString(url), url).toThrow(
        "RequestPort database configuration is invalid.",
      );
    }
  });
});

describe("the PG* variables no configuration can override", () => {
  test("are exactly the six the contract names", () => {
    expect([...UNOVERRIDABLE_PG_VARIABLES].sort()).toEqual(
      [
        "PGAPPNAME",
        "PGBINARY",
        "PGCLIENT_ENCODING",
        "PGOPTIONS",
        "PGREPLICATION",
        "PGSSLNEGOTIATION",
      ].sort(),
    );
  });

  test("each one refuses, naming the variable and never its value", () => {
    for (const name of UNOVERRIDABLE_PG_VARIABLES) {
      const env = { [name]: SENTINEL };

      expect(() => refuseUnoverridablePgVariables(env), name).toThrow(name);

      try {
        refuseUnoverridablePgVariables(env);
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(SENTINEL);
      }
    }
  });

  test("an empty value is not set, and nothing else refuses", () => {
    expect(() =>
      refuseUnoverridablePgVariables({
        PGOPTIONS: "",
        PGUSER: SENTINEL,
        PGPASSWORD: SENTINEL,
        PGHOST: SENTINEL,
        PGSSLMODE: "require",
      }),
    ).not.toThrow();
  });
});

/*
 * The pg path's refusal of a shared database (contract §3.4, last paragraph;
 * ruling 91, option (d)). Every case hands it a synthetic list through its
 * third parameter, so this file names no shared database's host. The hosts lie
 * under the reserved `example.test`, a pooled first label ending `-pooler`
 * beside the same label without it. client.test.ts and testing.test.ts prove
 * the same refusal through its callers, with `./shared-databases.js` replaced.
 */
describe("the refusal of a shared database, against the list it is given", () => {
  const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const PRODUCTION_HOST = "db-production-pooler.region-1.example.test";
  const STAGING_HOST = "db-staging-pooler.region-1.example.test";
  const PRODUCTION_ENTRY = {
    name: "production",
    hostSha256: sha256("db-production.region-1.example.test"),
    databaseNameSha256: null,
    optIn: "REQUESTPORT_PRODUCTION_DATABASE",
  };
  const STAGING_ENTRY = {
    name: "staging",
    hostSha256: sha256("db-staging.region-1.example.test"),
    databaseNameSha256: sha256("staging_app"),
    optIn: "REQUESTPORT_STAGING_DATABASE",
  };
  const SYNTHETIC: SharedDatabaseList = {
    kind: "private",
    entries: [PRODUCTION_ENTRY, STAGING_ENTRY],
  };
  const LOOPBACK = "postgresql://u:p@127.0.0.1:5432/app";
  const refuse = (connectionString: string, env: NodeJS.ProcessEnv = {}) =>
    refuseUnapprovedSharedPgDatabase(connectionString, env, SYNTHETIC);

  test("refuses each host the list names, however the driver would read it, naming the opt-in and not the host", () => {
    for (const url of [
      `postgresql://u:p@${PRODUCTION_HOST}/app`,
      "postgresql://u:p@db-production.region-1.example.test/app",
      `postgresql://u:p@${PRODUCTION_HOST}./app`,
      `postgresql://u:p@${PRODUCTION_HOST.toUpperCase()}/app`,
      `postgresql://u:p@127.0.0.1:5432/app?host=${PRODUCTION_HOST}`,
      "postgresql://u:p@db%2Dproduction%2Dpooler.region-1.example.test/app",
    ]) {
      expect(() => refuse(url), url).toThrow(
        /production database.*REQUESTPORT_PRODUCTION_DATABASE=approved/su,
      );
      expect(() => refuse(url), url).not.toThrow(/db-production|example/u);
    }
  });

  test("lets a listed database through only on its own opt-in, reading exactly approved", () => {
    const production = `postgresql://u:p@${PRODUCTION_HOST}/app`;
    for (const value of ["true", "1", "Approved", " approved", ""]) {
      expect(
        () => refuse(production, { REQUESTPORT_PRODUCTION_DATABASE: value }),
        value,
      ).toThrow(/production database/u);
    }
    expect(() =>
      refuse(production, { REQUESTPORT_STAGING_DATABASE: "approved" }),
    ).toThrow(/production database/u);
    expect(() =>
      refuse(production, { REQUESTPORT_PRODUCTION_DATABASE: "approved" }),
    ).not.toThrow();
  });

  test("refuses staging's own database, and lets a per-run one on its endpoint through", () => {
    expect(() =>
      refuse(`postgresql://u:p@${STAGING_HOST}/staging_app`),
    ).toThrow(/staging database.*REQUESTPORT_STAGING_DATABASE=approved/su);
    expect(() =>
      refuse(`postgresql://u:p@${STAGING_HOST}/requestport_ci_1234_1_normal`),
    ).not.toThrow();
  });

  test("says nothing about a host the list does not name", () => {
    for (const url of [
      LOOPBACK,
      "postgresql://u:p@db-unrelated-pooler.region-1.example.test/app",
      "postgresql://u:p@db-unrelated.region-1.example.test/app",
    ]) {
      expect(() => refuse(url), url).not.toThrow();
    }
  });

  test("a public list, with no entry, refuses nothing", () => {
    const publicList: SharedDatabaseList = { kind: "public", entries: [] };
    for (const url of [`postgresql://u:p@${PRODUCTION_HOST}/app`, LOOPBACK]) {
      expect(() =>
        refuseUnapprovedSharedPgDatabase(url, {}, publicList),
      ).not.toThrow();
    }
  });

  test("reads ./shared-databases.ts's list when no list is handed in", () => {
    expect(sharedDatabasesOf()).toBe(sharedDatabases.entries);
    expect(sharedDatabasesOf(SYNTHETIC)).toBe(SYNTHETIC.entries);
  });

  const withEntry = (changes: Record<string, unknown>): SharedDatabaseList => ({
    kind: "private",
    entries: [{ ...PRODUCTION_ENTRY, ...changes }],
  });
  const withoutKey = (key: string): SharedDatabaseList => {
    const entry: Record<string, unknown> = { ...PRODUCTION_ENTRY };
    delete entry[key];
    return { kind: "private", entries: [entry] };
  };
  /** One list per way a list can be wrong; each must refuse everything. */
  const MALFORMED: [string, unknown][] = [
    ["no list at all", null],
    ["a list that is not an object", "private"],
    ["no kind", { entries: [PRODUCTION_ENTRY] }],
    ["an unknown kind", { kind: "hosted", entries: [PRODUCTION_ENTRY] }],
    [
      "a kind in another case",
      { kind: "Private", entries: [PRODUCTION_ENTRY] },
    ],
    ["a private list with no entry", { kind: "private", entries: [] }],
    [
      "a public list with an entry",
      { kind: "public", entries: [PRODUCTION_ENTRY] },
    ],
    [
      "entries that are not an array",
      { kind: "private", entries: { production: PRODUCTION_ENTRY } },
    ],
    ["no entries", { kind: "private" }],
    ["an entry that is not an object", { kind: "private", entries: [null] }],
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
        entries: [PRODUCTION_ENTRY, { ...STAGING_ENTRY, name: "production" }],
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

  test("each malformed list refuses a loopback URL, and a string it cannot parse", () => {
    for (const [what, list] of MALFORMED) {
      for (const url of [LOOPBACK, "not a url"]) {
        expect(
          () =>
            refuseUnapprovedSharedPgDatabase(
              url,
              {},
              list as SharedDatabaseList,
            ),
          `${what}: ${url}`,
        ).toThrow(SHARED_DATABASE_LIST_MALFORMED);
      }
    }
    expect(SHARED_DATABASE_LIST_MALFORMED).toMatch(
      /the shared-database list is malformed/u,
    );
  });

  test("the well-formed list these cases use passes the same check, so each malformed one fails for its own fault", () => {
    expect(() => sharedDatabasesOf(SYNTHETIC)).not.toThrow();
    expect(() =>
      refuseUnapprovedSharedPgDatabase(LOOPBACK, {}, withEntry({})),
    ).not.toThrow();
  });
});
