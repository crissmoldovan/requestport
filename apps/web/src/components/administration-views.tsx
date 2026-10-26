import {
  EmptyState,
  Panel,
  PanelHeader,
  Row,
  StatBand,
} from "@cueplusplus/ui/chrome";
import {
  Progress,
  Table,
  TableScrollRegion,
} from "@cueplusplus/ui/instruments";
import {
  Card,
  Link as CueLink,
  DescriptionList,
  Grid,
  Item,
  Stack,
  Timeline,
} from "@cueplusplus/ui/layout";
import { Avatar, Button, Chip, StatusDot } from "@cueplusplus/ui/primitives";
import type {
  OrganizationAccess,
  OrganizationMember,
  OrganizationProject,
  PendingInvitation,
} from "@requestport/domain";
import { Activity, CheckCheck, FolderPlus, MailX } from "lucide-react";
import Link from "next/link";

import type { MemberActionState } from "../app/(app)/settings/members/action-state.js";
import type { FormAction } from "./administration-forms.js";
import {
  CreateProjectDialog,
  InviteMemberDialog,
  OrganizationForm,
  ProjectForm,
} from "./administration-forms.js";
import {
  MemberActionsMenu,
  MemberRoleControl,
  ResendInvitationForm,
  RevokeInvitationForm,
} from "./member-management.js";
import { Page } from "./page-layout.js";
import { sectionHeadingClasses } from "./section-heading.js";
import { SettingsSection } from "./settings-section.js";

/**
 * The organization administration surfaces, on native CUE++ composition.
 *
 * Two choices are worth naming. Tables live inside the named, keyboard-focusable
 * `TableScrollRegion` — §4.3's contract for tabular data — so an unbroken email
 * address or repository slug scrolls its own columns rather than the console.
 * And `StatusDot` draws only the overview's health line (ruling 261), whose
 * three states are `ok`, `warn` and `danger` from its shipped vocabulary
 * (`ok | busy | warn | danger | idle`): an organization role or a project
 * lifecycle is none of those, so §6.2 sends every one of them to `Chip`.
 *
 * The settings views follow the reference build's page (ruling 259): a header
 * with its title, one line of what the page is for and at most one primary
 * action, then panels of rows. A form that used to sit under its list opens
 * from that action in a dialog, and its confirmation goes to the console's
 * one toast provider, which the shell mounts (`ConsoleToasts`, ruling 260).
 */

const roleLabels = { admin: "Admin", member: "Member", owner: "Owner" };

function roleLabel(role: string) {
  return roleLabels[role as keyof typeof roleLabels] ?? role;
}

/** The first letter of a name, for an avatar that has no picture. */
function initialOf(name: string) {
  return (name.trim()[0] ?? "?").toLocaleUpperCase();
}

type MemberAction = (
  state: MemberActionState,
  formData: FormData,
) => Promise<MemberActionState>;

function ProjectTable({ projects }: { projects: OrganizationProject[] }) {
  return (
    <TableScrollRegion aria-label="Registered projects">
      <Table.Root>
        <Table.Caption>Registered projects</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Key</Table.Head>
            <Table.Head>Project</Table.Head>
            <Table.Head>Repository</Table.Head>
            <Table.Head>Status</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {projects.map((project) => (
            <Table.Row key={project.id}>
              <Table.Cell>
                <span className="font-mono">{project.keyPrefix}</span>
              </Table.Cell>
              <Table.Cell>
                <Stack direction="column" gap={1}>
                  <CueLink
                    render={<Link href={`/settings/projects/${project.id}`} />}
                    variant="underline"
                  >
                    {project.name}
                  </CueLink>
                  <span className="text-fg-subtle">{project.slug}</span>
                </Stack>
              </Table.Cell>
              <Table.Cell>
                {project.defaultRepository ? (
                  <CueLink
                    external
                    href={project.defaultRepository.browseUrl}
                    variant="underline"
                  >
                    {project.defaultRepository.repositorySlug}
                  </CueLink>
                ) : (
                  <span className="text-fg-subtle">Not connected</span>
                )}
              </Table.Cell>
              <Table.Cell>
                <Chip tone={project.status === "active" ? "ok" : "neutral"}>
                  {project.status === "active" ? "Active" : "Archived"}
                </Chip>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </TableScrollRegion>
  );
}

export function NoOrganizationSetup() {
  return (
    <Page
      description="Organizations are the tenant and authorization boundary for projects, requests, members, and agents."
      eyebrow="Workspace setup"
      title="Create your first organization"
      width="form"
    >
      <SettingsSection
        headingId="setup-organization"
        title="Organization identity"
      >
        <OrganizationForm />
      </SettingsSection>
    </Page>
  );
}

/** What the overview's summary read answers (`createOverviewQueryRepository`). */
export type OverviewFigures = {
  setup: {
    project: boolean;
    agent: boolean;
    team: boolean;
    routing: boolean;
  };
  /** Agent principals whose status is active: registered. */
  activeAgents: number;
  /** Of those, the ones whose key or grant was last used in the last 24 hours. */
  connectedAgents: number;
  openRequests: number;
  questionsForYou: number;
  oldestQuestionAt: Date | null;
  /** Null when the reader may not see webhooks: the figure is then left out. */
  failedDeliveries: number | null;
};

/**
 * What the overview's health read answers (`createOverviewQueryRepository`'s
 * `health`), every figure the reader's organization's own; null for a reader
 * who is not an owner or an admin, who is not shown the line.
 */
export type OverviewHealthFigures = {
  /** When the database ran the read, by its own clock. */
  checkedAt: Date;
  /** The organization's outbox rows pending, leased or accepted. */
  unprocessedEvents: number;
  oldestUnprocessedAt: Date | null;
  /** The organization's outbox rows dead-lettered in the last 24 hours. */
  deadLetters: number;
  lastDispatchAt: Date | null;
};

/**
 * Whether this person hid the setup card in this organization (the HttpOnly
 * cookie the page read, `setup-card-cookie.ts`), and the two server actions
 * that hide and show it.
 */
export type SetupCardControls = {
  hidden: boolean;
  hide: () => Promise<void>;
  show: () => Promise<void>;
};

export type OverviewAttention = {
  questions: ReadonlyArray<{
    id: string;
    bodyMd: string;
    createdAt: Date;
    displayKey: string | null;
    /** The request the question is asked on, whose page answers it. */
    requestId: string;
  }>;
  triage: ReadonlyArray<{
    id: string;
    displayKey: string | null;
    title: string;
    targetProjectName: string;
    updatedAt: Date;
  }>;
  failedDeliveries: ReadonlyArray<{
    id: string;
    subscriptionId: string;
    subscriptionName: string;
    eventType: string;
    failedAt: Date;
  }>;
};

export type OverviewActivityEvent = {
  id: string;
  type: string;
  occurredAt: Date;
  actor: Record<string, unknown>;
};

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "12 minutes ago", "2 hours ago", "yesterday": the age of a moment. */
function ago(moment: Date, now: Date) {
  const minutes = Math.round((now.getTime() - moment.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 45) return relativeTime.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 22) return relativeTime.format(-hours, "hour");
  return relativeTime.format(-Math.max(1, Math.round(hours / 24)), "day");
}

/** `request.completed.v2` reads as "request completed". */
function eventLabel(type: string) {
  return type
    .replace(/\.v\d+$/u, "")
    .split(".")
    .join(" ")
    .replace(/_/gu, " ");
}

/** The marker an event wears: finished well, stuck, waiting, or neither. */
function eventTone(type: string): "danger" | "idle" | "ok" | "warn" {
  if (/(?:blocked|declined|cancelled|failed|revoked)/u.test(type)) {
    return "danger";
  }
  if (/(?:completed|verified|accepted|answered)/u.test(type)) return "ok";
  if (/(?:question|waiting)/u.test(type)) return "warn";
  return "idle";
}

/** The first line of a question, which is what a row has room for. */
function firstLine(markdown: string) {
  return markdown.split("\n", 1)[0]?.trim() ?? "";
}

type SetupStep = {
  title: string;
  done: boolean;
  todo: string;
  finished: string;
  action: string;
  href: string;
};

function setupSteps(setup: OverviewFigures["setup"]): SetupStep[] {
  return [
    {
      title: "Create a project",
      done: setup.project,
      todo: "Requests are filed for a project, so register one first.",
      finished: "A project is registered.",
      action: "Create project",
      href: setup.project ? "/settings/projects" : "/settings/projects/new",
    },
    {
      title: "Connect an agent",
      done: setup.agent,
      todo: "A coding agent files, answers and works on requests over MCP or the REST API.",
      finished: "An agent is registered.",
      action: "Connect an agent",
      href: "/agents",
    },
    {
      title: "Invite your team",
      done: setup.team,
      todo: "People answer agents’ questions and triage what comes in.",
      finished: "Someone besides you has access, or has been invited.",
      action: "Invite people",
      href: "/settings/members",
    },
    {
      title: "Decide who can ask whom",
      done: setup.routing,
      todo: "Optional. Until a rule says otherwise, every project may file requests with every other.",
      finished: "A routing rule is in force.",
      action: "Review routing",
      href: "/settings/routing",
    },
  ];
}

function SetupCard({
  hide,
  steps,
}: {
  hide: SetupCardControls["hide"];
  steps: SetupStep[];
}) {
  const done = steps.filter((step) => step.done).length;
  const left = steps.length - done;
  const firstOpen = steps.findIndex((step) => !step.done);
  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>Finish setting up RequestPort</Card.Title>
        <Card.Description>
          {left === 1 ? "One step left." : `${left} steps left.`}
          {steps[2]?.done
            ? null
            : " Your team cannot answer agents’ questions until they are invited."}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Stack direction="column" gap={4}>
          <Progress
            label={`${done} of ${steps.length} done`}
            max={steps.length}
            showValue={false}
            value={done}
          />
          <Grid gap={3} minItemWidth="22rem">
            {steps.map((step, index) => (
              <Item
                actions={
                  <Button
                    render={<Link href={step.href} />}
                    size="sm"
                    variant={index === firstOpen ? "primary" : "ghost"}
                  >
                    {step.done ? "Review" : step.action}
                  </Button>
                }
                description={step.done ? step.finished : step.todo}
                key={step.title}
                media={
                  step.done ? (
                    <Chip tone="ok" variant="tag">
                      Done
                    </Chip>
                  ) : (
                    <Chip variant="tag">{index + 1}</Chip>
                  )
                }
                title={step.title}
                variant="outline"
              />
            ))}
          </Grid>
        </Stack>
      </Card.Content>
      <Card.Footer>
        {/* Hidden for this person in this organization only (ruling 261). */}
        <form action={hide}>
          <Button size="sm" type="submit" variant="ghost">
            Hide
          </Button>
        </form>
      </Card.Footer>
    </Card.Root>
  );
}

/**
 * In the hidden card's place while a step is still open: how far setup has
 * come, and the way to bring the card back.
 */
function SetupHidden({
  show,
  steps,
}: {
  show: SetupCardControls["show"];
  steps: SetupStep[];
}) {
  const done = steps.filter((step) => step.done).length;
  return (
    <form action={show}>
      <Stack
        align="center"
        className="text-fg-muted"
        direction="row"
        gap={2}
        wrap
      >
        <span>{`Setup: ${done} of ${steps.length} steps done.`}</span>
        <Button size="sm" type="submit" variant="ghost">
          Show setup steps
        </Button>
      </Stack>
    </form>
  );
}

/**
 * The health line's thresholds, in minutes the oldest unprocessed event has
 * waited by the read's own clock (ruling 261). The outbox sweep runs every
 * two minutes, and an event a run accepted but has not settled is claimed
 * again after ten (`trigger/src/outbox-repair.ts`; migration 0020's
 * `claim_outbox_batch`), so an event older than ten minutes has outlived a
 * reclaim, and one older than an hour, six.
 */
const healthWarnAfterMinutes = 10;
const healthDangerAfterMinutes = 60;

/**
 * The verdicts name what the read measures: this organization's own events,
 * not the worker. An organization with nothing waiting reads "on time"
 * whatever the worker is doing for other organizations, whose rows it is not
 * told about.
 */
const healthVerdicts = {
  danger: "This organization’s events are an hour or more behind",
  ok: "This organization’s events are on time",
  warn: "This organization’s events need attention",
} as const;

/**
 * Danger once the oldest unprocessed event has waited an hour; warn once it
 * has waited ten minutes, or an event ran out of retries in the last day; ok
 * otherwise.
 */
function healthTone(
  health: OverviewHealthFigures,
): keyof typeof healthVerdicts {
  const waited = health.oldestUnprocessedAt
    ? (health.checkedAt.getTime() - health.oldestUnprocessedAt.getTime()) /
      60_000
    : 0;
  if (waited >= healthDangerAfterMinutes) return "danger";
  if (waited >= healthWarnAfterMinutes || health.deadLetters > 0) return "warn";
  return "ok";
}

const checkedAtFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

/**
 * The reference build's health line, from the overview's health read: how
 * this organization's own events stand with the worker, then that the
 * database answered and when. Ages are measured against the read's clock,
 * not the web server's.
 */
function HealthLine({ health }: { health: OverviewHealthFigures }) {
  const tone = healthTone(health);
  const oldest = health.oldestUnprocessedAt
    ? `, the oldest written ${ago(health.oldestUnprocessedAt, health.checkedAt)}`
    : "";
  const events = health.unprocessedEvents
    ? `${health.unprocessedEvents} not yet processed${oldest}`
    : "none waiting";
  const deadLetters = health.deadLetters
    ? `${health.deadLetters} dead ${health.deadLetters === 1 ? "letter" : "letters"} in 24 hours`
    : "no dead letters in 24 hours";
  const dispatched = health.lastDispatchAt
    ? `last dispatched ${ago(health.lastDispatchAt, health.checkedAt)}`
    : "nothing dispatched yet";
  return (
    <Stack
      align="center"
      className="text-fg-muted"
      direction="row"
      gap={2}
      wrap
    >
      <StatusDot label={healthVerdicts[tone]} tone={tone} />
      <span aria-hidden="true">{healthVerdicts[tone]}</span>
      <span>{`· ${events}; ${deadLetters}; ${dispatched}`}</span>
      <span>
        · Database answered at{" "}
        <time dateTime={health.checkedAt.toISOString()}>
          {checkedAtFormat.format(health.checkedAt)} UTC
        </time>
      </span>
      <span>
        ·{" "}
        <CueLink
          render={<Link href="/settings/operations" />}
          variant="underline"
        >
          Operations
        </CueLink>
      </span>
    </Stack>
  );
}

type AttentionRow = {
  key: string;
  kind: "Question" | "Triage" | "Delivery";
  tone: "danger" | "info" | "warn";
  href: string;
  reference: string | null;
  text: string;
  at: Date;
};

function attentionRows(attention: OverviewAttention): AttentionRow[] {
  return [
    ...attention.questions.map(
      (question): AttentionRow => ({
        key: `question:${question.id}`,
        kind: "Question",
        tone: "warn",
        href: `/requests/${question.requestId}`,
        reference: question.displayKey,
        text: firstLine(question.bodyMd),
        at: question.createdAt,
      }),
    ),
    ...attention.triage.map(
      (request): AttentionRow => ({
        key: `triage:${request.id}`,
        kind: "Triage",
        tone: "info",
        href: `/requests/${request.id}`,
        reference: request.displayKey,
        text: `${request.title} · for ${request.targetProjectName}`,
        at: request.updatedAt,
      }),
    ),
    ...attention.failedDeliveries.map(
      (delivery): AttentionRow => ({
        key: `delivery:${delivery.id}`,
        kind: "Delivery",
        tone: "danger",
        href: `/webhooks/${delivery.subscriptionId}`,
        reference: null,
        text: `${delivery.subscriptionName}: ${eventLabel(delivery.eventType)} ran out of retries`,
        at: delivery.failedAt,
      }),
    ),
  ].sort((left, right) => right.at.getTime() - left.at.getTime());
}

function NeedsYou({
  attention,
  now,
}: {
  attention: OverviewAttention;
  now: Date;
}) {
  const rows = attentionRows(attention);
  return (
    <Panel>
      <PanelHeader
        actions={
          <Button
            render={<Link href="/requests?view=inbox" />}
            size="sm"
            variant="ghost"
          >
            Open inbox
          </Button>
        }
      >
        <h2 className={sectionHeadingClasses} id="overview-needs-you">
          Needs you
        </h2>
      </PanelHeader>
      {rows.length ? (
        rows.map((row) => (
          <Row key={row.key}>
            <Chip tone={row.tone}>{row.kind}</Chip>
            <span className="min-w-0 flex-1 truncate">
              <CueLink render={<Link href={row.href} />} variant="underline">
                {row.reference ? (
                  <span className="font-mono text-fg-subtle">
                    {row.reference}{" "}
                  </span>
                ) : null}
                {row.text}
              </CueLink>
            </span>
            <time className="text-fg-subtle" dateTime={row.at.toISOString()}>
              {ago(row.at, now)}
            </time>
          </Row>
        ))
      ) : (
        <EmptyState
          hint="Questions addressed to you, requests you can triage and failed webhook deliveries appear here."
          icon={CheckCheck}
          title="Nothing needs you"
        />
      )}
    </Panel>
  );
}

function RecentActivity({
  events,
  now,
}: {
  events: readonly OverviewActivityEvent[];
  now: Date;
}) {
  return (
    <Panel>
      <PanelHeader
        actions={
          <Button render={<Link href="/activity" />} size="sm" variant="ghost">
            All activity
          </Button>
        }
      >
        <h2 className={sectionHeadingClasses} id="overview-recent-activity">
          Recent activity
        </h2>
      </PanelHeader>
      {events.length ? (
        <Row>
          <Timeline.Root>
            {events.map((event) => (
              <Timeline.Item key={event.id}>
                <Timeline.Marker
                  label={eventLabel(event.type)}
                  tone={eventTone(event.type)}
                />
                <Timeline.Content>
                  {eventLabel(event.type)} ·{" "}
                  {String(event.actor.type ?? "actor")} ·{" "}
                  <time dateTime={event.occurredAt.toISOString()}>
                    {ago(event.occurredAt, now)}
                  </time>
                </Timeline.Content>
              </Timeline.Item>
            ))}
          </Timeline.Root>
        </Row>
      ) : (
        <EmptyState
          hint="Requests, questions and work appear here as agents and people act on them."
          icon={Activity}
          title="No activity yet"
        />
      )}
    </Panel>
  );
}

/**
 * The organization at a glance (ruling 258, the reference build's
 * `screens/Overview.tsx`): a setup checklist while a step is open, a band of
 * figures, what needs the reader and recent activity; since ruling 261 also
 * the card's Hide and the worker and database health line.
 *
 * Every number and row arrives as a prop from a query; nothing here counts or
 * invents one. The checklist is drawn for an owner or an admin only, because
 * every one of its steps is theirs to take, and not while that person has
 * hidden it in this organization; then one line says how far setup has come
 * and brings it back. The agents figure counts the agents that authenticated
 * in the last 24 hours, by API key or by OAuth, and its note how many are
 * registered. The health line is an owner's and an admin's too.
 */
export function OverviewView({
  activity,
  attention,
  figures,
  health,
  now,
  organization,
  setupCard,
}: {
  activity: readonly OverviewActivityEvent[];
  attention: OverviewAttention;
  figures: OverviewFigures;
  health: OverviewHealthFigures | null;
  now: Date;
  organization: OrganizationAccess;
  setupCard: SetupCardControls;
}) {
  const steps = setupSteps(figures.setup);
  const administrator =
    organization.role === "owner" || organization.role === "admin";
  const setupOpen = administrator && steps.some((step) => !step.done);
  const stats = [
    {
      label: "Open requests",
      value: String(figures.openRequests),
      note: "Submitted and not yet finished",
    },
    {
      label: "Waiting on your answer",
      value: String(figures.questionsForYou),
      note: figures.oldestQuestionAt
        ? `Oldest asked ${ago(figures.oldestQuestionAt, now)}`
        : "No open questions for you",
    },
    {
      label: "Agents connected, 24 h",
      value: String(figures.connectedAgents),
      note: `Of ${figures.activeAgents} registered`,
    },
    ...(figures.failedDeliveries === null
      ? []
      : [
          {
            label: "Failed deliveries, 24 h",
            value: String(figures.failedDeliveries),
            note: "Webhooks out of retries",
          },
        ]),
  ];
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
      description={organization.name}
      eyebrow={organization.slug}
      title="Overview"
      width="wide"
    >
      {setupOpen && !setupCard.hidden ? (
        <SetupCard hide={setupCard.hide} steps={steps} />
      ) : null}
      {setupOpen && setupCard.hidden ? (
        <SetupHidden show={setupCard.show} steps={steps} />
      ) : null}
      <StatBand stats={stats} />
      <Grid gap={6} minItemWidth="22rem">
        <NeedsYou attention={attention} now={now} />
        <RecentActivity events={activity} now={now} />
      </Grid>
      {administrator && health ? <HealthLine health={health} /> : null}
    </Page>
  );
}

export function OrganizationView({
  organization,
}: {
  organization: OrganizationAccess;
}) {
  return (
    <Page
      description="Canonical tenant identity and your effective membership."
      eyebrow="Settings"
      title="Organization"
    >
      <SettingsSection headingId="organization-identity" title="Identity">
        <DescriptionList.Root>
          <DescriptionList.Term>Name</DescriptionList.Term>
          <DescriptionList.Detail>{organization.name}</DescriptionList.Detail>
          <DescriptionList.Term>Slug</DescriptionList.Term>
          <DescriptionList.Detail className="break-all">
            {organization.slug}
          </DescriptionList.Detail>
          <DescriptionList.Term>Your role</DescriptionList.Term>
          <DescriptionList.Detail>
            <Chip tone="neutral">{organization.role}</Chip>
          </DescriptionList.Detail>
          <DescriptionList.Term>Status</DescriptionList.Term>
          <DescriptionList.Detail>
            <Chip tone="ok">Active</Chip>
          </DescriptionList.Detail>
        </DescriptionList.Root>
      </SettingsSection>
    </Page>
  );
}

export function ProjectsView({
  createAction,
  organization,
  projects,
}: {
  /** The registration action; the header offers it to an owner or admin. */
  createAction?: FormAction;
  organization: OrganizationAccess;
  projects: OrganizationProject[];
}) {
  const canCreate = organization.role !== "member";
  return (
    <Page
      action={
        canCreate && createAction ? (
          // Keyed on the count: registering ends in a redirect to this very
          // page, and the page that comes back has one project more, which
          // mounts the dialog again, closed.
          <CreateProjectDialog action={createAction} key={projects.length} />
        ) : undefined
      }
      description="Project identities and their optional canonical GitHub repositories."
      eyebrow="Settings"
      title="Projects"
    >
      <SettingsSection
        bleed={projects.length > 0}
        headingId="projects-registered"
        note={`${projects.length} registered`}
        title="Registered projects"
      >
        {projects.length > 0 ? (
          <ProjectTable projects={projects} />
        ) : (
          <EmptyState
            hint={
              canCreate
                ? "Use New project to register a project and its canonical repository."
                : "An organization owner or admin can register the first project."
            }
            icon={FolderPlus}
            title="No projects registered"
          />
        )}
      </SettingsSection>
    </Page>
  );
}

export function ProjectCreationView({
  action,
  organization,
}: {
  action: FormAction;
  organization: OrganizationAccess;
}) {
  return (
    <Page
      description={`Register a canonical target inside ${organization.name}.`}
      eyebrow="Projects"
      title="Create project"
      width="form"
    >
      <SettingsSection headingId="project-identity" title="Project identity">
        {organization.role === "member" ? (
          <EmptyState
            hint="Only an organization owner or admin can create projects."
            title="Administration access required"
          />
        ) : (
          <ProjectForm action={action} />
        )}
      </SettingsSection>
    </Page>
  );
}

export function MembersView({
  currentUserId,
  invitationAction,
  invitationIdempotencyKeys,
  invitationResendIdempotencyKeys,
  invitations,
  members,
  memberAction,
  memberIdempotencyKeys,
  organization,
  resendInvitationAction,
  revokeInvitationAction,
}: {
  currentUserId: string;
  invitationAction?: FormAction;
  /** The revocation form's key for each pending invitation, by its id. */
  invitationIdempotencyKeys?: Record<string, string>;
  /** The resend form's key for each pending invitation, by its id. */
  invitationResendIdempotencyKeys?: Record<string, string>;
  invitations: PendingInvitation[];
  members: OrganizationMember[];
  memberAction?: MemberAction;
  memberIdempotencyKeys?: Record<string, string>;
  organization: OrganizationAccess;
  resendInvitationAction?: MemberAction;
  revokeInvitationAction?: MemberAction;
}) {
  const canInvite =
    organization.role === "owner" || organization.role === "admin";
  const actorRole = organization.role as "owner" | "admin";
  // Whether a row offers its menu: never the actor's own row, and an owner's
  // row only to an owner. The same rule the role action enforces.
  const revocable = (member: OrganizationMember) =>
    member.userId !== currentUserId &&
    (member.role !== "owner" || organization.role === "owner");
  // Whether a pending invitation offers Resend and Revoke: an owner
  // invitation only to an owner, the rule both commands enforce (ruling 260).
  const manageableInvitation = (invitation: PendingInvitation) =>
    invitation.role !== "owner" || organization.role === "owner";
  return (
    <Page
      action={
        canInvite && invitationAction ? (
          <InviteMemberDialog
            action={invitationAction}
            canInviteOwner={organization.role === "owner"}
          />
        ) : undefined
      }
      description={`People who can answer agents, triage requests and change settings in ${organization.name}.`}
      eyebrow="Settings"
      title="Members"
    >
      <SettingsSection
        bleed
        headingId="active-members"
        note={`${members.length} total`}
        title="Active members"
      >
        <TableScrollRegion aria-label="Active organization members">
          <Table.Root>
            <Table.Caption>Active organization members</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Person</Table.Head>
                <Table.Head>Role</Table.Head>
                <Table.Head>Joined</Table.Head>
                {canInvite ? (
                  <Table.Head>
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                ) : null}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {members.map((member) => {
                const key = memberIdempotencyKeys?.[member.userId];
                const manageable = canInvite && memberAction && key;
                return (
                  <Table.Row key={member.userId}>
                    <Table.Cell>
                      <Stack align="center" direction="row" gap={3}>
                        <Avatar
                          aria-hidden="true"
                          fallback={initialOf(member.name || member.email)}
                          size="sm"
                        />
                        <Stack direction="column" gap={1}>
                          <span className="font-medium text-fg">
                            {member.name}
                          </span>
                          <span className="text-fg-muted">{member.email}</span>
                        </Stack>
                      </Stack>
                    </Table.Cell>
                    <Table.Cell>
                      {manageable ? (
                        <MemberRoleControl
                          action={memberAction}
                          actorRole={actorRole}
                          idempotencyKey={key}
                          member={member}
                        />
                      ) : (
                        <Chip tone="neutral">{roleLabel(member.role)}</Chip>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {/* When the membership began, written as this page
                       * writes an invitation's expiry: the UTC day, with the
                       * instant in `dateTime`. */}
                      <time
                        className="text-fg-muted"
                        dateTime={member.joinedAt.toISOString()}
                      >
                        {member.joinedAt.toISOString().slice(0, 10)}
                      </time>
                    </Table.Cell>
                    {canInvite ? (
                      <Table.Cell>
                        {manageable && revocable(member) ? (
                          <MemberActionsMenu
                            action={memberAction}
                            idempotencyKey={key}
                            member={member}
                          />
                        ) : null}
                      </Table.Cell>
                    ) : null}
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        </TableScrollRegion>
      </SettingsSection>
      {canInvite ? (
        <SettingsSection
          bleed={invitations.length > 0}
          headingId="pending-invitations"
          note={`${invitations.length} awaiting acceptance`}
          title="Pending invitations"
        >
          {invitations.length > 0 ? (
            invitations.map((invitation) => (
              <Row key={invitation.id}>
                <Stack
                  align="center"
                  direction="row"
                  gap={3}
                  justify="between"
                  wrap
                >
                  <Stack direction="column" gap={1}>
                    <span className="break-all text-fg">
                      {invitation.email}
                    </span>
                    <span className="text-fg-muted">
                      {roleLabel(invitation.role)} · expires{" "}
                      <time dateTime={invitation.expiresAt.toISOString()}>
                        {invitation.expiresAt.toISOString().slice(0, 10)}
                      </time>
                    </span>
                  </Stack>
                  {manageableInvitation(invitation) ? (
                    <Stack align="start" direction="row" gap={2} wrap>
                      {resendInvitationAction &&
                      invitationResendIdempotencyKeys?.[invitation.id] ? (
                        <ResendInvitationForm
                          action={resendInvitationAction}
                          idempotencyKey={
                            invitationResendIdempotencyKeys[invitation.id]
                          }
                          invitation={invitation}
                        />
                      ) : null}
                      {revokeInvitationAction &&
                      invitationIdempotencyKeys?.[invitation.id] ? (
                        <RevokeInvitationForm
                          action={revokeInvitationAction}
                          idempotencyKey={
                            invitationIdempotencyKeys[invitation.id]
                          }
                          invitation={invitation}
                        />
                      ) : null}
                    </Stack>
                  ) : null}
                </Stack>
              </Row>
            ))
          ) : (
            <EmptyState
              hint="Use Invite member to give someone access to this organization."
              icon={MailX}
              title="No pending invitations"
            />
          )}
        </SettingsSection>
      ) : null}
    </Page>
  );
}
