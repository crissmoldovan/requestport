"use server";

import { DomainError } from "@requestport/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import type { ActionValidationIssue } from "../../../lib/action-field-issues.js";
import { namedValidationFailure } from "../../../lib/action-field-issues.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import {
  coreCommandBus,
  humanCommandContext,
} from "../../../lib/server-core-commands.js";
import { queueSlackConnectionTest } from "../../../lib/server-slack-actions.js";
import type { SlackActionState } from "./slack-action-state.js";

function state(error: unknown): SlackActionState {
  if (error instanceof DomainError) {
    // A domain rejection that already knows which value it is about keeps that
    // name, so the message lands on the control the reader has to change.
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message:
        error.code === "forbidden"
          ? "Only organization owners and admins can manage Slack."
          : "The Slack settings could not be updated.",
    };
  }
  return {
    status: "error",
    message: "The Slack settings could not be updated.",
  };
}

/**
 * A rejected submission, addressed to the control that owns the value.
 *
 * The mapping, route and connection-test forms each draw a field for every
 * value they ask for, so section 7 puts a schema rejection on that control's
 * own error line. The installation status control draws none — it carries
 * hidden metadata only — and keeps the fixed banner.
 */
function rejected(issues: readonly ActionValidationIssue[]): SlackActionState {
  return { status: "error", ...namedValidationFailure(issues) };
}

/**
 * The session, the organization check and the `slack_user` limiter.
 *
 * Every action in this module resolves this before it reads a single value out
 * of the submission. Parsing first turns an owner/admin-only mutation into an
 * oracle an anonymous caller can query: they learn which of the values a Slack
 * form asks for the server rejects without ever costing a session lookup, and —
 * because the limiter lives behind the same call — without any bound on how
 * often they may ask again.
 */
async function context() {
  const application = await getApplicationContext();
  if (!application.currentOrganization)
    throw new DomainError("forbidden", "Organization required");
  await enforceRateLimit({
    endpointClass: "slack_user",
    fingerprint: rateLimitFingerprint(
      application.currentOrganization.id,
      application.session.user.id,
    ),
  });
  return {
    organization: application.currentOrganization,
    command: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
  };
}

export async function mapSlackUserAction(
  _previous: SlackActionState,
  formData: FormData,
): Promise<SlackActionState> {
  try {
    const current = await context();
    const parsed = z
      .object({
        installationId: z.uuid(),
        userId: z.string().min(1).max(255),
        slackUserId: z
          .string()
          .trim()
          .regex(/^[UW][A-Z0-9]{4,}$/u),
        idempotencyKey: z.string().trim().min(16).max(200),
        expectedVersion: z.coerce.number().int().nonnegative(),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return rejected(parsed.error.issues);
    const input = parsed.data;
    await coreCommandBus.execute({
      name: "set_slack_user_mapping",
      context: current.command,
      input: {
        organizationId: current.organization.id,
        installationId: input.installationId,
        userId: input.userId,
        slackUserId: input.slackUserId,
      },
      meta: {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    });
    revalidatePath("/slack");
    return { status: "success", message: "Slack user mapping saved." };
  } catch (error) {
    unstable_rethrow(error);
    return state(error);
  }
}

export async function setSlackRouteAction(
  _previous: SlackActionState,
  formData: FormData,
): Promise<SlackActionState> {
  try {
    const current = await context();
    const parsed = z
      .object({
        projectId: z.union([z.literal(""), z.uuid()]),
        mode: z.enum(["dm", "channel", "both"]),
        channelId: z.string().trim().max(64),
        fallback: z.enum(["none", "organization_channel", "email"]),
        expectedVersion: z.coerce.number().int().nonnegative(),
        idempotencyKey: z.string().trim().min(16).max(200),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return rejected(parsed.error.issues);
    const input = parsed.data;
    await coreCommandBus.execute({
      name: "set_slack_route",
      context: current.command,
      input: {
        organizationId: current.organization.id,
        projectId: input.projectId || null,
        mode: input.mode,
        channelId: input.channelId || null,
        fallback: input.fallback,
      },
      meta: {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    });
    revalidatePath("/slack");
    return { status: "success", message: "Slack delivery route saved." };
  } catch (error) {
    unstable_rethrow(error);
    return state(error);
  }
}

export async function setSlackInstallationStatusAction(
  _previous: SlackActionState,
  formData: FormData,
): Promise<SlackActionState> {
  try {
    const current = await context();
    const input = z
      .object({
        installationId: z.uuid(),
        expectedVersion: z.coerce.number().int().positive(),
        idempotencyKey: z.string().trim().min(16).max(200),
        status: z.enum(["active", "disabled", "revoked"]),
      })
      .parse(Object.fromEntries(formData));
    await coreCommandBus.execute({
      name: "set_slack_installation_status",
      context: current.command,
      input: {
        organizationId: current.organization.id,
        installationId: input.installationId,
        status: input.status,
      },
      meta: {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    });
    revalidatePath("/slack");
    return {
      status: "success",
      message: `Slack installation ${input.status}.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    return state(error);
  }
}

export async function sendSlackConnectionTestAction(
  _previous: SlackActionState,
  formData: FormData,
): Promise<SlackActionState> {
  try {
    const current = await context();
    const parsed = z
      .object({
        installationId: z.uuid(),
        channelId: z
          .string()
          .trim()
          .regex(/^C[A-Z0-9]{4,}$/u),
        idempotencyKey: z.string().trim().min(16).max(200),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return rejected(parsed.error.issues);
    const input = parsed.data;
    const queued = await queueSlackConnectionTest(
      current.command,
      {
        organizationId: current.organization.id,
        installationId: input.installationId,
        channelId: input.channelId,
      },
      { expectedVersion: 0, idempotencyKey: input.idempotencyKey },
    );
    revalidatePath("/slack");
    return {
      status: "success",
      message: queued.dispatched
        ? `Slack test queued as ${queued.operationId}.`
        : `Slack test ${queued.operationId} is durable and will be retried by the dispatcher.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    return state(error);
  }
}
