import { type CommandMeta, DomainError } from "@requestport/domain";

import type { NetworkCapabilityCall } from "./network-call.js";
import type {
  LocalCredentialSignIn,
  PersonSession,
  RequestPortBetterAuth,
} from "./options.js";

/*
  A person, in process (ruling 63; the principal G.0a fixed in track-g.md).

  In-process code already holds the database credentials, so the library runs
  at the web server's trust level, and its principal is a person signed in
  through Better Auth with D's local credential. Better Auth writes the
  session, never core: `signIn` hands the credential to the caller's
  `betterAuth.signInWithLocalCredential` and answers the session it wrote.

  What such a person may run in process is the in-process rule below: exactly
  the commands an F.0 server action runs for a signed-in person today. The
  registry's `credentialKinds` still govern network credentials only, agents
  and operators over REST and MCP, and are not read for a person. Nothing
  projects this list: the OpenAPI document, the MCP tool list and
  `CredentialKind` do not read it.
*/

/**
 * A call a person makes in process: the session `signIn` answered, the
 * organisation the command runs in, and the command's idempotency key and
 * expected version. Core builds the person's command context from it
 * (`personCommandContext`): a `user` actor, the human scopes, and the
 * session's id as the credential, which the tenant bus's `assertCurrent`
 * requires to name a live session, as it does for the web's forms.
 */
export interface PersonCapabilityCall {
  person: PersonSession;
  organizationId: string;
  meta: CommandMeta;
}

/** A network credential's call (REST, MCP) or a person's, in process. */
export type CapabilityCall = NetworkCapabilityCall | PersonCapabilityCall;

export function isPersonCall(
  call: CapabilityCall,
): call is PersonCapabilityCall {
  return "person" in call;
}

/**
 * The in-process rule (ruling 63): every command a person may run in
 * process, by the name the web's server action hands it. A tenant-bus
 * command goes by its command name, which is also its registry entry's
 * `dispatch.commandName` wherever it has one; the four that run off the bus
 * go by their registry entry's name, which is the only name they have.
 *
 * It is exactly the commands the web's server actions run for a signed-in
 * person, and `person.test.ts` fails when it and their source differ. Left
 * out, on purpose: the personal appearance command, a person's own act
 * (ruling 3) that runs on the session-only user bus, which core does not
 * compose; and the OAuth consent, which is human-only and outside the
 * done-when's modules (ruling 62). The rule names commands, because it is
 * `execute`'s: what the forms do through no command — the reads, Better
 * Auth's key and operator credential services, the import repository's
 * analyse, freeze, apply and correct, project creation, the webhook service
 * and the telemetry reveal — is not in it.
 *
 * One line per command: an R4 append point, like the port table (ruling 8),
 * where two appends keep both lines and are never sorted.
 */
export const inProcessPersonCommands: readonly string[] = Object.freeze([
  // `agents/actions.ts`
  "create_agent_principal",
  "set_agent_principal_status",
  "revoke_agent_credential",
  "revoke_agent_oauth_grant",
  // `imports/actions.ts`
  "review_legacy_import_entry",
  "split_legacy_import_entry",
  // `requests/actions.ts`
  "create_request_draft",
  "transition_request",
  "post_message",
  "update_request",
  "link_requests",
  "unlink_requests",
  "close_question",
  "ask_question",
  "answer_question",
  "attach_artifact",
  "assign_request",
  // `settings/members/actions.ts`
  "set_organization_member",
  "revoke_organization_invitation",
  "resend_organization_invitation",
  // `settings/operations/actions.ts`
  "requeue_outbox",
  "requeue_notification",
  "requeue_slack_operation",
  "requeue_import_dispatch",
  "create_retention_hold",
  "release_retention_hold",
  // `settings/operators/actions.ts`, through `server-operator-actions.ts`
  "revoke_operator_credential",
  // `settings/projects/[projectId]/actions.ts`
  "add_project_alias",
  "add_project_repository",
  "set_default_project_repository",
  "set_project_repository_status",
  "add_project_lane",
  "set_default_project_lane",
  "set_project_lane_status",
  "set_project_member",
  "set_project_work_policy",
  "update_project_metadata",
  "set_project_status",
  // `settings/routing/actions.ts`
  "create_routing_rule",
  "disable_routing_rule",
  "update_routing_rule",
  // `slack/actions.ts`
  "set_slack_user_mapping",
  "set_slack_route",
  "set_slack_installation_status",
  "send_slack_connection_test",
  // the invitation form (`server-administration-actions.ts`)
  "invite_organization_member",
  // the organisation's appearance (`server-appearance-actions.ts`)
  "appearance.update_organization_defaults.v1",
]);

const admitted = new Set(inProcessPersonCommands);

/** Whether the in-process rule admits a person to the command `name`. */
export function admitsPersonInProcess(name: string): boolean {
  return admitted.has(name);
}

/**
 * Signs a person in with D's local credential, through the caller's Better
 * Auth (ruling 63), and answers the session Better Auth wrote. Without
 * `signInWithLocalCredential` it refuses before anything is read.
 */
export function createSignIn(betterAuth: RequestPortBetterAuth | undefined) {
  return async function signIn(
    input: LocalCredentialSignIn,
  ): Promise<PersonSession> {
    const signInWithLocalCredential = betterAuth?.signInWithLocalCredential;
    if (!signInWithLocalCredential) {
      throw new DomainError(
        "configuration_error",
        "signIn() signs in through Better Auth, and this RequestPort was given no betterAuth.signInWithLocalCredential",
      );
    }
    return signInWithLocalCredential(input);
  };
}
