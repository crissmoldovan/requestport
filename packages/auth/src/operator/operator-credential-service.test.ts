import { createHmac } from "node:crypto";

import type {
  OperatorCredentialSummary,
  OperatorIssuanceReceipt,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  DomainError,
  type OperatorCredentialAvailability,
} from "@requestport/domain";
import { describe, expect, test } from "vitest";

import { createOperatorCredentialService } from "./operator-credential-service.js";

/*
  Plan 13, F.3: issuing and rotating an operator credential (F3-7, F3-8),
  human-only by design (ruling 3), and default-deny until F3-14's answer is on
  (rulings 46 and 53). The repository and Better Auth are fakes that record
  what was asked of them, so each refusal can show it happened before a
  receipt was reserved or a plugin key created. The same refusals against the
  real repository and Better Auth are in `operator-bearer.integration.test.ts`.
*/

const organizationId = "0190c8a4-0000-7000-8000-000000000001";
const otherOrganizationId = "0190c8a4-0000-7000-8000-000000000002";
const projectId = "0190c8a4-0000-7000-8000-000000000003";
const credentialId = "0190c8a4-0000-7000-8000-000000000004";
const fingerprintSecret = "operator-service-test-fingerprint-000001";

function personContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: "user_issuer" },
    organizationId,
    scopes: new Set(["operator:manage"]),
    credentialId: "session_live",
    correlationId: "corr_operator_service",
    ...overrides,
  };
}

const meta = { idempotencyKey: "operator-issue-key-0001", expectedVersion: 0 };

function existingCredential(
  overrides: Partial<OperatorCredentialSummary> = {},
): OperatorCredentialSummary {
  return {
    id: credentialId,
    organizationId,
    memberUserId: "user_issuer",
    projectId,
    betterAuthApiKeyId: "apikey_old",
    lineageId: credentialId,
    rotatedFromId: null,
    name: "CI deploy",
    prefix: "rpo_old",
    fingerprint: "fingerprint_old",
    scopes: ["operator:revoke"],
    version: 1,
    expiresAt: new Date(Date.now() + 10 * 86_400_000),
    revokedAt: null,
    overlapExpiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(Date.now() - 86_400_000),
    ...overrides,
  };
}

function harness(
  options: {
    availability?: OperatorCredentialAvailability;
    receipt?: Partial<OperatorIssuanceReceipt>;
    failBinding?: boolean;
    failOverlap?: boolean;
    credentials?: OperatorCredentialSummary[];
  } = {},
) {
  const calls: string[] = [];
  const recorded: Record<string, unknown> = {};
  const receipt: OperatorIssuanceReceipt = {
    key: {
      actorFingerprint: "user:user_issuer",
      commandName: "issue_operator_credential",
      idempotencyFingerprint: "fingerprint",
      normalizedInputHash: "hash",
      expiresAt: new Date(),
    },
    organizationId,
    result: { status: "pending" },
    reserved: true,
    ...options.receipt,
  };
  const service = createOperatorCredentialService({
    availability: async () => options.availability ?? { available: true },
    fingerprintSecret,
    createApiKey: async (input) => {
      calls.push("createApiKey");
      recorded.createApiKey = input;
      return {
        id: "apikey_new",
        key: "rpo_plaintext_secret",
        prefix: "rpo_",
        start: "plai",
        expiresAt: new Date(Date.now() + input.expiresIn * 1_000),
      };
    },
    repository: {
      async reserveIssuance(input) {
        calls.push("reserveIssuance");
        recorded.reserveIssuance = input;
        return receipt;
      },
      async cancelIssuance() {
        calls.push("cancelIssuance");
      },
      async createCredential(input) {
        calls.push("createCredential");
        recorded.createCredential = input;
        if (options.failBinding) throw new Error("binding failed");
        return {
          id: "0190c8a4-0000-7000-8000-00000000000a",
          organizationId: input.organizationId,
          memberUserId: input.memberUserId,
          projectId: input.projectId,
          betterAuthApiKeyId: input.betterAuthApiKeyId,
          lineageId: input.lineageId ?? "0190c8a4-0000-7000-8000-00000000000a",
          rotatedFromId: input.rotatedFromId ?? null,
          name: input.name,
          prefix: input.prefix,
          fingerprint: input.fingerprint,
          scopes: input.scopes,
          version: 1,
          expiresAt:
            input.expiresAt ??
            new Date(Date.now() + (input.expiresInDays ?? 0) * 86_400_000),
          revokedAt: null,
          createdAt: new Date(),
        };
      },
      async deleteOrphanApiKey(apiKeyId) {
        calls.push(`deleteOrphanApiKey:${apiKeyId}`);
      },
      async listCredentials(listed) {
        calls.push("listCredentials");
        return listed === organizationId
          ? (options.credentials ?? [existingCredential()])
          : [];
      },
      async setCredentialOverlap(input) {
        calls.push("setCredentialOverlap");
        recorded.setCredentialOverlap = input;
        if (options.failOverlap) {
          throw new DomainError("version_conflict", "changed");
        }
        return { id: input.credentialId, version: input.expectedVersion + 1 };
      },
      async revokeCredentialForCompensation(input) {
        calls.push(`revokeCredentialForCompensation:${input.credentialId}`);
        return null;
      },
    },
  });
  return { service, calls, recorded };
}

const issueInput = {
  organizationId,
  projectId: null,
  name: "CI deploy",
  scopes: ["operator:revoke"],
  expiresInDays: 30,
};

describe("issuing an operator credential (F3-7)", () => {
  test("reserves, mints under the operator configuration, binds, and reveals the key once", async () => {
    const { service, calls, recorded } = harness();

    const issued = await service.issue(personContext(), issueInput, meta);

    expect(calls).toEqual([
      "reserveIssuance",
      "createApiKey",
      "createCredential",
    ]);
    expect(recorded.reserveIssuance).toMatchObject({
      actorUserId: "user_issuer",
      sessionId: "session_live",
      organizationId,
      projectId: null,
      commandName: "issue_operator_credential",
      idempotencyKey: meta.idempotencyKey,
    });
    expect(recorded.createApiKey).toEqual({
      name: "CI deploy",
      userId: "user_issuer",
      expiresIn: 30 * 86_400,
    });
    expect(recorded.createCredential).toMatchObject({
      organizationId,
      memberUserId: "user_issuer",
      projectId: null,
      betterAuthApiKeyId: "apikey_new",
      prefix: "rpo_plai",
      fingerprint: createHmac("sha256", fingerprintSecret)
        .update("rpo_plaintext_secret")
        .digest("hex"),
      scopes: ["operator:revoke"],
      expiresInDays: 30,
    });
    expect(issued).toMatchObject({
      plaintextKey: "rpo_plaintext_secret",
      credential: { name: "CI deploy", scopes: ["operator:revoke"] },
    });
  });

  test("defaults the lifetime to 30 days and refuses more than 90", async () => {
    const { service, recorded } = harness();
    await service.issue(
      personContext(),
      { organizationId, projectId: null, name: "Default", scopes: [] },
      meta,
    );
    expect(recorded.createApiKey).toMatchObject({ expiresIn: 30 * 86_400 });

    const refused = harness();
    await expect(
      refused.service.issue(
        personContext(),
        { ...issueInput, expiresInDays: 91 },
        meta,
      ),
    ).rejects.toThrow();
    expect(refused.calls).toEqual([]);
  });

  test.each([
    ["not-migrated"],
    ["switched-off"],
    ["change-password-mounted"],
  ] as const)(
    "refuses while unavailable (%s), before reserving a receipt or creating a key",
    async (reason) => {
      const { service, calls } = harness({
        availability: { available: false, reason },
      });
      await expect(
        service.issue(personContext(), issueInput, meta),
      ).rejects.toMatchObject({
        code: "configuration_error",
        details: { reason },
      });
      expect(calls).toEqual([]);
    },
  );

  test.each([
    [
      "an agent",
      {
        actor: { type: "agent" as const, id: "agent_1" },
        scopes: new Set(["operator:manage"]),
      },
    ],
    [
      "an operator",
      {
        actor: {
          type: "service" as const,
          id: `operator:${credentialId}`,
          originatingActor: { type: "user" as const, id: "user_issuer" },
        },
        credentialKind: "operator",
      },
    ],
    ["a person without operator:manage", { scopes: new Set(["org:read"]) }],
    [
      "a person of another organisation",
      { organizationId: otherOrganizationId },
    ],
  ])("refuses %s before anything is written", async (_label, overrides) => {
    const { service, calls } = harness();
    await expect(
      service.issue(
        personContext(overrides as Partial<AuthorizedCommandContext>),
        issueInput,
        meta,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
  });

  test.each([
    ["an excluded scope", ["agent:manage"]],
    ["a scope not on the allow-list", ["request:read"]],
    ["operator:manage", ["operator:manage"]],
    ["work:sweep", ["work:sweep"]],
  ])("refuses %s before anything is written", async (_label, scopes) => {
    const { service, calls } = harness();
    await expect(
      service.issue(personContext(), { ...issueInput, scopes }, meta),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(calls).toEqual([]);
  });

  test("refuses a new issuance whose expected version is not zero", async () => {
    const { service, calls } = harness();
    await expect(
      service.issue(personContext(), issueInput, {
        ...meta,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(calls).toEqual([]);
  });

  test("never mints a second key for a completed or running issuance", async () => {
    for (const result of [
      { status: "complete", credential: { id: credentialId } },
      { status: "pending" },
    ]) {
      const { service, calls } = harness({
        receipt: { reserved: false, result },
      });
      await expect(
        service.issue(personContext(), issueInput, meta),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(calls).toEqual(["reserveIssuance"]);
    }
  });

  test("deletes the key it minted and cancels the receipt when binding fails", async () => {
    const { service, calls } = harness({ failBinding: true });
    await expect(
      service.issue(personContext(), issueInput, meta),
    ).rejects.toThrow("binding failed");
    expect(calls).toEqual([
      "reserveIssuance",
      "createApiKey",
      "createCredential",
      "deleteOrphanApiKey:apikey_new",
      "cancelIssuance",
    ]);
  });
});

describe("rotating an operator credential (F3-8)", () => {
  const rotation = (overrides: Record<string, unknown> = {}) => ({
    organizationId,
    credentialId,
    overlapMinutes: 15,
    meta: { idempotencyKey: "operator-rotate-key-0001", expectedVersion: 1 },
    ...overrides,
  });

  test("keeps the member, project, scopes, lineage and expiry, then bounds the old one's overlap", async () => {
    const old = existingCredential({
      lineageId: "0190c8a4-0000-7000-8000-0000000000ff",
    });
    const { service, calls, recorded } = harness({ credentials: [old] });

    const rotated = await service.rotate(personContext(), rotation());

    expect(calls).toEqual([
      "listCredentials",
      "reserveIssuance",
      "createApiKey",
      "createCredential",
      "setCredentialOverlap",
    ]);
    expect(recorded.reserveIssuance).toMatchObject({
      commandName: "rotate_operator_credential",
      projectId,
    });
    expect(recorded.createCredential).toMatchObject({
      memberUserId: "user_issuer",
      projectId,
      scopes: ["operator:revoke"],
      expiresAt: old.expiresAt,
      lineageId: old.lineageId,
      rotatedFromId: old.id,
      name: "CI deploy (rotated)",
    });
    const overlap = recorded.setCredentialOverlap as {
      overlapExpiresAt: Date;
      expectedVersion: number;
    };
    expect(overlap.expectedVersion).toBe(1);
    expect(overlap.overlapExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      15 * 60_000,
    );
    expect(rotated.plaintextKey).toBe("rpo_plaintext_secret");
  });

  test("hands the plugin at least a day, which it requires, and binds the old expiry however little is left", async () => {
    for (const left of [60 * 60_000, 5 * 60_000, 3 * 86_400_000]) {
      const old = existingCredential({
        expiresAt: new Date(Date.now() + left),
      });
      const { service, recorded } = harness({ credentials: [old] });
      await service.rotate(personContext(), rotation());
      const { expiresIn } = recorded.createApiKey as { expiresIn: number };
      expect(expiresIn, String(left)).toBeGreaterThanOrEqual(86_400);
      if (left > 86_400_000)
        expect(expiresIn, String(left)).toBe(Math.ceil(left / 1_000));
      expect(recorded.createCredential, String(left)).toMatchObject({
        expiresAt: old.expiresAt,
      });
    }
  });

  test("caps the overlap at 60 minutes", async () => {
    const { service, recorded } = harness();
    await service.rotate(personContext(), rotation({ overlapMinutes: 600 }));
    const overlap = recorded.setCredentialOverlap as { overlapExpiresAt: Date };
    expect(overlap.overlapExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      60 * 60_000,
    );
  });

  test("revokes the replacement when the old credential's overlap cannot be set", async () => {
    const { service, calls } = harness({ failOverlap: true });
    await expect(
      service.rotate(personContext(), rotation()),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(calls.at(-1)).toBe(
      "revokeCredentialForCompensation:0190c8a4-0000-7000-8000-00000000000a",
    );
  });

  test("rotates only a live credential its caller issued", async () => {
    for (const [credential, code] of [
      [existingCredential({ memberUserId: "user_someone_else" }), "forbidden"],
      [existingCredential({ revokedAt: new Date() }), "version_conflict"],
      [existingCredential({ version: 2 }), "version_conflict"],
      [
        existingCredential({ expiresAt: new Date(Date.now() - 1_000) }),
        "invalid_state",
      ],
    ] as const) {
      const { service, calls } = harness({ credentials: [credential] });
      await expect(
        service.rotate(personContext(), rotation()),
      ).rejects.toMatchObject({ code });
      expect(calls).toEqual(["listCredentials"]);
    }
    const missing = harness({ credentials: [] });
    await expect(
      missing.service.rotate(personContext(), rotation()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("refuses while unavailable, before reading anything", async () => {
    const { service, calls } = harness({
      availability: { available: false, reason: "switched-off" },
    });
    await expect(
      service.rotate(personContext(), rotation()),
    ).rejects.toMatchObject({ code: "configuration_error" });
    expect(calls).toEqual([]);
  });
});

describe("listing operator credentials", () => {
  test("lists the organisation's credentials for a person holding operator:manage", async () => {
    const { service } = harness();
    await expect(
      service.list(personContext(), organizationId),
    ).resolves.toMatchObject([{ id: credentialId, name: "CI deploy" }]);
  });

  test("refuses while unavailable, and refuses anyone else", async () => {
    const off = harness({
      availability: { available: false, reason: "not-migrated" },
    });
    await expect(
      off.service.list(personContext(), organizationId),
    ).rejects.toMatchObject({ code: "configuration_error" });
    expect(off.calls).toEqual([]);

    const { service } = harness();
    await expect(
      service.list(personContext({ scopes: new Set() }), organizationId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
