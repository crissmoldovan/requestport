import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { OperatorActionState } from "../app/(app)/settings/operators/action-state.js";
import {
  IssueOperatorCredentialDialog,
  OperatorCredentialActions,
} from "./operator-credentials.js";

/**
 * The operator credential controls, driven the way a person drives them
 * (Plan 13, F.3): issuance opens in a dialog from the page's "Issue key"
 * (ruling 259) and carries the page-minted key and version zero, the one-time
 * key is shown once, rotation is offered only to the credential's issuer, and
 * an unavailable answer is drawn as a notice, never an error.
 */

/** Opens the issuance dialog the way a person does, and hands it back. */
async function openIssuance(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Issue key" }));
  return await screen.findByRole("dialog", { name: "Issue an operator key" });
}

const idle: OperatorActionState = { message: "", status: "idle" };
const key = "web:operators:00000000-0000-4000-8000-000000000001";
const credentialId = "00000000-0000-4000-8000-0000000000c1";

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
  return [...data.entries()].map(([name, value]) => [name, String(value)]);
}

const action = vi.fn();
const secondAction = vi.fn();

beforeEach(() => {
  action.mockReset();
  action.mockResolvedValue(idle);
  secondAction.mockReset();
  secondAction.mockResolvedValue(idle);
});

describe("issuing an operator credential", () => {
  test("submits the name, reach, lifetime and chosen scopes with version zero and the page's key", async () => {
    const user = userEvent.setup();
    mount(
      <IssueOperatorCredentialDialog
        action={action}
        idempotencyKey={key}
        projects={[{ id: "00000000-0000-4000-8000-0000000000b1", name: "Web" }]}
        scopes={["operator:revoke"]}
      />,
    );

    await openIssuance(user);
    await user.type(screen.getByLabelText("Credential name"), "Nightly");
    await user.click(screen.getByRole("checkbox", { name: "operator:revoke" }));
    await user.click(
      screen.getByRole("button", { name: "Issue one-time key" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual(
      expect.arrayContaining([
        ["expectedVersion", "0"],
        ["idempotencyKey", key],
        ["name", "Nightly"],
        ["expiresInDays", "30"],
        ["scopes", "operator:revoke"],
      ]),
    );
  });

  test("shows the key once, in a dialog", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      status: "success",
      message: "Operator credential created.",
      plaintextKey: "rpo_one_time_secret",
    });
    mount(
      <IssueOperatorCredentialDialog
        action={action}
        idempotencyKey={key}
        projects={[]}
        scopes={["operator:revoke"]}
      />,
    );

    await openIssuance(user);
    await user.type(screen.getByLabelText("Credential name"), "Nightly");
    await user.click(
      screen.getByRole("button", { name: "Issue one-time key" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Copy this operator key now",
    });
    expect(dialog.textContent).toContain("rpo_one_time_secret");
    // The form's own dialog has closed: the key's is the only one left.
    // Asked with `hidden`, because the key's modal dialog hides the rest of
    // the page from the accessibility tree, and a form dialog still open
    // under it would not be found without it.
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          hidden: true,
          name: "Issue an operator key",
        }),
      ).toBeNull(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByText("rpo_one_time_secret")).toBeNull(),
    );
  });

  test("draws an unavailable answer as a notice, not an error", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      status: "unavailable",
      reason: "switched-off",
      message: "Operator credentials are switched off in this deployment.",
    });
    mount(
      <IssueOperatorCredentialDialog
        action={action}
        idempotencyKey={key}
        projects={[]}
        scopes={["operator:revoke"]}
      />,
    );

    await openIssuance(user);
    await user.type(screen.getByLabelText("Credential name"), "Nightly");
    await user.click(
      screen.getByRole("button", { name: "Issue one-time key" }),
    );

    expect((await screen.findByRole("status")).textContent).toContain(
      "switched off",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the issuance dialog", () => {
  test("shows a refusal only on the opening it answered: reopened, the form starts with none", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "name",
      message: "Name the credential.",
      status: "error",
    } satisfies OperatorActionState);
    mount(
      <IssueOperatorCredentialDialog
        action={action}
        idempotencyKey={key}
        projects={[]}
        scopes={["operator:revoke"]}
      />,
    );

    let dialog = await openIssuance(user);
    await user.type(within(dialog).getByLabelText("Credential name"), "x");
    await user.click(
      within(dialog).getByRole("button", { name: "Issue one-time key" }),
    );
    expect(
      await within(dialog).findByText("Name the credential."),
    ).toHaveAttribute("data-slot", "field-error");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Issue an operator key" }),
      ).toBeNull(),
    );

    dialog = await openIssuance(user);
    expect(within(dialog).getByLabelText("Credential name")).toHaveValue("");
    expect(within(dialog).queryByText("Name the credential.")).toBeNull();

    // A refusal of what is sent from this opening is shown again.
    await user.type(within(dialog).getByLabelText("Credential name"), "y");
    await user.click(
      within(dialog).getByRole("button", { name: "Issue one-time key" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(
      await within(dialog).findByText("Name the credential."),
    ).toHaveAttribute("data-slot", "field-error");
  });

  test("opens Reach as a listbox assistive technology can reach", async () => {
    // The dialog is not modal: a modal one hides every other child of
    // <body>, and a cue-ui Select portals through a <body> child it appended
    // when it mounted, with the dialog, so its listbox would open hidden.
    const user = userEvent.setup();
    mount(
      <IssueOperatorCredentialDialog
        action={action}
        idempotencyKey={key}
        projects={[{ id: "00000000-0000-4000-8000-0000000000b1", name: "Web" }]}
        scopes={["operator:revoke"]}
      />,
    );

    const dialog = await openIssuance(user);
    await user.click(within(dialog).getByRole("combobox", { name: "Reach" }));

    const reach = await screen.findByRole("listbox");
    expect(reach.closest('[aria-hidden="true"]')).toBeNull();
    await user.click(within(reach).getByRole("option", { name: "Only Web" }));
    expect(
      within(dialog).getByRole("combobox", { name: "Reach" }),
    ).toHaveTextContent("Only Web");
  });
});

describe("where issuance opens", () => {
  test("draws only the Issue key action until it is pressed", async () => {
    const user = userEvent.setup();
    mount(
      <IssueOperatorCredentialDialog
        action={action}
        idempotencyKey={key}
        projects={[]}
        scopes={["operator:revoke"]}
      />,
    );

    expect(screen.queryByLabelText("Credential name")).toBeNull();
    const dialog = await openIssuance(user);
    expect(within(dialog).getByLabelText("Credential name")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Issue one-time key" }),
    ).toBeTruthy();
  });
});

describe("a listed credential's controls", () => {
  test("offers rotation to the issuer only, and revocation to everyone permitted", () => {
    const { unmount } = mount(
      <OperatorCredentialActions
        credentialId={credentialId}
        expectedVersion={1}
        mayRotate={false}
        revokeAction={action}
        revokeIdempotencyKey={key}
        rotateAction={secondAction}
        rotateIdempotencyKey={`${key}:rotate`}
      />,
    );
    expect(screen.queryByRole("button", { name: /Rotate key/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke key" })).toBeTruthy();
    unmount();

    mount(
      <OperatorCredentialActions
        credentialId={credentialId}
        expectedVersion={1}
        mayRotate
        revokeAction={action}
        revokeIdempotencyKey={key}
        rotateAction={secondAction}
        rotateIdempotencyKey={`${key}:rotate`}
      />,
    );
    expect(screen.getByRole("button", { name: /Rotate key/u })).toBeTruthy();
  });

  test("revokes only after the confirmation, carrying the credential's version", async () => {
    const user = userEvent.setup();
    mount(
      <OperatorCredentialActions
        credentialId={credentialId}
        expectedVersion={3}
        mayRotate
        revokeAction={action}
        revokeIdempotencyKey={key}
        rotateAction={secondAction}
        rotateIdempotencyKey={`${key}:rotate`}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke key" }));
    expect(action).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    await user.click(
      [...confirm.querySelectorAll("button")].find(
        (button) => button.textContent === "Revoke key",
      ) as HTMLButtonElement,
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual([
      ["credentialId", credentialId],
      ["expectedVersion", "3"],
      ["idempotencyKey", key],
    ]);
  });
});
