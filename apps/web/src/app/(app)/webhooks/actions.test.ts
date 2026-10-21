import { DomainError } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const webhooks = vi.hoisted(() => ({
  create: vi.fn(),
  rotate: vi.fn(),
  setStatus: vi.fn(),
  verify: vi.fn(),
}));

/**
 * The two guards a webhook mutation is only allowed to run behind. They are
 * spies rather than stubs because *whether they ran* is itself a contract: an
 * owner/admin-only endpoint that answers a malformed submission without ever
 * looking up a session is an unauthenticated oracle, and one that answers
 * without touching the limiter is an unbounded one.
 */
const guards = vi.hoisted(() => ({
  applicationContext: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_SECRET: "test-signing-material" },
}));

vi.mock("@requestport/db", () => {
  const outbox = { createWebhookReplay: vi.fn() };
  const webhooks = { canManage: async () => true };
  return {
    createOutboxRepository: () => outbox,
    createWebhookRepository: () => webhooks,
  };
});

// The web root, whose storage the webhook replay builds its repositories over
// when it runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: guards.enforceRateLimit,
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: guards.applicationContext,
}));

vi.mock("../../../lib/server-core-commands.js", () => ({
  humanCommandContext: () => ({ correlationId: "correlation" }),
}));

vi.mock("../../../lib/server-webhooks.js", () => ({
  webhookManagementService: {
    create: webhooks.create,
    rotate: webhooks.rotate,
    setStatus: webhooks.setStatus,
    verify: webhooks.verify,
  },
}));

vi.mock("../../../lib/trigger-client.js", () => ({
  triggerWebhookDelivery: async () => {},
}));

import { createWebhookAction, setWebhookStatusAction } from "./actions.js";
import { initialWebhookActionState } from "./webhook-action-state.js";

/**
 * Where a rejected webhook submission is allowed to land.
 *
 * The create form draws a field for each value it asks for, so §7 puts a
 * rejection about one of them on that control's own error line. The status
 * toggle draws none — it carries hidden metadata only — so its rejections stay
 * the fixed banner they have always been.
 */

const key = "0123456789abcdef0123";
const organizationId = "00000000-0000-4000-8000-0000000000d1";
const laneIds = [
  "00000000-0000-4000-8000-000000000301",
  "00000000-0000-4000-8000-000000000302",
];

function createForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("idempotencyKey", key);
  data.set("expectedVersion", "0");
  data.set("projectId", "");
  data.set("name", "Release feed");
  data.set("endpointUrl", "https://hooks.example.invalid/requestport");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

beforeEach(() => {
  for (const mock of Object.values(webhooks)) mock.mockReset();
  webhooks.create.mockResolvedValue({ plaintextSecret: "whsec_fixture" });
  webhooks.setStatus.mockResolvedValue(undefined);
  for (const guard of Object.values(guards)) guard.mockReset();
  guards.enforceRateLimit.mockResolvedValue(undefined);
  guards.applicationContext.mockResolvedValue({
    currentOrganization: {
      id: organizationId,
      name: "CUE++",
      role: "owner",
      slug: "example-org",
    },
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  });
});

describe("a webhook submission that never parses", () => {
  test("still costs a session lookup and a limiter increment", async () => {
    const rejected = await createWebhookAction(
      initialWebhookActionState,
      createForm({ name: "" }),
    );

    // Reading the form first made creation answer an unauthenticated caller
    // with a distinguishable, field-addressed rejection — no session lookup, no
    // limiter increment, and nothing to stop them repeating it — on an endpoint
    // only an owner or admin may reach.
    expect(guards.applicationContext).toHaveBeenCalledTimes(1);
    expect(guards.enforceRateLimit).toHaveBeenCalledTimes(1);
    // Authenticating first must not cost the reader the line that tells them
    // which control to change.
    expect(rejected).toMatchObject({ field: "name", status: "error" });
  });

  test("never reaches the service", async () => {
    await createWebhookAction(
      initialWebhookActionState,
      createForm({ endpointUrl: "" }),
    );

    expect(webhooks.create).not.toHaveBeenCalled();
  });
});

describe("a rejected webhook submission", () => {
  test("names the control a schema rejection belongs to", async () => {
    expect(
      await createWebhookAction(
        initialWebhookActionState,
        createForm({ name: "" }),
      ),
    ).toMatchObject({ field: "name", status: "error" });
  });

  test("names the scope control when the project reference is unusable", async () => {
    expect(
      await createWebhookAction(
        initialWebhookActionState,
        createForm({ projectId: "not-a-uuid" }),
      ),
    ).toMatchObject({ field: "projectId", status: "error" });
  });

  test("carries the field a domain rejection already names", async () => {
    webhooks.create.mockRejectedValue(
      new DomainError("validation_failed", "endpoint resolves privately", {
        field: "endpointUrl",
      }),
    );

    expect(
      await createWebhookAction(initialWebhookActionState, createForm()),
    ).toEqual({
      field: "endpointUrl",
      message: "The endpoint or webhook settings were rejected.",
      status: "error",
    });
  });

  test("names no field when the rejection is about the subscription", async () => {
    webhooks.create.mockRejectedValue(
      new DomainError("forbidden", "not a manager"),
    );

    expect(
      await createWebhookAction(initialWebhookActionState, createForm()),
    ).toEqual({
      message: "Only organization owners and admins can manage webhooks.",
      status: "error",
    });
  });

  test("keeps the fixed message for the hidden-metadata status toggle", async () => {
    const data = new FormData();
    data.set("id", "00000000-0000-4000-8000-000000000101");
    data.set("idempotencyKey", key);
    data.set("expectedVersion", "0");
    data.set("status", "disabled");

    expect(
      await setWebhookStatusAction(initialWebhookActionState, data),
    ).toEqual({
      message: "Webhook action failed.",
      status: "error",
    });
  });
});

describe("an accepted webhook submission", () => {
  test("returns the one-time secret with its confirmation", async () => {
    expect(
      await createWebhookAction(initialWebhookActionState, createForm()),
    ).toMatchObject({ plaintextSecret: "whsec_fixture", status: "success" });
  });

  test("hands the service every lane the form chose, not just one", async () => {
    const data = createForm();
    for (const laneId of laneIds) data.append("laneIds", laneId);

    await createWebhookAction(initialWebhookActionState, data);

    // A lane filter is a set: reading one value out of a repeated field would
    // silently narrow the subscription to whichever lane happened to be first,
    // and nothing downstream could tell that from a deliberate choice.
    expect(webhooks.create).toHaveBeenCalledTimes(1);
    expect(webhooks.create.mock.calls[0]?.[1]).toEqual({
      endpointUrl: "https://hooks.example.invalid/requestport",
      eventTypes: [],
      laneIds,
      name: "Release feed",
      organizationId,
      projectId: null,
      projectIds: [],
      requestTypes: [],
    });
    expect(webhooks.create.mock.calls[0]?.[2]).toEqual({
      expectedVersion: 0,
      idempotencyKey: key,
    });
  });
});
