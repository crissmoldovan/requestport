import { createHmac } from "node:crypto";

import type {
  OperatorCredentialRepository,
  OperatorCredentialSummary,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  containsSensitiveContent,
  DomainError,
  type OperatorCredentialAvailability,
  operatorCredentialDefaultLifetimeDays,
  operatorCredentialMaxLifetimeDays,
  operatorExcludedScopes,
  operatorKeyPrefix,
  operatorManageScope,
  operatorScopes,
  requireOrganization,
  requireScope,
  validateCommandMeta,
} from "@requestport/domain";
import { z } from "zod";

import { operatorApiKeyConfiguration } from "../server-options.js";

/*
  Issuing and rotating an operator credential (Plan 13, F.3, F3-7 and F3-8).
  Human-only by design (ruling 3): a machine credential that could mint
  credentials would be an escalation path, so only a signed-in person, in a
  session, holding `operator:manage`, reaches either. Revocation is not here:
  it runs on the bus as `revoke_operator_credential`, for a person and an
  operator alike.

  Default-deny (F3-14; rulings 46 and 53): every entry point asks the
  availability it is handed first, and refuses before it reserves a receipt,
  creates a plugin key or reads a row while the answer is off.
*/

const issueInput = z.strictObject({
  organizationId: z.uuid(),
  projectId: z.uuid().nullable(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(
      (value) => !containsSensitiveContent(value),
      "Credential name contains private or secret material",
    ),
  scopes: z.array(z.string()).max(30),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(operatorCredentialMaxLifetimeDays)
    .default(operatorCredentialDefaultLifetimeDays),
});

export type IssueOperatorCredentialInput = z.input<typeof issueInput>;

const maxOverlapMinutes = 60;
/** The operator configuration's `minExpiresIn`, which the plugin reads in days. */
const minimumPluginLifetimeSeconds =
  operatorApiKeyConfiguration.keyExpiration.minExpiresIn * 86_400;
const defaultOverlapMinutes = 15;

type ServiceRepository = Pick<
  OperatorCredentialRepository,
  | "reserveIssuance"
  | "cancelIssuance"
  | "createCredential"
  | "deleteOrphanApiKey"
  | "listCredentials"
  | "setCredentialOverlap"
  | "revokeCredentialForCompensation"
>;

export type CreatedOperatorApiKey = {
  id: string;
  key: string;
  prefix: string | null;
  start: string | null;
  expiresAt: Date | null;
};

export function createOperatorCredentialService(dependencies: {
  /** F3-14's whole answer: the switch, the `/change-password` guard and the table. */
  availability: () => Promise<OperatorCredentialAvailability>;
  /** Creates a Better Auth key under the operator configuration, server-side. */
  createApiKey: (input: {
    name: string;
    userId: string;
    expiresIn: number;
  }) => Promise<CreatedOperatorApiKey>;
  repository: ServiceRepository;
  fingerprintSecret: string;
}) {
  async function assertAvailable() {
    const availability = await dependencies.availability();
    if (!availability.available) {
      throw new DomainError(
        "configuration_error",
        "Operator credentials are unavailable in this deployment",
        { reason: availability.reason },
      );
    }
  }

  /**
   * A person, in this organisation, holding `operator:manage`. The session
   * itself is re-read under lock by the repository's reservation, which is
   * what refuses a context whose credential is not a live session.
   */
  function assertPerson(
    context: AuthorizedCommandContext,
    organizationId: string,
  ) {
    requireOrganization(context, organizationId);
    if (context.actor.type !== "user" || context.credentialKind !== undefined) {
      throw new DomainError(
        "forbidden",
        "Operator credentials are issued by a person",
      );
    }
    requireScope(context, operatorManageScope);
    return context.actor.id;
  }

  function assertAdmissibleScopes(scopes: readonly string[]) {
    const excluded = new Set<string>(operatorExcludedScopes);
    if (
      new Set(scopes).size !== scopes.length ||
      scopes.some(
        (scope) => excluded.has(scope) || !operatorScopes.includes(scope),
      )
    ) {
      throw new DomainError(
        "validation_failed",
        "Operator credential scopes are not admissible",
        { field: "scopes" },
      );
    }
  }

  function fingerprint(key: string) {
    return createHmac("sha256", dependencies.fingerprintSecret)
      .update(key)
      .digest("hex");
  }

  /**
   * Reserves, mints, binds. A completed or running reservation is a conflict,
   * never a second key: the plaintext is revealed once. If binding fails, the
   * key is deleted and the reservation cancelled, so a retry starts clean.
   */
  async function mint(input: {
    userId: string;
    sessionId: string;
    organizationId: string;
    projectId: string | null;
    name: string;
    scopes: string[];
    lifetime:
      | { expiresInDays: number }
      | { expiresAt: Date; lineageId: string; rotatedFromId: string };
    commandName: "issue_operator_credential" | "rotate_operator_credential";
    idempotencyKey: string;
    normalizedInput: unknown;
    correlationId: string;
  }) {
    const receipt = await dependencies.repository.reserveIssuance({
      actorUserId: input.userId,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      commandName: input.commandName,
      idempotencyKey: input.idempotencyKey,
      fingerprintSecret: dependencies.fingerprintSecret,
      normalizedInput: input.normalizedInput,
    });
    if (!receipt.reserved) {
      const status = (receipt.result as { status?: unknown } | null)?.status;
      throw new DomainError(
        "conflict",
        status === "complete"
          ? "Operator credential issuance already completed; plaintext keys are revealed only once"
          : "Operator credential issuance is already in progress",
      );
    }
    let created: CreatedOperatorApiKey | null = null;
    try {
      // A replacement is bound to the old credential's expiry, and the
      // binding's `expires_at` is the authority: the plugin's expiry only
      // narrows (F3-6, F3-10). The plugin refuses a key asked to live less
      // than its `minExpiresIn`, which it reads in days, so a replacement
      // for a credential with under a day left — every one in its overlap —
      // is handed a day, and still stops at the binding's expiry.
      const expiresIn =
        "expiresInDays" in input.lifetime
          ? input.lifetime.expiresInDays * 86_400
          : Math.max(
              minimumPluginLifetimeSeconds,
              Math.ceil(
                (input.lifetime.expiresAt.getTime() - Date.now()) / 1_000,
              ),
            );
      created = await dependencies.createApiKey({
        name: input.name,
        userId: input.userId,
        expiresIn,
      });
      const binding = await dependencies.repository.createCredential({
        organizationId: input.organizationId,
        memberUserId: input.userId,
        projectId: input.projectId,
        betterAuthApiKeyId: created.id,
        name: input.name,
        prefix: `${created.prefix ?? operatorKeyPrefix}${created.start ?? ""}`,
        fingerprint: fingerprint(created.key),
        scopes: input.scopes,
        ...input.lifetime,
        correlationId: input.correlationId,
        issuanceReceipt: receipt,
      });
      return { plaintextKey: created.key, credential: binding };
    } catch (error) {
      if (created) {
        await dependencies.repository.deleteOrphanApiKey(created.id);
      }
      await dependencies.repository.cancelIssuance(receipt);
      throw error;
    }
  }

  async function issue(
    context: AuthorizedCommandContext,
    rawInput: IssueOperatorCredentialInput,
    meta: { idempotencyKey: string; expectedVersion: number },
  ) {
    await assertAvailable();
    validateCommandMeta(meta);
    const input = issueInput.parse(rawInput);
    const userId = assertPerson(context, input.organizationId);
    if (meta.expectedVersion !== 0) {
      throw new DomainError(
        "version_conflict",
        "New credentials require expected version zero",
      );
    }
    assertAdmissibleScopes(input.scopes);
    const scopes = [...input.scopes].sort();
    return mint({
      userId,
      sessionId: context.credentialId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      name: input.name,
      scopes,
      lifetime: { expiresInDays: input.expiresInDays },
      commandName: "issue_operator_credential",
      idempotencyKey: meta.idempotencyKey,
      normalizedInput: { ...input, scopes },
      correlationId: context.correlationId,
    });
  }

  /**
   * A rotation replaces a secret; it never re-authorises it (F3-8). The
   * replacement keeps the member, the project, the scopes and the lineage,
   * and lives only as long as the old credential had left; the old one gets
   * an overlap of at most 60 minutes. Only the credential's own issuer may
   * rotate it: the replacement carries the issuer's authority, so a key
   * revealed to anyone else would hand them that authority. Anyone else
   * with the right revokes instead. If the overlap cannot be set, the
   * replacement is revoked, so a failed rotation leaves one live credential.
   */
  async function rotate(
    context: AuthorizedCommandContext,
    input: {
      organizationId: string;
      credentialId: string;
      overlapMinutes?: number;
      meta: { idempotencyKey: string; expectedVersion: number };
    },
  ) {
    await assertAvailable();
    validateCommandMeta(input.meta);
    const userId = assertPerson(context, input.organizationId);
    const old = (
      await dependencies.repository.listCredentials(input.organizationId)
    ).find((credential) => credential.id === input.credentialId);
    if (!old) {
      throw new DomainError("not_found", "Operator credential was not found");
    }
    if (old.memberUserId !== userId) {
      throw new DomainError(
        "forbidden",
        "Only the person who issued an operator credential may rotate it",
      );
    }
    if (old.revokedAt || old.version !== input.meta.expectedVersion) {
      throw new DomainError("version_conflict", "Operator credential changed");
    }
    if (old.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(
        "invalid_state",
        "An expired operator credential cannot be rotated",
      );
    }
    const overlapMinutes = Math.min(
      maxOverlapMinutes,
      Math.max(0, Math.trunc(input.overlapMinutes ?? defaultOverlapMinutes)),
    );
    const replacement = await mint({
      userId,
      sessionId: context.credentialId,
      organizationId: input.organizationId,
      projectId: old.projectId,
      name: `${old.name} (rotated)`.slice(0, 160),
      scopes: old.scopes,
      lifetime: {
        expiresAt: old.expiresAt,
        lineageId: old.lineageId,
        rotatedFromId: old.id,
      },
      commandName: "rotate_operator_credential",
      idempotencyKey: input.meta.idempotencyKey,
      normalizedInput: {
        organizationId: input.organizationId,
        credentialId: old.id,
        expectedVersion: input.meta.expectedVersion,
        overlapMinutes,
      },
      correlationId: context.correlationId,
    });
    try {
      await dependencies.repository.setCredentialOverlap({
        organizationId: input.organizationId,
        credentialId: old.id,
        expectedVersion: input.meta.expectedVersion,
        overlapExpiresAt: new Date(Date.now() + overlapMinutes * 60_000),
        actorUserId: userId,
        correlationId: context.correlationId,
      });
    } catch (error) {
      await dependencies.repository.revokeCredentialForCompensation({
        organizationId: input.organizationId,
        credentialId: replacement.credential.id,
        actorUserId: userId,
        correlationId: context.correlationId,
        reason:
          "Replacement operator credential revoked because rotation could not complete",
      });
      throw error;
    }
    return replacement;
  }

  /** The organisation's credentials, for a person who may manage them. */
  async function list(
    context: AuthorizedCommandContext,
    organizationId: string,
  ): Promise<OperatorCredentialSummary[]> {
    await assertAvailable();
    assertPerson(context, organizationId);
    return dependencies.repository.listCredentials(organizationId);
  }

  return { issue, rotate, list };
}

export type OperatorCredentialService = ReturnType<
  typeof createOperatorCredentialService
>;
