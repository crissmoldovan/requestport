import { createHash } from "node:crypto";

import type { Database } from "@requestport/db";
import { createAgentAuthRepository } from "@requestport/db";
import type { BetterAuthOptions } from "better-auth";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test, vi } from "vitest";

import { requestportAgentGrantFamiliesClaim } from "./agent/authenticate-bearer.js";
import { createAuthOptions } from "./server-options.js";

const env = {
  NODE_ENV: "production" as const,
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "https://requestport.com",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

function bindingFingerprint(clientId: string, refreshFamilyId: string) {
  return createHash("sha256")
    .update(clientId)
    .update("\0")
    .update(refreshFamilyId)
    .digest("base64url");
}

// Rows as `requestport_private.list_oauth_grant_binding_fingerprints` returns
// them: its two output columns, by name, in the order the function sorts
// them.
function grantRows(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    client_id: `client-${index}`,
    refresh_family_id: `family-${index}`,
  }));
}

/*
 * The repository makes one call, `database.execute` of the function, and
 * reads the rows it answers. This stands in for the database at that call,
 * records the statement as PostgreSQL would receive it, and answers `rows`.
 * The function's own query — which grants count, newest first with a tie
 * broken by id, at most a hundred and one — runs against PostgreSQL in
 * packages/db's row-security.integration.test.ts ("the grant family claim,
 * now in its definer function").
 */
function recordingRepository(rows: Record<string, string>[]) {
  const dialect = new PgDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const database = {
    async execute(query: SQL) {
      const { sql, params } = dialect.sqlToQuery(query);
      queries.push({ sql, params });
      return { rows };
    },
  };
  return {
    queries,
    repository: createAgentAuthRepository(database as unknown as Database),
  };
}

describe("agent grant family fingerprints", () => {
  test("asks the definer function, with the user and the audience alone", async () => {
    const { queries, repository } = recordingRepository(grantRows(3));

    await repository.listOAuthGrantBindingFingerprints({
      userId: "user-1",
      audience: "mcp",
    });

    expect(queries).toEqual([
      {
        sql: "select * from requestport_private.list_oauth_grant_binding_fingerprints($1, $2)",
        params: ["user-1", "mcp"],
      },
    ]);
  });

  test("keeps the first hundred the function answers and reports the grant it dropped", async () => {
    const { repository } = recordingRepository(grantRows(101));

    const claim = await repository.listOAuthGrantBindingFingerprints({
      userId: "user-1",
      audience: "mcp",
    });

    expect(claim.fingerprints).toHaveLength(100);
    expect(claim.truncated).toBe(true);
    expect(claim.fingerprints[0]).toBe(
      bindingFingerprint("client-0", "family-0"),
    );
    expect(claim.fingerprints.at(-1)).toBe(
      bindingFingerprint("client-99", "family-99"),
    );
    expect(claim.fingerprints).not.toContain(
      bindingFingerprint("client-100", "family-100"),
    );
  });

  test("reports no truncation when the cap is exactly met", async () => {
    const { repository } = recordingRepository(grantRows(100));

    const claim = await repository.listOAuthGrantBindingFingerprints({
      userId: "user-1",
      audience: "mcp",
    });

    expect(claim.fingerprints).toHaveLength(100);
    expect(claim.truncated).toBe(false);
  });

  test("fingerprints the client and refresh family of every grant", async () => {
    const { repository } = recordingRepository(grantRows(2));

    const claim = await repository.listOAuthGrantBindingFingerprints({
      userId: "user-1",
      audience: "api",
    });

    expect(claim.fingerprints).toEqual([
      bindingFingerprint("client-0", "family-0"),
      bindingFingerprint("client-1", "family-1"),
    ]);
  });
});

function claimsHook(authOptions: BetterAuthOptions) {
  const plugin = authOptions.plugins?.find(
    (candidate) => candidate.id === "oauth-provider",
  ) as
    | {
        options?: {
          customAccessTokenClaims?: (info: {
            user?: { id: string } | null;
            scopes: string[];
            resources?: string[];
          }) => Promise<Record<string, unknown>>;
        };
      }
    | undefined;
  const hook = plugin?.options?.customAccessTokenClaims;
  if (!hook) throw new Error("The OAuth provider stamps no custom claims");
  return hook;
}

function optionsWith(
  resolveAgentGrantBindingFingerprints: (input: {
    userId: string;
    audience: "mcp" | "api";
  }) => Promise<{ fingerprints: string[]; truncated: boolean }>,
) {
  return createAuthOptions({
    assertSignupAllowed: vi.fn(async () => ({
      allowed: true as const,
      reason: "allowlist" as const,
    })),
    database: {} as never,
    env,
    sendMagicLink: vi.fn(async () => undefined),
    resolveAgentGrantBindingFingerprints,
  });
}

describe("access token grant family claim", () => {
  test("stamps the fingerprints alone into the claim", async () => {
    const hook = claimsHook(
      optionsWith(async () => ({
        fingerprints: ["first-family", "second-family"],
        truncated: false,
      })),
    );

    const claims = await hook({
      user: { id: "user-1" },
      scopes: ["openid"],
      resources: ["https://requestport.com/mcp"],
    });

    expect(claims).toEqual({
      [requestportAgentGrantFamiliesClaim]: ["first-family", "second-family"],
    });
  });

  test("says out loud when a grant was dropped from the claim", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hook = claimsHook(
      optionsWith(async () => ({
        fingerprints: ["first-family"],
        truncated: true,
      })),
    );

    const claims = await hook({
      user: { id: "user-1" },
      scopes: ["openid"],
      resources: ["https://requestport.com/api/v1"],
    });

    expect(claims).toEqual({
      [requestportAgentGrantFamiliesClaim]: ["first-family"],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      userId: "user-1",
      audience: "api",
      claimed: 1,
    });
    warn.mockRestore();
  });

  test("stays quiet when every grant reached the claim", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hook = claimsHook(
      optionsWith(async () => ({
        fingerprints: ["first-family"],
        truncated: false,
      })),
    );

    await hook({
      user: { id: "user-1" },
      scopes: ["openid"],
      resources: ["https://requestport.com/mcp"],
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("stamps nothing for a resource that is not an agent audience", async () => {
    const resolve = vi.fn(async () => ({
      fingerprints: ["first-family"],
      truncated: false,
    }));
    const hook = claimsHook(optionsWith(resolve));

    const claims = await hook({
      user: { id: "user-1" },
      scopes: ["openid"],
      resources: ["https://requestport.com/something-else"],
    });

    expect(claims).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
  });
});
