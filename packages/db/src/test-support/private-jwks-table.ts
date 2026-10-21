import { sql } from "drizzle-orm";

import type { Tx } from "../transaction.js";

/**
 * Gives a test file's transaction a `jwks` table of its own: an empty
 * temporary copy of `public.jwks`, which every unqualified `jwks` in that
 * transaction's session resolves to until the transaction ends.
 *
 * Why empty: Better Auth signs with the newest `jwks` row and decrypts its
 * private key with the secret it is given. The track databases are shared by
 * every suite and by the browser lanes, which commit rows encrypted under
 * their own secrets, so a file reading `public.jwks` can pick a key it cannot
 * decrypt. Over an empty table the provider mints a key under the file's own
 * secret, into the temporary table, and a key another suite commits while the
 * file runs never lands in it.
 *
 * It lives in this package, and reaches `packages/auth`'s tests only through
 * `@requestport/db/testing`, because the tenant-scope sweep refuses a module
 * outside `packages/db` that imports a database driver (its boundary case).
 *
 * Why not `delete from jwks` inside the transaction, which is what
 * `packages/auth`'s `dynamic-client-registration.test.ts`,
 * `better-auth-legacy-rows.integration.test.ts` and
 * `agent/cross-audience-token.integration.test.ts` did until 2026-09-29: a
 * delete row-locks every committed row it removes until its transaction ends,
 * and these transactions end with the file. The next of those files to run
 * the same delete waited on that lock (`Lock`/`transactionid`) for the whole
 * of the first file, and the third queued behind it (`Lock`/`tuple`). On a
 * loaded gate host, where each of these files runs for tens of seconds, the
 * waiting file's `beforeAll` passed its 30-second timeout
 * (docs/implementation/plans/2026-09-27-13/track-x17.md).
 *
 * Creating the copy takes no row lock on `public.jwks`. `LIKE` holds an
 * ACCESS SHARE lock on it until the transaction ends, which conflicts only
 * with ACCESS EXCLUSIVE (DROP, TRUNCATE, most forms of ALTER TABLE). The copy
 * is dropped when the transaction ends, by `ON COMMIT DROP` or by the
 * rollback, and no other session can see it.
 *
 * The copy is found first because PostgreSQL searches the session's temporary
 * schema before `search_path` for tables unless `search_path` names
 * `pg_temp` itself, and because the Drizzle schema declares the table as
 * `jwks` with no schema (`packages/db/src/schema/identity.ts`). The check
 * after the create throws when the unqualified name resolves outside the
 * temporary schema, which is what a `search_path` naming `pg_temp` would do.
 * It cannot catch the other change: a schema-qualified declaration
 * (`"public"."jwks"`) would send Better Auth to the shared table while the
 * check still passes.
 */
export async function usePrivateJwksTable(transaction: Tx) {
  await transaction.execute(
    sql`create temporary table jwks (like public.jwks including all) on commit drop`,
  );
  // `pg_temp.jwks` names this session's temporary table; the unqualified name
  // is resolved as every query in the transaction resolves it. Null when the
  // temporary table is missing, which fails the check too.
  const result = await transaction.execute(sql`
    select to_regclass('pg_temp.jwks') = to_regclass('jwks') as "private"
  `);
  const [row] = result.rows as { private: boolean }[];
  if (row?.private !== true) {
    throw new Error(
      "jwks does not resolve to this transaction's temporary table",
    );
  }
}
