import type {
  AgentCredentialSummary,
  createAgentAuthRepository,
  createAgentRepository,
} from "@requestport/db";
import type { AuthorizedCommandContext } from "@requestport/domain";
import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import { createAgentApiKeyService } from "./api-key-service.js";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL = "55555555-5555-4555-8555-555555555555";

/**
 * A plaintext key is revealed once, so a test that asserts a refusal has to be
 * able to prove the refusal happened before any key existed.
 */
const PLAINTEXT_KEY = "rp_live_test_plaintext_key";

type AuthRepository = ReturnType<typeof createAgentAuthRepository>;
type AgentRepository = ReturnType<typeof createAgentRepository>;
type Authorization = {
  assertCurrent(context: AuthorizedCommandContext): Promise<void>;
};

/**
 * The service over stand-in repositories, each recording in `calls` what it
 * was asked. `authorization` is the bus's re-check: by default one that
 * admits and records each context it is asked about in `rechecked`;
 * `"absent"` composes the service without one.
 */
function harness(
  options: {
    authorization?: Authorization | "absent";
    canManage?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const rechecked: AuthorizedCommandContext[] = [];
  const createdKeyNames: string[] = [];
  const reservations: unknown[] = [];
  const admitting: Authorization = {
    async assertCurrent(context) {
      calls.push("assertCurrent");
      rechecked.push(context);
    },
  };
  const authorization =
    options.authorization === "absent"
      ? undefined
      : (options.authorization ?? admitting);
  const service = createAgentApiKeyService({
    ...(authorization ? { authorization } : {}),
    createApiKey: async ({ name }) => {
      calls.push("createApiKey");
      createdKeyNames.push(name);
      return {
        expiresAt: new Date("2026-12-06T00:00:00.000Z"),
        id: "api_key_1",
        key: PLAINTEXT_KEY,
        prefix: "rp_",
        start: "live",
      };
    },
    authRepository: {
      async reserveCredentialIssuance(input: unknown) {
        calls.push("reserveCredentialIssuance");
        reservations.push(input);
        return {
          key: { hash: "receipt" },
          reserved: true,
          result: { status: "pending" },
        };
      },
      async createCredential(input: {
        name: string;
        prefix: string;
        fingerprint: string;
        audience: string;
        projectId: string;
        laneIds: string[];
        scopes: string[];
        expiresAt: Date;
      }) {
        calls.push("createCredential");
        return { id: CREDENTIAL, ...input };
      },
      async cancelCredentialIssuance() {},
      async deleteOrphanApiKey() {},
      async setCredentialOverlap() {
        calls.push("setCredentialOverlap");
        return { id: CREDENTIAL, version: 2 };
      },
      async revokeCredentialForCompensation() {},
    } as unknown as AuthRepository,
    agentRepository: {
      async canManage() {
        calls.push("canManage");
        return options.canManage ?? true;
      },
      async findPrincipal() {
        calls.push("findPrincipal");
        return { id: PRINCIPAL, projectId: PROJECT, status: "active" };
      },
    } as unknown as AgentRepository,
    fingerprintSecret: "test-fingerprint-secret",
  });
  return { calls, createdKeyNames, rechecked, reservations, service };
}

function context(): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: "user_1" },
    correlationId: "correlation_1",
    credentialId: "session_1",
    organizationId: ORGANIZATION,
    scopes: new Set(["agent:manage"]),
  };
}

function issuance(overrides: Record<string, unknown> = {}) {
  return {
    agentPrincipalId: PRINCIPAL,
    audience: "mcp",
    laneIds: [],
    name: "Build agent",
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    scopes: ["work:claim"],
    ...overrides,
  };
}

const meta = { expectedVersion: 0, idempotencyKey: "idempotency-key-0001" };

function credential(
  overrides: Partial<AgentCredentialSummary> = {},
): AgentCredentialSummary {
  return {
    agentPrincipalId: PRINCIPAL,
    audience: "mcp",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    createdByUserId: "user_1",
    expiresAt: new Date("2026-12-06T00:00:00.000Z"),
    fingerprint: "fingerprint",
    id: CREDENTIAL,
    laneIds: [],
    lastUsedAt: null,
    name: "Build agent",
    overlapExpiresAt: null,
    prefix: "rp_live",
    projectId: PROJECT,
    revokedAt: null,
    scopes: ["work:claim"],
    version: 1,
    ...overrides,
    // After the spread and defaulted explicitly: `Partial` plus
    // exactOptionalPropertyTypes turns a nullable field into
    // `string | null | undefined`, which does not satisfy `string | null`.
    // Null is the ordinary case anyway — a credential a human issued.
    issuedByGrantId: overrides.issuedByGrantId ?? null,
  };
}

async function refusal(action: Promise<unknown>) {
  const thrown = await action.then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(DomainError);
  return thrown as DomainError;
}

describe("issuing an agent API key", () => {
  test("refuses the provisioning scope", async () => {
    const { createdKeyNames, service } = harness();

    const error = await refusal(
      service.issue(
        context(),
        issuance({ scopes: ["project:provision"] }),
        meta,
      ),
    );

    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("project:provision");
    // Nothing was minted, so there is no key to leak and none to clean up.
    expect(createdKeyNames).toEqual([]);
  });

  test("refuses the provisioning scope even beside working scopes", async () => {
    const { createdKeyNames, service } = harness();

    const error = await refusal(
      service.issue(
        context(),
        issuance({ scopes: ["request:read", "project:provision"] }),
        meta,
      ),
    );

    expect(error.code).toBe("validation_failed");
    expect(createdKeyNames).toEqual([]);
  });

  test("refuses to rotate a credential into the provisioning scope", async () => {
    const { createdKeyNames, service } = harness();

    const error = await refusal(
      service.rotate(context(), {
        credential: credential({ scopes: ["project:provision"] }),
        meta,
        organizationId: ORGANIZATION,
      }),
    );

    expect(error.code).toBe("validation_failed");
    expect(createdKeyNames).toEqual([]);
  });

  test("still issues a key for ordinary working scopes", async () => {
    const { createdKeyNames, service } = harness();

    const issued = await service.issue(
      context(),
      issuance({ scopes: ["work:claim", "request:read"] }),
      meta,
    );

    expect(issued.plaintextKey).toBe(PLAINTEXT_KEY);
    expect(issued.credential.scopes).toEqual(["request:read", "work:claim"]);
    expect(createdKeyNames).toEqual(["Build agent"]);
  });

  test("refuses a scope the server does not define", async () => {
    const { createdKeyNames, service } = harness();

    const error = await refusal(
      service.issue(context(), issuance({ scopes: ["project:invent"] }), meta),
    );

    expect(error.code).toBe("validation_failed");
    expect(createdKeyNames).toEqual([]);
  });

  // Plan 13, F.2.2: `agent:revoke` is an operator credential's alone. An
  // agent key's scopes must be agent scopes, and `agentScopes` does not name
  // it, so it is refused here as `project:provision` is, alone or beside a
  // working scope, at issuance and at rotation.
  test("refuses agent:revoke, the operator's reduce-only scope, at issuance and rotation", async () => {
    const { createdKeyNames, service } = harness();

    for (const scopes of [["agent:revoke"], ["request:read", "agent:revoke"]]) {
      const error = await refusal(
        service.issue(context(), issuance({ scopes }), meta),
      );
      expect(error.code, scopes.join()).toBe("validation_failed");
      expect(error.message, scopes.join()).toBe("Agent scope is not allowed");
    }
    const rotated = await refusal(
      service.rotate(context(), {
        credential: credential({ scopes: ["agent:revoke"] }),
        meta,
        organizationId: ORGANIZATION,
      }),
    );
    expect(rotated.code).toBe("validation_failed");
    expect(createdKeyNames).toEqual([]);
  });
});

describe("a person's issuance and rotation, re-checked first by the authorization the service is composed with (ruling 233 item 2)", () => {
  const humanRefusal = () =>
    new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );

  test("issue refuses a person's context that the re-check (authorization.assertCurrent) refuses, with that refusal, before anything is read or minted", async () => {
    const refused = humanRefusal();
    const { calls, createdKeyNames, service } = harness({
      authorization: {
        async assertCurrent() {
          throw refused;
        },
      },
    });

    await expect(service.issue(context(), issuance(), meta)).rejects.toBe(
      refused,
    );
    expect(calls).toEqual([]);
    expect(createdKeyNames).toEqual([]);
  });

  test("rotate refuses it through issue, before anything is read, minted or written", async () => {
    const refused = humanRefusal();
    const { calls, createdKeyNames, service } = harness({
      authorization: {
        async assertCurrent() {
          throw refused;
        },
      },
    });

    await expect(
      service.rotate(context(), {
        credential: credential(),
        meta,
        organizationId: ORGANIZATION,
      }),
    ).rejects.toBe(refused);
    expect(calls).toEqual([]);
    expect(createdKeyNames).toEqual([]);
  });

  test("issue re-checks a person's context first, then the role, then mints", async () => {
    const { calls, rechecked, service } = harness();
    const person = context();

    await service.issue(person, issuance({ scopes: ["request:read"] }), meta);

    expect(rechecked).toHaveLength(1);
    expect(rechecked[0]).toBe(person);
    expect(calls).toEqual([
      "assertCurrent",
      "canManage",
      "findPrincipal",
      "reserveCredentialIssuance",
      "createApiKey",
      "createCredential",
    ]);
  });

  test("a person the re-check admits who does not manage the project's agents is refused by the role check, in its words, and nothing is minted", async () => {
    const { calls, createdKeyNames, service } = harness({ canManage: false });

    const error = await refusal(service.issue(context(), issuance(), meta));

    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("Agent management access is denied");
    expect(calls).toEqual(["assertCurrent", "canManage"]);
    expect(createdKeyNames).toEqual([]);
  });

  test("composed without the re-check, issue and rotate refuse a person's context as a configuration error, before anything is read or minted", async () => {
    const { calls, createdKeyNames, service } = harness({
      authorization: "absent",
    });

    const issued = await refusal(service.issue(context(), issuance(), meta));
    const rotated = await refusal(
      service.rotate(context(), {
        credential: credential(),
        meta,
        organizationId: ORGANIZATION,
      }),
    );

    expect(issued.code).toBe("configuration_error");
    expect(rotated.code).toBe("configuration_error");
    expect(calls).toEqual([]);
    expect(createdKeyNames).toEqual([]);
  });

  test("an agent's context is not re-checked here: issue refuses it as before, for a person is required", async () => {
    const { calls, service } = harness({
      authorization: {
        async assertCurrent() {
          throw new Error("an agent's context was re-checked");
        },
      },
    });

    const error = await refusal(
      service.issue(
        { ...context(), actor: { type: "agent", id: PRINCIPAL } },
        issuance(),
        meta,
      ),
    );

    expect(error.message).toBe("A human maintainer is required");
    expect(calls).toEqual([]);
  });
});
