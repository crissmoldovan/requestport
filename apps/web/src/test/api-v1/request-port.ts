/**
 * A `requests` port that lets a command get as far as its scope check.
 *
 * The lifecycle names check their scope inside `transition_request`'s
 * `execute`, after the request has been read, its version compared and the
 * caller's access to it loaded. So a scope refusal is only observable if the
 * request exists, matches the envelope's version, and the caller would
 * otherwise be allowed: this port answers all three that way. The access it
 * reports is a project maintainer who is also the reporter, the claimant and
 * the active worker — the widest a caller can be — so that a refusal can only
 * have come from the scope.
 *
 * Every other method stays unconfigured, which is how a test sees that a
 * command got *past* authorization: the first write it attempts throws
 * `UnconfiguredPortCall`.
 */
import type { RequestActorAccess, RequestRecord } from "@requestport/domain";

import { ids } from "./agent-client.js";
import { apiV1 } from "./fake-database.js";
import type { RestCommand } from "./rest-surface.js";

export function fakeRequest(
  command: Pick<RestCommand, "requestState" | "resumeState">,
  version = 1,
): RequestRecord {
  const at = new Date("2026-09-27T12:00:00.000Z");
  return {
    id: ids.request,
    organizationId: ids.organization,
    sequenceNumber: 1,
    displayKey: "B1-1",
    source: { kind: "project", projectId: ids.project },
    targetProjectId: ids.project,
    laneId: null,
    type: "feature",
    title: "Characterised",
    descriptionMd: "A request the B1 suite pretends to have read.",
    priority: "normal",
    visibility: "organization",
    sensitivity: "normal",
    state: command.requestState,
    resumeState: (command.resumeState ?? null) as RequestRecord["resumeState"],
    stateReason: null,
    reporter: { type: "agent", id: ids.agent },
    assignee: null,
    version,
    routingRuleId: null,
    routingPolicyVersion: null,
    createdAt: at,
    submittedAt: at,
    updatedAt: at,
  };
}

export const widestAccess: RequestActorAccess = {
  organizationRole: "owner",
  projectRole: "maintainer",
  isReporter: true,
  hasExclusiveClaim: true,
  isActiveWorker: true,
  explicitTriageGrant: true,
};

/** Let `command` read its request and the caller's access, and nothing more. */
export function allowRequestReads(command: RestCommand) {
  apiV1.ports.requests = {
    findForUpdate: async () => fakeRequest(command, command.expectedVersion),
    actorAccess: async () => widestAccess,
  };
}
