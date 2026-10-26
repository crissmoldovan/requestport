import { Field, FieldLabel, Input, Textarea } from "@cueplusplus/ui/forms";
import { Table } from "@cueplusplus/ui/instruments";
import { AlertDialog } from "@cueplusplus/ui/overlays";
import { ThemeProvider } from "@cueplusplus/ui/system";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn() }));
/** The query string `useSearchParams` reads; a case changes it to navigate. */
const address = vi.hoisted(() => ({
  search: "requestId=00000000-0000-4000-8000-000000000101",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/requests",
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(address.search),
}));

import {
  RequestFilterSheet,
  RequestRow,
  RequestRowTitle,
  RequestWorkbenchShell,
  requestFilterHref,
} from "./request-workbench-shell.js";

/**
 * `SplitPane` measures its own frame with `getBoundingClientRect` and stacks
 * below its threshold. jsdom lays nothing out, so every frame measures `0`
 * wide unless a test says otherwise — which is a phone, and the case the Back
 * button exists for.
 */
const originalRect = Element.prototype.getBoundingClientRect;

function frameWidth(width: number) {
  Element.prototype.getBoundingClientRect = function rect() {
    return { ...originalRect.call(this), width } as DOMRect;
  };
}

beforeEach(() => {
  router.push.mockReset();
  address.search = "requestId=00000000-0000-4000-8000-000000000101";
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

function themed(children: ReactNode) {
  return render(
    <ThemeProvider persistPreferences={false} theme="requestport">
      {children}
    </ThemeProvider>,
  );
}

describe("the workbench at a phone's width", () => {
  test("stacks into the detail and goes back to the list's own address", async () => {
    const user = userEvent.setup();
    frameWidth(390);
    themed(
      <RequestWorkbenchShell
        backHref="/requests?view=inbox&state=triage"
        detail={<p>The selected request</p>}
        hasDetail
        list={<p>The request list</p>}
      />,
    );

    expect(screen.getByText("The selected request")).toBeInTheDocument();
    expect(screen.queryByText("The request list")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to requests" }));

    expect(router.push).toHaveBeenCalledWith(
      "/requests?view=inbox&state=triage",
    );
  });

  test("shows only the list while nothing is selected", () => {
    frameWidth(390);
    themed(
      <RequestWorkbenchShell
        backHref="/requests"
        detail={null}
        hasDetail={false}
        list={<p>The request list</p>}
      />,
    );

    expect(screen.getByText("The request list")).toBeInTheDocument();
    expect(screen.queryByText("No request selected")).not.toBeInTheDocument();
  });

  test("keeps both panes and a keyboard-operable seam on a wide frame", () => {
    frameWidth(1440);
    themed(
      <RequestWorkbenchShell
        backHref="/requests"
        detail={null}
        hasDetail={false}
        list={<p>The request list</p>}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Request list" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Selected request" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No request selected")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize the requests" }),
    ).toHaveAttribute("tabindex", "0");
  });
});

/*
  Ruling 262: a navigation that changes only the query keeps the page's
  components, so the shell reads the address and closes the request as soon
  as `requestId` leaves it — before the server's next render, which is what
  used to close it.
*/
describe("closing on a query-only navigation", () => {
  function shell() {
    return (
      <RequestWorkbenchShell
        backHref="/requests?view=inbox"
        detail={<p>The selected request</p>}
        hasDetail
        list={<p>The request list</p>}
      />
    );
  }

  test("on a wide frame, the detail pane goes back to its empty state when requestId leaves the address", () => {
    frameWidth(1440);
    const view = themed(shell());
    expect(screen.getByText("The selected request")).toBeInTheDocument();

    // Back, or a link to the same list without the selection.
    address.search = "view=inbox";
    view.rerender(
      <ThemeProvider persistPreferences={false} theme="requestport">
        {shell()}
      </ThemeProvider>,
    );

    expect(screen.queryByText("The selected request")).not.toBeInTheDocument();
    expect(screen.getByText("No request selected")).toBeInTheDocument();
    expect(screen.getByText("The request list")).toBeInTheDocument();
  });

  test("stacked, the list comes back in the detail's place", () => {
    frameWidth(390);
    const view = themed(shell());
    expect(screen.queryByText("The request list")).not.toBeInTheDocument();

    address.search = "";
    view.rerender(
      <ThemeProvider persistPreferences={false} theme="requestport">
        {shell()}
      </ThemeProvider>,
    );

    expect(screen.getByText("The request list")).toBeInTheDocument();
    expect(screen.queryByText("The selected request")).not.toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});

/*
  Ruling 264: the selected row's highlight, and its title's aria-current,
  clear with the drawer — the moment requestId leaves the address — rather
  than on the server's next render.
*/
describe("the selected row on a query-only close", () => {
  function shell() {
    const href = "/requests?requestId=00000000-0000-4000-8000-000000000101";
    return (
      <ThemeProvider persistPreferences={false} theme="requestport">
        <RequestWorkbenchShell
          backHref="/requests"
          detail={<p>The selected request</p>}
          hasDetail
          list={
            <Table.Root>
              <Table.Body>
                <RequestRow href={href} selected>
                  <Table.Cell>
                    <RequestRowTitle href={href} selected>
                      The selected title
                    </RequestRowTitle>
                  </Table.Cell>
                </RequestRow>
              </Table.Body>
            </Table.Root>
          }
        />
      </ThemeProvider>
    );
  }

  test("drops the highlight and aria-current as soon as requestId leaves the address", () => {
    frameWidth(1440);
    const view = render(shell());
    const link = () => screen.getByRole("link", { name: "The selected title" });
    expect(link().closest("tr")).toHaveAttribute("data-selected");
    expect(link()).toHaveAttribute("aria-current", "true");

    address.search = "";
    view.rerender(shell());

    expect(link().closest("tr")).not.toHaveAttribute("data-selected");
    expect(link()).not.toHaveAttribute("aria-current");
    expect(router.push).not.toHaveBeenCalled();
  });

  test("outside a workbench, a row is as selected as it was drawn", () => {
    address.search = "";
    themed(
      <Table.Root>
        <Table.Body>
          <RequestRow href="/requests?requestId=r-1" selected>
            <Table.Cell>
              <RequestRowTitle href="/requests?requestId=r-1" selected>
                A row alone
              </RequestRowTitle>
            </Table.Cell>
          </RequestRow>
        </Table.Body>
      </Table.Root>,
    );
    const link = screen.getByRole("link", { name: "A row alone" });
    expect(link.closest("tr")).toHaveAttribute("data-selected");
    expect(link).toHaveAttribute("aria-current", "true");
  });
});

/**
 * Stacked, `SplitPane` goes back on any Escape inside the detail that nothing
 * has claimed. The detail holds fields a reader types into — the next step's
 * reason, the completion report, an answer — and going back there would throw
 * away what was typed.
 */
describe("Escape in the stacked detail", () => {
  function renderStacked(detail: ReactNode) {
    frameWidth(390);
    return themed(
      <RequestWorkbenchShell
        backHref="/requests?view=inbox"
        detail={detail}
        hasDetail
        list={<p>The request list</p>}
      />,
    );
  }

  test("goes back to the list from anywhere nobody types", () => {
    renderStacked(<h2 tabIndex={-1}>The selected request</h2>);

    fireEvent.keyDown(
      screen.getByRole("heading", { name: "The selected request" }),
      { key: "Escape" },
    );

    expect(router.push).toHaveBeenCalledWith("/requests?view=inbox");
  });

  test("stays on the request when the reader presses it in a field they are typing into", async () => {
    const user = userEvent.setup();
    renderStacked(
      <>
        <Field name="reason">
          <FieldLabel>Reason</FieldLabel>
          <Input name="reason" size="sm" />
        </Field>
        <Field name="outcomeMd">
          <FieldLabel>Outcome</FieldLabel>
          <Textarea name="outcomeMd" rows={2} />
        </Field>
      </>,
    );
    const reason = screen.getByRole("textbox", { name: "Reason" });
    const outcome = screen.getByRole("textbox", { name: "Outcome" });

    await user.type(reason, "half-typed");
    await user.keyboard("{Escape}");
    await user.type(outcome, "a draft");
    await user.keyboard("{Escape}");

    expect(router.push).not.toHaveBeenCalled();
    expect(reason).toHaveValue("half-typed");
    expect(outcome).toHaveValue("a draft");
  });

  test("leaves the Escape that closes a confirmation to the confirmation", async () => {
    const user = userEvent.setup();
    renderStacked(
      <AlertDialog.Root>
        <AlertDialog.Trigger>Cancel request</AlertDialog.Trigger>
        <AlertDialog.Content>
          <AlertDialog.Title>Cancel this request?</AlertDialog.Title>
          <AlertDialog.Description>
            It cannot be undone.
          </AlertDialog.Description>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>Keep it</AlertDialog.Cancel>
            <AlertDialog.Action tone="danger">Cancel it</AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>,
    );

    await user.click(screen.getByRole("button", { name: "Cancel request" }));
    await screen.findByRole("alertdialog", { name: "Cancel this request?" });
    await user.keyboard("{Escape}");

    // The popup plays its exit before it unmounts.
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Cancel this request?" }),
      ).toBeNull(),
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("a request row", () => {
  function renderRow() {
    return themed(
      <Table.Root>
        <Table.Body>
          <RequestRow href="/requests?requestId=r-1" selected={false}>
            <Table.Cell>
              <a href="/requests?requestId=r-1">The title</a>
            </Table.Cell>
            <Table.Cell>Triage</Table.Cell>
          </RequestRow>
        </Table.Body>
      </Table.Root>,
    );
  }

  test("selects the request by navigating to its address", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByText("Triage"));

    expect(router.push).toHaveBeenCalledWith("/requests?requestId=r-1");
  });

  test("leaves a click on the title to the link it already is", async () => {
    const user = userEvent.setup();
    renderRow();
    const link = screen.getByRole("link", { name: "The title" });
    link.addEventListener("click", (event) => event.preventDefault());

    await user.click(link);

    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("the filter sheet", () => {
  const options = {
    lanes: [
      { label: "release", value: "00000000-0000-4000-8000-0000000000e1" },
    ],
    priorities: [
      { label: "Urgent", value: "urgent" },
      { label: "Low", value: "low" },
    ],
    projects: [
      { label: "Platform", value: "00000000-0000-4000-8000-0000000000c1" },
    ],
    states: [
      { label: "Triage", value: "triage" },
      { label: "Blocked", value: "blocked" },
    ],
    types: [
      { label: "Feature", value: "feature" },
      { label: "Bug", value: "bug" },
    ],
    // Ruling 264: the organisation's members, by name (email when blank).
    reporters: [
      { label: "Ada Lovelace", value: "user-1" },
      { label: "grace@example.com", value: "user-7" },
    ],
    assignees: [
      { label: "Ada Lovelace", value: "user-1" },
      { label: "grace@example.com", value: "user-7" },
    ],
  };

  function renderSheet() {
    return themed(
      <RequestFilterSheet
        activeCount={2}
        clearHref="/requests?view=inbox"
        mode="inbox"
        values={{ label: "console", state: "triage" }}
        {...options}
      />,
    );
  }

  test("opens the full form, labelled, holding the filters in force", async () => {
    const user = userEvent.setup();
    renderSheet();

    expect(screen.queryByRole("form")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filters (2)" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Filter requests",
    });
    const form = within(dialog).getByRole("form", { name: "Request filters" });

    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/requests");
    for (const label of [
      "State",
      "Type",
      "Priority",
      "Lane",
      "Source project",
      "Target project",
      "Label",
      "Updated after",
      "Reporter",
      "Assignee",
    ]) {
      expect(within(form).getByLabelText(label)).toBeInTheDocument();
    }
    expect(
      within(form).getByRole("checkbox", { name: "Has an open question" }),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText("Label")).toHaveValue("console");
    expect(
      within(form).getByRole("combobox", { name: "State" }),
    ).toHaveTextContent("Triage");
    expect(
      within(form).getByRole("link", { name: "Clear all" }),
    ).toHaveAttribute("href", "/requests?view=inbox");
  });

  test("submits the page's own parameter names, leaving the empty ones out", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Filters (2)" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Filter requests",
    });

    // The assignee is a member chosen by name, submitted as their id.
    await user.click(
      within(dialog).getByRole("combobox", { name: "Assignee" }),
    );
    // In jsdom the Select's popup sits under an aria-hidden element while
    // the sheet is open, beside the State Select's, so it is asked for with
    // `hidden` and found by what it lists.
    const listbox = (
      await screen.findAllByRole("listbox", { hidden: true })
    ).find((candidate) => candidate.textContent?.startsWith("Any assignee"));
    if (!listbox) throw new Error("The assignee list did not open");
    expect(
      within(listbox)
        .getAllByRole("option", { hidden: true })
        .map((option) => option.textContent),
    ).toEqual(["Any assignee", "Ada Lovelace", "grace@example.com"]);
    await user.click(
      within(listbox).getByRole("option", {
        hidden: true,
        name: "grace@example.com",
      }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Has an open question" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Apply filters" }),
    );

    expect(router.push).toHaveBeenCalledWith(
      "/requests?view=inbox&state=triage&label=console&assigneeId=user-7&unanswered=true",
    );
    // The sheet plays its exit before it unmounts.
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Filter requests" }),
      ).toBeNull(),
    );
  });

  test("gives back every filter in force, and the view, when applied unchanged", async () => {
    const user = userEvent.setup();
    const lane = "00000000-0000-4000-8000-0000000000e1";
    const source = "00000000-0000-4000-8000-0000000000c1";
    const target = "00000000-0000-4000-8000-0000000000c2";
    themed(
      <RequestFilterSheet
        activeCount={11}
        clearHref="/requests?view=my_work"
        mode="my_work"
        values={{
          assigneeId: "user-7",
          label: "console",
          laneId: lane,
          priority: "low",
          reporterId: "user-1",
          sourceProjectId: source,
          state: "blocked",
          targetProjectId: target,
          type: "bug",
          unanswered: true,
          updatedAfter: "2026-08-19",
        }}
        {...options}
        projects={[
          { label: "Platform", value: source },
          { label: "Web", value: target },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filters (11)" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Filter requests",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Apply filters" }),
    );

    // Each control submits under the page's own parameter name and starts
    // from the value in force, so applying the sheet to change one filter
    // cannot drop or rename another.
    const href = String(router.push.mock.calls[0]?.[0]);
    const submitted = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect([...submitted.keys()]).toHaveLength(12);
    expect(Object.fromEntries(submitted)).toEqual({
      assigneeId: "user-7",
      label: "console",
      laneId: lane,
      priority: "low",
      reporterId: "user-1",
      sourceProjectId: source,
      state: "blocked",
      targetProjectId: target,
      type: "bug",
      unanswered: "true",
      updatedAfter: "2026-08-19",
      view: "my_work",
    });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  test("keeps a reporter in force whom no option names as the selection, and submits it again", async () => {
    const user = userEvent.setup();
    themed(
      <RequestFilterSheet
        activeCount={1}
        clearHref="/requests"
        mode="all"
        values={{ reporterId: "agent-9" }}
        {...options}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Filters (1)" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Filter requests",
    });
    expect(
      within(dialog).getByRole("combobox", { name: "Reporter" }),
    ).toHaveTextContent("agent-9");
    await user.click(
      within(dialog).getByRole("button", { name: "Apply filters" }),
    );
    expect(router.push).toHaveBeenCalledWith("/requests?reporterId=agent-9");
  });
});

describe("the address a filter form names", () => {
  test("is /requests alone when nothing is set", () => {
    const form = document.createElement("form");
    const empty = document.createElement("input");
    empty.name = "state";
    empty.value = "";
    form.append(empty);

    expect(requestFilterHref(form)).toBe("/requests");
  });
});
