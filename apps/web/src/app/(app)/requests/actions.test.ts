import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * What a rejected submission actually says, and about which field.
 *
 * Section 7 of the reskin specification sends a server-side field failure to
 * that field's own error line. A line that reads the same eight words for a
 * malformed UUID and for a sensitivity rule tells the reader nothing about
 * which value to change, so the schema's own message travels with the field
 * name. That is the one server-visible decision this migration made, and it is
 * only observable from the action: the form helpers see a `RequestActionState`
 * that someone else built. This suite drives the real actions with real
 * `FormData` and reads the state they return.
 *
 * Everything the actions reach for *after* validation is replaced, because a
 * rejected submission must never get that far — the command bus standing
 * unused is part of the assertion, not scaffolding.
 *
 * The session and the limiter come *before* it, though. A field-addressed
 * rejection is what an authorized reader is owed, so this suite hands every
 * action the organization membership a real submission always carries; what an
 * anonymous caller gets instead is the ordering contract's own subject and is
 * pinned next to the actions in `action-authorization.test.ts`.
 */

const server = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(async () => {}),
  execute: vi.fn(),
  getApplicationContext: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_SECRET: "unit-test-signing-material" },
}));

/**
 * The database the route preview's evaluation helper opens, faked at the
 * package boundary so the helper and the domain's evaluation entry run for
 * real. Each factory records the transaction it was built on.
 */
const database = vi.hoisted(() => {
  const tx = { name: "the preview's transaction" };
  return {
    tx,
    builtOn: [] as unknown[],
    assertCurrent: vi.fn(),
    findActiveOrganizationForUser: vi.fn(),
    listOrganizationProjects: vi.fn(),
    listRulesForMember: vi.fn(),
    withTransaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
  };
});

vi.mock("@requestport/db", () => ({
  createCommandAuthorizationRepository: (tx: unknown) => {
    database.builtOn.push(tx);
    return { assertCurrent: database.assertCurrent };
  },
  createFoundationQueryRepository: (tx: unknown) => {
    database.builtOn.push(tx);
    return {
      findActiveOrganizationForUser: database.findActiveOrganizationForUser,
      listOrganizationProjects: database.listOrganizationProjects,
    };
  },
  createRoutingRepository: (tx: unknown) => {
    database.builtOn.push(tx);
    return { listRulesForMember: database.listRulesForMember };
  },
  createRequestQueryRepository: () => ({}),
}));

/*
 * The helper opens its transaction on the web root's storage (Plan 13, G.2).
 * So the root hands back the fake above, `database.withTransaction`, as that
 * storage's `transaction`, and the cases count it as they always did.
 */
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ transaction: database.withTransaction }),
}));

vi.mock("next/cache", () => ({ revalidatePath: server.revalidatePath }));

// The real module, with only `redirect` replaced: the route preview's catch
// calls `unstable_rethrow` first, as every action here does.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: server.redirect,
}));

vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: server.enforceRateLimit,
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: server.getApplicationContext,
}));

vi.mock("../../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: server.execute },
  humanCommandContext: (
    session: { user: { id: string }; session: { id: string } },
    organizationId: string,
  ) => ({
    actor: { type: "user", id: session.user.id },
    organizationId,
    scopes: new Set(["request:create"]),
    credentialId: session.session.id,
    correlationId: "00000000-0000-4000-8000-0000000000cc",
  }),
}));

import { DomainError } from "@requestport/domain";
import {
  answerQuestionAction,
  createRequestAction,
  previewRequestRouteAction,
  updateRequestAction,
} from "./actions.js";
import {
  initialRequestActionState,
  requestFixedValidationMessage,
} from "./request-action-state.js";

const idempotencyKey = "requests-action-suite-key-0001";
const questionId = "00000000-0000-4000-8000-000000000201";
const requestId = "00000000-0000-4000-8000-000000000101";
const targetProjectId = "00000000-0000-4000-8000-0000000000c1";

function formData(entries: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}

/** A create submission every rule accepts, before one value is spoiled. */
function createForm(overrides: Record<string, string> = {}) {
  return formData({
    acceptanceCriteria: "",
    descriptionMd: "The console is native.",
    idempotencyKey,
    intent: "draft",
    labels: "",
    priority: "normal",
    sensitivity: "normal",
    sourceProjectId: "",
    targetProjectId,
    title: "Reskin the console",
    type: "feature",
    visibility: "organization",
    ...overrides,
  });
}

/** An edit submission every rule accepts, before one value is spoiled. */
function updateForm(overrides: Record<string, string> = {}) {
  return formData({
    descriptionMd: "The console is native.",
    expectedVersion: "4",
    idempotencyKey,
    priority: "normal",
    requestId,
    sensitivity: "normal",
    title: "Reskin the console",
    visibility: "organization",
    ...overrides,
  });
}

const organization = {
  id: "00000000-0000-4000-8000-0000000000d1",
  name: "CUE++",
  role: "owner",
  slug: "example-org",
};
const memberUserId = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  for (const mock of Object.values(server)) mock.mockClear();
  server.enforceRateLimit.mockImplementation(async () => {});
  server.getApplicationContext.mockResolvedValue({
    currentOrganization: organization,
    session: {
      user: { id: memberUserId },
      session: { id: "session-requests-suite" },
    },
  });
  database.builtOn.length = 0;
  for (const spy of [
    database.assertCurrent,
    database.findActiveOrganizationForUser,
    database.listOrganizationProjects,
    database.listRulesForMember,
  ])
    spy.mockReset();
  database.withTransaction.mockClear();
  database.assertCurrent.mockResolvedValue(undefined);
  database.findActiveOrganizationForUser.mockResolvedValue({
    ...organization,
    role: "member",
  });
  database.listOrganizationProjects.mockResolvedValue([]);
  database.listRulesForMember.mockResolvedValue([]);
});

describe("rejecting a request submission", () => {
  test("answers a blank title with the rule that rejected it", async () => {
    const state = await createRequestAction(
      initialRequestActionState,
      createForm({ title: "   " }),
    );

    expect(state).toEqual({
      code: "validation_failed",
      field: "title",
      message: "Too small: expected string to have >=1 characters",
      status: "error",
    });
    expect(state).not.toMatchObject({
      message: requestFixedValidationMessage,
    });
    expect(server.execute).not.toHaveBeenCalled();
    expect(server.redirect).not.toHaveBeenCalled();
    expect(server.revalidatePath).not.toHaveBeenCalled();
  });

  test("measures a title in UTF-16 code units, as zod 4.4.3 did: 121 emoji, 242 units, are over the 240", async () => {
    const state = await createRequestAction(
      initialRequestActionState,
      createForm({ title: "\u{1F600}".repeat(121) }),
    );

    expect(state).toEqual({
      code: "validation_failed",
      field: "title",
      message: "Too big: expected string to have <=240 characters",
      status: "error",
    });
    expect(server.execute).not.toHaveBeenCalled();
  });

  test("puts a cross-field rule on the field its schema names", async () => {
    // `sensitivity` is the value the reader changed; `visibility` is the one
    // the rule is about. Only the schema knows that, so only the schema's own
    // message can say it.
    const state = await updateRequestAction(
      initialRequestActionState,
      updateForm({ sensitivity: "sensitive", visibility: "organization" }),
    );

    expect(state).toEqual({
      code: "validation_failed",
      field: "visibility",
      message: "Sensitive requests must use restricted visibility",
      status: "error",
    });
    expect(server.execute).not.toHaveBeenCalled();
  });

  test("tells an empty answer which of its two inputs is missing", async () => {
    const state = await answerQuestionAction(
      initialRequestActionState,
      formData({
        bodyMd: "",
        expectedVersion: "3",
        idempotencyKey,
        questionId,
      }),
    );

    expect(state).toEqual({
      code: "validation_failed",
      field: "bodyMd",
      message: "An answer is required",
      status: "error",
    });
    expect(server.execute).not.toHaveBeenCalled();
  });
});

/**
 * The route preview reaches the one route evaluation entry the routing tester
 * also reaches (Plan 13, F.2.1), through `server-routing-actions.ts`, and
 * answers in the shape it always has.
 */
describe("previewing a route", () => {
  const sourceProjectId = "00000000-0000-4000-8000-0000000000c2";
  const ruleId = "00000000-0000-4000-8000-0000000000b1";

  function preview(overrides: Record<string, string> = {}) {
    return previewRequestRouteAction({
      sourceProjectId: "",
      targetProjectId,
      type: "feature",
      priority: "normal",
      ...overrides,
    });
  }

  function rule(overrides: Record<string, unknown> = {}) {
    return {
      id: ruleId,
      organizationId: organization.id,
      sourceKind: "human_direct",
      targetProjectId,
      decision: "deny",
      requestTypes: [],
      laneIds: [],
      priorities: [],
      humanRoles: [],
      agentPrincipalIds: [],
      specificity: 1_000,
      enabled: true,
      version: 5,
      ...overrides,
    };
  }

  test("re-checks the credential, then evaluates for the member, on one transaction", async () => {
    database.listRulesForMember.mockResolvedValue([
      rule({ humanRoles: ["member"], specificity: 1_099 }),
    ]);

    expect(await preview()).toEqual({
      status: "denied",
      reason: "matched_deny",
      policyVersion: 5,
      matchedRuleId: ruleId,
    });
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    expect(database.builtOn).toEqual([database.tx, database.tx, database.tx]);
    expect(database.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: "user", id: memberUserId },
        organizationId: organization.id,
        credentialId: "session-requests-suite",
      }),
    );
    expect(database.listRulesForMember).toHaveBeenCalledWith(
      memberUserId,
      organization.id,
    );
  });

  test("answers an unmatched route as allowed, with no rule", async () => {
    expect(await preview()).toEqual({
      status: "allowed",
      reason: "default_same_org",
      policyVersion: 0,
      matchedRuleId: null,
    });
  });

  test("denies a source project the member cannot represent as it always has, reading no rule", async () => {
    database.listOrganizationProjects.mockResolvedValue([
      {
        id: sourceProjectId,
        name: "Source",
        slug: "source",
        keyPrefix: "SRC",
        status: "active",
        canRepresent: false,
        defaultRepository: null,
      },
    ]);

    expect(await preview({ sourceProjectId })).toEqual({
      status: "denied",
      reason: "no_matching_permission",
      policyVersion: 0,
      matchedRuleId: null,
    });
    expect(database.listOrganizationProjects).toHaveBeenCalledWith(
      memberUserId,
      organization.id,
    );
    expect(database.listRulesForMember).not.toHaveBeenCalled();
  });

  test("evaluates a source project the member can represent", async () => {
    database.listOrganizationProjects.mockResolvedValue([
      {
        id: sourceProjectId,
        name: "Source",
        slug: "source",
        keyPrefix: "SRC",
        status: "active",
        canRepresent: true,
        defaultRepository: null,
      },
    ]);
    database.listRulesForMember.mockResolvedValue([
      rule({
        sourceKind: "project",
        sourceProjectId,
        decision: "allow",
        specificity: 1_099,
      }),
    ]);

    expect(await preview({ sourceProjectId })).toEqual({
      status: "allowed",
      reason: "matched_allow",
      policyVersion: 5,
      matchedRuleId: ruleId,
    });
  });

  test("is unavailable to a member the entry refuses", async () => {
    database.findActiveOrganizationForUser.mockResolvedValue(null);
    expect(await preview()).toEqual({ status: "unavailable" });

    database.findActiveOrganizationForUser.mockResolvedValue(organization);
    database.assertCurrent.mockRejectedValue(
      new DomainError(
        "forbidden",
        "Current human authorization is no longer active",
      ),
    );
    expect(await preview()).toEqual({ status: "unavailable" });
  });

  test("answers a malformed preview as invalid, opening nothing", async () => {
    expect(await preview({ targetProjectId: "not-a-uuid" })).toEqual({
      status: "invalid",
    });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  test("answers the limiter's refusal as rate limited, opening nothing", async () => {
    server.enforceRateLimit.mockImplementation(async () => {
      throw new DomainError("rate_limited", "Slow down");
    });
    expect(await preview()).toEqual({ status: "rate_limited" });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});
