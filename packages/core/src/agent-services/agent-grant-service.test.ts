import type { AuthorizedCommandContext } from "@requestport/domain";
import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  type AgentGrantRepository,
  createAgentGrantService,
} from "./agent-grant-service.js";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";

type GrantDependencies = Parameters<typeof createAgentGrantService>[0];
type ConsentBinding = Parameters<
  GrantDependencies["authRepository"]["bindOAuthConsent"]
>[0];
type ManagementCheck = Parameters<
  GrantDependencies["agentRepository"]["canManage"]
>[0];

type Authorization = {
  assertCurrent(context: AuthorizedCommandContext): Promise<void>;
};

/**
 * The service over stand-in repositories, each recording in `calls` what it
 * was asked. `authorization` is the bus's re-check: by default one that
 * admits and records each context it is asked about in `rechecked`;
 * `"absent"` composes the service without one.
 */
function harness(
  options: {
    authorization?: Authorization | "absent";
    canManage?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const rechecked: AuthorizedCommandContext[] = [];
  const bindings: ConsentBinding[] = [];
  const managementChecks: ManagementCheck[] = [];
  const admitting: Authorization = {
    async assertCurrent(context) {
      calls.push("assertCurrent");
      rechecked.push(context);
    },
  };
  const authorization =
    options.authorization === "absent"
      ? undefined
      : (options.authorization ?? admitting);
  const service = createAgentGrantService({
    ...(authorization ? { authorization } : {}),
    authRepository: {
      async bindOAuthConsent(input) {
        calls.push("bindOAuthConsent");
        bindings.push(input);
        return { id: GRANT };
      },
      async revokeOAuthGrant() {
        return { id: GRANT, revoked: true, version: 2 };
      },
    } satisfies AgentGrantRepository,
    agentRepository: {
      async canManage(input) {
        calls.push("canManage");
        managementChecks.push(input);
        return options.canManage ?? true;
      },
    },
    fingerprintSecret: "test-fingerprint-secret",
  });
  return { bindings, calls, managementChecks, rechecked, service };
}

function context(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: "user_1" },
    correlationId: "correlation_1",
    credentialId: "session_1",
    organizationId: ORGANIZATION,
    scopes: new Set(["agent:manage"]),
    ...overrides,
  };
}

function consent(overrides: Record<string, unknown> = {}) {
  return {
    agentPrincipalId: PRINCIPAL,
    audience: "mcp",
    clientId: "requestport-cli",
    expectedVersion: 0,
    idempotencyKey: "idempotency-key-0001",
    laneIds: [],
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    scopes: ["work:claim"],
    ...overrides,
  };
}

/**
 * A refusal must arrive as a `DomainError` rather than as a schema failure,
 * because the API surface turns a `DomainError` into an explanation the person
 * at the consent screen can act on.
 */
async function refusal(action: Promise<unknown>) {
  const thrown = await action.then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(DomainError);
  return thrown as DomainError;
}

describe("binding an agent OAuth consent", () => {
  test("refuses a provisioning grant that carries any other scope", async () => {
    const { bindings, service } = harness();

    const error = await refusal(
      service.bindConsent(
        context(),
        consent({
          projectId: undefined,
          scopes: ["work:claim", "project:provision", "request:read"],
        }),
      ),
    );

    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("request:read");
    expect(error.message).toContain("work:claim");
    expect(bindings).toEqual([]);
  });

  test("refuses a provisioning grant that names a project", async () => {
    const { bindings, service } = harness();

    const error = await refusal(
      service.bindConsent(
        context(),
        consent({ projectId: PROJECT, scopes: ["project:provision"] }),
      ),
    );

    expect(error.code).toBe("validation_failed");
    expect(bindings).toEqual([]);
  });

  test("still refuses an ordinary grant that names no project", async () => {
    const { bindings, service } = harness();

    const error = await refusal(
      service.bindConsent(
        context(),
        consent({ projectId: undefined, scopes: ["work:claim"] }),
      ),
    );

    expect(error.code).toBe("validation_failed");
    expect(bindings).toEqual([]);
  });

  test("refuses a provisioning grant from a human who is not an owner or admin", async () => {
    const { bindings, managementChecks, service } = harness({
      canManage: false,
    });

    const error = await refusal(
      service.bindConsent(
        context(),
        consent({ projectId: undefined, scopes: ["project:provision"] }),
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(bindings).toEqual([]);
    // A null project is what asks the repository for organization standing
    // rather than the maintainer standing an ordinary project grant accepts.
    expect(managementChecks).toEqual([
      {
        actor: { type: "user", id: "user_1" },
        organizationId: ORGANIZATION,
        projectId: null,
      },
    ]);
  });

  test("binds a provisioning grant for an owner, naming no project", async () => {
    const { bindings, service } = harness({ canManage: true });

    await expect(
      service.bindConsent(
        context(),
        consent({ projectId: undefined, scopes: ["project:provision"] }),
      ),
    ).resolves.toEqual({ grantId: GRANT });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.projectId).toBeNull();
    expect(bindings[0]?.scopes).toEqual(["project:provision"]);
  });

  test("leaves an ordinary grant to the maintainer standing it already accepts", async () => {
    const { bindings, managementChecks, service } = harness({
      canManage: false,
    });

    await expect(
      service.bindConsent(
        context(),
        consent({ projectId: PROJECT, scopes: ["work:claim"] }),
      ),
    ).resolves.toEqual({ grantId: GRANT });

    expect(bindings[0]?.projectId).toBe(PROJECT);
    // The owner-or-admin check belongs to provisioning alone; asking it here
    // would lock every project maintainer out of consenting to their own agent.
    expect(managementChecks).toEqual([]);
  });

  test("refuses a scope the server does not define", async () => {
    const { bindings, service } = harness();

    const error = await refusal(
      service.bindConsent(context(), consent({ scopes: ["project:invent"] })),
    );

    expect(error.code).toBe("validation_failed");
    expect(bindings).toEqual([]);
  });

  // Plan 13, F.2.2: `agent:revoke` is an operator credential's alone, and a
  // grant's scopes must be agent scopes, which do not name it.
  test("refuses agent:revoke, the operator's reduce-only scope, alone or beside a working scope", async () => {
    const { bindings, service } = harness();

    for (const scopes of [["agent:revoke"], ["work:claim", "agent:revoke"]]) {
      const error = await refusal(
        service.bindConsent(context(), consent({ scopes })),
      );
      expect(error.code, scopes.join()).toBe("validation_failed");
    }
    expect(bindings).toEqual([]);
  });
});

describe("a person's consent binding, re-checked first by the authorization the service is composed with (ruling 233 item 2)", () => {
  test("bindConsent refuses a person's context that the re-check (authorization.assertCurrent) refuses, with that refusal, before the role or the binding is read", async () => {
    const refused = new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );
    const { calls, service } = harness({
      authorization: {
        async assertCurrent() {
          throw refused;
        },
      },
    });

    await expect(
      service.bindConsent(
        context(),
        consent({ scopes: ["project:provision"], projectId: null }),
      ),
    ).rejects.toBe(refused);
    await expect(service.bindConsent(context(), consent())).rejects.toBe(
      refused,
    );
    expect(calls).toEqual([]);
  });

  test("bindConsent re-checks a person's context first, then the role where it checks one, then binds", async () => {
    const { calls, rechecked, service } = harness();
    const person = context();

    await service.bindConsent(person, consent());
    await service.bindConsent(
      person,
      consent({ scopes: ["project:provision"], projectId: null }),
    );

    expect(rechecked).toEqual([person, person]);
    expect(rechecked[0]).toBe(person);
    expect(calls).toEqual([
      "assertCurrent",
      "bindOAuthConsent",
      "assertCurrent",
      "canManage",
      "bindOAuthConsent",
    ]);
  });

  test("bindConsent hands the person's credentialId to bindOAuthConsent, whose transaction reads it again with the membership before anything is written (ruling 234 (c))", async () => {
    const { bindings, service } = harness();

    await service.bindConsent(context(), consent());
    await service.bindConsent(
      context(),
      consent({ scopes: ["project:provision"], projectId: null }),
    );

    expect(bindings).toEqual([
      expect.objectContaining({
        userId: "user_1",
        personCredentialId: "session_1",
      }),
      expect.objectContaining({
        userId: "user_1",
        personCredentialId: "session_1",
      }),
    ]);
  });

  test("a person the re-check admits who is not an owner or admin is refused a provisioning consent by the role check, in its words", async () => {
    const { calls, service } = harness({ canManage: false });

    const error = await refusal(
      service.bindConsent(
        context(),
        consent({ scopes: ["project:provision"], projectId: null }),
      ),
    );

    expect(error.message).toBe(
      "Provisioning consent requires an active organization owner or admin",
    );
    expect(calls).toEqual(["assertCurrent", "canManage"]);
  });

  test("composed without the re-check, bindConsent refuses a person's context as a configuration error, before anything is read", async () => {
    const { calls, service } = harness({ authorization: "absent" });

    const error = await refusal(service.bindConsent(context(), consent()));

    expect(error.code).toBe("configuration_error");
    expect(calls).toEqual([]);
  });

  test("an agent's context is not re-checked here: bindConsent refuses it as before, for a human user is required", async () => {
    const { calls, service } = harness({
      authorization: {
        async assertCurrent() {
          throw new Error("an agent's context was re-checked");
        },
      },
    });

    const error = await refusal(
      service.bindConsent(
        context({ actor: { type: "agent", id: PRINCIPAL } }),
        consent(),
      ),
    );

    expect(error.message).toBe("A human user is required");
    expect(calls).toEqual([]);
  });
});

describe("a consent's strings, measured as zod 4.4.3 measured them, in UTF-16 code units", () => {
  const emoji = "\u{1F600}";

  test("an idempotency key of eight emoji, sixteen units, binds", async () => {
    const { bindings, service } = harness();

    await expect(
      service.bindConsent(
        context(),
        consent({ idempotencyKey: emoji.repeat(8) }),
      ),
    ).resolves.toEqual({ grantId: GRANT });
    expect(bindings).toHaveLength(1);
  });

  test("a client id of 128 emoji, 256 units, is over its 255 and binds nothing", async () => {
    const { bindings, service } = harness();

    await expect(
      service.bindConsent(context(), consent({ clientId: emoji.repeat(128) })),
    ).rejects.toThrow(/Too big: expected string to have <=255 characters/);
    expect(bindings).toEqual([]);
  });
});
