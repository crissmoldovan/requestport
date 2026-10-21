import { describe, expect, test } from "vitest";

import {
  assertWorkTransition,
  boundedLeasePolicy,
  containsSensitiveJson,
  createEnvelopeEncryption,
  decodeBase64Key,
  deserializeEncryptedEnvelope,
  evaluateRoute,
  LocalAesKeyEncryptionKeyProvider,
  leaseTimes,
  nextRequestState,
  redactSensitiveText,
  serializeEncryptedEnvelope,
} from "./index.js";
import type {
  RouteEvaluationInput,
  RoutingRule,
} from "./routing/routing-types.js";

const organizationId = "018f0000-0000-7000-8000-000000000001";
const sourceProjectId = "018f0000-0000-7000-8000-000000000002";
const targetProjectId = "018f0000-0000-7000-8000-000000000003";

function routeInput(
  overrides: Partial<RouteEvaluationInput> = {},
): RouteEvaluationInput {
  return {
    sourceOrganizationId: organizationId,
    targetOrganizationId: organizationId,
    source: { kind: "project", projectId: sourceProjectId },
    targetProjectId,
    requestType: "feature",
    priority: "normal",
    principal: {
      type: "agent",
      id: "018f0000-0000-7000-8000-000000000004",
      scopes: new Set(["request:create"]),
    },
    ...overrides,
  };
}

function rule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: "018f0000-0000-7000-8000-000000000010",
    organizationId,
    sourceKind: "project",
    sourceProjectId,
    targetProjectId,
    decision: "allow",
    requestTypes: [],
    laneIds: [],
    priorities: [],
    humanRoles: [],
    agentPrincipalIds: [],
    specificity: 1,
    enabled: true,
    version: 1,
    ...overrides,
  };
}

describe("request and work state machines", () => {
  test("preserves the exact pre-block state and clears it on resume", () => {
    expect(
      nextRequestState({ action: "block_request", state: "planned" }),
    ).toEqual({
      state: "blocked",
      resumeState: "planned",
    });
    expect(
      nextRequestState({
        action: "resume_request",
        state: "blocked",
        resumeState: "planned",
      }),
    ).toEqual({
      state: "planned",
      resumeState: null,
    });
    expect(() =>
      nextRequestState({ action: "resume_request", state: "blocked" }),
    ).toThrow();
  });

  test("keeps request completion independent from terminal work state", () => {
    expect(
      nextRequestState({ action: "complete_request", state: "in_progress" }),
    ).toEqual({
      state: "completed",
      resumeState: null,
    });
    expect(() => assertWorkTransition("active", "ended")).not.toThrow();
    expect(() => assertWorkTransition("stale", "active")).toThrow();
    expect(() => assertWorkTransition("blocked", "stale")).not.toThrow();
  });

  test("bounds lease policy and derives grace from lease expiry", () => {
    const policy = boundedLeasePolicy({
      heartbeatIntervalSeconds: 1,
      leaseMultiplier: 100,
      graceSeconds: 1,
    });
    expect(policy).toEqual({
      heartbeatIntervalSeconds: 10,
      leaseMultiplier: 10,
      graceSeconds: 60,
    });
    const now = new Date("2026-08-18T00:00:00.000Z");
    expect(leaseTimes(now, policy)).toEqual({
      leaseExpiresAt: new Date("2026-08-18T00:01:40.000Z"),
      graceExpiresAt: new Date("2026-08-18T00:02:40.000Z"),
    });
  });
});

describe("routing policy", () => {
  test("denies cross-organization routing and unscoped human-direct creation", () => {
    expect(
      evaluateRoute(
        routeInput({
          targetOrganizationId: "018f0000-0000-7000-8000-000000000099",
        }),
        [],
      ),
    ).toMatchObject({
      allowed: false,
      reason: "cross_org_denied",
    });
    expect(
      evaluateRoute(
        routeInput({
          source: { kind: "human_direct" },
          principal: {
            type: "user",
            id: "user-1",
            organizationRole: "member",
            scopes: new Set(),
          },
        }),
        [],
      ),
    ).toMatchObject({ allowed: false, reason: "no_matching_permission" });
    expect(
      evaluateRoute(
        routeInput({
          source: { kind: "human_direct" },
          principal: {
            type: "user",
            id: "user-1",
            organizationRole: "member",
            scopes: new Set(["request:create"]),
          },
        }),
        [],
      ),
    ).toMatchObject({ allowed: true, reason: "default_same_org" });
  });

  test("uses the most-specific rule and lets deny win an exact tie", () => {
    const rules = [
      rule({ id: "allow", decision: "allow", specificity: 10, version: 4 }),
      rule({ id: "deny", decision: "deny", specificity: 10, version: 5 }),
      rule({
        id: "irrelevant",
        decision: "allow",
        specificity: 20,
        requestTypes: ["bug"],
        version: 9,
      }),
    ];
    expect(evaluateRoute(routeInput(), rules)).toMatchObject({
      allowed: false,
      reason: "matched_deny",
      matchedRuleId: "deny",
      policyVersion: 5,
    });
  });
});

describe("private telemetry encryption", () => {
  test("authenticates ciphertext with record-specific AAD and rewraps without plaintext change", async () => {
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    const provider = new LocalAesKeyEncryptionKeyProvider(
      "old-v1",
      new Map([
        ["old-v1", oldKey],
        ["new-v2", newKey],
      ]),
    );
    const encryption = createEnvelopeEncryption(provider);
    const aad = new TextEncoder().encode("org:workspace:schema-1");
    const envelope = await encryption.encrypt(
      { hostname: "private-host", pwd: "/Users/example/work" },
      aad,
    );
    expect(await encryption.decrypt(envelope, aad)).toEqual({
      hostname: "private-host",
      pwd: "/Users/example/work",
    });
    await expect(
      encryption.decrypt(envelope, new TextEncoder().encode("other-record")),
    ).rejects.toThrow();
    const rewrapped = await encryption.rewrap(envelope, "new-v2");
    expect(rewrapped.kekVersion).toBe("new-v2");
    expect(rewrapped.ciphertext).toEqual(envelope.ciphertext);
    expect(await encryption.decrypt(rewrapped, aad)).toEqual({
      hostname: "private-host",
      pwd: "/Users/example/work",
    });
    expect(
      deserializeEncryptedEnvelope(serializeEncryptedEnvelope(rewrapped)),
    ).toEqual(rewrapped);
  });

  test("rejects malformed keys and redacts telemetry from distributable projections", () => {
    expect(() =>
      decodeBase64Key(Buffer.alloc(31).toString("base64url")),
    ).toThrow();
    expect(
      containsSensitiveJson({
        nested: { workingDirectory: "/home/agent/repo" },
      }),
    ).toBe(true);
    expect(redactSensitiveText("hostname=private.internal")).toBe(
      "[Sensitive content omitted — open RequestPort]",
    );
  });
});
