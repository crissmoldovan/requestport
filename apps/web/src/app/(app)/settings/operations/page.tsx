import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { DescriptionList, Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import {
  createOperationsQueryRepository,
  createRetentionHoldRepository,
} from "@requestport/db";
import { Archive, FileWarning, Inbox, MessageSquareOff } from "lucide-react";
import { notFound } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import {
  ReleaseRetentionHoldForm,
  RequeueImportDispatchForm,
  RequeueNotificationForm,
  RequeueOutboxForm,
  RequeueSlackOperationForm,
  RetentionHoldDialog,
} from "../../../../components/operations-control.js";
import { Page } from "../../../../components/page-layout.js";
import { SettingsSection } from "../../../../components/settings-section.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import {
  createRetentionHoldAction,
  releaseRetentionHoldAction,
  requeueImportDispatchAction,
  requeueNotificationAction,
  requeueOutboxAction,
  requeueSlackOperationAction,
} from "./actions.js";

function instant(value: Date | string) {
  return new Date(value).toISOString();
}

/** One dense record line: a title, a detail, and the record's own timing. */
function RecordLine({
  aside,
  children,
  detail,
  title,
}: {
  aside: string;
  children?: ReactNode;
  detail: string;
  title: ReactNode;
}) {
  return (
    <Stack direction="column" gap={1}>
      <Stack align="baseline" direction="row" gap={3} justify="between" wrap>
        <span>{title}</span>
        <span className="text-fg-subtle">{aside}</span>
      </Stack>
      <span className="text-fg-subtle break-all">{detail}</span>
      {children}
    </Stack>
  );
}

export default async function OperationsPage() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (
    !organization ||
    (organization.role !== "owner" && organization.role !== "admin")
  )
    notFound();
  const storage = webStorage();
  const operationsQueries = createOperationsQueryRepository(storage.db);
  const [summary, details, holds] = await Promise.all([
    operationsQueries.summary(context.session.user.id, organization.id),
    operationsQueries.details(context.session.user.id, organization.id),
    createRetentionHoldRepository(storage.db).list(
      organization.id,
      context.session.user.id,
    ),
  ]);
  const items = [
    ["Pending outbox", summary.pending_outbox, 1_000],
    ["Oldest outbox age (seconds)", summary.oldest_outbox_seconds, 120],
    ["Dead-letter webhooks", summary.dead_webhooks, 0],
    ["Pending notifications", summary.pending_notifications, 100],
    ["Stale work sessions", summary.stale_sessions, 25],
    ["Open import blockers", summary.open_import_conflicts, 0],
    ["Dead-letter import tasks", summary.dead_import_dispatches, 0],
    ["Pending Slack updates", summary.pending_slack_updates, 50],
  ] as const;
  return (
    <Page
      description="Safe operational records for recovery decisions. Provider payloads, recipient addresses, tokens, and private telemetry are never projected here."
      eyebrow="Settings"
      title="Operations"
      width="wide"
    >
      <SettingsSection
        headingId="operations-health-heading"
        note="Refresh to reload canonical database state. Alert thresholds link to the observability runbook."
        title="Current health"
      >
        <DescriptionList.Root>
          {items.map(([label, value, alertAt]) => {
            const alerting = value > alertAt;
            return (
              <Fragment key={label}>
                <DescriptionList.Term>{label}</DescriptionList.Term>
                <DescriptionList.Detail>
                  <Stack align="center" direction="row" gap={2} wrap>
                    <span>{value}</span>
                    <Chip tone={alerting ? "danger" : "ok"}>
                      {alerting ? "Review" : "Healthy"}
                    </Chip>
                  </Stack>
                </DescriptionList.Detail>
              </Fragment>
            );
          })}
        </DescriptionList.Root>
      </SettingsSection>
      <SettingsSection
        bleed
        headingId="operations-outbox-heading"
        note="Event, outbox, task, retry, and recovery identifiers."
        title="Event outbox"
      >
        <TableScrollRegion aria-label="Event outbox records">
          <Table.Root>
            <Table.Caption>Recent event outbox records</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Outbox / event</Table.Head>
                <Table.Head>Event type</Table.Head>
                <Table.Head>State</Table.Head>
                <Table.Head>Attempts / next</Table.Head>
                <Table.Head>Trigger run</Table.Head>
                <Table.Head>Recovery</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {details.outbox.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <Stack direction="column" gap={1}>
                      <code className="font-mono">{row.id}</code>
                      <span className="text-fg-subtle">
                        event {row.event_id}
                        {row.request_id ? ` · request ${row.request_id}` : ""}
                      </span>
                    </Stack>
                  </Table.Cell>
                  <Table.Cell>{row.event_type}</Table.Cell>
                  <Table.Cell>{row.state}</Table.Cell>
                  <Table.Cell>
                    <Stack direction="column" gap={1}>
                      <span>{row.attempt_count}</span>
                      <span className="text-fg-subtle">
                        {instant(row.next_attempt_at)}
                      </span>
                    </Stack>
                  </Table.Cell>
                  <Table.Cell>
                    <code className="font-mono">
                      {row.trigger_run_id ?? "—"}
                    </code>
                  </Table.Cell>
                  <Table.Cell>
                    {row.state === "dead_letter" ? (
                      <RequeueOutboxForm
                        action={requeueOutboxAction}
                        expectedVersion={row.attempt_count}
                        idempotencyKey={`web:operations:requeue:${randomUUID()}`}
                        outboxId={row.id}
                      />
                    ) : (
                      "—"
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </TableScrollRegion>
      </SettingsSection>
      <SettingsSection
        action={
          <RetentionHoldDialog
            action={createRetentionHoldAction}
            idempotencyKey={`web:retention:create:${randomUUID()}`}
          />
        }
        headingId="operations-retention-heading"
        note="Pause eligible organization-scoped cleanup without exposing preserved data."
        title="Retention holds"
      >
        {holds.length ? (
          holds.map((hold) => (
            <RecordLine
              aside={`v${hold.version} · ${instant(hold.createdAt)}`}
              detail={hold.reason}
              key={hold.id}
              title={`${hold.category} · ${hold.status}`}
            >
              {hold.status === "active" ? (
                <ReleaseRetentionHoldForm
                  action={releaseRetentionHoldAction}
                  expectedVersion={hold.version}
                  holdId={hold.id}
                  idempotencyKey={`web:retention:release:${randomUUID()}`}
                />
              ) : null}
            </RecordLine>
          ))
        ) : (
          <EmptyState
            hint="A hold pauses eligible cleanup until it is released. Use Add hold to create one."
            icon={Archive}
            title="No retention holds"
          />
        )}
      </SettingsSection>
      <SettingsSection
        bleed
        headingId="operations-notifications-heading"
        note="Safe notification intents and provider-record statuses."
        title="HITL delivery"
      >
        <TableScrollRegion aria-label="Notification delivery records">
          <Table.Root>
            <Table.Caption>Recent notification delivery records</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Intent</Table.Head>
                <Table.Head>Subject</Table.Head>
                <Table.Head>Channel</Table.Head>
                <Table.Head>Template</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Provider record</Table.Head>
                <Table.Head>Attempts / retry</Table.Head>
                <Table.Head>Recovery</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {details.notifications.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <code className="font-mono">{row.id}</code>
                  </Table.Cell>
                  <Table.Cell>
                    <code className="font-mono">
                      {row.question_id ?? row.event_id ?? "—"}
                    </code>
                  </Table.Cell>
                  <Table.Cell>{row.channel}</Table.Cell>
                  <Table.Cell>{row.template}</Table.Cell>
                  <Table.Cell>{row.status}</Table.Cell>
                  <Table.Cell>
                    <Stack direction="column" gap={1}>
                      <code className="font-mono">
                        {row.provider_record_id ?? "—"}
                      </code>
                      <span className="text-fg-subtle">
                        {row.provider_status ?? "not created"}
                      </span>
                    </Stack>
                  </Table.Cell>
                  <Table.Cell>
                    <Stack direction="column" gap={1}>
                      <span>{row.attempt_count}</span>
                      <span className="text-fg-subtle">
                        {row.last_error_code ?? "no error"}
                        {row.next_attempt_at
                          ? ` · ${instant(row.next_attempt_at)}`
                          : " · no automatic retry"}
                      </span>
                    </Stack>
                  </Table.Cell>
                  <Table.Cell>
                    {row.status === "failed" &&
                    (row.channel === "email" || row.channel === "slack") ? (
                      <RequeueNotificationForm
                        action={requeueNotificationAction}
                        channel={row.channel}
                        expectedVersion={row.attempt_count}
                        idempotencyKey={`web:operations:notification:${randomUUID()}`}
                        notificationIntentId={row.id}
                      />
                    ) : (
                      "—"
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </TableScrollRegion>
      </SettingsSection>
      <SettingsSection
        headingId="operations-sessions-heading"
        note="Safe identities and lease state; machine telemetry stays encrypted."
        title="Work sessions"
      >
        {details.sessions.length ? (
          details.sessions.map((row) => (
            <RecordLine
              aside={`lease ${instant(row.lease_expires_at)}`}
              detail={`request ${row.request_id} · agent ${row.agent_principal_id}`}
              key={row.id}
              title={`${row.state} · session ${row.id}`}
            />
          ))
        ) : (
          <EmptyState
            hint="A session appears when an agent claims a request."
            icon={Inbox}
            title="No work sessions"
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="operations-imports-heading"
        note="Review identifiers without projecting preserved source bytes."
        title="Import conflicts"
      >
        {details.importConflicts.length ? (
          details.importConflicts.map((row) => (
            <RecordLine
              aside={
                row.resolved_at
                  ? `resolved ${instant(row.resolved_at)}`
                  : "open"
              }
              detail={`run ${row.import_run_id} · entry ${row.entry_id}`}
              key={row.id}
              title={`${row.severity} · ${row.kind}`}
            />
          ))
        ) : (
          <EmptyState
            hint="An import conflict appears when preserved source data cannot be reconciled."
            icon={FileWarning}
            title="No import conflicts"
          />
        )}
        <TableScrollRegion aria-label="Import task dispatch records">
          <Table.Root>
            <Table.Caption>Recent import task dispatch records</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Dispatch / run</Table.Head>
                <Table.Head>Task</Table.Head>
                <Table.Head>State</Table.Head>
                <Table.Head numeric>Attempts</Table.Head>
                <Table.Head>Trigger run</Table.Head>
                <Table.Head>Recovery</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {details.importDispatches.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <Stack direction="column" gap={1}>
                      <code className="font-mono">{row.id}</code>
                      <span className="text-fg-subtle">
                        run {row.import_run_id}
                      </span>
                    </Stack>
                  </Table.Cell>
                  <Table.Cell>{row.task_kind}</Table.Cell>
                  <Table.Cell>
                    <Stack direction="column" gap={1}>
                      <span>{row.state}</span>
                      {row.last_error_code ? (
                        <span className="text-fg-subtle">
                          {row.last_error_code}
                        </span>
                      ) : null}
                    </Stack>
                  </Table.Cell>
                  <Table.Cell numeric>{row.attempt_count}</Table.Cell>
                  <Table.Cell>
                    <code className="font-mono">
                      {row.trigger_run_id ?? "—"}
                    </code>
                  </Table.Cell>
                  <Table.Cell>
                    {row.state === "dead_letter" ? (
                      <RequeueImportDispatchForm
                        action={requeueImportDispatchAction}
                        dispatchId={row.id}
                        expectedVersion={row.attempt_count}
                        idempotencyKey={`web:operations:import:${randomUUID()}`}
                      />
                    ) : (
                      "—"
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </TableScrollRegion>
      </SettingsSection>
      <SettingsSection
        headingId="operations-slack-heading"
        note="Safe operation IDs and state; message content and tokens are excluded."
        title="Slack operations"
      >
        {details.slackOperations.length ? (
          details.slackOperations.map((row) => (
            <RecordLine
              aside={
                row.status === "retry"
                  ? `retry ${instant(row.next_attempt_at)}`
                  : instant(row.updated_at)
              }
              detail={`installation ${row.installation_id} · attempt ${row.attempt_count}${
                row.last_error_code ? ` · ${row.last_error_code}` : ""
              }`}
              key={row.id}
              title={`${row.status} · ${row.operation_type.replaceAll("_", " ")} ${row.id}`}
            >
              {row.status === "failed" &&
              (row.operation_type === "message_update" ||
                row.operation_type === "connection_test") ? (
                <RequeueSlackOperationForm
                  action={requeueSlackOperationAction}
                  expectedVersion={row.attempt_count}
                  idempotencyKey={`web:operations:slack:${randomUUID()}`}
                  operationId={row.id}
                  operationType={row.operation_type}
                />
              ) : null}
            </RecordLine>
          ))
        ) : (
          <EmptyState
            hint="A Slack operation appears when a message update or connection test is dispatched."
            icon={MessageSquareOff}
            title="No Slack operations"
          />
        )}
      </SettingsSection>
    </Page>
  );
}
