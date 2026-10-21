import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ProjectSettingsActionState } from "../app/(app)/settings/projects/[projectId]/action-state.js";
import {
  AliasForm,
  LaneForm,
  ProjectMemberForm,
  ProjectMembersTable,
  ProjectMetadataForm,
  ProjectStatusForm,
  ProjectWorkPolicyForm,
  RepositoryForm,
} from "./project-settings.js";

/**
 * Project settings, driven the way a maintainer drives them.
 *
 * Every visible control here belongs to one `Field` with a visible label, the
 * encrypted-context choice set is one named `CheckboxGroup` rather than one
 * field per box, and the one destructive control — revoking a person's project
 * access — arms in place because the role can simply be granted again.
 */

const idle: ProjectSettingsActionState = { status: "idle" };
const projectId = "00000000-0000-4000-8000-0000000000c1";
const meta = {
  expectedVersion: 7,
  idempotencyKey: "web:fixture:00000000-0000-4000-8000-000000000001",
};

function mount(node: ReactNode) {
  return render(
    <ThemeProvider
      density="ultra-compact"
      mode="system"
      persistPreferences={false}
      theme="requestport"
    >
      {node}
    </ThemeProvider>,
  );
}

function submitted(action: { mock: { calls: unknown[][] } }) {
  const data = action.mock.calls.at(-1)?.[1] as FormData | undefined;
  if (!data) throw new Error("the action was never invoked");

  return data;
}

function entries(action: { mock: { calls: unknown[][] } }) {
  return Object.fromEntries(
    [...submitted(action).entries()].map(([name, value]) => [
      name,
      String(value),
    ]),
  );
}

const action = vi.fn();

beforeEach(() => {
  action.mockReset();
  action.mockResolvedValue(idle);
});

describe("the compact settings forms", () => {
  test("keeps the project, version, and idempotency metadata on every write", async () => {
    const user = userEvent.setup();
    mount(<AliasForm action={action} meta={meta} projectId={projectId} />);

    await user.type(screen.getByLabelText("Alias"), "legacy-platform");
    await user.click(screen.getByRole("button", { name: "Add alias" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toEqual({
      alias: "legacy-platform",
      expectedVersion: "7",
      idempotencyKey: meta.idempotencyKey,
      projectId,
    });
  });

  test("names the repository and lane controls through their own fields", () => {
    mount(<RepositoryForm action={action} meta={meta} projectId={projectId} />);
    expect(screen.getByLabelText("GitHub repository")).toBeInTheDocument();

    mount(<LaneForm action={action} meta={meta} projectId={projectId} />);
    expect(screen.getByLabelText("Lane name")).toBeInTheDocument();
    expect(screen.getByLabelText("Lane slug")).toBeInTheDocument();
  });

  test("gives the project description a real labelled multi-line control", () => {
    mount(
      <ProjectMetadataForm
        action={action}
        meta={meta}
        project={{
          description: "The console",
          id: projectId,
          name: "Platform",
          version: 7,
        }}
      />,
    );

    const description = screen.getByLabelText("Description");
    expect(description.tagName).toBe("TEXTAREA");
    expect(description).toHaveValue("The console");
  });

  test("puts a rejected field's message on that field", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "alias",
      message: "That value is already registered in this organization.",
      status: "error",
    } satisfies ProjectSettingsActionState);
    mount(<AliasForm action={action} meta={meta} projectId={projectId} />);

    await user.type(screen.getByLabelText("Alias"), "taken");
    await user.click(screen.getByRole("button", { name: "Add alias" }));

    expect(
      await screen.findByText(
        "That value is already registered in this organization.",
      ),
    ).toHaveAttribute("data-slot", "field-error");
  });

  test("banners a version conflict, which belongs to no single field", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "The project changed. Refresh and try again.",
      status: "error",
    } satisfies ProjectSettingsActionState);
    mount(<AliasForm action={action} meta={meta} projectId={projectId} />);

    await user.type(screen.getByLabelText("Alias"), "legacy");
    await user.click(screen.getByRole("button", { name: "Add alias" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The project changed. Refresh and try again.",
    );
  });
});

describe("project membership", () => {
  test("chooses a person and a role through two named controls", async () => {
    const user = userEvent.setup();
    mount(
      <ProjectMemberForm
        action={action}
        members={[
          { email: "ada@example.com", name: "Ada Lovelace", userId: "user_2" },
        ]}
        meta={meta}
        projectId={projectId}
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "Organization member" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: /Ada Lovelace/u,
      }),
    );
    await user.click(screen.getByRole("combobox", { name: "Project role" }));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Maintainer",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save project role" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({
      projectId,
      role: "maintainer",
      status: "active",
      userId: "user_2",
    });
  });

  test("arms before it revokes a person's project access", async () => {
    const user = userEvent.setup();
    mount(
      <ProjectMembersTable
        action={action}
        members={[
          {
            email: "ada@example.com",
            id: "membership_1",
            name: "Ada Lovelace",
            role: "contributor",
            status: "active",
            userId: "user_2",
          },
        ]}
        metas={{ membership_1: meta }}
        projectId={projectId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(action).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({
      role: "contributor",
      status: "revoked",
      userId: "user_2",
    });
  });

  test("offers no control at all for an already revoked membership", () => {
    mount(
      <ProjectMembersTable
        action={action}
        members={[
          {
            email: "ada@example.com",
            id: "membership_1",
            name: "Ada Lovelace",
            role: "viewer",
            status: "revoked",
            userId: "user_2",
          },
        ]}
        metas={{ membership_1: meta }}
        projectId={projectId}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the agent work policy", () => {
  const policy = {
    graceSeconds: 900,
    heartbeatIntervalSeconds: 30,
    leaseMultiplier: 3,
    requiredWorkspaceFields: ["hostname"],
  };

  test("collects the encrypted context choices as one named group", async () => {
    const user = userEvent.setup();
    mount(
      <ProjectWorkPolicyForm
        action={action}
        meta={meta}
        policy={policy}
        projectId={projectId}
      />,
    );

    const group = screen.getByRole("group", {
      name: "Required encrypted workspace fields",
    });
    expect(
      within(group).getByRole("checkbox", { name: "hostname" }),
    ).toBeChecked();

    await user.click(within(group).getByRole("checkbox", { name: "fqdn" }));
    await user.click(screen.getByRole("button", { name: "Save work policy" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action).getAll("requiredWorkspaceFields")).toEqual([
      "hostname",
      "fqdn",
    ]);
  });

  test("keeps the three lease numbers on their own labelled controls", () => {
    mount(
      <ProjectWorkPolicyForm
        action={action}
        meta={meta}
        policy={policy}
        projectId={projectId}
      />,
    );

    expect(screen.getByLabelText("Heartbeat interval")).toHaveValue(30);
    expect(screen.getByLabelText("Lease multiplier")).toHaveValue(3);
    expect(screen.getByLabelText("Abandon grace")).toHaveValue(900);
  });
});

describe("the project lifecycle control", () => {
  test("archives an active project and reactivates an archived one", async () => {
    const user = userEvent.setup();
    const active = mount(
      <ProjectStatusForm
        action={action}
        meta={meta}
        project={{ id: projectId, status: "active", version: 7 }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive project" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({ status: "archived" });

    active.unmount();
    action.mockClear();
    mount(
      <ProjectStatusForm
        action={action}
        meta={meta}
        project={{ id: projectId, status: "archived", version: 7 }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Reactivate project" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({ status: "active" });
  });
});
