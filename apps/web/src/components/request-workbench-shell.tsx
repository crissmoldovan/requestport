"use client";

import { EmptyState, Tabs } from "@cueplusplus/ui/chrome";
import {
  Checkbox,
  Field,
  FieldLabel,
  Input,
  Select,
} from "@cueplusplus/ui/forms";
import { Table } from "@cueplusplus/ui/instruments";
import { Link as CueLink, SplitPane } from "@cueplusplus/ui/layout";
import { Sheet } from "@cueplusplus/ui/overlays";
import { Button, IconButton } from "@cueplusplus/ui/primitives";
import { ArrowUpRight, ListFilter, PanelRight, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * The requests workbench: the list beside the selected request, the row that
 * selects one, and the sheet that holds the list's filters.
 *
 * Everything the reader chooses here is an address. Selecting a row, going
 * back from a stacked detail, changing view, dropping a filter and applying
 * the filters all navigate to a `/requests` URL the page reads on the server,
 * so a filtered, selected view survives a reload, back and forward, and a
 * bookmark. The browser holds three things only: whether the filter sheet is
 * open, which of the selected request's three tabs is showing, and how wide
 * the reader has dragged the list (`SplitPane` keeps that itself). The shell
 * also reads the address itself, to close the selected request, and clear its
 * row's highlight, the moment `requestId` leaves it (`RequestWorkbenchShell`).
 *
 * These are the parts that have to be client components: cue-ui's `Tabs` is
 * a client-only namespace a server module may not dot into, and an icon is a
 * function, which a server module may not hand to a client `Button`.
 */

/**
 * The list pane's widths, in pixels, and the frame width below which the two
 * panes stack. They are the reference build's numbers
 * (`docs/design/console-prototype/src/screens/Requests.tsx`); the floor is
 * the narrowest the title and its one muted line stay readable at.
 */
export const workbenchListSize = {
  default: 480,
  maximum: 560,
  minimum: 280,
  stackBelow: 860,
} as const;

/**
 * The element an event came from, when it came from one. Read by its
 * `closest` method rather than `instanceof Element`: the self-host's boundary
 * contract admits `instanceof` only of the globals it lists.
 */
function elementOf(target: EventTarget | null): Element | null {
  return target !== null && "closest" in target ? (target as Element) : null;
}

/** Whether a key was pressed in an input, a text area or editable content. */
function typedInto(target: EventTarget | null) {
  return (
    elementOf(target)?.closest(
      'input, textarea, [contenteditable]:not([contenteditable="false"])',
    ) != null
  );
}

/**
 * Whether the selected request is open (ruling 264): false from the moment
 * `requestId` leaves the address, so the row the server drew as selected
 * stops looking selected at once (`RequestRow`, `RequestRowTitle`). Outside a
 * workbench it is true, and a row is as selected as it was drawn.
 */
const SelectionOpen = createContext(true);

type WorkbenchProps = {
  /** The same list with no request selected: where the stacked Back goes. */
  backHref: string;
  detail: ReactNode;
  hasDetail: boolean;
  list: ReactNode;
};

/**
 * The list beside the selected request.
 *
 * Whether the request is open is the server's answer (`hasDetail`) and the
 * address's: it closes as soon as `requestId` leaves the query, as a query
 * only navigation does — Back from a selected request, or a link to the list
 * without it — rather than staying drawn until the server's next render
 * replaces it. `AddressSelection` reads the address behind the `Suspense`
 * boundary Next asks for around a component that calls `useSearchParams`.
 * The boundary holds that reader alone, never the list or the request: one
 * around the panes made React draw a second, client copy of the list while a
 * streamed page waited for its swap (`streamed-page-hydration.dom.test.tsx`).
 */
export function RequestWorkbenchShell({
  backHref,
  detail,
  hasDetail,
  list,
}: WorkbenchProps) {
  const router = useRouter();
  // The server drew a selected request only for an address that names one,
  // so the first render trusts it; the reader corrects it after hydration and
  // on every navigation.
  const [addressSelects, setAddressSelects] = useState(true);
  const open = hasDetail && addressSelects;

  // `overflow-x-clip`: the server cannot measure, so it renders the panes
  // side by side, and on a phone the list's fixed width would scroll the
  // whole page sideways until the browser has measured and stacked them.
  // Clipping (not hiding) keeps the frame from becoming a scroll container.
  return (
    <SelectionOpen.Provider value={open}>
      <Suspense fallback={null}>
        <AddressSelection onChange={setAddressSelects} />
      </Suspense>
      <SplitPane
        className="overflow-x-clip border-t border-border"
        defaultListSize={workbenchListSize.default}
        detail={
          <aside
            aria-label="Selected request"
            onKeyDown={(event) => {
              // Stacked, `SplitPane` goes back on any Escape inside the detail
              // that nothing has claimed. Claimed here when it was pressed in an
              // input, a text area or editable content — the next step's
              // reason, the completion report and an answer are all of those —
              // so going back cannot throw away what was typed.
              if (event.key === "Escape" && typedInto(event.target)) {
                event.preventDefault();
              }
            }}
          >
            {open ? (
              detail
            ) : (
              <EmptyState
                hint="Choose a request from the list to read it here."
                icon={PanelRight}
                title="No request selected"
              />
            )}
          </aside>
        }
        detailOpen={open}
        list={<section aria-label="Request list">{list}</section>}
        listLabel="requests"
        maxListSize={workbenchListSize.maximum}
        minListSize={workbenchListSize.minimum}
        onBack={() => router.push(backHref)}
        stackBelow={workbenchListSize.stackBelow}
      />
    </SelectionOpen.Provider>
  );
}

/** Reports whether the address names a selected request, as it changes. */
function AddressSelection({
  onChange,
}: {
  onChange: (selects: boolean) => void;
}) {
  const selects = useSearchParams().has("requestId");
  useEffect(() => {
    onChange(selects);
  }, [onChange, selects]);
  return null;
}

/**
 * Whether a click on a row landed on something that acts on its own.
 *
 * The row's title is a real link, so a keyboard user, a middle click and a
 * screen reader all have the selection without this. The row answers the
 * rest of its area, and must not answer a click the link already took — that
 * would navigate twice.
 */
function landedOnControl(target: EventTarget | null) {
  return (
    elementOf(target)?.closest("a, button, input, label, select, textarea") !=
    null
  );
}

/**
 * A row of the list. `selected` is the server's answer, shown only while the
 * selected request is open, so closing it clears the row's highlight before
 * the server's next render arrives.
 */
export function RequestRow({
  children,
  href,
  selected,
}: {
  children: ReactNode;
  href: string;
  selected: boolean;
}) {
  const router = useRouter();
  const open = useContext(SelectionOpen);

  return (
    <Table.Row
      interactive
      onClick={(event) => {
        if (event.defaultPrevented || landedOnControl(event.target)) return;
        router.push(href);
      }}
      selected={selected && open}
    >
      {children}
    </Table.Row>
  );
}

/**
 * A row's title: the link that selects it, marked `aria-current` while it is
 * the open request, on the same terms as the row's highlight.
 */
export function RequestRowTitle({
  children,
  href,
  selected,
}: {
  children: ReactNode;
  href: string;
  selected: boolean;
}) {
  const open = useContext(SelectionOpen);
  return (
    <CueLink
      aria-current={selected && open ? "true" : undefined}
      className="font-medium"
      render={<Link href={href} />}
    >
      {children}
    </CueLink>
  );
}

type Option = { label: string; value: string };

/**
 * `options`, with `value` added when it is a value none of them holds, under
 * its own text: a filter in force stays the selection, and is submitted
 * again, rather than the control showing "Any" while the address says
 * otherwise.
 */
function withValueInForce(options: Option[], value: string | undefined) {
  return value && !options.some((option) => option.value === value)
    ? [{ label: value, value }, ...options]
    : options;
}

export type RequestFilterValues = {
  assigneeId?: string;
  label?: string;
  laneId?: string;
  priority?: string;
  reporterId?: string;
  sourceProjectId?: string;
  state?: string;
  targetProjectId?: string;
  type?: string;
  unanswered?: boolean;
  updatedAfter?: string;
};

/**
 * The address a submitted filter form names.
 *
 * Built from the form's own fields, so the parameter names are the ones the
 * controls carry — the same names the page reads — and an empty control adds
 * nothing rather than an empty `state=` the page would ignore anyway.
 */
export function requestFilterHref(form: HTMLFormElement): string {
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string" && value.trim() !== "") {
      params.append(name, value.trim());
    }
  }
  const query = params.toString();
  return query ? `/requests?${query}` : "/requests";
}

/**
 * Every filter the page reads, in a right-hand sheet.
 *
 * The form is a GET form on `/requests` whose controls carry the page's own
 * parameter names. The sheet opens only once the page has hydrated, and a
 * submission is turned into that same address without the empty fields,
 * pushed, and the sheet closed. The reporter and the assignee are chosen
 * from the people the page offers (ruling 264), each submitted as its id
 * under the same `reporterId` and `assigneeId` the page reads.
 */
export function RequestFilterSheet({
  activeCount,
  assignees,
  clearHref,
  lanes,
  mode,
  priorities,
  projects,
  reporters,
  states,
  types,
  values,
}: {
  activeCount: number;
  /** Whom the list can be filtered to as assignee: label, and user id. */
  assignees: Option[];
  /** The current view with every filter removed. */
  clearHref: string;
  lanes: Option[];
  mode: "all" | "inbox" | "my_work";
  priorities: Option[];
  projects: Option[];
  /** Whom the list can be filtered to as reporter: label, and user id. */
  reporters: Option[];
  states: Option[];
  types: Option[];
  values: RequestFilterValues;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const href = requestFilterHref(event.currentTarget);
    setOpen(false);
    router.push(href);
  }

  // Not modal, as the settings dialogs are not (administration-forms.tsx,
  // FormDialog): a modal sheet hides every other <body> child from assistive
  // technology, and cue-ui gives the reporter and assignee Selects' listboxes
  // containers of their own there, so their options would be unreachable.
  // Pointer dismissal is off so a press inside an open listbox, which sits
  // outside the sheet, does not close it.
  return (
    <Sheet.Root
      disablePointerDismissal
      modal={false}
      onOpenChange={setOpen}
      open={open}
    >
      <Sheet.Trigger
        render={<Button icon={ListFilter} size="sm" variant="secondary" />}
      >
        {activeCount > 0 ? `Filters (${activeCount})` : "Filters"}
      </Sheet.Trigger>
      <Sheet.Content side="right">
        <Sheet.Title>Filter requests</Sheet.Title>
        <Sheet.Description>
          Every filter is kept in the address, so a filtered list can be
          bookmarked and shared.
        </Sheet.Description>
        <form
          action="/requests"
          aria-label="Request filters"
          method="get"
          onSubmit={submit}
        >
          {mode !== "all" ? (
            <input name="view" type="hidden" value={mode} />
          ) : null}
          <div className="grid grid-cols-1 gap-(--cue-space-4) py-(--cue-space-4) sm:grid-cols-2">
            <Field name="state">
              <FieldLabel>State</FieldLabel>
              <Select
                defaultValue={values.state ?? ""}
                items={[{ label: "Any state", value: "" }, ...states]}
                name="state"
                size="sm"
              />
            </Field>
            <Field name="type">
              <FieldLabel>Type</FieldLabel>
              <Select
                defaultValue={values.type ?? ""}
                items={[{ label: "Any type", value: "" }, ...types]}
                name="type"
                size="sm"
              />
            </Field>
            <Field name="priority">
              <FieldLabel>Priority</FieldLabel>
              <Select
                defaultValue={values.priority ?? ""}
                items={[{ label: "Any priority", value: "" }, ...priorities]}
                name="priority"
                size="sm"
              />
            </Field>
            <Field name="laneId">
              <FieldLabel>Lane</FieldLabel>
              <Select
                defaultValue={values.laneId ?? ""}
                items={[{ label: "Any lane", value: "" }, ...lanes]}
                name="laneId"
                size="sm"
              />
            </Field>
            <Field name="sourceProjectId">
              <FieldLabel>Source project</FieldLabel>
              <Select
                defaultValue={values.sourceProjectId ?? ""}
                items={[{ label: "Any source", value: "" }, ...projects]}
                name="sourceProjectId"
                size="sm"
              />
            </Field>
            <Field name="targetProjectId">
              <FieldLabel>Target project</FieldLabel>
              <Select
                defaultValue={values.targetProjectId ?? ""}
                items={[{ label: "Any target", value: "" }, ...projects]}
                name="targetProjectId"
                size="sm"
              />
            </Field>
            <Field name="label">
              <FieldLabel>Label</FieldLabel>
              <Input defaultValue={values.label} name="label" size="sm" />
            </Field>
            <Field name="updatedAfter">
              <FieldLabel>Updated after</FieldLabel>
              <Input
                defaultValue={values.updatedAfter}
                name="updatedAfter"
                size="sm"
                type="date"
              />
            </Field>
            <Field name="reporterId">
              <FieldLabel>Reporter</FieldLabel>
              <Select
                defaultValue={values.reporterId ?? ""}
                items={[
                  { label: "Any reporter", value: "" },
                  ...withValueInForce(reporters, values.reporterId),
                ]}
                name="reporterId"
                size="sm"
              />
            </Field>
            <Field name="assigneeId">
              <FieldLabel>Assignee</FieldLabel>
              <Select
                defaultValue={values.assigneeId ?? ""}
                items={[
                  { label: "Any assignee", value: "" },
                  ...withValueInForce(assignees, values.assigneeId),
                ]}
                name="assigneeId"
                size="sm"
              />
            </Field>
            <Checkbox
              defaultChecked={values.unanswered}
              label="Has an open question"
              name="unanswered"
              value="true"
            />
          </div>
          <Sheet.Footer>
            <Button
              onClick={() => setOpen(false)}
              render={<Link href={clearHref} />}
              size="sm"
              variant="ghost"
            >
              Clear all
            </Button>
            <Button size="sm" type="submit" variant="primary">
              Apply filters
            </Button>
          </Sheet.Footer>
        </form>
      </Sheet.Content>
    </Sheet.Root>
  );
}

/**
 * A strip of cue-ui tabs whose tabs are links: a view or a section that is an
 * address, read back on the server. `value` names the tab the page is on.
 */
export function LinkTabs({
  label,
  tabs,
  value,
}: {
  label: string;
  /** `count`, when given, is drawn after the label: how many the tab holds. */
  tabs: ReadonlyArray<{
    count?: number;
    href: string;
    label: string;
    value: string;
  }>;
  value: string;
}) {
  return (
    <nav aria-label={label}>
      <Tabs.Root value={value}>
        <Tabs.List>
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab.value}
              nativeButton={false}
              render={
                <Link
                  aria-current={tab.value === value ? "page" : undefined}
                  href={tab.href}
                />
              }
              value={tab.value}
            >
              {tab.label}
              {tab.count === undefined ? null : (
                <span className="text-fg-muted"> {tab.count}</span>
              )}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.Root>
    </nav>
  );
}

/** One active filter: a link to the same list without it. */
export function RemoveFilterLink({
  href,
  text,
}: {
  href: string;
  text: string;
}) {
  return (
    <Button
      aria-label={`Remove filter ${text}`}
      icon={X}
      render={<Link href={href} />}
      size="sm"
      variant="secondary"
    >
      {text}
    </Button>
  );
}

/** The selected request's top strip: its key, the way to its record, and out. */
export function RequestPreviewHeader({
  backHref,
  displayKey,
  recordHref,
}: {
  backHref: string;
  displayKey: string;
  recordHref: string;
}) {
  return (
    <div className="flex items-center gap-(--cue-space-2) border-b border-border px-(--cue-space-5) py-(--cue-space-2)">
      <span className="flex-1 font-mono text-(length:--cue-text-ui) text-fg-muted">
        {displayKey}
      </span>
      <Button
        icon={ArrowUpRight}
        render={<Link href={recordHref} />}
        size="sm"
        variant="ghost"
      >
        Open full record
      </Button>
      <IconButton
        aria-label="Close the request"
        icon={X}
        render={<Link href={backHref} />}
        size="sm"
        variant="ghost"
      />
    </div>
  );
}

/**
 * The selected request's three views. They are views of one record rather
 * than addresses, so they are cue-ui `Tabs` proper; the record page holds the
 * full history.
 */
export function RequestPreviewTabs({
  activity,
  defaultValue,
  details,
  questions,
  questionsLabel,
}: {
  activity: ReactNode;
  defaultValue: "activity" | "details" | "questions";
  details: ReactNode;
  questions: ReactNode;
  questionsLabel: string;
}) {
  return (
    <Tabs.Root defaultValue={defaultValue}>
      <Tabs.List className="px-(--cue-space-5)">
        <Tabs.Tab value="details">Details</Tabs.Tab>
        <Tabs.Tab value="questions">{questionsLabel}</Tabs.Tab>
        <Tabs.Tab value="activity">Activity</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel
        className="flex flex-col gap-(--cue-space-5) p-(--cue-space-5)"
        value="details"
      >
        {details}
      </Tabs.Panel>
      <Tabs.Panel
        className="flex flex-col gap-(--cue-space-4) p-(--cue-space-5)"
        value="questions"
      >
        {questions}
      </Tabs.Panel>
      <Tabs.Panel
        className="flex flex-col gap-(--cue-space-4) p-(--cue-space-5)"
        value="activity"
      >
        {activity}
      </Tabs.Panel>
    </Tabs.Root>
  );
}
