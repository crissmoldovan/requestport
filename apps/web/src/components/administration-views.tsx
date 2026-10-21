import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import {
  Link as CueLink,
  DescriptionList,
  Stack,
} from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import type {
  OrganizationAccess,
  OrganizationMember,
  OrganizationProject,
  PendingInvitation,
} from "@requestport/domain";
import { FolderPlus, MailX } from "lucide-react";
import Link from "next/link";

import type { MemberActionState } from "../app/(app)/settings/members/action-state.js";
import type { FormAction } from "./administration-forms.js";
import {
  InvitationForm,
  OrganizationForm,
  ProjectForm,
} from "./administration-forms.js";
import {
  MemberManagementForm,
  RevokeInvitationForm,
} from "./member-management.js";
import { Page } from "./page-layout.js";
import { SettingsSection } from "./settings-section.js";

/**
 * The organization administration surfaces, on native CUE++ composition.
 *
 * Two choices are worth naming. Tables live inside the named, keyboard-focusable
 * `TableScrollRegion` — §4.3's contract for tabular data — so an unbroken email
 * address or repository slug scrolls its own columns rather than the console.
 * And `StatusDot` is absent throughout: its shipped vocabulary is
 * `ok | busy | warn | danger | idle`, and an organization role or a project
 * lifecycle is none of those, so §6.2 sends every one of them to `Chip`.
 */

type MemberAction = (
  state: MemberActionState,
  formData: FormData,
) => Promise<MemberActionState>;

function ProjectTable({ projects }: { projects: OrganizationProject[] }) {
  return (
    <TableScrollRegion aria-label="Registered projects">
      <Table.Root>
        <Table.Caption>Registered projects</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Key</Table.Head>
            <Table.Head>Project</Table.Head>
            <Table.Head>Repository</Table.Head>
            <Table.Head>Status</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {projects.map((project) => (
            <Table.Row key={project.id}>
              <Table.Cell>
                <span className="font-mono">{project.keyPrefix}</span>
              </Table.Cell>
              <Table.Cell>
                <Stack direction="column" gap={1}>
                  <CueLink
                    render={<Link href={`/settings/projects/${project.id}`} />}
                    variant="underline"
                  >
                    {project.name}
                  </CueLink>
                  <span className="text-fg-subtle">{project.slug}</span>
                </Stack>
              </Table.Cell>
              <Table.Cell>
                {project.defaultRepository ? (
                  <CueLink
                    external
                    href={project.defaultRepository.browseUrl}
                    variant="underline"
                  >
                    {project.defaultRepository.repositorySlug}
                  </CueLink>
                ) : (
                  <span className="text-fg-subtle">Not connected</span>
                )}
              </Table.Cell>
              <Table.Cell>
                <Chip tone={project.status === "active" ? "ok" : "neutral"}>
                  {project.status === "active" ? "Active" : "Archived"}
                </Chip>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </TableScrollRegion>
  );
}

function CreateProjectButton({ label }: { label: string }) {
  return (
    <Button
      render={<Link href="/settings/projects/new" />}
      size="sm"
      variant="primary"
    >
      {label}
    </Button>
  );
}

export function NoOrganizationSetup() {
  return (
    <Page
      description="Organizations are the tenant and authorization boundary for projects, requests, members, and agents."
      eyebrow="Workspace setup"
      title="Create your first organization"
      width="form"
    >
      <SettingsSection
        headingId="setup-organization"
        title="Organization identity"
      >
        <OrganizationForm />
      </SettingsSection>
    </Page>
  );
}

export function OverviewView({
  members,
  organization,
  projects,
}: {
  members: OrganizationMember[];
  organization: OrganizationAccess;
  projects: OrganizationProject[];
}) {
  return (
    <Page
      description={`${members.length} active ${members.length === 1 ? "member" : "members"} · ${projects.length} registered ${projects.length === 1 ? "project" : "projects"}`}
      eyebrow={organization.slug}
      title="Overview"
    >
      <SettingsSection
        action={
          <Button
            render={<Link href="/settings/projects" />}
            size="sm"
            variant="ghost"
          >
            Manage projects
          </Button>
        }
        bleed={projects.length > 0}
        headingId="overview-projects"
        note="Canonical targets available inside this organization."
        title="Projects"
      >
        {projects.length > 0 ? (
          <ProjectTable projects={projects} />
        ) : (
          <EmptyState
            action={
              organization.role === "member" ? null : (
                <CreateProjectButton label="Create project" />
              )
            }
            hint="Register the first project before requests and agents arrive."
            icon={FolderPlus}
            title="No projects registered"
          />
        )}
      </SettingsSection>
      <SettingsSection
        headingId="workflow-heading"
        title="Request workflow is live"
      >
        <p>
          Create and triage requests, answer human questions, follow agent
          sessions, configure event delivery, and migrate legacy handoffs.
        </p>
        <Stack direction="row" gap={3} wrap>
          <Button render={<Link href="/requests" />} size="sm" variant="ghost">
            Open requests
          </Button>
          <Button render={<Link href="/activity" />} size="sm" variant="ghost">
            View activity
          </Button>
        </Stack>
      </SettingsSection>
    </Page>
  );
}

export function OrganizationView({
  organization,
}: {
  organization: OrganizationAccess;
}) {
  return (
    <Page
      description="Canonical tenant identity and your effective membership."
      eyebrow="Settings"
      title="Organization"
    >
      <SettingsSection headingId="organization-identity" title="Identity">
        <DescriptionList.Root>
          <DescriptionList.Term>Name</DescriptionList.Term>
          <DescriptionList.Detail>{organization.name}</DescriptionList.Detail>
          <DescriptionList.Term>Slug</DescriptionList.Term>
          <DescriptionList.Detail className="break-all">
            {organization.slug}
          </DescriptionList.Detail>
          <DescriptionList.Term>Your role</DescriptionList.Term>
          <DescriptionList.Detail>
            <Chip tone="neutral">{organization.role}</Chip>
          </DescriptionList.Detail>
          <DescriptionList.Term>Status</DescriptionList.Term>
          <DescriptionList.Detail>
            <Chip tone="ok">Active</Chip>
          </DescriptionList.Detail>
        </DescriptionList.Root>
      </SettingsSection>
    </Page>
  );
}

export function ProjectsView({
  organization,
  projects,
}: {
  organization: OrganizationAccess;
  projects: OrganizationProject[];
}) {
  const canCreate = organization.role !== "member";
  return (
    <Page
      action={
        canCreate ? <CreateProjectButton label="Create project" /> : undefined
      }
      description="Project identities and their optional canonical GitHub repositories."
      eyebrow="Settings"
      title="Projects"
    >
      <SettingsSection
        bleed={projects.length > 0}
        headingId="projects-registered"
        note={`${projects.length} registered`}
        title="Registered projects"
      >
        {projects.length > 0 ? (
          <ProjectTable projects={projects} />
        ) : (
          <EmptyState
            action={
              canCreate ? <CreateProjectButton label="Create project" /> : null
            }
            hint={
              canCreate
                ? "Register a project and its canonical repository."
                : "An organization owner or admin can register the first project."
            }
            icon={FolderPlus}
            title="No projects registered"
          />
        )}
      </SettingsSection>
    </Page>
  );
}

export function ProjectCreationView({
  action,
  organization,
}: {
  action: FormAction;
  organization: OrganizationAccess;
}) {
  return (
    <Page
      description={`Register a canonical target inside ${organization.name}.`}
      eyebrow="Projects"
      title="Create project"
      width="form"
    >
      <SettingsSection headingId="project-identity" title="Project identity">
        {organization.role === "member" ? (
          <EmptyState
            hint="Only an organization owner or admin can create projects."
            title="Administration access required"
          />
        ) : (
          <ProjectForm action={action} />
        )}
      </SettingsSection>
    </Page>
  );
}

export function MembersView({
  currentUserId,
  invitationAction,
  invitationIdempotencyKeys,
  invitations,
  members,
  memberAction,
  memberIdempotencyKeys,
  organization,
  revokeInvitationAction,
}: {
  currentUserId: string;
  invitationAction?: FormAction;
  invitationIdempotencyKeys?: Record<string, string>;
  invitations: PendingInvitation[];
  members: OrganizationMember[];
  memberAction?: MemberAction;
  memberIdempotencyKeys?: Record<string, string>;
  organization: OrganizationAccess;
  revokeInvitationAction?: MemberAction;
}) {
  const canInvite =
    organization.role === "owner" || organization.role === "admin";
  return (
    <Page
      description="Active human access and pending invitations for this organization."
      eyebrow="Settings"
      title="Members"
    >
      <SettingsSection
        bleed
        headingId="active-members"
        note={`${members.length} total`}
        title="Active members"
      >
        <TableScrollRegion aria-label="Active organization members">
          <Table.Root>
            <Table.Caption>Active organization members</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Person</Table.Head>
                <Table.Head>Email</Table.Head>
                <Table.Head>Role</Table.Head>
                <Table.Head>Status</Table.Head>
                {canInvite ? <Table.Head>Access</Table.Head> : null}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {members.map((member) => (
                <Table.Row key={member.userId}>
                  <Table.Cell>{member.name}</Table.Cell>
                  <Table.Cell>
                    <span>{member.email}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <Chip tone="neutral">{member.role}</Chip>
                  </Table.Cell>
                  <Table.Cell>
                    <Chip tone="ok">Active</Chip>
                  </Table.Cell>
                  {canInvite ? (
                    <Table.Cell>
                      {memberAction &&
                      memberIdempotencyKeys?.[member.userId] ? (
                        <MemberManagementForm
                          action={memberAction}
                          actorRole={organization.role as "owner" | "admin"}
                          currentUserId={currentUserId}
                          idempotencyKey={memberIdempotencyKeys[member.userId]}
                          member={member}
                        />
                      ) : (
                        "—"
                      )}
                    </Table.Cell>
                  ) : null}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </TableScrollRegion>
      </SettingsSection>
      {canInvite ? (
        <>
          <SettingsSection
            bleed={invitations.length > 0}
            headingId="pending-invitations"
            note={`${invitations.length} awaiting acceptance`}
            title="Pending invitations"
          >
            {invitations.length > 0 ? (
              <TableScrollRegion aria-label="Pending organization invitations">
                <Table.Root>
                  <Table.Caption>
                    Pending organization invitations
                  </Table.Caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Email</Table.Head>
                      <Table.Head>Role</Table.Head>
                      <Table.Head>Expires</Table.Head>
                      <Table.Head>Action</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {invitations.map((invitation) => (
                      <Table.Row key={invitation.id}>
                        <Table.Cell>
                          <span>{invitation.email}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip tone="neutral">{invitation.role}</Chip>
                        </Table.Cell>
                        <Table.Cell>
                          <time dateTime={invitation.expiresAt.toISOString()}>
                            {invitation.expiresAt.toISOString().slice(0, 10)}
                          </time>
                        </Table.Cell>
                        <Table.Cell>
                          {revokeInvitationAction &&
                          invitationIdempotencyKeys?.[invitation.id] ? (
                            <RevokeInvitationForm
                              action={revokeInvitationAction}
                              idempotencyKey={
                                invitationIdempotencyKeys[invitation.id]
                              }
                              invitation={invitation}
                            />
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
                hint="Invite someone below to give them access to this organization."
                icon={MailX}
                title="No pending invitations"
              />
            )}
          </SettingsSection>
          {invitationAction ? (
            <SettingsSection headingId="invite-member" title="Invite member">
              <InvitationForm
                action={invitationAction}
                canInviteOwner={organization.role === "owner"}
              />
            </SettingsSection>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
