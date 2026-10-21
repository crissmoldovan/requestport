import { randomUUID } from "node:crypto";
import { EmptyState, Row } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { serverEnv } from "@requestport/config/server";
import {
  createFoundationQueryRepository,
  createSlackRepository,
} from "@requestport/db";
import { Hash, Inbox, ShieldOff, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Page } from "../../../components/page-layout.js";
import { SettingsSection } from "../../../components/settings-section.js";
import {
  SlackConnectionTestForm,
  SlackInstallationActions,
  SlackMappingForm,
  SlackRouteForm,
} from "../../../components/slack-management.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";
import { isE2EScenarioProviderUnavailable } from "../../../lib/server-scenario-boundary.js";
import {
  mapSlackUserAction,
  sendSlackConnectionTestAction,
  setSlackInstallationStatusAction,
  setSlackRouteAction,
} from "./actions.js";

/**
 * A Slack record's lifecycle, as a chip tone.
 *
 * `StatusDot`'s shipped vocabulary has no member for "disabled" or "revoked",
 * so §6.2 sends every one of these labels to `Chip` — and the state is read out
 * in words beside the tone, never in colour alone.
 */
function statusTone(status: string) {
  if (status === "active") return "ok" as const;
  if (status === "revoked") return "danger" as const;

  return "neutral" as const;
}

export default async function SlackPage() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) return null;
  const canManage =
    organization.role === "owner" || organization.role === "admin";
  const storage = webStorage();
  const foundationQueries = createFoundationQueryRepository(storage.db);
  const [configuration, members, projects] = canManage
    ? await Promise.all([
        createSlackRepository(storage.db).list(
          organization.id,
          context.session.user.id,
        ),
        foundationQueries.listOrganizationMembers(
          context.session.user.id,
          organization.id,
        ),
        foundationQueries.listOrganizationProjects(
          context.session.user.id,
          organization.id,
        ),
      ])
    : [null, [], []];
  const effectiveCanManage = canManage && configuration !== null;
  const providerConfigured =
    !(await isE2EScenarioProviderUnavailable()) &&
    Boolean(
      serverEnv.REQUESTPORT_SLACK_CLIENT_ID &&
        serverEnv.REQUESTPORT_SLACK_CLIENT_SECRET &&
        serverEnv.REQUESTPORT_SLACK_STATE_SECRET &&
        serverEnv.REQUESTPORT_SLACK_SIGNING_SECRET &&
        serverEnv.REQUESTPORT_WORKSPACE_KEK,
    );
  const activeInstallations =
    configuration?.installations.filter((item) => item.status === "active") ??
    [];
  // One padded measure column per page, so the two branches share the column
  // rather than each opening one of their own.
  const page = (children: ReactNode) => (
    <Page
      description="Deliver human questions to mapped members or channels and commit answers through the canonical RequestPort workflow."
      eyebrow="Integrations"
      title="Slack"
      width="wide"
    >
      {children}
    </Page>
  );
  if (!canManage) {
    return page(
      <SettingsSection headingId="slack-workspaces" title="Workspaces">
        <EmptyState
          hint="Ask an organization owner or admin to connect a workspace or change a delivery route."
          icon={ShieldOff}
          title="Slack delivery is owner and admin only"
        />
      </SettingsSection>,
    );
  }
  return page(
    <>
      {providerConfigured ? null : (
        <SettingsSection
          headingId="slack-provider-heading"
          title="Provider status"
        >
          {/* The five settings are only ever tested for presence; no value
              reaches this page. */}
          <EmptyState
            hint="Add the Slack client, signing, state, and encryption settings before connecting a workspace."
            icon={TriangleAlert}
            title="Slack configuration required"
          />
        </SettingsSection>
      )}
      <SettingsSection
        action={
          effectiveCanManage && providerConfigured ? (
            <Button
              render={<a href="/api/slack/install" />}
              size="sm"
              variant="primary"
            >
              Connect workspace
            </Button>
          ) : undefined
        }
        bleed={(configuration?.installations.length ?? 0) > 0}
        headingId="slack-workspaces"
        note={`${configuration?.installations.length ?? 0} connected`}
        title="Workspaces"
      >
        {configuration?.installations.length ? (
          <TableScrollRegion aria-label="Slack workspaces">
            <Table.Root>
              <Table.Caption>Slack installations</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Workspace</Table.Head>
                  <Table.Head>Bot</Table.Head>
                  <Table.Head>Scopes</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {configuration.installations.map((item) => (
                  <Table.Row key={item.id}>
                    <Table.Cell>
                      <Stack direction="column" gap={1}>
                        <span>{item.workspaceName}</span>
                        <code className="text-fg-subtle font-mono">
                          {item.workspaceId}
                        </code>
                      </Stack>
                    </Table.Cell>
                    <Table.Cell>
                      <code className="font-mono">{item.botUserId}</code>
                    </Table.Cell>
                    <Table.Cell>
                      <span>{item.scopes.join(", ")}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <Chip tone={statusTone(item.status)}>{item.status}</Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <SlackInstallationActions
                        action={setSlackInstallationStatusAction}
                        expectedVersion={item.version}
                        idempotencyKey={`web:slack:status:${randomUUID()}`}
                        installationId={item.id}
                        status={item.status}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Connect a workspace to enable interactive human-in-the-loop delivery."
            icon={Hash}
            title="No Slack workspace"
          />
        )}
      </SettingsSection>
      {effectiveCanManage && activeInstallations.length ? (
        <>
          <SettingsSection
            bleed
            headingId="slack-mappings"
            note="Bind Slack identities to active RequestPort members."
            title="Member mappings"
          >
            {configuration.mappings.length ? (
              <TableScrollRegion aria-label="Slack member mappings">
                <Table.Root>
                  <Table.Caption>Slack member mappings</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Member</Table.Head>
                      <Table.Head>Slack member ID</Table.Head>
                      <Table.Head>Status</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {configuration.mappings.map((mapping) => (
                      <Table.Row key={mapping.id}>
                        <Table.Cell>
                          <span>{mapping.userName}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <code className="font-mono">
                            {mapping.slackUserId}
                          </code>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip tone={statusTone(mapping.status)}>
                            {mapping.status}
                          </Chip>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </TableScrollRegion>
            ) : null}
            <Row>
              <SlackMappingForm
                action={mapSlackUserAction}
                idempotencyKey={`web:slack:mapping:${randomUUID()}`}
                installations={activeInstallations}
                mappings={configuration.mappings}
                members={members}
              />
            </Row>
          </SettingsSection>
          <SettingsSection
            bleed
            headingId="slack-routes"
            note="Project routes take precedence over the organization fallback."
            title="Delivery routes"
          >
            {configuration.routes.length ? (
              <TableScrollRegion aria-label="Slack delivery routes">
                <Table.Root>
                  <Table.Caption>Slack delivery routes</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Scope</Table.Head>
                      <Table.Head>Delivery</Table.Head>
                      <Table.Head>Channel</Table.Head>
                      <Table.Head>Status</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {configuration.routes.map((route) => (
                      <Table.Row key={route.id}>
                        <Table.Cell>
                          <span>
                            {route.projectName ?? "Organization fallback"}
                          </span>
                        </Table.Cell>
                        <Table.Cell>{route.mode}</Table.Cell>
                        <Table.Cell>
                          <code className="font-mono">
                            {route.channelId ?? "DM"}
                          </code>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip tone={statusTone(route.status)}>
                            {route.status}
                          </Chip>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </TableScrollRegion>
            ) : null}
            <Row>
              <SlackRouteForm
                action={setSlackRouteAction}
                idempotencyKey={`web:slack:route:${randomUUID()}`}
                projects={projects}
                routes={configuration.routes}
              />
            </Row>
          </SettingsSection>
          <SettingsSection
            bleed
            headingId="slack-test"
            note="Send a durable test through Trigger.dev and inspect its latest state."
            title="Connection test"
          >
            {configuration.operations.length ? (
              <TableScrollRegion aria-label="Recent Slack operations">
                <Table.Root>
                  <Table.Caption>Recent Slack operations</Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Operation</Table.Head>
                      <Table.Head>Identifier</Table.Head>
                      <Table.Head>State</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {configuration.operations.slice(0, 10).map((operation) => (
                      <Table.Row key={operation.id}>
                        <Table.Cell>
                          {operation.operationType.replaceAll("_", " ")}
                        </Table.Cell>
                        <Table.Cell>
                          <code className="font-mono">{operation.id}</code>
                        </Table.Cell>
                        <Table.Cell>
                          <Stack direction="column" gap={1}>
                            <span>{operation.status}</span>
                            <span className="text-fg-subtle">
                              {operation.updatedAt.toISOString()}
                            </span>
                          </Stack>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </TableScrollRegion>
            ) : (
              <Row>
                <EmptyState
                  hint="Send a test below to prove the workspace can be reached."
                  icon={Inbox}
                  title="No Slack operations yet"
                />
              </Row>
            )}
            <Row>
              <SlackConnectionTestForm
                action={sendSlackConnectionTestAction}
                idempotencyKey={`web:slack:test:${randomUUID()}`}
                installations={activeInstallations}
              />
            </Row>
          </SettingsSection>
        </>
      ) : null}
    </>,
  );
}
