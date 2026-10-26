import { Dialog } from "@cueplusplus/ui/overlays";
import { ThemeProvider } from "@cueplusplus/ui/system";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import type { AgentActionState } from "../app/(app)/agents/agent-action-state.js";
import {
  AgentStatusForm,
  ConnectAgentSheet,
  CreateAgentForm,
  CredentialActions,
  IssueAgentKeyForm,
  OauthGrantActions,
  RevealWorkspaceForm,
} from "./agent-management.js";

/**
 * Agent identity, credentials, grants and telemetry, driven the way an
 * administrator drives them.
 *
 * Two rules decide the shapes here. The lane and scope choice sets are one
 * named `CheckboxGroup` each rather than one field per box, and the three
 * actions with no way back — permanently revoking a principal, revoking a
 * credential, revoking a delegated grant — ask in a modal `AlertDialog`, while
 * a rotation arms in place because the previous secret keeps working through
 * its overlap.
 *
 * The one-time secret is treated as credential material throughout: the suite
 * asserts *where* it is shown and that it is copyable, never printing one that
 * could be mistaken for a real key.
 */

const idle: AgentActionState = { message: "", status: "idle" };
const agentPrincipalId = "00000000-0000-4000-8000-0000000000a1";
const key = "web:fixture:00000000-0000-4000-8000-000000000001";

const projects = [
  { id: "00000000-0000-4000-8000-0000000000c1", name: "Platform" },
  { id: "00000000-0000-4000-8000-0000000000c2", name: "Docs" },
];

const lanes = [
  {
    id: "00000000-0000-4000-8000-0000000000e1",
    name: "release",
    projectId: projects[0].id,
    slug: "release",
  },
];

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

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: string,
  option: RegExp | string,
) {
  await user.click(screen.getByRole("combobox", { name: control }));
  await user.click(
    within(await screen.findByRole("listbox")).getByRole("option", {
      name: option,
    }),
  );
}

const action = vi.fn();
const second = vi.fn();

beforeEach(() => {
  action.mockReset();
  second.mockReset();
  action.mockResolvedValue(idle);
  second.mockResolvedValue(idle);
});

/**
 * Wraps the real dialog root for one test, recording the props the component
 * hands it and every close Base UI reports back through it.
 *
 * `disablePointerDismissal` has no DOM projection, and while the dialog is
 * open-controlled a refused outside press and an ignored one look identical on
 * screen — so the only honest evidence that a scrim press was refused is that
 * the dialog was never asked to close. The real component still renders the
 * real dialog; this observes the boundary between them.
 */
function watchDialog() {
  const real = Dialog.Root;
  const closes: string[] = [];
  const spy = vi.spyOn(Dialog, "Root").mockImplementation((props) =>
    real({
      ...props,
      onOpenChange(open, details) {
        closes.push(details.reason);
        props.onOpenChange?.(open, details);
      },
    }),
  );
  onTestFinished(() => spy.mockRestore());

  return {
    closes,
    props: () => {
      const last = spy.mock.calls.at(-1)?.[0];
      if (!last) throw new Error("no dialog was rendered");

      return last;
    },
  };
}

/**
 * Gives a close that was asked for time to happen before asserting it did not.
 *
 * Base UI unmounts a closing dialog a frame or two after the gesture, so an
 * assertion fired in the same turn as one holds whether or not the dialog
 * obeyed. Each test that waits here closes the dialog for real afterwards,
 * which proves the unmount it waited for is live.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  });
}

/**
 * Drives one issuance whose answer carries a credential, and hands back the
 * dialog that credential is shown in — the only place it is ever shown.
 */
async function reveal(
  user: ReturnType<typeof userEvent.setup>,
  plaintextKey: string,
) {
  action.mockResolvedValue({
    message: "Credential issued.",
    plaintextKey,
    status: "success",
  } satisfies AgentActionState);
  mount(
    <IssueAgentKeyForm
      action={action}
      agentPrincipalId={agentPrincipalId}
      defaultProjectId={projects[0].id}
      idempotencyKey={key}
      lanes={lanes}
      projects={projects}
    />,
  );

  await user.type(screen.getByLabelText("Credential name"), "Laptop");
  await user.click(screen.getByRole("button", { name: "Issue one-time key" }));

  return screen.findByRole("dialog");
}

describe("registering an agent principal", () => {
  test("names every visible control through its own field", () => {
    mount(
      <CreateAgentForm
        action={action}
        allowOrganizationWide
        idempotencyKey={key}
        projects={projects}
      />,
    );

    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent slug")).toBeInTheDocument();
    expect(screen.getByLabelText("Software")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Default project" }),
    ).toBeInTheDocument();
  });

  test("offers the organization-wide scope only when it is allowed", async () => {
    const user = userEvent.setup();
    const wide = mount(
      <CreateAgentForm
        action={action}
        allowOrganizationWide
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Default project" }));
    expect(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Organization-wide",
      }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    wide.unmount();

    mount(
      <CreateAgentForm
        action={action}
        allowOrganizationWide={false}
        idempotencyKey={key}
        projects={projects}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Default project" }));
    expect(
      within(await screen.findByRole("listbox")).queryByRole("option", {
        name: "Organization-wide",
      }),
    ).toBeNull();
  });

  test("submits the idempotency key the page minted", async () => {
    const user = userEvent.setup();
    mount(
      <CreateAgentForm
        action={action}
        allowOrganizationWide
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await user.type(screen.getByLabelText("Display name"), "Claude Code");
    await user.type(screen.getByLabelText("Agent slug"), "claude-code");
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({
      displayName: "Claude Code",
      idempotencyKey: key,
      slug: "claude-code",
    });
  });

  test("puts a rejected field's message on that field", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "slug",
      message: "That agent slug is already registered.",
      status: "error",
    } satisfies AgentActionState);
    mount(
      <CreateAgentForm
        action={action}
        allowOrganizationWide
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await user.type(screen.getByLabelText("Display name"), "Claude Code");
    await user.type(screen.getByLabelText("Agent slug"), "claude-code");
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    expect(
      await screen.findByText("That agent slug is already registered."),
    ).toHaveAttribute("data-slot", "field-error");
  });
});

describe("issuing a credential", () => {
  test("collects lanes and scopes as two named groups", async () => {
    const user = userEvent.setup();
    mount(
      <IssueAgentKeyForm
        action={action}
        agentPrincipalId={agentPrincipalId}
        defaultProjectId={projects[0].id}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    const laneGroup = screen.getByRole("group", { name: "Allowed lanes" });
    const scopeGroup = screen.getByRole("group", { name: "Allowed scopes" });
    expect(
      within(scopeGroup).getByRole("checkbox", { name: "org:read" }),
    ).toBeChecked();
    expect(
      within(scopeGroup).getByRole("checkbox", { name: "webhook:manage" }),
    ).not.toBeChecked();

    await user.type(screen.getByLabelText("Credential name"), "Laptop");
    await user.click(
      within(laneGroup).getByRole("checkbox", { name: /release/u }),
    );
    await user.click(
      screen.getByRole("button", { name: "Issue one-time key" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action).getAll("laneIds")).toEqual([lanes[0].id]);
    expect(submitted(action).getAll("scopes")).toContain("org:read");
    expect(submitted(action).getAll("scopes")).not.toContain("webhook:manage");
  });

  test("puts a rejected group's message on that group and not in the banner", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "scopes",
      message: "Too small: expected array to have >=1 items",
      status: "error",
    } satisfies AgentActionState);
    mount(
      <IssueAgentKeyForm
        action={action}
        agentPrincipalId={agentPrincipalId}
        defaultProjectId={projects[0].id}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    await user.type(screen.getByLabelText("Credential name"), "Laptop");
    const scopeGroup = screen.getByRole("group", { name: "Allowed scopes" });
    // Untick the one default the server rejects the form for lacking: this is
    // the ordinary path, not tampering.
    await user.click(
      within(scopeGroup).getByRole("checkbox", { name: "org:read" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Issue one-time key" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(
      await screen.findByText("Too small: expected array to have >=1 items"),
    ).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("refuses to offer issuance when no project can hold the credential", () => {
    mount(
      <IssueAgentKeyForm
        action={action}
        agentPrincipalId={agentPrincipalId}
        defaultProjectId={null}
        idempotencyKey={key}
        lanes={[]}
        projects={[]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Issue one-time key" }),
    ).toBeDisabled();
  });

  test("shows the one-time secret in a modal with a copy control, once", async () => {
    const user = userEvent.setup();
    const secret = "rqp_test_not_a_real_credential";
    const dialog = await reveal(user, secret);
    expect(within(dialog).getByText(secret)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Copy credential" }),
    ).toBeInTheDocument();
    // One dismissal affordance, not two: a corner close beside the footer
    // control would say "Close" twice to a screen-reader user.
    expect(
      within(dialog).getAllByRole("button", { name: "Close" }),
    ).toHaveLength(1);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(secret)).toBeNull();
  });

  test("keeps the credential on screen when Escape is pressed", async () => {
    const user = userEvent.setup();
    const watched = watchDialog();
    const secret = "rqp_test_escape_not_a_real_credential";
    const dialog = await reveal(user, secret);

    await user.keyboard("{Escape}");

    // Escape does reach the dialog — it is the dismissal that is refused, not
    // the gesture that is missing.
    expect(watched.closes).toEqual(["escape-key"]);
    await settle();

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText(secret)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  test("keeps the credential on screen when the scrim is pressed", async () => {
    const user = userEvent.setup();
    const watched = watchDialog();
    const secret = "rqp_test_scrim_not_a_real_credential";
    const dialog = await reveal(user, secret);
    const scrim = document.querySelector('[data-slot="dialog-backdrop"]');
    if (!scrim) throw new Error("the dialog drew no scrim");

    expect(watched.props().disablePointerDismissal).toBe(true);

    await user.click(scrim);
    await settle();

    // Nothing was reported at all: without the guard the same press arrives as
    // `outside-press`.
    expect(watched.closes).toEqual([]);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText(secret)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("changing an agent's status", () => {
  test("asks in a modal before a permanent revocation, and not before a suspension", async () => {
    const user = userEvent.setup();
    mount(
      <AgentStatusForm
        action={action}
        agentPrincipalId={agentPrincipalId}
        currentStatus="active"
        expectedVersion={4}
        idempotencyKey={key}
      />,
    );

    await user.type(
      screen.getByLabelText("Reason"),
      "Rotating the fleet identity",
    );
    await user.click(
      screen.getByRole("button", { name: "Update agent status" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({
      expectedVersion: "4",
      status: "suspended",
    });

    action.mockClear();
    // React resets an uncontrolled form once its action settles, so the reason
    // the audit requires has to be given again for the second submission.
    await user.type(
      screen.getByLabelText("Reason"),
      "Retiring the fleet identity",
    );
    await choose(user, "New status", "Permanently revoke");
    await user.click(screen.getByRole("button", { name: "Revoke agent" }));
    expect(action).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Revoke permanently" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({ status: "revoked" });
  });

  test("offers nothing at all once the principal is already revoked", () => {
    mount(
      <AgentStatusForm
        action={action}
        agentPrincipalId={agentPrincipalId}
        currentStatus="revoked"
        expectedVersion={9}
        idempotencyKey={key}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText(/permanently revoked/u, { exact: false }),
    ).toBeInTheDocument();
  });
});

describe("credential and grant lifecycle", () => {
  test("arms a rotation in place and asks in a modal before a revocation", async () => {
    const user = userEvent.setup();
    mount(
      <CredentialActions
        agentPrincipalId={agentPrincipalId}
        credentialId="00000000-0000-4000-8000-0000000000b1"
        expectedVersion={2}
        revokeAction={second}
        revokeIdempotencyKey={`${key}:revoke`}
        rotateAction={action}
        rotateIdempotencyKey={`${key}:rotate`}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rotate credential" }));
    expect(action).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({
      expectedVersion: "2",
      overlapMinutes: "15",
    });

    await user.click(screen.getByRole("button", { name: "Revoke credential" }));
    expect(second).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Revoke credential" }),
    );
    await waitFor(() => expect(second).toHaveBeenCalled());
  });

  test("requires an audited reason before revoking a delegated grant", async () => {
    const user = userEvent.setup();
    const grantId = "00000000-0000-4000-8000-0000000000d9";
    mount(
      <OauthGrantActions
        action={action}
        agentPrincipalId={agentPrincipalId}
        expectedVersion={1}
        grantId={grantId}
        idempotencyKey={key}
      />,
    );

    const reason = screen.getByLabelText("Revocation reason");
    expect(reason).toBeRequired();
    await user.type(reason, "Laptop was decommissioned");

    await user.click(
      screen.getByRole("button", { name: "Revoke OAuth grant" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Revoke grant" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(entries(action)).toMatchObject({
      grantId,
      reason: "Laptop was decommissioned",
    });
  });
});

describe("revealing private machine telemetry", () => {
  test("stays folded away behind a disclosure until it is asked for", async () => {
    const user = userEvent.setup();
    mount(
      <RevealWorkspaceForm
        action={action}
        idempotencyKey={key}
        workspaceId="00000000-0000-4000-8000-0000000000f2"
      />,
    );

    expect(screen.queryByLabelText("Reason")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Reveal private telemetry" }),
    );
    expect(screen.getByLabelText("Reason")).toBeInTheDocument();
  });

  test("puts a rejected group's message on that group and not in the banner", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "fields",
      message: "Too small: expected array to have >=1 items",
      status: "error",
    } satisfies AgentActionState);
    mount(
      <RevealWorkspaceForm
        action={action}
        idempotencyKey={key}
        workspaceId="00000000-0000-4000-8000-0000000000f2"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Reveal private telemetry" }),
    );
    // Nothing is ticked by default, which is exactly what the schema rejects.
    await user.type(screen.getByLabelText("Reason"), "Investigating a stall");
    await user.click(screen.getByRole("button", { name: "Reveal and audit" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(
      await screen.findByText("Too small: expected array to have >=1 items"),
    ).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("submits the chosen fields as one named group and shows the audited answer", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "Telemetry revealed and audited.",
      status: "success",
      telemetryJson: '{"hostname":"build-01"}',
    } satisfies AgentActionState);
    mount(
      <RevealWorkspaceForm
        action={action}
        idempotencyKey={key}
        workspaceId="00000000-0000-4000-8000-0000000000f2"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Reveal private telemetry" }),
    );
    const group = screen.getByRole("group", { name: "Fields" });
    await user.click(within(group).getByRole("checkbox", { name: "hostname" }));
    await user.type(screen.getByLabelText("Reason"), "Investigating a stall");
    await user.click(screen.getByRole("button", { name: "Reveal and audit" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action).getAll("fields")).toEqual(["hostname"]);
    expect(
      await screen.findByText('{"hostname":"build-01"}'),
    ).toBeInTheDocument();
  });
});

describe("connecting an agent in three steps", () => {
  const endpoints = {
    mcp: "https://requestport.example/mcp",
    metadata:
      "https://requestport.example/.well-known/oauth-protected-resource/mcp",
    rest: "https://requestport.example/api/v1",
  };
  const created = {
    displayName: "Claude Code",
    id: "00000000-0000-4000-8000-0000000000a9",
    projectId: projects[1].id,
    slug: "claude-code",
  };

  function sheet(agents: (typeof created)[]) {
    return (
      <ThemeProvider
        density="ultra-compact"
        mode="system"
        persistPreferences={false}
        theme="requestport"
      >
        <ConnectAgentSheet
          agents={agents}
          allowOrganizationWide
          createAction={action}
          createIdempotencyKey={key}
          endpoints={endpoints}
          issueAction={second}
          issueIdempotencyKey={`${key}:issue`}
          lanes={lanes}
          projects={projects}
        />
      </ThemeProvider>
    );
  }

  /**
   * Opens the sheet and creates the agent through its first step. The page
   * revalidates after a create, so the agent list the sheet is handed next
   * carries the new principal; the re-render below stands in for that.
   */
  async function createThroughFirstStep(
    user: ReturnType<typeof userEvent.setup>,
    slug = "claude-code",
  ) {
    action.mockResolvedValue({
      message: "Agent principal created.",
      status: "success",
    } satisfies AgentActionState);
    const view = render(sheet([]));
    await user.click(screen.getByRole("button", { name: "Connect an agent" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Display name"),
      "Claude Code",
    );
    await user.type(within(dialog).getByLabelText("Agent slug"), slug);
    const create = within(dialog).getByRole("button", { name: "Create agent" });
    if (slug === "claude-code") {
      await user.click(create);
    } else {
      // The slug input's pattern stops a browser from submitting a slug that
      // is not already trimmed and lower-case; the submit event goes past it,
      // as a client that skips the pattern would.
      const form = create.closest("form");
      if (!form) throw new Error("the create button is outside a form");
      fireEvent.submit(form);
    }
    await waitFor(() => expect(action).toHaveBeenCalled());
    view.rerender(sheet([created]));
    await within(dialog).findByRole("radiogroup", { name: "How it signs in" });
    return dialog;
  }

  test("opens a right sheet whose first step is the existing create form", async () => {
    const user = userEvent.setup();
    render(sheet([]));

    await user.click(screen.getByRole("button", { name: "Connect an agent" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Connect an agent")).toBeInTheDocument();
    const steps = within(dialog).getByRole("navigation", {
      name: "Steps to connect an agent",
    });
    expect(steps).toHaveTextContent(/name.*sign-in.*connect/u);
    expect(within(dialog).getByLabelText("Display name")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Agent slug")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Software")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("combobox", { name: "Default project" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
  });

  test("submits the create form unchanged, then asks how the new agent signs in", async () => {
    const user = userEvent.setup();
    const dialog = await createThroughFirstStep(user);

    expect(entries(action)).toMatchObject({
      displayName: "Claude Code",
      idempotencyKey: key,
    });
    expect(
      within(dialog).getByRole("radio", { name: /^OAuth \(recommended\)/u }),
    ).toBeChecked();
    expect(within(dialog).getByText(/choose Claude Code/u)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Credential name")).toBeNull();
  });

  test("issues the new agent's key through the existing one-time flow", async () => {
    const user = userEvent.setup();
    const secret = "rqp_test_not_a_real_credential";
    second.mockResolvedValue({
      message: "Credential issued.",
      plaintextKey: secret,
      status: "success",
    } satisfies AgentActionState);
    const dialog = await createThroughFirstStep(user);

    await user.click(within(dialog).getByRole("radio", { name: /^API key/u }));
    await user.type(within(dialog).getByLabelText("Credential name"), "CI");
    await user.click(
      within(dialog).getByRole("button", { name: "Issue one-time key" }),
    );
    await waitFor(() => expect(second).toHaveBeenCalled());
    expect(entries(second)).toMatchObject({
      agentPrincipalId: created.id,
      idempotencyKey: `${key}:issue`,
      projectId: created.projectId,
    });

    const oneTime = await screen.findByRole("dialog", {
      name: "Copy this credential now",
    });
    expect(within(oneTime).getByText(secret)).toBeInTheDocument();
    await user.click(within(oneTime).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Copy this credential now" }),
      ).toBeNull(),
    );

    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(
      await within(dialog).findByText(
        `claude mcp add --transport http requestport ${endpoints.mcp}`,
      ),
    ).toBeInTheDocument();
    // No command carries the key, or a reference the shell would expand into
    // the command's arguments: the connection guide says never to put a
    // credential in a command argument.
    expect(within(dialog).queryByText(/--header/u)).toBeNull();
    expect(within(dialog).queryByText(/REQUESTPORT_API_KEY/u)).toBeNull();
    expect(screen.queryByText(secret)).toBeNull();
  });

  test("finds the new agent by the slug the schema stores, trimmed and lower-cased", async () => {
    const user = userEvent.setup();
    const dialog = await createThroughFirstStep(user, "Claude-Code ");

    expect(entries(action)).toMatchObject({ slug: "Claude-Code " });
    expect(within(dialog).getByText(/choose Claude Code/u)).toBeInTheDocument();
  });

  test("ends with the endpoints to copy and the Claude Code command", async () => {
    const user = userEvent.setup();
    const dialog = await createThroughFirstStep(user);

    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(
      await within(dialog).findByText(
        `claude mcp add --transport http requestport ${endpoints.mcp}`,
      ),
    ).toBeInTheDocument();
    for (const [label, url] of [
      ["MCP endpoint", endpoints.mcp],
      ["REST base URL", endpoints.rest],
    ]) {
      expect(within(dialog).getByText(url)).toBeInTheDocument();
      // userEvent.setup() stands a clipboard in for the browser's, so what
      // each control copied can be read back.
      await user.click(
        within(dialog).getByRole("button", { name: `Copy the ${label}` }),
      );
      await waitFor(async () =>
        expect(await navigator.clipboard.readText()).toBe(url),
      );
    }
    expect(
      within(dialog).getByRole("link", { name: "Manage Claude Code" }),
    ).toHaveAttribute("href", `/agents/${created.id}`);

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("starts again from an empty form when it is opened again", async () => {
    const user = userEvent.setup();
    const dialog = await createThroughFirstStep(user);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Connect an agent" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByLabelText("Display name")).toHaveValue("");
    expect(within(reopened).queryByRole("radiogroup")).toBeNull();
  });
});
