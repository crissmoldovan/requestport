"use server";

import {
  DomainError,
  revokeOrganizationInvitationCommandName,
  setOrganizationMemberCommandName,
} from "@requestport/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { namedValidationFailure } from "../../../../lib/action-field-issues.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import {
  coreCommandBus,
  humanCommandContext,
} from "../../../../lib/server-core-commands.js";
import type { MemberActionState } from "./action-state.js";

const memberSchema = z.object({
  userId: z.string().min(1).max(255),
  role: z.enum(["owner", "admin", "member"]),
  status: z.enum(["active", "revoked"]),
  expectedVersion: z.coerce.number().int().positive(),
  idempotencyKey: z.string().min(16).max(200),
});

const invitationSchema = z.object({
  invitationId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  idempotencyKey: z.string().min(16).max(200),
});

function mapError(error: unknown): MemberActionState {
  if (error instanceof DomainError) {
    const messages = {
      forbidden: "You do not have permission to manage that access.",
      not_found: "That access record is no longer available.",
      conflict: "The organization must retain an active owner.",
      invalid_transition: "That invitation is no longer pending.",
      version_conflict: "The record changed. Refresh and try again.",
      rate_limited: "Too many changes. Try again shortly.",
    } as const;
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message:
        messages[error.code as keyof typeof messages] ??
        "The access change could not be saved.",
    };
  }
  // A schema's own message travels with the field name it belongs to, so a
  // rejected role lands on the role control rather than in the banner.
  if (error instanceof z.ZodError) {
    return { status: "error", ...namedValidationFailure(error.issues) };
  }
  return {
    status: "error",
    message: "The access change could not be saved.",
  };
}

/**
 * The session, the organization and the `organization-access` limiter.
 *
 * It takes no argument any more, and that is the whole point: it used to be
 * handed the parsed metadata, which forced every action to read its submission
 * before it could authorize. A schema rejection here is addressed to the
 * control it names, so parsing first answered an anonymous caller per field —
 * and the limiter that would have bounded the asking sits behind this very
 * call.
 */
async function mutationContext() {
  const application = await getApplicationContext();
  if (!application.currentOrganization) {
    throw new DomainError("forbidden", "An active organization is required");
  }
  await enforceRateLimit({
    endpointClass: "mutation",
    fingerprint: rateLimitFingerprint(
      "organization-access",
      application.session.user.id,
    ),
  });
  return {
    organizationId: application.currentOrganization.id,
    command: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
  };
}

/** Whether PostgreSQL ended the command's transaction as a deadlock victim. */
function isDeadlockVictim(error: unknown) {
  // Drizzle wraps the driver's error and keeps it on `cause`, so the SQLSTATE
  // is one level down; the walk is bounded, and never reads a message.
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if ((current as { code?: unknown }).code === "40P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs the organisation administration command `name` on the tenant bus, as
 * the signed-in person, in the current organisation, at the version and with
 * the key the form carries. The command checks `members:manage`, the
 * organisation and the person's role before it answers a replay or writes, and
 * the bus keeps the one receipt (Plan 13, F.2.7).
 *
 * Sent once more, with the same key, if PostgreSQL ends the first attempt as
 * a deadlock victim (`40P01`) — and only then. A member change whose target is
 * changing a member at the same moment can meet one: each person's own
 * membership is held `FOR SHARE` by the bus's `assertCurrent`
 * (`lockOrganizationAccessChanges` in organization-management-repository.ts).
 * The victim's transaction was rolled back whole, receipt included, so the
 * second attempt is answered by the rules, against what the other change left.
 * A second deadlock is answered as any other unexpected failure.
 */
async function dispatch(
  current: Awaited<ReturnType<typeof mutationContext>>,
  name: string,
  meta: { expectedVersion: number; idempotencyKey: string },
  fields: Record<string, unknown>,
) {
  const command = {
    name,
    context: current.command,
    input: { organizationId: current.organizationId, ...fields },
    meta: {
      expectedVersion: meta.expectedVersion,
      idempotencyKey: meta.idempotencyKey,
    },
  };
  try {
    await coreCommandBus.execute(command);
  } catch (error) {
    if (!isDeadlockVictim(error)) throw error;
    await coreCommandBus.execute(command);
  }
}

export async function setOrganizationMemberAction(
  _state: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  try {
    const current = await mutationContext();
    const input = memberSchema.parse(Object.fromEntries(formData));
    await dispatch(current, setOrganizationMemberCommandName, input, {
      userId: input.userId,
      role: input.role,
      status: input.status,
    });
    revalidatePath("/settings/members");
    return {
      status: "success",
      message:
        input.status === "active" ? "Member role updated." : "Access revoked.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function revokeInvitationAction(
  _state: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  try {
    const current = await mutationContext();
    const input = invitationSchema.parse(Object.fromEntries(formData));
    await dispatch(current, revokeOrganizationInvitationCommandName, input, {
      invitationId: input.invitationId,
    });
    revalidatePath("/settings/members");
    return { status: "success", message: "Invitation revoked." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}
