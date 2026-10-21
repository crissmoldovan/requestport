import { testPool } from "@requestport/db/testing";

import { e2eScenarioRowKeys } from "../../src/lib/e2e-scenario-seed.js";
import type { ScenarioRow } from "./acceptance-run.js";
import { fixtureStorage } from "./auth.js";

/**
 * How many of the rows a run reported still exist, asked of the database the
 * server wrote them to.
 *
 * The deleter's own key map is reused rather than a second idea of what
 * addresses a row: two of these tables are keyed by the entity they belong to
 * rather than by a surrogate, and a counter that assumed `id` would report a
 * clean database for a row that is still there.
 */
export async function countScenarioRows(
  rows: readonly ScenarioRow[],
): Promise<{ found: number; table: string }[]> {
  const counted: { found: number; table: string }[] = [];

  for (const row of rows) {
    const key = e2eScenarioRowKeys[row.table];
    const found = await testPool(fixtureStorage()).query<{ present: string }>(
      `SELECT count(*) AS "present" FROM "public"."${row.table}" WHERE "${key}"::text = $1`,
      [row.id],
    );
    counted.push({
      found: Number(found.rows[0]?.present ?? 0),
      table: row.table,
    });
  }

  return counted;
}
