"use client";

import { Row } from "@cueplusplus/ui/chrome";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  Textarea,
} from "@cueplusplus/ui/forms";
import { Stack } from "@cueplusplus/ui/layout";
import { Dialog, useToast } from "@cueplusplus/ui/overlays";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { FolderPlus, UserPlus } from "lucide-react";
import {
  type ElementType,
  type ReactNode,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";
import type { AdministrationActionState } from "../lib/administration-actions.js";
import { postOrganizationCreate } from "../lib/organization-create.js";

/**
 * The organization, project and invitation forms, on native CUE++ controls,
 * and the dialog the settings pages open a form in.
 *
 * Section 7 gives every visible control one `Field` with a visible label, so no
 * form here wires an `id`/`htmlFor` pair by hand and every server-side field
 * failure has a line of its own to land on. A failure that names no field — or
 * names one this form does not draw — stays in the fixed banner.
 *
 * A settings page is a header and panels of rows (ruling 259): a form that
 * used to sit under its list opens in a `FormDialog` from the page's or the
 * panel's action instead. The dialog closes when its form reports success and
 * says so in a toast; a refusal keeps it open, on the field or banner it lands
 * on. The toast goes to the console's one provider, which the shell mounts
 * around every page (`ConsoleToasts`, ruling 260).
 */

export type FormAction = (
  previousState: AdministrationActionState,
  formData: FormData,
) => Promise<AdministrationActionState>;

const initialState: AdministrationActionState = {
  status: "success",
  message: "",
};

/**
 * The allowlisted result code the last submission answered with, on the line
 * that carries its sentence.
 *
 * Hidden command metadata rather than anything a reader sees: §12 closes the
 * failure vocabulary, so the code travels with the message it produced instead
 * of being re-derived from the words. A field-addressed failure draws no
 * banner, which is why the field's own error line carries it too.
 */
function resultCode(
  state: AdministrationActionState,
  field?: string,
): string | undefined {
  if (state.status !== "error") return undefined;

  return field === undefined || state.field === field ? state.code : undefined;
}

/** One field's error line, carrying the code the server answered with. */
function ActionFieldError({
  name,
  state,
}: {
  name: string;
  state: AdministrationActionState;
}) {
  return (
    <FieldError
      data-code={resultCode(state, name)}
      issues={actionFieldIssues(state, name)}
    />
  );
}

/**
 * The fixed result line: a tone chip and a message, never colour alone and
 * never text derived from a thrown error.
 */
function ActionResult({
  fields,
  state,
}: {
  fields: readonly string[];
  state: AdministrationActionState;
}) {
  const failure = actionBannerMessage(state, fields);
  if (failure) {
    return (
      <div role="alert">
        <Row>
          <Chip tone="danger">Error</Chip>
          <span data-code={resultCode(state)}>{failure}</span>
        </Row>
      </div>
    );
  }
  if (state.status !== "success" || !state.message) return null;

  return (
    <div role="status">
      <Row>
        <Chip tone="ok">Done</Chip>
        <span>{state.message}</span>
      </Row>
    </div>
  );
}

/**
 * Hands a form's success message to `onSuccess` once per submission.
 *
 * Keyed on the state object, not on the message: the same sentence answers two
 * submissions in a row, and each is reported. The ref is what stops a second
 * report of one submission when the caller hands a new `onSuccess` while the
 * dialog that holds the form is still closing.
 */
export function useReportSuccess(
  state: { status: string; message?: string },
  onSuccess: ((message: string) => void) | undefined,
) {
  const reported = useRef<object | null>(null);
  useEffect(() => {
    if (state.status !== "success" || !state.message || !onSuccess) return;
    if (reported.current === state) return;
    reported.current = state;
    onSuccess(state.message);
  }, [state, onSuccess]);
}

/**
 * The control that leaves a dialog's form without submitting it.
 *
 * `type="button"` on the element it renders, because it sits inside the form:
 * a button there submits by default.
 */
export function DialogCancel() {
  return (
    <Dialog.Close
      render={<Button size="sm" type="button" variant="secondary" />}
    >
      Cancel
    </Dialog.Close>
  );
}

/**
 * A form's closing row: Cancel when it is in a dialog, then its one submit.
 */
function FormActions({
  cancel,
  children,
}: {
  cancel?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack direction="row" gap={2} justify="end" wrap>
      {cancel}
      {children}
    </Stack>
  );
}

/**
 * A form opened from a page's or a panel's action, in a non-modal dialog.
 *
 * The trigger is the one primary control the header carries. The dialog is
 * controlled here so that `done`, handed to the form, can close it and confirm
 * the write in a toast with the sentence the action answered. Base UI owns the
 * rest: Escape, initial focus, focus returning to the trigger.
 *
 * It is not modal, on purpose, and it does not close on a press outside it.
 * A modal Base UI dialog hides every other child of `<body>` from assistive
 * technology while it is open, and in `@cueplusplus/ui` 0.29.0 each overlay
 * portals through a container of its own that it appends to `<body>` when it
 * mounts, not when it opens. A `Select` in the dialog mounts with the dialog,
 * so its container is there to be hidden, and its listbox then opens inside an
 * `aria-hidden` subtree: a screen reader hears no options, and a role query
 * finds none. `modal={false}` hides nothing; `disablePointerDismissal` keeps
 * a stray press on the scrim from discarding what was typed (and, with it,
 * closing on focus leaving). Focus is not trapped, so Tab can leave the
 * dialog; Escape closes it.
 */
export function FormDialog({
  children,
  description,
  icon,
  title,
  trigger,
  triggerLabel,
  triggerVariant = "primary",
  width = "md",
}: {
  children: (done: (message: string) => void) => ReactNode;
  description?: ReactNode;
  icon?: ElementType;
  title: string;
  trigger: string;
  /** An accessible name longer than the visible label, for a trigger in a row. */
  triggerLabel?: string;
  triggerVariant?: "primary" | "secondary";
  width?: "md" | "lg";
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  // Held in a ref so `done` keeps one identity across renders: the forms
  // report through an effect, and a new callback each render would ask them
  // to report again while the dialog is still animating closed.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const done = useCallback((message: string) => {
    setOpen(false);
    toastRef.current.add({ title: message, tone: "ok" });
  }, []);

  return (
    <Dialog.Root
      disablePointerDismissal
      modal={false}
      onOpenChange={setOpen}
      open={open}
    >
      <Dialog.Trigger
        render={
          <Button
            aria-label={triggerLabel}
            icon={icon}
            size="sm"
            variant={triggerVariant}
          />
        }
      >
        {trigger}
      </Dialog.Trigger>
      <Dialog.Content width={width}>
        <Dialog.Title>{title}</Dialog.Title>
        {description ? (
          <Dialog.Description>{description}</Dialog.Description>
        ) : null}
        {children(done)}
      </Dialog.Content>
    </Dialog.Root>
  );
}

const organizationFields = ["name", "slug"] as const;

/**
 * The creation is posted to a Route Handler rather than dispatched as a Server
 * Action, and it ends in a full-document navigation to the destination the
 * server validated.
 *
 * Creating an organization makes it the current tenant, so the appearance
 * triple the next document inherits changes with it. An action that writes a
 * cookie makes the router refetch and commit the current route tree into *this*
 * document — and this one also revalidated and redirected outright — so the new
 * tenant's theme was adopted during a client transition. `useActionState` still
 * drives the form, because what changes is where the submission goes, not how a
 * rejection is rendered: a field failure still lands on its own control.
 */
async function createOrganizationSubmission(
  _previousState: AdministrationActionState,
  formData: FormData,
): Promise<AdministrationActionState> {
  return postOrganizationCreate(formData);
}

export function OrganizationForm() {
  const [state, formAction, pending] = useActionState(
    createOrganizationSubmission,
    initialState,
  );

  useEffect(() => {
    if (state.status === "success" && state.destination) {
      window.location.assign(state.destination);
    }
  }, [state]);

  return (
    <form action={formAction}>
      <Stack direction="column" gap={4}>
        <Field name="name">
          <FieldLabel>Organization name</FieldLabel>
          <Input autoComplete="organization" name="name" required size="sm" />
          <FieldDescription>
            The human-readable organization name.
          </FieldDescription>
          <ActionFieldError name="name" state={state} />
        </Field>
        <Field name="slug">
          <FieldLabel>Organization slug</FieldLabel>
          <Input
            autoCapitalize="none"
            autoComplete="off"
            name="slug"
            pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
            required
            size="sm"
          />
          <FieldDescription>
            Lowercase letters, numbers, and single hyphens.
          </FieldDescription>
          <ActionFieldError name="slug" state={state} />
        </Field>
        <ActionResult fields={organizationFields} state={state} />
        <Button disabled={pending} size="sm" type="submit" variant="primary">
          {pending ? "Creating…" : "Create organization"}
        </Button>
      </Stack>
    </form>
  );
}

const projectFields = [
  "name",
  "keyPrefix",
  "slug",
  "repositoryUrl",
  "description",
] as const;

export function ProjectForm({
  action,
  cancel,
  onSuccess,
}: {
  action: FormAction;
  /** The dialog's Cancel, when the form is opened in one. */
  cancel?: ReactNode;
  onSuccess?: (message: string) => void;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  useReportSuccess(state, onSuccess);
  return (
    <form action={formAction}>
      <Stack direction="column" gap={4}>
        <Field name="name">
          <FieldLabel>Project name</FieldLabel>
          <Input name="name" required size="sm" />
          <ActionFieldError name="name" state={state} />
        </Field>
        <Field name="keyPrefix">
          <FieldLabel>Request key prefix</FieldLabel>
          <Input
            autoCapitalize="characters"
            maxLength={10}
            name="keyPrefix"
            pattern="[A-Z][A-Z0-9]{1,9}"
            required
            size="sm"
          />
          <FieldDescription>2–10 uppercase letters or digits.</FieldDescription>
          <ActionFieldError name="keyPrefix" state={state} />
        </Field>
        <Field name="slug">
          <FieldLabel>Project slug</FieldLabel>
          <Input
            autoCapitalize="none"
            name="slug"
            pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
            required
            size="sm"
          />
          <FieldDescription>
            Stable lowercase project identifier.
          </FieldDescription>
          <ActionFieldError name="slug" state={state} />
        </Field>
        <Field name="repositoryUrl">
          <FieldLabel>GitHub repository</FieldLabel>
          <Input
            autoCapitalize="none"
            name="repositoryUrl"
            placeholder="https://github.com/example-org/project"
            size="sm"
            type="url"
          />
          <FieldDescription>
            Optional canonical URL in the form
            https://github.com/owner/repository.
          </FieldDescription>
          <ActionFieldError name="repositoryUrl" state={state} />
        </Field>
        <Field name="description">
          <FieldLabel>Description</FieldLabel>
          <Textarea name="description" rows={4} />
          <ActionFieldError name="description" state={state} />
        </Field>
        <ActionResult fields={projectFields} state={state} />
        <FormActions cancel={cancel}>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Creating…" : "Create project"}
          </Button>
        </FormActions>
      </Stack>
    </form>
  );
}

const invitationFields = ["email", "role"] as const;

const memberRoleOptions = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

export function InvitationForm({
  action,
  canInviteOwner,
  cancel,
  onSuccess,
}: {
  action: FormAction;
  canInviteOwner: boolean;
  /** The dialog's Cancel, when the form is opened in one. */
  cancel?: ReactNode;
  onSuccess?: (message: string) => void;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  useReportSuccess(state, onSuccess);
  return (
    <form action={formAction}>
      <Stack direction="column" gap={4}>
        <Field name="email">
          <FieldLabel>Email address</FieldLabel>
          <Input
            autoComplete="email"
            name="email"
            required
            size="sm"
            type="email"
          />
          <ActionFieldError name="email" state={state} />
        </Field>
        <Field name="role">
          <FieldLabel>Role</FieldLabel>
          <Select
            defaultValue="member"
            items={
              canInviteOwner
                ? [...memberRoleOptions, { label: "Owner", value: "owner" }]
                : memberRoleOptions
            }
            name="role"
            size="sm"
          />
          <ActionFieldError name="role" state={state} />
        </Field>
        <ActionResult fields={invitationFields} state={state} />
        <FormActions cancel={cancel}>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Sending…" : "Send invitation"}
          </Button>
        </FormActions>
      </Stack>
    </form>
  );
}

/**
 * The members page's one primary action: the invitation, in a dialog.
 *
 * The dialog's submit is named "Send invitation" rather than after the
 * trigger, so the two never share an accessible name while it is open.
 */
export function InviteMemberDialog({
  action,
  canInviteOwner,
}: {
  action: FormAction;
  canInviteOwner: boolean;
}) {
  return (
    <FormDialog
      description="They receive an email with a link that signs them in to this organization."
      icon={UserPlus}
      title="Invite member"
      trigger="Invite member"
    >
      {(done) => (
        <InvitationForm
          action={action}
          canInviteOwner={canInviteOwner}
          cancel={<DialogCancel />}
          onSuccess={done}
        />
      )}
    </FormDialog>
  );
}

/**
 * The projects page's one primary action: registering a project, in a dialog.
 *
 * The action ends by redirecting to `/settings/projects`, the page this dialog
 * is on, so the form never sees a success state to report. The caller keys
 * this component on the number of projects instead: the redirect re-renders
 * the page with one more, and the new key mounts the dialog closed.
 * `/settings/projects/new` keeps the same form as a page of its own.
 */
export function CreateProjectDialog({ action }: { action: FormAction }) {
  return (
    <FormDialog
      description="A project is a canonical target for requests, with an optional GitHub repository."
      icon={FolderPlus}
      title="Create project"
      trigger="New project"
      width="lg"
    >
      {(done) => (
        <ProjectForm
          action={action}
          cancel={<DialogCancel />}
          onSuccess={done}
        />
      )}
    </FormDialog>
  );
}
