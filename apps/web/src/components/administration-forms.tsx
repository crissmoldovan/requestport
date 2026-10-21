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
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { useActionState, useEffect } from "react";

import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";
import type { AdministrationActionState } from "../lib/administration-actions.js";
import { postOrganizationCreate } from "../lib/organization-create.js";

/**
 * The organization, project and invitation forms, on native CUE++ controls.
 *
 * Section 7 gives every visible control one `Field` with a visible label, so no
 * form here wires an `id`/`htmlFor` pair by hand and every server-side field
 * failure has a line of its own to land on. A failure that names no field — or
 * names one this form does not draw — stays in the fixed banner.
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

export function ProjectForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, initialState);
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
        <Button disabled={pending} size="sm" type="submit" variant="primary">
          {pending ? "Creating…" : "Create project"}
        </Button>
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
}: {
  action: FormAction;
  canInviteOwner: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
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
        <Button disabled={pending} size="sm" type="submit" variant="primary">
          {pending ? "Inviting…" : "Invite member"}
        </Button>
      </Stack>
    </form>
  );
}
