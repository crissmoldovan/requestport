import { z } from "zod";

import {
  type AuthorizedCommandContext,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import {
  auditActor,
  isOperatorContext,
  operatorManageScope,
  operatorRevokeScope,
} from "./operator-types.js";

export const revokeOperatorCredentialCommandName = "revoke_operator_credential";

/** The unit-of-work port the command opens (`@requestport/db`'s repository). */
export const operatorCredentialsPortName = "operatorCredentials";

/**
 * The organisation is injected by the route from the credential, never taken
 * from the caller; `authorize` checks it against the context again.
 */
const revokeInputSchema = z.strictObject({
  organizationId: z.uuid(),
  credentialId: z.uuid(),
});

export type RevokeOperatorCredentialInput = z.infer<typeof revokeInputSchema>;

/** By command name, the schema each definition below parses with. */
export const operatorCommandInputSchemas = {
  [revokeOperatorCredentialCommandName]: revokeInputSchema,
} as const;

export type LockedOperatorCredential = {
  id: string;
  organizationId: string;
  memberUserId: string;
  projectId: string | null;
  lineageId: string;
  version: number;
  revokedAt: Date | null;
};

export interface OperatorCredentialPort {
  lockCredential(input: {
    organizationId: string;
    credentialId: string;
  }): Promise<LockedOperatorCredential | null>;
  lockMemberRole(input: {
    organizationId: string;
    userId: string;
  }): Promise<{ role: "owner" | "admin" | "member" } | null>;
  revokeCredential(input: {
    organizationId: string;
    credentialId: string;
    expectedVersion: number;
    actor: ReturnType<typeof auditActor>;
    reason: string;
    correlationId: string;
  }): Promise<{ id: string; revoked: true; version: number }>;
}

function port(uow: UnitOfWork) {
  return uow.port<OperatorCredentialPort>(operatorCredentialsPortName);
}

async function lockTarget(
  uow: UnitOfWork,
  input: RevokeOperatorCredentialInput,
) {
  const target = await port(uow).lockCredential(input);
  if (!target) {
    throw new DomainError("not_found", "Operator credential was not found");
  }
  return target;
}

/**
 * Who may revoke (F3-9). An operator credential can reduce authority but never
 * create it, so revocation is the one command it reaches in F.3.
 *
 * - A person holding `operator:manage`: any credential in the organisation as
 *   an owner or admin, otherwise only one they issued.
 * - An operator, the credential it is, with no scope: a credential can
 *   always revoke itself. Another credential of its lineage (a rotation)
 *   counts as another credential.
 * - An operator, another credential, with `operator:revoke`: an
 *   organisation-wide operator reaches any in the organisation, a project-bound
 *   one only those bound to its own project.
 * - Nobody else: agents and every other service actor are refused.
 */
async function authorizeRevocation(
  context: AuthorizedCommandContext,
  input: RevokeOperatorCredentialInput,
  uow: UnitOfWork,
) {
  requireOrganization(context, input.organizationId);
  if (context.actor.type === "user") {
    requireScope(context, operatorManageScope);
    const [membership, target] = [
      await port(uow).lockMemberRole({
        organizationId: input.organizationId,
        userId: context.actor.id,
      }),
      await lockTarget(uow, input),
    ];
    if (
      membership?.role === "owner" ||
      membership?.role === "admin" ||
      (membership && target.memberUserId === context.actor.id)
    ) {
      return;
    }
    throw new DomainError(
      "forbidden",
      "Operator credential revocation is not permitted",
    );
  }
  if (isOperatorContext(context)) {
    const target = await lockTarget(uow, input);
    // The credential, not its lineage: a rotation shares the lineage (and so
    // the actor) through its overlap, and needs `operator:revoke` to revoke its
    // predecessor or be revoked by it. `assertCurrent` has already bound
    // `credentialId` to this actor's lineage and member.
    if (target.id === context.credentialId) return;
    requireScope(context, operatorRevokeScope);
    if (context.projectId && target.projectId !== context.projectId) {
      throw new DomainError("forbidden", "Operator project access is denied");
    }
    return;
  }
  throw new DomainError(
    "forbidden",
    "Operator credentials are revoked by a person or an operator",
  );
}

export function createOperatorCommandDefinitions(): Array<
  CommandDefinition<unknown, JsonObject>
> {
  const revoke: CommandDefinition<unknown, JsonObject> = {
    name: revokeOperatorCredentialCommandName,
    parse: (input) => revokeInputSchema.parse(input),
    async authorize(context, rawInput, uow) {
      await authorizeRevocation(
        context,
        revokeInputSchema.parse(rawInput),
        uow,
      );
    },
    async execute(uow, context, rawInput, meta) {
      const input = revokeInputSchema.parse(rawInput);
      const target = await lockTarget(uow, input);
      if (target.revokedAt || target.version !== meta.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "Operator credential changed",
        );
      }
      const revoked = await port(uow).revokeCredential({
        organizationId: input.organizationId,
        credentialId: input.credentialId,
        expectedVersion: meta.expectedVersion,
        actor: auditActor(context),
        reason:
          context.actor.type === "user"
            ? "A person revoked an operator credential"
            : "An operator credential revoked an operator credential",
        correlationId: context.correlationId,
      });
      // No domain event: a credential's lifecycle is recorded in the audit
      // trail only, as it is for agent keys, so no webhook subscriber sees it.
      return {
        result: {
          id: revoked.id,
          revoked: revoked.revoked,
          version: revoked.version,
        },
        aggregateId: revoked.id,
        events: [],
      };
    },
  };
  return [revoke];
}
