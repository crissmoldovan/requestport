import {
  type AuthorizedCommandContext,
  DomainError,
  type OperatorCredentialAvailability,
  revokeOperatorCredentialCommandName,
} from "@requestport/domain";
import { z } from "zod";

import {
  type OperatorActionState,
  type OperatorUnavailableReason,
  operatorUnavailableMessages,
} from "../app/(app)/settings/operators/action-state.js";
import { namedValidationFailure } from "./action-field-issues.js";

/*
  The `/settings/operators` actions, after the Server Action has resolved its
  session, its organisation and its limiter (Plan 13, F.3, F3-7 to F3-9).
  Issuing and rotating go to `@requestport/auth`'s service, which is
  human-only by design (ruling 3); revoking runs `revoke_operator_credential`
  on the tenant bus as the person, as an operator runs it over REST.

  Default-deny (F3-14; rulings 46 and 53): every action asks the availability
  first and, while it is off, answers the unavailable state without reading
  the submission or calling anything. An answer the service or the bus gives
  later (the switch read again under them) is mapped to the same state. No
  error escapes as a throw, so the page never turns one into a 500.
*/

const idempotencyKey = z.string().trim().min(16).max(200);

const issueSchema = z.object({
  projectId: z.union([z.literal(""), z.uuid()]).default(""),
  name: z.string().trim().min(1).max(160),
  scopes: z.array(z.string()).max(30),
  expiresInDays: z.coerce.number().int().min(1).max(90),
  expectedVersion: z.coerce.number().int().nonnegative(),
  idempotencyKey,
});

const credentialSchema = z.object({
  credentialId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  overlapMinutes: z.coerce.number().int().min(0).max(60).optional(),
  idempotencyKey,
});

export type OperatorActionContext = {
  command: AuthorizedCommandContext;
  organizationId: string;
};

type OperatorKeyResult = { plaintextKey: string };

export type OperatorActionDependencies = {
  availability: () => Promise<OperatorCredentialAvailability>;
  service: {
    issue: (
      context: AuthorizedCommandContext,
      input: {
        organizationId: string;
        projectId: string | null;
        name: string;
        scopes: string[];
        expiresInDays: number;
      },
      meta: { expectedVersion: number; idempotencyKey: string },
    ) => Promise<OperatorKeyResult>;
    rotate: (
      context: AuthorizedCommandContext,
      input: {
        organizationId: string;
        credentialId: string;
        overlapMinutes?: number;
        meta: { expectedVersion: number; idempotencyKey: string };
      },
    ) => Promise<OperatorKeyResult>;
  };
  executeCommand: (command: {
    name: typeof revokeOperatorCredentialCommandName;
    context: AuthorizedCommandContext;
    input: { organizationId: string; credentialId: string };
    meta: { expectedVersion: number; idempotencyKey: string };
  }) => Promise<unknown>;
  revalidatePath: (path: string) => void;
};

const operatorsPath = "/settings/operators";

const unavailableReasons = new Set<string>(
  Object.keys(operatorUnavailableMessages),
);

function unavailableState(
  reason: OperatorUnavailableReason,
): OperatorActionState {
  return {
    status: "unavailable",
    reason,
    message: operatorUnavailableMessages[reason],
  };
}

/** A refusal as the page shows it; never the error's own text. */
export function operatorActionError(error: unknown): OperatorActionState {
  if (error instanceof DomainError) {
    const reason = error.details.reason;
    if (
      error.code === "configuration_error" &&
      typeof reason === "string" &&
      unavailableReasons.has(reason)
    ) {
      return unavailableState(reason as OperatorUnavailableReason);
    }
    const messages: Partial<Record<string, string>> = {
      conflict:
        "That operator credential change conflicts with current state. If an issuance already completed, its key cannot be shown again; issue or rotate a replacement.",
      forbidden:
        "You do not have permission to manage that operator credential.",
      idempotency_conflict:
        "This action key was already used for different values.",
      invalid_state: "That operator credential has expired.",
      not_found: "That operator credential is no longer available.",
      rate_limited: "Too many changes. Try again shortly.",
      validation_failed: "Check the values and try again.",
      version_conflict: "This record changed. Refresh and try again.",
    };
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message:
        messages[error.code] ??
        "The operator credential action could not be completed.",
    };
  }
  if (error instanceof z.ZodError) {
    return { status: "error", ...namedValidationFailure(error.issues) };
  }
  return {
    status: "error",
    message: "The operator credential action could not be completed.",
  };
}

export function createOperatorActions(
  dependencies: OperatorActionDependencies,
) {
  /** The unavailable state while F3-14's answer is off, otherwise null. */
  async function whileOff(): Promise<OperatorActionState | null> {
    const availability = await dependencies.availability();
    return availability.available
      ? null
      : unavailableState(availability.reason);
  }

  async function answer(
    run: () => Promise<OperatorActionState>,
  ): Promise<OperatorActionState> {
    try {
      return (await whileOff()) ?? (await run());
    } catch (error) {
      return operatorActionError(error);
    }
  }

  return {
    issue(current: OperatorActionContext, formData: FormData) {
      return answer(async () => {
        const input = issueSchema.parse({
          ...Object.fromEntries(formData),
          scopes: formData.getAll("scopes"),
        });
        const result = await dependencies.service.issue(
          current.command,
          {
            organizationId: current.organizationId,
            projectId: input.projectId || null,
            name: input.name,
            scopes: input.scopes,
            expiresInDays: input.expiresInDays,
          },
          {
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          },
        );
        dependencies.revalidatePath(operatorsPath);
        return {
          status: "success",
          message:
            "Operator credential created. Copy it now; RequestPort never stores or reveals the plaintext again.",
          plaintextKey: result.plaintextKey,
        };
      });
    },

    rotate(current: OperatorActionContext, formData: FormData) {
      return answer(async () => {
        const input = credentialSchema.parse(Object.fromEntries(formData));
        const result = await dependencies.service.rotate(current.command, {
          organizationId: current.organizationId,
          credentialId: input.credentialId,
          overlapMinutes: input.overlapMinutes,
          meta: {
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          },
        });
        dependencies.revalidatePath(operatorsPath);
        return {
          status: "success",
          message:
            "Replacement created. Copy it now; the old key keeps working only for the selected overlap.",
          plaintextKey: result.plaintextKey,
        };
      });
    },

    revoke(current: OperatorActionContext, formData: FormData) {
      return answer(async () => {
        const input = credentialSchema.parse(Object.fromEntries(formData));
        await dependencies.executeCommand({
          name: revokeOperatorCredentialCommandName,
          context: current.command,
          input: {
            organizationId: current.organizationId,
            credentialId: input.credentialId,
          },
          meta: {
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          },
        });
        dependencies.revalidatePath(operatorsPath);
        return { status: "success", message: "Operator credential revoked." };
      });
    },
  };
}
