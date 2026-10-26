"use client";

import {
  Checkbox,
  CheckboxGroup,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Radio,
  RadioGroup,
  Select,
} from "@cueplusplus/ui/forms";
import {
  CodeBlock,
  CopyButton,
  TwoStepButton,
} from "@cueplusplus/ui/instruments";
import {
  Link as CueLink,
  Disclosure,
  Stack,
  Stepper,
} from "@cueplusplus/ui/layout";
import { AlertDialog, Dialog, Sheet } from "@cueplusplus/ui/overlays";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import {
  agentScopes,
  privateTelemetryFields,
} from "@requestport/domain/browser";
import { Plus } from "lucide-react";
import NextLink from "next/link";
import { type ReactNode, useActionState, useRef, useState } from "react";

import type { AgentActionState } from "../app/(app)/agents/agent-action-state.js";
import { initialAgentActionState } from "../app/(app)/agents/agent-action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";

/**
 * Agent identity, credentials, grants and telemetry, on native CUE++ controls.
 *
 * Two rules from the specification shape the forms. Section 7 gives every
 * visible control one `Field` with a visible label and turns each choice set —
 * lanes, scopes, telemetry fields — into one named `CheckboxGroup` rather than
 * one field per box. Section 6.2 splits the destructive actions by whether they
 * can be taken back: rotating a credential leaves the previous secret working
 * through its overlap, so it arms in place, while permanently revoking a
 * principal, a credential or a delegated grant has no way back at all and asks
 * in a modal `AlertDialog` first.
 *
 * The one-time secret is shown in exactly one place — a modal the reader
 * dismisses — and is never written anywhere else in the page.
 */

type AgentFormAction = (
  previous: AgentActionState,
  formData: FormData,
) => Promise<AgentActionState>;

const defaultAgentScopes = new Set([
  "org:read",
  "project:read",
  "request:create",
  "request:read",
  "request:write",
  "question:answer",
  "work:claim",
  "work:update",
  "agent:register",
]);

const audienceOptions = [
  { label: "MCP", value: "mcp" },
  { label: "REST API", value: "api" },
];

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: AgentActionState;
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
 * The one-time secret, shown once and dismissed.
 *
 * The dialog is keyed on the secret itself rather than on a boolean, so a
 * second issue or rotation opens a fresh one and a dismissed secret can never
 * be reopened from state this component still holds.
 *
 * Because the dismissal is final, it is spent by one gesture only. Base UI's
 * dialog closes on Escape and on an outside press as well as on its own close
 * control, and any of the three would destroy the single copy of something
 * this dialog has just promised is never shown again — an operator moving the
 * modal aside to read the page beneath it would have to rotate the credential
 * or issue another to get one. So the scrim stops dismissing at all, and only
 * a press on the footer control — Base UI reports the reason alongside the new
 * state — records the credential as gone.
 */
function OneTimeCredential({ state }: { state: AgentActionState }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (state.status !== "success" || !state.plaintextKey) return null;
  const plaintextKey = state.plaintextKey;
  const open = dismissed !== plaintextKey;

  return (
    <Dialog.Root
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next && details.reason === "close-press")
          setDismissed(plaintextKey);
      }}
      open={open}
    >
      {/* One dismissal affordance, not two: the corner close would carry the
          same accessible name as the footer control and a screen-reader user
          would hear "Close" twice in one dialog. */}
      <Dialog.Content showCloseButton={false}>
        <Dialog.Title>Copy this credential now</Dialog.Title>
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
            Copy credential
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

/**
 * A modal question with two answers, in front of a form submission that cannot
 * be taken back.
 */
function IrreversibleSubmit({
  confirmLabel,
  description,
  disabled,
  form,
  title,
  trigger,
}: {
  confirmLabel: string;
  description: string;
  disabled?: boolean;
  form: React.RefObject<HTMLFormElement | null>;
  title: string;
  trigger: string;
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        render={
          <Button disabled={disabled} size="sm" variant="danger-outline">
            {trigger}
          </Button>
        }
      />
      <AlertDialog.Content>
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description}</AlertDialog.Description>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>Keep it</AlertDialog.Cancel>
          <AlertDialog.Action
            onClick={() => form.current?.requestSubmit()}
            tone="danger"
          >
            {confirmLabel}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/**
 * One choice set: a named group of boxes sharing a single submitted field.
 *
 * The group owns an error line for the same reason a single control does. A
 * rejection that names the group — an empty scope set, an empty telemetry
 * selection — is suppressed in the fixed banner by the field list its form
 * declares, so without this line the message would have nowhere at all to
 * land and the submission would look like it did nothing.
 */
function ChoiceGroup({
  children,
  hint,
  label,
  name,
  selected,
  state,
}: {
  children?: ReactNode;
  hint?: ReactNode;
  label: string;
  name: string;
  selected: readonly string[];
  state: AgentActionState;
}) {
  return (
    <Field name={name}>
      <FieldLabel>{label}</FieldLabel>
      <CheckboxGroup aria-label={label} defaultValue={[...selected]}>
        <Stack direction="row" gap={3} wrap>
          {children}
        </Stack>
      </CheckboxGroup>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <FieldError issues={actionFieldIssues(state, name)} />
    </Field>
  );
}

const createFields = ["displayName", "slug", "softwareName", "projectId"];

export function CreateAgentForm({
  action,
  allowOrganizationWide,
  idempotencyKey,
  onCreated,
  projects,
}: {
  action: AgentFormAction;
  allowOrganizationWide: boolean;
  idempotencyKey: string;
  /**
   * Told the slug a successful create stored — trimmed and lower-cased, as
   * the action's schema stores it. Given, the form submits through a client
   * wrapper that awaits the same action and then reports; without it the form
   * hands React the server action itself, as it always has.
   */
  onCreated?: (slug: string) => void;
  projects: Array<{ id: string; name: string }>;
}) {
  const [state, formAction, pending] = useActionState(
    onCreated
      ? async (previous: AgentActionState, formData: FormData) => {
          const result = await action(previous, formData);
          if (result.status === "success") {
            onCreated(
              String(formData.get("slug") ?? "")
                .trim()
                .toLowerCase(),
            );
          }
          return result;
        }
      : action,
    initialAgentActionState,
  );
  const projectItems = projects.map((project) => ({
    label: project.name,
    value: project.id,
  }));
  return (
    <form action={formAction}>
      <Stack direction="column" gap={4}>
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <Field name="displayName">
          <FieldLabel>Display name</FieldLabel>
          <Input name="displayName" required size="sm" />
          <FieldError issues={actionFieldIssues(state, "displayName")} />
        </Field>
        <Field name="slug">
          <FieldLabel>Agent slug</FieldLabel>
          <Input
            name="slug"
            pattern="[a-z0-9][a-z0-9-]{1,62}"
            required
            size="sm"
          />
          <FieldDescription>Stable lowercase identifier.</FieldDescription>
          <FieldError issues={actionFieldIssues(state, "slug")} />
        </Field>
        <Field name="softwareName">
          <FieldLabel>Software</FieldLabel>
          <Input name="softwareName" size="sm" />
          <FieldDescription>Optional product or CLI name.</FieldDescription>
          <FieldError issues={actionFieldIssues(state, "softwareName")} />
        </Field>
        <Field name="projectId">
          <FieldLabel>Default project</FieldLabel>
          <Select
            defaultValue={
              allowOrganizationWide ? "" : (projects[0]?.id ?? null)
            }
            items={
              allowOrganizationWide
                ? [{ label: "Organization-wide", value: "" }, ...projectItems]
                : projectItems
            }
            name="projectId"
            required={!allowOrganizationWide}
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "projectId")} />
        </Field>
        <Status fields={createFields} state={state} />
        <Button disabled={pending} size="sm" type="submit" variant="primary">
          {pending ? "Creating…" : "Create agent"}
        </Button>
      </Stack>
    </form>
  );
}

const issueFields = [
  "name",
  "projectId",
  "audience",
  "expiresInDays",
  "laneIds",
  "scopes",
];

export function IssueAgentKeyForm({
  action,
  agentPrincipalId,
  projects,
  defaultProjectId,
  lanes,
  idempotencyKey,
}: {
  action: AgentFormAction;
  agentPrincipalId: string;
  projects: Array<{ id: string; name: string }>;
  lanes: Array<{ id: string; projectId: string; name: string; slug: string }>;
  defaultProjectId: string | null;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAgentActionState,
  );
  return (
    <form action={formAction}>
      <Stack direction="column" gap={4}>
        <input name="agentPrincipalId" type="hidden" value={agentPrincipalId} />
        <input name="expectedVersion" type="hidden" value="0" />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <Field name="name">
          <FieldLabel>Credential name</FieldLabel>
          <Input
            name="name"
            placeholder="Claude Code on MacBook"
            required
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "name")} />
        </Field>
        <Field name="projectId">
          <FieldLabel>Project</FieldLabel>
          <Select
            defaultValue={defaultProjectId ?? projects[0]?.id ?? null}
            items={projects.map((project) => ({
              label: project.name,
              value: project.id,
            }))}
            name="projectId"
            placeholder="Select a project"
            required
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "projectId")} />
        </Field>
        <Field name="audience">
          <FieldLabel>Transport</FieldLabel>
          <Select
            defaultValue="mcp"
            items={audienceOptions}
            name="audience"
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "audience")} />
        </Field>
        <Field name="expiresInDays">
          <FieldLabel>Expires in days</FieldLabel>
          <Input
            defaultValue="90"
            max="365"
            min="1"
            name="expiresInDays"
            required
            size="sm"
            type="number"
          />
          <FieldDescription>1–365 days.</FieldDescription>
          <FieldError issues={actionFieldIssues(state, "expiresInDays")} />
        </Field>
        <ChoiceGroup
          hint="Leave every lane unchecked for project-wide access. Selected lanes must belong to the chosen project."
          label="Allowed lanes"
          name="laneIds"
          selected={[]}
          state={state}
        >
          {lanes.map((lane) => (
            <Checkbox
              key={lane.id}
              label={`${
                projects.find((project) => project.id === lane.projectId)
                  ?.name ?? "Project"
              } / ${lane.name}`}
              name="laneIds"
              size="sm"
              value={lane.id}
            />
          ))}
        </ChoiceGroup>
        <ChoiceGroup
          label="Allowed scopes"
          name="scopes"
          selected={agentScopes.filter((scope) =>
            defaultAgentScopes.has(scope),
          )}
          state={state}
        >
          {agentScopes.map((scope) => (
            <Checkbox
              key={scope}
              label={scope}
              name="scopes"
              size="sm"
              value={scope}
            />
          ))}
        </ChoiceGroup>
        <Status fields={issueFields} state={state} />
        <OneTimeCredential state={state} />
        <Button
          disabled={pending || projects.length === 0}
          size="sm"
          type="submit"
          variant="primary"
        >
          {pending ? "Issuing…" : "Issue one-time key"}
        </Button>
      </Stack>
    </form>
  );
}

export function AgentStatusForm({
  action,
  agentPrincipalId,
  currentStatus,
  expectedVersion,
  idempotencyKey,
}: {
  action: AgentFormAction;
  agentPrincipalId: string;
  currentStatus: "active" | "suspended" | "revoked";
  expectedVersion: number;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAgentActionState,
  );
  const form = useRef<HTMLFormElement>(null);
  const reversibleStatus = currentStatus === "active" ? "suspended" : "active";
  const [status, setStatus] = useState<string>(reversibleStatus);
  if (currentStatus === "revoked") {
    return (
      <p>
        This agent is permanently revoked. Its credentials and grants can no
        longer authenticate.
      </p>
    );
  }
  return (
    <form action={formAction} ref={form}>
      <Stack direction="column" gap={4}>
        <input name="agentPrincipalId" type="hidden" value={agentPrincipalId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <Field name="status">
          <FieldLabel>New status</FieldLabel>
          <Select
            items={[
              {
                label: currentStatus === "active" ? "Suspend" : "Reactivate",
                value: reversibleStatus,
              },
              { label: "Permanently revoke", value: "revoked" },
            ]}
            name="status"
            onValueChange={(next) => setStatus(next ?? reversibleStatus)}
            size="sm"
            value={status}
          />
          <FieldError issues={actionFieldIssues(state, "status")} />
        </Field>
        <Field name="reason">
          <FieldLabel>Reason</FieldLabel>
          <Input minLength={10} name="reason" required size="sm" />
          <FieldDescription>
            Recorded in the immutable security audit.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "reason")} />
        </Field>
        <Status fields={["status", "reason"]} state={state} />
        {status === "revoked" ? (
          <IrreversibleSubmit
            confirmLabel="Revoke permanently"
            description="A revoked principal can never authenticate again, and its credentials and delegated grants stop working immediately."
            disabled={pending}
            form={form}
            title="Permanently revoke this agent?"
            trigger="Revoke agent"
          />
        ) : (
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Updating…" : "Update agent status"}
          </Button>
        )}
      </Stack>
    </form>
  );
}

export function CredentialActions({
  agentPrincipalId,
  credentialId,
  expectedVersion,
  revokeIdempotencyKey,
  rotateIdempotencyKey,
  revokeAction,
  rotateAction,
}: {
  agentPrincipalId: string;
  credentialId: string;
  expectedVersion: number;
  revokeIdempotencyKey: string;
  rotateIdempotencyKey: string;
  revokeAction: AgentFormAction;
  rotateAction: AgentFormAction;
}) {
  const [revokeState, revokeFormAction, revoking] = useActionState(
    revokeAction,
    initialAgentActionState,
  );
  const [rotateState, rotateFormAction, rotating] = useActionState(
    rotateAction,
    initialAgentActionState,
  );
  const rotateForm = useRef<HTMLFormElement>(null);
  const revokeForm = useRef<HTMLFormElement>(null);
  return (
    <Stack direction="column" gap={2}>
      <form action={rotateFormAction} ref={rotateForm}>
        <input name="agentPrincipalId" type="hidden" value={agentPrincipalId} />
        <input name="credentialId" type="hidden" value={credentialId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input
          name="idempotencyKey"
          type="hidden"
          value={rotateIdempotencyKey}
        />
        <input name="overlapMinutes" type="hidden" value="15" />
        {/* Recoverable — the previous secret keeps working through its
            overlap — so the confirmation arms in place. */}
        <TwoStepButton
          disabled={rotating}
          onConfirm={() => rotateForm.current?.requestSubmit()}
          size="sm"
        >
          Rotate credential
        </TwoStepButton>
      </form>
      <form action={revokeFormAction} ref={revokeForm}>
        <input name="agentPrincipalId" type="hidden" value={agentPrincipalId} />
        <input name="credentialId" type="hidden" value={credentialId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input
          name="idempotencyKey"
          type="hidden"
          value={revokeIdempotencyKey}
        />
        <IrreversibleSubmit
          confirmLabel="Revoke credential"
          description="A revoked credential stops authenticating immediately and cannot be restored. Issue a replacement instead if the installation is still in use."
          disabled={revoking}
          form={revokeForm}
          title="Revoke this credential?"
          trigger="Revoke credential"
        />
      </form>
      <OneTimeCredential state={rotateState} />
      <Status state={rotateState} />
      <Status state={revokeState} />
    </Stack>
  );
}

export function OauthGrantActions({
  action,
  agentPrincipalId,
  grantId,
  expectedVersion,
  idempotencyKey,
}: {
  action: AgentFormAction;
  agentPrincipalId: string;
  grantId: string;
  expectedVersion: number;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAgentActionState,
  );
  const form = useRef<HTMLFormElement>(null);
  return (
    <form action={formAction} ref={form}>
      <Stack direction="column" gap={3}>
        <input name="agentPrincipalId" type="hidden" value={agentPrincipalId} />
        <input name="grantId" type="hidden" value={grantId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <Field name="reason">
          <FieldLabel>Revocation reason</FieldLabel>
          <Input minLength={10} name="reason" required size="sm" />
          <FieldDescription>
            Recorded in the immutable security audit.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "reason")} />
        </Field>
        <Status fields={["reason"]} state={state} />
        <IrreversibleSubmit
          confirmLabel="Revoke grant"
          description="The delegated grant stops working immediately and the person who delegated it has to consent again."
          disabled={pending}
          form={form}
          title="Revoke this delegated grant?"
          trigger="Revoke OAuth grant"
        />
      </Stack>
    </form>
  );
}

export function RevealWorkspaceForm({
  action,
  workspaceId,
  idempotencyKey,
}: {
  action: AgentFormAction;
  workspaceId: string;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAgentActionState,
  );
  return (
    <Disclosure label="Reveal private telemetry">
      <form action={formAction}>
        <Stack direction="column" gap={4}>
          <input name="workspaceId" type="hidden" value={workspaceId} />
          <input name="expectedVersion" type="hidden" value="0" />
          <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
          <ChoiceGroup label="Fields" name="fields" selected={[]} state={state}>
            {privateTelemetryFields.map((field) => (
              <Checkbox
                key={field}
                label={field}
                name="fields"
                size="sm"
                value={field}
              />
            ))}
          </ChoiceGroup>
          <Field name="reason">
            <FieldLabel>Reason</FieldLabel>
            <Input minLength={10} name="reason" required size="sm" />
            <FieldDescription>
              Required for the immutable security audit.
            </FieldDescription>
            <FieldError issues={actionFieldIssues(state, "reason")} />
          </Field>
          <Status fields={["fields", "reason"]} state={state} />
          {state.status === "success" && state.telemetryJson ? (
            <pre className="overflow-x-auto font-mono">
              <code>{state.telemetryJson}</code>
            </pre>
          ) : null}
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Revealing…" : "Reveal and audit"}
          </Button>
        </Stack>
      </form>
    </Disclosure>
  );
}

const connectSteps = [
  { id: "name", label: "name" },
  { id: "signin", label: "sign-in" },
  { id: "connect", label: "connect" },
] as const;

type ConnectStep = (typeof connectSteps)[number]["id"];

type ConnectableAgent = {
  id: string;
  slug: string;
  displayName: string;
  projectId: string | null;
};

type ConnectSheetProps = {
  /** The organization's agents, as the page last rendered them. */
  agents: readonly ConnectableAgent[];
  allowOrganizationWide: boolean;
  createAction: AgentFormAction;
  createIdempotencyKey: string;
  endpoints: { mcp: string; rest: string; metadata: string };
  issueAction: AgentFormAction;
  issueIdempotencyKey: string;
  lanes: Array<{ id: string; projectId: string; name: string; slug: string }>;
  projects: Array<{ id: string; name: string }>;
};

/**
 * One pass through the sheet. It is keyed on the open count by its parent, so
 * every opening starts from an empty create form: a finished pass's form,
 * whose action state still reads "created", is never shown again.
 */
function ConnectAgentSteps({
  agents,
  allowOrganizationWide,
  createAction,
  createIdempotencyKey,
  endpoints,
  issueAction,
  issueIdempotencyKey,
  lanes,
  onDone,
  projects,
}: ConnectSheetProps & { onDone: () => void }) {
  const [step, setStep] = useState<ConnectStep>("name");
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [method, setMethod] = useState<"oauth" | "key">("oauth");
  // The create action answers with a message, not the principal: the page it
  // revalidates hands the new agent back in `agents`, found by the slug the
  // action stored (trimmed and lower-cased, as its schema does).
  const created = createdSlug
    ? agents.find((agent) => agent.slug === createdSlug)
    : undefined;
  const index = connectSteps.findIndex((entry) => entry.id === step);
  const claudeCode = `claude mcp add --transport http requestport ${endpoints.mcp}`;
  return (
    <>
      <Stack direction="column" gap={5}>
        <Stepper
          current={step}
          label="Steps to connect an agent"
          onStepChange={(next) => setStep(next as ConnectStep)}
          steps={connectSteps}
        />
        {step === "name" ? (
          createdSlug ? (
            <p>
              {created?.displayName ?? createdSlug} is registered. Continue to
              decide how it signs in.
            </p>
          ) : (
            <CreateAgentForm
              action={createAction}
              allowOrganizationWide={allowOrganizationWide}
              idempotencyKey={createIdempotencyKey}
              onCreated={(slug) => {
                setCreatedSlug(slug);
                setStep("signin");
              }}
              projects={projects}
            />
          )
        ) : null}
        {step === "signin" ? (
          <Stack direction="column" gap={4}>
            <RadioGroup
              aria-label="How it signs in"
              onValueChange={(value) =>
                setMethod(value === "key" ? "key" : "oauth")
              }
              value={method}
            >
              <Radio
                label="OAuth (recommended): for Claude Code, Codex and other MCP clients. You approve it once in the browser."
                value="oauth"
              />
              <Radio
                label="API key: for scripts and CI. The key is shown once; keep it in your secret manager."
                value="key"
              />
            </RadioGroup>
            {method === "oauth" ? (
              <p>
                Nothing to copy. The first time the client connects, RequestPort
                opens a consent page in your browser: choose{" "}
                {created?.displayName ?? "this agent"} there.
              </p>
            ) : created ? (
              <IssueAgentKeyForm
                action={issueAction}
                agentPrincipalId={created.id}
                defaultProjectId={created.projectId}
                idempotencyKey={issueIdempotencyKey}
                lanes={lanes}
                projects={projects}
              />
            ) : (
              <p>
                The new agent is not listed yet. Issue its key from its own page
                once it appears in the table.
              </p>
            )}
          </Stack>
        ) : null}
        {step === "connect" ? (
          <Stack direction="column" gap={4}>
            {[
              { label: "MCP endpoint", value: endpoints.mcp },
              { label: "REST base URL", value: endpoints.rest },
            ].map((row) => (
              <Stack direction="column" gap={1} key={row.label}>
                <span className="text-fg-subtle">{row.label}</span>
                <Stack align="center" direction="row" gap={2}>
                  <code className="min-w-0 flex-1 truncate font-mono">
                    {row.value}
                  </code>
                  <CopyButton
                    aria-label={`Copy the ${row.label}`}
                    size="sm"
                    value={row.value}
                    variant="ghost"
                  />
                </Stack>
              </Stack>
            ))}
            <CodeBlock
              code={claudeCode}
              label="Add it to Claude Code"
              language="sh"
            />
            {created ? (
              <CueLink
                render={<NextLink href={`/agents/${created.id}`} />}
                variant="underline"
              >
                Manage {created.displayName}
              </CueLink>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
      <Sheet.Footer>
        {index === 0 ? (
          <Sheet.Close
            render={
              <Button size="sm" variant="secondary">
                Cancel
              </Button>
            }
          />
        ) : (
          <Button
            onClick={() => setStep(connectSteps[index - 1]?.id ?? "name")}
            size="sm"
            variant="secondary"
          >
            Back
          </Button>
        )}
        {step === "signin" ? (
          <Button
            onClick={() => setStep("connect")}
            size="sm"
            variant="primary"
          >
            Continue
          </Button>
        ) : null}
        {step === "connect" ? (
          <Button onClick={onDone} size="sm" variant="primary">
            Done
          </Button>
        ) : null}
        {step === "name" && createdSlug ? (
          <Button onClick={() => setStep("signin")} size="sm" variant="primary">
            Continue
          </Button>
        ) : null}
      </Sheet.Footer>
    </>
  );
}

/**
 * "Connect an agent" (ruling 258, the reference build's `screens/Agents.tsx`):
 * a right sheet with three steps — name and default project, how it signs in,
 * and where to point it.
 *
 * Nothing here is a new path to the server. The first step is the existing
 * `CreateAgentForm` with its action; the API-key choice is the existing
 * `IssueAgentKeyForm`, whose one-time secret appears in that form's own
 * dialog and nowhere else; the last step prints two addresses and Claude
 * Code's `claude mcp add` command for the MCP endpoint, none of which holds
 * or names a credential.
 */
export function ConnectAgentSheet(props: ConnectSheetProps) {
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState(0);
  // Not modal, as the settings dialogs and the requests filter sheet are not:
  // a modal sheet hides every other <body> child from assistive technology,
  // and cue-ui gives the Default project and Project Selects' listboxes
  // containers of their own there, so their options would be unreachable.
  // Pointer dismissal is off so a press inside an open listbox, which sits
  // outside the sheet, does not close it.
  return (
    <Sheet.Root
      disablePointerDismissal
      modal={false}
      onOpenChange={(next) => {
        if (next) setPass((count) => count + 1);
        setOpen(next);
      }}
      open={open}
    >
      <Sheet.Trigger
        render={
          <Button icon={Plus} size="sm" variant="primary">
            Connect an agent
          </Button>
        }
      />
      <Sheet.Content side="right">
        <Sheet.Title>Connect an agent</Sheet.Title>
        <Sheet.Description>
          Three steps. Nothing secret is pasted anywhere when the agent signs in
          with OAuth.
        </Sheet.Description>
        <ConnectAgentSteps
          {...props}
          key={pass}
          onDone={() => setOpen(false)}
        />
      </Sheet.Content>
    </Sheet.Root>
  );
}
