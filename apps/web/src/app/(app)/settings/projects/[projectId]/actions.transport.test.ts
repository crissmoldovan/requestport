import {
  operatorActor,
  projectSettingsCommandInputSchemas,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
} from "../../../../../test/api-v1/agent-client.js";
import {
  apiV1,
  resetApiV1Fakes,
} from "../../../../../test/api-v1/fake-database.js";

/*
  Plan 13, F.2.3's registry half: the settings form and `/api/v1` reach the
  same handler. Both run here for real — the form's action, the REST route,
  the real `server-core-commands.ts` bus and `createCoreCommandRegistry()` —
  over B1's faked `@requestport/db`, so each ends at the same project
  settings port method, which records what it was handed. The form arrives
  as the signed-in person; REST as an operator credential, whose issuing
  member the port is asked about, and whose own actor the write records.

  What the fake cannot show — the role rule, the version check, the
  credential's re-check against its row — is proven on PostgreSQL in
  `packages/db/src/queries/project-settings-repository.integration.test.ts`
  and `administration/project-settings-reads.integration.test.ts`.
*/

vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../../../../test/api-v1/fake-database.js"))
      .fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../../../test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock(
  "../../../../../lib/observability.js",
  async () =>
    (await import("../../../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../../../../lib/trigger-client.js",
  async () =>
    (await import("../../../../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../../../test/api-v1/fake-database.js"))
      .fakeWiringModule,
);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const session = vi.hoisted(() => ({
  user: { id: "user_f23_person" },
  session: { id: "session_f23" },
}));
vi.mock("../../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: {
      id: "018f0000-0000-7000-8000-00000000b101",
      name: "B1",
      role: "owner",
      slug: "b1",
    },
    session,
  }),
}));

const route = await import("../../../../api/v1/[[...path]]/route.js");
const actions = await import("./actions.js");
const { initialProjectSettingsActionState } = await import("./action-state.js");
const api = restClient(route);

const projectId = "018f0000-0000-7000-8000-0000000f2311";
const otherProjectId = "018f0000-0000-7000-8000-0000000f2312";
const repositoryId = "018f0000-0000-7000-8000-0000000f2313";
const laneId = "018f0000-0000-7000-8000-0000000f2314";
const lineageId = "018f0000-0000-7000-8000-0000000f2315";
const credentialId = "018f0000-0000-7000-8000-0000000f2316";
const memberUserId = "user_f23_operator_member";

type CommandName = keyof typeof projectSettingsCommandInputSchemas;

/** Each command, its form action, its port method and one valid input. */
const cases: Array<{
  command: CommandName;
  action: keyof typeof actions;
  method: string;
  fields: Record<string, unknown>;
  form: Record<string, string>;
}> = [
  {
    command: "add_project_alias",
    action: "addAliasAction",
    method: "addAlias",
    fields: { alias: "legacy" },
    form: { alias: "legacy" },
  },
  {
    command: "add_project_repository",
    action: "addRepositoryAction",
    method: "addRepository",
    fields: { repositoryUrl: "https://github.com/example-org/requestport" },
    form: { repositoryUrl: "https://github.com/example-org/requestport" },
  },
  {
    command: "set_default_project_repository",
    action: "setDefaultRepositoryAction",
    method: "setDefaultRepository",
    fields: { repositoryId },
    form: { repositoryId },
  },
  {
    command: "set_project_repository_status",
    action: "setRepositoryStatusAction",
    method: "setRepositoryStatus",
    fields: { repositoryId, status: "archived" },
    form: { repositoryId, status: "archived" },
  },
  {
    command: "add_project_lane",
    action: "addLaneAction",
    method: "addLane",
    fields: { name: "Hotfix", slug: "hotfix" },
    form: { name: "Hotfix", slug: "hotfix" },
  },
  {
    command: "set_default_project_lane",
    action: "setDefaultLaneAction",
    method: "setDefaultLane",
    fields: { laneId },
    form: { laneId },
  },
  {
    command: "set_project_lane_status",
    action: "setLaneStatusAction",
    method: "setLaneStatus",
    fields: { laneId, status: "archived" },
    form: { laneId, status: "archived" },
  },
  {
    command: "set_project_member",
    action: "setProjectMemberAction",
    method: "setMember",
    fields: { userId: "user_f23_target", role: "viewer", status: "active" },
    form: { userId: "user_f23_target", role: "viewer", status: "active" },
  },
  {
    command: "set_project_work_policy",
    action: "setProjectWorkPolicyAction",
    method: "setWorkPolicy",
    fields: {
      heartbeatIntervalSeconds: 60,
      leaseMultiplier: 3,
      graceSeconds: 600,
      requiredWorkspaceFields: [],
    },
    form: {
      heartbeatIntervalSeconds: "60",
      leaseMultiplier: "3",
      graceSeconds: "600",
    },
  },
  {
    command: "update_project_metadata",
    action: "updateProjectMetadataAction",
    method: "updateMetadata",
    fields: { name: "Renamed", description: "About it" },
    form: { name: "Renamed", description: "About it" },
  },
  {
    command: "set_project_status",
    action: "setProjectStatusAction",
    method: "setProjectStatus",
    fields: { status: "archived" },
    form: { status: "archived" },
  },
];

function operatorContext(
  options: { projectId?: string | null; scopes?: readonly string[] } = {},
) {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator" as const,
    organizationId: ids.organization,
    projectId: options.projectId ?? null,
    laneIds: new Set<string>(),
    scopes: new Set(options.scopes ?? ["project:manage"]),
    credentialId,
    credentialFingerprint: "f23-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2317",
    authorizationId: credentialId,
  };
}

function signInAsOperator(options?: Parameters<typeof operatorContext>[0]) {
  const context = operatorContext(options);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** What the project settings port was handed, per method. */
function recordPort() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const methods = ["authorize", ...cases.map((entry) => entry.method)];
  apiV1.ports.projectSettingsCommands = Object.fromEntries(
    methods.map((method) => [
      method,
      async (...args: unknown[]) => {
        calls.push({ method, args });
        if (method === "authorize") return undefined;
        return { projectId, version: 8 };
      },
    ]),
  ) as never;
  return calls;
}

function formData(fields: Record<string, string>, id = projectId) {
  const data = new FormData();
  data.set("projectId", id);
  data.set("expectedVersion", "7");
  data.set("idempotencyKey", "f23-form-idempotency-0001");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function nothingReached() {
  expect(
    apiV1.portCalls.filter((call) =>
      call.startsWith("projectSettingsCommands."),
    ),
  ).toEqual([]);
}

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

describe("the form and REST reach the same handler", () => {
  test("the cases are the eleven commands, each once", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(projectSettingsCommandInputSchemas).sort(),
    );
  });

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s: the form and an operator's POST end at the same port method, each for its own member",
    async (_, entry) => {
      const calls = recordPort();
      const action = actions[entry.action] as (
        state: unknown,
        data: FormData,
      ) => Promise<{ status: string }>;
      const state = await action(
        initialProjectSettingsActionState,
        formData(entry.form),
      );
      expect(state.status).toBe("success");
      const fromForm = [...calls];
      calls.length = 0;

      const context = signInAsOperator();
      const response = await api.command(entry.command, {
        input: { projectId, ...entry.fields },
        idempotencyKey: "f23-rest-idempotency-0001",
        expectedVersion: 7,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        result: { projectId, version: 8 },
      });
      const fromRest = [...calls];

      // One authorisation, then the one write, by the same method on each
      // path.
      expect(fromForm.map((call) => call.method)).toEqual([
        "authorize",
        entry.method,
      ]);
      expect(fromRest.map((call) => call.method)).toEqual(
        fromForm.map((call) => call.method),
      );
      const target = (userId: string) => ({
        userId,
        organizationId: ids.organization,
        projectId,
      });
      expect(fromForm[0]?.args).toEqual([target(session.user.id)]);
      expect(fromRest[0]?.args).toEqual([target(memberUserId)]);
      expect(fromForm[1]?.args[0]).toMatchObject({
        ...target(session.user.id),
        actor: { type: "user", id: session.user.id },
        expectedVersion: 7,
      });
      expect(fromRest[1]?.args[0]).toMatchObject({
        ...target(memberUserId),
        actor: context.actor,
        correlationId: context.correlationId,
        expectedVersion: 7,
      });
      // What the write is told to do, beyond who and where, is the same.
      expect(fromRest[1]?.args.slice(1)).toEqual(fromForm[1]?.args.slice(1));
    },
  );
});

describe("REST refuses what the handler must never see", () => {
  test.each(cases.map((entry) => [entry.command] as const))(
    "%s refuses an agent credential 403 before anything runs, even holding project:manage",
    async (name) => {
      recordPort();
      signInAs(agentContext({ scopes: ["project:manage", "project:read"] }));
      const response = await api.command(name, {
        input: { projectId },
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      expect(apiV1.transactionsRun).toBe(0);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator bound to another project 403 before the port is asked",
    async (_, entry) => {
      recordPort();
      signInAsOperator({ projectId: otherProjectId });
      const response = await api.command(entry.command, {
        input: { projectId, ...entry.fields },
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s writes the credential's organisation over the one the caller names",
    async (_, entry) => {
      const calls = recordPort();
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: {
          organizationId: ids.otherOrganization,
          projectId,
          ...entry.fields,
        },
        expectedVersion: 7,
      });
      expect(response.status).toBe(200);
      expect(calls[0]?.args[0]).toMatchObject({
        organizationId: ids.organization,
      });
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator without project:manage 403, naming nothing it could reach",
    async (_, entry) => {
      recordPort();
      signInAsOperator({ scopes: ["operator:revoke"] });
      const response = await api.command(entry.command, {
        input: { projectId, ...entry.fields },
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator whose credential is no longer current 403, before the port is asked",
    async (_, entry) => {
      recordPort();
      apiV1.ports.commandAuthorization = {
        assertCurrent: async () => {
          const { DomainError } = await import("@requestport/domain");
          throw new DomainError(
            "forbidden",
            "Current operator authorization is no longer active",
          );
        },
      };
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: { projectId, ...entry.fields },
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
    },
  );
});

describe("GET /api/v1/administration/projects/{projectId}/settings", () => {
  const path = ["administration", "projects", projectId, "settings"];

  test("reads for an operator holding project:manage, in one transaction, with its context and the path's project", async () => {
    const context = signInAsOperator({ projectId });
    apiV1.administrationReads.projectSettings.mockResolvedValue({
      id: projectId,
      version: 3,
    });
    const response = await api.get(path);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: projectId,
      version: 3,
    });
    expect(apiV1.administrationReads.projectSettings).toHaveBeenCalledOnce();
    expect(apiV1.administrationReads.projectSettings).toHaveBeenCalledWith(
      { fake: "transaction" },
      {
        context,
        projectId,
        operatorCredentials: undefined,
      },
    );
    expect(apiV1.transactionsRun).toBe(1);
  });

  test("refuses an agent credential 403, even holding project:manage, reading nothing", async () => {
    signInAs(agentContext({ scopes: ["project:manage", "project:read"] }));
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(apiV1.administrationReads.projectSettings).not.toHaveBeenCalled();
    expect(apiV1.transactionsRun).toBe(0);
  });

  test("refuses an operator without project:manage 403, reading nothing", async () => {
    signInAsOperator({ scopes: ["operator:revoke"] });
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(apiV1.administrationReads.projectSettings).not.toHaveBeenCalled();
  });

  test.each([
    ["forbidden", 403],
    ["not_found", 404],
  ] as const)("answers the read's %s as %i", async (code, status) => {
    signInAsOperator();
    const { DomainError } = await import("@requestport/domain");
    apiV1.administrationReads.projectSettings.mockRejectedValue(
      new DomainError(code, "refused by the read"),
    );
    const response = await api.get(path);
    expect(response.status).toBe(status);
  });

  test("a path beside the read's is refused 403, reading nothing", async () => {
    for (const parts of [
      ["administration", "projects", projectId],
      ["administration", "projects", projectId, "settings", "extra"],
      ["administration", "projects", "", "settings"],
    ]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(403);
    }
    expect(apiV1.administrationReads.projectSettings).not.toHaveBeenCalled();
  });
});
