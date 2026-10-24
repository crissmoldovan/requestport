"use server";

import {
  DomainError,
  requestPriorities,
  requestTypes,
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
import { evaluateRouteInTransaction } from "../../../../lib/server-routing-actions.js";
import type { RoutingActionState } from "./routing-action-state.js";

const createSchema = z.object({
  sourceProjectId: z.union([z.literal(""), z.uuid()]),
  targetProjectId: z.uuid(),
  decision: z.enum(["allow", "deny"]),
  requestTypes: z.array(z.enum(requestTypes)).max(requestTypes.length),
  priorities: z.array(z.enum(requestPriorities)).max(requestPriorities.length),
  humanRoles: z.array(z.enum(["owner", "admin", "member"])).max(3),
  laneIds: z.array(z.uuid()).max(100),
  agentPrincipalIds: z.array(z.uuid()).max(100),
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
});

const disableSchema = z.object({
  ruleId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
});

const updateSchema = createSchema.extend({
  ruleId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
});

const testSchema = z.object({
  sourceProjectId: z.union([z.literal(""), z.uuid()]),
  targetProjectId: z.uuid(),
  requestType: z.enum(requestTypes),
  priority: z.enum(requestPriorities),
  laneId: z.union([z.literal(""), z.uuid()]),
  agentPrincipalId: z.union([z.literal(""), z.uuid()]),
});

function errorState(error: unknown): RoutingActionState {
  if (error instanceof DomainError) {
    const messages: Record<string, string> = {
      conflict: "That rule conflicts with existing policy.",
      forbidden: "Only organization owners and admins can manage routing.",
      not_found: "That routing rule is unavailable.",
      validation_failed: "Check the rule values and try again.",
      version_conflict: "The rule changed. Refresh and try again.",
    };
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message: messages[error.code] ?? "Routing policy could not be updated.",
    };
  }
  // A schema's own message travels with the field name it belongs to, so a
  // rejected target lands on the target control rather than in the banner.
  if (error instanceof z.ZodError) {
    return { status: "error", ...namedValidationFailure(error.issues) };
  }
  return { status: "error", message: "Routing policy could not be updated." };
}

/**
 * The session, the organization check and the `mutation` limiter.
 *
 * Every action in this module resolves this before it reads a single value out
 * of the submission. Parsing first turns an owner/admin-only mutation into an
 * oracle an anonymous caller can query: they learn which end of a route the
 * server rejects without ever costing a session lookup, and — because the
 * limiter lives behind the same call — without any bound on how often they may
 * ask again.
 */
async function context() {
  const application = await getApplicationContext();
  if (!application.currentOrganization) {
    throw new DomainError("forbidden", "An active organization is required");
  }
  await enforceRateLimit({
    endpointClass: "mutation",
    fingerprint: rateLimitFingerprint(
      application.currentOrganization.id,
      application.session.user.id,
    ),
  });
  return {
    application,
    organization: application.currentOrganization,
    command: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
  };
}

type RoutingContext = Awaited<ReturnType<typeof context>>;

/**
 * The same step, resolved as a value rather than thrown.
 *
 * Three of these actions answer a rejected submission from outside their `try`,
 * each with its own wording, so wrapping the whole body in one `catch` to get
 * the ordering right would have rewritten those answers. Handing the failure
 * back as a state instead moves the guards in front of the parse and leaves
 * every message exactly where §7 put it.
 */
async function authorized(): Promise<
  | { ok: true; current: RoutingContext }
  | { ok: false; state: RoutingActionState }
> {
  try {
    return { ok: true, current: await context() };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, state: errorState(error) };
  }
}

export async function createRoutingRuleAction(
  _previous: RoutingActionState,
  formData: FormData,
): Promise<RoutingActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const parsed = createSchema.safeParse({
    sourceProjectId: formData.get("sourceProjectId"),
    targetProjectId: formData.get("targetProjectId"),
    decision: formData.get("decision"),
    requestTypes: formData.getAll("requestTypes"),
    priorities: formData.getAll("priorities"),
    humanRoles: formData.getAll("humanRoles"),
    laneIds: formData.getAll("laneIds"),
    agentPrincipalIds: formData.getAll("agentPrincipalIds"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  // The rule forms draw a field for each end of the route and for the
  // decision, so a rejected one is addressed to the control that owns it.
  if (!parsed.success) return errorState(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "create_routing_rule",
      context: gate.current.command,
      meta: { expectedVersion: 0, idempotencyKey: parsed.data.idempotencyKey },
      input: {
        organizationId: gate.current.organization.id,
        sourceKind: parsed.data.sourceProjectId ? "project" : "human_direct",
        // Absent, not `undefined`, for a rule with no source: the bus hashes
        // the parsed input for its receipt, and refuses `undefined` as not
        // JSON-safe.
        ...(parsed.data.sourceProjectId
          ? { sourceProjectId: parsed.data.sourceProjectId }
          : {}),
        targetProjectId: parsed.data.targetProjectId,
        decision: parsed.data.decision,
        requestTypes: parsed.data.requestTypes,
        laneIds: parsed.data.laneIds,
        priorities: parsed.data.priorities,
        humanRoles: parsed.data.humanRoles,
        agentPrincipalIds: parsed.data.agentPrincipalIds,
        enabled: true,
      },
    });
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/settings/routing");
  return { status: "success", message: "Routing rule created." };
}

export async function disableRoutingRuleAction(
  _previous: RoutingActionState,
  formData: FormData,
): Promise<RoutingActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const parsed = disableSchema.safeParse({
    ruleId: formData.get("ruleId"),
    expectedVersion: formData.get("expectedVersion"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success)
    return { status: "error", message: "Routing rule input is invalid." };
  try {
    await coreCommandBus.execute({
      name: "disable_routing_rule",
      context: gate.current.command,
      meta: {
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      input: {
        organizationId: gate.current.organization.id,
        ruleId: parsed.data.ruleId,
      },
    });
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/settings/routing");
  return { status: "success", message: "Routing rule disabled." };
}

export async function updateRoutingRuleAction(
  _previous: RoutingActionState,
  formData: FormData,
): Promise<RoutingActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const parsed = updateSchema.safeParse({
    ruleId: formData.get("ruleId"),
    expectedVersion: formData.get("expectedVersion"),
    sourceProjectId: formData.get("sourceProjectId"),
    targetProjectId: formData.get("targetProjectId"),
    decision: formData.get("decision"),
    requestTypes: formData.getAll("requestTypes"),
    priorities: formData.getAll("priorities"),
    humanRoles: formData.getAll("humanRoles"),
    laneIds: formData.getAll("laneIds"),
    agentPrincipalIds: formData.getAll("agentPrincipalIds"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) return errorState(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "update_routing_rule",
      context: gate.current.command,
      meta: {
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      input: {
        organizationId: gate.current.organization.id,
        ruleId: parsed.data.ruleId,
        sourceKind: parsed.data.sourceProjectId ? "project" : "human_direct",
        // As the create form: absent, not `undefined`, with no source.
        ...(parsed.data.sourceProjectId
          ? { sourceProjectId: parsed.data.sourceProjectId }
          : {}),
        targetProjectId: parsed.data.targetProjectId,
        decision: parsed.data.decision,
        requestTypes: parsed.data.requestTypes,
        laneIds: parsed.data.laneIds,
        priorities: parsed.data.priorities,
        humanRoles: parsed.data.humanRoles,
        agentPrincipalIds: parsed.data.agentPrincipalIds,
        enabled: true,
      },
    });
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/settings/routing");
  return { status: "success", message: "Routing rule updated." };
}

export async function testRoutingRuleAction(
  _previous: RoutingActionState,
  formData: FormData,
): Promise<RoutingActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const parsed = testSchema.safeParse({
    sourceProjectId: formData.get("sourceProjectId"),
    targetProjectId: formData.get("targetProjectId"),
    requestType: formData.get("requestType"),
    priority: formData.get("priority"),
    laneId: formData.get("laneId"),
    agentPrincipalId: formData.get("agentPrincipalId"),
  });
  if (!parsed.success)
    return { status: "error", message: "Choose a complete route to test." };
  try {
    // The one evaluation entry the request form's preview also reaches. It
    // takes the member's role from the organisation's record and evaluates the
    // named agent principal, or the member, with the context's scopes.
    const decision = await evaluateRouteInTransaction(gate.current.command, {
      purpose: "test",
      organizationId: gate.current.organization.id,
      ...(parsed.data.sourceProjectId
        ? { sourceProjectId: parsed.data.sourceProjectId }
        : {}),
      targetProjectId: parsed.data.targetProjectId,
      requestType: parsed.data.requestType,
      priority: parsed.data.priority,
      ...(parsed.data.laneId ? { laneId: parsed.data.laneId } : {}),
      ...(parsed.data.agentPrincipalId
        ? { agentPrincipalId: parsed.data.agentPrincipalId }
        : {}),
    });
    return {
      status: "decision",
      allowed: decision.allowed,
      message: `${decision.allowed ? "Allowed" : "Denied"}: ${decision.reason.replaceAll("_", " ")} · policy v${decision.policyVersion}`,
    };
  } catch (error) {
    return errorState(error);
  }
}
