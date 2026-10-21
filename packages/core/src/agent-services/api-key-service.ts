import { createHmac } from "node:crypto";

import type {
  AgentCredentialSummary,
  createAgentAuthRepository,
  createAgentRepository,
  createCommandAuthorizationRepository,
} from "@requestport/db";
import type { AgentScope, AuthorizedCommandContext } from "@requestport/domain";
import {
  agentAdministrationScope,
  agentScopes,
  containsSensitiveContent,
  DomainError,
  memberAuthority,
  requireAgentProject,
  requireOrganization,
  requireScope,
  validateCommandMeta,
} from "@requestport/domain";
import { z } from "zod";

const allowedAgentScopes = new Set<string>(agentScopes);

/**
 * Minting authority never sits on an API key.
 *
 * `allowedAgentScopes` is built from `agentScopes`, so adding this fifteenth
 * member made it issuable here by default. An API key has no consenting human
 * behind it and may live 365 days, so one carrying this scope would be an
 * unattended, year-long licence to create projects and mint their credentials.
 * It is granted through the delegated consent screen, where a named human
 * approves it and revoking that grant revokes what it minted, or not at all.
 */
const provisioningScope: AgentScope = "project:provision";

const issuanceReceiptSchema = z.object({
  status: z.literal("complete"),
  credential: z.object({
    id: z.uuid(),
    agentPrincipalId: z.uuid(),
    name: z.string(),
    prefix: z.string(),
    fingerprint: z.string(),
    audience: z.enum(["mcp", "api"]),
    projectId: z.uuid(),
    laneIds: z.array(z.uuid()),
    scopes: z.array(z.string()),
    version: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    overlapExpiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdByUserId: z.string(),
    createdAt: z.iso.datetime(),
  }),
});

const issueInput = z.object({
  organizationId: z.uuid(),
  agentPrincipalId: z.uuid(),
  projectId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(
      (value) => !containsSensitiveContent(value),
      "Credential name contains private or secret material",
    ),
  audience: z.enum(["mcp", "api"]),
  laneIds: z.array(z.uuid()).max(100).default([]),
  scopes: z.array(z.string()).min(1).max(30),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  /**
   * The provisioning grant minting this credential, when one is.
   *
   * Never supplied by the UI, where a signed-in human is the authority and the
   * credential should outlive any particular session. Supplied by
   * `provision_agent`, so that revoking the grant revokes what it made.
   */
  issuedByGrantId: z.uuid().optional(),
});

type AgentAuthRepository = ReturnType<typeof createAgentAuthRepository>;
type AgentRepository = ReturnType<typeof createAgentRepository>;

export function createAgentApiKeyService(dependencies: {
  /**
   * The bus's own re-check (`assertCurrent`), which `issue`, and so
   * `rotate`, run for a person's context once the call's input is parsed,
   * before anything is read or minted (ruling 233 item 2). Absent, both
   * refuse a person's context. `revoke` does not run
   * it: called directly, it re-checks no session; core's revocation handlers
   * run the re-check in their own transaction before they call it
   * (`../agent-administration.ts`).
   */
  authorization?: Pick<
    ReturnType<typeof createCommandAuthorizationRepository>,
    "assertCurrent"
  >;
  createApiKey: (input: {
    name: string;
    userId: string;
    expiresIn: number;
  }) => Promise<{
    id: string;
    key: string;
    prefix: string | null;
    start: string | null;
    expiresAt: Date | null;
  }>;
  authRepository: AgentAuthRepository;
  agentRepository: AgentRepository;
  fingerprintSecret: string;
}) {
  /**
   * A person's context (a `user` actor), re-checked as the bus re-checks a
   * person: its `credentialId` must name an unexpired session of that person
   * while they are an active member of the active organisation, or an active
   * organisation-wide provisioning grant they delegated, while they are an
   * active owner or admin of the organisation (the role is read at the
   * re-check, not at delegation). Its refusal is the call's. Any other
   * context is not re-checked here, and `assertManager` refuses it. The
   * re-check runs where `authorization` runs it; its locks are not held into
   * the repositories' own transactions, as the bus holds them into a
   * command's. The role is `assertManager`'s, and the repository checks it
   * again under lock.
   */
  async function assertCurrentPerson(context: AuthorizedCommandContext) {
    if (context.actor.type !== "user") return;
    if (!dependencies.authorization) {
      throw new DomainError(
        "configuration_error",
        "Issuing an agent key for a person runs the command bus's re-check of their session first, and this service was composed without one",
      );
    }
    await dependencies.authorization.assertCurrent(context);
  }

  async function assertManager(
    context: AuthorizedCommandContext,
    organizationId: string,
    projectId: string,
  ) {
    requireOrganization(context, organizationId);
    requireScope(context, "agent:manage");
    if (context.actor.type !== "user") {
      throw new DomainError("forbidden", "A human maintainer is required");
    }
    if (
      !(await dependencies.agentRepository.canManage({
        organizationId,
        projectId,
        actor: context.actor,
      }))
    ) {
      throw new DomainError("forbidden", "Agent management access is denied");
    }
    return context.actor.id;
  }

  /**
   * Who may revoke one of an agent's keys (Plan 13, F.2.2): a person holding
   * `agent:manage`, or an operator credential holding `agent:revoke`, acting
   * for the member `memberAuthority` names; anyone else is refused before
   * any query. A project-bound operator is held to the key's project. The
   * member must then pass `canManage` on that project, asked about them as
   * the person they are — the rule the form has always applied. Answers the
   * member's user id. Issue and rotate mint a key, and keep `assertManager`:
   * a person only.
   */
  async function assertRevoker(
    context: AuthorizedCommandContext,
    organizationId: string,
    projectId: string,
  ) {
    requireOrganization(context, organizationId);
    requireScope(context, agentAdministrationScope(context));
    const member = memberAuthority(context);
    if (!member) {
      throw new DomainError(
        "forbidden",
        "Agent administration requires a person or an operator credential",
      );
    }
    requireAgentProject(context, projectId);
    if (
      !(await dependencies.agentRepository.canManage({
        organizationId,
        projectId,
        actor: { type: "user", id: member.userId },
      }))
    ) {
      throw new DomainError("forbidden", "Agent management access is denied");
    }
    return member.userId;
  }

  async function issue(
    context: AuthorizedCommandContext,
    rawInput: unknown,
    meta: { idempotencyKey: string; expectedVersion: number },
  ) {
    validateCommandMeta(meta);
    const input = issueInput.parse(rawInput);
    await assertCurrentPerson(context);
    const userId = await assertManager(
      context,
      input.organizationId,
      input.projectId,
    );
    const principal = await dependencies.agentRepository.findPrincipal(
      input.organizationId,
      input.agentPrincipalId,
    );
    if (
      principal?.status !== "active" ||
      (principal.projectId && principal.projectId !== input.projectId)
    ) {
      throw new DomainError("forbidden", "Agent project binding is invalid");
    }
    if (!input.scopes.every((scope) => allowedAgentScopes.has(scope))) {
      throw new DomainError("validation_failed", "Agent scope is not allowed");
    }
    if (input.scopes.includes(provisioningScope)) {
      throw new DomainError(
        "validation_failed",
        `${provisioningScope} requires delegated human consent and cannot be attached to an API key`,
      );
    }
    const normalizedInput = {
      ...input,
      laneIds: [...new Set(input.laneIds)].sort(),
      scopes: [...new Set(input.scopes)].sort(),
    };
    const receipt = await dependencies.authRepository.reserveCredentialIssuance(
      {
        actorUserId: userId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ...meta,
        fingerprintSecret: dependencies.fingerprintSecret,
        normalizedInput,
      },
    );
    const completed = issuanceReceiptSchema.safeParse(receipt.result);
    if (completed.success) {
      throw new DomainError(
        "conflict",
        "Credential issuance already completed; plaintext keys are revealed only once",
      );
    }
    if (!receipt.reserved) {
      throw new DomainError(
        "conflict",
        "Credential issuance is already in progress",
      );
    }
    let created: Awaited<ReturnType<typeof dependencies.createApiKey>> | null =
      null;
    try {
      created = await dependencies.createApiKey({
        name: input.name,
        userId,
        expiresIn: input.expiresInDays * 24 * 60 * 60,
      });
      const credentialFingerprint = createHmac(
        "sha256",
        dependencies.fingerprintSecret,
      )
        .update(created.key)
        .digest("hex");
      const binding = await dependencies.authRepository.createCredential({
        organizationId: input.organizationId,
        agentPrincipalId: input.agentPrincipalId,
        betterAuthApiKeyId: created.id,
        name: input.name,
        prefix: `${created.prefix ?? "rp_"}${created.start ?? ""}`,
        fingerprint: credentialFingerprint,
        audience: input.audience,
        projectId: input.projectId,
        laneIds: normalizedInput.laneIds,
        scopes: normalizedInput.scopes,
        expiresAt:
          created.expiresAt ??
          new Date(Date.now() + input.expiresInDays * 86_400_000),
        createdByUserId: userId,
        /**
         * The grant that authorized this issuance, when one did.
         *
         * Absent for a credential a signed-in human issued in the UI. Present
         * when a provisioning grant minted it, and the repository refuses to
         * write it unless that grant is still usable — which is what lets a
         * single revocation account for every credential a grant produced,
         * instead of leaving the owner to demote themselves.
         */
        ...(input.issuedByGrantId
          ? { issuedByGrantId: input.issuedByGrantId }
          : {}),
        correlationId: context.correlationId,
        issuanceReceipt: receipt,
      });
      return {
        plaintextKey: created.key,
        credential: {
          id: binding.id,
          name: binding.name,
          prefix: binding.prefix,
          fingerprint: binding.fingerprint,
          audience: binding.audience,
          projectId: binding.projectId,
          laneIds: binding.laneIds,
          scopes: binding.scopes,
          expiresAt: binding.expiresAt,
        },
      };
    } catch (error) {
      if (created) {
        await dependencies.authRepository.deleteOrphanApiKey(created.id);
      }
      await dependencies.authRepository.cancelCredentialIssuance(receipt);
      throw error;
    }
  }

  async function revoke(
    context: AuthorizedCommandContext,
    input: {
      organizationId: string;
      credential: AgentCredentialSummary;
      meta: { idempotencyKey: string; expectedVersion: number };
    },
  ) {
    const memberUserId = await assertRevoker(
      context,
      input.organizationId,
      input.credential.projectId,
    );
    // The member's role is checked again, under lock, by the repository; the
    // audit row and the receipt name who acts, which for an operator is its
    // own `service` actor, never its member.
    const revoked = await dependencies.authRepository.revokeCredential({
      organizationId: input.organizationId,
      credentialId: input.credential.id,
      actorUserId: memberUserId,
      actor: context.actor,
      correlationId: context.correlationId,
      ...input.meta,
      fingerprintSecret: dependencies.fingerprintSecret,
    });
    if (!revoked)
      throw new DomainError("not_found", "Credential was not found");
    return { id: input.credential.id, revoked: true };
  }

  /**
   * Issues the replacement through `issue`, whose re-check of a person runs
   * before anything is read, minted or written, then sets the original's
   * overlap.
   */
  async function rotate(
    context: AuthorizedCommandContext,
    input: {
      organizationId: string;
      credential: AgentCredentialSummary;
      overlapMinutes?: number;
      meta: { idempotencyKey: string; expectedVersion: number };
    },
  ) {
    const days = Math.max(
      1,
      Math.ceil(
        (input.credential.expiresAt.getTime() - Date.now()) / 86_400_000,
      ),
    );
    const replacement = await issue(
      context,
      {
        organizationId: input.organizationId,
        agentPrincipalId: input.credential.agentPrincipalId,
        /**
         * Carried forward, so a rotation cannot launder a minted credential.
         *
         * A rotation replaces a credential; it does not re-authorize it. The
         * replacement therefore inherits the grant that authorized the
         * original, and dies with it — otherwise one rotation turned a
         * revocable credential into a permanent one.
         */
        ...(input.credential.issuedByGrantId
          ? { issuedByGrantId: input.credential.issuedByGrantId }
          : {}),
        projectId: input.credential.projectId,
        name: `${input.credential.name} (rotated)`,
        audience: input.credential.audience,
        laneIds: input.credential.laneIds,
        scopes: input.credential.scopes,
        expiresInDays: Math.min(365, days),
      },
      { idempotencyKey: input.meta.idempotencyKey, expectedVersion: 0 },
    );
    const overlapMinutes = Math.min(
      60,
      Math.max(0, input.overlapMinutes ?? 15),
    );
    try {
      const updated = await dependencies.authRepository.setCredentialOverlap({
        organizationId: input.organizationId,
        credentialId: input.credential.id,
        overlapExpiresAt: new Date(Date.now() + overlapMinutes * 60_000),
        overlapMinutes,
        actorUserId: context.actor.id,
        correlationId: context.correlationId,
        ...input.meta,
        fingerprintSecret: dependencies.fingerprintSecret,
      });
      if (!updated) {
        throw new DomainError(
          "version_conflict",
          "Credential changed during rotation",
        );
      }
    } catch (error) {
      await dependencies.authRepository.revokeCredentialForCompensation({
        organizationId: input.organizationId,
        credentialId: replacement.credential.id,
        actorUserId: context.actor.id,
        correlationId: context.correlationId,
        reason:
          "Replacement credential revoked because rotation could not complete",
      });
      throw error;
    }
    return replacement;
  }

  return { issue, revoke, rotate };
}
