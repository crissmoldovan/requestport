import type {
  ActorRef,
  AuthorizedCommandContext,
} from "../shared/authorization.js";

/**
 * The operator credential (Plan 13, F.3): a secret a script, CI job or the
 * self-host CLI holds, acting on `/api/v1` with the live authority of the
 * organisation member who issued it, narrowed by the scopes written on it and,
 * if the issuer chose, to one project. It reaches only the capabilities whose
 * registry entry names `"operator"` in `credentialKinds`, never mints a
 * credential and never does agent work.
 */
export const operatorCredentialKind = "operator";

/**
 * The Better Auth api-key configuration that holds operator keys, and the
 * prefix it gives them. The prefix only routes a bearer to the operator branch;
 * the configuration check and the binding row are what refuse a key of the
 * other kind, because a signed-in user chooses a key's prefix and
 * configuration when creating one over HTTP (F3-11).
 */
export const operatorApiKeyConfigId = "requestport-operator";
export const operatorKeyPrefix = "rpo_";

/** The scope a person needs to issue, rotate and revoke operator credentials. */
export const operatorManageScope = "operator:manage";

/**
 * Lets an operator credential revoke another within its own binding. A
 * credential needs no scope to revoke itself.
 */
export const operatorRevokeScope = "operator:revoke";

/**
 * Lets an operator credential take authority away from an agent, and nothing
 * else (Plan 13, F.2.2; ruling 3, F3-4): suspend an agent principal, revoke
 * one of its API keys, revoke one of its OAuth grants. `agent:manage`, which a
 * person holds for the same three acts, also creates principals and mints and
 * rotates keys, so it is never admissible on an operator; this is the
 * narrower scope F3-4 asks the agent administration group to propose. Only an
 * operator carries it: a person suspends and revokes with `agent:manage`.
 */
export const agentRevokeScope = "agent:revoke";

/**
 * The scopes an operator credential may carry: an explicit allow-list, never
 * derived from another set, so it does not widen when that set grows. Its
 * first entry is `operator:revoke`, F.3's. An F.2 group appends the scopes its
 * operator-admitted capabilities check, in the change that admits them: one
 * line per scope, an append point where two appends keep both lines.
 * `operator_credentials_scopes_check` in `@requestport/db` refuses the
 * excluded scopes below on its own.
 */
export const operatorScopes: readonly string[] = [
  operatorRevokeScope,
  // F.2.0b: `list_administration_projects` and `list_administration_lanes`.
  "project:read",
  // F.2.0b: `list_administration_members`.
  "org:read",
  // Plan 13, F.2.3: the eleven project settings commands and their read.
  "project:manage",
  // Plan 13, F.2.1: the three routing rule commands, their read and the
  // route tester's evaluation.
  "routing:manage",
  // Plan 13, F.2.1: the request form's route preview.
  "request:create",
  // Plan 13, F.2.2: suspending an agent, revoking its key or its grant, and
  // the two reads those take their identifiers from.
  agentRevokeScope,
  // Plan 13, F.2.4: the four requeues, the two retention hold commands and
  // their two reads.
  "operations:manage",
  // Plan 13, F.2.5: the three Slack administration commands and their read.
  "slack:manage",
  // Plan 13, F.2.6: import review, the split and their two reads. Also an
  // agent scope (the MCP import tools); each entry admits operators alone.
  "import:write",
  // Plan 13, F.2.7: members, invitations and organisation appearance — four
  // commands and their two reads.
  "members:manage",
];

/**
 * The scopes only an operator credential carries (F3-4's table: no agent key
 * and no person holds them; a person revokes with `operator:manage`). A
 * signed-in person's `humanScopes` holds every scope a registry entry requires
 * except these, and its test reads the exemption from here.
 */
export const operatorOnlyScopes: readonly string[] = [
  operatorRevokeScope,
  // Plan 13, F.2.2: a person suspends and revokes with `agent:manage`.
  agentRevokeScope,
];

/**
 * Never admissible on an operator credential, in code and by the table's
 * CHECK: nothing that mints a credential (`project:provision`,
 * `agent:manage`, `operator:manage`), no agent or service work (`work:claim`,
 * `work:update`, `work:sweep`, `agent:register`), and no decryption of private
 * telemetry (`workspace:telemetry:reveal`). `work:sweep` is load-bearing: the
 * operator is a `service` actor, and the sweep commands admit any `service`
 * actor that holds it.
 */
export const operatorExcludedScopes = [
  "project:provision",
  "agent:manage",
  "operator:manage",
  "work:claim",
  "work:update",
  "work:sweep",
  "agent:register",
  "workspace:telemetry:reveal",
] as const;

/** Every operator credential expires; 30 days unless the issuer says less or more. */
export const operatorCredentialDefaultLifetimeDays = 30;
/** The table's CHECK enforces the same bound. */
export const operatorCredentialMaxLifetimeDays = 90;

const operatorActorIdPrefix = "operator:";

export type OperatorActor = {
  type: "service";
  id: string;
  originatingActor: { type: "user"; id: string };
};

/**
 * The operator's actor: a `service` actor named for the credential's lineage,
 * which is stable across rotation, with the issuing member as its origin. It
 * is not a uuid, so it must never reach a query that compares
 * `context.actor.id` with a `uuid` column; the REST admission and
 * `assertCurrent` stop an operator before any such query runs.
 */
export function operatorActor(input: {
  lineageId: string;
  memberUserId: string;
}): OperatorActor {
  return {
    type: "service",
    id: `${operatorActorIdPrefix}${input.lineageId}`,
    originatingActor: { type: "user", id: input.memberUserId },
  };
}

/** The lineage id an operator actor names, or null for any other actor. */
export function operatorLineageId(actor: ActorRef): string | null {
  return actor.type === "service" && actor.id.startsWith(operatorActorIdPrefix)
    ? actor.id.slice(operatorActorIdPrefix.length) || null
    : null;
}

type ContextWithActor = Pick<AuthorizedCommandContext, "actor"> & {
  credentialKind?: unknown;
};

export type OperatorCommandContext = AuthorizedCommandContext & {
  actor: OperatorActor;
  credentialKind: "operator";
};

/**
 * Whether a context is an operator's. Both halves must agree: the context
 * says `credentialKind: "operator"`, and its actor is a service actor named
 * `operator:<lineage>` whose origin is a user. Either alone is not enough, so
 * the worker's own service actor, which has no origin, is never taken for one.
 */
export function isOperatorContext<T extends ContextWithActor>(
  context: T,
): context is T & Pick<OperatorCommandContext, "actor" | "credentialKind"> {
  const actor = context.actor;
  return (
    context.credentialKind === operatorCredentialKind &&
    operatorLineageId(actor) !== null &&
    actor.type === "service" &&
    actor.originatingActor?.type === "user" &&
    typeof actor.originatingActor.id === "string" &&
    actor.originatingActor.id.length > 0
  );
}

/**
 * Whether a context claims to be an operator's by either half, well formed or
 * not. Confinement uses this, so a context that claims the kind without the
 * shape is confined rather than let through.
 */
export function claimsOperator(context: ContextWithActor) {
  return (
    context.credentialKind === operatorCredentialKind ||
    operatorLineageId(context.actor) !== null
  );
}

/**
 * The organisation member whose authority a context acts with: the signed-in
 * person for a user actor, the issuing member for an operator, and nobody for
 * anything else. An F.2 capability that admits operators takes the acting
 * member from here, never from `context.actor.id`, which for an operator is
 * `operator:<lineage>`.
 */
export function memberAuthority(
  context: ContextWithActor,
): { userId: string; via: "session" | "operator" } | null {
  if (context.actor.type === "user") {
    return { userId: context.actor.id, via: "session" };
  }
  if (isOperatorContext(context)) {
    return { userId: context.actor.originatingActor.id, via: "operator" };
  }
  return null;
}

/**
 * The `actor_type` and `actor_id` a `security_audit_records` row carries for
 * a context. An operator is recorded as the service it is, never as its
 * member: the member is one join away through the credential row.
 */
export function auditActor(context: ContextWithActor): {
  actorType: "user" | "agent" | "service";
  actorId: string;
} {
  return { actorType: context.actor.type, actorId: context.actor.id };
}

/**
 * Whether F3-14 lets operator credentials be issued and used here. It is on
 * only when the deployment's switch is `enabled` **and** its Better Auth
 * composition closes `/change-password`; `@requestport/auth` computes it once
 * per process, and `@requestport/db` adds the table's presence to it.
 */
export type OperatorCredentialSwitch =
  | { enabled: true }
  | { enabled: false; reason: "switched-off" | "change-password-mounted" };

/** The answer a caller of F3-14 gets: the switch, and the table's presence. */
export type OperatorCredentialAvailability =
  | { available: true }
  | {
      available: false;
      reason: "not-migrated" | "switched-off" | "change-password-mounted";
    };
