import { Dialog } from "@cueplusplus/ui/overlays";
import { ThemeProvider } from "@cueplusplus/ui/system";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import type { WebhookActionState } from "../app/(app)/webhooks/webhook-action-state.js";
import {
  CreateWebhookForm,
  WebhookActions,
  WebhookReplayButton,
} from "./webhook-management.js";

/**
 * The webhook controls, driven the way an administrator drives them.
 *
 * The server action is the one thing replaced here: each test decides what a
 * submission answers with and then asserts where that answer lands — the
 * rejected control's own error line, the fixed banner, or the one-time dialog
 * that is the only place a signing secret is ever shown.
 */

const idle: WebhookActionState = { message: "", status: "idle" };
const key = "web:fixture:00000000-0000-4000-8000-000000000001";
const subscriptionId = "00000000-0000-4000-8000-000000000101";

const projects = [
  { id: "00000000-0000-4000-8000-000000000201", name: "Platform" },
  { id: "00000000-0000-4000-8000-000000000202", name: "Console" },
];

const lanes = [
  {
    id: "00000000-0000-4000-8000-000000000301",
    name: "release",
    projectId: projects[0]?.id ?? "",
  },
  {
    id: "00000000-0000-4000-8000-000000000302",
    name: "hotfix",
    projectId: projects[1]?.id ?? "",
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

/**
 * The FormData one mocked action received, keyed by field name.
 *
 * A repeated key keeps every value it carried rather than only the last one.
 * `laneIds` is a repeated field — a lane filter is a set — and flattening it
 * would make a form that emitted one lane out of two indistinguishable from one
 * that emitted both.
 */
function submitted(action: { mock: { calls: unknown[][] } }) {
  const data = action.mock.calls.at(-1)?.[1] as FormData | undefined;
  if (!data) throw new Error("the action was never invoked");

  return Object.fromEntries(
    [...new Set(data.keys())].map((name) => {
      const values = data.getAll(name).map(String);

      return [name, values.length === 1 ? values[0] : values];
    }),
  );
}

/** Picks one row out of a portalled listbox by its visible label. */
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

/** Picks several rows out of one portalled listbox, then closes it. */
async function chooseAll(
  user: ReturnType<typeof userEvent.setup>,
  control: string,
  options: readonly RegExp[],
) {
  await user.click(screen.getByRole("combobox", { name: control }));
  const listbox = await screen.findByRole("listbox");
  for (const option of options) {
    await user.click(within(listbox).getByRole("option", { name: option }));
  }
  await user.keyboard("{Escape}");
}

const action = vi.fn();
const rotateAction = vi.fn();
const statusAction = vi.fn();

const actions = {
  idempotencyKeys: { rotate: key, status: key, verify: key },
  rotateAction,
  statusAction,
  verifyAction: action,
};

beforeEach(() => {
  for (const mock of [action, rotateAction, statusAction]) {
    mock.mockReset();
    mock.mockResolvedValue(idle);
  }
});

/**
 * Drives one creation whose answer carries a signing secret, and hands back
 * the dialog that secret is shown in — the only place it is ever shown.
 */
async function reveal(
  user: ReturnType<typeof userEvent.setup>,
  plaintextSecret: string,
) {
  action.mockResolvedValue({
    message: "Webhook created.",
    plaintextSecret,
    status: "success",
  } satisfies WebhookActionState);
  mount(
    <CreateWebhookForm
      action={action}
      idempotencyKey={key}
      lanes={lanes}
      projects={projects}
    />,
  );

  await user.type(screen.getByLabelText("Name"), "Release feed");
  await user.type(
    screen.getByLabelText("Endpoint URL"),
    "https://hooks.example.invalid/requestport",
  );
  await user.click(screen.getByRole("button", { name: "Create webhook" }));

  return screen.findByRole("dialog");
}

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

/**
 * Wraps the real dialog root for one test, recording the props the component
 * hands it and every close Base UI reports back through it.
 *
 * Two things about `disablePointerDismissal` make this necessary. It has no DOM
 * projection, and while the dialog is open-controlled a refused outside press
 * and an ignored one look identical on screen — so the only honest evidence
 * that a scrim press was refused is that the dialog was never asked to close.
 * The real component still renders the real dialog; this observes the boundary
 * between them rather than replacing either.
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
 * obeyed. This spends that window with an order of magnitude to spare, and each
 * test that uses it closes the dialog for real afterwards, which proves the
 * unmount it waited for is live.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  });
}

describe("creating a webhook subscription", () => {
  test("names every visible control through its own field", () => {
    mount(
      <CreateWebhookForm
        action={action}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Event types")).toBeInTheDocument();
    expect(screen.getByLabelText("Request types")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Scope" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Lane filters" }),
    ).toBeInTheDocument();
  });

  test("submits the scope, the lane filters, and the command metadata", async () => {
    const user = userEvent.setup();
    mount(
      <CreateWebhookForm
        action={action}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Release feed");
    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://hooks.example.invalid/requestport",
    );
    await user.type(screen.getByLabelText("Event types"), "request.created.v1");
    await choose(user, "Scope", "Platform");
    await chooseAll(user, "Lane filters", [/release/u, /hotfix/u]);
    await user.click(screen.getByRole("button", { name: "Create webhook" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    // Both lanes travel, as two entries under one name: a lane filter is a set,
    // and a submission carrying only the last one chosen would silently narrow
    // what the subscription receives.
    expect(submitted(action)).toEqual({
      endpointUrl: "https://hooks.example.invalid/requestport",
      eventTypes: "request.created.v1",
      expectedVersion: "0",
      idempotencyKey: key,
      laneIds: [lanes[0]?.id ?? "", lanes[1]?.id ?? ""],
      name: "Release feed",
      projectId: projects[0]?.id ?? "",
      requestTypes: "",
    });
  });

  test("puts a rejected endpoint on the endpoint's own error line", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "endpointUrl",
      message: "That endpoint resolves to a private address.",
      status: "error",
    } satisfies WebhookActionState);
    mount(
      <CreateWebhookForm
        action={action}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Release feed");
    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://hooks.example.invalid/requestport",
    );
    await user.click(screen.getByRole("button", { name: "Create webhook" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const line = await screen.findByText(
      "That endpoint resolves to a private address.",
    );
    expect(line).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("keeps a failure about the subscription as a whole in the banner", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "Only organization owners and admins can manage webhooks.",
      status: "error",
    } satisfies WebhookActionState);
    mount(
      <CreateWebhookForm
        action={action}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Release feed");
    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://hooks.example.invalid/requestport",
    );
    await user.click(screen.getByRole("button", { name: "Create webhook" }));

    expect(
      within(await screen.findByRole("alert")).getByText(
        "Only organization owners and admins can manage webhooks.",
      ),
    ).toBeInTheDocument();
  });

  test("names the work and refuses a second press while a creation is in flight", async () => {
    const user = userEvent.setup();
    const release = hold(action);
    mount(
      <CreateWebhookForm
        action={action}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Release feed");
    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://hooks.example.invalid/requestport",
    );
    await user.click(screen.getByRole("button", { name: "Create webhook" }));

    expect(
      await screen.findByRole("button", { name: "Creating…" }),
    ).toBeDisabled();

    release();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create webhook" }),
      ).toBeEnabled(),
    );
  });

  test("shows a new signing secret once, in a dialog, and never again", async () => {
    const user = userEvent.setup();
    const plaintextSecret = "whsec_00000000000000000000000000000000";
    const dialog = await reveal(user, plaintextSecret);
    expect(within(dialog).getByText(plaintextSecret)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(document.body.textContent).not.toContain(plaintextSecret);
  });

  test("keeps the secret on screen when Escape is pressed", async () => {
    const user = userEvent.setup();
    const watched = watchDialog();
    const plaintextSecret = "whsec_22222222222222222222222222222222";
    const dialog = await reveal(user, plaintextSecret);

    await user.keyboard("{Escape}");

    // Escape does reach the dialog — it is the dismissal that is refused, not
    // the gesture that is missing.
    expect(watched.closes).toEqual(["escape-key"]);
    await settle();

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText(plaintextSecret)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  test("keeps the secret on screen when the scrim behind it is pressed", async () => {
    const user = userEvent.setup();
    const watched = watchDialog();
    const plaintextSecret = "whsec_33333333333333333333333333333333";
    const dialog = await reveal(user, plaintextSecret);
    const scrim = document.querySelector('[data-slot="dialog-backdrop"]');
    if (!scrim) throw new Error("the dialog drew no scrim");

    expect(watched.props().disablePointerDismissal).toBe(true);

    await user.click(scrim);
    await settle();

    // Nothing was reported at all: without the guard the same press arrives as
    // `outside-press`.
    expect(watched.closes).toEqual([]);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText(plaintextSecret)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("operating one subscription", () => {
  test("offers verification only while the endpoint is unproven", async () => {
    const user = userEvent.setup();
    mount(
      <WebhookActions
        {...actions}
        expectedVersion={1}
        id={subscriptionId}
        status="pending_verification"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Rotate secret" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "1",
      id: subscriptionId,
      idempotencyKey: key,
    });
  });

  test("names the work and refuses a second press while a verification is in flight", async () => {
    const user = userEvent.setup();
    const release = hold(action);
    mount(
      <WebhookActions
        {...actions}
        expectedVersion={1}
        id={subscriptionId}
        status="pending_verification"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(
      await screen.findByRole("button", { name: "Verifying…" }),
    ).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Verify" })).toBeEnabled(),
    );
  });

  test("arms a rotation in place, because the previous secret keeps working", async () => {
    const user = userEvent.setup();
    mount(
      <WebhookActions
        {...actions}
        expectedVersion={4}
        id={subscriptionId}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rotate secret" }));
    expect(rotateAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(rotateAction).toHaveBeenCalled());
    expect(submitted(rotateAction)).toEqual({
      expectedVersion: "4",
      id: subscriptionId,
      idempotencyKey: key,
      overlapMinutes: "60",
    });
  });

  test("shows a rotated secret once and drops it on dismissal", async () => {
    const user = userEvent.setup();
    const plaintextSecret = "whsec_11111111111111111111111111111111";
    rotateAction.mockResolvedValue({
      message: "Next secret created.",
      plaintextSecret,
      status: "success",
    } satisfies WebhookActionState);
    mount(
      <WebhookActions
        {...actions}
        expectedVersion={4}
        id={subscriptionId}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rotate secret" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(plaintextSecret)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(document.body.textContent).not.toContain(plaintextSecret);
  });

  test("carries the status the toggle is asking the server to move to", async () => {
    const user = userEvent.setup();
    mount(
      <WebhookActions
        {...actions}
        expectedVersion={4}
        id={subscriptionId}
        status="active"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(statusAction).toHaveBeenCalled());
    expect(submitted(statusAction)).toMatchObject({ status: "disabled" });
  });

  test("offers nothing but the record once a subscription is revoked", () => {
    mount(
      <WebhookActions
        {...actions}
        expectedVersion={9}
        id={subscriptionId}
        status="revoked"
      />,
    );

    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

describe("replaying one delivery", () => {
  test("carries the delivery and its own idempotency key", async () => {
    const user = userEvent.setup();
    mount(
      <WebhookReplayButton
        action={action}
        deliveryId="00000000-0000-4000-8000-000000000401"
        idempotencyKey={key}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Replay" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      deliveryId: "00000000-0000-4000-8000-000000000401",
      expectedVersion: "0",
      idempotencyKey: key,
    });
  });

  test("reports a failed delivery replay as text beside the control", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "That webhook delivery is no longer available.",
      status: "error",
    } satisfies WebhookActionState);
    mount(
      <WebhookReplayButton
        action={action}
        deliveryId="00000000-0000-4000-8000-000000000401"
        idempotencyKey={key}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Replay" }));

    expect(
      within(await screen.findByRole("alert")).getByText(
        "That webhook delivery is no longer available.",
      ),
    ).toBeInTheDocument();
  });
});
