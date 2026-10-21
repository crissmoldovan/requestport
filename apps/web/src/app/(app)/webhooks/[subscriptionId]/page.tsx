import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { DescriptionList, Stack } from "@cueplusplus/ui/layout";
import {
  createOutboxRepository,
  createWebhookRepository,
} from "@requestport/db";
import { Inbox } from "lucide-react";
import { notFound } from "next/navigation";
import { Fragment } from "react";

import { Page } from "../../../../components/page-layout.js";
import { SettingsSection } from "../../../../components/settings-section.js";
import { WebhookReplayButton } from "../../../../components/webhook-management.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import { replayWebhookAction } from "../actions.js";

export default async function WebhookDetailPage({
  params,
}: {
  params: Promise<{ subscriptionId: string }>;
}) {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) return null;
  const { subscriptionId } = await params;
  const storage = webStorage();
  const subscription = (
    await createWebhookRepository(storage.db).list(
      organization.id,
      context.session.user.id,
    )
  ).find((item) => item.id === subscriptionId);
  if (!subscription) notFound();
  const operations = await createOutboxRepository(
    storage.db,
  ).listWebhookOperations(
    organization.id,
    subscription.id,
    context.session.user.id,
  );
  const attemptsByDelivery = new Map<string, typeof operations.attempts>();
  for (const attempt of operations.attempts)
    attemptsByDelivery.set(attempt.deliveryId, [
      ...(attemptsByDelivery.get(attempt.deliveryId) ?? []),
      attempt,
    ]);
  // Key identifiers only. A signing secret is returned once, at creation or
  // rotation, and never projected onto a page that can be reloaded.
  const policy = [
    ["Status", subscription.status.replaceAll("_", " ")],
    ["Project IDs", subscription.projectIds.join(", ") || "All projects"],
    ["Lane IDs", subscription.laneIds.join(", ") || "All lanes"],
    ["Event types", subscription.eventTypes.join(", ") || "All event types"],
    [
      "Request types",
      subscription.requestTypes.join(", ") || "All request types",
    ],
    ["Current signing key", subscription.currentSecretKeyId],
    [
      "Rotation",
      subscription.nextSecretKeyId
        ? `${subscription.nextSecretKeyId} until ${
            subscription.overlapEndsAt?.toISOString() ?? "promotion"
          }`
        : "No overlap in progress",
    ],
  ] as const;
  return (
    <Page
      description={subscription.endpointUrl}
      eyebrow="Webhook"
      title={subscription.name}
      width="wide"
    >
      <SettingsSection
        headingId="webhook-filter-heading"
        note="Current safe scope and signing-key state."
        title="Subscription policy"
      >
        <DescriptionList.Root>
          {policy.map(([label, value]) => (
            <Fragment key={label}>
              <DescriptionList.Term>{label}</DescriptionList.Term>
              <DescriptionList.Detail>
                <span className="break-all">{value}</span>
              </DescriptionList.Detail>
            </Fragment>
          ))}
        </DescriptionList.Root>
      </SettingsSection>
      <SettingsSection
        bleed={operations.deliveries.length > 0}
        headingId="webhook-deliveries"
        note={`${operations.deliveries.length} retained`}
        title="Deliveries"
      >
        {operations.deliveries.length ? (
          <TableScrollRegion aria-label="Webhook delivery attempts">
            <Table.Root>
              <Table.Caption>Webhook deliveries and attempts</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Delivery</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Replay</Table.Head>
                  <Table.Head>Created</Table.Head>
                  <Table.Head>Latest attempt</Table.Head>
                  <Table.Head>Retry / failure</Table.Head>
                  <Table.Head>Action</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {operations.deliveries.map((delivery) => {
                  const attempt = attemptsByDelivery.get(delivery.id)?.[0];
                  return (
                    <Table.Row key={delivery.id}>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <code className="font-mono">{delivery.id}</code>
                          <span className="text-fg-subtle">
                            event {delivery.eventId}
                          </span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        {delivery.status.replaceAll("_", " ")}
                      </Table.Cell>
                      <Table.Cell>{delivery.replayNumber}</Table.Cell>
                      <Table.Cell>
                        <span className="text-fg-subtle">
                          {delivery.createdAt.toISOString()}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        {attempt ? (
                          <Stack direction="column" gap={1}>
                            <span>
                              {attempt.responseStatus ??
                                attempt.errorCode ??
                                "running"}
                            </span>
                            {attempt.responseExcerpt ? (
                              <span className="text-fg-subtle">
                                {attempt.responseExcerpt}
                              </span>
                            ) : null}
                          </Stack>
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <span>
                          {attempt?.nextAttemptAt
                            ? attempt.nextAttemptAt.toISOString()
                            : (attempt?.errorCode ??
                              (delivery.status === "dead_letter"
                                ? "Attempts exhausted"
                                : "—"))}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <WebhookReplayButton
                          action={replayWebhookAction}
                          deliveryId={delivery.id}
                          idempotencyKey={randomUUID()}
                        />
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Matching domain events will appear here."
            icon={Inbox}
            title="No deliveries yet"
          />
        )}
      </SettingsSection>
    </Page>
  );
}
