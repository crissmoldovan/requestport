import { ThemeProvider } from "@cueplusplus/ui/system";
import type {
  OrganizationMember,
  PendingInvitation,
} from "@requestport/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { MemberActionState } from "../app/(app)/settings/members/action-state.js";
import {
  MemberManagementForm,
  RevokeInvitationForm,
} from "./member-management.js";

/**
 * Organization access, changed the way an owner changes it.
 *
 * Both controls here sit inside a table row whose column heading already names
 * them, which is the one case §7 lets a control carry an `aria-label` instead
 * of its own visible field. Revoking is destructive but reversible — the person
 * can be added again — so it arms and confirms in place rather than opening a
 * modal.
 */

const idle: MemberActionState = { message: "", status: "idle" };

const member: OrganizationMember = {
  email: "member@example.com",
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

const action = vi.fn();

beforeEach(() => {
  action.mockReset();
  action.mockResolvedValue(idle);
});

describe("changing a member's role", () => {
  test("names the role control by the person it belongs to", () => {
    mount(
      <MemberManagementForm
        action={action}
        actorRole="owner"
        currentUserId="user_1"
        idempotencyKey={key}
        member={member}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace" }),
    ).toBeInTheDocument();
  });

  test("keeps the command metadata every write is checked against", async () => {
    const user = userEvent.setup();
    mount(
      <MemberManagementForm
        action={action}
        actorRole="owner"
        currentUserId="user_1"
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
    await user.click(screen.getByRole("button", { name: "Save role" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "3",
      idempotencyKey: key,
      role: "admin",
      status: "active",
      userId: "user_2",
    });
  });

  test("offers the owner role only to an owner", async () => {
    const user = userEvent.setup();
    mount(
      <MemberManagementForm
        action={action}
        actorRole="admin"
        currentUserId="user_1"
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

  test("hides an owner's access entirely from an admin", () => {
    mount(
      <MemberManagementForm
        action={action}
        actorRole="admin"
        currentUserId="user_1"
        idempotencyKey={key}
        member={{ ...member, role: "owner" }}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("never offers a person the control that revokes their own access", () => {
    mount(
      <MemberManagementForm
        action={action}
        actorRole="owner"
        currentUserId="user_2"
        idempotencyKey={key}
        member={member}
      />,
    );

    expect(screen.queryByRole("button", { name: /Revoke/u })).toBeNull();
  });

  test("arms before it revokes, and submits the revoked status once", async () => {
    const user = userEvent.setup();
    mount(
      <MemberManagementForm
        action={action}
        actorRole="owner"
        currentUserId="user_1"
        idempotencyKey={key}
        member={member}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(action).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({
      expectedVersion: "3",
      status: "revoked",
      userId: "user_2",
    });
  });

  test("reports a rejected change as text beside the controls", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "The record changed. Refresh and try again.",
      status: "error",
    } satisfies MemberActionState);
    mount(
      <MemberManagementForm
        action={action}
        actorRole="owner"
        currentUserId="user_1"
        idempotencyKey={key}
        member={member}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save role" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The record changed. Refresh and try again.",
    );
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
});
