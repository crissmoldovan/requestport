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
import { utf16Max } from "../shared/zod-compat.js";

/*
  Slack administration, as commands on the tenant bus (Plan 13, F.2.5): mapping
  a member to a Slack user, setting a delivery route, and changing an
  installation's status. The Slack forms dispatch these, and so does
  `/api/v1`, for an operator credential only: each has a capability registry
  entry naming `credentialKinds: ["operator"]` and no MCP tool.

  Each one checks `slack:manage`, the organisation, the member whose authority
  it runs with (`memberAuthority`: the signed-in person, or an operator's
  issuing member), and that an operator is bound to no project, since Slack
  configuration is the organisation's. It then asks the Slack administration
  port whether that member may manage Slack — an owner or admin of the active
  organisation, the rule the repository applies to every write — before the
  bus answers a replay or runs the write. `slack:manage` is F.2.0's scope for
  Slack administration: a signed-in person's context holds it (`humanScopes`),
  an operator credential may carry it (`operatorScopes`), and no agent key or
  grant can.

  The repository does the write, in its own savepoint inside the bus's
  transaction, and records its audit row, its `integration.slack_changed.v1`
  event and its outbox row there. The commands return no events of their own,
  so the bus's after-commit dispatch does not fire for these. The scheduled
  outbox repair run delivers them, as it did when the forms wrote through the
  repository directly.

  The fourth Slack capability, the connection test, is not a command here: it
  dispatches a task after its commit, so it stays off the bus
  (`packages/core/src/slack-connection-test.ts`). Its handler parses
  `slackConnectionTestInputSchema` and runs `slackAdministrationTarget`, the
  same checks these commands run, before its transaction opens. `/api/v1`
  reaches that handler for an operator credential only, through its registry
  entry `send_slack_connection_test` (Plan 13, F.2.5's connection test
  follow-up).
*/

/** The scope every Slack administration capability requires. */
export const slackAdministrationScope = "slack:manage";

/** The unit-of-work port these commands write through. */
export const slackAdministrationPortName = "slackAdministrationCommands";

const target = z.object({ organizationId: z.uuid() });
const userMappingInput = target.extend({
  installationId: z.uuid(),
  userId: z.string().min(1).check(utf16Max(255)),
  slackUserId: z
    .string()
    .trim()
    .regex(/^[UW][A-Z0-9]{4,}$/u),
});
const routeInput = target.extend({
  projectId: z.uuid().nullable(),
  mode: z.enum(["dm", "channel", "both"]),
  channelId: z.string().trim().min(1).check(utf16Max(64)).nullable(),
  fallback: z.enum(["none", "organization_channel", "email"]),
});
const installationStatusInput = target.extend({
  installationId: z.uuid(),
  status: z.enum(["active", "disabled", "revoked"]),
});

/**
 * The input schema each Slack administration command parses with, by command
 * name. These are the same objects the definitions below call `parse` on.
 */
export const slackAdministrationCommandInputSchemas = {
  set_slack_user_mapping: userMappingInput,
  set_slack_route: routeInput,
  set_slack_installation_status: installationStatusInput,
} as const;

export type SlackAdministrationCommandName =
  keyof typeof slackAdministrationCommandInputSchemas;

/**
 * The connection test's input: the organisation, an installation and the
 * channel the test posts to. Not a command's schema — the connection test
 * stays off the bus — but the one its handler parses, and the one its REST
 * entry describes.
 */
export const slackConnectionTestInputSchema = target.extend({
  installationId: z.uuid(),
  channelId: z
    .string()
    .trim()
    .regex(/^C[A-Z0-9]{4,}$/u),
});

/** Whose authority a write runs under, and in which organisation. */
export interface SlackAdministrationTarget {
  actorUserId: string;
  organizationId: string;
}

/**
 * A write: its target, the version it expects, its correlation, and the
 * context's actor. `actorUserId` is the member whose authority the write runs
 * with; `actor` is who acts — that member for a person, the `service` actor
 * `operator:<lineage>` for an operator — and is what the write records.
 */
export interface SlackAdministrationMutation extends SlackAdministrationTarget {
  correlationId: string;
  expectedVersion: number;
  actor: ActorRef;
}

/** What a write answers: the row it wrote and the version it left it at. */
export interface SlackAdministrationWriteResult {
  id: string;
  version: number;
}

/**
 * The Slack repository's administrative writes, as the commands reach them
 * through the unit of work. `authorize` throws `forbidden` unless
 * `actorUserId` is an active owner or admin of the active organisation. Every
 * write checks the same again, and its row's version, before it writes.
 */
export interface SlackAdministrationPort {
  authorize(target: SlackAdministrationTarget): Promise<void>;
  upsertMapping(
    mutation: SlackAdministrationMutation,
    input: { installationId: string; userId: string; slackUserId: string },
  ): Promise<SlackAdministrationWriteResult>;
  setRoute(
    mutation: SlackAdministrationMutation,
    input: {
      projectId: string | null;
      mode: "dm" | "channel" | "both";
      channelId: string | null;
      fallback: "none" | "organization_channel" | "email";
    },
  ): Promise<SlackAdministrationWriteResult>;
  setInstallationStatus(
    mutation: SlackAdministrationMutation,
    input: {
      installationId: string;
      status: "active" | "disabled" | "revoked";
    },
  ): Promise<SlackAdministrationWriteResult & { status: string }>;
}

function port(uow: UnitOfWork) {
  return uow.port<SlackAdministrationPort>(slackAdministrationPortName);
}

/**
 * The member a Slack administration command acts for: the one whose role
 * authorises it, and whom the repository's checks name. It is
 * `memberAuthority(context)` (Plan 13, F.3, F3-2): the person for a `user`
 * actor, the issuing member for a well-formed operator context, and nobody —
 * so `forbidden` before any repository runs — for an agent and for every
 * other service actor, which includes one named `operator:<lineage>` in a
 * context that does not say `credentialKind: "operator"`, or that says it
 * with no originating person.
 *
 * `memberAuthority` reads the actor's type first, so a `user` actor in a
 * context that says `credentialKind: "operator"` is given the person it
 * names here, not nobody. What refuses that context is the next check in
 * `slackTarget`, `requireAgentProject`: `claimsOperator` takes the context
 * for an operator's by its kind and `isOperatorContext` does not, so it is
 * `forbidden` ("Operator project access is denied") before the port is asked,
 * bound to a project or not.
 *
 * A `user` actor is taken as the person it names. That includes the MCP
 * route's provisioning delegation, which presents the delegating person as a
 * `user` actor holding `humanScopes` (so `slack:manage`); it cannot reach
 * these commands because no MCP tool names them (each registry entry's
 * `mcpTool` is null), and `/api/v1` authenticates no `user` actor.
 */
function actingMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Slack administration requires a person or an operator credential",
    );
  return member.userId;
}

/**
 * The target a command runs on, after the checks that need no repository:
 * the scope, the organisation, the acting member, and — Slack configuration
 * being the organisation's (`manifest-f2.md` §4.1, rule 7, binding
 * `organization`) — that an operator is bound to no project.
 * `requireAgentProject` with no project allowed refuses an operator bound to
 * one, and a context that claims to be an operator's without being one, and
 * lets a person and an organisation-wide operator through.
 */
function slackTarget(
  context: AuthorizedCommandContext,
  input: { organizationId: string },
): SlackAdministrationTarget {
  requireScope(context, slackAdministrationScope);
  requireOrganization(context, input.organizationId);
  const actorUserId = actingMember(context);
  requireAgentProject(context);
  return { actorUserId, organizationId: input.organizationId };
}

/**
 * `slackTarget`, for the connection test's handler off the bus
 * (`packages/core/src/slack-connection-test.ts`), so that it admits and refuses
 * exactly whom these commands do, before its transaction opens.
 */
export { slackTarget as slackAdministrationTarget };

function slackAdministrationCommand<TSchema extends z.ZodType>(
  name: SlackAdministrationCommandName,
  schema: TSchema,
  write: (
    slack: SlackAdministrationPort,
    mutation: SlackAdministrationMutation,
    input: z.output<TSchema>,
  ) => Promise<JsonObject & SlackAdministrationWriteResult>,
): CommandDefinition<unknown, JsonObject> {
  return {
    name,
    parse: (input) => schema.parse(input),
    async authorize(context, rawInput, uow) {
      const input = schema.parse(rawInput) as z.output<typeof target>;
      await port(uow).authorize(slackTarget(context, input));
    },
    async execute(uow, context, rawInput, meta: CommandMeta) {
      const input = schema.parse(rawInput);
      const mutation: SlackAdministrationMutation = {
        ...slackTarget(context, input as z.output<typeof target>),
        correlationId: context.correlationId,
        expectedVersion: meta.expectedVersion,
        actor: context.actor,
      };
      const result = await write(port(uow), mutation, input);
      return { result, aggregateId: result.id, events: [] };
    },
  };
}

export function createSlackAdministrationCommandDefinitions(): Array<
  CommandDefinition<unknown, JsonObject>
> {
  return [
    slackAdministrationCommand(
      "set_slack_user_mapping",
      userMappingInput,
      async (slack, mutation, input) => {
        const written = await slack.upsertMapping(mutation, {
          installationId: input.installationId,
          userId: input.userId,
          slackUserId: input.slackUserId,
        });
        return { id: written.id, version: written.version };
      },
    ),
    slackAdministrationCommand(
      "set_slack_route",
      routeInput,
      async (slack, mutation, input) => {
        const written = await slack.setRoute(mutation, {
          projectId: input.projectId,
          mode: input.mode,
          channelId: input.channelId,
          fallback: input.fallback,
        });
        return { id: written.id, version: written.version };
      },
    ),
    slackAdministrationCommand(
      "set_slack_installation_status",
      installationStatusInput,
      async (slack, mutation, input) => {
        const written = await slack.setInstallationStatus(mutation, {
          installationId: input.installationId,
          status: input.status,
        });
        return {
          id: written.id,
          version: written.version,
          status: written.status,
        };
      },
    ),
  ];
}
