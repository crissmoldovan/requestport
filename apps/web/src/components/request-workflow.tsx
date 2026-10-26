import {
  EmptyState,
  Inspector,
  PageShell,
  Panel,
  PanelHeader,
  Row,
  SectionHeader,
} from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import {
  Breadcrumb,
  Link as CueLink,
  DescriptionList,
  Disclosure,
  Stack,
  Timeline,
} from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import type {
  CursorPage,
  RequestDetail,
  RequestListItem,
  RequestQuestionView,
  TimelineEventView,
} from "@requestport/domain";
import { Activity, ListX, MessageCircleQuestion, SearchX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { MarkdownContent } from "./markdown-content.js";
import { Page, PageSection } from "./page-layout.js";
import {
  AnswerQuestionForm,
  ArtifactLinkForm,
  AskQuestionForm,
  AssignRequestForm,
  CloseQuestionForm,
  MessageComposer,
  RelationshipForm,
  RequestEditForm,
  RequestTransitionForm,
  UnlinkRelationshipForm,
} from "./request-forms.js";
import {
  LinkTabs,
  RemoveFilterLink,
  RequestFilterSheet,
  RequestPreviewHeader,
  RequestPreviewTabs,
  RequestRow,
  RequestRowTitle,
  RequestWorkbenchShell,
} from "./request-workbench-shell.js";

/**
 * The request and collaboration surfaces, on native CUE++ composition, laid
 * out as the console prototype (`docs/design/console-prototype`) draws them.
 *
 * Choices a reader would otherwise assume were overlooked:
 *
 * - every view, filter and selection on the list is an address the page reads
 *   on the server. The views are CUE++ `Tabs` whose tabs render as links, the
 *   active filters are links that drop their own parameter, and a row selects
 *   by navigating — so which requests a reader is looking at, and which one
 *   is open, never lives only in the browser. What does is whether the filter
 *   sheet is open, which of the open request's tabs is showing, and how wide
 *   the list has been dragged;
 * - the request list is a compound `Table` inside a named, keyboard-focusable
 *   `TableScrollRegion`, the specification's §4.3 contract for tabular data;
 * - an open question is drawn as a card of CUE++ parts around the existing
 *   answer form, not as cue-ui's `QuestionCard`. That component ships only in
 *   `@cueplusplus/ui/elements`, whose entry module imports every element:
 *   `activity-graph.js` imports the optional peer `heat-graph`, and the
 *   Markdown elements `micromark-extension-gfm-table` and
 *   `mdast-util-gfm-table`, none of which this workspace declares. Declaring
 *   them was weighed and left (ruling 262's record): `heat-graph` brings
 *   eleven `@radix-ui` packages into the audited production set. And
 *   `QuestionCard` answers in free text only, where these questions may also
 *   offer structured choices;
 * - `StatusDot` never appears. Its shipped vocabulary is `ok | busy | warn |
 *   danger | idle`, and a request state, a priority or a label is none of
 *   those, so §6.2 sends all three to `Chip`.
 */

function shortDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

/**
 * How long ago something changed, in the list's one-line shorthand: `now`,
 * `4m`, `3h`, `2d`, then the date. The exact time is the `<time>` element's
 * title and `dateTime`, so the shorthand never has to carry it.
 */
function requestAge(value: Date, now: Date) {
  const minutes = Math.floor((now.getTime() - value.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(value);
}

function eventLabel(type: string) {
  return type
    .replace(/\.v\d+$/u, "")
    .split(".")
    .join(" ")
    .replace(/_/gu, " ");
}

/** A domain value in sentence case: `in_progress` reads `In progress`. */
function humanize(value: string) {
  const spaced = value.replaceAll("_", " ");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

/** The two waiting states say who is being waited on; the rest humanize. */
function stateLabel(state: string) {
  if (state === "waiting_human") return "Waiting on a person";
  if (state === "waiting_requester") return "Waiting on the requester";
  return humanize(state);
}

function reportValue(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function changedRepositoryLabel(repository: Record<string, unknown>) {
  return (
    reportValue(
      repository,
      "repositoryUrl",
      "repository_url",
      "url",
      "repository",
    ) ?? "Repository change"
  );
}

function changedRepositoryDetail(repository: Record<string, unknown>) {
  const commit = reportValue(
    repository,
    "commitSha",
    "commit_sha",
    "commit",
    "sha",
  );
  const reference = reportValue(
    repository,
    "reference",
    "branch",
    "pullRequestUrl",
    "pull_request_url",
  );
  return (
    [commit ? `commit ${commit}` : null, reference]
      .filter(Boolean)
      .join(" · ") || "No commit reference supplied"
  );
}

function validationLabel(validation: Record<string, unknown>) {
  return (
    reportValue(validation, "name", "command", "check", "label") ?? "Validation"
  );
}

function validationDetail(validation: Record<string, unknown>) {
  const status = reportValue(validation, "status", "result", "outcome");
  const detail = reportValue(validation, "details", "summary", "output");
  return (
    [status, detail].filter(Boolean).join(" · ") ||
    "No validation detail supplied"
  );
}

function keyedRecords(records: Array<Record<string, unknown>>) {
  const occurrences = new Map<string, number>();
  return records.map((record) => {
    const base = JSON.stringify(
      Object.entries(record).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}:${occurrence}`, record };
  });
}

/**
 * A request or question state, in the chip vocabulary.
 *
 * The return type is the closed union rather than `string` on purpose: the
 * native audit verifies a variant from the value's *type*, so a helper that
 * returned `string` would be rejected however careful its body was.
 */
function stateTone(
  state: string,
): "accent" | "busy" | "danger" | "info" | "neutral" | "ok" | "warn" {
  if (["verified", "completed", "answered"].includes(state)) return "ok";
  if (["accepted", "planned"].includes(state)) return "accent";
  if (state === "in_progress") return "busy";
  if (["submitted", "triage"].includes(state)) return "info";
  if (["blocked", "declined"].includes(state)) return "danger";
  if (["waiting_human", "waiting_requester", "open"].includes(state)) {
    return "warn";
  }
  return "neutral";
}

export function RequestStateBadge({ state }: { state: string }) {
  return <Chip tone={stateTone(state)}>{stateLabel(state)}</Chip>;
}

/** Where a request came from and where it went: `Web → Platform / release`. */
function requestRoute(
  request: Pick<
    RequestListItem,
    "laneName" | "sourceProjectName" | "targetProjectName"
  >,
) {
  return `${request.sourceProjectName ?? "Human direct"} → ${request.targetProjectName}${request.laneName ? ` / ${request.laneName}` : ""}`;
}

/**
 * A reporter or an assignee as the console names them: the person's name, or
 * their email when the name is blank, or the agent's display name
 * (`displayName`, read by joining the organisation's members and agents),
 * else the short id the row holds.
 */
function personLabel(
  displayName: string | null,
  type: string | null,
  id: string | null,
) {
  if (displayName) return displayName;
  return type && id ? `${type}:${id.slice(0, 12)}` : "Unassigned";
}

/**
 * Who wrote a message or an answer, named as `personLabel` names a reporter:
 * the name when the read found one, else the short id in a monospace face.
 */
function ActorName({
  displayName,
  id,
  type,
}: {
  displayName: string | null;
  id: string;
  type: string;
}) {
  return displayName ? (
    <span className="text-(length:--cue-text-ui) text-fg-muted">
      {displayName}
    </span>
  ) : (
    <span className="font-mono text-(length:--cue-text-ui) text-fg-muted">
      {type}:{id.slice(0, 12)}
    </span>
  );
}

/**
 * What a question asked, on one line of at most 80 characters: how the
 * record's Deliveries name the question each delivery was for. The Markdown
 * is shown as written, not rendered.
 */
function questionExcerpt(bodyMd: string) {
  const line = bodyMd.replace(/\s+/gu, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The state, the facts beside it, and the route, on one wrapping line. */
function RequestFacts({ request }: { request: RequestDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-(--cue-space-2)">
      <RequestStateBadge state={request.state} />
      <Chip variant="tag">{humanize(request.priority)} priority</Chip>
      <Chip variant="tag">{humanize(request.type)}</Chip>
      {request.visibility === "restricted" ? (
        <Chip tone="warn" variant="tag">
          Restricted
        </Chip>
      ) : null}
      {request.sensitivity === "sensitive" ? (
        <Chip tone="warn" variant="tag">
          Sensitive
        </Chip>
      ) : null}
      <span className="text-(length:--cue-text-ui) text-fg-muted">
        {requestRoute(request)}
      </span>
    </div>
  );
}

/**
 * A section of the record: a CUE++ `SectionHeader` whose label is the
 * section's heading. The label slot is a `<span>`, which may not contain an
 * `<h2>`, so the heading is the span's child announced through
 * `role="heading"` — a screen-reader user still jumps between sections.
 */
function RecordSection({
  children,
  count,
  headingId,
  title,
}: {
  children: ReactNode;
  count?: number;
  headingId: string;
  title: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-(--cue-space-3)"
    >
      <SectionHeader
        count={count}
        label={
          // biome-ignore lint/a11y/useSemanticElements: the label slot is a <span>, and a <span> may not contain an <h2>.
          <span aria-level={2} id={headingId} role="heading">
            {title}
          </span>
        }
      />
      {children}
    </section>
  );
}

function RequestTimeline({ page }: { page: CursorPage<TimelineEventView> }) {
  return (
    <Timeline.Root>
      {page.items.map((event) => (
        <Timeline.Item key={event.id}>
          <Timeline.Marker label={eventLabel(event.type)} tone="idle" />
          <Timeline.Content>
            <Stack direction="column" gap={1}>
              <span>{eventLabel(event.type)}</span>
              <span className="text-fg-subtle">
                {event.actorDisplayName ?? String(event.actor.type ?? "actor")}{" "}
                · v{event.aggregateVersion} ·{" "}
                <time dateTime={event.occurredAt.toISOString()}>
                  {shortDate(event.occurredAt)}
                </time>
              </span>
            </Stack>
          </Timeline.Content>
        </Timeline.Item>
      ))}
    </Timeline.Root>
  );
}

type QuestionKeys = {
  answers: Record<string, string>;
  closes?: Record<string, string>;
  fallback: string;
};

/**
 * One open question: what was asked, of whom, the answers it allows, and the
 * existing answer form. The answer goes through `answerQuestionAction`
 * unchanged — this is the question's frame, not a second way to answer it.
 */
function RequestQuestionCard({
  keys,
  question,
  requestId,
  title,
}: {
  keys: QuestionKeys;
  question: RequestQuestionView;
  requestId?: string;
  title?: ReactNode;
}) {
  return (
    <Panel>
      <PanelHeader
        actions={
          <Chip tone={question.blocksRequest ? "warn" : "neutral"}>
            {question.blocksRequest ? "Blocking" : "Non-blocking"}
          </Chip>
        }
        title={
          title ?? `Asked of ${question.audienceType.replaceAll("_", " ")}`
        }
      />
      <Row>
        <Stack direction="column" gap={3}>
          <MarkdownContent>{question.bodyMd}</MarkdownContent>
          {question.choices.length ? (
            <Stack
              aria-label="Allowed answers"
              direction="row"
              gap={2}
              role="group"
              wrap
            >
              {question.choices.map((choice) => (
                <Chip key={choice} variant="tag">
                  {choice}
                </Chip>
              ))}
            </Stack>
          ) : null}
          <p className="text-(length:--cue-text-ui) text-fg-subtle">
            {[
              `Asked ${shortDate(question.createdAt)}`,
              question.deadlineAt
                ? `due ${shortDate(question.deadlineAt)}`
                : null,
              question.allowFreeText
                ? "Free-text answers allowed"
                : "Structured choices only",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {question.answers.map((answer) => (
            <Stack direction="column" gap={1} key={answer.id}>
              <ActorName
                displayName={answer.actorDisplayName}
                id={answer.actorId}
                type={answer.actorType}
              />
              <MarkdownContent>{answer.bodyMd}</MarkdownContent>
            </Stack>
          ))}
          {question.state === "open" && question.canAnswer ? (
            <AnswerQuestionForm
              idempotencyKey={keys.answers[question.id] ?? keys.fallback}
              question={question}
            />
          ) : null}
          {requestId &&
          keys.closes &&
          question.state === "open" &&
          question.answerMode === "multiple" &&
          question.canClose ? (
            <CloseQuestionForm
              idempotencyKey={keys.closes[question.id] ?? keys.fallback}
              question={question}
              requestId={requestId}
            />
          ) : null}
        </Stack>
      </Row>
    </Panel>
  );
}

/** A question nobody needs to answer any more: what was asked and how it ended. */
function SettledQuestion({ question }: { question: RequestQuestionView }) {
  return (
    <Stack direction="column" gap={1}>
      <Stack align="center" direction="row" gap={2} wrap>
        <RequestStateBadge state={question.state} />
        <span className="text-(length:--cue-text-ui) text-fg-muted">
          {question.answers.length} answer
          {question.answers.length === 1 ? "" : "s"}
        </span>
      </Stack>
      <MarkdownContent>{question.bodyMd}</MarkdownContent>
      {question.answers.map((answer) => (
        <Stack direction="column" gap={1} key={answer.id}>
          <ActorName
            displayName={answer.actorDisplayName}
            id={answer.actorId}
            type={answer.actorType}
          />
          <MarkdownContent>{answer.bodyMd}</MarkdownContent>
        </Stack>
      ))}
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * The list.
 * ------------------------------------------------------------------ */

type RequestListMode = "all" | "inbox" | "my_work";

type RequestListQuery = {
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

/** A `/requests` address from a set of parameters, with no empty `?`. */
function listHref(params: URLSearchParams) {
  const query = params.toString();
  return query ? `/requests?${query}` : "/requests";
}

function requestHref(queryString: string, requestId: string) {
  return `/requests?${queryString ? `${queryString}&` : ""}requestId=${requestId}`;
}

/** How many requests each view's tab would list, by the view's value. */
export type RequestViewCounts = Record<
  "all" | "inbox" | "my_work" | "waiting",
  number
>;

/**
 * The four views, each keeping whatever filters are set.
 *
 * "Waiting on an answer" is the `unanswered=true` filter over every request,
 * so it owns that parameter: choosing any other view drops it, and the filter
 * shows as a chip only when it is combined with Inbox or My work. `counts`,
 * when given, is how many requests each tab's own address lists.
 */
function requestViews(queryString: string, counts?: RequestViewCounts) {
  const base = new URLSearchParams(queryString);
  base.delete("view");
  base.delete("unanswered");
  const withParam = (key: string, value: string) => {
    const params = new URLSearchParams(base);
    params.set(key, value);
    return listHref(params);
  };
  return [
    { count: counts?.all, href: listHref(base), label: "All", value: "all" },
    {
      count: counts?.inbox,
      href: withParam("view", "inbox"),
      label: "Inbox",
      value: "inbox",
    },
    {
      count: counts?.my_work,
      href: withParam("view", "my_work"),
      label: "My work",
      value: "my_work",
    },
    {
      count: counts?.waiting,
      href: withParam("unanswered", "true"),
      label: "Waiting on an answer",
      value: "waiting",
    },
  ] as const;
}

type ListMember = { userId: string; name: string; email: string };

/**
 * What the list calls a reporter or an assignee filter's value (ruling 264):
 * the member's name, or their email when the name is blank; else the name a
 * listed row gives that reporter or assignee (an agent, or someone no longer
 * a member); else the short id the parameter holds.
 */
function filterPersonLabel(
  id: string,
  members: readonly ListMember[],
  items: readonly RequestListItem[],
) {
  const member = members.find((candidate) => candidate.userId === id);
  if (member) return member.name.trim() || member.email;
  for (const item of items) {
    if (item.reporterId === id && item.reporterDisplayName)
      return item.reporterDisplayName;
    if (item.assigneeId === id && item.assigneeDisplayName)
      return item.assigneeDisplayName;
  }
  return id.slice(0, 12);
}

/**
 * The filters in force beyond the view, each with the address that drops it.
 *
 * The labels name projects, lanes and people by name, because the parameter
 * holds an identifier nobody reads; an identifier the page could not name is
 * still a filter in force, so it is shown rather than hidden.
 */
function activeFilters({
  items,
  lanes,
  members,
  mode,
  projects,
  query,
  queryString,
}: {
  items: readonly RequestListItem[];
  lanes: Array<{ id: string; name: string }>;
  members: readonly ListMember[];
  mode: RequestListMode;
  projects: Array<{ id: string; name: string }>;
  query: RequestListQuery;
  queryString: string;
}) {
  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ?? id.slice(0, 8);
  const entries: Array<{ key: string; text: string } | null> = [
    query.state
      ? { key: "state", text: `State: ${stateLabel(query.state)}` }
      : null,
    query.type ? { key: "type", text: `Type: ${humanize(query.type)}` } : null,
    query.priority
      ? { key: "priority", text: `Priority: ${humanize(query.priority)}` }
      : null,
    query.sourceProjectId
      ? {
          key: "sourceProjectId",
          text: `From: ${projectName(query.sourceProjectId)}`,
        }
      : null,
    query.targetProjectId
      ? {
          key: "targetProjectId",
          text: `To: ${projectName(query.targetProjectId)}`,
        }
      : null,
    query.laneId
      ? {
          key: "laneId",
          text: `Lane: ${lanes.find((lane) => lane.id === query.laneId)?.name ?? query.laneId.slice(0, 8)}`,
        }
      : null,
    query.label ? { key: "label", text: `Label: ${query.label}` } : null,
    query.reporterId
      ? {
          key: "reporterId",
          text: `Reporter: ${filterPersonLabel(query.reporterId, members, items)}`,
        }
      : null,
    query.assigneeId
      ? {
          key: "assigneeId",
          text: `Assignee: ${filterPersonLabel(query.assigneeId, members, items)}`,
        }
      : null,
    query.updatedAfter
      ? { key: "updatedAfter", text: `Updated after ${query.updatedAfter}` }
      : null,
    query.unanswered && mode !== "all"
      ? { key: "unanswered", text: "Has an open question" }
      : null,
  ];
  return entries
    .filter((entry) => entry !== null)
    .map((entry) => {
      const params = new URLSearchParams(queryString);
      params.delete(entry.key);
      return { ...entry, href: listHref(params) };
    });
}

function RequestTable({
  items,
  listQuery,
  now,
  selectedId,
}: {
  items: RequestListItem[];
  /** The list being read, its page included, which a row's link keeps. */
  listQuery: string;
  now: Date;
  selectedId: string | null;
}) {
  return (
    <TableScrollRegion aria-label="Requests">
      <Table.Root>
        <Table.Caption className="sr-only">Requests in this view</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Request</Table.Head>
            <Table.Head>State</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {items.map((item) => {
            const href = requestHref(listQuery, item.id);
            const selected = selectedId === item.id;
            return (
              <RequestRow href={href} key={item.id} selected={selected}>
                <Table.Cell>
                  <Stack direction="column" gap={1}>
                    <RequestRowTitle href={href} selected={selected}>
                      {item.title}
                    </RequestRowTitle>
                    <span className="text-(length:--cue-text-ui) text-fg-muted">
                      {item.unread ? (
                        <>
                          <Chip tone="accent" variant="tag">
                            Unread
                          </Chip>{" "}
                        </>
                      ) : null}
                      <span className="font-mono">
                        {item.displayKey ?? "Draft"}
                      </span>
                      {` · ${humanize(item.type)} · ${humanize(item.priority)} · `}
                      <time
                        dateTime={item.updatedAt.toISOString()}
                        title={`Updated ${shortDate(item.updatedAt)}`}
                      >
                        {requestAge(item.updatedAt, now)}
                      </time>
                      {item.openQuestionCount > 0
                        ? ` · ${item.openQuestionCount} open question${item.openQuestionCount === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </Stack>
                </Table.Cell>
                <Table.Cell>
                  <RequestStateBadge state={item.state} />
                </Table.Cell>
              </RequestRow>
            );
          })}
        </Table.Body>
      </Table.Root>
    </TableScrollRegion>
  );
}

/**
 * Every value the page accepts for the three closed filters, in the order the
 * sheet offers them. Written as records keyed by the domain's own unions, so
 * the compiler refuses a list that misses a value or names one the domain does
 * not have — without importing the domain's runtime into a component.
 */
const filterableStates: Record<RequestListItem["state"], null> = {
  draft: null,
  submitted: null,
  triage: null,
  accepted: null,
  planned: null,
  in_progress: null,
  blocked: null,
  waiting_human: null,
  waiting_requester: null,
  completed: null,
  verified: null,
  declined: null,
  duplicate: null,
  superseded: null,
  cancelled: null,
};
const filterableTypes: Record<RequestListItem["type"], null> = {
  feature: null,
  bug: null,
  question: null,
  investigation: null,
  chore: null,
};
const filterablePriorities: Record<RequestListItem["priority"], null> = {
  urgent: null,
  high: null,
  normal: null,
  low: null,
};
const stateFilterItems = Object.keys(filterableStates).map((state) => ({
  label: stateLabel(state),
  value: state,
}));
const typeFilterItems = Object.keys(filterableTypes).map((type) => ({
  label: humanize(type),
  value: type,
}));
const priorityFilterItems = Object.keys(filterablePriorities).map(
  (priority) => ({ label: humanize(priority), value: priority }),
);

export function RequestListView({
  counts,
  cursor,
  lanes,
  members = [],
  mode,
  now,
  page,
  projects,
  query,
  queryString,
  selected,
}: {
  /** How many requests each view lists, with the filters in force. */
  counts?: RequestViewCounts;
  /** The page of the list the reader is on, when it is not the first. */
  cursor?: string;
  lanes: Array<{ id: string; name: string; projectId: string }>;
  /**
   * The organisation's active members: whom the selected request can go to,
   * and whom the filter sheet offers as reporter and assignee.
   */
  members?: ListMember[];
  mode: RequestListMode;
  /** The moment the page was read, which every row's age is measured from. */
  now: Date;
  page: CursorPage<RequestListItem>;
  projects: Array<{ id: string; name: string }>;
  query: RequestListQuery;
  /** The view and the filters in force, as the page will read them back. */
  queryString: string;
  selected: {
    keys: {
      answers: Record<string, string>;
      assign: string;
      transition: string;
    };
    request: RequestDetail;
    timeline: CursorPage<TimelineEventView>;
  } | null;
}) {
  const views = requestViews(queryString, counts);
  const activeView = mode === "all" && query.unanswered ? "waiting" : mode;
  // The active view with no filter kept: where Clear all goes.
  const viewHref =
    requestViews("").find((view) => view.value === activeView)?.href ??
    "/requests";
  const filters = activeFilters({
    items: page.items,
    lanes,
    members,
    mode,
    projects,
    query,
    queryString,
  });
  const people = members.map((member) => ({
    label: member.name.trim() || member.email,
    value: member.userId,
  }));
  // A reporter or an assignee in force whom the members do not include (an
  // agent, or someone since removed) stays the selection, named as its chip.
  const peopleWith = (id: string | undefined) =>
    id && !members.some((member) => member.userId === id)
      ? [
          { label: filterPersonLabel(id, members, page.items), value: id },
          ...people,
        ]
      : people;
  const projectItems = projects.map((project) => ({
    label: project.name,
    value: project.id,
  }));
  const laneItems = lanes
    .filter(
      (lane) =>
        !query.targetProjectId || lane.projectId === query.targetProjectId,
    )
    .map((lane) => ({ label: lane.name, value: lane.id }));
  // The list as it is being read, its page included: where selecting a row,
  // Close and the stacked Back go, so the reader stays on that page. A view,
  // a chip and Clear all choose another list, which starts at its first page,
  // so none carries the cursor: views and chips are built from `queryString`,
  // Clear all from the view alone.
  const listParams = new URLSearchParams(queryString);
  if (cursor) listParams.set("cursor", cursor);
  const listQuery = listParams.toString();
  const backHref = listHref(listParams);

  return (
    <Page
      action={
        <Button
          render={<Link href="/requests/new" />}
          size="sm"
          variant="primary"
        >
          New request
        </Button>
      }
      description="What projects, agents and people have asked of each other."
      eyebrow="Workflow"
      title="Requests"
      width="wide"
    >
      <PageSection>
        <Stack direction="column" gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-(--cue-space-3)">
            <LinkTabs label="Request views" tabs={views} value={activeView} />
            <RequestFilterSheet
              activeCount={filters.length}
              assignees={peopleWith(query.assigneeId)}
              clearHref={viewHref}
              lanes={laneItems}
              mode={mode}
              priorities={priorityFilterItems}
              projects={projectItems}
              reporters={peopleWith(query.reporterId)}
              states={stateFilterItems}
              types={typeFilterItems}
              values={query}
            />
          </div>
          {filters.length > 0 ? (
            <Stack
              align="center"
              aria-label="Active filters"
              direction="row"
              gap={2}
              role="group"
              wrap
            >
              {filters.map((filter) => (
                <RemoveFilterLink
                  href={filter.href}
                  key={filter.key}
                  text={filter.text}
                />
              ))}
              <Button
                render={<Link href={viewHref} />}
                size="sm"
                variant="ghost"
              >
                Clear all
              </Button>
            </Stack>
          ) : null}
          <RequestWorkbenchShell
            backHref={backHref}
            detail={
              selected ? (
                // Keyed by the request: choosing another row changes only
                // `?requestId=`, and the router keeps the page's components
                // across a change of search parameters, so without a key the
                // next step's chosen transition, its result and the open tab
                // would carry over from the request selected before.
                <RequestPreview
                  backHref={backHref}
                  key={selected.request.id}
                  keys={selected.keys}
                  members={members}
                  request={selected.request}
                  timeline={selected.timeline}
                />
              ) : null
            }
            hasDetail={Boolean(selected)}
            list={
              page.items.length > 0 ? (
                <RequestTable
                  items={page.items}
                  listQuery={listQuery}
                  now={now}
                  selectedId={selected?.request.id ?? null}
                />
              ) : filters.length > 0 ? (
                <EmptyState
                  action={
                    <Button
                      render={<Link href={viewHref} />}
                      size="sm"
                      variant="secondary"
                    >
                      Clear filters
                    </Button>
                  }
                  hint="Try another view, or clear the filters to see every request in this one."
                  icon={SearchX}
                  title="Nothing matches these filters"
                />
              ) : (
                <EmptyState
                  hint="Open one with New request, or connect an agent to submit one on behalf of a project."
                  icon={ListX}
                  title="No requests in this view"
                />
              )
            }
          />
          {page.nextCursor ? (
            <Button
              render={
                <Link
                  href={`/requests?${queryString ? `${queryString}&` : ""}cursor=${encodeURIComponent(page.nextCursor)}`}
                />
              }
              size="sm"
              variant="ghost"
            >
              Load older requests
            </Button>
          ) : null}
        </Stack>
      </PageSection>
    </Page>
  );
}

/**
 * The selected request beside the list: its header, its next step, and its
 * three tabs (`RequestPreviewTabs`).
 */
function RequestPreview({
  backHref,
  keys,
  members,
  request,
  timeline,
}: {
  backHref: string;
  keys: { answers: Record<string, string>; assign: string; transition: string };
  members: Array<{ userId: string; name: string; email: string }>;
  request: RequestDetail;
  timeline: CursorPage<TimelineEventView>;
}) {
  const openQuestions = request.questions.filter(
    (question) => question.state === "open",
  );
  const settledQuestions = request.questions.filter(
    (question) => question.state !== "open",
  );
  const liveSession = request.workSessions.find((session) =>
    ["claimed", "active", "paused", "blocked", "stale"].includes(session.state),
  );

  return (
    <article aria-labelledby="selected-request-title">
      <RequestPreviewHeader
        backHref={backHref}
        displayKey={request.displayKey ?? "Draft"}
        recordHref={`/requests/${request.id}`}
      />
      <div className="flex flex-col gap-(--cue-space-4) p-(--cue-space-5)">
        <h2
          className="text-(length:--cue-text-emphasis) font-semibold text-fg"
          id="selected-request-title"
        >
          {request.title}
        </h2>
        <RequestFacts request={request} />
        <RequestTransitionForm
          idempotencyKey={keys.transition}
          request={request}
        />
        {request.permissions.canAssign ? (
          <AssignRequestForm
            idempotencyKey={keys.assign}
            members={members}
            request={request}
          />
        ) : null}
      </div>
      <RequestPreviewTabs
        activity={
          <>
            <RequestTimeline
              page={{ items: timeline.items.slice(0, 8), nextCursor: null }}
            />
            <CueLink
              render={<Link href={`/requests/${request.id}`} />}
              variant="underline"
            >
              The full history is on the record
            </CueLink>
          </>
        }
        defaultValue={openQuestions.length > 0 ? "questions" : "details"}
        details={
          <>
            <MarkdownContent>{request.descriptionMd}</MarkdownContent>
            <DescriptionList.Root>
              <div>
                <DescriptionList.Term>From</DescriptionList.Term>
                <DescriptionList.Detail>
                  {request.sourceProjectName ?? "Human direct"}
                </DescriptionList.Detail>
              </div>
              <div>
                <DescriptionList.Term>To</DescriptionList.Term>
                <DescriptionList.Detail>
                  {request.targetProjectName}
                </DescriptionList.Detail>
              </div>
              <div>
                <DescriptionList.Term>Lane</DescriptionList.Term>
                <DescriptionList.Detail>
                  {request.laneName ?? "None"}
                </DescriptionList.Detail>
              </div>
              <div>
                <DescriptionList.Term>Assignee</DescriptionList.Term>
                <DescriptionList.Detail>
                  {personLabel(
                    request.assigneeDisplayName,
                    request.assigneeType,
                    request.assigneeId,
                  )}
                </DescriptionList.Detail>
              </div>
              <div>
                <DescriptionList.Term>Reporter</DescriptionList.Term>
                <DescriptionList.Detail>
                  {personLabel(
                    request.reporterDisplayName,
                    request.reporterType,
                    request.reporterId,
                  )}
                </DescriptionList.Detail>
              </div>
              <div>
                <DescriptionList.Term>Labels</DescriptionList.Term>
                <DescriptionList.Detail>
                  {request.labels.length ? request.labels.join(", ") : "None"}
                </DescriptionList.Detail>
              </div>
              <div>
                <DescriptionList.Term>Current work</DescriptionList.Term>
                <DescriptionList.Detail>
                  {liveSession
                    ? `${liveSession.agentDisplayName} · ${liveSession.state} · ${liveSession.latestProgress ?? "No progress update yet."}`
                    : "No active agent session."}
                </DescriptionList.Detail>
              </div>
              <div>
                <DescriptionList.Term>Created</DescriptionList.Term>
                <DescriptionList.Detail>
                  {shortDate(request.createdAt)}
                </DescriptionList.Detail>
              </div>
            </DescriptionList.Root>
          </>
        }
        questions={
          <>
            {openQuestions.map((question) => (
              <RequestQuestionCard
                key={question.id}
                keys={{ answers: keys.answers, fallback: question.id }}
                question={question}
              />
            ))}
            {settledQuestions.map((question) => (
              <SettledQuestion key={question.id} question={question} />
            ))}
            {request.questions.length === 0 ? (
              <EmptyState
                hint="When an agent needs a decision from a person, it appears here and in Questions."
                icon={MessageCircleQuestion}
                title="No questions on this request"
              />
            ) : null}
          </>
        }
        questionsLabel={
          openQuestions.length > 0
            ? `Questions (${openQuestions.length})`
            : "Questions"
        }
      />
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * The record.
 * ------------------------------------------------------------------ */

export const requestDetailTabs = [
  { label: "Relations", value: "relations" },
  { label: "Artifacts", value: "artifacts" },
  { label: "Agent sessions", value: "sessions" },
  { label: "Provenance", value: "provenance" },
] as const;

export type RequestDetailTab = (typeof requestDetailTabs)[number]["value"];

export function RequestDetailView({
  activeTab,
  keys,
  members,
  request,
  timeline,
}: {
  activeTab: RequestDetailTab;
  keys: {
    artifact: string;
    assign: string;
    edit: string;
    message: string;
    question: string;
    relationship: string;
    transition: string;
    answers: Record<string, string>;
    closes: Record<string, string>;
    unlinks: Record<string, string>;
  };
  members: Array<{ userId: string; name: string; email: string }>;
  request: RequestDetail;
  timeline: CursorPage<TimelineEventView>;
}) {
  const liveSession = request.workSessions.find((session) =>
    ["claimed", "active", "paused", "blocked", "stale"].includes(session.state),
  );
  const openQuestions = request.questions.filter(
    (question) => question.state === "open",
  );
  const settledQuestions = request.questions.filter(
    (question) => question.state !== "open",
  );
  const deliveredQuestions = request.questions.filter(
    (question) => question.deliveries.length > 0,
  );

  return (
    <PageShell className="break-words" width="broad">
      <div className="flex flex-wrap items-center justify-between gap-(--cue-space-3) border-b border-border pb-(--cue-space-3) text-(length:--cue-text-ui) text-fg-muted">
        <Breadcrumb
          items={[
            { href: "/requests", label: "Requests" },
            { label: request.displayKey ?? "Draft" },
          ]}
        />
        <span>
          Updated{" "}
          <time dateTime={request.updatedAt.toISOString()}>
            {shortDate(request.updatedAt)}
          </time>
        </span>
      </div>
      <div className="flex flex-col gap-(--cue-space-7) lg:flex-row lg:items-start">
        <article
          aria-labelledby="request-title"
          className="flex min-w-0 flex-1 flex-col gap-(--cue-space-6)"
        >
          <header className="flex flex-col gap-(--cue-space-3)">
            <h1
              className="text-(length:--cue-text-title) font-semibold text-fg"
              id="request-title"
            >
              {request.title}
            </h1>
            <RequestFacts request={request} />
          </header>
          {liveSession ? (
            <Panel>
              <Row>
                <Stack align="center" direction="row" gap={2} wrap>
                  <Chip tone="busy">{liveSession.state}</Chip>
                  <span>{liveSession.agentDisplayName}</span>
                  <span className="text-fg-subtle">
                    {liveSession.latestProgress ?? "No progress update yet."}
                  </span>
                  <time dateTime={liveSession.updatedAt.toISOString()}>
                    Updated {shortDate(liveSession.updatedAt)}
                  </time>
                  <CueLink
                    render={
                      <Link href={`/agents/${liveSession.agentPrincipalId}`} />
                    }
                    variant="underline"
                  >
                    Inspect session
                  </CueLink>
                </Stack>
              </Row>
            </Panel>
          ) : null}
          <RecordSection
            headingId="request-description-heading"
            title="Description"
          >
            <MarkdownContent>{request.descriptionMd}</MarkdownContent>
            {request.permissions.canEdit ? (
              <Disclosure label="Edit request content">
                <RequestEditForm idempotencyKey={keys.edit} request={request} />
              </Disclosure>
            ) : null}
          </RecordSection>
          <RecordSection
            count={request.acceptanceCriteria.length}
            headingId="criteria-heading"
            title="Acceptance criteria"
          >
            {request.acceptanceCriteria.length > 0 ? (
              <ol className="flex flex-col gap-(--cue-space-1)">
                {request.acceptanceCriteria.map((criterion) => (
                  <li key={criterion.id}>
                    <Stack align="center" direction="row" gap={2} wrap>
                      <Chip tone={criterion.satisfiedAt ? "ok" : "neutral"}>
                        {criterion.satisfiedAt ? "Met" : "Open"}
                      </Chip>
                      <span>{criterion.text}</span>
                    </Stack>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-fg-muted">No acceptance criteria yet.</p>
            )}
          </RecordSection>
          <RecordSection
            count={openQuestions.length}
            headingId="questions-heading"
            title="Questions"
          >
            {openQuestions.map((question) => (
              <RequestQuestionCard
                key={question.id}
                keys={{
                  answers: keys.answers,
                  closes: keys.closes,
                  fallback: keys.question,
                }}
                question={question}
                requestId={request.id}
              />
            ))}
            {settledQuestions.map((question) => (
              <SettledQuestion key={question.id} question={question} />
            ))}
            {request.questions.length === 0 ? (
              <p className="text-fg-muted">No questions on this request.</p>
            ) : null}
            {request.permissions.canParticipate ? (
              <Disclosure label="Ask a question">
                <AskQuestionForm
                  idempotencyKey={keys.question}
                  members={members}
                  request={request}
                />
              </Disclosure>
            ) : null}
          </RecordSection>
          <RecordSection headingId="activity-heading" title="Activity">
            <RequestTimeline page={timeline} />
            {timeline.nextCursor ? (
              <Button
                render={
                  <Link
                    href={`/requests/${request.id}?tab=${activeTab}&timelineCursor=${encodeURIComponent(timeline.nextCursor)}`}
                  />
                }
                size="sm"
                variant="ghost"
              >
                Older events
              </Button>
            ) : null}
            <h3 className="font-medium text-fg" id="conversation-heading">
              Conversation · {request.messages.length} comment
              {request.messages.length === 1 ? "" : "s"}
            </h3>
            {request.messages.map((message) => (
              <Stack direction="column" gap={1} key={message.id}>
                <Stack align="center" direction="row" gap={2} wrap>
                  <ActorName
                    displayName={message.actorDisplayName}
                    id={message.actorId}
                    type={message.actorType}
                  />
                  <time
                    className="text-(length:--cue-text-ui) text-fg-subtle"
                    dateTime={message.createdAt.toISOString()}
                  >
                    {shortDate(message.createdAt)}
                  </time>
                </Stack>
                <MarkdownContent>{message.bodyMd}</MarkdownContent>
              </Stack>
            ))}
            {request.permissions.canParticipate ? (
              <MessageComposer
                idempotencyKey={keys.message}
                requestId={request.id}
              />
            ) : null}
          </RecordSection>
          {request.completionReport ? (
            <RecordSection headingId="report-heading" title="Completion report">
              <p className="text-(length:--cue-text-ui) text-fg-subtle">
                Submitted {shortDate(request.completionReport.createdAt)}
              </p>
              <h3>Outcome</h3>
              <MarkdownContent>
                {request.completionReport.outcomeMd}
              </MarkdownContent>
              <h3>Changed repositories</h3>
              {request.completionReport.changedRepositories.length > 0 ? (
                <Stack direction="column" gap={1}>
                  {keyedRecords(
                    request.completionReport.changedRepositories,
                  ).map(({ key, record: repository }) => (
                    <Stack direction="column" gap={1} key={key}>
                      <span className="break-all">
                        {changedRepositoryLabel(repository)}
                      </span>
                      <span className="text-fg-subtle">
                        {changedRepositoryDetail(repository)}
                      </span>
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <p>No repository changes reported.</p>
              )}
              <h3>Validations</h3>
              {request.completionReport.validations.length > 0 ? (
                <Stack direction="column" gap={1}>
                  {keyedRecords(request.completionReport.validations).map(
                    ({ key, record: validation }) => (
                      <Stack direction="column" gap={1} key={key}>
                        <span className="font-mono">
                          {validationLabel(validation)}
                        </span>
                        <span className="text-fg-subtle">
                          {validationDetail(validation)}
                        </span>
                      </Stack>
                    ),
                  )}
                </Stack>
              ) : (
                <p>No validations reported.</p>
              )}
              <h3>Verification steps</h3>
              <MarkdownContent>
                {request.completionReport.verificationStepsMd}
              </MarkdownContent>
              {request.completionReport.risksMd.trim() ? (
                <>
                  <h3>Risks</h3>
                  <MarkdownContent>
                    {request.completionReport.risksMd}
                  </MarkdownContent>
                </>
              ) : null}
              {request.completionReport.followupsMd.trim() ? (
                <>
                  <h3>Follow-ups</h3>
                  <MarkdownContent>
                    {request.completionReport.followupsMd}
                  </MarkdownContent>
                </>
              ) : null}
            </RecordSection>
          ) : null}
          <RecordSection headingId="linked-work-heading" title="Linked work">
            <LinkTabs
              label="Request detail sections"
              tabs={requestDetailTabs.map((tab) => ({
                ...tab,
                href: `/requests/${request.id}?tab=${tab.value}`,
              }))}
              value={activeTab}
            />
            {activeTab === "relations" ? (
              <Stack direction="column" gap={3}>
                {request.relationships.length ? (
                  <Stack direction="column" gap={2}>
                    {request.relationships.map((relationship) => (
                      <Stack
                        align="center"
                        direction="row"
                        gap={2}
                        key={relationship.id}
                        wrap
                      >
                        <CueLink
                          render={
                            <Link
                              href={`/requests/${relationship.requestId}`}
                            />
                          }
                          variant="underline"
                        >
                          <span className="font-mono">
                            {relationship.displayKey ?? "Draft"}
                          </span>{" "}
                          · {relationship.title}
                        </CueLink>
                        <span className="text-fg-subtle">
                          {relationship.direction} ·{" "}
                          {relationship.type.replaceAll("_", " ")}
                        </span>
                        {relationship.direction === "outgoing" &&
                        request.permissions.canParticipate ? (
                          <UnlinkRelationshipForm
                            idempotencyKey={
                              keys.unlinks[relationship.id] ?? keys.relationship
                            }
                            relationshipId={relationship.id}
                            requestId={request.id}
                          />
                        ) : null}
                      </Stack>
                    ))}
                  </Stack>
                ) : (
                  <p className="text-fg-muted">No related requests.</p>
                )}
                {request.permissions.canParticipate ? (
                  <Disclosure label="Link another request">
                    <RelationshipForm
                      idempotencyKey={keys.relationship}
                      requestId={request.id}
                    />
                  </Disclosure>
                ) : null}
              </Stack>
            ) : null}
            {activeTab === "artifacts" ? (
              <Stack direction="column" gap={3}>
                <p className="text-(length:--cue-text-ui) text-fg-subtle">
                  Metadata and external links only.
                </p>
                {request.artifacts.length > 0 ? (
                  <Stack direction="column" gap={2}>
                    {request.artifacts.map((artifact) => (
                      <Stack
                        align="center"
                        direction="row"
                        gap={2}
                        key={artifact.id}
                        wrap
                      >
                        <Chip variant="tag">{artifact.kind}</Chip>
                        <CueLink
                          className="break-all"
                          href={artifact.externalUrl}
                          rel="noreferrer"
                          target="_blank"
                          variant="underline"
                        >
                          {artifact.externalUrl}
                        </CueLink>
                      </Stack>
                    ))}
                  </Stack>
                ) : (
                  <p className="text-fg-muted">No artifacts attached.</p>
                )}
                {request.permissions.canParticipate ? (
                  <Disclosure label="Attach an external artifact">
                    <ArtifactLinkForm
                      idempotencyKey={keys.artifact}
                      requestId={request.id}
                    />
                  </Disclosure>
                ) : null}
              </Stack>
            ) : null}
            {activeTab === "sessions" ? (
              request.workSessions.length ? (
                <Stack direction="column" gap={2}>
                  {request.workSessions.map((session) => (
                    <Stack direction="column" gap={1} key={session.id}>
                      <CueLink
                        render={
                          <Link href={`/agents/${session.agentPrincipalId}`} />
                        }
                        variant="underline"
                      >
                        {session.agentDisplayName}
                      </CueLink>
                      <span className="text-fg-subtle">
                        {session.latestProgress ?? "No progress report yet."}
                      </span>
                      <span className="text-fg-subtle">
                        {session.progressPercent === null
                          ? session.state
                          : `${session.state} · ${session.progressPercent}%`}{" "}
                        · {shortDate(session.updatedAt)}
                      </span>
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <p className="text-fg-muted">
                  No agent has claimed this request.
                </p>
              )
            ) : null}
            {activeTab === "provenance" ? (
              <Stack direction="column" gap={2}>
                <p className="text-(length:--cue-text-ui) text-fg-subtle">
                  Immutable source mapping retained through import.
                </p>
                {request.provenance.aliases.length ||
                request.provenance.mappings.length ? (
                  <Stack direction="column" gap={2}>
                    {request.provenance.aliases.map((entry) => (
                      <Stack direction="column" gap={1} key={entry.id}>
                        <span className="font-mono break-all">
                          {entry.namespace}:{entry.normalizedKey}
                        </span>
                        <span className="text-fg-subtle break-all">
                          {entry.relativePath} · {entry.sha256.slice(0, 12)}
                        </span>
                      </Stack>
                    ))}
                    {request.provenance.mappings.map((entry) => (
                      <Stack direction="column" gap={1} key={entry.id}>
                        <span className="font-mono break-all">
                          {entry.relativePath} · record {entry.recordIndex}
                        </span>
                        <span className="text-fg-subtle break-all">
                          Import {entry.importRunId} ·{" "}
                          {entry.sha256.slice(0, 12)}
                        </span>
                      </Stack>
                    ))}
                  </Stack>
                ) : (
                  <p className="text-fg-muted">
                    No imported provenance is attached to this request.
                  </p>
                )}
              </Stack>
            ) : null}
          </RecordSection>
        </article>
        <aside
          aria-label="Request properties"
          className="flex min-w-0 flex-col gap-(--cue-space-5) lg:shrink-0 lg:basis-1/3"
        >
          <Panel>
            <PanelHeader title="Next step" />
            <Row>
              <RequestTransitionForm
                idempotencyKey={keys.transition}
                request={request}
              />
            </Row>
            {request.permissions.canAssign ? (
              <Row>
                <AssignRequestForm
                  idempotencyKey={keys.assign}
                  members={members}
                  request={request}
                />
              </Row>
            ) : null}
          </Panel>
          <Inspector.Root>
            <Inspector.Section label="Properties">
              {/* Text, not elements: a row lays its label on an element
                  child as that element's `aria-label`, so only a text value
                  is announced as what it says. */}
              <Inspector.Row label="State">
                {stateLabel(request.state)}
              </Inspector.Row>
              <Inspector.Row label="Assignee">
                {personLabel(
                  request.assigneeDisplayName,
                  request.assigneeType,
                  request.assigneeId,
                )}
              </Inspector.Row>
              <Inspector.Row label="Priority">
                {humanize(request.priority)}
              </Inspector.Row>
              <Inspector.Row label="Type">
                {humanize(request.type)}
              </Inspector.Row>
              <Inspector.Row label="From">
                {request.sourceProjectName ?? "Human direct"}
              </Inspector.Row>
              <Inspector.Row label="To">
                {request.targetProjectName}
              </Inspector.Row>
              <Inspector.Row label="Lane">
                {request.laneName ?? "None"}
              </Inspector.Row>
              <Inspector.Row label="Labels">
                {request.labels.length ? request.labels.join(", ") : "None"}
              </Inspector.Row>
              <Inspector.Row label="Visibility">
                {humanize(request.visibility)}
              </Inspector.Row>
              <Inspector.Row label="Sensitivity">
                {humanize(request.sensitivity)}
              </Inspector.Row>
              <Inspector.Row label="Reporter">
                {personLabel(
                  request.reporterDisplayName,
                  request.reporterType,
                  request.reporterId,
                )}
              </Inspector.Row>
              <Inspector.Row label="Created">
                {shortDate(request.createdAt)}
              </Inspector.Row>
              <Inspector.Row label="Version">{`v${request.version}`}</Inspector.Row>
              <Inspector.Row label="ID">{request.id}</Inspector.Row>
            </Inspector.Section>
          </Inspector.Root>
          {deliveredQuestions.length > 0 ? (
            <Panel>
              <PanelHeader title="Deliveries" />
              {/* One row per question, named by what it asked, so a failed
                  delivery says which question it was for. Not a link to the
                  question's delivery record: that page is not found for
                  anyone but an owner or an admin, and other members read
                  this record too. */}
              {deliveredQuestions.map((question) => (
                <Row key={question.id}>
                  <Stack direction="column" gap={2}>
                    <span className="font-medium text-fg">
                      {questionExcerpt(question.bodyMd)}
                    </span>
                    {question.deliveries.map((delivery) => (
                      <Stack
                        align="center"
                        direction="row"
                        gap={2}
                        key={delivery.id}
                        wrap
                      >
                        <Chip variant="tag">{delivery.channel}</Chip>
                        <span>
                          {delivery.attempts
                            .map((attempt) => attempt.status)
                            .join(" → ") || "Not attempted"}
                        </span>
                        <span className="text-fg-subtle">
                          {delivery.status}
                        </span>
                      </Stack>
                    ))}
                  </Stack>
                </Row>
              ))}
            </Panel>
          ) : null}
        </aside>
      </div>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ *
 * Questions and activity.
 * ------------------------------------------------------------------ */

export function QuestionQueueView({
  answerKeys,
  page,
}: {
  answerKeys: Record<string, string>;
  page: CursorPage<
    RequestQuestionView & {
      requestId: string;
      displayKey: string | null;
      title: string;
    }
  >;
}) {
  return (
    <Page
      description="Questions addressed to you, your role, or projects you maintain."
      eyebrow="HITL"
      title="Questions"
      width="wide"
    >
      <PageSection>
        <Stack direction="column" gap={4}>
          {page.items.length > 0 ? (
            page.items.map((question) => (
              <RequestQuestionCard
                key={question.id}
                keys={{ answers: answerKeys, fallback: question.id }}
                question={question}
                title={
                  <CueLink
                    render={<Link href={`/requests/${question.requestId}`} />}
                    variant="underline"
                  >
                    <span className="font-mono">
                      {question.displayKey ?? "Draft"}
                    </span>{" "}
                    · {question.title}
                  </CueLink>
                }
              />
            ))
          ) : (
            <EmptyState
              hint="Human-in-the-loop questions addressed to you will appear here."
              icon={MessageCircleQuestion}
              title="No open questions"
            />
          )}
          {page.nextCursor ? (
            <Button
              render={
                <Link
                  href={`/questions?cursor=${encodeURIComponent(page.nextCursor)}`}
                />
              }
              size="sm"
              variant="ghost"
            >
              Load older questions
            </Button>
          ) : null}
        </Stack>
      </PageSection>
    </Page>
  );
}

export function ActivityView({
  page,
}: {
  page: CursorPage<TimelineEventView>;
}) {
  return (
    <Page
      description="Immutable request, question, work, and integration events across this organization."
      eyebrow="Audit"
      title="Activity"
      width="wide"
    >
      <PageSection>
        <Stack direction="column" gap={4}>
          {page.items.length > 0 ? (
            <Panel>
              <Row>
                <RequestTimeline page={page} />
              </Row>
            </Panel>
          ) : (
            <EmptyState
              hint="Domain events appear here as agents and humans work through requests."
              icon={Activity}
              title="No activity yet"
            />
          )}
          {page.nextCursor ? (
            <Button
              render={
                <Link
                  href={`/activity?cursor=${encodeURIComponent(page.nextCursor)}`}
                />
              }
              size="sm"
              variant="ghost"
            >
              Load older activity
            </Button>
          ) : null}
        </Stack>
      </PageSection>
    </Page>
  );
}
