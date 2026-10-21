import assert from "node:assert/strict";
import test from "node:test";

import {
  ownerCapableVariableNames,
  removeOwnerCapableVariables,
} from "./owner-capable-variables.mjs";

/*
 * The rule the scripts that start the web application strip by (Plan 13,
 * I.2 step 7). That it names exactly what the role guard names is
 * `packages/db/src/owner-capable-copies.test.ts`'s case.
 */

/** A placeholder password for these cases' URLs. */
const PW = "placeholder";

test("names DATABASE_URL, every DATABASE_URL_*, PG* and POSTGRES_*, sorted, and none of RequestPort's own database variables", () => {
  const env = {
    POSTGRES_URL: `postgresql://owner:${PW}@owner.example/db`,
    DATABASE_URL: `postgresql://owner:${PW}@owner.example/db`,
    DATABASE_URL_UNPOOLED: "",
    PGHOST: "owner.example",
    PGPASSWORD: PW,
    REQUESTPORT_APPLICATION_DATABASE_URL: `postgresql://app:${PW}@app/db`,
    REQUESTPORT_E2E_OWNER_DATABASE_URL: `postgresql://owner:${PW}@127.0.0.1/db`,
    REQUESTPORT_LOCAL_DATABASE_URL: `postgresql://owner:${PW}@127.0.0.1/db`,
    REQUESTPORT_DISPATCHER_DATABASE_URL: `postgresql://d:${PW}@w/db`,
    DATABASE_URLS: "kept",
    XPGHOST: "kept",
    NODE_ENV: "development",
  };

  assert.deepEqual(ownerCapableVariableNames(env), [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "PGHOST",
    "PGPASSWORD",
    "POSTGRES_URL",
  ]);
});

test("removes each owner-capable name in place, saying its name and never its value, and keeps every other", () => {
  const secret = "S3NT1NEL-owner-value-never-said";
  const env = {
    DATABASE_URL: `postgresql://owner:${secret}@127.0.0.1/db`,
    PGHOST: "127.0.0.1",
    REQUESTPORT_APPLICATION_DATABASE_URL: `postgresql://app:${PW}@127.0.0.1/db`,
    NODE_ENV: "test",
  };
  const said = [];

  assert.deepEqual(
    removeOwnerCapableVariables(env, (name) => said.push(name)),
    ["DATABASE_URL", "PGHOST"],
  );
  assert.deepEqual(said, ["DATABASE_URL", "PGHOST"]);
  assert.deepEqual(env, {
    REQUESTPORT_APPLICATION_DATABASE_URL: `postgresql://app:${PW}@127.0.0.1/db`,
    NODE_ENV: "test",
  });
  assert.doesNotMatch(said.join("\n"), new RegExp(secret, "u"));
});
