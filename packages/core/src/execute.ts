import {
  type AgentAdministrationHandlerName,
  type AuthorizedCommandContext,
  admitsCredentialKind,
  type CommandMeta,
  DomainError,
  findRestCommandTransport,
} from "@requestport/domain";

import { personCommandContext } from "./command-bus.js";
import { networkCredentialKind, requireProject } from "./network-call.js";
import {
  admitsPersonInProcess,
  type CapabilityCall,
  isPersonCall,
} from "./person.js";

/*
  Running one registry command (manifest-g.md §2.5; Done when 7): the entry by
  its REST name, its admission, its project requirement and its dispatch
  target. The REST route ran all four until Plan 13, G.6, and is now an
  adapter over this. Since Plan 13, H.1 its POST handler is
  `handleRestCommand` (`packages/server/src/rest.ts`), which the route
  (`apps/web/src/app/api/v1/[[...path]]/route.ts`) composes. The handler
  keeps authentication, the rate limit, the content type, the envelope and
  its limits, its own checks of the entry and of the credential's kind before
  it reads the body and of the project after it, and the fields the registry
  injects from the credential, which it writes into the input after the
  caller's own (`injectedValue`). Here the input is taken as the adapter
  hands it, and the entry, the kind and the project are checked again before
  the dispatch.

  A person, in process (ruling 63), is admitted by the in-process rule
  instead (`inProcessPersonCommands`, `person.ts`), never by
  `admitsCredentialKind`, and runs as the context `personCommandContext`
  builds from the session.
*/

/** What the tenant command bus is handed for a `command-bus` entry. */
export interface BusCommand {
  name: string;
  input: Record<string, unknown>;
  context: AuthorizedCommandContext;
  meta: CommandMeta;
}

/**
 * Each dispatch target, by the registry's `dispatch.to`. Each is asked only
 * when an entry dispatches to it.
 */
export interface CommandTargets {
  /** `command-bus`: the tenant command bus's `execute`. */
  commandBus(command: BusCommand): Promise<unknown>;
  /** `project-registration-repository`: `createProjectRegistration`'s `register`. */
  projectRegistration(
    context: AuthorizedCommandContext,
    input: Record<string, unknown>,
    meta: CommandMeta,
  ): Promise<unknown>;
  /** `agent-administration`: the handler the entry names (`createAgentAdministration`). */
  agentAdministration(
    handler: AgentAdministrationHandlerName,
    context: AuthorizedCommandContext,
    input: Record<string, unknown>,
    meta: CommandMeta,
  ): Promise<unknown>;
  /** `import-split`: `createImportSplit`'s `splitImportEntry`. */
  importSplit(
    context: AuthorizedCommandContext,
    input: Record<string, unknown>,
    meta: CommandMeta,
  ): Promise<unknown>;
  /** `slack-connection-test`: `createSlackConnectionTest`'s `queueSlackConnectionTest`. */
  slackConnectionTest(
    context: AuthorizedCommandContext,
    input: Record<string, unknown>,
    meta: CommandMeta,
  ): Promise<unknown>;
}

/**
 * Runs one command for `call`, and answers what its dispatch target answers.
 *
 * For a network credential's call, `name` is the command's REST name:
 *
 * - A name the registry holds no command for is `not_found`, as the route
 *   answers it.
 * - A credential the entry does not admit is `forbidden`, exactly where
 *   `admitsCredentialKind` says no; so is a call whose stated kind is not
 *   the kind its context is (`networkCredentialKind`), so an operator's
 *   context can never pass as an agent's, nor a person's as either.
 * - Where the entry says so (`routeRequiresProject`), a credential bound to
 *   no project is refused before anything is dispatched.
 * - The input is handed on as given: the adapter has written the registry's
 *   injected fields from its credential.
 *
 * For a person's call, in process, `name` is the name the in-process rule
 * gives the command (`inProcessPersonCommands`):
 *
 * - A name the rule does not hold is `forbidden`, whatever the registry
 *   says of it.
 * - The context is the person's (`personCommandContext`): a `user` actor
 *   with the human scopes, whose credential is the session.
 * - A tenant-bus command goes to the bus under `name` itself. One of the
 *   four that run off the bus goes to its registry entry's target. No
 *   project is required of a person, and nothing is injected.
 */
export function createCommandExecution(targets: CommandTargets) {
  return async function execute(
    name: string,
    input: Record<string, unknown>,
    call: CapabilityCall,
  ): Promise<unknown> {
    if (isPersonCall(call)) return executeForPerson(targets, name, input, call);
    const transport = findRestCommandTransport(name);
    if (!transport) {
      throw new DomainError("not_found", "API command was not found");
    }
    const { context, credentialKind, meta } = call;
    if (
      networkCredentialKind(context) !== credentialKind ||
      !admitsCredentialKind(transport, credentialKind)
    ) {
      throw new DomainError(
        "forbidden",
        "This kind of credential is not admitted to this command",
      );
    }
    if (transport.routeRequiresProject) requireProject(context);
    const { dispatch } = transport;
    switch (dispatch.to) {
      case "command-bus":
        return targets.commandBus({
          name: dispatch.commandName,
          input,
          context,
          meta,
        });
      case "project-registration-repository":
        return targets.projectRegistration(context, input, meta);
      case "agent-administration":
        return targets.agentAdministration(
          dispatch.handler,
          context,
          input,
          meta,
        );
      case "import-split":
        return targets.importSplit(context, input, meta);
      case "slack-connection-test":
        return targets.slackConnectionTest(context, input, meta);
      default: {
        // An entry whose target this does not know is a fault, never a pass.
        const unknownTarget: never = dispatch;
        throw new Error(
          `No dispatch for the target of ${name}: ${JSON.stringify(unknownTarget)}`,
        );
      }
    }
  };
}

/** A person's command, in process: the in-process rule, then its target. */
async function executeForPerson(
  targets: CommandTargets,
  name: string,
  input: Record<string, unknown>,
  call: Extract<CapabilityCall, { person: unknown }>,
): Promise<unknown> {
  if (!admitsPersonInProcess(name)) {
    throw new DomainError(
      "forbidden",
      "A person is not admitted to this command in process",
    );
  }
  const context = personCommandContext(call.person, call.organizationId);
  const { meta } = call;
  const dispatch = findRestCommandTransport(name)?.dispatch;
  switch (dispatch?.to) {
    case "agent-administration":
      return targets.agentAdministration(
        dispatch.handler,
        context,
        input,
        meta,
      );
    case "import-split":
      return targets.importSplit(context, input, meta);
    case "slack-connection-test":
      return targets.slackConnectionTest(context, input, meta);
    case "project-registration-repository":
      // Registers a project for an agent credential only; the rule holds no
      // such entry, so this is a fault in the rule, never a pass.
      throw new Error(`No person dispatch for ${name}`);
    default:
      // A tenant-bus command, by its command name: one with no registry
      // entry (`create_agent_principal`), or one whose entry dispatches it
      // to the bus under the same name.
      return targets.commandBus({ name, input, context, meta });
  }
}

export type CommandExecution = ReturnType<typeof createCommandExecution>;
