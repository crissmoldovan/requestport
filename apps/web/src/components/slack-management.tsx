"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
} from "@cueplusplus/ui/forms";
import { Stack } from "@cueplusplus/ui/layout";
import { AlertDialog } from "@cueplusplus/ui/overlays";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { useActionState, useRef, useState } from "react";

import {
  initialSlackActionState,
  type SlackActionState,
} from "../app/(app)/slack/slack-action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";

/**
 * The Slack integration controls, on native CUE++ controls.
 *
 * Enabling and disabling a workspace is a single press, because either can be
 * undone by the other. Revoking is the one Slack action with no way back — the
 * repository refuses to move a revoked installation anywhere and says the
 * workspace has to be reinstalled through OAuth — so §6.2 sends it to a modal
 * rather than to a button that arms in place.
 *
 * The two carry the same idempotency key and the same expected version — the
 * page mints one of each per installation row — so they are one submission
 * queue, not two: whichever is in flight stops both.
 */

type Action = (
  state: SlackActionState,
  data: FormData,
) => Promise<SlackActionState>;

const deliveryModes = [
  { label: "User DM", value: "dm" },
  { label: "Channel", value: "channel" },
  { label: "DM and channel", value: "both" },
];

const fallbacks = [
  { label: "Email", value: "email" },
  { label: "None", value: "none" },
  { label: "Organization channel", value: "organization_channel" },
];

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: SlackActionState;
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

const mappingFields = ["installationId", "userId", "slackUserId"] as const;

export function SlackMappingForm({
  action,
  idempotencyKey,
  installations,
  mappings,
  members,
}: {
  action: Action;
  idempotencyKey: string;
  installations: Array<{ id: string; workspaceName: string }>;
  mappings: Array<{ installationId: string; userId: string; version: number }>;
  members: Array<{ userId: string; name: string; email: string }>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialSlackActionState,
  );
  const [installationId, setInstallationId] = useState(
    installations[0]?.id ?? "",
  );
  const [userId, setUserId] = useState(members[0]?.userId ?? "");
  // The pair the reader has selected decides which record is being replaced,
  // so the expected version travels with the selection rather than the form.
  const expectedVersion =
    mappings.find(
      (mapping) =>
        mapping.installationId === installationId && mapping.userId === userId,
    )?.version ?? 0;
  return (
    <form action={formAction}>
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={4}>
        <Field name="installationId">
          <FieldLabel>Workspace</FieldLabel>
          <Select
            items={installations.map((item) => ({
              label: item.workspaceName,
              value: item.id,
            }))}
            name="installationId"
            onValueChange={(value) => setInstallationId(value ?? "")}
            required
            size="sm"
            value={installationId}
          />
          <FieldError issues={actionFieldIssues(state, "installationId")} />
        </Field>
        <Field name="userId">
          <FieldLabel>RequestPort user</FieldLabel>
          <Select
            items={members.map((member) => ({
              label: `${member.name} · ${member.email}`,
              value: member.userId,
            }))}
            name="userId"
            onValueChange={(value) => setUserId(value ?? "")}
            required
            size="sm"
            value={userId}
          />
          <FieldError issues={actionFieldIssues(state, "userId")} />
        </Field>
        <Field name="slackUserId">
          <FieldLabel>Slack member ID</FieldLabel>
          <Input
            name="slackUserId"
            placeholder="U012ABCDEF"
            required
            size="sm"
          />
          <FieldDescription>
            The workspace member ID, not the display name.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "slackUserId")} />
        </Field>
        <Status fields={mappingFields} state={state} />
        <div>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Saving…" : "Save mapping"}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

const routeFields = ["projectId", "mode", "channelId", "fallback"] as const;

export function SlackRouteForm({
  action,
  idempotencyKey,
  projects,
  routes,
}: {
  action: Action;
  idempotencyKey: string;
  projects: Array<{ id: string; name: string }>;
  routes: Array<{ projectId: string | null; status: string; version: number }>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialSlackActionState,
  );
  const [projectId, setProjectId] = useState("");
  // A change replaces the scope's active route and leaves the old row,
  // disabled, in the list, in no stated order. The repository checks the
  // version of the scope's active route, and 0 when it has none, so that is
  // the only version this form may send.
  const expectedVersion =
    routes.find(
      (route) =>
        route.status === "active" && (route.projectId ?? "") === projectId,
    )?.version ?? 0;
  return (
    <form action={formAction}>
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={4}>
        <Field name="projectId">
          <FieldLabel>Scope</FieldLabel>
          <Select
            items={[
              { label: "Organization fallback", value: "" },
              ...projects.map((project) => ({
                label: project.name,
                value: project.id,
              })),
            ]}
            name="projectId"
            onValueChange={(value) => setProjectId(value ?? "")}
            size="sm"
            value={projectId}
          />
          <FieldDescription>
            A project route takes precedence over the organization fallback.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "projectId")} />
        </Field>
        <Field name="mode">
          <FieldLabel>Delivery</FieldLabel>
          <Select
            defaultValue="dm"
            items={deliveryModes}
            name="mode"
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "mode")} />
        </Field>
        <Field name="channelId">
          <FieldLabel>Channel ID</FieldLabel>
          <Input name="channelId" placeholder="C012ABCDEF" size="sm" />
          <FieldError issues={actionFieldIssues(state, "channelId")} />
        </Field>
        <Field name="fallback">
          <FieldLabel>Fallback</FieldLabel>
          <Select
            defaultValue="email"
            items={fallbacks}
            name="fallback"
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "fallback")} />
        </Field>
        <Status fields={routeFields} state={state} />
        <div>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Saving…" : "Save route"}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

export function SlackInstallationActions({
  action,
  expectedVersion,
  idempotencyKey,
  installationId,
  status,
}: {
  action: Action;
  expectedVersion: number;
  idempotencyKey: string;
  installationId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialSlackActionState,
  );
  const [revokeState, revokeFormAction, revoking] = useActionState(
    action,
    initialSlackActionState,
  );
  const revokeForm = useRef<HTMLFormElement>(null);
  return (
    <Stack direction="column" gap={2}>
      <form action={formAction}>
        <input name="installationId" type="hidden" value={installationId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <input
          name="status"
          type="hidden"
          value={status === "active" ? "disabled" : "active"}
        />
        <Button
          disabled={pending || revoking}
          size="sm"
          type="submit"
          variant="secondary"
        >
          {status === "active" ? "Disable" : "Enable"}
        </Button>
      </form>
      <form action={revokeFormAction} ref={revokeForm}>
        <input name="installationId" type="hidden" value={installationId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <input name="status" type="hidden" value="revoked" />
        {/* No way back: a revoked installation has to be reinstalled through
            OAuth, so the question is asked in a modal. */}
        <AlertDialog.Root>
          <AlertDialog.Trigger
            render={
              <Button
                disabled={pending || revoking}
                size="sm"
                variant="danger-outline"
              >
                Revoke
              </Button>
            }
          />
          <AlertDialog.Content>
            <AlertDialog.Title>Revoke this workspace?</AlertDialog.Title>
            <AlertDialog.Description>
              Deliveries stop immediately and the workspace has to be
              reinstalled through OAuth before it can be used again. Disable it
              instead if the pause is temporary.
            </AlertDialog.Description>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Keep it</AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => revokeForm.current?.requestSubmit()}
                tone="danger"
              >
                Revoke workspace
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
      </form>
      <Status state={state} />
      <Status state={revokeState} />
    </Stack>
  );
}

const testFields = ["installationId", "channelId"] as const;

export function SlackConnectionTestForm({
  action,
  installations,
  idempotencyKey,
}: {
  action: Action;
  installations: Array<{ id: string; workspaceName: string }>;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialSlackActionState,
  );
  return (
    <form action={formAction}>
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={4}>
        <Field name="installationId">
          <FieldLabel>Workspace</FieldLabel>
          <Select
            defaultValue={installations[0]?.id ?? ""}
            items={installations.map((installation) => ({
              label: installation.workspaceName,
              value: installation.id,
            }))}
            name="installationId"
            required
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "installationId")} />
        </Field>
        <Field name="channelId">
          <FieldLabel>Test channel ID</FieldLabel>
          <Input name="channelId" placeholder="C012ABCDEF" required size="sm" />
          <FieldError issues={actionFieldIssues(state, "channelId")} />
        </Field>
        <Status fields={testFields} state={state} />
        <div>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Queuing…" : "Send test"}
          </Button>
        </div>
      </Stack>
    </form>
  );
}
