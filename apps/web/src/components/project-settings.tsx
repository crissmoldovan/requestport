"use client";

import {
  Checkbox,
  CheckboxGroup,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  Textarea,
} from "@cueplusplus/ui/forms";
import {
  Table,
  TableScrollRegion,
  TwoStepButton,
} from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { privateTelemetryFields } from "@requestport/domain/browser";
import { type ReactNode, useActionState, useRef } from "react";

import type { ProjectSettingsActionState } from "../app/(app)/settings/projects/[projectId]/action-state.js";
import { initialProjectSettingsActionState } from "../app/(app)/settings/projects/[projectId]/action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";

/**
 * Project settings, on native CUE++ controls.
 *
 * Every visible control belongs to one `Field` with a visible label, the
 * encrypted-context choice set is one named `CheckboxGroup` rather than one
 * field per box, and the only destructive control — revoking a person's project
 * access — arms in place because the role can simply be granted again.
 *
 * Archiving is deliberately *not* treated as destructive: it is one half of a
 * toggle whose other half is on the same control, so a confirmation step there
 * would ask about something the next press undoes.
 */

type Action = (
  state: ProjectSettingsActionState,
  data: FormData,
) => Promise<ProjectSettingsActionState>;
type MutationMeta = { expectedVersion: number; idempotencyKey: string };

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: ProjectSettingsActionState;
}) {
  const failure = actionBannerMessage(state, fields);
  if (failure) {
    return (
      <div role="alert">
        <Stack align="center" direction="row" gap={2} wrap>
          <Chip tone="danger">Error</Chip>
          <span>{failure}</span>
        </Stack>
      </div>
    );
  }
  if (state.status !== "success" || !state.message) return null;

  return (
    <div role="status">
      <Stack align="center" direction="row" gap={2} wrap>
        <Chip tone="ok">Done</Chip>
        <span>{state.message}</span>
      </Stack>
    </div>
  );
}

function MutationMetaInputs({ meta }: { meta: MutationMeta }) {
  return (
    <>
      <input
        name="expectedVersion"
        type="hidden"
        value={meta.expectedVersion}
      />
      <input name="idempotencyKey" type="hidden" value={meta.idempotencyKey} />
    </>
  );
}

function CompactForm({
  action,
  children,
  fields,
  meta,
  projectId,
  submit,
}: {
  action: Action;
  children: ReactNode | ((state: ProjectSettingsActionState) => ReactNode);
  fields: readonly string[];
  meta: MutationMeta;
  projectId: string;
  submit: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialProjectSettingsActionState,
  );
  return (
    <form action={formAction}>
      <Stack direction="column" gap={4}>
        <input name="projectId" type="hidden" value={projectId} />
        <MutationMetaInputs meta={meta} />
        {typeof children === "function" ? children(state) : children}
        <Status fields={fields} state={state} />
        <Button disabled={pending} size="sm" type="submit" variant="secondary">
          {pending ? "Saving…" : submit}
        </Button>
      </Stack>
    </form>
  );
}

/** One control-and-answer form whose only input is hidden command metadata. */
function CommandForm({
  action,
  children,
  disabled = false,
  label,
  pendingLabel,
}: {
  action: Action;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialProjectSettingsActionState,
  );
  return (
    <form action={formAction}>
      <Stack align="center" direction="row" gap={2} wrap>
        {children}
        <Button
          disabled={pending || disabled}
          size="sm"
          type="submit"
          variant="secondary"
        >
          {pending ? pendingLabel : label}
        </Button>
        <Status state={state} />
      </Stack>
    </form>
  );
}

export function AliasForm({
  action,
  meta,
  projectId,
}: {
  action: Action;
  meta: MutationMeta;
  projectId: string;
}) {
  return (
    <CompactForm
      action={action}
      fields={["alias"]}
      meta={meta}
      projectId={projectId}
      submit="Add alias"
    >
      {(state) => (
        <Field name="alias">
          <FieldLabel>Alias</FieldLabel>
          <Input maxLength={100} name="alias" required size="sm" />
          <FieldDescription>
            A historical or local name agents can resolve.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "alias")} />
        </Field>
      )}
    </CompactForm>
  );
}

export function RepositoryForm({
  action,
  meta,
  projectId,
}: {
  action: Action;
  meta: MutationMeta;
  projectId: string;
}) {
  return (
    <CompactForm
      action={action}
      fields={["repositoryUrl"]}
      meta={meta}
      projectId={projectId}
      submit="Add repository"
    >
      {(state) => (
        <Field name="repositoryUrl">
          <FieldLabel>GitHub repository</FieldLabel>
          <Input
            name="repositoryUrl"
            placeholder="https://github.com/owner/repository"
            required
            size="sm"
            type="url"
          />
          <FieldDescription>
            Canonical https://github.com/owner/repository URL.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "repositoryUrl")} />
        </Field>
      )}
    </CompactForm>
  );
}

export function LaneForm({
  action,
  meta,
  projectId,
}: {
  action: Action;
  meta: MutationMeta;
  projectId: string;
}) {
  return (
    <CompactForm
      action={action}
      fields={["name", "slug"]}
      meta={meta}
      projectId={projectId}
      submit="Add lane"
    >
      {(state) => (
        <>
          <Field name="name">
            <FieldLabel>Lane name</FieldLabel>
            <Input name="name" required size="sm" />
            <FieldError issues={actionFieldIssues(state, "name")} />
          </Field>
          <Field name="slug">
            <FieldLabel>Lane slug</FieldLabel>
            <Input
              name="slug"
              pattern="[a-z0-9][a-z0-9-]{0,62}"
              required
              size="sm"
            />
            <FieldDescription>Lowercase stable identifier.</FieldDescription>
            <FieldError issues={actionFieldIssues(state, "slug")} />
          </Field>
        </>
      )}
    </CompactForm>
  );
}

const projectRoleOptions = [
  { label: "Maintainer", value: "maintainer" },
  { label: "Contributor", value: "contributor" },
  { label: "Viewer", value: "viewer" },
];

export function ProjectMemberForm({
  action,
  members,
  meta,
  projectId,
}: {
  action: Action;
  members: Array<{ userId: string; name: string; email: string }>;
  meta: MutationMeta;
  projectId: string;
}) {
  return (
    <CompactForm
      action={action}
      fields={["userId", "role"]}
      meta={meta}
      projectId={projectId}
      submit="Save project role"
    >
      {(state) => (
        <>
          <input name="status" type="hidden" value="active" />
          <Field name="userId">
            <FieldLabel>Organization member</FieldLabel>
            <Select
              items={members.map((member) => ({
                label: `${member.name} · ${member.email}`,
                value: member.userId,
              }))}
              name="userId"
              placeholder="Select member"
              required
              size="sm"
            />
            <FieldError issues={actionFieldIssues(state, "userId")} />
          </Field>
          <Field name="role">
            <FieldLabel>Project role</FieldLabel>
            <Select
              defaultValue="contributor"
              items={projectRoleOptions}
              name="role"
              size="sm"
            />
            <FieldError issues={actionFieldIssues(state, "role")} />
          </Field>
        </>
      )}
    </CompactForm>
  );
}

export function DefaultRepositoryForm({
  action,
  meta,
  projectId,
  repositoryId,
}: {
  action: Action;
  meta: MutationMeta;
  projectId: string;
  repositoryId: string;
}) {
  return (
    <CommandForm action={action} label="Make default" pendingLabel="Saving…">
      <input name="projectId" type="hidden" value={projectId} />
      <input name="repositoryId" type="hidden" value={repositoryId} />
      <MutationMetaInputs meta={meta} />
    </CommandForm>
  );
}

export function RepositoryStatusForm({
  action,
  meta,
  projectId,
  repository,
}: {
  action: Action;
  meta: MutationMeta;
  projectId: string;
  repository: { id: string; status: string; isDefault: boolean };
}) {
  const nextStatus = repository.status === "active" ? "archived" : "active";
  return (
    <CommandForm
      action={action}
      disabled={nextStatus === "archived" && repository.isDefault}
      label={nextStatus === "archived" ? "Archive" : "Reactivate"}
      pendingLabel="Saving…"
    >
      <input name="projectId" type="hidden" value={projectId} />
      <input name="repositoryId" type="hidden" value={repository.id} />
      <input name="status" type="hidden" value={nextStatus} />
      <MutationMetaInputs meta={meta} />
    </CommandForm>
  );
}

export function DefaultLaneForm({
  action,
  laneId,
  meta,
  projectId,
}: {
  action: Action;
  laneId: string;
  meta: MutationMeta;
  projectId: string;
}) {
  return (
    <CommandForm action={action} label="Make default" pendingLabel="Saving…">
      <input name="projectId" type="hidden" value={projectId} />
      <input name="laneId" type="hidden" value={laneId} />
      <MutationMetaInputs meta={meta} />
    </CommandForm>
  );
}

export function LaneStatusForm({
  action,
  isDefault,
  lane,
  meta,
  projectId,
}: {
  action: Action;
  isDefault: boolean;
  lane: { id: string; status: string };
  meta: MutationMeta;
  projectId: string;
}) {
  const nextStatus = lane.status === "active" ? "archived" : "active";
  return (
    <CommandForm
      action={action}
      disabled={nextStatus === "archived" && isDefault}
      label={nextStatus === "archived" ? "Archive" : "Reactivate"}
      pendingLabel="Saving…"
    >
      <input name="projectId" type="hidden" value={projectId} />
      <input name="laneId" type="hidden" value={lane.id} />
      <input name="status" type="hidden" value={nextStatus} />
      <MutationMetaInputs meta={meta} />
    </CommandForm>
  );
}

export function RevokeProjectMemberForm({
  action,
  member,
  meta,
  projectId,
}: {
  action: Action;
  member: { userId: string; role: string };
  meta: MutationMeta;
  projectId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialProjectSettingsActionState,
  );
  const form = useRef<HTMLFormElement>(null);
  return (
    <form action={formAction} ref={form}>
      <Stack direction="column" gap={2}>
        <input name="projectId" type="hidden" value={projectId} />
        <input name="userId" type="hidden" value={member.userId} />
        <input name="role" type="hidden" value={member.role} />
        <input name="status" type="hidden" value="revoked" />
        <MutationMetaInputs meta={meta} />
        {/* Reversible — the role can simply be granted again — so the
            confirmation arms in place rather than opening a modal. */}
        <TwoStepButton
          disabled={pending}
          onConfirm={() => form.current?.requestSubmit()}
          size="sm"
        >
          Revoke access
        </TwoStepButton>
        <Status state={state} />
      </Stack>
    </form>
  );
}

export function ProjectMembersTable({
  action,
  members,
  metas,
  projectId,
}: {
  action: Action;
  members: Array<{
    id: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    status: string;
  }>;
  metas: Record<string, MutationMeta>;
  projectId: string;
}) {
  return (
    <TableScrollRegion aria-label="Project members">
      <Table.Root>
        <Table.Caption>Project members</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Person</Table.Head>
            <Table.Head>Role</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Access</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {members.map((member) => (
            <Table.Row key={member.id}>
              <Table.Cell>
                <Stack direction="column" gap={1}>
                  <span>{member.name}</span>
                  <span className="text-fg-subtle">{member.email}</span>
                </Stack>
              </Table.Cell>
              <Table.Cell>
                <Chip tone="neutral">{member.role}</Chip>
              </Table.Cell>
              <Table.Cell>
                <Chip tone={member.status === "active" ? "ok" : "neutral"}>
                  {member.status}
                </Chip>
              </Table.Cell>
              <Table.Cell>
                {member.status === "active" && metas[member.id] ? (
                  <RevokeProjectMemberForm
                    action={action}
                    member={member}
                    meta={metas[member.id]}
                    projectId={projectId}
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
  );
}

export function ProjectWorkPolicyForm({
  action,
  meta,
  policy,
  projectId,
}: {
  action: Action;
  meta: MutationMeta;
  policy: {
    heartbeatIntervalSeconds: number;
    leaseMultiplier: number;
    graceSeconds: number;
    requiredWorkspaceFields: string[];
  };
  projectId: string;
}) {
  return (
    <CompactForm
      action={action}
      fields={[
        "heartbeatIntervalSeconds",
        "leaseMultiplier",
        "graceSeconds",
        "requiredWorkspaceFields",
      ]}
      meta={meta}
      projectId={projectId}
      submit="Save work policy"
    >
      {(state) => (
        <>
          <Field name="heartbeatIntervalSeconds">
            <FieldLabel>Heartbeat interval</FieldLabel>
            <Input
              defaultValue={policy.heartbeatIntervalSeconds}
              max={300}
              min={10}
              name="heartbeatIntervalSeconds"
              required
              size="sm"
              type="number"
            />
            <FieldDescription>10–300 seconds.</FieldDescription>
            <FieldError
              issues={actionFieldIssues(state, "heartbeatIntervalSeconds")}
            />
          </Field>
          <Field name="leaseMultiplier">
            <FieldLabel>Lease multiplier</FieldLabel>
            <Input
              defaultValue={policy.leaseMultiplier}
              max={10}
              min={2}
              name="leaseMultiplier"
              required
              size="sm"
              type="number"
            />
            <FieldDescription>2–10 heartbeat intervals.</FieldDescription>
            <FieldError issues={actionFieldIssues(state, "leaseMultiplier")} />
          </Field>
          <Field name="graceSeconds">
            <FieldLabel>Abandon grace</FieldLabel>
            <Input
              defaultValue={policy.graceSeconds}
              max={86_400}
              min={60}
              name="graceSeconds"
              required
              size="sm"
              type="number"
            />
            <FieldDescription>60–86400 seconds after stale.</FieldDescription>
            <FieldError issues={actionFieldIssues(state, "graceSeconds")} />
          </Field>
          <Field name="requiredWorkspaceFields">
            <FieldLabel>Required encrypted workspace fields</FieldLabel>
            <CheckboxGroup
              aria-label="Required encrypted workspace fields"
              defaultValue={[...policy.requiredWorkspaceFields]}
            >
              <Stack direction="row" gap={3} wrap>
                {privateTelemetryFields.map((field) => (
                  <Checkbox
                    key={field}
                    label={field}
                    name="requiredWorkspaceFields"
                    size="sm"
                    value={field}
                  />
                ))}
              </Stack>
            </CheckboxGroup>
            <FieldError
              issues={actionFieldIssues(state, "requiredWorkspaceFields")}
            />
          </Field>
        </>
      )}
    </CompactForm>
  );
}

export function ProjectMetadataForm({
  action,
  meta,
  project,
}: {
  action: Action;
  meta: MutationMeta;
  project: {
    id: string;
    name: string;
    description: string | null;
    version: number;
  };
}) {
  return (
    <CompactForm
      action={action}
      fields={["name", "description"]}
      meta={meta}
      projectId={project.id}
      submit="Save details"
    >
      {(state) => (
        <>
          <Field name="name">
            <FieldLabel>Project name</FieldLabel>
            <Input
              defaultValue={project.name}
              maxLength={160}
              name="name"
              required
              size="sm"
            />
            <FieldError issues={actionFieldIssues(state, "name")} />
          </Field>
          <Field name="description">
            <FieldLabel>Description</FieldLabel>
            <Textarea
              defaultValue={project.description ?? ""}
              maxLength={2_000}
              name="description"
              rows={4}
            />
            <FieldDescription>
              Human-readable context shown to requesters and agents.
            </FieldDescription>
            <FieldError issues={actionFieldIssues(state, "description")} />
          </Field>
        </>
      )}
    </CompactForm>
  );
}

export function ProjectStatusForm({
  action,
  meta,
  project,
}: {
  action: Action;
  meta: MutationMeta;
  project: { id: string; status: string; version: number };
}) {
  const nextStatus = project.status === "active" ? "archived" : "active";
  return (
    <CommandForm
      action={action}
      label={
        nextStatus === "archived" ? "Archive project" : "Reactivate project"
      }
      pendingLabel="Saving…"
    >
      <input name="projectId" type="hidden" value={project.id} />
      <input name="status" type="hidden" value={nextStatus} />
      <MutationMetaInputs meta={meta} />
    </CommandForm>
  );
}
