import {
  createCoreCommandRegistry,
  DomainError,
  slackAdministrationCommandInputSchemas,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const slack = vi.hoisted(() => ({
  execute: vi.fn(),
  queueSlackConnectionTest: vi.fn(),
  humanCommandContext: vi.fn(),
  commandContext: {
    actor: { type: "user", id: "00000000-0000-4000-8000-0000000000aa" },
    organizationId: "00000000-0000-4000-8000-0000000000d1",
    credentialId: "session-under-test",
    correlationId: "correlation-under-test",
    scopes: new Set(["slack:manage"]),
  },
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  },
  session: {
    user: { id: "00000000-0000-4000-8000-0000000000aa" },
    session: { id: "session-under-test" },
  },
}));

vi.mock("../../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: slack.execute },
  humanCommandContext: slack.humanCommandContext,
}));

vi.mock("../../../lib/server-slack-actions.js", () => ({
  queueSlackConnectionTest: slack.queueSlackConnectionTest,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: slack.organization,
    session: slack.session,
  }),
}));

import {
  mapSlackUserAction,
  sendSlackConnectionTestAction,
  setSlackInstallationStatusAction,
  setSlackRouteAction,
} from "./actions.js";
import { initialSlackActionState } from "./slack-action-state.js";

/**
 * Where a rejected Slack submission is allowed to land.
 *
 * Every Slack form draws a field for each value it asks for, so §7 puts a
 * rejection about one of them on that control's own error line. The
 * installation status control draws none, so its rejections stay the fixed
 * banner.
 */

const key = "0123456789abcdef0123";
const installationId = "00000000-0000-4000-8000-000000000201";
const projectId = "00000000-0000-4000-8000-0000000000c1";
const memberId = "00000000-0000-4000-8000-0000000000a1";
const operationId = "00000000-0000-4000-8000-000000000301";

function mappingForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("installationId", installationId);
  data.set("userId", memberId);
  data.set("slackUserId", "U012ABCDEF");
  data.set("idempotencyKey", key);
  data.set("expectedVersion", "0");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

function routeForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("projectId", "");
  data.set("mode", "channel");
  data.set("channelId", "C012ABCDEF");
  data.set("fallback", "email");
  data.set("idempotencyKey", key);
  data.set("expectedVersion", "0");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

function testForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("installationId", installationId);
  data.set("channelId", "C012ABCDEF");
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

beforeEach(() => {
  slack.execute.mockReset();
  slack.execute.mockResolvedValue({ id: "row", version: 1 });
  slack.humanCommandContext.mockReset();
  slack.humanCommandContext.mockReturnValue(slack.commandContext);
  slack.queueSlackConnectionTest.mockReset();
  slack.queueSlackConnectionTest.mockResolvedValue({
    operationId,
    dispatched: true,
  });
});

describe("a rejected Slack submission", () => {
  test("names the control a rejected Slack member ID belongs to", async () => {
    expect(
      await mapSlackUserAction(
        initialSlackActionState,
        mappingForm({ slackUserId: "nope" }),
      ),
    ).toMatchObject({ field: "slackUserId", status: "error" });
    expect(slack.execute).not.toHaveBeenCalled();
  });

  test("names the delivery control when the mode is not one of the three", async () => {
    expect(
      await setSlackRouteAction(
        initialSlackActionState,
        routeForm({ mode: "carrier-pigeon" }),
      ),
    ).toMatchObject({ field: "mode", status: "error" });
    expect(slack.execute).not.toHaveBeenCalled();
  });

  test("names no field when the whole surface is denied", async () => {
    slack.execute.mockRejectedValue(
      new DomainError("forbidden", "not a manager"),
    );

    expect(
      await mapSlackUserAction(initialSlackActionState, mappingForm()),
    ).toEqual({
      message: "Only organization owners and admins can manage Slack.",
      status: "error",
    });
  });

  test("keeps the fixed message for the hidden-metadata status control", async () => {
    const data = new FormData();
    data.set("installationId", installationId);
    data.set("expectedVersion", "0");
    data.set("idempotencyKey", key);
    data.set("status", "revoked");

    expect(
      await setSlackInstallationStatusAction(initialSlackActionState, data),
    ).toEqual({
      message: "The Slack settings could not be updated.",
      status: "error",
    });
    expect(slack.execute).not.toHaveBeenCalled();
  });
});

/*
  Plan 13, F.2.5: each Slack form reaches the handler the transport will
  reach. Three forms run one command each on the tenant bus, by name, with the
  signed-in person's command context, the organisation from the session, the
  fields from the form, and the version and key as the bus's meta. The
  connection test calls its off-bus handler with the same three.
*/
const actions = {
  mapSlackUserAction,
  setSlackRouteAction,
  setSlackInstallationStatusAction,
};

const cases: Array<{
  label: string;
  action: keyof typeof actions;
  command: keyof typeof slackAdministrationCommandInputSchemas;
  form: FormData;
  input: Record<string, unknown>;
  meta: { expectedVersion: number; idempotencyKey: string };
  message: string;
}> = [
  {
    label: "the mapping form",
    action: "mapSlackUserAction",
    command: "set_slack_user_mapping",
    form: mappingForm({ slackUserId: " U012ABCDEF ", expectedVersion: "3" }),
    input: { installationId, userId: memberId, slackUserId: "U012ABCDEF" },
    meta: { expectedVersion: 3, idempotencyKey: key },
    message: "Slack user mapping saved.",
  },
  {
    label: "the route form, for the organisation and by DM",
    action: "setSlackRouteAction",
    command: "set_slack_route",
    form: routeForm({ mode: "dm", channelId: "" }),
    input: { projectId: null, mode: "dm", channelId: null, fallback: "email" },
    meta: { expectedVersion: 0, idempotencyKey: key },
    message: "Slack delivery route saved.",
  },
  {
    label: "the route form, for a project and in a channel",
    action: "setSlackRouteAction",
    command: "set_slack_route",
    form: routeForm({
      projectId,
      channelId: " C012ABCDEF ",
      fallback: "none",
      expectedVersion: "2",
    }),
    input: {
      projectId,
      mode: "channel",
      channelId: "C012ABCDEF",
      fallback: "none",
    },
    meta: { expectedVersion: 2, idempotencyKey: key },
    message: "Slack delivery route saved.",
  },
  {
    label: "the installation status control",
    action: "setSlackInstallationStatusAction",
    command: "set_slack_installation_status",
    form: (() => {
      const data = new FormData();
      data.set("installationId", installationId);
      data.set("expectedVersion", "4");
      data.set("idempotencyKey", key);
      data.set("status", "disabled");
      return data;
    })(),
    input: { installationId, status: "disabled" },
    meta: { expectedVersion: 4, idempotencyKey: key },
    message: "Slack installation disabled.",
  },
];

describe("each Slack form reaches its handler", () => {
  test("the three bus forms name the three Slack administration commands", () => {
    expect([...new Set(cases.map((entry) => entry.command))].sort()).toEqual(
      Object.keys(slackAdministrationCommandInputSchemas).sort(),
    );
    expect(new Set(cases.map((entry) => entry.action))).toEqual(
      new Set(Object.keys(actions)),
    );
  });

  test.each(cases.map((entry) => [entry.label, entry] as const))(
    "%s dispatches its command on the tenant bus, as the signed-in person",
    async (_, entry) => {
      const state = await actions[entry.action](
        initialSlackActionState,
        entry.form,
      );

      expect(state).toEqual({ status: "success", message: entry.message });
      expect(slack.humanCommandContext).toHaveBeenCalledWith(
        slack.session,
        slack.organization.id,
      );
      expect(slack.execute).toHaveBeenCalledOnce();
      expect(slack.execute).toHaveBeenCalledWith({
        name: entry.command,
        context: slack.commandContext,
        input: { organizationId: slack.organization.id, ...entry.input },
        meta: entry.meta,
      });
      expect(slack.queueSlackConnectionTest).not.toHaveBeenCalled();
      // The command the form names is one the bus holds, and it accepts what
      // the form sends.
      const definition = createCoreCommandRegistry().resolve(entry.command);
      expect(definition).toBeDefined();
      expect(() =>
        definition?.parse(slack.execute.mock.calls[0]?.[0].input),
      ).not.toThrow();
    },
  );

  test("the connection test calls its handler, as the signed-in person, with version zero", async () => {
    const state = await sendSlackConnectionTestAction(
      initialSlackActionState,
      testForm({ channelId: " C012ABCDEF " }),
    );

    expect(state).toEqual({
      status: "success",
      message: `Slack test queued as ${operationId}.`,
    });
    expect(slack.humanCommandContext).toHaveBeenCalledWith(
      slack.session,
      slack.organization.id,
    );
    expect(slack.queueSlackConnectionTest).toHaveBeenCalledOnce();
    expect(slack.queueSlackConnectionTest).toHaveBeenCalledWith(
      slack.commandContext,
      {
        organizationId: slack.organization.id,
        installationId,
        channelId: "C012ABCDEF",
      },
      { expectedVersion: 0, idempotencyKey: key },
    );
    expect(slack.execute).not.toHaveBeenCalled();
  });

  test("the connection test says the operation is durable when it could not be dispatched", async () => {
    slack.queueSlackConnectionTest.mockResolvedValue({
      operationId,
      dispatched: false,
    });

    expect(
      await sendSlackConnectionTestAction(initialSlackActionState, testForm()),
    ).toEqual({
      status: "success",
      message: `Slack test ${operationId} is durable and will be retried by the dispatcher.`,
    });
  });

  test("the connection test names the channel control it rejects, without reaching its handler", async () => {
    expect(
      await sendSlackConnectionTestAction(
        initialSlackActionState,
        testForm({ channelId: "general" }),
      ),
    ).toMatchObject({ field: "channelId", status: "error" });
    expect(slack.queueSlackConnectionTest).not.toHaveBeenCalled();
  });
});
