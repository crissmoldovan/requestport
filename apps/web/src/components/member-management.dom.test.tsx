import { ThemeProvider } from "@cueplusplus/ui/system";
import type {
  OrganizationMember,
  PendingInvitation,
} from "@requestport/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { MemberActionState } from "../app/(app)/settings/members/action-state.js";
import { ConsoleToasts } from "./console-toasts.js";
import {
  MemberActionsMenu,
  MemberRoleControl,
  ResendInvitationForm,
  RevokeInvitationForm,
} from "./member-management.js";

/**
 * Organization access, changed the way an owner changes it (ruling 259).
 *
 * Every control here sits inside a table row whose column heading already
 * names it, which is the one case §7 lets a control carry an `aria-label`
 * instead of its own visible field. A role is changed by choosing it — the
 * choice is the write, and a toast confirms it — and revoking a person's
 * access sits in the row's menu behind a confirmation dialog. Revoking an
 * invitation still arms in place.
 */

const idle: MemberActionState = { message: "", status: "idle" };

const member: OrganizationMember = {
  email: "member@example.com",
  joinedAt: new Date("2026-05-01T09:00:00.000Z"),
  name: "Ada Lovelace",
  role: "member",
  userId: "user_2",
  version: 3,
};

const invitation: PendingInvitation = {
  email: "pending@example.com",
  expiresAt: new Date("2026-08-23T12:00:00.000Z"),
  id: "00000000-0000-4000-8000-0000000000f1",
  role: "member",
  version: 1,
};

const key = "web:fixture:00000000-0000-4000-8000-000000000001";

function mount(node: ReactNode) {
  return render(
    <ThemeProvider
      density="ultra-compact"
      mode="system"
      persistPreferences={false}
      theme="requestport"
    >
      <ConsoleToasts>{node}</ConsoleToasts>
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

/**
 * A confirmation, found in the toast viewport: the sentence must still be on
 * screen there, whatever happened to the control that asked for it.
 */
async function toastSaying(text: string) {
  return within(
    screen.getByRole("region", { name: "Notifications" }),
  ).findByText(text);
}

/** Lets Base UI's timers run, for a case that asserts something did not happen. */
function settle(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const action = vi.fn();

beforeEach(() => {
  action.mockReset();
  action.mockResolvedValue(idle);
});

describe("changing a member's role", () => {
  test("names the role control by the person it belongs to", () => {
    mount(
      <MemberRoleControl
        action={action}
        actorRole="owner"
        idempotencyKey={key}
        member={member}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace" }),
    ).toBeInTheDocument();
  });

  test("saves the role it is changed to at once, with the command metadata, and draws no save button", async () => {
    const user = userEvent.setup();
    mount(
      <MemberRoleControl
        action={action}
        actorRole="owner"
        idempotencyKey={key}
        member={member}
      />,
    );

    expect(screen.queryByRole("button", { name: /Save/u })).toBeNull();
    await user.click(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Admin",
      }),
    );

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(submitted(action)).toEqual({
      expectedVersion: "3",
      idempotencyKey: key,
      role: "admin",
      status: "active",
      userId: "user_2",
    });
  });

  test("confirms a saved role in a toast", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "Member role updated.",
      status: "success",
    } satisfies MemberActionState);
    mount(
      <MemberRoleControl
        action={action}
        actorRole="owner"
        idempotencyKey={key}
        member={member}
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Admin",
      }),
    );

    expect(
      await screen.findByText("Ada Lovelace is now Admin."),
    ).toBeInTheDocument();
  });

  test("offers the owner role only to an owner", async () => {
    const user = userEvent.setup();
    mount(
      <MemberRoleControl
        action={action}
        actorRole="admin"
        idempotencyKey={key}
        member={member}
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace" }),
    );
    expect(
      within(await screen.findByRole("listbox")).queryByRole("option", {
        name: "Owner",
      }),
    ).toBeNull();
  });

  test("shows an admin an owner's role and no control to change it", () => {
    mount(
      <MemberRoleControl
        action={action}
        actorRole="admin"
        idempotencyKey={key}
        member={{ ...member, role: "owner" }}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  test("reports a rejected change as text beside the control, and puts the role back", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "The record changed. Refresh and try again.",
      status: "error",
    } satisfies MemberActionState);
    mount(
      <MemberRoleControl
        action={action}
        actorRole="owner"
        idempotencyKey={key}
        member={member}
      />,
    );

    const role = screen.getByRole("combobox", {
      name: "Role for Ada Lovelace",
    });
    await user.click(role);
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Admin",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The record changed. Refresh and try again.",
    );
    await waitFor(() => expect(role).toHaveTextContent("Member"));
  });

  test("writes nothing when a letter is typed on the closed control", async () => {
    // Base UI's Select chooses the option a letter typed on its closed
    // trigger matches, without opening, and here a choice is a write: "o"
    // would make the person an owner with no listbox ever drawn.
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "Member role updated.",
      status: "success",
    } satisfies MemberActionState);
    mount(
      <MemberRoleControl
        action={action}
        actorRole="owner"
        idempotencyKey={key}
        member={member}
      />,
    );

    const role = screen.getByRole("combobox", {
      name: "Role for Ada Lovelace",
    });
    role.focus();
    // Base UI mounts the options typeahead reads when the trigger is focused,
    // after a timer of its own.
    await settle(50);
    await user.keyboard("o");
    await settle(300);

    expect(action).not.toHaveBeenCalled();
    expect(role).toHaveTextContent("Member");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("Ada Lovelace is now Owner.")).toBeNull();
  });

  test("still takes a role chosen with the keyboard in the open listbox", async () => {
    const user = userEvent.setup();
    mount(
      <MemberRoleControl
        action={action}
        actorRole="owner"
        idempotencyKey={key}
        member={member}
      />,
    );

    screen.getByRole("combobox", { name: "Role for Ada Lovelace" }).focus();
    await user.keyboard("{ArrowDown}");
    const roles = await screen.findByRole("listbox");
    await user.keyboard("a");
    await waitFor(() =>
      expect(
        within(roles).getByRole("option", { name: "Admin" }),
      ).toHaveAttribute("data-highlighted"),
    );
    await user.keyboard("{Enter}");

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(submitted(action)).toMatchObject({
      role: "admin",
      userId: "user_2",
    });
  });
});

describe("revoking a member's access", () => {
  test("asks in a dialog from the row's menu, then submits the revoked status once", async () => {
    const user = userEvent.setup();
    mount(
      <MemberActionsMenu
        action={action}
        idempotencyKey={key}
        member={member}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "More for Ada Lovelace" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Revoke access…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Revoke Ada Lovelace’s access?");
    expect(action).not.toHaveBeenCalled();

    await user.click(
      within(dialog).getByRole("button", { name: "Revoke access" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(submitted(action)).toEqual({
      expectedVersion: "3",
      idempotencyKey: key,
      role: "member",
      status: "revoked",
      userId: "user_2",
    });
  });

  test("keeps the access when the dialog is dismissed", async () => {
    const user = userEvent.setup();
    mount(
      <MemberActionsMenu
        action={action}
        idempotencyKey={key}
        member={member}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "More for Ada Lovelace" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Revoke access…" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Keep access",
      }),
    );

    expect(action).not.toHaveBeenCalled();
  });

  test("confirms the revocation in a toast, though the row leaves the list in the same answer", async () => {
    const user = userEvent.setup();
    const page = { removeRow: () => {} };
    action.mockImplementation(async () => {
      // What the action's revalidation does in the same answer: the page
      // lists active members only, so it comes back without this row.
      page.removeRow();
      return {
        message: "Access revoked.",
        status: "success",
      } satisfies MemberActionState;
    });
    function Rows() {
      const [rows, setRows] = useState([member]);
      page.removeRow = () => setRows([]);
      return (
        <>
          {rows.map((row) => (
            <MemberActionsMenu
              action={action}
              idempotencyKey={key}
              key={row.userId}
              member={row}
            />
          ))}
        </>
      );
    }
    mount(<Rows />);

    await user.click(
      screen.getByRole("button", { name: "More for Ada Lovelace" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Revoke access…" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke access",
      }),
    );

    expect(await toastSaying("Access revoked.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More for Ada Lovelace" }),
    ).toBeNull();
  });
});

describe("revoking a pending invitation", () => {
  test("arms before it revokes and keeps the invitation's own version", async () => {
    const user = userEvent.setup();
    mount(
      <RevokeInvitationForm
        action={action}
        idempotencyKey={key}
        invitation={invitation}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke invitation" }));
    expect(action).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "1",
      idempotencyKey: key,
      invitationId: invitation.id,
    });
  });

  test("confirms the revocation in a toast, though the row leaves the list in the same answer", async () => {
    const user = userEvent.setup();
    const page = { removeRow: () => {} };
    action.mockImplementation(async () => {
      // The page lists unrevoked invitations only, so the answer that
      // revokes this one comes back without its row.
      page.removeRow();
      return {
        message: "Invitation revoked.",
        status: "success",
      } satisfies MemberActionState;
    });
    function Rows() {
      const [rows, setRows] = useState([invitation]);
      page.removeRow = () => setRows([]);
      return (
        <>
          {rows.map((row) => (
            <RevokeInvitationForm
              action={action}
              idempotencyKey={key}
              invitation={row}
              key={row.id}
            />
          ))}
        </>
      );
    }
    mount(<Rows />);

    await user.click(screen.getByRole("button", { name: "Revoke invitation" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await toastSaying("Invitation revoked.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Revoke invitation" }),
    ).toBeNull();
  });
});

describe("resending a pending invitation (ruling 260)", () => {
  test("resends in one press with the invitation's id, key and version, and confirms it in a toast", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "Invitation resent.",
      status: "success",
    } satisfies MemberActionState);
    mount(
      <ResendInvitationForm
        action={action}
        idempotencyKey={key}
        invitation={invitation}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Resend invitation" }));

    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(submitted(action)).toEqual({
      expectedVersion: "1",
      idempotencyKey: key,
      invitationId: invitation.id,
    });
    expect(await toastSaying("Invitation resent.")).toBeInTheDocument();
  });

  test("holds the control while the resend is in flight, so a second press sends nothing", async () => {
    const user = userEvent.setup();
    let answer: (state: MemberActionState) => void = () => {};
    action.mockImplementation(
      () =>
        new Promise<MemberActionState>((resolve) => {
          answer = resolve;
        }),
    );
    mount(
      <ResendInvitationForm
        action={action}
        idempotencyKey={key}
        invitation={invitation}
      />,
    );
    const control = screen.getByRole("button", { name: "Resend invitation" });

    await user.click(control);
    await waitFor(() => expect(control).toBeDisabled());
    await user.click(control);
    expect(action).toHaveBeenCalledOnce();

    answer({ message: "Invitation resent.", status: "success" });
    await waitFor(() => expect(control).toBeEnabled());
  });

  test("says a refused resend beside the control, and raises no toast", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "That invitation is no longer pending.",
      status: "error",
    } satisfies MemberActionState);
    mount(
      <ResendInvitationForm
        action={action}
        idempotencyKey={key}
        invitation={invitation}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Resend invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That invitation is no longer pending.",
    );
    await settle(50);
    expect(
      within(screen.getByRole("region", { name: "Notifications" })).queryByText(
        "That invitation is no longer pending.",
      ),
    ).toBeNull();
  });
});
