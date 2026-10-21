import {
  type AuthorizedCommandContext,
  type CommandMeta,
  type CredentialKind,
  DomainError,
  isOperatorContext,
} from "@requestport/domain";

/**
 * A call a network credential makes, as the adapter that authenticated it
 * hands it to core (G.0a's `CapabilityCall`, its network variant): the
 * context the credential authenticated as, the kind of credential it is, and
 * the command envelope's idempotency key and expected version.
 *
 * The context is structural: an agent's context from `@requestport/auth`
 * (with its audience, grant and lanes) is one, and core names no type of
 * that package (manifest-g.md §2.5.1).
 */
export interface NetworkCapabilityCall {
  context: AuthorizedCommandContext;
  credentialKind: CredentialKind;
  meta: CommandMeta;
}

/**
 * The kind of network credential `context` is: an operator's when
 * `isOperatorContext` recognises it, the test the REST route has always
 * made; an agent's when its actor is an agent; otherwise none, because a
 * person is not a network credential (ruling 63).
 */
export function networkCredentialKind(
  context: AuthorizedCommandContext,
): CredentialKind | undefined {
  if (isOperatorContext(context)) return "operator";
  return context.actor.type === "agent" ? "agent" : undefined;
}

/**
 * The same context, proven to name a project, or the refusal the web's
 * `withProject` (`apps/web/src/lib/agent-project-scope.ts`) answers, in the
 * same words: a credential bound to no project — an exclusively-provisioning
 * grant, or an organisation-wide operator — cannot reach project data.
 */
export function requireProject<T extends { projectId?: string | null }>(
  context: T,
): T & { projectId: string } {
  if (!context.projectId) {
    throw new DomainError(
      "forbidden",
      "This credential is not bound to a project, so it cannot reach project data",
    );
  }
  return { ...context, projectId: context.projectId };
}

/** A command context whose actor is an agent. */
export type AgentContext = AuthorizedCommandContext & {
  actor: Extract<AuthorizedCommandContext["actor"], { type: "agent" }>;
};

/**
 * The call's context, when the call is an agent's, stated as one: its stated
 * kind is `agent`, and its context is an agent's (`networkCredentialKind`).
 * Any other call is refused, before anything is read.
 */
export function agentContextOf(
  call: Pick<NetworkCapabilityCall, "context" | "credentialKind">,
): AgentContext {
  const { context, credentialKind } = call;
  if (
    credentialKind === "agent" &&
    networkCredentialKind(context) === "agent" &&
    context.actor.type === "agent"
  ) {
    return context as AgentContext;
  }
  throw new DomainError(
    "forbidden",
    "This kind of credential is not admitted to this command",
  );
}
