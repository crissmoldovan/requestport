import { EmptyState, Panel, PanelHeader, Row } from "@cueplusplus/ui/chrome";
import { Checkbox, Input, Select } from "@cueplusplus/ui/forms";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import {
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
import { Activity, ListX, MessageCircleQuestion } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { MarkdownContent } from "./markdown-content.js";
import { Page, PageSection } from "./page-layout.js";
import {
  AnswerQuestionForm,
  ArtifactLinkForm,
  AskQuestionForm,
  CloseQuestionForm,
  MessageComposer,
  RelationshipForm,
  RequestEditForm,
  RequestTransitionForm,
  UnlinkRelationshipForm,
} from "./request-forms.js";
import { RequestWorkbenchShell } from "./request-workbench-shell.js";
import { sectionHeadingClasses } from "./section-heading.js";

/**
 * The request and collaboration surfaces, on native CUE++ composition.
 *
 * Three choices here are worth naming because a reader will otherwise assume
 * the obvious component was overlooked:
 *
 * - the request list is a compound `Table` inside a named, keyboard-focusable
 *   `TableScrollRegion`, which is the specification's §4.3 contract for tabular
 *   data and the reason the workbench's narrow list pane stays readable;
 * - the two tab-shaped strips — the list's views and the detail's sections —
 *   are **links**, not `Tabs`. Both change the URL and are answered by a fresh
 *   server render, and the installed manifest's own `Tabs` document says in as
 *   many words that it is *not for* navigation between pages. Composing links
 *   as buttons through the documented Base UI `render` prop is §6.2's contract
 *   for exactly this;
 * - `StatusDot` never appears. Its shipped vocabulary is `ok | busy | warn |
 *   danger | idle`, and a request state, a priority or a label is none of
 *   those, so §6.2 sends all three to `Chip`.
 */

/**
 * The type CUE++ gives a `PanelHeader`'s own title, spelled in its tokens.
 *
 * The title goes in the header's *leading cluster* rather than its `title`
 * slot, because that slot is a `<span>` — phrasing content — and a section of a
 * document needs a real `<h2>` a screen-reader user can jump between. The
 * cluster is a `<div>`, so the heading is valid there, and this borrows the
 * slot's typography so the two read identically.
 */

function shortDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
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
function stateTone(state: string): "danger" | "neutral" | "ok" | "warn" {
  if (["verified", "completed", "accepted", "answered"].includes(state)) {
    return "ok";
  }
  if (["blocked", "waiting_human", "waiting_requester"].includes(state)) {
    return "warn";
  }
  if (["declined", "cancelled", "duplicate", "superseded"].includes(state)) {
    return "danger";
  }
  return "neutral";
}

function priorityTone(
  priority: string,
): "danger" | "info" | "neutral" | "warn" {
  if (priority === "urgent") return "danger";
  if (priority === "high") return "warn";
  if (priority === "normal") return "info";
  return "neutral";
}

export function RequestStateBadge({ state }: { state: string }) {
  return <Chip tone={stateTone(state)}>{state.replaceAll("_", " ")}</Chip>;
}

function PriorityChip({ priority }: { priority: string }) {
  return (
    <Chip tone={priorityTone(priority)} variant="outline">
      {priority}
    </Chip>
  );
}

const requestViews = [
  { href: "/requests", label: "All", mode: "all" },
  { href: "/requests?view=inbox", label: "Inbox", mode: "inbox" },
  { href: "/requests?view=my_work", label: "My work", mode: "my_work" },
] as const;

const stateFilterOptions = [
  { label: "All states", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Submitted", value: "submitted" },
  { label: "Triage", value: "triage" },
  { label: "Accepted", value: "accepted" },
  { label: "Planned", value: "planned" },
  { label: "In progress", value: "in_progress" },
  { label: "Blocked", value: "blocked" },
  { label: "Waiting human", value: "waiting_human" },
  { label: "Completed", value: "completed" },
  { label: "Verified", value: "verified" },
];

const typeFilterOptions = [
  { label: "All types", value: "" },
  { label: "Feature", value: "feature" },
  { label: "Bug", value: "bug" },
  { label: "Question", value: "question" },
  { label: "Investigation", value: "investigation" },
  { label: "Chore", value: "chore" },
];

const priorityFilterOptions = [
  { label: "All priorities", value: "" },
  { label: "Urgent", value: "urgent" },
  { label: "High", value: "high" },
  { label: "Normal", value: "normal" },
  { label: "Low", value: "low" },
];

function requestHref(queryString: string, requestId: string) {
  return `/requests?${queryString ? `${queryString}&` : ""}requestId=${requestId}`;
}

function RequestTable({
  items,
  queryString,
  selectedId,
}: {
  items: RequestListItem[];
  queryString: string;
  selectedId: string | null;
}) {
  return (
    <TableScrollRegion aria-label="Requests">
      <Table.Root>
        <Table.Caption>Requests in this view</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Key</Table.Head>
            <Table.Head>Request</Table.Head>
            <Table.Head>Priority</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Updated</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {items.map((item) => (
            <Table.Row key={item.id}>
              <Table.Cell>
                <Stack align="center" direction="row" gap={2} wrap>
                  {item.unread ? <Chip tone="accent">Unread</Chip> : null}
                  <CueLink
                    aria-current={selectedId === item.id ? "true" : undefined}
                    render={<Link href={requestHref(queryString, item.id)} />}
                    variant="underline"
                  >
                    {item.displayKey ?? "DRAFT"}
                  </CueLink>
                </Stack>
              </Table.Cell>
              <Table.Cell>
                <Stack direction="column" gap={1}>
                  <span>{item.title}</span>
                  <span className="text-fg-subtle">
                    {item.sourceProjectName ?? "Human direct"} →{" "}
                    {item.targetProjectName}
                    {item.laneName ? ` / ${item.laneName}` : ""} · {item.type}
                    {item.openQuestionCount > 0
                      ? ` · ${item.openQuestionCount} open question${item.openQuestionCount === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </Stack>
              </Table.Cell>
              <Table.Cell>
                <PriorityChip priority={item.priority} />
              </Table.Cell>
              <Table.Cell>
                <RequestStateBadge state={item.state} />
              </Table.Cell>
              <Table.Cell>
                <time dateTime={item.updatedAt.toISOString()}>
                  {shortDate(item.updatedAt)}
                </time>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </TableScrollRegion>
  );
}

export function RequestListView({
  lanes,
  mode,
  page,
  projects,
  query,
  queryString,
  selected,
}: {
  lanes: Array<{ id: string; name: string; projectId: string }>;
  mode: "all" | "inbox" | "my_work";
  page: CursorPage<RequestListItem>;
  projects: Array<{ id: string; name: string }>;
  query: {
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
  queryString: string;
  selected: {
    request: RequestDetail;
    timeline: CursorPage<TimelineEventView>;
  } | null;
}) {
  const title =
    mode === "inbox" ? "Inbox" : mode === "my_work" ? "My work" : "Requests";
  const description =
    mode === "inbox"
      ? "Unread activity, assignments, and questions that need your attention."
      : mode === "my_work"
        ? "Requests you reported or that are assigned to you."
        : "Feature requests, bugs, investigations, and handoffs across projects.";
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
      description={description}
      eyebrow="Workflow"
      title={title}
      width="wide"
    >
      <PageSection>
        <Stack direction="column" gap={4}>
          <nav aria-label="Request views">
            <Stack direction="row" gap={2} wrap>
              {requestViews.map((view) => (
                <Button
                  aria-current={mode === view.mode ? "page" : undefined}
                  key={view.mode}
                  render={<Link href={view.href} />}
                  size="sm"
                  variant={mode === view.mode ? "secondary" : "ghost"}
                >
                  {view.label}
                </Button>
              ))}
            </Stack>
          </nav>
          {/* A toolbar of filters: §7 lets a control whose surrounding
              structure already names it carry `aria-label` instead of its own
              visible `Field`, which is what keeps this one row rather than
              eleven stacked labels. */}
          <form aria-label="Request filters">
            {mode !== "all" ? (
              <input name="view" type="hidden" value={mode} />
            ) : null}
            <Stack align="center" direction="row" gap={2} wrap>
              <Select
                aria-label="State"
                defaultValue={query.state ?? ""}
                items={stateFilterOptions}
                name="state"
                size="sm"
              />
              <Select
                aria-label="Type"
                defaultValue={query.type ?? ""}
                items={typeFilterOptions}
                name="type"
                size="sm"
              />
              <Select
                aria-label="Priority"
                defaultValue={query.priority ?? ""}
                items={priorityFilterOptions}
                name="priority"
                size="sm"
              />
              <Select
                aria-label="Source project"
                defaultValue={query.sourceProjectId ?? ""}
                items={[{ label: "Any source", value: "" }, ...projectItems]}
                name="sourceProjectId"
                size="sm"
              />
              <Select
                aria-label="Target project"
                defaultValue={query.targetProjectId ?? ""}
                items={[{ label: "Any target", value: "" }, ...projectItems]}
                name="targetProjectId"
                size="sm"
              />
              <Select
                aria-label="Lane"
                defaultValue={query.laneId ?? ""}
                items={[{ label: "Any lane", value: "" }, ...laneItems]}
                name="laneId"
                size="sm"
              />
              <Input
                aria-label="Label"
                defaultValue={query.label}
                name="label"
                placeholder="Label"
                size="sm"
              />
              <Input
                aria-label="Reporter ID"
                defaultValue={query.reporterId}
                name="reporterId"
                placeholder="Reporter ID"
                size="sm"
              />
              <Input
                aria-label="Assignee ID"
                defaultValue={query.assigneeId}
                name="assigneeId"
                placeholder="Assignee ID"
                size="sm"
              />
              <Input
                aria-label="Updated after"
                defaultValue={query.updatedAfter}
                name="updatedAfter"
                size="sm"
                type="date"
              />
              <Checkbox
                defaultChecked={query.unanswered}
                label="Open questions"
                name="unanswered"
                value="true"
              />
              <Button size="sm" type="submit" variant="secondary">
                Filter
              </Button>
            </Stack>
          </form>
          <RequestWorkbenchShell
            detail={
              selected ? (
                <RequestPreview
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
                  queryString={queryString}
                  selectedId={selected?.request.id ?? null}
                />
              ) : (
                <EmptyState
                  action={
                    <Button
                      render={<Link href="/requests/new" />}
                      size="sm"
                      variant="primary"
                    >
                      Create request
                    </Button>
                  }
                  hint="Open a request directly, or connect an agent to submit one on behalf of a project."
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

function RequestPreview({
  request,
  timeline,
}: {
  request: RequestDetail;
  timeline: CursorPage<TimelineEventView>;
}) {
  return (
    <Panel>
      <PanelHeader
        actions={<RequestStateBadge state={request.state} />}
        title={request.displayKey ?? "Draft"}
      />
      <Row>
        <Stack direction="column" gap={1}>
          <span>{request.title}</span>
          <span className="text-fg-subtle">
            {request.sourceProjectName ?? "Human direct"} →{" "}
            {request.targetProjectName}
            {request.laneName ? ` / ${request.laneName}` : ""}
          </span>
        </Stack>
      </Row>
      <Row>
        <Stack direction="column" gap={2}>
          <h2 className={sectionHeadingClasses}>Description</h2>
          <MarkdownContent>{request.descriptionMd}</MarkdownContent>
        </Stack>
      </Row>
      <Row>
        <Stack direction="column" gap={2}>
          <h2 className={sectionHeadingClasses}>Current work</h2>
          {request.workSessions.length ? (
            <Stack direction="column" gap={1}>
              {request.workSessions.slice(0, 3).map((session) => (
                <Stack
                  align="center"
                  direction="row"
                  gap={2}
                  key={session.id}
                  wrap
                >
                  <Chip tone="neutral">{session.state}</Chip>
                  <span>{session.agentDisplayName}</span>
                  <span className="text-fg-subtle">
                    {session.latestProgress ?? "No progress update yet."}
                  </span>
                </Stack>
              ))}
            </Stack>
          ) : (
            <p>No active agent session.</p>
          )}
        </Stack>
      </Row>
      <Row>
        <Stack direction="column" gap={2}>
          <h2 className={sectionHeadingClasses}>Open questions</h2>
          {request.questions.some((question) => question.state === "open") ? (
            <Stack direction="column" gap={1}>
              {request.questions
                .filter((question) => question.state === "open")
                .slice(0, 4)
                .map((question) => (
                  <Stack direction="row" gap={2} key={question.id} wrap>
                    <Chip tone={question.blocksRequest ? "warn" : "neutral"}>
                      {question.blocksRequest ? "Blocking" : "Question"}
                    </Chip>
                    <span>{question.bodyMd.slice(0, 120)}</span>
                  </Stack>
                ))}
            </Stack>
          ) : (
            <p>No open questions.</p>
          )}
        </Stack>
      </Row>
      <Row>
        <Stack direction="column" gap={2}>
          <h2 className={sectionHeadingClasses}>Recent activity</h2>
          <RequestTimeline
            page={{ items: timeline.items.slice(0, 8), nextCursor: null }}
          />
        </Stack>
      </Row>
      <Row>
        <Stack align="center" direction="row" gap={2} wrap>
          <Button
            render={<Link href={`/requests/${request.id}`} />}
            size="sm"
            variant="primary"
          >
            Open full request
          </Button>
          <span className="text-fg-subtle">
            v{request.version} · {request.priority}
          </span>
        </Stack>
      </Row>
    </Panel>
  );
}

function Metadata({ request }: { request: RequestDetail }) {
  const entries: Array<[string, string]> = [
    ["Target", request.targetProjectName],
    ["Source", request.sourceProjectName ?? "Human direct"],
    ["Type", request.type],
    ["Priority", request.priority],
    ["Visibility", request.visibility],
    ["Sensitivity", request.sensitivity],
    ["Reporter", `${request.reporterType}:${request.reporterId.slice(0, 12)}`],
    [
      "Assignee",
      request.assigneeId
        ? `${request.assigneeType}:${request.assigneeId.slice(0, 12)}`
        : "Unassigned",
    ],
    ["Created", shortDate(request.createdAt)],
    ["Version", `v${request.version}`],
  ];

  return (
    <DescriptionList.Root>
      {entries.map(([term, value]) => (
        <div key={term}>
          <DescriptionList.Term>{term}</DescriptionList.Term>
          <DescriptionList.Detail>{value}</DescriptionList.Detail>
        </div>
      ))}
    </DescriptionList.Root>
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
                {String(event.actor.type ?? "actor")} · v
                {event.aggregateVersion} ·{" "}
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

const detailTabs = [
  "activity",
  "relations",
  "artifacts",
  "sessions",
  "provenance",
] as const;

function SectionPanel({
  action,
  children,
  headingId,
  note,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  headingId: string;
  note?: string;
  title: string;
}) {
  return (
    <Panel>
      <PanelHeader actions={action}>
        <h2 className={sectionHeadingClasses} id={headingId}>
          {title}
        </h2>
        {note ? <span className="text-fg-subtle">{note}</span> : null}
      </PanelHeader>
      <Row>
        <Stack direction="column" gap={3}>
          {children}
        </Stack>
      </Row>
    </Panel>
  );
}

export function RequestDetailView({
  activeTab,
  keys,
  members,
  request,
  timeline,
}: {
  activeTab: "activity" | "relations" | "artifacts" | "sessions" | "provenance";
  keys: {
    artifact: string;
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
  ).length;

  return (
    <Page
      action={
        <Stack align="center" direction="row" gap={2} wrap>
          <RequestStateBadge state={request.state} />
          <PriorityChip priority={request.priority} />
          {request.visibility === "restricted" ? (
            <Chip tone="warn">Restricted</Chip>
          ) : null}
          {request.sensitivity === "sensitive" ? (
            <Chip tone="warn">Sensitive</Chip>
          ) : null}
        </Stack>
      }
      description={`${request.targetProjectName} · ${request.type} · updated ${shortDate(request.updatedAt)}`}
      eyebrow={request.displayKey ?? "Draft request"}
      title={request.title}
      width="wide"
    >
      <PageSection>
        <Stack direction="column" gap={4}>
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
          <SectionPanel
            headingId="request-description-heading"
            title="Description"
          >
            <MarkdownContent>{request.descriptionMd}</MarkdownContent>
            {request.labels.length > 0 ? (
              <Stack direction="row" gap={2} wrap>
                {request.labels.map((label) => (
                  <Chip key={label} tone="neutral">
                    {label}
                  </Chip>
                ))}
              </Stack>
            ) : null}
            {request.permissions.canEdit ? (
              <Disclosure label="Edit request content">
                <RequestEditForm idempotencyKey={keys.edit} request={request} />
              </Disclosure>
            ) : null}
          </SectionPanel>
          <SectionPanel
            headingId="criteria-heading"
            note={`${request.acceptanceCriteria.length} defined`}
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
              <p>No acceptance criteria yet.</p>
            )}
          </SectionPanel>
          <nav aria-label="Request detail sections">
            <Stack direction="row" gap={2} wrap>
              {detailTabs.map((tab) => (
                <Button
                  aria-current={activeTab === tab ? "page" : undefined}
                  key={tab}
                  render={<Link href={`/requests/${request.id}?tab=${tab}`} />}
                  size="sm"
                  variant={activeTab === tab ? "secondary" : "ghost"}
                >
                  {tab[0]?.toUpperCase()}
                  {tab.slice(1)}
                </Button>
              ))}
            </Stack>
          </nav>
          {activeTab === "activity" ? (
            <>
              <SectionPanel
                headingId="conversation-heading"
                note={`${request.messages.length} comments`}
                title="Conversation"
              >
                {request.messages.map((message) => (
                  <Stack direction="column" gap={1} key={message.id}>
                    <Stack align="center" direction="row" gap={2} wrap>
                      <span className="font-mono">
                        {message.actorType}:{message.actorId.slice(0, 12)}
                      </span>
                      <time dateTime={message.createdAt.toISOString()}>
                        {shortDate(message.createdAt)}
                      </time>
                    </Stack>
                    <MarkdownContent>{message.bodyMd}</MarkdownContent>
                  </Stack>
                ))}
                {request.messages.length === 0 ? <p>No comments yet.</p> : null}
                {request.permissions.canParticipate ? (
                  <MessageComposer
                    idempotencyKey={keys.message}
                    requestId={request.id}
                  />
                ) : null}
              </SectionPanel>
              <SectionPanel
                headingId="questions-heading"
                note={`${openQuestions} open`}
                title="Questions"
              >
                {request.questions.map((question) => (
                  <Panel key={question.id}>
                    <PanelHeader
                      actions={<RequestStateBadge state={question.state} />}
                      title={
                        question.blocksRequest ? "Blocking" : "Non-blocking"
                      }
                    >
                      <span className="text-fg-subtle">
                        {question.audienceType.replaceAll("_", " ")}
                      </span>
                    </PanelHeader>
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
                              <Chip key={choice} tone="neutral">
                                {choice}
                              </Chip>
                            ))}
                          </Stack>
                        ) : null}
                        <p className="text-fg-subtle">
                          {question.deadlineAt
                            ? `Due ${shortDate(question.deadlineAt)} · `
                            : ""}
                          {question.allowFreeText
                            ? "Free-text answers allowed"
                            : "Structured choices only"}
                        </p>
                        {question.answers.map((answer) => (
                          <Stack direction="column" gap={1} key={answer.id}>
                            <span className="font-mono">
                              {answer.actorType}:{answer.actorId.slice(0, 12)}
                            </span>
                            <MarkdownContent>{answer.bodyMd}</MarkdownContent>
                          </Stack>
                        ))}
                        {question.deliveries.length ? (
                          <Disclosure
                            label={`${question.deliveries.length} delivery intent${question.deliveries.length === 1 ? "" : "s"}`}
                          >
                            {question.deliveries.map((delivery) => (
                              <Stack
                                align="center"
                                direction="row"
                                gap={2}
                                key={delivery.id}
                                wrap
                              >
                                <Chip tone="neutral">{delivery.channel}</Chip>
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
                          </Disclosure>
                        ) : null}
                        {question.state === "open" && question.canAnswer ? (
                          <AnswerQuestionForm
                            idempotencyKey={
                              keys.answers[question.id] ?? keys.question
                            }
                            question={question}
                          />
                        ) : null}
                        {question.state === "open" &&
                        question.answerMode === "multiple" &&
                        question.canClose ? (
                          <CloseQuestionForm
                            idempotencyKey={
                              keys.closes[question.id] ?? keys.question
                            }
                            question={question}
                            requestId={request.id}
                          />
                        ) : null}
                      </Stack>
                    </Row>
                  </Panel>
                ))}
                {request.permissions.canParticipate ? (
                  <Disclosure label="Ask a question">
                    <AskQuestionForm
                      idempotencyKey={keys.question}
                      members={members}
                      request={request}
                    />
                  </Disclosure>
                ) : null}
              </SectionPanel>
              <SectionPanel
                headingId="activity-heading"
                note="Immutable semantic timeline"
                title="Activity"
              >
                <RequestTimeline page={timeline} />
                {timeline.nextCursor ? (
                  <Button
                    render={
                      <Link
                        href={`/requests/${request.id}?tab=activity&timelineCursor=${encodeURIComponent(timeline.nextCursor)}`}
                      />
                    }
                    size="sm"
                    variant="ghost"
                  >
                    Older events
                  </Button>
                ) : null}
              </SectionPanel>
              {request.completionReport ? (
                <SectionPanel
                  headingId="report-heading"
                  note={`Submitted ${shortDate(request.completionReport.createdAt)}`}
                  title="Completion report"
                >
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
                </SectionPanel>
              ) : null}
            </>
          ) : null}
          {activeTab === "artifacts" ? (
            <SectionPanel
              headingId="artifacts-heading"
              note="Metadata and external links only"
              title="Artifacts"
            >
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
                      <Chip tone="neutral">{artifact.kind}</Chip>
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
                <p>No artifacts attached.</p>
              )}
              {request.permissions.canParticipate ? (
                <Disclosure label="Attach an external artifact">
                  <ArtifactLinkForm
                    idempotencyKey={keys.artifact}
                    requestId={request.id}
                  />
                </Disclosure>
              ) : null}
            </SectionPanel>
          ) : null}
          {activeTab === "relations" ? (
            <SectionPanel
              headingId="relationships-heading"
              note={`${request.relationships.length} linked requests`}
              title="Relations"
            >
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
                          <Link href={`/requests/${relationship.requestId}`} />
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
                <p>No related requests.</p>
              )}
              {request.permissions.canParticipate ? (
                <Disclosure label="Link another request">
                  <RelationshipForm
                    idempotencyKey={keys.relationship}
                    requestId={request.id}
                  />
                </Disclosure>
              ) : null}
            </SectionPanel>
          ) : null}
          {activeTab === "sessions" ? (
            <SectionPanel
              headingId="sessions-detail-heading"
              note={`${request.workSessions.length} work sessions`}
              title="Agent sessions"
            >
              {request.workSessions.length ? (
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
                <p>No agent has claimed this request.</p>
              )}
            </SectionPanel>
          ) : null}
          {activeTab === "provenance" ? (
            <SectionPanel
              headingId="provenance-heading"
              note="Immutable source mapping retained through import."
              title="Legacy provenance"
            >
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
                        Import {entry.importRunId} · {entry.sha256.slice(0, 12)}
                      </span>
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <p>No imported provenance is attached to this request.</p>
              )}
            </SectionPanel>
          ) : null}
          <SectionPanel headingId="request-state-heading" title="State">
            <RequestTransitionForm
              idempotencyKey={keys.transition}
              request={request}
            />
          </SectionPanel>
          <SectionPanel
            headingId="request-properties-heading"
            title="Properties"
          >
            <Metadata request={request} />
          </SectionPanel>
        </Stack>
      </PageSection>
    </Page>
  );
}

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
              <Panel key={question.id}>
                <PanelHeader
                  actions={
                    <Chip tone={question.blocksRequest ? "warn" : "neutral"}>
                      {question.blocksRequest ? "Blocking" : "Non-blocking"}
                    </Chip>
                  }
                  title={
                    <CueLink
                      render={<Link href={`/requests/${question.requestId}`} />}
                      variant="underline"
                    >
                      <span className="font-mono">
                        {question.displayKey ?? "DRAFT"}
                      </span>{" "}
                      · {question.title}
                    </CueLink>
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
                          <Chip key={choice} tone="neutral">
                            {choice}
                          </Chip>
                        ))}
                      </Stack>
                    ) : null}
                    {question.deadlineAt ? (
                      <p className="text-fg-subtle">
                        Due {shortDate(question.deadlineAt)}
                      </p>
                    ) : null}
                    <AnswerQuestionForm
                      idempotencyKey={answerKeys[question.id] ?? question.id}
                      question={question}
                    />
                  </Stack>
                </Row>
              </Panel>
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
