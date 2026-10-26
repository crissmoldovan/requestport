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
} from "@cueplusplus/ui/forms";
import { CopyButton, TwoStepButton } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { AlertDialog, Dialog } from "@cueplusplus/ui/overlays";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { KeyRound } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  initialOperatorActionState,
  type OperatorActionState,
} from "../app/(app)/settings/operators/action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";
import { DialogCancel } from "./administration-forms.js";

/**
 * Operator credentials, on native CUE++ controls (Plan 13, F.3).
 *
 * The forms follow the agent-key forms they mirror: one `Field` per control,
 * the scopes as one named `CheckboxGroup`, the one-time key in a modal that
 * only its own close control dismisses, rotation armed in place because the
 * old key keeps working through its overlap, and revocation behind a modal
 * `AlertDialog` because it cannot be taken back.
 *
 * An `unavailable` answer — operator credentials switched off, or their
 * migration not applied, while the page was open — is drawn as the same
 * notice the page shows when it loads in that state.
 *
 * The issuance form opens in a dialog from the page's "Issue key" action
 * (ruling 259). Its submission's state is held outside that dialog, because the
 * one-time key it answers with is shown in a dialog of its own once the form's
 * has closed. The form shows an answer only on the opening of the dialog it
 * was sent from: its inputs remount empty each time the dialog opens, and a
 * refusal of what was typed before must not sit on them.
 */

type OperatorFormAction = (
  previous: OperatorActionState,
  formData: FormData,
) => Promise<OperatorActionState>;

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: OperatorActionState;
}) {
  if (state.status === "unavailable") {
    return (
      <div role="status">
        <Stack align="center" direction="row" gap={2} wrap>
          <Chip tone="warn">Unavailable</Chip>
          <span>{state.message}</span>
        </Stack>
      </div>
    );
  }
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
 * The one-time key, shown once and dismissed by its own close control only,
 * as the agent key's is: keyed on the key, so a second issue or rotation opens
 * a fresh dialog and a dismissed key can never be reopened.
 */
function OneTimeKey({ state }: { state: OperatorActionState }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (state.status !== "success" || !state.plaintextKey) return null;
  const plaintextKey = state.plaintextKey;

  return (
    <Dialog.Root
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next && details.reason === "close-press")
          setDismissed(plaintextKey);
      }}
      open={dismissed !== plaintextKey}
    >
      <Dialog.Content showCloseButton={false}>
        <Dialog.Title>Copy this operator key now</Dialog.Title>
        <Dialog.Description>
          {state.message} RequestPort will not show it again.
        </Dialog.Description>
        <code className="font-mono break-all">{plaintextKey}</code>
        <Dialog.Footer>
          <CopyButton
            copiedLabel="Copied"
            size="sm"
            value={plaintextKey}
            variant="primary"
          >
            Copy key
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

const issueFields = ["name", "projectId", "expiresInDays", "scopes"];

/** An issuance's answer, and which opening of the dialog it was sent from. */
type IssueAnswer = { opening: number; state: OperatorActionState };

const organizationWide = "";

export function IssueOperatorCredentialDialog({
  action,
  idempotencyKey,
  projects,
  scopes,
}: {
  action: OperatorFormAction;
  idempotencyKey: string;
  projects: ReadonlyArray<{ id: string; name: string }>;
  /** The scopes an operator credential may carry today (`operatorScopes`). */
  scopes: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  // Counts the dialog's openings. A submission is tagged with the opening it
  // was sent from, and the form shows only the current opening's answer.
  const [opening, setOpening] = useState(0);
  const [answer, formAction, pending] = useActionState(
    async (previous: IssueAnswer, data: FormData): Promise<IssueAnswer> => ({
      opening,
      state: await action(previous.state, data),
    }),
    { opening: 0, state: initialOperatorActionState },
  );
  const state =
    answer.opening === opening ? answer.state : initialOperatorActionState;
  const answered = useRef(answer);
  // A successful issue closes the form's dialog; the key's own opens instead.
  useEffect(() => {
    if (answered.current === answer) return;
    answered.current = answer;
    if (answer.state.status === "success") setOpen(false);
  }, [answer]);

  return (
    <>
      {/* Not modal, and not dismissed by a press outside, for the reason
          `FormDialog` gives: its Reach `Select` must open a listbox that
          assistive technology can reach. */}
      <Dialog.Root
        disablePointerDismissal
        modal={false}
        onOpenChange={(next) => {
          if (next) setOpening((count) => count + 1);
          setOpen(next);
        }}
        open={open}
      >
        <Dialog.Trigger
          render={<Button icon={KeyRound} size="sm" variant="primary" />}
        >
          Issue key
        </Dialog.Trigger>
        <Dialog.Content width="lg">
          <Dialog.Title>Issue an operator key</Dialog.Title>
          <Dialog.Description>
            The key is shown once. A rotation keeps its scopes, project and
            expiry.
          </Dialog.Description>
          <form action={formAction}>
            <Stack direction="column" gap={4}>
              <input name="expectedVersion" type="hidden" value="0" />
              <input
                name="idempotencyKey"
                type="hidden"
                value={idempotencyKey}
              />
              <Field name="name">
                <FieldLabel>Credential name</FieldLabel>
                <Input
                  maxLength={160}
                  name="name"
                  placeholder="Nightly deploy job"
                  required
                  size="sm"
                />
                <FieldError issues={actionFieldIssues(state, "name")} />
              </Field>
              <Field name="projectId">
                <FieldLabel>Reach</FieldLabel>
                <Select
                  defaultValue={organizationWide}
                  items={[
                    {
                      label: "The whole organization",
                      value: organizationWide,
                    },
                    ...projects.map((project) => ({
                      label: `Only ${project.name}`,
                      value: project.id,
                    })),
                  ]}
                  name="projectId"
                  size="sm"
                />
                <FieldDescription>
                  An organization-wide credential needs an owner or admin; a
                  project-bound one, that project's maintainer.
                </FieldDescription>
                <FieldError issues={actionFieldIssues(state, "projectId")} />
              </Field>
              <Field name="expiresInDays">
                <FieldLabel>Expires in days</FieldLabel>
                <Input
                  defaultValue="30"
                  max="90"
                  min="1"
                  name="expiresInDays"
                  required
                  size="sm"
                  type="number"
                />
                <FieldDescription>1–90 days.</FieldDescription>
                <FieldError
                  issues={actionFieldIssues(state, "expiresInDays")}
                />
              </Field>
              <Field name="scopes">
                <FieldLabel>Allowed scopes</FieldLabel>
                <CheckboxGroup aria-label="Allowed scopes" defaultValue={[]}>
                  <Stack direction="row" gap={3} wrap>
                    {scopes.map((scope) => (
                      <Checkbox
                        key={scope}
                        label={scope}
                        name="scopes"
                        size="sm"
                        value={scope}
                      />
                    ))}
                  </Stack>
                </CheckboxGroup>
                <FieldDescription>
                  A credential can always revoke itself; operator:revoke lets it
                  revoke others within its reach.
                </FieldDescription>
                <FieldError issues={actionFieldIssues(state, "scopes")} />
              </Field>
              {/* The success line is the key's dialog, not this one. */}
              {state.status === "success" ? null : (
                <Status fields={issueFields} state={state} />
              )}
              <Stack direction="row" gap={2} justify="end" wrap>
                <DialogCancel />
                <Button
                  disabled={pending}
                  size="sm"
                  type="submit"
                  variant="primary"
                >
                  {pending ? "Issuing…" : "Issue one-time key"}
                </Button>
              </Stack>
            </Stack>
          </form>
        </Dialog.Content>
      </Dialog.Root>
      <OneTimeKey state={answer.state} />
    </>
  );
}

export function OperatorCredentialActions({
  credentialId,
  expectedVersion,
  mayRotate,
  revokeAction,
  revokeIdempotencyKey,
  rotateAction,
  rotateIdempotencyKey,
}: {
  credentialId: string;
  expectedVersion: number;
  /** Only the credential's own issuer rotates it; anyone permitted revokes. */
  mayRotate: boolean;
  revokeAction: OperatorFormAction;
  revokeIdempotencyKey: string;
  rotateAction: OperatorFormAction;
  rotateIdempotencyKey: string;
}) {
  const [revokeState, revokeFormAction, revoking] = useActionState(
    revokeAction,
    initialOperatorActionState,
  );
  const [rotateState, rotateFormAction, rotating] = useActionState(
    rotateAction,
    initialOperatorActionState,
  );
  const rotateForm = useRef<HTMLFormElement>(null);
  const revokeForm = useRef<HTMLFormElement>(null);
  return (
    <Stack direction="column" gap={2}>
      {mayRotate ? (
        <form action={rotateFormAction} ref={rotateForm}>
          <input name="credentialId" type="hidden" value={credentialId} />
          <input name="expectedVersion" type="hidden" value={expectedVersion} />
          <input
            name="idempotencyKey"
            type="hidden"
            value={rotateIdempotencyKey}
          />
          <input name="overlapMinutes" type="hidden" value="15" />
          {/* Recoverable — the old key keeps working through its overlap —
              so the confirmation arms in place. */}
          <TwoStepButton
            disabled={rotating}
            onConfirm={() => rotateForm.current?.requestSubmit()}
            size="sm"
          >
            Rotate key
          </TwoStepButton>
        </form>
      ) : null}
      <form action={revokeFormAction} ref={revokeForm}>
        <input name="credentialId" type="hidden" value={credentialId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input
          name="idempotencyKey"
          type="hidden"
          value={revokeIdempotencyKey}
        />
        <AlertDialog.Root>
          <AlertDialog.Trigger
            render={
              <Button disabled={revoking} size="sm" variant="danger-outline">
                Revoke key
              </Button>
            }
          />
          <AlertDialog.Content>
            <AlertDialog.Title>Revoke this operator key?</AlertDialog.Title>
            <AlertDialog.Description>
              A revoked operator key stops authenticating immediately and cannot
              be restored. Issue a new one if the job still needs it.
            </AlertDialog.Description>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Keep it</AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => revokeForm.current?.requestSubmit()}
                tone="danger"
              >
                Revoke key
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
      </form>
      <OneTimeKey state={rotateState} />
      <Status state={rotateState} />
      <Status state={revokeState} />
    </Stack>
  );
}
