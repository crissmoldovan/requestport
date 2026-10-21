import {
  claimsOperator,
  isOperatorContext,
} from "../operators/operator-types.js";
import { DomainError } from "./errors.js";

export type ActorRef =
  | { type: "user"; id: string }
  | {
      type: "agent";
      id: string;
      delegatedBy?: { type: "user"; id: string };
    }
  | { type: "service"; id: string; originatingActor?: ActorRef };

/**
 * The part of a command context the atomic executor itself depends on. Both
 * the tenant bus and the session-only authenticated-user bus satisfy it, which
 * is what lets them share one receipt/lock/replay implementation instead of
 * growing a second, weaker copy.
 */
export interface CommandActorContext {
  actor: ActorRef;
  credentialId: string;
  correlationId: string;
}

/**
 * A human, session-bound context with no tenant at all. Personal appearance is
 * global across organizations, so implying one here would let a command bind a
 * global preference to a tenant it never authorized against.
 */
export interface AuthenticatedUserCommandContext extends CommandActorContext {
  actor: { type: "user"; id: string };
}

export interface AuthorizedCommandContext extends CommandActorContext {
  actor: ActorRef;
  organizationId: string;
  /**
   * Present for project-bound agent credentials. Domain commands use this
   * binding in addition to the agent principal ID so a principal with grants
   * for multiple projects cannot replay one grant as another project.
   *
   * Explicitly nullable, not merely optional, because an exclusively-
   * provisioning grant genuinely has no project: its capability is
   * organization-wide, and requiring it to name one is what made an
   * organization's first project impossible to create over MCP. Absent and
   * null mean the same thing here — no project — and `requireAgentProject`
   * refuses both, which is why widening this type widens no command.
   */
  projectId?: string | null;
  /** Empty or absent means the project grant is not lane-restricted. */
  laneIds?: ReadonlySet<string>;
  scopes: ReadonlySet<string>;
  credentialId: string;
  credentialFingerprint?: string;
  correlationId: string;
  /**
   * `"operator"` for a context an operator credential authenticated (Plan 13,
   * F.3); absent for every other. `isOperatorContext` recognises an operator
   * only when this and the actor's shape agree, and `assertCurrent` takes its
   * operator branch only then.
   */
  credentialKind?: "operator";
}

/**
 * Confines a machine credential to the projects a command allows.
 *
 * An agent must be bound to one of them. An operator bound to a project must
 * name one of them; an organisation-wide operator (no project) passes, because
 * its authority is the organisation's. A context that claims to be an
 * operator's without being well formed is confined as a project-bound one, so
 * a malformed claim never passes as organisation-wide. Every other context — a
 * person, and the worker's own service actor — passes, as it always has.
 */
export function requireAgentProject(
  context: AuthorizedCommandContext,
  ...allowedProjectIds: Array<string | null | undefined>
) {
  if (claimsOperator(context)) {
    if (!context.projectId && isOperatorContext(context)) return;
    if (
      !context.projectId ||
      !allowedProjectIds.some((projectId) => projectId === context.projectId)
    ) {
      throw new DomainError("forbidden", "Operator project access is denied");
    }
    return;
  }
  if (context.actor.type !== "agent") return;
  if (
    !context.projectId ||
    !allowedProjectIds.some((projectId) => projectId === context.projectId)
  ) {
    throw new DomainError("forbidden", "Agent project access is denied");
  }
}

export function requireAgentLane(
  context: AuthorizedCommandContext,
  laneId: string | null,
) {
  if (context.actor.type !== "agent" || !context.laneIds?.size) return;
  if (!laneId || !context.laneIds.has(laneId)) {
    throw new DomainError("forbidden", "Agent lane access is denied");
  }
}

export function actorId(actor: ActorRef) {
  return actor.id;
}

export function actorFingerprint(actor: ActorRef): string {
  if (actor.type === "agent" && actor.delegatedBy) {
    return `agent:${actor.id}:delegated-by:user:${actor.delegatedBy.id}`;
  }
  if (actor.type === "service" && actor.originatingActor) {
    return `service:${actor.id}:origin:${actorFingerprint(actor.originatingActor)}`;
  }
  return `${actor.type}:${actor.id}`;
}

export function requireScope(context: AuthorizedCommandContext, scope: string) {
  if (!context.scopes.has(scope)) {
    throw new DomainError("forbidden", "Required capability is missing", {
      scope,
    });
  }
}

export function requireOrganization(
  context: AuthorizedCommandContext,
  organizationId: string,
) {
  if (context.organizationId !== organizationId) {
    throw new DomainError("forbidden", "Organization access is denied");
  }
}

/**
 * Denies every machine actor with the caller's fixed message. Agent and service
 * principals reach the tenant bus through the API and MCP surfaces, so a
 * human-only command has to say so explicitly rather than relying on a scope it
 * never grants them.
 */
export function requireHumanActor(
  context: { actor: ActorRef },
  message: string,
) {
  if (context.actor.type !== "user") {
    throw new DomainError("forbidden", message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the session-only human context at the runtime boundary. A context
 * carrying `organizationId` is rejected outright: the authenticated-user bus
 * must never be handed a tenant it did not authorize, and silently ignoring the
 * field would make that mistake invisible.
 */
export function assertAuthenticatedUserContext(
  context: unknown,
): asserts context is AuthenticatedUserCommandContext {
  const invalid = () =>
    new DomainError(
      "forbidden",
      "Authenticated user command context is invalid",
    );
  if (!isRecord(context) || "organizationId" in context) throw invalid();
  const actor = context.actor;
  if (
    !isRecord(actor) ||
    actor.type !== "user" ||
    typeof actor.id !== "string" ||
    actor.id.length === 0
  ) {
    throw invalid();
  }
  if (
    typeof context.credentialId !== "string" ||
    context.credentialId.length === 0 ||
    typeof context.correlationId !== "string" ||
    context.correlationId.length === 0
  ) {
    throw invalid();
  }
}
