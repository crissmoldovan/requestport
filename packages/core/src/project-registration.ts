import type { createProjectRegistrationRepository } from "@requestport/db";
import {
  type AuthorizedCommandContext,
  type CommandMeta,
  DomainError,
  isOperatorContext,
} from "@requestport/domain";

import { requireProject } from "./network-call.js";
import type { RequestPortSecrets } from "./options.js";

/*
  Project registration, off the command bus (manifest-g.md §2.5's
  `project-registration-repository` row): `register_project`, which an agent
  credential bound to a project runs over REST and MCP. The repository binds
  the registration to the credential's organisation and project itself, checks
  `agent:register`, and keeps its own receipt, keyed with the raw
  `commandFingerprintKey` (`BETTER_AUTH_SECRET` in the web).
*/

type ProjectRegistrationRepository = Pick<
  ReturnType<typeof createProjectRegistrationRepository>,
  "register"
>;

export interface ProjectRegistrationOptions {
  /** The repository, built when a registration runs. */
  repository(): ProjectRegistrationRepository;
  /** `commandFingerprintKey` is read when each registration runs. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
}

type AgentContext = AuthorizedCommandContext & {
  actor: { type: "agent"; id: string };
};

function isAgentContext(
  context: AuthorizedCommandContext,
): context is AgentContext {
  return context.actor.type === "agent";
}

export function createProjectRegistration(options: ProjectRegistrationOptions) {
  return {
    /**
     * Registers the project the input names, for the agent credential that
     * calls. Its registry entry admits agents only, and `execute` refuses
     * an operator before it calls this; this refuses any context that is not
     * an agent's with the same answer, and so fails closed if an entry ever
     * claimed otherwise, since the repository takes an agent. A credential
     * bound to no project is refused before the repository is built.
     */
    async register(
      context: AuthorizedCommandContext,
      input: Record<string, unknown>,
      meta: CommandMeta,
    ) {
      if (isOperatorContext(context) || !isAgentContext(context)) {
        throw new DomainError(
          "forbidden",
          "This kind of credential is not admitted to this command",
        );
      }
      const projectScoped = requireProject(context);
      return options
        .repository()
        .register(
          projectScoped,
          input,
          meta,
          options.secrets.commandFingerprintKey,
        );
    },
  };
}
