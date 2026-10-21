import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import {
  buildAllowlistEligibilityQuery,
  buildInvitationEligibilityQuery,
} from "./signup-eligibility.js";

describe("signup eligibility database queries", () => {
  test.each([
    [
      "invitation",
      buildInvitationEligibilityQuery,
      "from requestport_private.invitation_eligibility($1)",
    ],
    [
      "allowlist",
      buildAllowlistEligibilityQuery,
      "from requestport_private.signup_allowlist_eligibility($1)",
    ],
  ])(
    "reads the %s through its definer function, with the address as its one parameter",
    (_name, buildQuery, expectedSql) => {
      const query = new PgDialect().sqlToQuery(
        buildQuery("person@example.com"),
      );

      expect(query.sql).toContain(expectedSql);
      expect(query.params).toEqual(["person@example.com"]);
    },
  );

  test.each([
    [
      "invitation_eligibility",
      "public.invitations i",
      "lower(i.normalized_email)",
    ],
    [
      "signup_allowlist_eligibility",
      "public.signup_allowlist a",
      "lower(a.normalized_email)",
    ],
  ])(
    "%s compares the functional normalized-email index's expression",
    (name, table, expression) => {
      const migration = readFileSync(
        new URL("../migrations/0019_row_security_expand.sql", import.meta.url),
        "utf8",
      );
      const start = migration.indexOf(
        `CREATE OR REPLACE FUNCTION requestport_private.${name}(`,
      );
      const body = migration.slice(start, migration.indexOf("$$;", start));

      expect(start).toBeGreaterThan(-1);
      expect(body).toContain(`FROM ${table}`);
      expect(body).toContain(`WHERE ${expression} = p_normalized_email`);
    },
  );
});
