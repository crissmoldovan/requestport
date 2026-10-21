import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import type { SlackActionState } from "../app/(app)/slack/slack-action-state.js";
import {
  SlackConnectionTestForm,
  SlackInstallationActions,
  SlackMappingForm,
  SlackRouteForm,
} from "./slack-management.js";

/**
 * The Slack controls, driven the way an administrator drives them.
 *
 * Two behaviours are worth pinning beyond the labels. The mapping form derives
 * the expected version from the pair the reader has selected, so changing
 * either half has to change the version the submission carries. And revoking an
 * installation is the one Slack action with no way back — the repository
 * refuses to move a revoked installation anywhere — so it asks in a modal
 * rather than arming in place.
 */

const idle: SlackActionState = { message: "", status: "idle" };
const key = "web:fixture:00000000-0000-4000-8000-000000000001";

const installations = [
  { id: "00000000-0000-4000-8000-000000000201", workspaceName: "CUE++ HQ" },
  { id: "00000000-0000-4000-8000-000000000202", workspaceName: "Field ops" },
];

const members = [
  {
    email: "ada@example.invalid",
    name: "Ada",
    userId: "00000000-0000-4000-8000-0000000000a1",
  },
  {
    email: "grace@example.invalid",
    name: "Grace",
    userId: "00000000-0000-4000-8000-0000000000a2",
  },
];

const projects = [
  { id: "00000000-0000-4000-8000-000000000301", name: "Platform" },
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

  return Object.fromEntries(
    [...data.entries()].map(([name, value]) => [name, String(value)]),
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

beforeEach(() => {
  action.mockReset();
  action.mockResolvedValue(idle);
});

/**
 * Parks the mocked action on a promise the test releases, so the in-flight
 * state can be read while it is genuinely in flight.
 *
 * React 19 entangles every async transition on one lane, so an action left
 * unsettled would stall the next test's state updates too: releasing before
 * the test ends is part of the contract, not tidiness.
 */
function hold(mock: typeof action) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.mockImplementation(async () => {
    await held;
    return idle;
  });
  // A failed assertion must not leave the action parked either: an unreleased
  // hold would stall the next test in this file rather than let it report.
  onTestFinished(() => release());

  return () => release();
}

describe("mapping a Slack identity to a member", () => {
  test("names every visible control through its own field", () => {
    mount(
      <SlackMappingForm
        action={action}
        idempotencyKey={key}
        installations={installations}
        mappings={[]}
        members={members}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "RequestPort user" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Slack member ID")).toBeInTheDocument();
  });

  test("carries the version of the pair the reader has selected", async () => {
    const user = userEvent.setup();
    mount(
      <SlackMappingForm
        action={action}
        idempotencyKey={key}
        installations={installations}
        mappings={[
          {
            installationId: installations[1]?.id ?? "",
            userId: members[1]?.userId ?? "",
            version: 7,
          },
        ]}
        members={members}
      />,
    );

    await choose(user, "Workspace", "Field ops");
    await choose(user, "RequestPort user", /Grace/u);
    await user.type(screen.getByLabelText("Slack member ID"), "U012ABCDEF");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "7",
      idempotencyKey: key,
      installationId: installations[1]?.id ?? "",
      slackUserId: "U012ABCDEF",
      userId: members[1]?.userId ?? "",
    });
  });

  test("names the work and refuses a second press while a save is in flight", async () => {
    const user = userEvent.setup();
    const release = hold(action);
    mount(
      <SlackMappingForm
        action={action}
        idempotencyKey={key}
        installations={installations}
        mappings={[]}
        members={members}
      />,
    );

    await user.type(screen.getByLabelText("Slack member ID"), "U012ABCDEF");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(
      await screen.findByRole("button", { name: "Saving…" }),
    ).toBeDisabled();

    release();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save mapping" }),
      ).toBeEnabled(),
    );
  });

  test("puts a rejected Slack member ID on that control's error line", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "slackUserId",
      message: "A Slack member ID starts with U or W.",
      status: "error",
    } satisfies SlackActionState);
    mount(
      <SlackMappingForm
        action={action}
        idempotencyKey={key}
        installations={installations}
        mappings={[]}
        members={members}
      />,
    );

    await user.type(screen.getByLabelText("Slack member ID"), "nope");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(
      await screen.findByText("A Slack member ID starts with U or W."),
    ).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("choosing where questions are delivered", () => {
  test("defaults to the organization fallback and its own version", async () => {
    const user = userEvent.setup();
    mount(
      <SlackRouteForm
        action={action}
        idempotencyKey={key}
        projects={projects}
        routes={[{ projectId: null, status: "active", version: 3 }]}
      />,
    );

    await choose(user, "Delivery", "Channel");
    await user.type(screen.getByLabelText("Channel ID"), "C012ABCDEF");
    await user.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      channelId: "C012ABCDEF",
      expectedVersion: "3",
      fallback: "email",
      idempotencyKey: key,
      mode: "channel",
      projectId: "",
    });
  });

  test("switches to the project's own version when the scope changes", async () => {
    const user = userEvent.setup();
    mount(
      <SlackRouteForm
        action={action}
        idempotencyKey={key}
        projects={projects}
        routes={[
          { projectId: null, status: "active", version: 3 },
          { projectId: projects[0]?.id ?? "", status: "active", version: 11 },
        ]}
      />,
    );

    await choose(user, "Scope", "Platform");
    await user.click(screen.getByRole("button", { name: "Save route" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({
      expectedVersion: "11",
      projectId: projects[0]?.id ?? "",
    });
  });

  // A change replaces the scope's active route: the old row stays, disabled,
  // and the list the page hands the form holds it, in no stated order. So the
  // form must take the version of the scope's active route. The organisation's
  // three rows are the list the repository returned on a real database after
  // three writes to that route (track-f2.md, F.2.5); the project's are the same
  // pattern after four. A disabled row can share the active one's version, so
  // only the first disabled row of each scope tells the two lookups apart.
  test("carries the active route's version, not a disabled row's listed before it", async () => {
    const user = userEvent.setup();
    const projectId = projects[0]?.id ?? "";
    mount(
      <SlackRouteForm
        action={action}
        idempotencyKey={key}
        projects={projects}
        routes={[
          { projectId: null, status: "disabled", version: 2 },
          { projectId, status: "disabled", version: 2 },
          { projectId: null, status: "disabled", version: 3 },
          { projectId, status: "disabled", version: 3 },
          { projectId, status: "disabled", version: 4 },
          { projectId: null, status: "active", version: 3 },
          { projectId, status: "active", version: 4 },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save route" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(submitted(action)).toMatchObject({
      expectedVersion: "3",
      projectId: "",
    });

    await choose(user, "Scope", "Platform");
    await user.click(screen.getByRole("button", { name: "Save route" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(submitted(action)).toMatchObject({
      expectedVersion: "4",
      projectId,
    });
  });

  test("carries version 0 for a scope whose routes are all disabled", async () => {
    const user = userEvent.setup();
    mount(
      <SlackRouteForm
        action={action}
        idempotencyKey={key}
        projects={projects}
        routes={[{ projectId: null, status: "disabled", version: 2 }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save route" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({
      expectedVersion: "0",
      projectId: "",
    });
  });
});

describe("changing an installation's status", () => {
  test("toggles an active workspace off in one press", async () => {
    const user = userEvent.setup();
    mount(
      <SlackInstallationActions
        action={action}
        expectedVersion={2}
        idempotencyKey={key}
        installationId={installations[0]?.id ?? ""}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "2",
      idempotencyKey: key,
      installationId: installations[0]?.id ?? "",
      status: "disabled",
    });
  });

  test("asks in a modal before a revocation that cannot be taken back", async () => {
    const user = userEvent.setup();
    mount(
      <SlackInstallationActions
        action={action}
        expectedVersion={2}
        idempotencyKey={key}
        installationId={installations[0]?.id ?? ""}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(action).not.toHaveBeenCalled();

    const confirmation = await screen.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", { name: "Revoke workspace" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({ status: "revoked" });
  });

  test("stops the other control while either submission is in flight", async () => {
    const user = userEvent.setup();
    const release = hold(action);
    mount(
      <SlackInstallationActions
        action={action}
        expectedVersion={2}
        idempotencyKey={key}
        installationId={installations[0]?.id ?? ""}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));

    // Both controls carry the same idempotency key and the same expected
    // version, so a second submission while the first is unanswered would ask
    // the server for two different commands under one identity.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Disable" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Revoke" })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled();
  });

  test("stops the status toggle while a revocation is in flight", async () => {
    const user = userEvent.setup();
    const release = hold(action);
    mount(
      <SlackInstallationActions
        action={action}
        expectedVersion={2}
        idempotencyKey={key}
        installationId={installations[0]?.id ?? ""}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke workspace",
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revoke" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Disable" })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
  });

  test("keeps the workspace when the modal is dismissed", async () => {
    const user = userEvent.setup();
    mount(
      <SlackInstallationActions
        action={action}
        expectedVersion={2}
        idempotencyKey={key}
        installationId={installations[0]?.id ?? ""}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Keep it",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(action).not.toHaveBeenCalled();
  });
});

describe("proving the connection works", () => {
  test("queues a test against one workspace and channel", async () => {
    const user = userEvent.setup();
    mount(
      <SlackConnectionTestForm
        action={action}
        idempotencyKey={key}
        installations={installations}
      />,
    );

    await user.type(screen.getByLabelText("Test channel ID"), "C012ABCDEF");
    await user.click(screen.getByRole("button", { name: "Send test" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      channelId: "C012ABCDEF",
      idempotencyKey: key,
      installationId: installations[0]?.id ?? "",
    });
  });

  test("keeps a provider failure in the fixed banner", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "The Slack settings could not be updated.",
      status: "error",
    } satisfies SlackActionState);
    mount(
      <SlackConnectionTestForm
        action={action}
        idempotencyKey={key}
        installations={installations}
      />,
    );

    await user.type(screen.getByLabelText("Test channel ID"), "C012ABCDEF");
    await user.click(screen.getByRole("button", { name: "Send test" }));

    expect(
      within(await screen.findByRole("alert")).getByText(
        "The Slack settings could not be updated.",
      ),
    ).toBeInTheDocument();
  });
});
