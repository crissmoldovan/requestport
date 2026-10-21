import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import { serverEnv } from "@requestport/config/server";
import {
  createAgentManagementRepository,
  createFoundationQueryRepository,
  createProjectSettingsRepository,
} from "@requestport/db";
import { BotOff, KeyRound, MonitorOff, ShieldOff } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AgentConnectionGuide } from "../../../../components/agent-connection-guide.js";
import {
  AgentStatusForm,
  CredentialActions,
  IssueAgentKeyForm,
  OauthGrantActions,
  RevealWorkspaceForm,
} from "../../../../components/agent-management.js";
import { Page } from "../../../../components/page-layout.js";
import { SettingsSection } from "../../../../components/settings-section.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import {
  issueAgentKeyAction,
  revealWorkspaceTelemetryAction,
  revokeAgentKeyAction,
  revokeAgentOauthGrantAction,
  rotateAgentKeyAction,
  setAgentStatusAction,
} from "../actions.js";

function date(value: Date | null) {
  return value ? value.toISOString().replace("T", " ").slice(0, 19) : "—";
}

function laneNames(
  laneIds: readonly string[],
  lanes: Array<{ id: string; name: string }>,
) {
  return laneIds.length
    ? laneIds
        .map(
          (laneId) =>
            lanes.find((lane) => lane.id === laneId)?.name ??
            laneId.slice(0, 8),
        )
        .join(", ")
    : "All";
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
  title: string;
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

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const [{ agentId }, context] = await Promise.all([
    params,
    getApplicationContext(),
  ]);
  const organization = context.currentOrganization;
  if (!organization) notFound();
  const storage = webStorage();
  const [detail, projects, lanes] = await Promise.all([
    createAgentManagementRepository(storage.db).getAgent(
      context.session.user.id,
      organization.id,
      agentId,
    ),
    createProjectSettingsRepository(storage.db).listManageableProjects(
      context.session.user.id,
      organization.id,
    ),
    createFoundationQueryRepository(storage.db).listOrganizationLanes(
      context.session.user.id,
      organization.id,
    ),
  ]);
  if (!detail) notFound();
  const canManage = detail.agent.projectId
    ? projects.some((project) => project.id === detail.agent.projectId)
    : organization.role === "owner" || organization.role === "admin";
  return (
    <Page
      description={`${detail.agent.softwareName ?? "Agent"} · ${detail.agent.projectName ?? "organization-wide"} · ${detail.agent.slug}`}
      eyebrow="Agent"
      title={detail.agent.displayName}
      width="wide"
    >
      <SettingsSection
        action={
          <Chip tone={detail.agent.status === "active" ? "ok" : "danger"}>
            {detail.agent.status}
          </Chip>
        }
        headingId="agent-status-heading"
        note="Authentication is accepted only while this principal is active."
        title="Agent status"
      >
        {canManage ? (
          <AgentStatusForm
            action={setAgentStatusAction}
            agentPrincipalId={agentId}
            currentStatus={
              detail.agent.status as "active" | "suspended" | "revoked"
            }
            expectedVersion={detail.agent.version}
            idempotencyKey={`web:agent:status:${randomUUID()}`}
          />
        ) : (
          <p>Only an administrator of this agent can change its status.</p>
        )}
      </SettingsSection>
      <SettingsSection
        bleed={detail.credentials.length > 0}
        headingId="agent-credentials-heading"
        note="Secrets are hashed at rest and plaintext is returned only once."
        title="Credentials"
      >
        {detail.credentials.length ? (
          <TableScrollRegion aria-label="Agent credentials">
            <Table.Root>
              <Table.Caption>Agent credentials</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Name</Table.Head>
                  <Table.Head>Prefix</Table.Head>
                  <Table.Head>Transport</Table.Head>
                  <Table.Head>Scopes</Table.Head>
                  <Table.Head>Lanes</Table.Head>
                  <Table.Head>Expires</Table.Head>
                  <Table.Head>Last used</Table.Head>
                  <Table.Head>Action</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {detail.credentials.map((credential) => (
                  <Table.Row key={credential.id}>
                    <Table.Cell>{credential.name}</Table.Cell>
                    <Table.Cell>
                      <code className="font-mono">{credential.prefix}</code>
                    </Table.Cell>
                    <Table.Cell>{credential.audience.toUpperCase()}</Table.Cell>
                    <Table.Cell>
                      <span>{credential.scopes.join(", ")}</span>
                    </Table.Cell>
                    <Table.Cell>
                      {laneNames(credential.laneIds, lanes)}
                    </Table.Cell>
                    <Table.Cell>{date(credential.expiresAt)}</Table.Cell>
                    <Table.Cell>{date(credential.lastUsedAt)}</Table.Cell>
                    <Table.Cell>
                      {credential.revokedAt ? (
                        <Chip tone="danger">revoked</Chip>
                      ) : canManage ? (
                        <CredentialActions
                          agentPrincipalId={agentId}
                          credentialId={credential.id}
                          expectedVersion={credential.version}
                          revokeAction={revokeAgentKeyAction}
                          revokeIdempotencyKey={`web:agent:credential:revoke:${randomUUID()}`}
                          rotateAction={rotateAgentKeyAction}
                          rotateIdempotencyKey={`web:agent:credential:rotate:${randomUUID()}`}
                        />
                      ) : (
                        <Chip tone="ok">active</Chip>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Issue a least-privilege one-time key, or connect this agent over OAuth."
            icon={KeyRound}
            title="No credentials issued."
          />
        )}
      </SettingsSection>
      <SettingsSection
        bleed={detail.oauthGrants.length > 0}
        headingId="agent-oauth-grants-heading"
        note="Each grant is bound to one human, client, project, audience, lane set, scope set, and expiry."
        title="Delegated OAuth grants"
      >
        {detail.oauthGrants.length ? (
          <TableScrollRegion aria-label="Delegated OAuth grants">
            <Table.Root>
              <Table.Caption>Delegated OAuth grants</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Delegated by</Table.Head>
                  <Table.Head>Client</Table.Head>
                  <Table.Head>Transport</Table.Head>
                  <Table.Head>Scopes</Table.Head>
                  <Table.Head>Lanes</Table.Head>
                  <Table.Head>Expires</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Action</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {detail.oauthGrants.map((grant) => {
                  const active =
                    grant.status === "active" &&
                    !grant.revokedAt &&
                    grant.expiresAt > new Date();
                  const canRevoke =
                    canManage || grant.userId === context.session.user.id;
                  return (
                    <Table.Row key={grant.id}>
                      <Table.Cell>
                        <span>{grant.userName ?? grant.userEmail}</span>
                      </Table.Cell>
                      <Table.Cell>
                        <span>{grant.clientName ?? grant.clientId}</span>
                      </Table.Cell>
                      <Table.Cell>{grant.audience.toUpperCase()}</Table.Cell>
                      <Table.Cell>
                        <span>{grant.scopes.join(", ")}</span>
                      </Table.Cell>
                      <Table.Cell>{laneNames(grant.laneIds, lanes)}</Table.Cell>
                      <Table.Cell>{date(grant.expiresAt)}</Table.Cell>
                      <Table.Cell>
                        <Chip tone={active ? "ok" : "danger"}>
                          {active
                            ? "active"
                            : grant.revokedAt
                              ? "revoked"
                              : "expired"}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        {active && canRevoke ? (
                          <OauthGrantActions
                            action={revokeAgentOauthGrantAction}
                            agentPrincipalId={agentId}
                            expectedVersion={grant.version}
                            grantId={grant.id}
                            idempotencyKey={`web:agent:oauth:revoke:${randomUUID()}`}
                          />
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="A person consenting through OAuth creates a grant bound to their own access."
            icon={ShieldOff}
            title="No delegated OAuth grants."
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="agent-connect-heading"
        note="Use OAuth or a least-privilege one-time key."
        title="Connect this agent"
      >
        <AgentConnectionGuide baseUrl={serverEnv.BETTER_AUTH_URL} compact />
      </SettingsSection>
      {canManage && detail.agent.status === "active" ? (
        <SettingsSection
          headingId="issue-key-heading"
          note="Choose the minimum project, lanes, transport, and scopes needed by this installation."
          title="Issue credential"
        >
          <IssueAgentKeyForm
            action={issueAgentKeyAction}
            agentPrincipalId={agentId}
            defaultProjectId={detail.agent.projectId}
            idempotencyKey={`web:agent:credential:issue:${randomUUID()}`}
            lanes={lanes}
            projects={projects}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection
        headingId="installations-heading"
        note={`${detail.installations.length} observed`}
        title="Installations"
      >
        {detail.installations.length ? (
          detail.installations.map((installation) => (
            <RecordLine
              aside={`${installation.status} · ${date(installation.lastSeenAt)}`}
              detail={
                Object.entries(installation.capabilities)
                  .filter(([, enabled]) => enabled)
                  .map(([name]) => name)
                  .join(", ") || "No declared capabilities"
              }
              key={installation.id}
              title={`${installation.softwareName} ${installation.softwareVersion}`}
            />
          ))
        ) : (
          <EmptyState
            hint="An installation appears the first time this principal authenticates."
            icon={BotOff}
            title="No installation has connected yet."
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="workspaces-heading"
        note="Safe telemetry is always visible. Private host and path data requires a reason and is audited."
        title="Machine workspaces"
      >
        {detail.workspaces.length ? (
          detail.workspaces.map((workspace) => (
            <RecordLine
              aside={`${workspace.status} · ${date(workspace.lastSeenAt)}`}
              detail={
                Object.entries(workspace.safeCapabilities)
                  .filter(([, enabled]) => enabled)
                  .map(([name]) => name)
                  .join(", ") || "No safe capabilities"
              }
              key={workspace.id}
              title={`Workspace ${workspace.id.slice(0, 8)}`}
            >
              {canManage ? (
                <RevealWorkspaceForm
                  action={revealWorkspaceTelemetryAction}
                  idempotencyKey={`web:workspace:reveal:${randomUUID()}`}
                  workspaceId={workspace.id}
                />
              ) : null}
            </RecordLine>
          ))
        ) : (
          <EmptyState
            hint="A workspace registers itself when an installation reports encrypted machine context."
            icon={MonitorOff}
            title="No machine workspace has registered yet."
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="sessions-heading"
        note="Latest 100 sessions and their most recent progress report."
        title="Work sessions"
      >
        {detail.sessions.length ? (
          detail.sessions.map((session) => (
            <RecordLine
              aside={`v${session.version} · ${date(session.updatedAt)}`}
              detail={session.latestProgress ?? "No progress report yet."}
              key={session.id}
              title={`${session.state} · request ${session.requestId.slice(0, 8)}`}
            />
          ))
        ) : (
          <EmptyState
            hint="A session appears when this agent claims a request."
            icon={BotOff}
            title="No work sessions yet."
          />
        )}
      </SettingsSection>
    </Page>
  );
}
