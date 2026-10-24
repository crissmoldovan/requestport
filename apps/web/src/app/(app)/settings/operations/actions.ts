"use server";

import {
  operationsCommandInputSchemas as commands,
  DomainError,
  type JsonObject,
  type OperationsCommandName,
  utf16Max,
  utf16Min,
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
import {
  dispatchCommittedOutbox,
  dispatchImportTask,
  triggerNotificationDelivery,
  triggerSlackConnectionTest,
  triggerSlackMessageUpdate,
} from "../../../../lib/trigger-client.js";
import type { OperationsActionState } from "./action-state.js";

/**
 * What every operations form submits besides its own fields: the version the
 * page showed — a row's attempt count, a hold's version, or zero for a new
 * hold — and the key that makes a resubmission a replay.
 */
const envelope = z.object({
  expectedVersion: z.coerce.number().int().nonnegative(),
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
});

/**
 * A form's schema: the envelope, then the fields of the command it
 * dispatches, parsed by that command's own schema (Plan 13, F.2.4). The
 * organisation is the session's, written in when the command is dispatched,
 * never read from the form.
 */
function formFields<TName extends OperationsCommandName>(name: TName) {
  const command = commands[name] as unknown as z.ZodObject<z.ZodRawShape>;
  return command.omit({ organizationId: true }).shape as unknown as Omit<
    (typeof commands)[TName]["shape"],
    "organizationId"
  >;
}

const outboxForm = envelope.extend(formFields("requeue_outbox"));
/** The channel is the form's own: it picks the task started after the commit. */
const notificationForm = envelope.extend({
  ...formFields("requeue_notification"),
  channel: z.enum(["email", "slack"]),
});
/**
 * The form still names the operation's type, and a value outside the two is
 * refused as before; the task started after the commit follows the type the
 * command read from the row.
 */
const slackOperationForm = envelope.extend({
  ...formFields("requeue_slack_operation"),
  operationType: z.enum(["message_update", "connection_test"]),
});
const importDispatchForm = envelope.extend(
  formFields("requeue_import_dispatch"),
);
const holdCreateForm = envelope.extend(formFields("create_retention_hold"));
const holdReleaseForm = envelope.extend(formFields("release_retention_hold"));

/**
 * The session, the owner/admin check and the `mutation` limiter.
 *
 * It takes no argument, which is what lets every action here call it before
 * it parses. The hold form is the one operations surface whose schema
 * rejection is addressed to a named control, so the submission must not be
 * read before anything has established that the caller is an operator at all.
 */
async function operatorContext() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization || !["owner", "admin"].includes(organization.role))
    throw new DomainError("forbidden", "Operations access is denied");
  await enforceRateLimit({
    endpointClass: "mutation",
    fingerprint: rateLimitFingerprint(organization.id, context.session.user.id),
  });
  return {
    organizationId: organization.id,
    command: humanCommandContext(context.session, organization.id),
  };
}

/**
 * Runs the operations command `name` on the tenant bus, as the signed-in
 * person, at the version and with the key the form names. The command checks
 * `operations:manage`, the organisation and the person's role before it
 * answers a replay or writes, and the bus keeps the one receipt (Plan 13,
 * F.2.4). It returns once the command has committed.
 */
async function runCommand<TResult extends JsonObject>(
  current: Awaited<ReturnType<typeof operatorContext>>,
  name: OperationsCommandName,
  form: z.output<typeof envelope>,
  fields: Record<string, unknown>,
): Promise<TResult> {
  return coreCommandBus.execute<unknown, TResult>({
    name,
    context: current.command,
    input: { organizationId: current.organizationId, ...fields },
    meta: {
      expectedVersion: form.expectedVersion,
      idempotencyKey: form.idempotencyKey,
    },
  });
}

export async function requeueOutboxAction(
  _previous: OperationsActionState,
  formData: FormData,
): Promise<OperationsActionState> {
  try {
    const current = await operatorContext();
    const input = outboxForm.parse(Object.fromEntries(formData));
    const result = await runCommand<{ outboxId: string; eventId: string }>(
      current,
      "requeue_outbox",
      input,
      { outboxId: input.outboxId },
    );
    const dispatch = await dispatchCommittedOutbox(
      result.outboxId,
      current.organizationId,
    );
    revalidatePath("/settings/operations");
    return {
      status: "success",
      message: dispatch.accepted
        ? "Outbox event requeued and accepted by the dispatcher."
        : "Outbox event requeued; the repair sweep will retry it.",
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof DomainError) {
      const messages: Record<string, string> = {
        forbidden:
          "Only organization owners and admins can operate delivery recovery.",
        not_found: "That outbox event is no longer available.",
        rate_limited: "Too many recovery actions. Wait a moment and try again.",
        validation_failed: "The recovery request was invalid.",
      };
      return {
        status: "error",
        message: messages[error.code] ?? "Recovery action failed.",
      };
    }
    return { status: "error", message: "Recovery action failed." };
  }
}

export async function requeueNotificationAction(
  _previous: OperationsActionState,
  formData: FormData,
): Promise<OperationsActionState> {
  try {
    const current = await operatorContext();
    const input = notificationForm.parse(Object.fromEntries(formData));
    await runCommand(current, "requeue_notification", input, {
      notificationIntentId: input.notificationIntentId,
    });
    let accepted = true;
    try {
      await triggerNotificationDelivery(
        input.notificationIntentId,
        input.channel,
      );
    } catch {
      accepted = false;
    }
    revalidatePath("/settings/operations");
    return {
      status: "success",
      message: accepted
        ? "Notification requeued and accepted for delivery."
        : "Notification requeued; the repair sweep will retry it.",
    };
  } catch (error) {
    unstable_rethrow(error);
    const messages: Record<string, string> = {
      forbidden:
        "Only organization owners and admins can operate delivery recovery.",
      not_found: "That notification intent is no longer available.",
      invalid_state: "Only failed notification intents can be requeued.",
      version_conflict: "That notification changed. Refresh and try again.",
      rate_limited: "Too many recovery actions. Wait a moment and try again.",
      validation_failed: "The recovery request was invalid.",
    };
    return {
      status: "error",
      message:
        error instanceof DomainError
          ? (messages[error.code] ?? "Recovery action failed.")
          : "Recovery action failed.",
    };
  }
}

export async function requeueSlackOperationAction(
  _previous: OperationsActionState,
  formData: FormData,
): Promise<OperationsActionState> {
  try {
    const current = await operatorContext();
    const input = slackOperationForm.parse(Object.fromEntries(formData));
    const result = await runCommand<{
      operationId: string;
      operationType: "message_update" | "connection_test";
    }>(current, "requeue_slack_operation", input, {
      operationId: input.operationId,
    });
    let accepted = true;
    try {
      if (result.operationType === "message_update") {
        await triggerSlackMessageUpdate(result.operationId);
      } else {
        await triggerSlackConnectionTest(result.operationId);
      }
    } catch {
      accepted = false;
    }
    revalidatePath("/settings/operations");
    return {
      status: "success",
      message: accepted
        ? "Slack operation requeued and accepted for delivery."
        : "Slack operation requeued; the repair sweep will retry it.",
    };
  } catch (error) {
    unstable_rethrow(error);
    const messages: Record<string, string> = {
      forbidden:
        "Only organization owners and admins can operate delivery recovery.",
      not_found: "That Slack operation is no longer available.",
      invalid_state: "Only failed Slack operations can be requeued.",
      version_conflict: "That Slack operation changed. Refresh and try again.",
      rate_limited: "Too many recovery actions. Wait a moment and try again.",
      validation_failed: "The recovery request was invalid.",
    };
    return {
      status: "error",
      message:
        error instanceof DomainError
          ? (messages[error.code] ?? "Recovery action failed.")
          : "Recovery action failed.",
    };
  }
}

export async function requeueImportDispatchAction(
  _previous: OperationsActionState,
  formData: FormData,
): Promise<OperationsActionState> {
  try {
    const current = await operatorContext();
    const input = importDispatchForm.parse(Object.fromEntries(formData));
    const result = await runCommand<{ dispatchId: string }>(
      current,
      "requeue_import_dispatch",
      input,
      { dispatchId: input.dispatchId },
    );
    const dispatch = await dispatchImportTask(
      result.dispatchId,
      current.organizationId,
    );
    revalidatePath("/settings/operations");
    return {
      status: "success",
      message: dispatch.accepted
        ? "Import task requeued and accepted by the dispatcher."
        : "Import task requeued; the repair sweep will retry it.",
    };
  } catch (error) {
    unstable_rethrow(error);
    const messages: Record<string, string> = {
      forbidden:
        "Only organization owners and admins can operate delivery recovery.",
      not_found: "That import task is no longer available.",
      invalid_state: "Only dead-lettered import tasks can be requeued.",
      version_conflict: "That import task changed. Refresh and try again.",
      rate_limited: "Too many recovery actions. Wait a moment and try again.",
      validation_failed: "The recovery request was invalid.",
    };
    return {
      status: "error",
      message:
        error instanceof DomainError
          ? (messages[error.code] ?? "Recovery action failed.")
          : "Recovery action failed.",
    };
  }
}

export async function createRetentionHoldAction(
  _previous: OperationsActionState,
  formData: FormData,
): Promise<OperationsActionState> {
  try {
    const current = await operatorContext();
    const input = holdCreateForm.parse(Object.fromEntries(formData));
    await runCommand(current, "create_retention_hold", input, {
      category: input.category,
      reason: input.reason,
    });
    revalidatePath("/settings/operations");
    return { status: "success", message: "Retention hold created." };
  } catch (error) {
    unstable_rethrow(error);
    // The hold is the one operations form with visible fields of its own, so a
    // schema's message travels with the field it belongs to; everything else
    // stays the fixed banner.
    if (error instanceof z.ZodError)
      return { status: "error", ...namedValidationFailure(error.issues) };
    // The bus refuses input its secret detector matches as `validation_failed`
    // naming no field, before authorisation and before any write. The form's
    // schema has passed by now, and the reason is its only free text, so that
    // refusal is the reason's. A refusal naming a field stays the banner.
    if (
      error instanceof DomainError &&
      error.code === "validation_failed" &&
      error.details.field === undefined
    )
      return {
        status: "error",
        field: "reason",
        message:
          "Remove passwords, tokens and other secrets from the reason, then try again.",
      };
    return {
      status: "error",
      message:
        error instanceof DomainError && error.code === "forbidden"
          ? "Only organization owners and admins can manage retention holds."
          : "The retention hold could not be created.",
    };
  }
}

export async function releaseRetentionHoldAction(
  _previous: OperationsActionState,
  formData: FormData,
): Promise<OperationsActionState> {
  try {
    const current = await operatorContext();
    const input = holdReleaseForm.parse(Object.fromEntries(formData));
    await runCommand(current, "release_retention_hold", input, {
      holdId: input.holdId,
    });
    revalidatePath("/settings/operations");
    return { status: "success", message: "Retention hold released." };
  } catch (error) {
    unstable_rethrow(error);
    return {
      status: "error",
      message:
        error instanceof DomainError && error.code === "forbidden"
          ? "Only organization owners and admins can manage retention holds."
          : "The retention hold could not be released.",
    };
  }
}
