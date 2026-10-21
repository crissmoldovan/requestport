import {
  agentCommandInputSchemas,
  createAgentCommandDefinitions,
  registerAgentEventSchemas,
} from "../agents/agent-commands.js";
import {
  appearanceCommandInputSchemas,
  createAppearanceCommandDefinitions,
  createPersonalAppearanceCommandDefinitions,
  personalAppearanceCommandInputSchemas,
} from "../appearance/appearance-commands.js";
import {
  collaborationCommandInputSchemas,
  createCollaborationCommandDefinitions,
  registerCollaborationEventSchemas,
} from "../collaboration/collaboration-commands.js";
import { registerConfigurationEventSchemas } from "../events/configuration-events.js";
import { EventFactory, EventSchemaRegistry } from "../events/event-factory.js";
import { registerImportEventSchemas } from "../imports/import-events.js";
import {
  createImportReviewCommandDefinitions,
  importReviewCommandInputSchemas,
} from "../imports/import-review-commands.js";
import {
  createOperationsCommandDefinitions,
  operationsCommandInputSchemas,
} from "../operations/operations-commands.js";
import {
  createOperatorCommandDefinitions,
  operatorCommandInputSchemas,
} from "../operators/operator-commands.js";
import {
  createOrganizationAdministrationCommandDefinitions,
  organizationAdministrationCommandInputSchemas,
} from "../organizations/organization-administration-commands.js";
import {
  createProjectSettingsCommandDefinitions,
  projectSettingsCommandInputSchemas,
} from "../projects/project-settings-commands.js";
import {
  createRequestCommandDefinitions,
  registerRequestEventSchemas,
  requestCommandInputSchemas,
} from "../requests/request-commands.js";
import type { RequestAction } from "../requests/request-types.js";
import {
  createRoutingCommandDefinitions,
  registerRoutingEventSchemas,
  routingCommandInputSchemas,
} from "../routing/routing-commands.js";
import type { EnvelopeEncryption } from "../security/envelope-encryption.js";
import {
  type AuthenticatedUserCommandContext,
  requireScope,
} from "../shared/authorization.js";
import { type CommandDefinition, CommandRegistry } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import {
  createSlackAdministrationCommandDefinitions,
  slackAdministrationCommandInputSchemas,
} from "../slack/slack-administration-commands.js";
import {
  createWorkCommandDefinitions,
  registerWorkEventSchemas,
  workCommandInputSchemas,
} from "../work/work-commands.js";

/**
 * Every command `createCoreCommandRegistry` registers, mapped to the input
 * schema its definition parses with. The key set equals the registry's names,
 * and a test holds it there. A command reachable over REST or MCP is described
 * from here, which is what lets a generator say what a command accepts without
 * a hand-written copy of the schema.
 */
export const coreCommandInputSchemas = {
  ...agentCommandInputSchemas,
  ...requestCommandInputSchemas,
  ...collaborationCommandInputSchemas,
  ...routingCommandInputSchemas,
  ...workCommandInputSchemas,
  ...appearanceCommandInputSchemas,
  ...projectSettingsCommandInputSchemas,
  ...operatorCommandInputSchemas,
  ...operationsCommandInputSchemas,
  ...slackAdministrationCommandInputSchemas,
  ...importReviewCommandInputSchemas,
  ...organizationAdministrationCommandInputSchemas,
} as const;

/**
 * The same, for `createAuthenticatedUserCommandRegistry`: session-only human
 * commands, absent from every machine surface by design.
 */
export const authenticatedUserCommandInputSchemas = {
  ...personalAppearanceCommandInputSchemas,
} as const;

/**
 * The scope each request lifecycle action requires: the one `authorizeAction`
 * in `requests/request-commands.ts` demands for it inside `execute`. The
 * capability registry (`transport-metadata.ts`) publishes these as
 * `transition_request`'s by-action scopes and as each lifecycle name's scope,
 * and `createCoreCommandRegistry` checks them in `transition_request`'s
 * `authorize` too (`withActionScope` below).
 */
export const requestActionScopes: Readonly<Record<RequestAction, string>> = {
  submit_request: "request:create",
  begin_triage: "request:triage",
  accept_request: "request:triage",
  decline_request: "request:triage",
  mark_duplicate: "request:triage",
  supersede_request: "request:triage",
  plan_request: "request:triage",
  begin_request_work: "work:update",
  block_request: "work:update",
  resume_request: "work:update",
  withdraw_request: "request:create",
  cancel_request: "request:triage",
  reopen_request: "request:triage",
  complete_request: "request:complete",
  verify_request: "request:verify",
};

/**
 * `transition_request` with its action's scope checked in `authorize`, after
 * the definition's own check (which refuses a service actor), and before the
 * request is read. Every other definition is returned unchanged.
 *
 * `AtomicCommandBus` re-runs only `authorize` before it answers from a stored
 * receipt. The definition checks the action's scope in `execute`, so without
 * this a replay by an actor who had since lost the scope was answered from its
 * receipt (Plan 13 B1, finding 1; fixed in F.1). `execute` still checks it
 * again, with the role, claim and project checks that follow it there.
 */
function withActionScope(
  definition: CommandDefinition<unknown, JsonObject>,
): CommandDefinition<unknown, JsonObject> {
  if (definition.name !== "transition_request") return definition;
  return {
    ...definition,
    async authorize(context, input, uow) {
      await definition.authorize(context, input, uow);
      // `input` is what `parse` returned, so `action` is one of the fifteen;
      // an action with no scope here is refused rather than let through.
      const { action } = input as { action: string };
      const scope = Object.hasOwn(requestActionScopes, action)
        ? requestActionScopes[action as RequestAction]
        : undefined;
      if (!scope)
        throw new DomainError("forbidden", "Required capability is missing");
      requireScope(context, scope);
    },
  };
}

export function createCoreEventSchemaRegistry() {
  const registry = new EventSchemaRegistry();
  registerAgentEventSchemas(registry);
  registerRequestEventSchemas(registry);
  registerCollaborationEventSchemas(registry);
  registerRoutingEventSchemas(registry);
  registerWorkEventSchemas(registry);
  registerImportEventSchemas(registry);
  registerConfigurationEventSchemas(registry);
  return registry;
}

export function createCoreCommandRegistry(dependencies?: {
  createId?: () => string;
  now?: () => Date;
  workspaceEncryption?: EnvelopeEncryption;
}) {
  const schemas = createCoreEventSchemaRegistry();
  const events = new EventFactory(
    schemas,
    dependencies?.createId,
    dependencies?.now,
  );
  const registry = new CommandRegistry();
  for (const command of createAgentCommandDefinitions({
    events,
    encryption: dependencies?.workspaceEncryption,
    createId: dependencies?.createId,
  })) {
    registry.register(command);
  }
  for (const command of createRequestCommandDefinitions({
    events,
    createId: dependencies?.createId,
  })) {
    registry.register(withActionScope(command));
  }
  for (const command of createCollaborationCommandDefinitions({
    events,
    createId: dependencies?.createId,
  })) {
    registry.register(command);
  }
  for (const command of createRoutingCommandDefinitions({
    events,
    createId: dependencies?.createId,
  })) {
    registry.register(command);
  }
  for (const command of createWorkCommandDefinitions({
    events,
    createId: dependencies?.createId,
  })) {
    registry.register(command);
  }
  for (const command of createAppearanceCommandDefinitions({ events })) {
    registry.register(command);
  }
  for (const command of createProjectSettingsCommandDefinitions()) {
    registry.register(command);
  }
  for (const command of createOperatorCommandDefinitions()) {
    registry.register(command);
  }
  for (const command of createOperationsCommandDefinitions()) {
    registry.register(command);
  }
  for (const command of createSlackAdministrationCommandDefinitions()) {
    registry.register(command);
  }
  for (const command of createImportReviewCommandDefinitions()) {
    registry.register(command);
  }
  for (const command of createOrganizationAdministrationCommandDefinitions({
    events,
  })) {
    registry.register(command);
  }
  return registry;
}

/**
 * The dedicated session-only human command registry. It carries no organization
 * and is deliberately absent from the generic API and MCP dispatch surfaces, so
 * a personal preference can never be written by an agent or service principal.
 */
export function createAuthenticatedUserCommandRegistry() {
  const registry = new CommandRegistry<AuthenticatedUserCommandContext>();
  for (const command of createPersonalAppearanceCommandDefinitions()) {
    registry.register(command);
  }
  return registry;
}
