import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { OperatorActionState } from "../app/(app)/settings/operators/action-state.js";
import {
  IssueOperatorCredentialForm,
  OperatorCredentialActions,
} from "./operator-credentials.js";

/**
 * The operator credential controls, driven the way a person drives them
 * (Plan 13, F.3): issuance carries the page-minted key and version zero, the
 * one-time key is shown once, rotation is offered only to the credential's
 * issuer, and an unavailable answer is drawn as a notice, never an error.
 */

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
      <IssueOperatorCredentialForm
        action={action}
        idempotencyKey={key}
        projects={[{ id: "00000000-0000-4000-8000-0000000000b1", name: "Web" }]}
        scopes={["operator:revoke"]}
      />,
    );

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
      <IssueOperatorCredentialForm
        action={action}
        idempotencyKey={key}
        projects={[]}
        scopes={["operator:revoke"]}
      />,
    );

    await user.type(screen.getByLabelText("Credential name"), "Nightly");
    await user.click(
      screen.getByRole("button", { name: "Issue one-time key" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("rpo_one_time_secret");
    await user.click(screen.getByRole("button", { name: "Close" }));
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
      <IssueOperatorCredentialForm
        action={action}
        idempotencyKey={key}
        projects={[]}
        scopes={["operator:revoke"]}
      />,
    );

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
