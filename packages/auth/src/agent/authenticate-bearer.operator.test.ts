import type {
  ResolvedAgentAuthorization,
  ResolvedOperatorAuthorization,
} from "@requestport/db";
import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  createAuthenticateAgentBearer,
  createAuthenticateApiBearer,
} from "./authenticate-bearer.js";

/*
  Plan 13, F.3 (F3-11). Three kinds of credential reach the bearer path, told
  apart by five separations; this file holds the two that live here. The prefix
  routes (`rpo_` to the operator branch, which exists only in
  `authenticateApiBearer`, the `/api/v1` route's), and `authenticateAgentBearer`
  — `/mcp` and the artifact upload — refuses an `rpo_` key outright, without
  the re-authorisation advice meant for a broken OAuth token. The plugin's
  configuration check and the binding row are the refusals that do not trust
  the prefix; `operator-bearer.integration.test.ts` runs those for real.
*/

const base = "https://requestport.com";
const audiences = { api: `${base}/api/v1`, mcp: `${base}/mcp` } as const;
const operatorKey = `rpo_${"o".repeat(64)}`;
const agentKey = `rp_${"a".repeat(64)}`;

function operator(): ResolvedOperatorAuthorization {
  return {
    credentialId: "018f0000-0000-7000-8000-0000000f3e01",
    lineageId: "018f0000-0000-7000-8000-0000000f3e02",
    organizationId: "018f0000-0000-7000-8000-0000000f3e03",
    memberUserId: "user_f3_member",
    projectId: null,
    scopes: ["operator:revoke"],
    expiresAt: new Date(Date.now() + 60_000),
    credentialFingerprint: "operator-fingerprint",
  };
}

function agent(): ResolvedAgentAuthorization {
  return {
    agentPrincipalId: "018f0000-0000-7000-8000-0000000f3e11",
    audience: "api",
    authorizationId: "018f0000-0000-7000-8000-0000000f3e12",
    credentialFingerprint: "agent-fingerprint",
    delegatedByUserId: null,
    laneIds: [],
    organizationId: "018f0000-0000-7000-8000-0000000f3e13",
    projectId: "018f0000-0000-7000-8000-0000000f3e14",
    scopes: ["request:read"],
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function harness(
  overrides: {
    available?: boolean;
    operatorKey?: { valid: boolean; key: { id: string } | null };
    resolved?: ResolvedOperatorAuthorization | null;
  } = {},
) {
  const agentDependencies = {
    resolveApiKey: vi.fn(async () => agent()),
    resolveOAuth: vi.fn(async () => null),
    touchCredential: vi.fn(async () => {}),
    touchOAuthGrant: vi.fn(async () => {}),
    verifyApiKey: vi.fn(async (_key: string) => ({
      valid: true,
      key: { id: "agent-key-id" },
    })),
    verifyJwt: vi.fn(async () => null),
  };
  const authenticateAgentBearer = createAuthenticateAgentBearer({
    audiences,
    ...agentDependencies,
  });
  const operatorDependencies = {
    operatorCredentialsAvailable: vi.fn(
      async () => overrides.available ?? true,
    ),
    verifyOperatorKey: vi.fn(
      async (_key: string) =>
        overrides.operatorKey ?? {
          valid: true,
          key: { id: "operator-key-id" },
        },
    ),
    resolveOperatorKey: vi.fn(async () =>
      "resolved" in overrides ? (overrides.resolved ?? null) : operator(),
    ),
    touchOperatorCredential: vi.fn(async () => {}),
  };
  return {
    agentDependencies,
    operatorDependencies,
    authenticateAgentBearer,
    authenticateApiBearer: createAuthenticateApiBearer({
      authenticateAgentBearer,
      ...operatorDependencies,
    }),
  };
}

function bearer(token: string, path = "/api/v1/whoami") {
  return new Request(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("authenticateApiBearer, the /api/v1 route's", () => {
  test("turns a live, bound operator key into the operator's context", async () => {
    const { authenticateApiBearer, operatorDependencies } = harness();
    const context = await authenticateApiBearer(bearer(operatorKey));

    expect(context).toMatchObject({
      actor: {
        type: "service",
        id: `operator:${operator().lineageId}`,
        originatingActor: { type: "user", id: "user_f3_member" },
      },
      credentialKind: "operator",
      organizationId: operator().organizationId,
      projectId: null,
      credentialId: operator().credentialId,
      authorizationId: operator().credentialId,
      credentialFingerprint: "operator-fingerprint",
    });
    expect([...context.scopes]).toEqual(["operator:revoke"]);
    expect(context.laneIds.size).toBe(0);
    expect(operatorDependencies.verifyOperatorKey).toHaveBeenCalledWith(
      operatorKey,
    );
    expect(operatorDependencies.resolveOperatorKey).toHaveBeenCalledWith({
      apiKeyId: "operator-key-id",
    });
    // Stamped bound to the organisation the lookup found (D15).
    expect(operatorDependencies.touchOperatorCredential).toHaveBeenCalledWith(
      operator().credentialId,
      operator().organizationId,
    );
  });

  test("answers 401 while operator credentials are off, without verifying or looking anything up", async () => {
    const { authenticateApiBearer, operatorDependencies } = harness({
      available: false,
    });
    await expect(authenticateApiBearer(bearer(operatorKey))).rejects.toEqual(
      new DomainError("unauthenticated", "Operator credential is invalid"),
    );
    expect(operatorDependencies.verifyOperatorKey).not.toHaveBeenCalled();
    expect(operatorDependencies.resolveOperatorKey).not.toHaveBeenCalled();
  });

  test("answers an unverified key and an unbound one exactly as an unknown key", async () => {
    for (const overrides of [
      { operatorKey: { valid: false, key: null } },
      { resolved: null },
    ]) {
      const { authenticateApiBearer, operatorDependencies } =
        harness(overrides);
      await expect(authenticateApiBearer(bearer(operatorKey))).rejects.toEqual(
        new DomainError("unauthenticated", "Operator credential is invalid"),
      );
      expect(
        operatorDependencies.touchOperatorCredential,
      ).not.toHaveBeenCalled();
    }
  });

  test("hands every other credential to the agent path, for the api audience", async () => {
    const { authenticateApiBearer, agentDependencies, operatorDependencies } =
      harness();
    const context = await authenticateApiBearer(bearer(agentKey));
    expect(context.actor).toEqual({
      type: "agent",
      id: agent().agentPrincipalId,
    });
    expect(agentDependencies.resolveApiKey).toHaveBeenCalledWith({
      apiKeyId: "agent-key-id",
      audience: "api",
    });
    expect(operatorDependencies.verifyOperatorKey).not.toHaveBeenCalled();
    expect(
      operatorDependencies.operatorCredentialsAvailable,
    ).not.toHaveBeenCalled();
  });

  test("refuses a missing or non-bearer credential as the agent path does", async () => {
    const { authenticateApiBearer } = harness();
    await expect(
      authenticateApiBearer(new Request(`${base}/api/v1/whoami`)),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      authenticateApiBearer(
        new Request(`${base}/api/v1/whoami`, {
          headers: { authorization: `Basic ${operatorKey}` },
        }),
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("authenticateAgentBearer, /mcp's and the artifact upload's", () => {
  test.each(["mcp", "api"] as const)(
    "refuses an operator key for the %s audience, with no re-authorisation advice",
    async (audience) => {
      const { authenticateAgentBearer, agentDependencies } = harness();
      const refusal = await authenticateAgentBearer(
        bearer(operatorKey, "/mcp"),
        audience,
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(DomainError);
      expect(refusal).toMatchObject({ code: "unauthenticated" });
      expect((refusal as DomainError).details).toEqual({});
      expect(agentDependencies.verifyApiKey).not.toHaveBeenCalled();
      expect(agentDependencies.verifyJwt).not.toHaveBeenCalled();
    },
  );

  test("still admits an agent key, the positive control", async () => {
    const { authenticateAgentBearer } = harness();
    await expect(
      authenticateAgentBearer(bearer(agentKey, "/mcp"), "api"),
    ).resolves.toMatchObject({ actor: { type: "agent" } });
  });
});
