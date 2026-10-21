import { readSignInMethods } from "@requestport/config/sign-in-methods";
import {
  createDatabaseRoleGuard,
  DatabaseRoleGuardError,
} from "@requestport/db";
import { describe, expect, test } from "vitest";

import { LOGIN_URL_VARIABLES } from "../configuration.js";
import {
  namedLoginUrls,
  ownerCapableNames,
  pgliteHonestyLine,
  removeLoginUrlVariables,
  removeOwnerCapableVariables,
  removeSignInProviderVariables,
  SIGN_IN_PROVIDER_VARIABLES,
  servingApplicationName,
  withApplicationName,
} from "./environment.js";
import { authEnvironment } from "./serve.js";

/*
 * The serving process's environment (ruling 158, item 11; Done when 5 and
 * 10): what `requestport start` removes before it serves, held to the role
 * guard's own environment check, and the name its connections carry.
 */

const SENTINEL = "S3NT1NEL-value-never-printed";

/** The guard's environment check, in enforce mode, for a process declared `application`. */
function environmentCheck(env: NodeJS.ProcessEnv) {
  return () =>
    createDatabaseRoleGuard({
      env,
      surface: () => "application",
      modes: {
        declaration: "enforce",
        environment: "enforce",
        role: "enforce",
      },
      write: () => undefined,
    }).beforeConnect();
}

describe("the owner-capable names", () => {
  const inherited = () => ({
    DATABASE_URL: `postgres://owner:${SENTINEL}@127.0.0.1/db`,
    // The direct owner URL the audit of 2026-10-17 found in Trigger.dev
    // prod beside DATABASE_URL (ruling 217 item 2).
    DATABASE_URL_UNPOOLED: `postgres://owner:${SENTINEL}@127.0.0.1/db`,
    PGPASSWORD: SENTINEL,
    PGCONNECT_TIMEOUT: "5",
    POSTGRES_URL: SENTINEL,
    PATH: "/usr/bin",
    REQUESTPORT_APPLICATION_DATABASE_URL: "postgres://app:pw@127.0.0.1/db",
    REQUESTPORT_DISPATCHER_DATABASE_URL: "postgres://d:pw@127.0.0.1/db",
    PG_LIKE: SENTINEL,
    XPGHOST: "kept",
    XDATABASE_URL_UNPOOLED: "kept",
  });

  test("are exactly what the role guard's environment check refuses", () => {
    const env = inherited();
    const names = ownerCapableNames(env);

    expect(names).toEqual([
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "PGCONNECT_TIMEOUT",
      "PGPASSWORD",
      "PG_LIKE",
      "POSTGRES_URL",
    ]);
    expect(environmentCheck(env)).toThrow(DatabaseRoleGuardError);
    expect(environmentCheck(env)).toThrow(`it names ${names.join(", ")}.`);
  });

  test("are removed, one line each naming the variable and never its value, and the guard then passes", () => {
    const env: NodeJS.ProcessEnv = inherited();
    const lines: string[] = [];

    const removed = removeOwnerCapableVariables(env, (line) =>
      lines.push(line),
    );

    expect(removed).toEqual(ownerCapableNames(inherited()));
    expect(lines).toHaveLength(removed.length);
    for (const [index, name] of removed.entries()) {
      expect(lines[index]).toBe(
        `removed ${name} from the serving process's environment: it connects as this instance's logins, never through ${name}.`,
      );
    }
    expect(lines.join("\n")).not.toContain(SENTINEL);
    expect(Object.keys(env).sort()).toEqual([
      "PATH",
      "REQUESTPORT_APPLICATION_DATABASE_URL",
      "REQUESTPORT_DISPATCHER_DATABASE_URL",
      "XDATABASE_URL_UNPOOLED",
      "XPGHOST",
    ]);
    expect(environmentCheck(env)).not.toThrow();
  });

  /*
   * This module writes the rule out rather than importing the guard's
   * (above), so this holds the two lists equal, name by name, at each edge
   * of each part of the rule: a name the guard refuses and this leaves in
   * the serving process, or the reverse, fails here (ruling 217 item 2).
   */
  test("agree with the role guard's own list, name by name, at every edge of the rule", () => {
    const corpus = [
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "DATABASE_URL_POOLED",
      "DATABASE_URL_",
      "DATABASE_URLS",
      "XDATABASE_URL",
      "XDATABASE_URL_UNPOOLED",
      "database_url",
      "REQUESTPORT_APPLICATION_DATABASE_URL",
      "REQUESTPORT_DISPATCHER_DATABASE_URL",
      "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
      "REQUESTPORT_MAINTENANCE_DATABASE_URL",
      "REQUESTPORT_LOCAL_DATABASE_URL",
      "REQUESTPORT_PREVIEW_DATABASE_URL",
      "POSTGRES_URL",
      "POSTGRES_",
      "POSTGRES",
      "POSTGRESQL_URL",
      "PG",
      "PGHOST",
      "PGHOST_UNPOOLED",
      "PG_LIKE",
      "PGhost",
      "XPGHOST",
      "TRIGGER_PROJECT_REF",
      "PATH",
      // Each prefix followed by a letter at either end of the range, a digit
      // at either end, an underscore, a lowercase letter and a hyphen: a copy
      // whose character class dropped digits or case would differ here.
      ...["PG", "POSTGRES_", "DATABASE_URL", "DATABASE_URL_"].flatMap(
        (prefix) =>
          ["A", "Z", "0", "9", "_", "a", "z", "-"].map((tail) => prefix + tail),
      ),
    ];
    /**
     * The guard's own list: its environment check's objections, which it
     * records before it refuses (it refuses since I.2 step 7) or passes.
     */
    const guardNames = (env: NodeJS.ProcessEnv) => {
      const guard = createDatabaseRoleGuard({
        env,
        surface: () => "application",
        write: () => undefined,
      });
      try {
        guard.beforeConnect();
      } catch (error) {
        if (!(error instanceof DatabaseRoleGuardError)) throw error;
      }
      return (
        guard
          .report()
          .findings.find((finding) => finding.check === "environment")
          ?.objections ?? []
      );
    };

    for (const name of corpus) {
      const env = { [name]: SENTINEL };
      expect(ownerCapableNames(env), name).toEqual(guardNames(env));
    }
    const all = Object.fromEntries(corpus.map((name) => [name, SENTINEL]));
    expect(ownerCapableNames(all)).toEqual(guardNames(all));
    expect(ownerCapableNames(all)).toContain("DATABASE_URL_UNPOOLED");
  });

  test("an environment with none of them is left as it was, and nothing is said", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const lines: string[] = [];

    expect(
      removeOwnerCapableVariables(env, (line) => lines.push(line)),
    ).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(lines).toEqual([]);
  });
});

/*
 * The GitHub and Resend pairs (H.5, after the independent review):
 * `requestport start` composes Better Auth without either
 * (`authEnvironment`, `serve.ts`) and hands core no e-mail sender, while
 * Next's sign-in page, served in the same process, reads its methods from
 * this environment (`readSignInMethods(process.env)`). So the serving step
 * removes both pairs, as it removes the owner-capable names.
 */
describe("the sign-in providers' names", () => {
  const inherited = () => ({
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: SENTINEL,
    RESEND_API_KEY: `re_${SENTINEL}`,
    RESEND_FROM_EMAIL: "requestport@example.invalid",
    PATH: "/usr/bin",
    REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID: "kept",
    XGITHUB_CLIENT_ID: "kept",
  });

  test("are the GitHub pair and the Resend pair", () => {
    expect([...SIGN_IN_PROVIDER_VARIABLES]).toEqual([
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
    ]);
  });

  test("with them, the sign-in methods offer GitHub and the e-mailed link, and not the local credential", () => {
    expect(readSignInMethods(inherited())).toEqual({
      github: true,
      magicLink: true,
      localCredential: false,
    });
  });

  test("are removed, one line each naming the variable and never its value, and the sign-in methods are then the local credential alone; nothing else is removed", () => {
    const env: NodeJS.ProcessEnv = inherited();
    const lines: string[] = [];

    const removed = removeSignInProviderVariables(env, (line) =>
      lines.push(line),
    );

    expect(removed).toEqual([...SIGN_IN_PROVIDER_VARIABLES]);
    expect(lines).toEqual(
      removed.map(
        (name) =>
          `removed ${name} from the serving process's environment: requestport start offers no GitHub sign-in and sends no e-mail, and the sign-in page Next serves reads this environment.`,
      ),
    );
    expect(lines.join("\n")).not.toContain(SENTINEL);
    expect(env).toEqual({
      PATH: "/usr/bin",
      REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID: "kept",
      XGITHUB_CLIENT_ID: "kept",
    });
    expect(readSignInMethods(env)).toEqual({
      github: false,
      magicLink: false,
      localCredential: true,
    });
  });

  test("half a pair, or an empty value, is removed too", () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_CLIENT_ID: "",
      RESEND_API_KEY: SENTINEL,
    };
    const lines: string[] = [];

    expect(
      removeSignInProviderVariables(env, (line) => lines.push(line)),
    ).toEqual(["GITHUB_CLIENT_ID", "RESEND_API_KEY"]);
    expect(env).toEqual({});
    expect(lines).toHaveLength(2);
  });

  test("Better Auth's composition leaves both pairs out whatever the parsed configuration holds (authEnvironment), so that a caller that composes the host alone offers neither", () => {
    const composed = authEnvironment(
      {
        BETTER_AUTH_URL: "http://127.0.0.1:3200",
        ...inherited(),
      } as unknown as Parameters<typeof authEnvironment>[0],
      { VERCEL_ENV: undefined },
    );

    for (const name of SIGN_IN_PROVIDER_VARIABLES) {
      expect(composed[name], name).toBeUndefined();
    }
    expect(composed.BETTER_AUTH_URL).toBe("http://127.0.0.1:3200");
    expect(readSignInMethods(composed)).toEqual({
      github: false,
      magicLink: false,
      localCredential: true,
    });
  });

  test("an environment with none of them is left as it was, and nothing is said", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const lines: string[] = [];

    expect(
      removeSignInProviderVariables(env, (line) => lines.push(line)),
    ).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(lines).toEqual([]);
  });
});

describe("the serving process's connection name", () => {
  test("names the program and the pid", () => {
    expect(servingApplicationName(4242)).toBe("requestport start 4242");
  });

  test("is set as each login URL's application_name, keeping its other parameters", () => {
    expect(
      withApplicationName(
        "postgres://u:p@127.0.0.1:5432/db?sslmode=require",
        "requestport start 7",
      ),
    ).toBe(
      "postgres://u:p@127.0.0.1:5432/db?sslmode=require&application_name=requestport+start+7",
    );
    expect(
      withApplicationName(
        "postgres://u:p@127.0.0.1:5432/db?application_name=other",
        "requestport start 7",
      ),
    ).toBe(
      "postgres://u:p@127.0.0.1:5432/db?application_name=requestport+start+7",
    );
  });

  test("on the four login URLs of a canonical environment, and nothing else", () => {
    const environment: Record<string, string> = {
      NODE_ENV: "production",
      BETTER_AUTH_URL: "http://127.0.0.1:3200",
    };
    for (const [kind, variable] of Object.entries(LOGIN_URL_VARIABLES)) {
      environment[variable] = `postgres://${kind}:pw@127.0.0.1:5432/db`;
    }

    const named = namedLoginUrls(environment, "requestport start 9");

    expect(Object.keys(named).sort()).toEqual(
      Object.values(LOGIN_URL_VARIABLES).sort(),
    );
    for (const [variable, url] of Object.entries(named)) {
      expect(new URL(url).searchParams.get("application_name"), variable).toBe(
        "requestport start 9",
      );
      expect(new URL(url).username, variable).toBe(
        new URL(environment[variable] as string).username,
      );
    }
  });
});

/*
 * On PGlite (manifest-h.md §2.6 items 1, 2 and 5; Done when 9): the serving
 * process connects to no server, so it carries no owner-capable name and no
 * instance login URL, and it says what PGlite does not give.
 */
describe("the serving process's environment on PGlite", () => {
  test("an owner-capable name is removed with PGlite's reason, never its value", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: `postgres://owner:${SENTINEL}@127.0.0.1/db`,
      PATH: "/usr/bin",
    };
    const lines: string[] = [];

    expect(
      removeOwnerCapableVariables(env, (line) => lines.push(line), "pglite"),
    ).toEqual(["DATABASE_URL"]);
    expect(lines).toEqual([
      "removed DATABASE_URL from the serving process's environment: on PGlite it connects to no server.",
    ]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("the four login URL variables are removed, one line each, never the value; nothing else is", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", XPGHOST: "kept" };
    for (const variable of Object.values(LOGIN_URL_VARIABLES)) {
      env[variable] = `postgres://login:${SENTINEL}@127.0.0.1/db`;
    }
    const lines: string[] = [];

    const removed = removeLoginUrlVariables(env, (line) => lines.push(line));

    expect(removed.sort()).toEqual(Object.values(LOGIN_URL_VARIABLES).sort());
    expect(lines.sort()).toEqual(
      removed.map(
        (name) =>
          `removed ${name} from the serving process's environment: on PGlite it connects to no server.`,
      ),
    );
    expect(lines.join("\n")).not.toContain(SENTINEL);
    expect(env).toEqual({ PATH: "/usr/bin", XPGHOST: "kept" });
    expect(removeLoginUrlVariables(env, (line) => lines.push(line))).toEqual(
      [],
    );
  });

  test("the honesty line names the bind address, one user and the missing row-level security", () => {
    expect(pgliteHonestyLine("127.0.0.1")).toBe(
      "PGlite serves one user on this machine: this instance binds 127.0.0.1 only, and row-level security does not apply to its database, which it opens as PGlite's superuser.",
    );
  });
});
