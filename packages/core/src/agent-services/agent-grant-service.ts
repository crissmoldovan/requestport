import type {
  createAgentAuthRepository,
  createCommandAuthorizationRepository,
} from "@requestport/db";
import type {
  AgentRepository,
  AgentScope,
  AuthorizedCommandContext,
} from "@requestport/domain";
import {
  agentAdministrationScope,
  agentScopes,
  containsSensitiveContent,
  DomainError,
  memberAuthority,
  requireAgentProject,
  requireOrganization,
  requireScope,
  utf16Max,
  utf16Min,
} from "@requestport/domain";
import { z } from "zod";

const consentInput = z.object({
  organizationId: z.uuid(),
  agentPrincipalId: z.uuid(),
  /**
   * Absent only for an exclusively-provisioning grant, which is organization-
   * wide and names no project. The schema cannot say "absent for that case
   * alone", so `bindConsent` refuses both halves of the mistake below: a
   * provisioning grant that names a project, and an ordinary grant that does
   * not. Making this optional here does not relax the requirement — it moves
   * the refusal to where the scope set is visible.
   */
  /**
   * Absent or null for an exclusively-provisioning grant.
   *
   * `optional()` alone rejected an explicit `null`, which is what the consent
   * action passes for an organization-wide grant — so the value the caller was
   * changed to send was refused by the schema it was sent to.
   */
  projectId: z.uuid().nullish(),
  clientId: z.string().min(1).check(utf16Max(255)),
  audience: z.enum(["mcp", "api"]),
  laneIds: z.array(z.uuid()).max(100).default([]),
  scopes: z.array(z.string()).min(1).max(30),
  expectedVersion: z.literal(0),
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
  newPrincipal: z
    .object({
      id: z.uuid(),
      displayName: z
        .string()
        .trim()
        .min(1)
        .check(utf16Max(160))
        .refine(
          (value) => !containsSensitiveContent(value),
          "Agent name contains private or secret material",
        ),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
      softwareName: z
        .string()
        .trim()
        .min(1)
        .check(utf16Max(160))
        .refine(
          (value) => !containsSensitiveContent(value),
          "Software name contains private or secret material",
        ),
    })
    .optional(),
});

const allowedAgentScopes = new Set<string>(agentScopes);

/**
 * The one scope that is organization-wide, exclusive, and owner-held.
 *
 * `allowedAgentScopes` is built from `agentScopes`, so adding this fifteenth
 * member made it bindable here alongside anything else and by anyone holding
 * `agent:manage`. The three checks in `bindConsent` are that widening put back.
 */
const provisioningScope: AgentScope = "project:provision";

type AgentAuthRepository = ReturnType<typeof createAgentAuthRepository>;

/**
 * The two repository calls this service makes, with the consent binding's
 * `projectId` widened to admit its absence.
 *
 * A provisioning grant genuinely has no project — that is what let an
 * organization's first project be created over MCP — so a binder that cannot
 * represent "no project" cannot express one at all. The shape is stated here
 * rather than taken wholesale from the repository so that this service's
 * contract is the one its rules are written against.
 */
export type AgentGrantRepository = {
  bindOAuthConsent(
    input: Omit<
      Parameters<AgentAuthRepository["bindOAuthConsent"]>[0],
      "projectId"
    > & { projectId: string | null },
  ): Promise<{ id: string }>;
  revokeOAuthGrant(
    input: Parameters<AgentAuthRepository["revokeOAuthGrant"]>[0],
  ): ReturnType<AgentAuthRepository["revokeOAuthGrant"]>;
};

const revokeInput = z.object({
  organizationId: z.uuid(),
  agentPrincipalId: z.uuid(),
  grantId: z.uuid(),
  reason: z
    .string()
    .trim()
    .check(utf16Min(10))
    .check(utf16Max(500))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Reason contains private or secret material",
    ),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
});

export function createAgentGrantService(dependencies: {
  /**
   * The bus's own re-check (`assertCurrent`), which `bindConsent` runs for a
   * person's context once its input is parsed, before anything is read
   * (ruling 233 item 2): its `credentialId` must name an unexpired session of
   * that person while they are an active member of the active organisation,
   * or an active organisation-wide provisioning grant they delegated, while
   * they are an active owner or admin of the organisation (the role is read
   * at the re-check, not at delegation), and its refusal is the call's. Its
   * locks are not held into the repository's own transaction, as the bus
   * holds them into a command's; `bindConsent` hands the same `credentialId`
   * to `bindOAuthConsent`, whose transaction reads the membership and that
   * credential again under lock before it writes (ruling 234 (c)). Absent,
   * `bindConsent` refuses a person's
   * context. `revokeGrant` does not run it: called directly, it re-checks no
   * session; core's revocation handler runs the re-check in its own
   * transaction before it calls it (`../agent-administration.ts`).
   */
  authorization?: Pick<
    ReturnType<typeof createCommandAuthorizationRepository>,
    "assertCurrent"
  >;
  authRepository: AgentGrantRepository;
  /**
   * Resolves organization standing. Asked with no project, `canManage` answers
   * for `owner` and `admin` of an active organization alone — the same
   * resolution the rest of the agent surface uses, rather than a second copy
   * of the membership rules that could drift from it.
   */
  agentRepository: Pick<AgentRepository, "canManage">;
  fingerprintSecret: string;
}) {
  return {
    async bindConsent(context: AuthorizedCommandContext, rawInput: unknown) {
      const input = consentInput.parse(rawInput);
      if (context.actor.type === "user") {
        // A person's context first, as the bus re-checks a person. Any other
        // context reaches the checks below, which refuse all but a user's.
        if (!dependencies.authorization) {
          throw new DomainError(
            "configuration_error",
            "Binding an agent's consent for a person runs the command bus's re-check of their session first, and this service was composed without one",
          );
        }
        await dependencies.authorization.assertCurrent(context);
      }
      requireOrganization(context, input.organizationId);
      requireScope(context, "agent:manage");
      if (context.actor.type !== "user") {
        throw new DomainError("forbidden", "A human user is required");
      }
      if (!input.scopes.every((scope) => allowedAgentScopes.has(scope))) {
        throw new DomainError(
          "validation_failed",
          "Agent scope is not allowed",
        );
      }
      /**
       * Deduplicated before anything reasons about the set.
       *
       * The exclusivity check below asks what a provisioning grant *also*
       * carries, and a repeated scope carries nothing — so
       * `["project:provision", "project:provision"]` passed it, and was then
       * refused by the database, whose check is an exact jsonb equality and so
       * is sensitive to duplicates. That reaches the person as a 500 with
       * nothing to act on, which is precisely what the comment below says this
       * layer exists to prevent.
       */
      const scopes = [...new Set(input.scopes)];
      if (scopes.includes(provisioningScope)) {
        const alsoCarried = scopes
          .filter((scope) => scope !== provisioningScope)
          .toSorted();
        /**
         * Named, not merely counted, because the database refuses this
         * combination too and a constraint violation reaches the person at the
         * consent screen as a 500 with nothing to act on.
         */
        if (alsoCarried.length > 0) {
          throw new DomainError(
            "validation_failed",
            `A ${provisioningScope} grant may carry no other scope, but this one also carries ${alsoCarried.join(", ")}`,
            { scopes: alsoCarried },
          );
        }
        if (input.projectId) {
          throw new DomainError(
            "validation_failed",
            `A ${provisioningScope} grant is organization-wide and must name no project`,
          );
        }
        /**
         * Owner or admin, not the maintainer standing an ordinary project
         * grant accepts: a maintainer of one project could otherwise consent
         * to a grant that creates projects anywhere in the organization and
         * mints their credentials.
         */
        if (
          !(await dependencies.agentRepository.canManage({
            organizationId: input.organizationId,
            projectId: null,
            actor: context.actor,
          }))
        ) {
          throw new DomainError(
            "forbidden",
            "Provisioning consent requires an active organization owner or admin",
          );
        }
      } else if (!input.projectId) {
        throw new DomainError(
          "validation_failed",
          "An agent grant must name a project",
        );
      }
      const grant = await dependencies.authRepository.bindOAuthConsent({
        ...input,
        projectId: input.projectId ?? null,
        // The deduplicated set, not the caller's array. The database check is an
        // exact jsonb equality, so a repeated scope is refused there as a 500
        // even though this layer has already decided the grant is legitimate.
        scopes,
        laneIds: [...new Set(input.laneIds)],
        userId: context.actor.id,
        // Read again, with the membership, in the binding's own transaction
        // (ruling 234 (c)): a session revoked or expired since the re-check
        // above is refused there, before anything is written.
        personCredentialId: context.credentialId,
        correlationId: context.correlationId,
        fingerprintSecret: dependencies.fingerprintSecret,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      });
      return { grantId: grant.id };
    },

    /**
     * Revokes one of an agent's OAuth grants (Plan 13, F.2.2): for a person
     * holding `agent:manage`, or an operator credential holding
     * `agent:revoke`, acting for the member `memberAuthority` names; anyone
     * else is refused before any query. The repository applies the role rule
     * to that member (an owner or admin, the member who delegated the grant,
     * or a maintainer of its project), holds a project-bound operator to the
     * grant's project, and records who acts — for an operator its own
     * `service` actor, never its member — on the audit row and the receipt.
     */
    async revokeGrant(context: AuthorizedCommandContext, rawInput: unknown) {
      const input = revokeInput.parse(rawInput);
      requireOrganization(context, input.organizationId);
      requireScope(context, agentAdministrationScope(context));
      const member = memberAuthority(context);
      if (!member) {
        throw new DomainError(
          "forbidden",
          "Agent administration requires a person or an operator credential",
        );
      }
      return dependencies.authRepository.revokeOAuthGrant({
        ...input,
        actorUserId: member.userId,
        actor: context.actor,
        requireGrantProject: (projectId) =>
          requireAgentProject(context, projectId),
        correlationId: context.correlationId,
        fingerprintSecret: dependencies.fingerprintSecret,
      });
    },
  };
}
