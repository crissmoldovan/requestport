import { EmptyState, Panel, PanelHeader } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { createNotificationRepository } from "@requestport/db";
import { MailX } from "lucide-react";
import { notFound } from "next/navigation";

import { Page, PageSection } from "../../../../../components/page-layout.js";
import {
  sectionHeadingClasses,
  sectionHeadingNoteClasses,
} from "../../../../../components/section-heading.js";
import { getApplicationContext } from "../../../../../lib/server-application-context.js";
import { webStorage } from "../../../../../lib/server-request-port.js";

/**
 * The type CUE++ gives a `PanelHeader`'s own title, spelled in its tokens.
 *
 * The heading goes in the header's leading cluster rather than its `title`
 * slot: that slot is a `<span>`, and a section of a document needs a real
 * `<h2>` a screen-reader user can jump between.
 */

export default async function QuestionDeliveriesPage({
  params,
}: {
  params: Promise<{ questionId: string }>;
}) {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (
    !organization ||
    (organization.role !== "owner" && organization.role !== "admin")
  )
    notFound();
  const { questionId } = await params;
  const storage = webStorage();
  const deliveries = await createNotificationRepository(
    storage.db,
  ).listQuestionDeliveries(
    organization.id,
    questionId,
    context.session.user.id,
  );
  return (
    <Page
      eyebrow="Operations"
      title="Question delivery"
      description="Safe delivery state across email and Slack. Provider payloads and credentials are never displayed."
      width="wide"
    >
      <PageSection labelledBy="question-delivery-records">
        <Panel>
          <PanelHeader>
            <h2
              className={sectionHeadingClasses}
              id="question-delivery-records"
            >
              Delivery records
            </h2>
            <span className={sectionHeadingNoteClasses}>
              {deliveries.length} intents
            </span>
          </PanelHeader>
          {deliveries.length ? (
            <TableScrollRegion aria-label="Question delivery records">
              <Table.Root>
                <Table.Caption>Question delivery status</Table.Caption>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Intent / channel</Table.Head>
                    <Table.Head>Recipient</Table.Head>
                    <Table.Head>Template</Table.Head>
                    <Table.Head>Status</Table.Head>
                    <Table.Head numeric>Attempts / retry</Table.Head>
                    <Table.Head>Provider records</Table.Head>
                    <Table.Head>Created</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {deliveries.map((delivery) => (
                    <Table.Row key={delivery.id}>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <span className="font-mono">{delivery.id}</span>
                          <span className="text-fg-subtle">
                            {delivery.channel}
                          </span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="font-mono">
                          {delivery.recipientUserId ?? "external recipient"}
                        </span>
                      </Table.Cell>
                      <Table.Cell>{delivery.template}</Table.Cell>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <span>{delivery.status}</span>
                          <span className="text-fg-subtle">
                            {delivery.lastErrorCode ?? "no error"}
                          </span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell numeric>
                        <Stack direction="column" gap={1}>
                          <span>{delivery.attemptCount}</span>
                          <span className="text-fg-subtle">
                            {delivery.nextAttemptAt
                              ? delivery.nextAttemptAt.toISOString()
                              : "no automatic retry"}
                          </span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        {delivery.attempts.length ? (
                          <Stack direction="column" gap={1}>
                            {delivery.attempts.map((attempt) => (
                              <span
                                className="text-fg-subtle"
                                key={
                                  "providerMessageId" in attempt
                                    ? (attempt.providerMessageId ??
                                      attempt.intentId)
                                    : (attempt.messageTs ??
                                      `${attempt.intentId}:${attempt.channelId}`)
                                }
                              >
                                {"providerMessageId" in attempt
                                  ? `email ${attempt.status} · ${attempt.providerMessageId ?? "pending"}`
                                  : `Slack ${attempt.status} · ${attempt.messageTs ?? "pending"}`}
                              </span>
                            ))}
                          </Stack>
                        ) : (
                          "not created"
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {delivery.createdAt.toISOString()}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </TableScrollRegion>
          ) : (
            <EmptyState
              hint="This question has not produced an ordinary notification intent."
              icon={MailX}
              title="No delivery records"
            />
          )}
        </Panel>
      </PageSection>
    </Page>
  );
}
