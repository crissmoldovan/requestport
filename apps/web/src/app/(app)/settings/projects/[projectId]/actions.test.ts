import {
  createCoreCommandRegistry,
  DomainError,
  projectSettingsCommandInputSchemas,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const project = vi.hoisted(() => ({
  execute: vi.fn(),
  commandContext: {
    actor: { type: "user", id: "00000000-0000-4000-8000-0000000000aa" },
    organizationId: "00000000-0000-4000-8000-0000000000d1",
    credentialId: "session-under-test",
    correlationId: "correlation-under-test",
    scopes: new Set(["project:manage"]),
  },
  humanCommandContext: vi.fn(),
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

vi.mock("../../../../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: project.execute },
  humanCommandContext: project.humanCommandContext,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: project.organization,
    session: project.session,
  }),
}));

import { initialProjectSettingsActionState } from "./action-state.js";
import {
  addAliasAction,
  addLaneAction,
  addRepositoryAction,
  setDefaultLaneAction,
  setDefaultRepositoryAction,
  setLaneStatusAction,
  setProjectMemberAction,
  setProjectStatusAction,
  setProjectWorkPolicyAction,
  setRepositoryStatusAction,
  updateProjectMetadataAction,
} from "./actions.js";

/** Every action the module exports, by name. */
const actions = {
  addAliasAction,
  addRepositoryAction,
  setDefaultRepositoryAction,
  setRepositoryStatusAction,
  addLaneAction,
  setDefaultLaneAction,
  setLaneStatusAction,
  setProjectMemberAction,
  setProjectWorkPolicyAction,
  updateProjectMetadataAction,
  setProjectStatusAction,
};

/**
 * Where a rejected project settings submission is allowed to land.
 *
 * The alias form draws one visible field, so §7 puts a rejection about the
 * alias on that control's own error line. A version conflict is about the
 * project rather than about any field, so it stays the fixed banner.
 */

const projectId = "00000000-0000-4000-8000-0000000000c1";
const key = "0123456789abcdef0123";

function aliasForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("projectId", projectId);
  data.set("alias", "legacy-platform");
  data.set("expectedVersion", "7");
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

beforeEach(() => {
  project.execute.mockReset();
  project.execute.mockResolvedValue({ projectId, version: 8 });
  project.humanCommandContext.mockReset();
  project.humanCommandContext.mockReturnValue(project.commandContext);
});

describe("adding a project alias", () => {
  test("addresses a rejected alias to the alias control", async () => {
    const state = await addAliasAction(
      initialProjectSettingsActionState,
      aliasForm({ alias: "" }),
    );

    expect(state).toMatchObject({ field: "alias", status: "error" });
    expect(state.message).not.toBe("");
    expect(project.execute).not.toHaveBeenCalled();
  });

  test("carries the field a domain rejection already names", async () => {
    project.execute.mockRejectedValue(
      new DomainError("conflict", "alias already registered", {
        field: "alias",
      }),
    );

    expect(
      await addAliasAction(initialProjectSettingsActionState, aliasForm()),
    ).toEqual({
      field: "alias",
      message: "That value is already registered in this organization.",
      status: "error",
    });
  });

  test("keeps a version conflict in the fixed banner", async () => {
    project.execute.mockRejectedValue(
      new DomainError("version_conflict", "stale"),
    );

    expect(
      await addAliasAction(initialProjectSettingsActionState, aliasForm()),
    ).toEqual({
      message: "The project changed. Refresh and try again.",
      status: "error",
    });
  });

  test("confirms an accepted alias without naming any field", async () => {
    expect(
      await addAliasAction(initialProjectSettingsActionState, aliasForm()),
    ).toEqual({ message: "Alias added.", status: "success" });
  });
});

/*
  Plan 13, F.2.3: each settings form reaches the command the transport will
  reach — one command on the tenant bus per form, by name, with the signed-in
  person's command context, the organisation from the session, the project and
  fields from the form, and the version and key as the bus's meta.
*/
const repositoryId = "00000000-0000-4000-8000-0000000000e1";
const laneId = "00000000-0000-4000-8000-0000000000f1";

type ActionName = keyof typeof actions;

const cases: Array<{
  action: ActionName;
  command: keyof typeof projectSettingsCommandInputSchemas;
  form: Record<string, string | string[]>;
  input: Record<string, unknown>;
  message: string;
}> = [
  {
    action: "addAliasAction",
    command: "add_project_alias",
    form: { alias: "  legacy-platform " },
    input: { alias: "legacy-platform" },
    message: "Alias added.",
  },
  {
    action: "addRepositoryAction",
    command: "add_project_repository",
    form: { repositoryUrl: "https://github.com/example-org/requestport" },
    input: { repositoryUrl: "https://github.com/example-org/requestport" },
    message: "Repository added.",
  },
  {
    action: "setDefaultRepositoryAction",
    command: "set_default_project_repository",
    form: { repositoryId },
    input: { repositoryId },
    message: "Default repository updated.",
  },
  {
    action: "setRepositoryStatusAction",
    command: "set_project_repository_status",
    form: { repositoryId, status: "archived" },
    input: { repositoryId, status: "archived" },
    message: "Repository archived.",
  },
  {
    action: "addLaneAction",
    command: "add_project_lane",
    form: { name: "Hotfix", slug: "HotFix" },
    input: { name: "Hotfix", slug: "hotfix" },
    message: "Lane added.",
  },
  {
    action: "setDefaultLaneAction",
    command: "set_default_project_lane",
    form: { laneId },
    input: { laneId },
    message: "Default lane updated.",
  },
  {
    action: "setLaneStatusAction",
    command: "set_project_lane_status",
    form: { laneId, status: "active" },
    input: { laneId, status: "active" },
    message: "Lane reactivated.",
  },
  {
    action: "setProjectMemberAction",
    command: "set_project_member",
    form: { userId: "user_42", role: "viewer", status: "revoked" },
    input: { userId: "user_42", role: "viewer", status: "revoked" },
    message: "Project access revoked.",
  },
  {
    action: "setProjectWorkPolicyAction",
    command: "set_project_work_policy",
    form: {
      heartbeatIntervalSeconds: "45",
      leaseMultiplier: "3",
      graceSeconds: "600",
      requiredWorkspaceFields: ["hostname", "branch", "hostname"],
    },
    input: {
      heartbeatIntervalSeconds: 45,
      leaseMultiplier: 3,
      graceSeconds: 600,
      requiredWorkspaceFields: ["hostname", "branch"],
    },
    message: "Agent work policy updated.",
  },
  {
    action: "updateProjectMetadataAction",
    command: "update_project_metadata",
    form: { name: " Requestport ", description: "" },
    input: { name: "Requestport", description: "" },
    message: "Project details updated.",
  },
  {
    action: "setProjectStatusAction",
    command: "set_project_status",
    form: { status: "archived" },
    input: { status: "archived" },
    message: "Project archived.",
  },
];

function form(fields: Record<string, string | string[]>) {
  const data = new FormData();
  data.set("projectId", projectId);
  data.set("expectedVersion", "7");
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(fields))
    for (const one of Array.isArray(value) ? value : [value])
      data.append(name, one);
  return data;
}

describe("each settings form reaches its project settings command", () => {
  test("the eleven forms name the eleven commands, each once", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(projectSettingsCommandInputSchemas).sort(),
    );
    expect(new Set(cases.map((entry) => entry.action)).size).toBe(11);
  });

  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s dispatches its command on the tenant bus, as the signed-in person",
    async (_, entry) => {
      const action = actions[entry.action];
      const state = await action(
        initialProjectSettingsActionState,
        form(entry.form),
      );

      expect(state).toEqual({ status: "success", message: entry.message });
      expect(project.humanCommandContext).toHaveBeenCalledWith(
        project.session,
        project.organization.id,
      );
      expect(project.execute).toHaveBeenCalledOnce();
      expect(project.execute).toHaveBeenCalledWith({
        name: entry.command,
        context: project.commandContext,
        input: {
          organizationId: project.organization.id,
          projectId,
          ...entry.input,
        },
        meta: { expectedVersion: 7, idempotencyKey: key },
      });
      // The command the form names is one the bus holds, and it accepts what
      // the form sends.
      const definition = createCoreCommandRegistry().resolve(entry.command);
      expect(definition).toBeDefined();
      expect(() =>
        definition?.parse(project.execute.mock.calls[0]?.[0].input),
      ).not.toThrow();
    },
  );

  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s refuses a malformed project id without reaching the bus",
    async (_, entry) => {
      const data = form(entry.form);
      data.set("projectId", "not-a-project");
      const state = await actions[entry.action](
        initialProjectSettingsActionState,
        data,
      );

      expect(state).toMatchObject({ status: "error", field: "projectId" });
      expect(project.execute).not.toHaveBeenCalled();
    },
  );
});
