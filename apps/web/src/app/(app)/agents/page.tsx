import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Link as CueLink, Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import { serverEnv } from "@requestport/config/server";
import {
  createAgentManagementRepository,
  createProjectSettingsRepository,
} from "@requestport/db";
import { BotOff } from "lucide-react";
import Link from "next/link";

import { AgentConnectionGuide } from "../../../components/agent-connection-guide.js";
import { CreateAgentForm } from "../../../components/agent-management.js";
import { Page } from "../../../components/page-layout.js";
import { SettingsSection } from "../../../components/settings-section.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";
import { createAgentAction } from "./actions.js";

export default async function AgentsPage() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) return null;
  const storage = webStorage();
  const [agents, projects] = await Promise.all([
    createAgentManagementRepository(storage.db).listAgents(
      context.session.user.id,
      organization.id,
    ),
    createProjectSettingsRepository(storage.db).listManageableProjects(
      context.session.user.id,
      organization.id,
    ),
  ]);
  const canManageOrganization =
    organization.role === "owner" || organization.role === "admin";
  const canManage = canManageOrganization || projects.length > 0;
  return (
    <Page
      description="Identities, installations, credentials, work sessions, and encrypted machine workspaces."
      eyebrow="Automation"
      title="Agents"
      width="wide"
    >
      <SettingsSection
        bleed={agents.length > 0}
        headingId="agents-heading"
        note={`${agents.length} principal${agents.length === 1 ? "" : "s"}`}
        title="Registered agents"
      >
        {agents.length ? (
          <TableScrollRegion aria-label="Registered agents">
            <Table.Root>
              <Table.Caption>Registered agent principals</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Agent</Table.Head>
                  <Table.Head>Project</Table.Head>
                  <Table.Head>Software</Table.Head>
                  <Table.Head numeric>Installations</Table.Head>
                  <Table.Head numeric>Active work</Table.Head>
                  <Table.Head>Status</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {agents.map((agent) => (
                  <Table.Row key={agent.id}>
                    <Table.Cell>
                      <Stack direction="column" gap={1}>
                        <CueLink
                          render={<Link href={`/agents/${agent.id}`} />}
                          variant="underline"
                        >
                          {agent.displayName}
                        </CueLink>
                        <span className="text-fg-subtle">{agent.slug}</span>
                      </Stack>
                    </Table.Cell>
                    <Table.Cell>
                      {agent.projectName ?? "Organization-wide"}
                    </Table.Cell>
                    <Table.Cell>{agent.softwareName ?? "—"}</Table.Cell>
                    <Table.Cell numeric>{agent.installationCount}</Table.Cell>
                    <Table.Cell numeric>{agent.activeSessionCount}</Table.Cell>
                    <Table.Cell>
                      <Chip tone={agent.status === "active" ? "ok" : "danger"}>
                        {agent.status}
                      </Chip>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Create a stable principal, then connect it through OAuth or a one-time API key."
            icon={BotOff}
            title="No agents registered"
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="connect-agent-heading"
        note="Environment-specific endpoints for this RequestPort deployment."
        title="Connection reference"
      >
        <AgentConnectionGuide baseUrl={serverEnv.BETTER_AUTH_URL} compact />
      </SettingsSection>
      {canManage ? (
        <SettingsSection
          headingId="create-agent-heading"
          note="A principal is durable; installations and credentials rotate independently."
          title="Create agent principal"
        >
          <CreateAgentForm
            action={createAgentAction}
            allowOrganizationWide={canManageOrganization}
            idempotencyKey={`web:agent:create:${randomUUID()}`}
            projects={projects}
          />
        </SettingsSection>
      ) : null}
    </Page>
  );
}
