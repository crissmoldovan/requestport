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
import { TwoStepButton } from "@cueplusplus/ui/instruments";
import { Link as CueLink, Stack } from "@cueplusplus/ui/layout";
import { AlertDialog } from "@cueplusplus/ui/overlays";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import type {
  OrganizationProject,
  RequestDetail,
  RequestQuestionView,
  RequestState,
} from "@requestport/domain";
import {
  type RefObject,
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  answerQuestionAction,
  askQuestionAction,
  attachArtifactAction,
  closeQuestionAction,
  createRequestAction,
  linkRequestsAction,
  postMessageAction,
  previewRequestRouteAction,
  transitionRequestAction,
  unlinkRequestsAction,
  updateRequestAction,
} from "../app/(app)/requests/actions.js";
import type { RequestActionState } from "../app/(app)/requests/request-action-state.js";
import {
  initialRequestActionState,
  requestBannerMessage,
  requestFieldIssues,
} from "../app/(app)/requests/request-action-state.js";

/**
 * The request forms, on native CUE++ controls.
 *
 * Two rules from the specification shape every form here. Section 7 gives each
 * visible control one `Field` with a visible label, so no form still wires an
 * `id`/`htmlFor` pair by hand and every server-side field failure has an error
 * line to land on. Section 6.2 gives the destructive actions their two shapes:
 * a routine one arms and confirms in place through `TwoStepButton`, and one
 * that cannot be undone asks in a modal `AlertDialog`.
 */

type Option = { label: string; value: string };

const requestTypeOptions: Option[] = [
  { label: "Feature", value: "feature" },
  { label: "Bug", value: "bug" },
  { label: "Question", value: "question" },
  { label: "Investigation", value: "investigation" },
  { label: "Chore", value: "chore" },
];

const priorityOptions: Option[] = [
  { label: "Urgent", value: "urgent" },
  { label: "High", value: "high" },
  { label: "Normal", value: "normal" },
  { label: "Low", value: "low" },
];

const visibilityOptions: Option[] = [
  { label: "Organization", value: "organization" },
  { label: "Participants and project team", value: "restricted" },
];

const sensitivityOptions: Option[] = [
  { label: "Normal", value: "normal" },
  { label: "Sensitive (requires restricted visibility)", value: "sensitive" },
];

const editSensitivityOptions: Option[] = [
  { label: "Normal", value: "normal" },
  { label: "Sensitive", value: "sensitive" },
];

const relationshipOptions: Option[] = [
  { label: "Related to", value: "related_to" },
  { label: "Blocks", value: "blocks" },
  { label: "Depends on", value: "depends_on" },
  { label: "Duplicates", value: "duplicates" },
  { label: "Supersedes", value: "supersedes" },
  { label: "Derived from", value: "derived_from" },
];

const validationResultOptions: Option[] = [
  { label: "Passed", value: "passed" },
  { label: "Failed", value: "failed" },
  { label: "Not run", value: "not_run" },
];

const answerModeOptions: Option[] = [
  { label: "Single answer", value: "single" },
  { label: "Multiple answers", value: "multiple" },
];

const freeTextOptions: Option[] = [
  { label: "Allow free text", value: "true" },
  { label: "Choices only", value: "false" },
];

const escalationOptions: Option[] = [
  { label: "Escalate 1h overdue", value: "60" },
  { label: "Escalate 4h overdue", value: "240" },
  { label: "Escalate 1d overdue", value: "1440" },
  { label: "No escalation", value: "none" },
];

function projectOptions(projects: OrganizationProject[]): Option[] {
  return projects.map((project) => ({
    label: `${project.keyPrefix} · ${project.name}`,
    value: project.id,
  }));
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
  state: RequestActionState;
}) {
  const failure = requestBannerMessage(state, fields);
  if (failure) {
    return (
      <div role="alert">
        <Row>
          <Chip tone="danger">Error</Chip>
          <span>{failure}</span>
        </Row>
      </div>
    );
  }
  if (state.status !== "success") return null;

  return (
    <div role="status">
      <Row>
        <Chip tone="ok">Done</Chip>
        <span>{state.message}</span>
      </Row>
    </div>
  );
}

function ResetOnSuccess({
  form,
  status,
}: {
  form: RefObject<HTMLFormElement | null>;
  status: string;
}) {
  useEffect(() => {
    if (status === "success") form.current?.reset();
  }, [form, status]);
  return null;
}

const createFields = [
  "title",
  "sourceProjectId",
  "targetProjectId",
  "type",
  "priority",
  "labels",
  "visibility",
  "sensitivity",
  "descriptionMd",
  "acceptanceCriteria",
] as const;

export function RequestCreateForm({
  canManageRouting,
  idempotencyKey,
  projects,
}: {
  canManageRouting: boolean;
  idempotencyKey: string;
  projects: OrganizationProject[];
}) {
  const [state, action, pending] = useActionState(
    createRequestAction,
    initialRequestActionState,
  );
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [targetProjectId, setTargetProjectId] = useState("");
  const [requestType, setRequestType] = useState<
    "feature" | "bug" | "question" | "chore" | "investigation"
  >("feature");
  const [priority, setPriority] = useState<
    "urgent" | "high" | "normal" | "low"
  >("normal");
  const [preview, setPreview] = useState<
    Awaited<ReturnType<typeof previewRequestRouteAction>>
  >({ status: "invalid" });
  const [previewPending, startPreview] = useTransition();
  useEffect(() => {
    if (!targetProjectId) {
      setPreview({ status: "invalid" });
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      startPreview(async () => {
        const result = await previewRequestRouteAction({
          sourceProjectId,
          targetProjectId,
          type: requestType,
          priority,
        });
        if (current) setPreview(result);
      });
    }, 180);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [priority, requestType, sourceProjectId, targetProjectId]);
  const routeDenied = preview.status === "denied";
  const sourceOptions: Option[] = [
    { label: "Me directly", value: "" },
    ...projectOptions(
      projects.filter(
        (project) => project.status === "active" && project.canRepresent,
      ),
    ),
  ];

  return (
    <form action={action}>
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={4}>
        <Field name="title">
          <FieldLabel>Title</FieldLabel>
          <Input
            maxLength={240}
            name="title"
            placeholder="What should change?"
            required
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "title")} />
        </Field>
        <Field name="sourceProjectId">
          <FieldLabel>Source</FieldLabel>
          <Select
            items={sourceOptions}
            name="sourceProjectId"
            onValueChange={(next) => setSourceProjectId(next ?? "")}
            size="sm"
            value={sourceProjectId}
          />
          <FieldError issues={requestFieldIssues(state, "sourceProjectId")} />
        </Field>
        <Field name="targetProjectId">
          <FieldLabel>Target project</FieldLabel>
          <Select
            items={projectOptions(projects)}
            name="targetProjectId"
            onValueChange={(next) => setTargetProjectId(next ?? "")}
            placeholder="Select a project"
            required
            size="sm"
            value={targetProjectId || null}
          />
          <FieldError issues={requestFieldIssues(state, "targetProjectId")} />
        </Field>
        <Field name="type">
          <FieldLabel>Type</FieldLabel>
          <Select
            items={requestTypeOptions}
            name="type"
            onValueChange={(next) =>
              setRequestType((next ?? requestType) as typeof requestType)
            }
            size="sm"
            value={requestType}
          />
          <FieldError issues={requestFieldIssues(state, "type")} />
        </Field>
        <Field name="priority">
          <FieldLabel>Priority</FieldLabel>
          <Select
            items={priorityOptions}
            name="priority"
            onValueChange={(next) =>
              setPriority((next ?? priority) as typeof priority)
            }
            size="sm"
            value={priority}
          />
          <FieldError issues={requestFieldIssues(state, "priority")} />
        </Field>
        <Field name="labels">
          <FieldLabel>Labels</FieldLabel>
          <Input name="labels" placeholder="api, agent, ui" size="sm" />
          <FieldDescription>Comma separated.</FieldDescription>
          <FieldError issues={requestFieldIssues(state, "labels")} />
        </Field>
        <Field name="visibility">
          <FieldLabel>Visibility</FieldLabel>
          <Select
            defaultValue="organization"
            items={visibilityOptions}
            name="visibility"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "visibility")} />
        </Field>
        <Field name="sensitivity">
          <FieldLabel>Sensitivity</FieldLabel>
          <Select
            defaultValue="normal"
            items={sensitivityOptions}
            name="sensitivity"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "sensitivity")} />
        </Field>
        <Field name="descriptionMd">
          <FieldLabel>Description (Markdown)</FieldLabel>
          <Textarea
            name="descriptionMd"
            placeholder="Context, desired behavior, constraints, and relevant links."
            required
            rows={9}
          />
          <FieldError issues={requestFieldIssues(state, "descriptionMd")} />
        </Field>
        <Field name="acceptanceCriteria">
          <FieldLabel>Acceptance criteria</FieldLabel>
          <Textarea
            name="acceptanceCriteria"
            placeholder="One criterion per line"
            rows={4}
          />
          <FieldDescription>
            Required before a target maintainer accepts the request.
          </FieldDescription>
          <FieldError
            issues={requestFieldIssues(state, "acceptanceCriteria")}
          />
        </Field>
        {targetProjectId ? (
          <div aria-live="polite">
            <Row>
              {previewPending ? (
                <span>Checking the current routing policy…</span>
              ) : preview.status === "allowed" ||
                preview.status === "denied" ? (
                <Stack align="center" direction="row" gap={2} wrap>
                  <Chip tone={routeDenied ? "danger" : "ok"}>
                    {routeDenied ? "Route denied" : "Route allowed"}
                  </Chip>
                  <span>
                    {preview.reason.replaceAll("_", " ")} · policy v
                    {preview.policyVersion}
                    {preview.matchedRuleId
                      ? ` · rule ${preview.matchedRuleId.slice(0, 8)}`
                      : ""}
                  </span>
                  {routeDenied && canManageRouting ? (
                    <CueLink href="/settings/routing" variant="underline">
                      Review routing policy
                    </CueLink>
                  ) : null}
                </Stack>
              ) : (
                <span>
                  The routing preview is unavailable. Submission will still
                  recheck policy.
                </span>
              )}
            </Row>
          </div>
        ) : null}
        <ActionResult fields={createFields} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button
            disabled={pending}
            name="intent"
            size="sm"
            type="submit"
            value="draft"
            variant="secondary"
          >
            Save draft
          </Button>
          <Button
            disabled={pending || previewPending || routeDenied}
            name="intent"
            size="sm"
            type="submit"
            value="submit"
            variant="primary"
          >
            Create and submit
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

type RequestAction =
  | "submit_request"
  | "begin_triage"
  | "accept_request"
  | "decline_request"
  | "mark_duplicate"
  | "supersede_request"
  | "plan_request"
  | "begin_request_work"
  | "block_request"
  | "resume_request"
  | "withdraw_request"
  | "cancel_request"
  | "reopen_request"
  | "complete_request"
  | "verify_request";

const stateActions: Partial<
  Record<RequestState, Array<{ action: RequestAction; label: string }>>
> = {
  accepted: [
    { action: "begin_request_work", label: "Start work" },
    { action: "plan_request", label: "Mark planned" },
    { action: "block_request", label: "Block" },
    { action: "cancel_request", label: "Cancel" },
  ],
  blocked: [
    { action: "resume_request", label: "Resume" },
    { action: "cancel_request", label: "Cancel" },
  ],
  cancelled: [],
  completed: [
    { action: "verify_request", label: "Verify" },
    { action: "reopen_request", label: "Reopen" },
  ],
  declined: [{ action: "reopen_request", label: "Reopen" }],
  duplicate: [{ action: "reopen_request", label: "Reopen" }],
  draft: [{ action: "submit_request", label: "Submit" }],
  in_progress: [
    { action: "complete_request", label: "Complete" },
    { action: "block_request", label: "Block" },
    { action: "cancel_request", label: "Cancel" },
  ],
  planned: [
    { action: "begin_request_work", label: "Start work" },
    { action: "block_request", label: "Block" },
    { action: "cancel_request", label: "Cancel" },
  ],
  submitted: [
    { action: "begin_triage", label: "Begin triage" },
    { action: "withdraw_request", label: "Withdraw" },
    { action: "cancel_request", label: "Cancel" },
  ],
  superseded: [],
  triage: [
    { action: "accept_request", label: "Accept" },
    { action: "decline_request", label: "Decline" },
    { action: "mark_duplicate", label: "Mark duplicate" },
    { action: "supersede_request", label: "Mark superseded" },
    { action: "block_request", label: "Block" },
    { action: "cancel_request", label: "Cancel" },
  ],
  waiting_human: [{ action: "cancel_request", label: "Cancel" }],
  waiting_requester: [{ action: "cancel_request", label: "Cancel" }],
  verified: [{ action: "reopen_request", label: "Reopen" }],
};

const actionsRequiringReason = new Set<RequestAction>([
  "accept_request",
  "decline_request",
  "mark_duplicate",
  "supersede_request",
  "block_request",
  "resume_request",
  "withdraw_request",
  "cancel_request",
  "reopen_request",
  "verify_request",
]);

/**
 * The two transitions a request cannot come back from.
 *
 * `cancelled` and `superseded` are the only states with no onward transition at
 * all — `stateActions` gives both an empty list — so these are the two that
 * earn a modal question rather than an in-place confirmation.
 */
const irreversibleTransitions: Partial<
  Record<
    RequestAction,
    {
      cancel: string;
      confirm: string;
      description: string;
      title: string;
      trigger: string;
    }
  >
> = {
  cancel_request: {
    cancel: "Keep it",
    confirm: "Cancel this request",
    description:
      "This request cannot be transitioned again once it is cancelled.",
    title: "Cancel this request?",
    trigger: "Cancel request",
  },
  supersede_request: {
    cancel: "Keep it",
    confirm: "Supersede this request",
    description:
      "This request cannot be transitioned again once it is superseded.",
    title: "Supersede this request?",
    trigger: "Supersede request",
  },
};

/**
 * The transition fields every action draws, and the ones only some do.
 *
 * `ActionResult` suppresses the banner for a field the form owns, so the list
 * it is given has to be the fields actually on screen for the chosen
 * transition. A completion-only field named while a different transition is
 * selected has no error line of its own to appear on, and claiming it anyway
 * would take the message out of the banner too — losing it entirely.
 */
const constantTransitionFields = ["action", "reason"] as const;

const completionReportFields = [
  "outcomeMd",
  "changedRepositories",
  "validationCommand",
  "validationResult",
  "validationSummary",
  "risksMd",
  "followupsMd",
  "verificationStepsMd",
] as const;

export function RequestTransitionForm({
  idempotencyKey,
  request,
}: {
  idempotencyKey: string;
  request: Pick<RequestDetail, "allowedActions" | "id" | "state" | "version">;
}) {
  const available = (stateActions[request.state] ?? []).filter((item) =>
    request.allowedActions.includes(item.action),
  );
  const [selected, setSelected] = useState<RequestAction | "">(
    available[0]?.action ?? "",
  );
  const [state, action, pending] = useActionState(
    transitionRequestAction,
    initialRequestActionState,
  );
  const form = useRef<HTMLFormElement>(null);
  if (available.length === 0) {
    return <p>No manual transition is available from this state.</p>;
  }
  const completion = selected === "complete_request";
  const verification = selected === "verify_request";
  const related =
    selected === "mark_duplicate" || selected === "supersede_request";
  const reasonRequired = actionsRequiringReason.has(selected as RequestAction);
  const irreversible = irreversibleTransitions[selected as RequestAction];
  const drawnFields = [
    ...constantTransitionFields,
    ...(completion ? completionReportFields : []),
    ...(verification ? ["verificationEvidence"] : []),
    ...(related ? ["relatedRequestId"] : []),
  ];

  return (
    <form action={action} ref={form}>
      <input name="requestId" type="hidden" value={request.id} />
      <input name="expectedVersion" type="hidden" value={request.version} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        <Field name="action">
          <FieldLabel>Transition</FieldLabel>
          <Select
            items={available.map((item) => ({
              label: item.label,
              value: item.action,
            }))}
            name="action"
            onValueChange={(next) =>
              setSelected((next ?? selected) as RequestAction)
            }
            size="sm"
            value={selected}
          />
          <FieldError issues={requestFieldIssues(state, "action")} />
        </Field>
        <Field name="reason">
          <FieldLabel>Reason</FieldLabel>
          <Input name="reason" required={reasonRequired} size="sm" />
          <FieldDescription>
            {reasonRequired
              ? "Recorded on the transition. Required for this action."
              : "Recorded on the transition. Optional for this action."}
          </FieldDescription>
          <FieldError issues={requestFieldIssues(state, "reason")} />
        </Field>
        {completion ? (
          <>
            <Field name="outcomeMd">
              <FieldLabel>Outcome</FieldLabel>
              <Textarea name="outcomeMd" required rows={4} />
              <FieldError issues={requestFieldIssues(state, "outcomeMd")} />
            </Field>
            <Field name="changedRepositories">
              <FieldLabel>Changed repositories</FieldLabel>
              <Textarea
                name="changedRepositories"
                placeholder="One credential-free HTTPS repository URL per line; optionally add a commit SHA after a space."
                rows={2}
              />
              <FieldError
                issues={requestFieldIssues(state, "changedRepositories")}
              />
            </Field>
            <Field name="validationCommand">
              <FieldLabel>Validation command</FieldLabel>
              <Input name="validationCommand" required size="sm" />
              <FieldError
                issues={requestFieldIssues(state, "validationCommand")}
              />
            </Field>
            <Field name="validationResult">
              <FieldLabel>Validation result</FieldLabel>
              <Select
                defaultValue="passed"
                items={validationResultOptions}
                name="validationResult"
                size="sm"
              />
              <FieldError
                issues={requestFieldIssues(state, "validationResult")}
              />
            </Field>
            <Field name="validationSummary">
              <FieldLabel>Validation summary</FieldLabel>
              <Input name="validationSummary" size="sm" />
              <FieldError
                issues={requestFieldIssues(state, "validationSummary")}
              />
            </Field>
            <Field name="risksMd">
              <FieldLabel>Risks</FieldLabel>
              <Textarea name="risksMd" rows={3} />
              <FieldError issues={requestFieldIssues(state, "risksMd")} />
            </Field>
            <Field name="followupsMd">
              <FieldLabel>Follow-ups</FieldLabel>
              <Textarea name="followupsMd" rows={3} />
              <FieldError issues={requestFieldIssues(state, "followupsMd")} />
            </Field>
            <Field name="verificationStepsMd">
              <FieldLabel>Verification steps</FieldLabel>
              <Textarea name="verificationStepsMd" required rows={3} />
              <FieldError
                issues={requestFieldIssues(state, "verificationStepsMd")}
              />
            </Field>
          </>
        ) : (
          <>
            <input name="outcomeMd" type="hidden" value="" />
            <input name="changedRepositories" type="hidden" value="" />
            <input name="validationCommand" type="hidden" value="" />
            <input name="validationResult" type="hidden" value="not_run" />
            <input name="validationSummary" type="hidden" value="" />
            <input name="risksMd" type="hidden" value="" />
            <input name="followupsMd" type="hidden" value="" />
            <input name="verificationStepsMd" type="hidden" value="" />
          </>
        )}
        {verification ? (
          <Field name="verificationEvidence">
            <FieldLabel>Verification evidence</FieldLabel>
            <Textarea name="verificationEvidence" required rows={3} />
            <FieldError
              issues={requestFieldIssues(state, "verificationEvidence")}
            />
          </Field>
        ) : (
          <input name="verificationEvidence" type="hidden" value="" />
        )}
        {related ? (
          <Field name="relatedRequestId">
            <FieldLabel>Related request UUID</FieldLabel>
            <Input name="relatedRequestId" required size="sm" />
            <FieldError
              issues={requestFieldIssues(state, "relatedRequestId")}
            />
          </Field>
        ) : (
          <input name="relatedRequestId" type="hidden" value="" />
        )}
        <ActionResult fields={drawnFields} state={state} />
        {irreversible ? (
          <AlertDialog.Root>
            <AlertDialog.Trigger
              render={
                <Button
                  disabled={pending}
                  size="sm"
                  type="button"
                  variant="danger-outline"
                />
              }
            >
              {irreversible.trigger}
            </AlertDialog.Trigger>
            <AlertDialog.Content>
              <AlertDialog.Title>{irreversible.title}</AlertDialog.Title>
              <AlertDialog.Description>
                {irreversible.description}
              </AlertDialog.Description>
              <AlertDialog.Footer>
                <AlertDialog.Cancel>{irreversible.cancel}</AlertDialog.Cancel>
                <AlertDialog.Action
                  onClick={() => form.current?.requestSubmit()}
                  tone="danger"
                >
                  {irreversible.confirm}
                </AlertDialog.Action>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog.Root>
        ) : (
          <Stack direction="row" gap={2} wrap>
            <Button
              disabled={pending || !selected}
              size="sm"
              type="submit"
              variant="primary"
            >
              Apply
            </Button>
          </Stack>
        )}
      </Stack>
    </form>
  );
}

const messageFields = ["bodyMd", "visibility", "mentionUserIds"] as const;

export function MessageComposer({
  idempotencyKey,
  requestId,
}: {
  idempotencyKey: string;
  requestId: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    postMessageAction,
    initialRequestActionState,
  );
  return (
    <form action={action} ref={ref}>
      <ResetOnSuccess form={ref} status={state.status} />
      <input name="requestId" type="hidden" value={requestId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        <Field name="bodyMd">
          <FieldLabel>Comment</FieldLabel>
          <Textarea
            name="bodyMd"
            placeholder="Add a Markdown comment…"
            required
            rows={3}
          />
          <FieldError issues={requestFieldIssues(state, "bodyMd")} />
        </Field>
        <Field name="visibility">
          <FieldLabel>Comment visibility</FieldLabel>
          <Select
            defaultValue="organization"
            items={[
              { label: "Organization", value: "organization" },
              { label: "Restricted", value: "restricted" },
            ]}
            name="visibility"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "visibility")} />
        </Field>
        <Field name="mentionUserIds">
          <FieldLabel>Mention user IDs</FieldLabel>
          <Input
            name="mentionUserIds"
            placeholder="Comma-separated user IDs"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "mentionUserIds")} />
        </Field>
        <ActionResult fields={messageFields} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            Post comment
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

const editFields = [
  "title",
  "descriptionMd",
  "priority",
  "visibility",
  "sensitivity",
] as const;

export function RequestEditForm({
  idempotencyKey,
  request,
}: {
  idempotencyKey: string;
  request: Pick<
    RequestDetail,
    | "descriptionMd"
    | "id"
    | "priority"
    | "sensitivity"
    | "title"
    | "version"
    | "visibility"
  >;
}) {
  const [state, action, pending] = useActionState(
    updateRequestAction,
    initialRequestActionState,
  );
  return (
    <form action={action}>
      <input name="requestId" type="hidden" value={request.id} />
      <input name="expectedVersion" type="hidden" value={request.version} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        <Field name="title">
          <FieldLabel>Request title</FieldLabel>
          <Input
            defaultValue={request.title}
            maxLength={240}
            name="title"
            required
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "title")} />
        </Field>
        <Field name="descriptionMd">
          <FieldLabel>Request description</FieldLabel>
          <Textarea
            defaultValue={request.descriptionMd}
            name="descriptionMd"
            required
            rows={8}
          />
          <FieldError issues={requestFieldIssues(state, "descriptionMd")} />
        </Field>
        <Field name="priority">
          <FieldLabel>Priority</FieldLabel>
          <Select
            defaultValue={request.priority}
            items={priorityOptions}
            name="priority"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "priority")} />
        </Field>
        <Field name="visibility">
          <FieldLabel>Visibility</FieldLabel>
          <Select
            defaultValue={request.visibility}
            items={visibilityOptions}
            name="visibility"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "visibility")} />
        </Field>
        <Field name="sensitivity">
          <FieldLabel>Sensitivity</FieldLabel>
          <Select
            defaultValue={request.sensitivity}
            items={editSensitivityOptions}
            name="sensitivity"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "sensitivity")} />
        </Field>
        <ActionResult fields={editFields} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Save request
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

const relationshipFields = ["type", "toRequestId"] as const;

export function RelationshipForm({
  idempotencyKey,
  requestId,
}: {
  idempotencyKey: string;
  requestId: string;
}) {
  const [state, action, pending] = useActionState(
    linkRequestsAction,
    initialRequestActionState,
  );
  return (
    <form action={action}>
      <input name="fromRequestId" type="hidden" value={requestId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        <Field name="type">
          <FieldLabel>Relationship type</FieldLabel>
          <Select
            defaultValue="related_to"
            items={relationshipOptions}
            name="type"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "type")} />
        </Field>
        <Field name="toRequestId">
          <FieldLabel>Related request UUID</FieldLabel>
          <Input
            name="toRequestId"
            placeholder="Related request UUID"
            required
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "toRequestId")} />
        </Field>
        <ActionResult fields={relationshipFields} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Link
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

export function UnlinkRelationshipForm({
  idempotencyKey,
  relationshipId,
  requestId,
}: {
  idempotencyKey: string;
  relationshipId: string;
  requestId: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    unlinkRequestsAction,
    initialRequestActionState,
  );
  return (
    <form action={action} ref={form}>
      <input name="requestId" type="hidden" value={requestId} />
      <input name="relationshipId" type="hidden" value={relationshipId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={2}>
        {/* Routine and reversible — the link can simply be made again — so the
            confirmation arms in place rather than opening a modal. */}
        <TwoStepButton
          disabled={pending}
          onConfirm={() => form.current?.requestSubmit()}
          size="sm"
        >
          Unlink request
        </TwoStepButton>
        <ActionResult fields={[]} state={state} />
      </Stack>
    </form>
  );
}

export function CloseQuestionForm({
  idempotencyKey,
  question,
  requestId,
}: {
  idempotencyKey: string;
  question: Pick<RequestQuestionView, "id" | "version">;
  requestId: string;
}) {
  const [state, action, pending] = useActionState(
    closeQuestionAction,
    initialRequestActionState,
  );
  return (
    <form action={action}>
      <input name="requestId" type="hidden" value={requestId} />
      <input name="questionId" type="hidden" value={question.id} />
      <input name="expectedVersion" type="hidden" value={question.version} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        <Field name="reason">
          <FieldLabel>Closing reason</FieldLabel>
          <Input name="reason" required size="sm" />
          <FieldError issues={requestFieldIssues(state, "reason")} />
        </Field>
        <ActionResult fields={["reason"]} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Close answers
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

const askFields = [
  "bodyMd",
  "choices",
  "audience",
  "answerMode",
  "allowFreeText",
  "blocksRequest",
  "deadlineAt",
  "escalateAfterMinutes",
] as const;

export function AskQuestionForm({
  idempotencyKey,
  members,
  request,
}: {
  idempotencyKey: string;
  members: Array<{ userId: string; name: string; email: string }>;
  request: Pick<RequestDetail, "id" | "permissions" | "state" | "version">;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    askQuestionAction,
    initialRequestActionState,
  );
  const canBlock =
    request.permissions.canAskBlocking &&
    ["triage", "accepted", "planned", "in_progress", "completed"].includes(
      request.state,
    );
  // The retired native control grouped its audiences with `optgroup`, which the
  // installed `Select` has no equivalent for. The grouping is carried in the
  // row's own label instead, so the submitted values — `role:owner`,
  // `user:<id>` — are byte-for-byte the ones the action already parses.
  const audienceOptions: Option[] = [
    { label: "Project maintainers", value: "project_maintainers" },
    { label: "Requester", value: "requester" },
    { label: "Role · Organization owners", value: "role:owner" },
    { label: "Role · Organization admins", value: "role:admin" },
    { label: "Role · Organization members", value: "role:member" },
    ...members.map((member) => ({
      label: `Member · ${member.name} · ${member.email}`,
      value: `user:${member.userId}`,
    })),
  ];

  return (
    <form action={action} ref={ref}>
      <ResetOnSuccess form={ref} status={state.status} />
      <input name="requestId" type="hidden" value={request.id} />
      <input name="expectedVersion" type="hidden" value={request.version} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        <Field name="bodyMd">
          <FieldLabel>Question</FieldLabel>
          <Textarea
            name="bodyMd"
            placeholder="What needs clarification?"
            required
            rows={3}
          />
          <FieldError issues={requestFieldIssues(state, "bodyMd")} />
        </Field>
        <Field name="choices">
          <FieldLabel>Structured answer choices</FieldLabel>
          <Textarea
            name="choices"
            placeholder="Optional choices, one per line"
            rows={2}
          />
          <FieldError issues={requestFieldIssues(state, "choices")} />
        </Field>
        <Field name="audience">
          <FieldLabel>Audience</FieldLabel>
          <Select
            defaultValue="project_maintainers"
            items={audienceOptions}
            name="audience"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "audience")} />
        </Field>
        <Field name="answerMode">
          <FieldLabel>Answer mode</FieldLabel>
          <Select
            defaultValue="single"
            items={answerModeOptions}
            name="answerMode"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "answerMode")} />
        </Field>
        <Field name="allowFreeText">
          <FieldLabel>Free-text answers</FieldLabel>
          <Select
            defaultValue="true"
            items={freeTextOptions}
            name="allowFreeText"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "allowFreeText")} />
        </Field>
        <Field name="blocksRequest">
          <FieldLabel>Blocking behavior</FieldLabel>
          <Select
            defaultValue="false"
            items={[
              { label: "Non-blocking", value: "false" },
              { disabled: !canBlock, label: "Block request", value: "true" },
            ]}
            name="blocksRequest"
            size="sm"
          />
          <FieldError issues={requestFieldIssues(state, "blocksRequest")} />
        </Field>
        <Field name="deadlineAt">
          <FieldLabel>Deadline</FieldLabel>
          <Input name="deadlineAt" size="sm" type="datetime-local" />
          <FieldError issues={requestFieldIssues(state, "deadlineAt")} />
        </Field>
        <Field name="escalateAfterMinutes">
          <FieldLabel>Overdue escalation</FieldLabel>
          <Select
            defaultValue="60"
            items={escalationOptions}
            name="escalateAfterMinutes"
            size="sm"
          />
          <FieldError
            issues={requestFieldIssues(state, "escalateAfterMinutes")}
          />
        </Field>
        <ActionResult fields={askFields} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Ask
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

export function AnswerQuestionForm({
  idempotencyKey,
  question,
}: {
  idempotencyKey: string;
  question: Pick<
    RequestQuestionView,
    "allowFreeText" | "choices" | "id" | "version"
  >;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    answerQuestionAction,
    initialRequestActionState,
  );
  // The question's own shape decides which of the two answer inputs exists,
  // so it decides which failures this form can show on a field of their own.
  const drawnFields = [
    ...(question.choices.length > 0 ? ["choice"] : []),
    ...(question.allowFreeText ? ["bodyMd"] : []),
  ];
  return (
    <form action={action} ref={ref}>
      <ResetOnSuccess form={ref} status={state.status} />
      <input name="questionId" type="hidden" value={question.id} />
      <input name="expectedVersion" type="hidden" value={question.version} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        {question.choices.length > 0 ? (
          <Field name="choice">
            <FieldLabel>Structured answer</FieldLabel>
            <Select
              items={question.choices.map((choice) => ({
                label: choice,
                value: choice,
              }))}
              name="choice"
              placeholder={
                question.allowFreeText
                  ? "Optional structured answer"
                  : "Choose an answer"
              }
              required={!question.allowFreeText}
              size="sm"
            />
            <FieldError issues={requestFieldIssues(state, "choice")} />
          </Field>
        ) : null}
        {question.allowFreeText ? (
          <Field name="bodyMd">
            <FieldLabel>Answer</FieldLabel>
            <Textarea
              name="bodyMd"
              placeholder="Answer in Markdown…"
              required={question.choices.length === 0}
              rows={2}
            />
            <FieldError issues={requestFieldIssues(state, "bodyMd")} />
          </Field>
        ) : (
          <input name="bodyMd" type="hidden" value="structured-answer" />
        )}
        <ActionResult fields={drawnFields} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            Answer
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

const artifactFields = ["kind", "externalUrl", "mediaType", "sha256"] as const;

export function ArtifactLinkForm({
  idempotencyKey,
  requestId,
}: {
  idempotencyKey: string;
  requestId: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    attachArtifactAction,
    initialRequestActionState,
  );
  return (
    <form action={action} ref={ref}>
      <ResetOnSuccess form={ref} status={state.status} />
      <input name="requestId" type="hidden" value={requestId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={3}>
        <Field name="kind">
          <FieldLabel>Kind</FieldLabel>
          <Input name="kind" placeholder="PR, run, log" required size="sm" />
          <FieldError issues={requestFieldIssues(state, "kind")} />
        </Field>
        <Field name="externalUrl">
          <FieldLabel>External URL</FieldLabel>
          <Input
            name="externalUrl"
            placeholder="https://…"
            required
            size="sm"
            type="url"
          />
          <FieldDescription>
            RequestPort stores the link and its metadata only; no artifact bytes
            are copied.
          </FieldDescription>
          <FieldError issues={requestFieldIssues(state, "externalUrl")} />
        </Field>
        <Field name="mediaType">
          <FieldLabel>Media type</FieldLabel>
          <Input name="mediaType" placeholder="Optional" size="sm" />
          <FieldError issues={requestFieldIssues(state, "mediaType")} />
        </Field>
        <Field name="sha256">
          <FieldLabel>Checksum</FieldLabel>
          <Input name="sha256" placeholder="SHA-256, optional" size="sm" />
          <FieldError issues={requestFieldIssues(state, "sha256")} />
        </Field>
        <ActionResult fields={artifactFields} state={state} />
        <Stack direction="row" gap={2} wrap>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Attach link
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}
