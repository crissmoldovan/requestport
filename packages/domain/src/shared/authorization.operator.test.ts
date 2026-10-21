import { describe, expect, test } from "vitest";

import { sanitizeEventActor } from "../events/event-factory.js";
import {
  auditActor,
  isOperatorContext,
  memberAuthority,
  operatorActor,
} from "../operators/operator-types.js";
import {
  type AuthorizedCommandContext,
  actorFingerprint,
  requireAgentProject,
} from "./authorization.js";

/*
  Plan 13, F.3 (F3-2, F3-5). The operator is a `service` actor whose origin is
  the member who issued the credential, recognised only when the context also
  says `credentialKind: "operator"`. `requireAgentProject` confines a
  project-bound operator to its project and lets an organisation-wide one
  through; every other context answers exactly as it did before F.3.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f3a01";
const projectP = "018f0000-0000-7000-8000-0000000f3a02";
const projectQ = "018f0000-0000-7000-8000-0000000f3a03";
const lineageId = "018f0000-0000-7000-8000-0000000f3a04";
const memberUserId = "user_f3_member";

function operatorContext(
  projectId: string | null,
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator",
    organizationId,
    projectId,
    laneIds: new Set(),
    scopes: new Set(["operator:revoke"]),
    credentialId: "018f0000-0000-7000-8000-0000000f3a05",
    correlationId: "018f0000-0000-7000-8000-0000000f3a06",
    ...overrides,
  };
}

function context(
  actor: AuthorizedCommandContext["actor"],
  projectId?: string | null,
): AuthorizedCommandContext {
  return {
    actor,
    organizationId,
    ...(projectId === undefined ? {} : { projectId }),
    scopes: new Set(),
    credentialId: "credential",
    correlationId: "correlation",
  };
}

describe("the operator actor", () => {
  test("is a service actor named for its lineage, with the member as origin", () => {
    expect(operatorActor({ lineageId, memberUserId })).toEqual({
      type: "service",
      id: `operator:${lineageId}`,
      originatingActor: { type: "user", id: memberUserId },
    });
  });

  test("is recognised only with the operator credential kind beside it", () => {
    expect(isOperatorContext(operatorContext(null))).toBe(true);
    const { credentialKind: _omitted, ...withoutKind } = operatorContext(null);
    expect(isOperatorContext(withoutKind)).toBe(false);
    expect(
      isOperatorContext({
        ...operatorContext(null),
        actor: { type: "service", id: "trigger:work-session-sweep" },
      }),
    ).toBe(false);
    expect(
      isOperatorContext({
        ...operatorContext(null),
        actor: { type: "user", id: memberUserId },
      }),
    ).toBe(false);
  });

  test("has its own receipt namespace, apart from its member's", () => {
    const operator = operatorActor({ lineageId, memberUserId });
    expect(actorFingerprint(operator)).toBe(
      `service:operator:${lineageId}:origin:user:${memberUserId}`,
    );
    expect(actorFingerprint(operator)).not.toBe(
      actorFingerprint({ type: "user", id: memberUserId }),
    );
  });

  test("survives the event sanitiser every deployed worker runs, unchanged", () => {
    const operator = operatorActor({ lineageId, memberUserId });
    expect(sanitizeEventActor(operator)).toEqual(operator);
  });
});

describe("memberAuthority and auditActor", () => {
  test("give the acting member for a person and for an operator", () => {
    expect(memberAuthority(context({ type: "user", id: "user_1" }))).toEqual({
      userId: "user_1",
      via: "session",
    });
    expect(memberAuthority(operatorContext(null))).toEqual({
      userId: memberUserId,
      via: "operator",
    });
  });

  test("give no member for an agent, a plain service actor, or a malformed operator", () => {
    expect(memberAuthority(context({ type: "agent", id: "agent_1" }))).toBe(
      null,
    );
    expect(
      memberAuthority(
        context({ type: "service", id: "trigger:work-session-sweep" }),
      ),
    ).toBe(null);
    const { credentialKind: _omitted, ...withoutKind } = operatorContext(null);
    expect(memberAuthority(withoutKind)).toBe(null);
  });

  test("record a person as a user and an operator as the service it is", () => {
    expect(auditActor(context({ type: "user", id: "user_1" }))).toEqual({
      actorType: "user",
      actorId: "user_1",
    });
    expect(auditActor(operatorContext(projectP))).toEqual({
      actorType: "service",
      actorId: `operator:${lineageId}`,
    });
    expect(auditActor(context({ type: "agent", id: "agent_1" }))).toEqual({
      actorType: "agent",
      actorId: "agent_1",
    });
  });
});

describe("requireAgentProject", () => {
  test("lets an organisation-wide operator through for any project", () => {
    expect(() =>
      requireAgentProject(operatorContext(null), projectP),
    ).not.toThrow();
    expect(() =>
      requireAgentProject(operatorContext(null), projectQ),
    ).not.toThrow();
  });

  test("confines a project-bound operator to its project", () => {
    expect(() =>
      requireAgentProject(operatorContext(projectP), projectP),
    ).not.toThrow();
    expect(() =>
      requireAgentProject(operatorContext(projectP), projectQ),
    ).toThrow(/Operator project access is denied/u);
    expect(() => requireAgentProject(operatorContext(projectP), null)).toThrow(
      /Operator project access is denied/u,
    );
  });

  test("confines a context that claims the operator kind but is malformed", () => {
    const malformed = {
      ...operatorContext(null),
      actor: { type: "service" as const, id: "operator:not-a-member" },
    };
    expect(() => requireAgentProject(malformed, projectP)).toThrow(
      /Operator project access is denied/u,
    );
  });

  test("answers an agent exactly as before", () => {
    const agent = { type: "agent" as const, id: "agent_1" };
    expect(() =>
      requireAgentProject(context(agent, projectP), projectP),
    ).not.toThrow();
    expect(() =>
      requireAgentProject(context(agent, projectP), projectQ),
    ).toThrow(/Agent project access is denied/u);
    expect(() => requireAgentProject(context(agent, null), projectP)).toThrow(
      /Agent project access is denied/u,
    );
  });

  test("answers a user and the worker's sweep actor exactly as before", () => {
    expect(() =>
      requireAgentProject(context({ type: "user", id: "user_1" }), projectQ),
    ).not.toThrow();
    const sweep = {
      actor: { type: "service" as const, id: "trigger:work-session-sweep" },
      organizationId,
      scopes: new Set(["work:sweep"]),
      credentialId: "trigger:work-session-sweep",
      correlationId: "correlation",
    };
    expect(() => requireAgentProject(sweep, projectQ)).not.toThrow();
  });
});
