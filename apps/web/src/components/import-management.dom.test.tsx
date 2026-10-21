import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import type { ImportActionState } from "../app/(app)/imports/import-action-state.js";
import {
  AnalyzeImportButton,
  ApplyImportForm,
  CorrectImportButton,
  FreezeImportButton,
  ImportEntryReviewForm,
  ImportRunLink,
  SplitImportBundleForm,
} from "./import-management.js";

/**
 * The legacy-import review controls, driven the way a reviewer drives them.
 *
 * Applying a manifest is the one action in the product that rewrites history,
 * so both of its gates are pinned here: freezing asks in a modal, and applying
 * asks the reviewer to type the immutable hash prefix back. Nothing in the
 * review surface may reinterpret a preserved value — the decision, the target
 * and the relationships travel exactly as they were entered.
 */

const idle: ImportActionState = { message: "", status: "idle" };
const key = "web:fixture:00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000101";
const entryId = "00000000-0000-4000-8000-000000000102";
const manifestSha256 =
  "9f2c0b7a4d1e5c6b8a0f3d2e7c1b4a6d8e0f2c4b6a8d0e2f4c6b8a0d2e4f6c8b";

const projects = [
  { id: "00000000-0000-4000-8000-000000000201", name: "Platform" },
  { id: "00000000-0000-4000-8000-000000000202", name: "Console" },
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

const entry = {
  decision: "pending",
  id: entryId,
  parsedJson: {} as Record<string, unknown>,
  proposedCanonicalId: null as string | null,
  version: 4,
};

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

describe("queuing an analysis", () => {
  test("carries the preserved snapshot and its source", async () => {
    const user = userEvent.setup();
    mount(
      <AnalyzeImportButton
        action={action}
        idempotencyKey={key}
        snapshotId="00000000-0000-4000-8000-000000000301"
        sourceId="00000000-0000-4000-8000-000000000302"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "0",
      idempotencyKey: key,
      snapshotId: "00000000-0000-4000-8000-000000000301",
      sourceId: "00000000-0000-4000-8000-000000000302",
    });
  });
});

describe("reviewing one proposed record", () => {
  test("names every visible control through its own field", () => {
    mount(
      <ImportEntryReviewForm
        action={action}
        entry={entry}
        idempotencyKey={key}
        projects={projects}
        runId={runId}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Decision" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Target project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Existing canonical request UUID"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Reviewed relationships")).toBeInTheDocument();
  });

  test("submits the decision, the target, and the relationships verbatim", async () => {
    const user = userEvent.setup();
    mount(
      <ImportEntryReviewForm
        action={action}
        entry={entry}
        idempotencyKey={key}
        projects={projects}
        runId={runId}
      />,
    );

    await choose(user, "Decision", "Confirm existing mapping");
    await choose(user, "Target project", "Console");
    await user.type(
      screen.getByLabelText("Existing canonical request UUID"),
      "00000000-0000-4000-8000-000000000401",
    );
    await user.type(
      screen.getByLabelText("Reviewed relationships"),
      "derived_from:00000000-0000-4000-8000-000000000402",
    );
    await user.click(screen.getByRole("button", { name: "Save decision" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      decision: "map_existing",
      entryId,
      expectedVersion: "4",
      idempotencyKey: key,
      proposedCanonicalId: "00000000-0000-4000-8000-000000000401",
      relationships: "derived_from:00000000-0000-4000-8000-000000000402",
      runId,
      targetProjectId: projects[1]?.id ?? "",
    });
  });

  test("offers the correction wording when the run is a compensating one", () => {
    mount(
      <ImportEntryReviewForm
        action={action}
        correction
        entry={entry}
        idempotencyKey={key}
        projects={projects}
        runId={runId}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Decision" }),
    ).toHaveTextContent("Add compensating message");
  });

  test("puts a rejected canonical identifier on that control's error line", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "proposedCanonicalId",
      message: "That request identifier is not a UUID.",
      status: "error",
    } satisfies ImportActionState);
    mount(
      <ImportEntryReviewForm
        action={action}
        entry={entry}
        idempotencyKey={key}
        projects={projects}
        runId={runId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save decision" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(
      await screen.findByText("That request identifier is not a UUID."),
    ).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("splitting a bundled source record", () => {
  test("keeps the split behind a disclosure and carries its line numbers", async () => {
    const user = userEvent.setup();
    mount(
      <SplitImportBundleForm
        action={action}
        entryId={entryId}
        expectedVersion={4}
        idempotencyKey={key}
        runId={runId}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Split bundled source into separate records",
      }),
    );
    await user.type(
      await screen.findByLabelText("New record start lines"),
      "24, 61",
    );
    await user.click(screen.getByRole("button", { name: "Split for review" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      entryId,
      expectedVersion: "4",
      idempotencyKey: key,
      runId,
      splitLines: "24, 61",
    });
  });
});

describe("approving and applying a manifest", () => {
  test("asks in a modal before freezing a manifest that cannot be reopened", async () => {
    const user = userEvent.setup();
    mount(
      <FreezeImportButton
        action={action}
        expectedVersion={4}
        idempotencyKey={key}
        runId={runId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve manifest" }));
    expect(action).not.toHaveBeenCalled();

    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Approve it",
      }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "4",
      idempotencyKey: key,
      runId,
    });
  });

  test("asks for the immutable hash prefix before applying", async () => {
    const user = userEvent.setup();
    mount(
      <ApplyImportForm
        action={action}
        expectedVersion={5}
        idempotencyKey={key}
        manifestSha256={manifestSha256}
        runId={runId}
      />,
    );

    const confirmation = screen.getByLabelText("Approved manifest hash prefix");
    expect(confirmation).toHaveAttribute(
      "placeholder",
      manifestSha256.slice(0, 12),
    );

    await user.type(confirmation, manifestSha256.slice(0, 12));
    await user.click(
      screen.getByRole("button", { name: "Apply approved import" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "5",
      idempotencyKey: key,
      manifestConfirmation: manifestSha256.slice(0, 12),
      runId,
    });
  });

  test("names the work and refuses a second press while an apply is in flight", async () => {
    const user = userEvent.setup();
    const release = hold(action);
    mount(
      <ApplyImportForm
        action={action}
        expectedVersion={5}
        idempotencyKey={key}
        manifestSha256={manifestSha256}
        runId={runId}
      />,
    );

    await user.type(
      screen.getByLabelText("Approved manifest hash prefix"),
      manifestSha256.slice(0, 12),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply approved import" }),
    );

    // The one action in the product that rewrites history: a second press
    // while the first is unanswered must be impossible, not merely idempotent.
    expect(
      await screen.findByRole("button", { name: "Queuing…" }),
    ).toBeDisabled();

    release();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Apply approved import" }),
      ).toBeEnabled(),
    );
  });

  test("puts a mismatched confirmation on the confirmation's own error line", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      field: "manifestConfirmation",
      message: "Approved import manifest hash does not match.",
      status: "error",
    } satisfies ImportActionState);
    mount(
      <ApplyImportForm
        action={action}
        expectedVersion={5}
        idempotencyKey={key}
        manifestSha256={manifestSha256}
        runId={runId}
      />,
    );

    await user.type(
      screen.getByLabelText("Approved manifest hash prefix"),
      "000000000000",
    );
    await user.click(
      screen.getByRole("button", { name: "Apply approved import" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(
      await screen.findByText("Approved import manifest hash does not match."),
    ).toHaveAttribute("data-slot", "field-error");
  });
});

describe("compensating an applied run", () => {
  test("starts a new review against the same preserved snapshot", async () => {
    const user = userEvent.setup();
    mount(
      <CorrectImportButton
        action={action}
        expectedVersion={9}
        idempotencyKey={key}
        runId={runId}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Start correction review" }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      expectedVersion: "9",
      idempotencyKey: key,
      runId,
    });
  });
});

describe("reaching one run's review", () => {
  test("links to the run by its identifier", () => {
    mount(<ImportRunLink id={runId} />);

    expect(screen.getByRole("link", { name: "Review import" })).toHaveAttribute(
      "href",
      `/imports/${runId}`,
    );
  });
});
