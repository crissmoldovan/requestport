import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import {
  createAgentManagementRepository,
  createFoundationQueryRepository,
  createRoutingRepository,
} from "@requestport/db";
import { Route } from "lucide-react";
import { notFound, redirect } from "next/navigation";

import { Page } from "../../../../components/page-layout.js";
import {
  CreateRoutingRuleForm,
  DisableRoutingRuleForm,
  RoutingTester,
  UpdateRoutingRuleForm,
} from "../../../../components/routing-policy.js";
import { SettingsSection } from "../../../../components/settings-section.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";

export default async function RoutingSettingsPage() {
  const context = await getApplicationContext();
  if (!context.currentOrganization) redirect("/");
  const storage = webStorage();
  const foundationQueries = createFoundationQueryRepository(storage.db);
  const [projects, lanes, agents, rules] = await Promise.all([
    foundationQueries.listOrganizationProjects(
      context.session.user.id,
      context.currentOrganization.id,
    ),
    foundationQueries.listOrganizationLanes(
      context.session.user.id,
      context.currentOrganization.id,
    ),
    createAgentManagementRepository(storage.db).listAgents(
      context.session.user.id,
      context.currentOrganization.id,
    ),
    createRoutingRepository(storage.db).listRulesForManager(
      context.session.user.id,
      context.currentOrganization.id,
    ),
  ]);
  if (!rules) notFound();
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  return (
    <Page
      description="Explicit project-to-project and human-direct request policy. The most specific matching rule wins; equal specificity denies."
      eyebrow="Organization"
      title="Routing policy"
      width="wide"
    >
      <SettingsSection
        headingId="route-test-heading"
        note="Evaluate the current policy without creating a request."
        title="Route tester"
      >
        <RoutingTester agents={agents} lanes={lanes} projects={projects} />
      </SettingsSection>
      <SettingsSection
        bleed={rules.length > 0}
        headingId="routing-rules-heading"
        note={`${rules.length} configured · same-organization routes default to allow when no rule matches.`}
        title="Rules"
      >
        {rules.length > 0 ? (
          <TableScrollRegion aria-label="Routing rules">
            <Table.Root>
              <Table.Caption>Routing rules</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Source</Table.Head>
                  <Table.Head>Target</Table.Head>
                  <Table.Head>Decision</Table.Head>
                  <Table.Head>Constraints</Table.Head>
                  <Table.Head numeric>Specificity</Table.Head>
                  <Table.Head numeric>Version</Table.Head>
                  <Table.Head>Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rules.map((rule) => (
                  <Table.Row key={rule.id}>
                    <Table.Cell>
                      {rule.sourceProjectId
                        ? (projectNames.get(rule.sourceProjectId) ??
                          "Unknown project")
                        : "Human direct"}
                    </Table.Cell>
                    <Table.Cell>
                      {projectNames.get(rule.targetProjectId) ??
                        "Unknown project"}
                    </Table.Cell>
                    <Table.Cell>
                      <Chip tone={rule.decision === "allow" ? "ok" : "danger"}>
                        {rule.decision}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <span>
                        {[
                          ...rule.requestTypes,
                          ...rule.priorities,
                          ...rule.humanRoles,
                          ...rule.laneIds.map((id) => `lane:${id.slice(0, 8)}`),
                          ...rule.agentPrincipalIds.map(
                            (id) => `agent:${id.slice(0, 8)}`,
                          ),
                        ].join(", ") || "All"}
                      </span>
                    </Table.Cell>
                    <Table.Cell numeric>{rule.specificity}</Table.Cell>
                    <Table.Cell numeric>v{rule.version}</Table.Cell>
                    <Table.Cell>
                      <Stack direction="column" gap={2}>
                        <UpdateRoutingRuleForm
                          agents={agents}
                          idempotencyKey={`web:routing:update:${randomUUID()}`}
                          lanes={lanes}
                          projects={projects}
                          rule={rule}
                        />
                        <DisableRoutingRuleForm
                          idempotencyKey={`web:routing:disable:${randomUUID()}`}
                          rule={rule}
                        />
                      </Stack>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Same-organization project and human-direct requests currently use the default allow behavior."
            icon={Route}
            title="No explicit rules"
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="routing-create-heading"
        note="Use deny rules for hard boundaries and allow rules for explicit exceptions."
        title="Add rule"
      >
        <CreateRoutingRuleForm
          agents={agents}
          idempotencyKey={`web:routing:create:${randomUUID()}`}
          lanes={lanes}
          projects={projects}
        />
      </SettingsSection>
    </Page>
  );
}
