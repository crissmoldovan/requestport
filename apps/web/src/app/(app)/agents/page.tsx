import { randomUUID } from "node:crypto";

import { EmptyState, Panel } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Link as CueLink, Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { serverEnv } from "@requestport/config/server";
import {
  createAgentManagementRepository,
  createFoundationQueryRepository,
  createOverviewQueryRepository,
  createProjectSettingsRepository,
} from "@requestport/db";
import { BotOff } from "lucide-react";
import Link from "next/link";

import {
  AgentEndpoints,
  agentEndpoints,
} from "../../../components/agent-connection-guide.js";
import { ConnectAgentSheet } from "../../../components/agent-management.js";
import { Page } from "../../../components/page-layout.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";
import { createAgentAction, issueAgentKeyAction } from "./actions.js";

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "12 minutes ago", "1 hour ago", "3 days ago": the age of a moment. */
function ago(moment: Date, now: Date) {
  const minutes = Math.round((now.getTime() - moment.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 45) return relativeTime.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 22) return relativeTime.format(-hours, "hour");
  return relativeTime.format(-Math.max(1, Math.round(hours / 24)), "day");
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

type Connection = {
  activeGrantCount: number;
  activeKeyCount: number;
  lastSignedInAt: Date | null;
  workingSessionCount: number;
  openAssignedCount: number;
};

/**
 * A principal's state in words and a tone, from what the data holds: its
 * lifecycle, and how many sessions it is working in now — claimed or active,
 * with a lease that has not run out (`listAgentConnections`); a paused,
 * blocked or stale session is not work under way. When it last signed in is
 * the sign-in column's, and no chip claims "online".
 */
function agentState(
  agent: { status: string },
  connection: Connection | undefined,
): {
  label: string;
  tone: "busy" | "danger" | "ok" | "warn";
} {
  if (agent.status === "revoked") return { label: "Revoked", tone: "danger" };
  if (agent.status === "suspended") return { label: "Suspended", tone: "warn" };
  const working = connection?.workingSessionCount ?? 0;
  if (working > 0) {
    return {
      label: `Working · ${plural(working, "session", "sessions")}`,
      tone: "busy",
    };
  }
  return { label: "Active", tone: "ok" };
}

/**
 * How an agent signs in, from the keys and grants that authorize it now, and
 * when it last did, by either (ruling 261). The read counts no key or grant
 * for a suspended or revoked agent, and none once its keys have expired or
 * been revoked, so "No active sign-in" says only that nothing signs it in now.
 * When it last signed in is history and is shown whatever its state: the
 * newest use stamped on any of its keys or grants, at most five minutes
 * behind (`agentLastUseStampSeconds`). With no stamp the line says none was
 * recorded rather than that it never signed in: nothing stamped an OAuth
 * sign-in before migration 0027.
 */
function signsInWith(connection: Connection | undefined, now: Date) {
  const grants = connection?.activeGrantCount ?? 0;
  const keys = connection?.activeKeyCount ?? 0;
  const lastSignedIn = connection?.lastSignedInAt
    ? `Last signed in ${ago(connection.lastSignedInAt, now)}`
    : "No sign-in recorded";
  if (!grants && !keys) {
    return { method: "No active sign-in", detail: null, lastSignedIn };
  }
  const keyDetail = keys ? plural(keys, "active key", "active keys") : null;
  const grantDetail = grants
    ? plural(grants, "active grant", "active grants")
    : null;
  return {
    method: grants && keys ? "OAuth and API key" : grants ? "OAuth" : "API key",
    detail: [grantDetail, keyDetail].filter(Boolean).join(" · "),
    lastSignedIn,
  };
}

export default async function AgentsPage() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) return null;
  const storage = webStorage();
  const userId = context.session.user.id;
  const [agents, projects, lanes, connections] = await Promise.all([
    createAgentManagementRepository(storage.db).listAgents(
      userId,
      organization.id,
    ),
    createProjectSettingsRepository(storage.db).listManageableProjects(
      userId,
      organization.id,
    ),
    createFoundationQueryRepository(storage.db).listOrganizationLanes(
      userId,
      organization.id,
    ),
    createOverviewQueryRepository(storage.db).listAgentConnections(
      userId,
      organization.id,
    ),
  ]);
  const canManageOrganization =
    organization.role === "owner" || organization.role === "admin";
  const canManage = canManageOrganization || projects.length > 0;
  const endpoints = agentEndpoints(serverEnv.BETTER_AUTH_URL);
  const connectionOf = new Map(
    connections.map((connection) => [connection.agentPrincipalId, connection]),
  );
  const now = new Date();
  return (
    <Page
      action={
        canManage ? (
          <ConnectAgentSheet
            agents={agents.map((agent) => ({
              displayName: agent.displayName,
              id: agent.id,
              projectId: agent.projectId,
              slug: agent.slug,
            }))}
            allowOrganizationWide={canManageOrganization}
            createAction={createAgentAction}
            createIdempotencyKey={`web:agent:create:${randomUUID()}`}
            endpoints={endpoints}
            issueAction={issueAgentKeyAction}
            issueIdempotencyKey={`web:agent:credential:issue:${randomUUID()}`}
            lanes={lanes}
            projects={projects}
          />
        ) : undefined
      }
      description="Coding agents and scripts that file, answer and work on requests here."
      eyebrow="Automation"
      title="Agents"
      width="wide"
    >
      <Panel>
        {agents.length ? (
          <TableScrollRegion aria-label="Registered agents">
            <Table.Root>
              <Table.Caption>Registered agents</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Agent</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Signs in with</Table.Head>
                  <Table.Head>Default project</Table.Head>
                  <Table.Head numeric>Open, assigned</Table.Head>
                  <Table.Head>
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {agents.map((agent) => {
                  const connection = connectionOf.get(agent.id);
                  const state = agentState(agent, connection);
                  const signIn = signsInWith(connection, now);
                  return (
                    <Table.Row key={agent.id}>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <CueLink
                            render={<Link href={`/agents/${agent.id}`} />}
                            variant="underline"
                          >
                            {agent.displayName}
                          </CueLink>
                          <span className="text-fg-subtle">
                            {agent.softwareName ?? agent.slug}
                          </span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip tone={state.tone}>{state.label}</Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <span>{signIn.method}</span>
                          {signIn.detail ? (
                            <span className="text-fg-subtle">
                              {signIn.detail}
                            </span>
                          ) : null}
                          <span className="text-fg-subtle">
                            {signIn.lastSignedIn}
                          </span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        {agent.projectName ?? "Organization-wide"}
                      </Table.Cell>
                      <Table.Cell numeric>
                        {connection?.openAssignedCount ?? 0}
                      </Table.Cell>
                      <Table.Cell>
                        <Button
                          aria-label={`Manage ${agent.displayName}`}
                          render={<Link href={`/agents/${agent.id}`} />}
                          size="sm"
                          variant="secondary"
                        >
                          Manage
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Connect a coding agent or a script, then let it sign in through OAuth or a one-time API key."
            icon={BotOff}
            title="No agents registered"
          />
        )}
      </Panel>
      <AgentEndpoints endpoints={endpoints} />
    </Page>
  );
}
