import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Link as CueLink } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import {
  createFoundationQueryRepository,
  createWebhookRepository,
} from "@requestport/db";
import { ShieldOff, Webhook } from "lucide-react";
import Link from "next/link";

import { Page } from "../../../components/page-layout.js";
import { SettingsSection } from "../../../components/settings-section.js";
import {
  CreateWebhookForm,
  WebhookActions,
} from "../../../components/webhook-management.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";
import {
  createWebhookAction,
  rotateWebhookSecretAction,
  setWebhookStatusAction,
  verifyWebhookAction,
} from "./actions.js";

/**
 * A subscription's lifecycle, as a chip tone.
 *
 * `StatusDot`'s shipped vocabulary is `ok | busy | warn | danger | idle`, and a
 * webhook awaiting verification is none of those, so §6.2 sends every one of
 * these labels to `Chip` — where the state is also read out in words, never in
 * colour alone.
 */
function statusTone(status: string) {
  if (status === "active") return "ok" as const;
  if (status === "revoked") return "danger" as const;
  if (status === "pending_verification") return "warn" as const;

  return "neutral" as const;
}

export default async function WebhooksPage() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) return null;
  const canManage =
    organization.role === "owner" || organization.role === "admin";
  const storage = webStorage();
  const foundationQueries = createFoundationQueryRepository(storage.db);
  const [subscriptions, projects, lanes] = canManage
    ? await Promise.all([
        createWebhookRepository(storage.db).list(
          organization.id,
          context.session.user.id,
        ),
        foundationQueries.listOrganizationProjects(
          context.session.user.id,
          organization.id,
        ),
        foundationQueries.listOrganizationLanes(
          context.session.user.id,
          organization.id,
        ),
      ])
    : [[], [], []];
  return (
    <Page
      description="Versioned organization or project events delivered with exact-byte signatures, bounded retries, and SSRF-safe endpoint validation."
      eyebrow="Integrations"
      title="Webhooks"
      width="wide"
    >
      {canManage ? (
        <>
          <SettingsSection
            bleed={subscriptions.length > 0}
            headingId="subscriptions-heading"
            note={`${subscriptions.length} configured`}
            title="Subscriptions"
          >
            {subscriptions.length ? (
              <TableScrollRegion aria-label="Webhook subscriptions">
                <Table.Root>
                  <Table.Caption>Webhook subscriptions</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Name</Table.Head>
                      <Table.Head>Endpoint</Table.Head>
                      <Table.Head>Events</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Last verified</Table.Head>
                      <Table.Head>Actions</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {subscriptions.map((subscription) => (
                      <Table.Row key={subscription.id}>
                        <Table.Cell>
                          <CueLink
                            render={
                              <Link href={`/webhooks/${subscription.id}`} />
                            }
                            variant="underline"
                          >
                            {subscription.name}
                          </CueLink>
                        </Table.Cell>
                        <Table.Cell>
                          <code className="font-mono">
                            {subscription.endpointUrl}
                          </code>
                        </Table.Cell>
                        <Table.Cell>
                          {subscription.eventTypes.join(", ") || "All"}
                        </Table.Cell>
                        <Table.Cell>
                          <Chip tone={statusTone(subscription.status)}>
                            {subscription.status.replaceAll("_", " ")}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-fg-subtle">
                            {subscription.verifiedAt?.toISOString() ?? "—"}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <WebhookActions
                            expectedVersion={subscription.version}
                            id={subscription.id}
                            idempotencyKeys={{
                              rotate: randomUUID(),
                              status: randomUUID(),
                              verify: randomUUID(),
                            }}
                            rotateAction={rotateWebhookSecretAction}
                            status={subscription.status}
                            statusAction={setWebhookStatusAction}
                            verifyAction={verifyWebhookAction}
                          />
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </TableScrollRegion>
            ) : (
              <EmptyState
                hint="Create one below; its signing secret is displayed once."
                icon={Webhook}
                title="No webhooks"
              />
            )}
          </SettingsSection>
          <SettingsSection
            headingId="create-webhook-heading"
            note="Endpoint verification must succeed before normal delivery starts."
            title="Create webhook"
          >
            <CreateWebhookForm
              action={createWebhookAction}
              idempotencyKey={randomUUID()}
              lanes={lanes}
              projects={projects}
            />
          </SettingsSection>
        </>
      ) : (
        <SettingsSection
          headingId="subscriptions-heading"
          title="Subscriptions"
        >
          <EmptyState
            hint="Ask an organization owner or admin to add, verify or rotate a subscription."
            icon={ShieldOff}
            title="Webhook delivery is owner and admin only"
          />
        </SettingsSection>
      )}
    </Page>
  );
}
