import { z } from "zod";

import { memberAuthority } from "../operators/operator-types.js";
import {
  type ActorRef,
  type AuthorizedCommandContext,
  requireAgentProject,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition, CommandMeta } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import { privateTelemetryFields } from "../workspaces/workspace-types.js";

/*
  Project settings, as commands on the tenant bus (Plan 13, F.2.3). The eleven
  settings forms dispatch these, and so does `/api/v1`, for an operator
  credential only: each has a capability registry entry naming
  `credentialKinds: ["operator"]` and no MCP tool. Each one checks
  `project:manage`, the organisation, the member whose authority it runs with
  (`memberAuthority`: the signed-in person, or an operator's issuing member)
  and, for an operator bound to a project, that the input names that project.
  It then asks the project settings port whether that member may manage the
  project — the same rule the repository applies to every write — before the
  bus answers a replay or runs the write.

  The repository does the write, in its own savepoint inside the bus's
  transaction, and records its audit row, its `project.updated.v1` event and
  its outbox row there. The command returns no events of its own, so the bus's
  after-commit dispatch does not fire for these. The scheduled outbox repair
  run delivers them, as it did when the forms wrote through the repository
  directly.
*/

/** The scope every project settings command requires. */
export const projectSettingsScope = "project:manage";

/** The unit-of-work port these commands write through. */
export const projectSettingsPortName = "projectSettingsCommands";

const target = z.object({ organizationId: z.uuid(), projectId: z.uuid() });
const aliasInput = target.extend({
  alias: z.string().trim().min(1).max(100),
});
const repositoryInput = target.extend({
  repositoryUrl: z.string().trim().min(1).max(500),
});
const repositoryDefaultInput = target.extend({ repositoryId: z.uuid() });
const repositoryStatusInput = repositoryDefaultInput.extend({
  status: z.enum(["active", "archived"]),
});
const laneInput = target.extend({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
});
const laneDefaultInput = target.extend({ laneId: z.uuid() });
const laneStatusInput = laneDefaultInput.extend({
  status: z.enum(["active", "archived"]),
});
const memberInput = target.extend({
  userId: z.string().trim().min(1).max(255),
  role: z.enum(["maintainer", "contributor", "viewer"]),
  status: z.enum(["active", "revoked"]),
});
const workPolicyInput = target.extend({
  heartbeatIntervalSeconds: z.number().int().min(10).max(300),
  leaseMultiplier: z.number().int().min(2).max(10),
  graceSeconds: z.number().int().min(60).max(86_400),
  requiredWorkspaceFields: z
    .array(z.enum(privateTelemetryFields))
    .max(privateTelemetryFields.length),
});
const metadataInput = target.extend({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000),
});
const projectStatusInput = target.extend({
  status: z.enum(["active", "archived"]),
});

/**
 * The input schema each project settings command parses with, by command
 * name. These are the same objects the definitions below call `parse` on. The
 * settings forms parse their submissions with the same fields
 * (`settings/projects/[projectId]/actions.ts`).
 */
export const projectSettingsCommandInputSchemas = {
  add_project_alias: aliasInput,
  add_project_repository: repositoryInput,
  set_default_project_repository: repositoryDefaultInput,
  set_project_repository_status: repositoryStatusInput,
  add_project_lane: laneInput,
  set_default_project_lane: laneDefaultInput,
  set_project_lane_status: laneStatusInput,
  set_project_member: memberInput,
  set_project_work_policy: workPolicyInput,
  update_project_metadata: metadataInput,
  set_project_status: projectStatusInput,
} as const;

export type ProjectSettingsCommandName =
  keyof typeof projectSettingsCommandInputSchemas;

/** Whose authority a write runs under, and on which project. */
export interface ProjectSettingsTarget {
  userId: string;
  organizationId: string;
  projectId: string;
}

/**
 * A write: its target, the version it expects, its correlation, and the
 * context's actor. `userId` is the member whose authority the write runs
 * with; `actor` is who acts — that member for a person, the `service` actor
 * `operator:<lineage>` for an operator — and is what the write records.
 */
export interface ProjectSettingsMutation extends ProjectSettingsTarget {
  correlationId: string;
  expectedVersion: number;
  actor: ActorRef;
}

/**
 * What a write answers: the project and the version the write left it at,
 * the id of the row it created where it created one, and the project's
 * status where it set it.
 */
export interface ProjectSettingsWriteResult {
  projectId: string;
  version: number;
  id?: string;
  status?: "active" | "archived";
}

/**
 * The project settings repository, as the commands reach it through the unit
 * of work. `authorize` throws unless `userId` may manage the project: an owner
 * or admin of the active organisation, or an active maintainer of the project.
 * Every write checks the same again, and the project's version, before it
 * writes.
 */
export interface ProjectSettingsPort {
  authorize(target: ProjectSettingsTarget): Promise<void>;
  addAlias(
    mutation: ProjectSettingsMutation,
    alias: string,
  ): Promise<ProjectSettingsWriteResult>;
  addRepository(
    mutation: ProjectSettingsMutation,
    repositoryUrl: string,
  ): Promise<ProjectSettingsWriteResult>;
  setDefaultRepository(
    mutation: ProjectSettingsMutation,
    repositoryId: string,
  ): Promise<ProjectSettingsWriteResult>;
  setRepositoryStatus(
    mutation: ProjectSettingsMutation,
    repositoryId: string,
    status: "active" | "archived",
  ): Promise<ProjectSettingsWriteResult>;
  addLane(
    mutation: ProjectSettingsMutation,
    input: { name: string; slug: string },
  ): Promise<ProjectSettingsWriteResult>;
  setDefaultLane(
    mutation: ProjectSettingsMutation,
    laneId: string,
  ): Promise<ProjectSettingsWriteResult>;
  setLaneStatus(
    mutation: ProjectSettingsMutation,
    laneId: string,
    status: "active" | "archived",
  ): Promise<ProjectSettingsWriteResult>;
  setMember(
    mutation: ProjectSettingsMutation,
    input: {
      userId: string;
      role: "maintainer" | "contributor" | "viewer";
      status: "active" | "revoked";
    },
  ): Promise<ProjectSettingsWriteResult>;
  setWorkPolicy(
    mutation: ProjectSettingsMutation,
    input: {
      heartbeatIntervalSeconds: number;
      leaseMultiplier: number;
      graceSeconds: number;
      requiredWorkspaceFields: string[];
    },
  ): Promise<ProjectSettingsWriteResult>;
  updateMetadata(
    mutation: ProjectSettingsMutation,
    input: { name: string; description: string | null },
  ): Promise<ProjectSettingsWriteResult>;
  setProjectStatus(
    mutation: ProjectSettingsMutation,
    status: "active" | "archived",
  ): Promise<ProjectSettingsWriteResult>;
}

function port(uow: UnitOfWork) {
  return uow.port<ProjectSettingsPort>(projectSettingsPortName);
}

/**
 * The member a project settings command acts for: the one whose role
 * authorises it, and whom the repository's checks name. It is
 * `memberAuthority(context)` (Plan 13, F.3, F3-2): the person for a `user`
 * actor, the issuing member for a well-formed operator context, and nobody —
 * so `forbidden` before any repository runs — for an agent, for any other
 * service actor, and for a context that claims to be an operator's without
 * being one.
 *
 * A `user` actor is taken as the person it names. That includes the MCP
 * route's provisioning delegation, which presents the delegating person as a
 * `user` actor holding `humanScopes` (so `project:manage`); it cannot reach
 * these commands because no MCP tool names them (each registry entry's
 * `mcpTool` is null), and `/api/v1` authenticates no `user` actor.
 */
function actingMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Project settings require a person or an operator credential",
    );
  return member.userId;
}

/**
 * The target a command runs on, after the checks that need no repository:
 * the scope, the organisation, the acting member, and — for an operator bound
 * to a project — that the input names that project (`requireAgentProject`
 * lets an organisation-wide operator and a person through).
 */
function projectTarget(
  context: AuthorizedCommandContext,
  input: { organizationId: string; projectId: string },
): ProjectSettingsTarget {
  requireScope(context, projectSettingsScope);
  requireOrganization(context, input.organizationId);
  const userId = actingMember(context);
  requireAgentProject(context, input.projectId);
  return {
    userId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  };
}

function writeResult(result: ProjectSettingsWriteResult): JsonObject {
  return {
    projectId: result.projectId,
    version: result.version,
    ...(result.id === undefined ? {} : { id: result.id }),
    ...(result.status === undefined ? {} : { status: result.status }),
  };
}

function projectSettingsCommand<TSchema extends z.ZodType>(
  name: ProjectSettingsCommandName,
  schema: TSchema,
  write: (
    projectSettings: ProjectSettingsPort,
    mutation: ProjectSettingsMutation,
    input: z.output<TSchema>,
  ) => Promise<ProjectSettingsWriteResult>,
): CommandDefinition<unknown, JsonObject> {
  return {
    name,
    parse: (input) => schema.parse(input),
    async authorize(context, rawInput, uow) {
      const input = schema.parse(rawInput) as z.output<typeof target>;
      await port(uow).authorize(projectTarget(context, input));
    },
    async execute(uow, context, rawInput, meta: CommandMeta) {
      const input = schema.parse(rawInput);
      const mutation: ProjectSettingsMutation = {
        ...projectTarget(context, input as z.output<typeof target>),
        correlationId: context.correlationId,
        expectedVersion: meta.expectedVersion,
        actor: context.actor,
      };
      const result = await write(port(uow), mutation, input);
      return {
        result: writeResult(result),
        aggregateId: mutation.projectId,
        events: [],
      };
    },
  };
}

export function createProjectSettingsCommandDefinitions(): Array<
  CommandDefinition<unknown, JsonObject>
> {
  return [
    projectSettingsCommand("add_project_alias", aliasInput, (p, m, input) =>
      p.addAlias(m, input.alias),
    ),
    projectSettingsCommand(
      "add_project_repository",
      repositoryInput,
      (p, m, input) => p.addRepository(m, input.repositoryUrl),
    ),
    projectSettingsCommand(
      "set_default_project_repository",
      repositoryDefaultInput,
      (p, m, input) => p.setDefaultRepository(m, input.repositoryId),
    ),
    projectSettingsCommand(
      "set_project_repository_status",
      repositoryStatusInput,
      (p, m, input) =>
        p.setRepositoryStatus(m, input.repositoryId, input.status),
    ),
    projectSettingsCommand("add_project_lane", laneInput, (p, m, input) =>
      p.addLane(m, { name: input.name, slug: input.slug }),
    ),
    projectSettingsCommand(
      "set_default_project_lane",
      laneDefaultInput,
      (p, m, input) => p.setDefaultLane(m, input.laneId),
    ),
    projectSettingsCommand(
      "set_project_lane_status",
      laneStatusInput,
      (p, m, input) => p.setLaneStatus(m, input.laneId, input.status),
    ),
    projectSettingsCommand("set_project_member", memberInput, (p, m, input) =>
      p.setMember(m, {
        userId: input.userId,
        role: input.role,
        status: input.status,
      }),
    ),
    projectSettingsCommand(
      "set_project_work_policy",
      workPolicyInput,
      (p, m, input) =>
        p.setWorkPolicy(m, {
          heartbeatIntervalSeconds: input.heartbeatIntervalSeconds,
          leaseMultiplier: input.leaseMultiplier,
          graceSeconds: input.graceSeconds,
          requiredWorkspaceFields: [...new Set(input.requiredWorkspaceFields)],
        }),
    ),
    projectSettingsCommand(
      "update_project_metadata",
      metadataInput,
      (p, m, input) =>
        p.updateMetadata(m, {
          name: input.name,
          description: input.description || null,
        }),
    ),
    projectSettingsCommand(
      "set_project_status",
      projectStatusInput,
      (p, m, input) => p.setProjectStatus(m, input.status),
    ),
  ];
}
