import { ThemeProvider } from "@cueplusplus/ui/system";
import type {
  OrganizationProject,
  RequestDetail,
  RequestQuestionView,
} from "@requestport/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RequestActionState } from "../app/(app)/requests/request-action-state.js";

/**
 * The request forms, driven the way a person drives them.
 *
 * Each form is bound to a real server action in production, so the actions are
 * the one thing replaced here: the suite decides what a submission answers with
 * and then asserts where that answer lands — a field's own error line, the
 * fixed banner, or a reset composer. The controls themselves are the installed
 * CUE++ ones, mounted under the verified provider so their portals carry the
 * appearance triple.
 */

const idle: RequestActionState = { status: "idle" };

const actions = vi.hoisted(() => ({
  answer: vi.fn(),
  artifact: vi.fn(),
  ask: vi.fn(),
  assign: vi.fn(),
  close: vi.fn(),
  create: vi.fn(),
  link: vi.fn(),
  message: vi.fn(),
  preview: vi.fn(),
  transition: vi.fn(),
  unlink: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../app/(app)/requests/actions.js", () => ({
  answerQuestionAction: actions.answer,
  askQuestionAction: actions.ask,
  assignRequestAction: actions.assign,
  attachArtifactAction: actions.artifact,
  closeQuestionAction: actions.close,
  createRequestAction: actions.create,
  linkRequestsAction: actions.link,
  postMessageAction: actions.message,
  previewRequestRouteAction: actions.preview,
  transitionRequestAction: actions.transition,
  unlinkRequestsAction: actions.unlink,
  updateRequestAction: actions.update,
}));

import {
  AnswerQuestionForm,
  ArtifactLinkForm,
  AssignRequestForm,
  MessageComposer,
  RequestCreateForm,
  RequestTransitionForm,
  UnlinkRelationshipForm,
} from "./request-forms.js";

const key = "web:fixture:00000000-0000-4000-8000-000000000001";

const projects: OrganizationProject[] = [
  {
    canRepresent: true,
    defaultRepository: null,
    id: "00000000-0000-4000-8000-0000000000c1",
    keyPrefix: "PLT",
    name: "Platform",
    slug: "platform",
    status: "active",
  },
  {
    canRepresent: false,
    defaultRepository: null,
    id: "00000000-0000-4000-8000-0000000000c2",
    keyPrefix: "DOC",
    name: "Docs",
    slug: "docs",
    status: "active",
  },
];

const question: Pick<
  RequestQuestionView,
  "allowFreeText" | "choices" | "id" | "version"
> = {
  allowFreeText: true,
  choices: ["wide", "narrow"],
  id: "00000000-0000-4000-8000-000000000201",
  version: 3,
};

const transitionRequest: Pick<
  RequestDetail,
  "allowedActions" | "id" | "state" | "version"
> = {
  allowedActions: ["complete_request", "block_request", "cancel_request"],
  id: "00000000-0000-4000-8000-000000000101",
  state: "in_progress",
  version: 4,
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

/** The FormData one mocked action received, keyed by field name. */
function submitted(action: { mock: { calls: unknown[][] } }) {
  const data = action.mock.calls.at(-1)?.[1] as FormData | undefined;
  if (!data) throw new Error("the action was never invoked");

  return Object.fromEntries(
    [...data.entries()].map(([name, value]) => [name, String(value)]),
  );
}

/** Picks one row out of a `Select`'s portalled listbox by its visible label. */
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

/**
 * Everything the create form requires before it will submit at all.
 *
 * The controls are genuinely `required`, so a suite that wants to see what the
 * *server* answered has to get past the browser's own refusal first.
 */
async function completeCreateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Title"), "Reskin");
  await user.type(screen.getByLabelText("Description (Markdown)"), "Body");
  await choose(user, "Target project", /Platform/u);
}

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  actions.preview.mockResolvedValue({ status: "unavailable" });
  for (const action of [
    actions.answer,
    actions.artifact,
    actions.ask,
    actions.assign,
    actions.close,
    actions.create,
    actions.link,
    actions.message,
    actions.transition,
    actions.unlink,
    actions.update,
  ]) {
    action.mockResolvedValue(idle);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("creating a request", () => {
  test("names every visible control through its own field", async () => {
    const { container } = mount(
      <RequestCreateForm
        canManageRouting
        idempotencyKey={key}
        projects={projects}
      />,
    );

    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="field"]')).toHaveLength(10);
    expect(
      container.querySelectorAll('[data-slot="field-label"]'),
    ).toHaveLength(10);

    for (const label of [
      "Title",
      "Labels",
      "Description (Markdown)",
      "Acceptance criteria",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    for (const label of [
      "Source",
      "Target project",
      "Type",
      "Priority",
      "Visibility",
      "Sensitivity",
    ]) {
      expect(screen.getByRole("combobox", { name: label })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();
  });

  test("chooses a target through the portalled native listbox", async () => {
    const user = userEvent.setup();
    actions.preview.mockResolvedValue({
      matchedRuleId: null,
      policyVersion: 3,
      reason: "default_allow",
      status: "allowed",
    });
    mount(
      <RequestCreateForm
        canManageRouting
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Target project" }));

    const listbox = await screen.findByRole("listbox");

    expect(listbox.closest("[data-cue-portal]")).not.toBeNull();
    await user.click(
      within(listbox).getByRole("option", { name: /Platform/u }),
    );

    await waitFor(() =>
      expect(screen.getByText("Route allowed")).toBeVisible(),
    );
    expect(actions.preview).toHaveBeenCalledWith(
      expect.objectContaining({ targetProjectId: projects[0]?.id }),
    );
  });

  test("keeps submit unavailable while the current policy denies the route", async () => {
    const user = userEvent.setup();
    actions.preview.mockResolvedValue({
      matchedRuleId: "00000000-0000-4000-8000-0000000000f1",
      policyVersion: 3,
      reason: "no_matching_rule",
      status: "denied",
    });
    mount(
      <RequestCreateForm
        canManageRouting
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await choose(user, "Target project", /Platform/u);

    await waitFor(() => expect(screen.getByText("Route denied")).toBeVisible());
    expect(
      screen.getByRole("button", { name: "Create and submit" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(
      screen.getByRole("link", { name: "Review routing policy" }),
    ).toHaveAttribute("href", "/settings/routing");
  });

  test("holds every submit shut while a submission is still in flight", async () => {
    // Pending is a state of the form, not a decoration on the button that was
    // clicked: the create form offers two submits against one command, and a
    // second click on the *other* one while the first is unanswered is a
    // duplicate write carrying the same idempotency key. Both therefore close
    // for as long as the action is unanswered, and both reopen when it answers.
    const user = userEvent.setup();
    let answer: (state: RequestActionState) => void = () => {};
    actions.create.mockImplementation(
      () =>
        new Promise<RequestActionState>((resolve) => {
          answer = resolve;
        }),
    );
    mount(
      <RequestCreateForm
        canManageRouting={false}
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await completeCreateForm(user);
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled(),
    );
    expect(
      screen.getByRole("button", { name: "Create and submit" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Create and submit" }));
    expect(actions.create).toHaveBeenCalledTimes(1);

    answer(idle);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled(),
    );
    expect(actions.create).toHaveBeenCalledTimes(1);
  });

  test("puts a rejected field's message on that field, not in the banner", async () => {
    const user = userEvent.setup();
    // The exact state `createRequestAction` returns for a blank title, pinned
    // against the real action in `requests/actions.test.ts`. A form suite that
    // invented a friendlier sentence here would still pass while production
    // shipped a message no test had ever seen.
    actions.create.mockResolvedValue({
      code: "validation_failed",
      field: "title",
      message: "Too small: expected string to have >=1 characters",
      status: "error",
    } satisfies RequestActionState);
    mount(
      <RequestCreateForm
        canManageRouting={false}
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await completeCreateForm(user);
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Title")).toHaveAccessibleDescription(
        expect.stringContaining("expected string to have >=1 characters"),
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitted(actions.create).idempotencyKey).toBe(key);
    expect(submitted(actions.create).intent).toBe("draft");
  });

  test("reports a failure that belongs to no field in the fixed banner", async () => {
    const user = userEvent.setup();
    actions.create.mockResolvedValue({
      code: "route_denied",
      message: "The current routing policy denies this request.",
      status: "error",
    } satisfies RequestActionState);
    mount(
      <RequestCreateForm
        canManageRouting={false}
        idempotencyKey={key}
        projects={projects}
      />,
    );

    await completeCreateForm(user);
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    const banner = await screen.findByRole("alert");

    expect(banner).toHaveTextContent(
      "The current routing policy denies this request.",
    );
  });
});

describe("transitioning a request", () => {
  test("submits a completion with its report and expected version", async () => {
    const user = userEvent.setup();
    mount(
      <RequestTransitionForm
        idempotencyKey={key}
        request={transitionRequest}
      />,
    );

    await user.type(screen.getByLabelText("Reason"), "Work is done");
    await user.type(screen.getByLabelText("Outcome"), "The console is native");
    await user.type(screen.getByLabelText("Validation command"), "pnpm test");
    await user.type(screen.getByLabelText("Verification steps"), "Run the app");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(actions.transition).toHaveBeenCalled());
    expect(submitted(actions.transition)).toMatchObject({
      action: "complete_request",
      expectedVersion: "4",
      idempotencyKey: key,
      outcomeMd: "The console is native",
      requestId: transitionRequest.id,
      validationCommand: "pnpm test",
      verificationStepsMd: "Run the app",
    });
  });

  test("asks once, in a modal alert, before an irreversible transition", async () => {
    const user = userEvent.setup();
    mount(
      <RequestTransitionForm
        idempotencyKey={key}
        request={transitionRequest}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Transition" }));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Cancel",
      }),
    );
    await user.type(screen.getByLabelText("Reason"), "Superseded by RQP-20");
    await user.click(screen.getByRole("button", { name: "Cancel request" }));

    const alert = await screen.findByRole("alertdialog");

    expect(within(alert).getByText(/cannot be transitioned/u)).toBeVisible();
    expect(actions.transition).not.toHaveBeenCalled();

    await user.click(within(alert).getByRole("button", { name: "Keep it" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(actions.transition).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel request" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Cancel this request",
      }),
    );

    await waitFor(() => expect(actions.transition).toHaveBeenCalled());
    expect(submitted(actions.transition).action).toBe("cancel_request");
  });

  test("reveals the completion report only for the transition that needs it", async () => {
    const user = userEvent.setup();
    mount(
      <RequestTransitionForm
        idempotencyKey={key}
        request={transitionRequest}
      />,
    );

    expect(screen.getByLabelText("Outcome")).toBeInTheDocument();
    expect(screen.getByLabelText("Verification steps")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Transition" }));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Block",
      }),
    );

    await waitFor(() => expect(screen.queryByLabelText("Outcome")).toBeNull());
    expect(screen.getByLabelText("Reason")).toBeRequired();
  });

  test("follows a completion-only failure out of the branch that drew it", async () => {
    // A malformed repository line is rejected with the field it belongs to,
    // and `changedRepositories` exists on screen only while the completion
    // report does. The reader may answer that failure by choosing a different
    // transition — at which point the field, and its error line, are gone. The
    // message has to survive that, because a failure that quietly disappears
    // leaves the form looking as though nothing was wrong with it.
    const user = userEvent.setup();
    actions.transition.mockResolvedValue({
      code: "validation_failed",
      field: "changedRepositories",
      message: "Check the supplied values and try again.",
      status: "error",
    } satisfies RequestActionState);
    mount(
      <RequestTransitionForm
        idempotencyKey={key}
        request={transitionRequest}
      />,
    );

    await user.type(screen.getByLabelText("Reason"), "Work is done");
    await user.type(screen.getByLabelText("Outcome"), "The console is native");
    await user.type(screen.getByLabelText("Validation command"), "pnpm test");
    await user.type(screen.getByLabelText("Verification steps"), "Run the app");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(
        screen.getByLabelText("Changed repositories"),
      ).toHaveAccessibleDescription(
        expect.stringContaining("Check the supplied values"),
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    await choose(user, "Transition", "Block");

    await waitFor(() =>
      expect(screen.queryByLabelText("Changed repositories")).toBeNull(),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Check the supplied values and try again.",
    );
  });

  test("reports a stale expected version in the fixed banner", async () => {
    const user = userEvent.setup();
    actions.transition.mockResolvedValue({
      code: "version_conflict",
      message: "This record changed. Refresh and try again.",
      status: "error",
    } satisfies RequestActionState);
    mount(
      <RequestTransitionForm
        idempotencyKey={key}
        request={{
          ...transitionRequest,
          allowedActions: ["submit_request"],
          state: "draft",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This record changed. Refresh and try again.",
    );
  });

  test("says so when no manual transition is available", () => {
    mount(
      <RequestTransitionForm
        idempotencyKey={key}
        request={{
          ...transitionRequest,
          allowedActions: [],
          state: "verified",
        }}
      />,
    );

    expect(
      screen.getByText("No manual transition is available from this state."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});

describe("participating in a request", () => {
  test("posts a comment and clears the composer on success", async () => {
    const user = userEvent.setup();
    actions.message.mockResolvedValue({
      message: "Comment posted.",
      status: "success",
    } satisfies RequestActionState);
    const { container } = mount(
      <MessageComposer idempotencyKey={key} requestId={transitionRequest.id} />,
    );

    expect(container.querySelectorAll('[data-slot="textarea"]')).toHaveLength(
      1,
    );

    const comment = screen.getByLabelText("Comment");

    await user.type(comment, "Looks good");
    await user.click(screen.getByRole("button", { name: "Post comment" }));

    await waitFor(() => expect(comment).toHaveValue(""));
    expect(submitted(actions.message)).toMatchObject({
      bodyMd: "Looks good",
      idempotencyKey: key,
      requestId: transitionRequest.id,
      visibility: "organization",
    });
  });

  test("answers a question through its structured choice", async () => {
    const user = userEvent.setup();
    mount(<AnswerQuestionForm idempotencyKey={key} question={question} />);

    await user.click(
      screen.getByRole("combobox", { name: "Structured answer" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "narrow",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(actions.answer).toHaveBeenCalled());
    expect(submitted(actions.answer)).toMatchObject({
      choice: "narrow",
      expectedVersion: "3",
      questionId: question.id,
    });
  });

  test("shows each answer failure where this question can show it", async () => {
    // A question's shape decides which of the two answer inputs exists. The
    // action's vocabulary does not narrow with it — `answerSchema` names
    // `bodyMd` whenever an answer is missing — so a form that claimed both
    // fields regardless would suppress the banner for a field it never drew
    // and report the failure nowhere at all.
    const user = userEvent.setup();
    actions.answer.mockResolvedValue({
      code: "validation_failed",
      field: "choice",
      message: "Too big: expected string to have <=160 characters",
      status: "error",
    } satisfies RequestActionState);
    mount(
      <AnswerQuestionForm
        idempotencyKey={key}
        question={{ ...question, allowFreeText: false }}
      />,
    );

    expect(screen.queryByLabelText("Answer")).toBeNull();
    await choose(user, "Structured answer", "narrow");
    await user.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Structured answer" }),
      ).toHaveAccessibleDescription(expect.stringContaining("Too big")),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    actions.answer.mockResolvedValue({
      code: "validation_failed",
      field: "bodyMd",
      message: "An answer is required",
      status: "error",
    } satisfies RequestActionState);
    await user.click(screen.getByRole("button", { name: "Answer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An answer is required",
    );
  });

  test("banners a structured failure a free-text question never drew", async () => {
    const user = userEvent.setup();
    actions.answer.mockResolvedValue({
      code: "validation_failed",
      field: "choice",
      message: "Too big: expected string to have <=160 characters",
      status: "error",
    } satisfies RequestActionState);
    mount(
      <AnswerQuestionForm
        idempotencyKey={key}
        question={{ ...question, choices: [] }}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "Structured answer" })).toBe(
      null,
    );
    await user.type(screen.getByLabelText("Answer"), "Narrow, for now");
    await user.click(screen.getByRole("button", { name: "Answer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too big: expected string to have <=160 characters",
    );
  });

  test("attaches an external artifact by link alone", async () => {
    const user = userEvent.setup();
    mount(
      <ArtifactLinkForm
        idempotencyKey={key}
        requestId={transitionRequest.id}
      />,
    );

    await user.type(screen.getByLabelText("Kind"), "pull_request");
    await user.type(
      screen.getByLabelText("External URL"),
      "https://github.example/example-org/requestport/pull/12",
    );
    await user.click(screen.getByRole("button", { name: "Attach link" }));

    await waitFor(() => expect(actions.artifact).toHaveBeenCalled());
    expect(submitted(actions.artifact)).toMatchObject({
      externalUrl: "https://github.example/example-org/requestport/pull/12",
      kind: "pull_request",
      requestId: transitionRequest.id,
    });
  });

  test("arms an unlink before it runs, and disarms on Escape", async () => {
    const user = userEvent.setup();
    mount(
      <UnlinkRelationshipForm
        idempotencyKey={key}
        relationshipId="00000000-0000-4000-8000-000000000901"
        requestId={transitionRequest.id}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Unlink request" }));

    expect(actions.unlink).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Confirm" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull(),
    );
    expect(actions.unlink).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Unlink request" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(actions.unlink).toHaveBeenCalled());
    expect(submitted(actions.unlink)).toMatchObject({
      idempotencyKey: key,
      relationshipId: "00000000-0000-4000-8000-000000000901",
      requestId: transitionRequest.id,
    });
  });
});

describe("assigning a request (ruling 262)", () => {
  const members = [
    {
      email: "ada@example.com",
      name: "Ada Lovelace",
      userId: "00000000-0000-4000-8000-0000000000a1",
    },
    {
      email: "grace@example.com",
      name: " ",
      userId: "00000000-0000-4000-8000-0000000000a2",
    },
  ];
  const unassigned = {
    assigneeDisplayName: null,
    assigneeId: null,
    assigneeType: null,
    id: transitionRequest.id,
    version: 4,
  } as const;

  test("offers Unassign and every active member by name, falling back to the email, and posts the chosen member", async () => {
    const user = userEvent.setup();
    mount(
      <AssignRequestForm
        idempotencyKey={key}
        members={members}
        request={unassigned}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Assignee" }));
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Unassign", "Ada Lovelace", "grace@example.com"]);
    await user.click(
      within(listbox).getByRole("option", { name: "Ada Lovelace" }),
    );
    await user.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(actions.assign).toHaveBeenCalled());
    expect(submitted(actions.assign)).toEqual({
      assigneeUserId: members[0]?.userId,
      expectedVersion: "4",
      idempotencyKey: key,
      requestId: transitionRequest.id,
    });
  });

  test("starts on the current assignee, and Unassign posts an empty assignee", async () => {
    const user = userEvent.setup();
    mount(
      <AssignRequestForm
        idempotencyKey={key}
        members={members}
        request={{
          ...unassigned,
          assigneeDisplayName: "Ada Lovelace",
          assigneeId: members[0]?.userId ?? null,
          assigneeType: "user",
        }}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Assignee" }),
    ).toHaveTextContent("Ada Lovelace");
    await choose(user, "Assignee", "Unassign");
    await user.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(actions.assign).toHaveBeenCalled());
    expect(submitted(actions.assign)).toMatchObject({ assigneeUserId: "" });
  });

  test("shows a current assignee who is no longer an active member as the selection, greyed out", async () => {
    const user = userEvent.setup();
    mount(
      <AssignRequestForm
        idempotencyKey={key}
        members={members}
        request={{
          ...unassigned,
          assigneeDisplayName: "Former member",
          assigneeId: "00000000-0000-4000-8000-0000000000f0",
          assigneeType: "user",
        }}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    expect(trigger).toHaveTextContent("Former member (not an active member)");
    await user.click(trigger);
    expect(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Former member (not an active member)",
      }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  test("puts a refused assignee on the field's own line", async () => {
    const user = userEvent.setup();
    actions.assign.mockResolvedValue({
      status: "error",
      code: "validation_failed",
      field: "assigneeUserId",
      message: "Check the supplied values and try again.",
    });
    mount(
      <AssignRequestForm
        idempotencyKey={key}
        members={members}
        request={unassigned}
      />,
    );

    await choose(user, "Assignee", "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Assign" }));

    expect(
      await screen.findByText("Check the supplied values and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
