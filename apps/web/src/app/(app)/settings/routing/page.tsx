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
  AddRoutingRuleDialog,
  DisableRoutingRuleForm,
  EditRoutingRuleDialog,
  RoutingTester,
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
  const projectName = (id: string | null | undefined) =>
    id ? (projectNames.get(id) ?? "Unknown project") : "Human direct";
  // The page is a header and panels of rows (ruling 259): the rules first,
  // then the tester in a panel of its own; adding a rule opens from the
  // header's action and editing one from its row, each in a dialog.
  return (
    <Page
      action={
        <AddRoutingRuleDialog
          agents={agents}
          idempotencyKey={`web:routing:create:${randomUUID()}`}
          lanes={lanes}
          projects={projects}
        />
      }
      description="Which project may send requests to which. The most specific matching rule wins; equal specificity denies."
      eyebrow="Organization"
      title="Routing policy"
      width="wide"
    >
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
                  <Table.Head>
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rules.map((rule) => {
                  const source = projectName(rule.sourceProjectId);
                  const target = projectName(rule.targetProjectId);
                  return (
                    <Table.Row key={rule.id}>
                      <Table.Cell>{source}</Table.Cell>
                      <Table.Cell>{target}</Table.Cell>
                      <Table.Cell>
                        <Chip
                          tone={rule.decision === "allow" ? "ok" : "danger"}
                        >
                          {rule.decision}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <span>
                          {[
                            ...rule.requestTypes,
                            ...rule.priorities,
                            ...rule.humanRoles,
                            ...rule.laneIds.map(
                              (id) => `lane:${id.slice(0, 8)}`,
                            ),
                            ...rule.agentPrincipalIds.map(
                              (id) => `agent:${id.slice(0, 8)}`,
                            ),
                          ].join(", ") || "All"}
                        </span>
                      </Table.Cell>
                      <Table.Cell numeric>{rule.specificity}</Table.Cell>
                      <Table.Cell>
                        <Stack
                          align="center"
                          direction="row"
                          gap={2}
                          justify="end"
                          wrap
                        >
                          <EditRoutingRuleDialog
                            agents={agents}
                            idempotencyKey={`web:routing:update:${randomUUID()}`}
                            label={`${source} to ${target}`}
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
                  );
                })}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Same-organization project and human-direct requests currently use the default allow behavior. Use Add rule to set a boundary."
            icon={Route}
            title="No explicit rules"
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="route-test-heading"
        note="Evaluate the current policy without creating a request."
        title="Route tester"
      >
        <RoutingTester agents={agents} lanes={lanes} projects={projects} />
      </SettingsSection>
    </Page>
  );
}
