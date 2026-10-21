import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { ownerCapableVariableNames } from "./role-guard.js";

/*
 * The scripts' copy of the owner-capable rule (Plan 13, I.2 step 7):
 * `scripts/owner-capable-variables.mjs`, which `with-root-env.mjs
 * --without-owner-variables` (`pnpm dev`) and the acceptance server's start
 * strip their application process's environment by. A script cannot load this
 * package's TypeScript, so the rule is written out there; this case holds the
 * two equal, name by name, at every edge of the rule. (`requestport start`'s
 * copy, `apps/requestport/src/serve/environment.ts`, is held equal in its own
 * package.)
 */

type ScriptsCopy = {
  ownerCapableVariableNames(env: NodeJS.ProcessEnv): string[];
};

const scriptsCopy = pathToFileURL(
  resolve(import.meta.dirname, "../../../scripts/owner-capable-variables.mjs"),
).href;

/** Names at every edge of the rule, each on its own and all at once. */
const CORPUS = [
  "DATABASE_URL",
  "DATABASE_URL_",
  "DATABASE_URL_UNPOOLED",
  "DATABASE_URL_POOLED",
  "DATABASE_URL_0",
  "DATABASE_URL_a",
  "DATABASE_URL_-",
  "DATABASE_URLS",
  "XDATABASE_URL",
  "database_url",
  "PG",
  "PG_",
  "PGHOST",
  "PGHOST_UNPOOLED",
  "PG0",
  "PGa",
  "PG-HOST",
  "XPGHOST",
  "pghost",
  "POSTGRES_",
  "POSTGRES_URL",
  "POSTGRES_a",
  "POSTGRES",
  "POSTGRESQL_URL",
  "REQUESTPORT_APPLICATION_DATABASE_URL",
  "REQUESTPORT_E2E_OWNER_DATABASE_URL",
  "REQUESTPORT_LOCAL_DATABASE_URL",
  "REQUESTPORT_PREVIEW_DATABASE_URL",
  "REQUESTPORT_DISPATCHER_DATABASE_URL",
  "NODE_ENV",
  // Each prefix followed by a letter at either end of the range, a digit at
  // either end, an underscore, a lowercase letter and a hyphen, as
  // `apps/requestport/src/serve/environment.test.ts` adds: a copy whose
  // character class dropped digits or case, or lost an end of a range,
  // would differ here.
  ...["PG", "POSTGRES_", "DATABASE_URL", "DATABASE_URL_"].flatMap((prefix) =>
    ["A", "Z", "0", "9", "_", "a", "z", "-"].map((tail) => prefix + tail),
  ),
];

describe("the scripts' copy of the owner-capable rule", () => {
  test("names exactly what ownerCapableVariableNames names, name by name and all at once", async () => {
    const copy = (await import(/* @vite-ignore */ scriptsCopy)) as ScriptsCopy;

    for (const name of CORPUS) {
      expect(copy.ownerCapableVariableNames({ [name]: "" }), name).toEqual(
        ownerCapableVariableNames({ [name]: "" }),
      );
    }
    const all = Object.fromEntries(CORPUS.map((name) => [name, "x"]));

    expect(copy.ownerCapableVariableNames(all)).toEqual(
      ownerCapableVariableNames(all),
    );
    // The corpus reaches both sides of the rule.
    expect(ownerCapableVariableNames(all).length).toBeGreaterThan(10);
    expect(ownerCapableVariableNames(all)).not.toContain(
      "REQUESTPORT_E2E_OWNER_DATABASE_URL",
    );
  });
});
