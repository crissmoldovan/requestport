import { describe, expect, test } from "vitest";

import type { ActorRef, AuthorizedCommandContext } from "./authorization.js";
import {
  actorFingerprint,
  assertAuthenticatedUserContext,
  requireHumanActor,
  requireOrganization,
} from "./authorization.js";

const userId = "user_01JQ0000000000000000000005";
const organizationId = "8f6b0f2a-0000-4000-8000-00000000000a";

describe("authenticated-user command context", () => {
  test("accepts a session-only human context", () => {
    const context = {
      actor: { type: "user", id: userId },
      credentialId: "session_1",
      correlationId: "correlation-1",
    };

    expect(() => assertAuthenticatedUserContext(context)).not.toThrow();
  });

  test("rejects an organization-bearing context so a tenant is never implied", () => {
    expect(() =>
      assertAuthenticatedUserContext({
        actor: { type: "user", id: userId },
        credentialId: "session_1",
        correlationId: "correlation-1",
        organizationId,
      }),
    ).toThrow(/Authenticated user command context is invalid/u);
  });

  test.each([
    [{ type: "agent", id: "agent_1" }],
    [{ type: "service", id: "requestport-appearance-default-initializer" }],
  ] as Array<[ActorRef]>)("rejects the %o actor", (actor) => {
    expect(() =>
      assertAuthenticatedUserContext({
        actor,
        credentialId: "session_1",
        correlationId: "correlation-1",
      }),
    ).toThrow();
  });

  test.each([
    [{ credentialId: "session_1", correlationId: "correlation-1" }],
    [
      {
        actor: { type: "user", id: "" },
        credentialId: "session_1",
        correlationId: "correlation-1",
      },
    ],
    [{ actor: { type: "user", id: userId }, correlationId: "correlation-1" }],
    [{ actor: { type: "user", id: userId }, credentialId: "session_1" }],
    ["not-a-context"],
    [null],
  ])("rejects the malformed context %#", (context) => {
    expect(() => assertAuthenticatedUserContext(context)).toThrow();
  });
});

describe("human-only tenant authorization", () => {
  test("passes a user actor and denies every machine actor", () => {
    const base: AuthorizedCommandContext = {
      actor: { type: "user", id: userId },
      organizationId,
      scopes: new Set<string>(),
      credentialId: "session_1",
      correlationId: "correlation-1",
    };

    expect(() =>
      requireHumanActor(
        base,
        "Organization appearance defaults require a human actor",
      ),
    ).not.toThrow();
    for (const actor of [
      { type: "agent", id: "agent_1" },
      {
        type: "agent",
        id: "agent_1",
        delegatedBy: { type: "user", id: userId },
      },
      { type: "service", id: "service_1" },
    ] as ActorRef[]) {
      expect(() =>
        requireHumanActor(
          { ...base, actor },
          "Organization appearance defaults require a human actor",
        ),
      ).toThrow(/Organization appearance defaults require a human actor/u);
    }
  });

  test("keeps the existing organization binding and actor fingerprints", () => {
    const context: AuthorizedCommandContext = {
      actor: { type: "user", id: userId },
      organizationId,
      scopes: new Set<string>(),
      credentialId: "session_1",
      correlationId: "correlation-1",
    };

    expect(() => requireOrganization(context, organizationId)).not.toThrow();
    expect(() =>
      requireOrganization(context, "8f6b0f2a-0000-4000-8000-00000000000b"),
    ).toThrow(/Organization access is denied/u);
    expect(actorFingerprint(context.actor)).toBe(`user:${userId}`);
  });
});
