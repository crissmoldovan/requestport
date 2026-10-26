import { describe, expect, test } from "vitest";

import { createCoreEventSchemaRegistry } from "../core/core-commands.js";
import { EventFactory } from "../events/event-factory.js";
import type {
  ActorRef,
  AuthorizedCommandContext,
} from "../shared/authorization.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import { createRequestCommandDefinitions } from "./request-commands.js";
import type { RequestActorAccess, RequestRecord } from "./request-types.js";

/*
  `assign_request` (ruling 262), against a fake repository and the real event
  registry, so the payload is held to the schema the outbox worker parses it
  with.
*/

const organizationId = "8f6b0f2a-0000-4000-8000-0000000000ff";
const projectId = "8f6b0f2a-0000-4000-8000-0000000000aa";
const requestId = "8f6b0f2a-0000-4000-8000-0000000000bb";
const actorId = "user_assigner";
const memberId = "user_member";

const maintainer: RequestActorAccess = {
  organizationRole: "member",
  projectRole: "maintainer",
  isReporter: false,
  hasExclusiveClaim: false,
  isActiveWorker: false,
  explicitTriageGrant: true,
};

function stored(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: requestId,
    organizationId,
    sequenceNumber: 7,
    displayKey: "RP-7",
    source: { kind: "human_direct" },
    targetProjectId: projectId,
    laneId: null,
    type: "feature",
    title: "Assign me",
    descriptionMd: "Body",
    priority: "normal",
    visibility: "organization",
    sensitivity: "normal",
    state: "triage",
    resumeState: null,
    stateReason: null,
    reporter: { type: "user", id: "user_reporter" },
    assignee: null,
    version: 3,
    routingRuleId: null,
    routingPolicyVersion: null,
    createdAt: new Date("2026-10-26T08:00:00.000Z"),
    submittedAt: new Date("2026-10-26T08:00:00.000Z"),
    updatedAt: new Date("2026-10-26T08:00:00.000Z"),
    ...overrides,
  };
}

function harness(
  options: {
    request?: RequestRecord;
    access?: RequestActorAccess;
    members?: string[];
  } = {},
) {
  const request = options.request ?? stored();
  const members = new Set(options.members ?? [memberId]);
  const assigned: Array<{
    assignee: { type: "user"; id: string } | null;
    actor: ActorRef;
    correlationId: string;
    expectedVersion: number;
  }> = [];
  const uow = {
    port: () => ({
      findForUpdate: async () => request,
      actorAccess: async () => options.access ?? maintainer,
      isActiveMember: async (_organizationId: string, userId: string) =>
        members.has(userId),
      assign: async (input: (typeof assigned)[number]) => {
        assigned.push(input);
        return {
          ...request,
          assignee: input.assignee,
          version: input.expectedVersion + 1,
        };
      },
    }),
  } as unknown as UnitOfWork;
  const command = createRequestCommandDefinitions({
    events: new EventFactory(createCoreEventSchemaRegistry()),
  }).find((definition) => definition.name === "assign_request");
  return { assigned, command, uow };
}

function context(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: actorId },
    organizationId,
    scopes: new Set(["request:triage"]),
    credentialId: "session_1",
    correlationId: "8f6b0f2a-0000-4000-8000-0000000000cc",
    ...overrides,
  };
}

async function run(
  h: ReturnType<typeof harness>,
  assigneeUserId: string | null,
  options: {
    context?: AuthorizedCommandContext;
    expectedVersion?: number;
  } = {},
) {
  const input = h.command?.parse({ organizationId, requestId, assigneeUserId });
  const actorContext = options.context ?? context();
  await h.command?.authorize(actorContext, input, h.uow);
  return h.command?.execute(h.uow, actorContext, input, {
    idempotencyKey: "assign-request-key-0001",
    expectedVersion: options.expectedVersion ?? 3,
  });
}

describe("assign_request", () => {
  test("assigns an active member at the next version, with the audit actor and a request.assigned.v1 event", async () => {
    const h = harness();
    expect(h.command, "assign_request must be registered").toBeDefined();
    const execution = await run(h, memberId);
    expect(h.assigned).toEqual([
      {
        requestId,
        organizationId,
        expectedVersion: 3,
        assignee: { type: "user", id: memberId },
        actor: { type: "user", id: actorId },
        correlationId: "8f6b0f2a-0000-4000-8000-0000000000cc",
      },
    ]);
    expect(execution?.result).toEqual({
      id: requestId,
      displayKey: "RP-7",
      state: "triage",
      version: 4,
    });
    expect(execution?.events).toHaveLength(1);
    expect(execution?.events[0]).toMatchObject({
      type: "request.assigned.v1",
      aggregateType: "request",
      aggregateId: requestId,
      aggregateVersion: 4,
      projectId,
      requestId,
      links: { request: "RP-7" },
      data: {
        requestId,
        displayKey: "RP-7",
        state: "triage",
        version: 4,
        assignee: { type: "user", id: memberId },
        previousAssignee: null,
      },
    });
  });

  test("unassigns, naming who it was assigned to before", async () => {
    const h = harness({
      request: stored({ assignee: { type: "user", id: memberId } }),
    });
    const execution = await run(h, null);
    expect(h.assigned[0]?.assignee).toBeNull();
    expect(execution?.events[0]?.data).toMatchObject({
      assignee: null,
      previousAssignee: { type: "user", id: memberId },
    });
  });

  test("admits an owner or an admin who maintains nothing", async () => {
    for (const organizationRole of ["owner", "admin"] as const) {
      const h = harness({
        access: {
          ...maintainer,
          organizationRole,
          projectRole: null,
          explicitTriageGrant: true,
        },
      });
      await expect(run(h, memberId)).resolves.toBeDefined();
    }
  });

  test("refuses a reporter, a contributor and an active worker without triage authority", async () => {
    for (const access of [
      { ...maintainer, projectRole: null, isReporter: true },
      { ...maintainer, projectRole: "contributor" as const },
      { ...maintainer, projectRole: null, isActiveWorker: true },
    ]) {
      const h = harness({ access: { ...access, explicitTriageGrant: false } });
      await expect(run(h, memberId)).rejects.toMatchObject({
        code: "forbidden",
        message: "Target triage authority is required",
      });
      expect(h.assigned).toEqual([]);
    }
  });

  /*
    Ruling 264: REST and MCP reach the command, so an agent may assign where it
    may begin triage — bound to the request's target project, or delegated by
    a person with triage authority — inside its projects and lanes.
  */
  test("admits an agent bound to the target project, and one delegated by a maintainer", async () => {
    const noRole: RequestActorAccess = {
      ...maintainer,
      organizationRole: null,
      projectRole: null,
      explicitTriageGrant: false,
    };
    const target = harness({ access: noRole });
    await run(target, memberId, {
      context: context({
        actor: { type: "agent", id: "agent_1" },
        projectId,
      }),
    });
    expect(target.assigned[0]?.actor).toEqual({ type: "agent", id: "agent_1" });
    const sourceProjectId = "8f6b0f2a-0000-4000-8000-0000000000dd";
    const delegated = harness({
      request: stored({
        source: { kind: "project", projectId: sourceProjectId },
      }),
    });
    await expect(
      run(delegated, memberId, {
        context: context({
          actor: {
            type: "agent",
            id: "agent_2",
            delegatedBy: { type: "user", id: actorId },
          },
          projectId: sourceProjectId,
        }),
      }),
    ).resolves.toBeDefined();
  });

  test("refuses an agent of another project, a target agent outside its lanes, and one from the source project without triage authority", async () => {
    const noRole: RequestActorAccess = {
      ...maintainer,
      organizationRole: null,
      projectRole: null,
      explicitTriageGrant: false,
    };
    const elsewhere = harness();
    await expect(
      run(elsewhere, memberId, {
        context: context({
          actor: { type: "agent", id: "agent_1" },
          projectId: "8f6b0f2a-0000-4000-8000-0000000000ee",
        }),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Agent project access is denied",
    });
    const laneId = "8f6b0f2a-0000-4000-8000-000000000011";
    const outsideLane = harness({ request: stored({ laneId }) });
    await expect(
      run(outsideLane, memberId, {
        context: context({
          actor: { type: "agent", id: "agent_1" },
          projectId,
          laneIds: new Set(["8f6b0f2a-0000-4000-8000-000000000012"]),
        }),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Agent lane access is denied",
    });
    const sourceProjectId = "8f6b0f2a-0000-4000-8000-0000000000dd";
    const fromSource = harness({
      access: noRole,
      request: stored({
        source: { kind: "project", projectId: sourceProjectId },
      }),
    });
    await expect(
      run(fromSource, memberId, {
        context: context({
          actor: { type: "agent", id: "agent_1" },
          projectId: sourceProjectId,
        }),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Target triage authority is required",
    });
    expect(
      [elsewhere, outsideLane, fromSource].flatMap((h) => h.assigned),
    ).toEqual([]);
  });

  test("refuses a service, and a person or an agent without request:triage, before reading the request", async () => {
    const service = harness();
    await expect(
      run(service, memberId, {
        context: context({ actor: { type: "service", id: "worker" } }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const unscoped = harness();
    await expect(
      run(unscoped, memberId, {
        context: context({ scopes: new Set(["request:write"]) }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const unscopedAgent = harness();
    await expect(
      run(unscopedAgent, memberId, {
        context: context({
          actor: { type: "agent", id: "agent_1" },
          projectId,
          scopes: new Set(["request:write"]),
        }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      [service, unscoped, unscopedAgent].flatMap((h) => h.assigned),
    ).toEqual([]);
  });

  test("refuses a stale version, a terminal request, the same assignee and someone who is not an active member", async () => {
    const stale = harness();
    await expect(
      run(stale, memberId, { expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const terminal = harness({ request: stored({ state: "cancelled" }) });
    await expect(run(terminal, memberId)).rejects.toMatchObject({
      code: "invalid_transition",
    });
    const unchanged = harness({
      request: stored({ assignee: { type: "user", id: memberId } }),
    });
    await expect(run(unchanged, memberId)).rejects.toMatchObject({
      code: "conflict",
    });
    const alreadyNobody = harness();
    await expect(run(alreadyNobody, null)).rejects.toMatchObject({
      code: "conflict",
    });
    const outsider = harness();
    await expect(run(outsider, "user_outsider")).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "assigneeUserId" },
    });
    expect(
      [stale, terminal, unchanged, alreadyNobody, outsider].flatMap(
        (h) => h.assigned,
      ),
    ).toEqual([]);
  });
});
