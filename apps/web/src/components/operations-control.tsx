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
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { Archive } from "lucide-react";
import { type ReactNode, useActionState } from "react";

import {
  initialOperationsActionState,
  type OperationsActionState,
} from "../app/(app)/settings/operations/action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";
import {
  DialogCancel,
  FormDialog,
  useReportSuccess,
} from "./administration-forms.js";

/**
 * The recovery controls, on native CUE++ controls.
 *
 * Requeueing is a *recovery* action rather than a destructive one — it puts
 * work back on a queue that already owns an idempotency key — so it stays one
 * press. What every form here does carry is the record's own expected version
 * and the page-minted key, which is what makes a double press safe.
 *
 * A new retention hold opens in a dialog from its panel's "Add hold" action
 * (ruling 259); the dialog closes on success and a toast confirms it.
 */

type Action = (
  state: OperationsActionState,
  formData: FormData,
) => Promise<OperationsActionState>;

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: OperationsActionState;
}) {
  const failure = actionBannerMessage(state, fields);
  if (failure) {
    return (
      <div role="alert">
        <Stack align="center" direction="row" gap={2}>
          <Chip tone="danger">Error</Chip>
          <span>{failure}</span>
        </Stack>
      </div>
    );
  }
  if (state.status !== "success" || !state.message) return null;

  return (
    <div role="status">
      <Stack align="center" direction="row" gap={2}>
        <Chip tone="ok">Done</Chip>
        <span>{state.message}</span>
      </Stack>
    </div>
  );
}

/**
 * One requeue control and its answer. Every caller differs only in the hidden
 * command metadata it carries, which is exactly what `children` supplies.
 */
function RequeueForm({
  action,
  children,
}: {
  action: Action;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialOperationsActionState,
  );
  return (
    <form action={formAction}>
      <Stack align="center" direction="row" gap={2} wrap>
        {children}
        <Button disabled={pending} size="sm" type="submit" variant="secondary">
          {pending ? "Requeuing…" : "Requeue"}
        </Button>
        <Status state={state} />
      </Stack>
    </form>
  );
}

export function RequeueOutboxForm({
  action,
  expectedVersion,
  idempotencyKey,
  outboxId,
}: {
  action: Action;
  expectedVersion: number;
  idempotencyKey: string;
  outboxId: string;
}) {
  return (
    <RequeueForm action={action}>
      <input name="outboxId" type="hidden" value={outboxId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
    </RequeueForm>
  );
}

export function RequeueNotificationForm({
  action,
  channel,
  expectedVersion,
  idempotencyKey,
  notificationIntentId,
}: {
  action: Action;
  channel: "email" | "slack";
  expectedVersion: number;
  idempotencyKey: string;
  notificationIntentId: string;
}) {
  return (
    <RequeueForm action={action}>
      <input
        name="notificationIntentId"
        type="hidden"
        value={notificationIntentId}
      />
      <input name="channel" type="hidden" value={channel} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
    </RequeueForm>
  );
}

export function RequeueSlackOperationForm({
  action,
  expectedVersion,
  idempotencyKey,
  operationId,
  operationType,
}: {
  action: Action;
  expectedVersion: number;
  idempotencyKey: string;
  operationId: string;
  operationType: "message_update" | "connection_test";
}) {
  return (
    <RequeueForm action={action}>
      <input name="operationId" type="hidden" value={operationId} />
      <input name="operationType" type="hidden" value={operationType} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
    </RequeueForm>
  );
}

export function RequeueImportDispatchForm({
  action,
  dispatchId,
  expectedVersion,
  idempotencyKey,
}: {
  action: Action;
  dispatchId: string;
  expectedVersion: number;
  idempotencyKey: string;
}) {
  return (
    <RequeueForm action={action}>
      <input name="dispatchId" type="hidden" value={dispatchId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
    </RequeueForm>
  );
}

const categoryOptions = [
  { label: "All organization-scoped cleanup", value: "all" },
  { label: "Slack OAuth state", value: "slack_oauth_state" },
  { label: "Slack action tokens", value: "slack_action_token" },
];

const holdFields = ["category", "reason"] as const;

export function RetentionHoldForm({
  action,
  cancel,
  idempotencyKey,
  onSuccess,
}: {
  action: Action;
  /** The dialog's Cancel, when the form is opened in one. */
  cancel?: ReactNode;
  idempotencyKey: string;
  onSuccess?: (message: string) => void;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialOperationsActionState,
  );
  useReportSuccess(state, onSuccess);
  return (
    <form action={formAction}>
      <Stack direction="column" gap={4}>
        <input name="expectedVersion" type="hidden" value="0" />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <Field name="category">
          <FieldLabel>Category</FieldLabel>
          <Select
            defaultValue="all"
            items={categoryOptions}
            name="category"
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "category")} />
        </Field>
        <Field name="reason">
          <FieldLabel>Preservation reason</FieldLabel>
          <Input
            maxLength={500}
            minLength={8}
            name="reason"
            required
            size="sm"
          />
          <FieldDescription>
            Recorded with the hold; preserved data itself is never projected.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "reason")} />
        </Field>
        <Status fields={holdFields} state={state} />
        <Stack direction="row" gap={2} justify="end" wrap>
          {cancel}
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Creating…" : "Create hold"}
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

/** The retention panel's action: a new hold, in a dialog. */
export function RetentionHoldDialog({
  action,
  idempotencyKey,
}: {
  action: Action;
  idempotencyKey: string;
}) {
  return (
    <FormDialog
      description="Pause eligible organization-scoped cleanup until the hold is released."
      icon={Archive}
      title="Add a retention hold"
      trigger="Add hold"
      triggerVariant="secondary"
    >
      {(done) => (
        <RetentionHoldForm
          action={action}
          cancel={<DialogCancel />}
          idempotencyKey={idempotencyKey}
          onSuccess={done}
        />
      )}
    </FormDialog>
  );
}

export function ReleaseRetentionHoldForm({
  action,
  expectedVersion,
  holdId,
  idempotencyKey,
}: {
  action: Action;
  expectedVersion: number;
  holdId: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialOperationsActionState,
  );
  return (
    <form action={formAction}>
      <Stack align="center" direction="row" gap={2} wrap>
        <input name="holdId" type="hidden" value={holdId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <Button disabled={pending} size="sm" type="submit" variant="secondary">
          {pending ? "Releasing…" : "Release"}
        </Button>
        <Status state={state} />
      </Stack>
    </form>
  );
}
