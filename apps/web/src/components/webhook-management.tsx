"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  MultiSelect,
  Select,
} from "@cueplusplus/ui/forms";
import { CopyButton, TwoStepButton } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Dialog } from "@cueplusplus/ui/overlays";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { useActionState, useRef, useState } from "react";

import {
  initialWebhookActionState,
  type WebhookActionState,
} from "../app/(app)/webhooks/webhook-action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";

/**
 * Webhook subscriptions, on native CUE++ controls.
 *
 * Two rulings are worth naming. A signing secret is shown in exactly one
 * place — a modal keyed on the secret itself, so a second rotation opens a
 * fresh one and a dismissed secret can never be reopened from state this
 * component still holds. And rotation arms in place through `TwoStepButton`
 * rather than opening an `AlertDialog`: the previous secret keeps signing for
 * the whole overlap window, so the action is destructive but reversible, which
 * is the shape §6.2 gives the two-press control.
 */

type Action = (
  previous: WebhookActionState,
  data: FormData,
) => Promise<WebhookActionState>;

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: WebhookActionState;
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

/**
 * The one-time signing secret, shown once and dismissed.
 *
 * Keyed on the secret rather than on a boolean so a second creation or
 * rotation opens a fresh dialog, and so dismissing one drops it for good.
 *
 * Because the dismissal is final, it is spent by one gesture only. Base UI's
 * dialog closes on Escape and on an outside press as well as on its own close
 * control, and any of the three would destroy the single copy of something
 * this dialog has just promised is never shown again — an operator moving the
 * modal aside to read the page beneath it would have to rotate or re-create
 * the subscription to get another. So the scrim stops dismissing at all, and
 * only a press on the footer control — Base UI reports the reason alongside
 * the new state — records the secret as gone.
 */
function OneTimeSecret({ state }: { state: WebhookActionState }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (state.status !== "success" || !state.plaintextSecret) return null;
  const plaintextSecret = state.plaintextSecret;
  const open = dismissed !== plaintextSecret;

  return (
    <Dialog.Root
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next && details.reason === "close-press")
          setDismissed(plaintextSecret);
      }}
      open={open}
    >
      {/* One dismissal affordance, not two: a corner close would carry the
          same accessible name as the footer control and a screen-reader user
          would hear "Close" twice in one dialog. */}
      <Dialog.Content showCloseButton={false}>
        <Dialog.Title>Copy this signing secret now</Dialog.Title>
        <Dialog.Description>
          {state.message} RequestPort will not show it again.
        </Dialog.Description>
        <code className="font-mono break-all">{plaintextSecret}</code>
        <Dialog.Footer>
          <CopyButton
            copiedLabel="Copied"
            size="sm"
            value={plaintextSecret}
            variant="primary"
          >
            Copy signing secret
          </CopyButton>
          <Dialog.Close
            render={
              <Button size="sm" variant="secondary">
                Close
              </Button>
            }
          />
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

const createFields = [
  "name",
  "projectId",
  "endpointUrl",
  "eventTypes",
  "requestTypes",
  "laneIds",
] as const;

export function CreateWebhookForm({
  action,
  idempotencyKey,
  lanes,
  projects,
}: {
  action: Action;
  idempotencyKey: string;
  lanes: Array<{ id: string; name: string; projectId: string }>;
  projects: Array<{ id: string; name: string }>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialWebhookActionState,
  );
  const laneItems = lanes.map((lane) => ({
    label: `${
      projects.find((project) => project.id === lane.projectId)?.name ??
      "Project"
    } · ${lane.name}`,
    value: lane.id,
  }));
  return (
    <form action={formAction}>
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <input name="expectedVersion" type="hidden" value="0" />
      <Stack direction="column" gap={4}>
        <Field name="name">
          <FieldLabel>Name</FieldLabel>
          <Input name="name" required size="sm" />
          <FieldError issues={actionFieldIssues(state, "name")} />
        </Field>
        <Field name="projectId">
          <FieldLabel>Scope</FieldLabel>
          <Select
            defaultValue=""
            items={[
              { label: "Entire organization", value: "" },
              ...projects.map((project) => ({
                label: project.name,
                value: project.id,
              })),
            ]}
            name="projectId"
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "projectId")} />
        </Field>
        <Field name="endpointUrl">
          <FieldLabel>Endpoint URL</FieldLabel>
          <Input name="endpointUrl" required size="sm" type="url" />
          <FieldDescription>
            HTTPS only; public DNS addresses are revalidated on every redirect
            and delivery.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "endpointUrl")} />
        </Field>
        <Field name="eventTypes">
          <FieldLabel>Event types</FieldLabel>
          <Input
            name="eventTypes"
            placeholder="request.created.v1, question.asked.v1"
            size="sm"
          />
          <FieldDescription>
            Optional comma-separated exact event types. Empty means all.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "eventTypes")} />
        </Field>
        <Field name="requestTypes">
          <FieldLabel>Request types</FieldLabel>
          <Input name="requestTypes" placeholder="feature, bug" size="sm" />
          <FieldDescription>
            Optional comma-separated request types.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "requestTypes")} />
        </Field>
        <Field name="laneIds">
          <FieldLabel>Lane filters</FieldLabel>
          <MultiSelect
            items={laneItems}
            name="laneIds"
            placeholder="All lanes"
            size="sm"
          />
          <FieldDescription>
            Optional. Deliveries are limited to the receiving lanes you choose.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "laneIds")} />
        </Field>
        <Status fields={createFields} state={state} />
        <div>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Creating…" : "Create webhook"}
          </Button>
        </div>
      </Stack>
      <OneTimeSecret state={state} />
    </form>
  );
}

export function WebhookActions({
  expectedVersion,
  id,
  idempotencyKeys,
  status,
  verifyAction,
  rotateAction,
  statusAction,
}: {
  expectedVersion: number;
  id: string;
  idempotencyKeys: { rotate: string; status: string; verify: string };
  status: string;
  verifyAction: Action;
  rotateAction: Action;
  statusAction: Action;
}) {
  const [verifyState, verifyForm, verifying] = useActionState(
    verifyAction,
    initialWebhookActionState,
  );
  const [rotateState, rotateForm, rotating] = useActionState(
    rotateAction,
    initialWebhookActionState,
  );
  const [state, statusForm, changing] = useActionState(
    statusAction,
    initialWebhookActionState,
  );
  const rotation = useRef<HTMLFormElement>(null);
  return (
    <Stack direction="column" gap={2}>
      {status === "pending_verification" ? (
        <form action={verifyForm}>
          <input name="id" type="hidden" value={id} />
          <input
            name="idempotencyKey"
            type="hidden"
            value={idempotencyKeys.verify}
          />
          <input name="expectedVersion" type="hidden" value={expectedVersion} />
          <Button
            disabled={verifying}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {verifying ? "Verifying…" : "Verify"}
          </Button>
        </form>
      ) : null}
      {status === "active" || status === "disabled" ? (
        <form action={rotateForm} ref={rotation}>
          <input name="id" type="hidden" value={id} />
          <input
            name="idempotencyKey"
            type="hidden"
            value={idempotencyKeys.rotate}
          />
          <input name="expectedVersion" type="hidden" value={expectedVersion} />
          <input name="overlapMinutes" type="hidden" value="60" />
          {/* Reversible for the whole overlap window — the previous secret
              keeps signing — so the confirmation arms in place. */}
          <TwoStepButton
            disabled={rotating}
            onConfirm={() => rotation.current?.requestSubmit()}
            size="sm"
          >
            {rotating ? "Rotating…" : "Rotate secret"}
          </TwoStepButton>
        </form>
      ) : null}
      {status !== "revoked" ? (
        <form action={statusForm}>
          <input name="id" type="hidden" value={id} />
          <input
            name="idempotencyKey"
            type="hidden"
            value={idempotencyKeys.status}
          />
          <input name="expectedVersion" type="hidden" value={expectedVersion} />
          <input
            name="status"
            type="hidden"
            value={status === "active" ? "disabled" : "active"}
          />
          <Button
            disabled={changing}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {status === "active" ? "Disable" : "Enable"}
          </Button>
        </form>
      ) : null}
      <Status state={verifyState} />
      <Status state={rotateState} />
      <Status state={state} />
      <OneTimeSecret state={rotateState} />
    </Stack>
  );
}

export function WebhookReplayButton({
  action,
  deliveryId,
  idempotencyKey,
}: {
  action: Action;
  deliveryId: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialWebhookActionState,
  );
  return (
    <form action={formAction}>
      <Stack direction="column" gap={2}>
        <input name="deliveryId" type="hidden" value={deliveryId} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <input name="expectedVersion" type="hidden" value="0" />
        <div>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Queuing…" : "Replay"}
          </Button>
        </div>
        <Status state={state} />
      </Stack>
    </form>
  );
}
