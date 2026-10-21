import { describe, expect, test } from "vitest";

import { createCoreEventSchemaRegistry } from "../core/core-commands.js";
import { EventFactory } from "../events/event-factory.js";
import type { AuthorizedCommandContext } from "../shared/authorization.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import { createRequestCommandDefinitions } from "./request-commands.js";

const organizationId = "8f6b0f2a-0000-4000-8000-0000000000ff";
const projectId = "8f6b0f2a-0000-4000-8000-0000000000aa";
const requestId = "8f6b0f2a-0000-4000-8000-0000000000bb";
const userId = "user_01JQ0000000000000000000009";

/**
 * The request the repository hands back, with every field the event payloads
 * read. Nothing here is asserted; it exists so the payload can be built at all.
 */
const storedRequest = {
  id: requestId,
  organizationId,
  displayKey: "RP-1",
  state: "draft",
  version: 1,
  title: "A request that should be creatable",
  descriptionMd: "Body",
  type: "feature",
  priority: "normal",
  visibility: "organization",
  sensitivity: "normal",
  targetProjectId: projectId,
  source: { kind: "project", projectId },
};

const submittedRequest = { ...storedRequest, state: "submitted", version: 2 };

function unitOfWork(): UnitOfWork {
  return {
    port: (name: string) =>
      name === "routing"
        ? { listRules: async () => [] }
        : {
            validateDraftOwnership: async () => true,
            createDraft: async () => storedRequest,
            findForUpdate: async () => storedRequest,
            actorAccess: async () => ({
              organizationRole: "owner",
              projectRole: "maintainer",
              isReporter: true,
            }),
            allocateDisplayKey: async () => ({
              displayKey: "RP-1",
              sequence: 1,
            }),
            transition: async () => submittedRequest,
            insertStateTransition: async () => undefined,
            hasAcceptanceCriteria: async () => true,
          },
  } as unknown as UnitOfWork;
}

function context(): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["request:create"]),
    credentialId: "session_1",
    correlationId: "8f6b0f2a-0000-4000-8000-0000000000cc",
  };
}

describe("request events", () => {
  /**
   * That a request can be created at all.
   *
   * The event payloads are validated against the schemas registered for them,
   * and `actorEventSchema` names the request `requestId`. Two payloads were
   * built by spreading `requestResult`, which is the *command's* answer and
   * names the same value `id` — so `request.created.v1` failed its own schema
   * and every attempt to create a request was refused with "Event payload is
   * invalid", for agents and for people alike.
   *
   * Nothing caught it because every other test of these commands supplies a
   * stub event factory, and a stub has no schemas to fail. This one uses the
   * real registry, which is the only arrangement in which this can fail.
   */
  test("builds a valid payload when a draft is created", async () => {
    const definitions = createRequestCommandDefinitions({
      events: new EventFactory(createCoreEventSchemaRegistry()),
      createId: () => requestId,
    });
    const draft = definitions.find(
      (definition) => definition.name === "create_request_draft",
    );
    expect(draft, "create_request_draft must be registered").toBeTruthy();

    const input = draft?.parse({
      organizationId,
      sourceKind: "project",
      sourceProjectId: projectId,
      targetProjectId: projectId,
      type: "feature",
      title: "A request that should be creatable",
      descriptionMd: "Body",
    });

    const execution = await draft?.execute(unitOfWork(), context(), input, {
      idempotencyKey: "request-events-key-one",
      expectedVersion: 0,
    });

    expect(
      execution?.events,
      "creating a draft must emit its event",
    ).toHaveLength(1);
    expect(execution?.events?.[0]?.data).toMatchObject({ requestId });
  });
  /**
   * The same fault, on every transition.
   *
   * `submit_request` and its siblings build four payload shapes and all four
   * spread the command's answer, so the whole lifecycle was unreachable behind
   * the creation that was already unreachable. Submitting is the one worth
   * pinning: it is the step the product exists to perform.
   */
  test("builds a valid payload when a draft is submitted", async () => {
    const definitions = createRequestCommandDefinitions({
      events: new EventFactory(createCoreEventSchemaRegistry()),
      createId: () => requestId,
    });
    const transition = definitions.find(
      (definition) => definition.name === "transition_request",
    );
    expect(transition, "transition_request must be registered").toBeTruthy();

    const input = transition?.parse({
      organizationId,
      requestId,
      action: "submit_request",
    });

    const execution = await transition?.execute(
      unitOfWork(),
      context(),
      input,
      { idempotencyKey: "request-events-key-two", expectedVersion: 1 },
    );

    expect(
      execution?.events?.[0]?.data,
      "submitting must emit an event the schema accepts",
    ).toMatchObject({ requestId });
  });
});
