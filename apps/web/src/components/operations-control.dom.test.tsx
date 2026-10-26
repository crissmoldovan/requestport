import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { OperationsActionState } from "../app/(app)/settings/operations/action-state.js";
import { ConsoleToasts } from "./console-toasts.js";
import {
  ReleaseRetentionHoldForm,
  RequeueImportDispatchForm,
  RequeueNotificationForm,
  RequeueOutboxForm,
  RequeueSlackOperationForm,
  RetentionHoldDialog,
  RetentionHoldForm,
} from "./operations-control.js";

/**
 * The recovery controls, driven the way an operator drives them.
 *
 * Requeueing is a recovery action rather than a destructive one, so it stays a
 * single press; every one of them carries the record's own version and the
 * page-minted idempotency key so a double press cannot enqueue the work twice.
 * Nothing here may project a provider payload, a recipient, or a token — the
 * suite asserts that the identifiers are all the forms carry.
 */

const idle: OperationsActionState = { message: "", status: "idle" };
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

/**
 * A confirmation, found in the toast viewport rather than in the form's own
 * result line, which is drawn in the dialog until it closes.
 */
async function toastSaying(text: string) {
  return within(
    screen.getByRole("region", { name: "Notifications" }),
  ).findByText(text);
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

describe("requeueing a stalled record", () => {
  test("carries the outbox identity, version, and idempotency key", async () => {
    const user = userEvent.setup();
    mount(
      <RequeueOutboxForm
        action={action}
        expectedVersion={5}
        idempotencyKey={key}
        outboxId="00000000-0000-4000-8000-000000000201"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Requeue" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "5",
      idempotencyKey: key,
      outboxId: "00000000-0000-4000-8000-000000000201",
    });
  });

  test("carries the channel a failed notification has to be retried on", async () => {
    const user = userEvent.setup();
    mount(
      <RequeueNotificationForm
        action={action}
        channel="slack"
        expectedVersion={2}
        idempotencyKey={key}
        notificationIntentId="00000000-0000-4000-8000-000000000202"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Requeue" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({ channel: "slack" });
  });

  test("carries the exact Slack operation type", async () => {
    const user = userEvent.setup();
    mount(
      <RequeueSlackOperationForm
        action={action}
        expectedVersion={1}
        idempotencyKey={key}
        operationId="00000000-0000-4000-8000-000000000203"
        operationType="message_update"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Requeue" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({
      operationType: "message_update",
    });
  });

  test("carries the dead-lettered import dispatch", async () => {
    const user = userEvent.setup();
    mount(
      <RequeueImportDispatchForm
        action={action}
        dispatchId="00000000-0000-4000-8000-000000000204"
        expectedVersion={3}
        idempotencyKey={key}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Requeue" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({
      dispatchId: "00000000-0000-4000-8000-000000000204",
    });
  });

  test("reports a rejected requeue as text beside the control", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "That record is no longer dead-lettered.",
      status: "error",
    } satisfies OperationsActionState);
    mount(
      <RequeueOutboxForm
        action={action}
        expectedVersion={5}
        idempotencyKey={key}
        outboxId="00000000-0000-4000-8000-000000000201"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Requeue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That record is no longer dead-lettered.",
    );
  });
});

describe("retention holds", () => {
  test("names the category and the preservation reason through their own fields", async () => {
    const user = userEvent.setup();
    mount(<RetentionHoldForm action={action} idempotencyKey={key} />);

    expect(
      screen.getByRole("combobox", { name: "Category" }),
    ).toBeInTheDocument();
    const reason = screen.getByLabelText("Preservation reason");
    expect(reason).toBeRequired();

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Slack OAuth state",
      }),
    );
    await user.type(reason, "Pending legal review");
    await user.click(screen.getByRole("button", { name: "Create hold" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      category: "slack_oauth_state",
      expectedVersion: "0",
      idempotencyKey: key,
      reason: "Pending legal review",
    });
  });

  test("puts a rejected reason on the reason field", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "reason",
      message: "Give a preservation reason of at least eight characters.",
      status: "error",
    } satisfies OperationsActionState);
    mount(<RetentionHoldForm action={action} idempotencyKey={key} />);

    await user.type(screen.getByLabelText("Preservation reason"), "short");
    await user.click(screen.getByRole("button", { name: "Create hold" }));

    expect(
      await screen.findByText(
        "Give a preservation reason of at least eight characters.",
      ),
    ).toHaveAttribute("data-slot", "field-error");
  });

  test("releases an active hold against its own version", async () => {
    const user = userEvent.setup();
    mount(
      <ReleaseRetentionHoldForm
        action={action}
        expectedVersion={4}
        holdId="00000000-0000-4000-8000-000000000205"
        idempotencyKey={key}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Release" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "4",
      holdId: "00000000-0000-4000-8000-000000000205",
      idempotencyKey: key,
    });
  });
});

describe("a new retention hold, from its panel (ruling 259)", () => {
  test("opens in a dialog from Add hold, and closes on success with a toast", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({
      message: "Retention hold created.",
      status: "success",
    } satisfies OperationsActionState);
    mount(
      <RetentionHoldDialog
        action={action}
        idempotencyKey="web:retention:create:fixture-0001"
      />,
    );

    expect(screen.queryByLabelText("Preservation reason")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add hold" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Add a retention hold",
    });
    await user.type(
      within(dialog).getByLabelText("Preservation reason"),
      "Pending legal review",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create hold" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(await toastSaying("Retention hold created.")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Add a retention hold" }),
      ).toBeNull(),
    );
  });
});
