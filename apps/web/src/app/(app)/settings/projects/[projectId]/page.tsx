import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Link as CueLink, Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import { createProjectSettingsRepository } from "@requestport/db";
import { GitBranch, GitFork, Tags } from "lucide-react";
import { notFound } from "next/navigation";

import { Page } from "../../../../../components/page-layout.js";
import {
  DefaultLaneForm,
  DefaultRepositoryForm,
  LaneStatusForm,
  ProjectAddDialog,
  ProjectMembersTable,
  ProjectMetadataForm,
  ProjectStatusForm,
  ProjectWorkPolicyForm,
  RepositoryStatusForm,
} from "../../../../../components/project-settings.js";
import { SettingsSection } from "../../../../../components/settings-section.js";
import { getApplicationContext } from "../../../../../lib/server-application-context.js";
import { webStorage } from "../../../../../lib/server-request-port.js";
import {
  addAliasAction,
  addLaneAction,
  addRepositoryAction,
  setDefaultLaneAction,
  setDefaultRepositoryAction,
  setLaneStatusAction,
  setProjectMemberAction,
  setProjectStatusAction,
  setProjectWorkPolicyAction,
  setRepositoryStatusAction,
  updateProjectMetadataAction,
} from "./actions.js";

export default async function ProjectSettingsDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const [{ projectId }, application] = await Promise.all([
    params,
    getApplicationContext(),
  ]);
  const organization = application.currentOrganization;
  if (!organization) notFound();
  const storage = webStorage();
  const detail = await createProjectSettingsRepository(storage.db).getProject(
    application.session.user.id,
    organization.id,
    projectId,
  );
  if (!detail) notFound();
  const mutationMeta = () => ({
    expectedVersion: detail.project.version,
    idempotencyKey: randomUUID(),
  });
  // Panels of rows (ruling 259): each list's "Add" opens its form in a dialog
  // from the panel's header; the forms that edit what is there stay inline.
  return (
    <Page
      description={`${detail.project.keyPrefix} · ${detail.project.slug} · ${detail.project.status}`}
      eyebrow="Project settings"
      title={detail.project.name}
      width="wide"
    >
      <SettingsSection
        headingId="project-details"
        note="Human-readable identity and lifecycle. Stable slug and request key remain immutable."
        title="Project details"
      >
        {detail.canManage ? (
          <>
            <ProjectMetadataForm
              action={updateProjectMetadataAction}
              meta={mutationMeta()}
              project={detail.project}
            />
            <ProjectStatusForm
              action={setProjectStatusAction}
              meta={mutationMeta()}
              project={detail.project}
            />
          </>
        ) : (
          <p>Only a project maintainer can change project details.</p>
        )}
      </SettingsSection>
      <SettingsSection
        action={
          detail.canManage ? (
            <ProjectAddDialog
              action={addRepositoryAction}
              kind="repository"
              meta={mutationMeta()}
              projectId={projectId}
            />
          ) : undefined
        }
        bleed={detail.repositories.length > 0}
        headingId="project-repositories"
        note="Canonical code locations used by connected agents and legacy-import provenance."
        title="Repositories"
      >
        {detail.repositories.length ? (
          <TableScrollRegion aria-label="Project repositories">
            <Table.Root>
              <Table.Caption>Project repositories</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Repository</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Default</Table.Head>
                  <Table.Head>Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {detail.repositories.map((repository) => (
                  <Table.Row key={repository.id}>
                    <Table.Cell>
                      <Stack direction="column" gap={1}>
                        <CueLink
                          external
                          href={repository.browseUrl}
                          variant="underline"
                        >
                          {repository.repositorySlug}
                        </CueLink>
                        <code className="text-fg-subtle font-mono">
                          {repository.cloneUrl}
                        </code>
                      </Stack>
                    </Table.Cell>
                    <Table.Cell>
                      <Chip
                        tone={repository.status === "active" ? "ok" : "neutral"}
                      >
                        {repository.status}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      {repository.isDefault ? (
                        <Chip tone="ok">Default</Chip>
                      ) : (
                        "—"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {detail.canManage ? (
                        <Stack direction="column" gap={2}>
                          {!repository.isDefault &&
                          repository.status === "active" ? (
                            <DefaultRepositoryForm
                              action={setDefaultRepositoryAction}
                              meta={mutationMeta()}
                              projectId={projectId}
                              repositoryId={repository.id}
                            />
                          ) : null}
                          <RepositoryStatusForm
                            action={setRepositoryStatusAction}
                            meta={mutationMeta()}
                            projectId={projectId}
                            repository={repository}
                          />
                        </Stack>
                      ) : (
                        "—"
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Add at least one canonical GitHub repository."
            icon={GitFork}
            title="No repositories"
          />
        )}
      </SettingsSection>
      <SettingsSection
        action={
          detail.canManage ? (
            <ProjectAddDialog
              action={addAliasAction}
              kind="alias"
              meta={mutationMeta()}
              projectId={projectId}
            />
          ) : undefined
        }
        headingId="project-aliases"
        note="Historical names accepted during routing and legacy import."
        title="Aliases"
      >
        {detail.aliases.length ? (
          detail.aliases.map((alias) => (
            <Stack
              align="baseline"
              direction="row"
              gap={3}
              justify="between"
              key={alias.id}
              wrap
            >
              <Stack direction="column" gap={1}>
                <span className="break-all">{alias.alias}</span>
                <span className="text-fg-subtle">{alias.source}</span>
              </Stack>
              <time
                className="text-fg-subtle"
                dateTime={alias.createdAt.toISOString()}
              >
                {alias.createdAt.toISOString().slice(0, 10)}
              </time>
            </Stack>
          ))
        ) : (
          <EmptyState
            hint="An alias lets agents resolve a historical or local project name."
            icon={Tags}
            title="No aliases registered"
          />
        )}
      </SettingsSection>
      <SettingsSection
        action={
          detail.canManage ? (
            <ProjectAddDialog
              action={addLaneAction}
              kind="lane"
              meta={mutationMeta()}
              projectId={projectId}
            />
          ) : undefined
        }
        bleed={detail.lanes.length > 0}
        headingId="project-lanes"
        note="Optional work streams used for routing and request defaults."
        title="Lanes"
      >
        {detail.lanes.length ? (
          <TableScrollRegion aria-label="Project lanes">
            <Table.Root>
              <Table.Caption>Project lanes</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Lane</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Default</Table.Head>
                  <Table.Head>Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {detail.lanes.map((lane) => {
                  const isDefault = detail.project.defaultLaneId === lane.id;
                  return (
                    <Table.Row key={lane.id}>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <span>{lane.name}</span>
                          <span className="text-fg-subtle">{lane.slug}</span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip
                          tone={lane.status === "active" ? "ok" : "neutral"}
                        >
                          {lane.status}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        {isDefault ? <Chip tone="ok">Default</Chip> : "—"}
                      </Table.Cell>
                      <Table.Cell>
                        {detail.canManage ? (
                          <Stack direction="column" gap={2}>
                            {!isDefault && lane.status === "active" ? (
                              <DefaultLaneForm
                                action={setDefaultLaneAction}
                                laneId={lane.id}
                                meta={mutationMeta()}
                                projectId={projectId}
                              />
                            ) : null}
                            <LaneStatusForm
                              action={setLaneStatusAction}
                              isDefault={isDefault}
                              lane={lane}
                              meta={mutationMeta()}
                              projectId={projectId}
                            />
                          </Stack>
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
            hint="A lane is an optional work stream inside this project."
            icon={GitBranch}
            title="No lanes registered"
          />
        )}
      </SettingsSection>
      <SettingsSection
        action={
          detail.canManage ? (
            <ProjectAddDialog
              action={setProjectMemberAction}
              kind="member"
              members={detail.availableMembers}
              meta={mutationMeta()}
              projectId={projectId}
            />
          ) : undefined
        }
        headingId="project-members"
        note="Maintainers manage lifecycle; contributors work requests; viewers observe."
        title="Project access"
      >
        {detail.members.length ? (
          <ProjectMembersTable
            action={setProjectMemberAction}
            members={detail.members}
            metas={Object.fromEntries(
              detail.members.map((member) => [member.id, mutationMeta()]),
            )}
            projectId={projectId}
          />
        ) : (
          <p>
            No explicit project roles. Organization owners and admins retain
            administration access.
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        headingId="project-work-policy"
        note="Server-owned lease timing and encrypted context requirements. Agents cannot widen these values."
        title="Agent work policy"
      >
        {detail.canManage ? (
          <ProjectWorkPolicyForm
            action={setProjectWorkPolicyAction}
            meta={mutationMeta()}
            policy={detail.project}
            projectId={projectId}
          />
        ) : (
          <p>Only a project maintainer can change work policy.</p>
        )}
      </SettingsSection>
    </Page>
  );
}
