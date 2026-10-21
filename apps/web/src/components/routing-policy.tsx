"use client";

import {
  Checkbox,
  CheckboxGroup,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Select,
} from "@cueplusplus/ui/forms";
import { TwoStepButton } from "@cueplusplus/ui/instruments";
import { Disclosure, Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import type { OrganizationProject, RoutingRule } from "@requestport/domain";
import { type ReactNode, useActionState, useRef } from "react";

import {
  createRoutingRuleAction,
  disableRoutingRuleAction,
  testRoutingRuleAction,
  updateRoutingRuleAction,
} from "../app/(app)/settings/routing/actions.js";
import type { RoutingActionState } from "../app/(app)/settings/routing/routing-action-state.js";
import { initialRoutingActionState } from "../app/(app)/settings/routing/routing-action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";

/**
 * Routing policy, on native CUE++ controls.
 *
 * Each constraint axis is one named `CheckboxGroup` rather than one `Field` per
 * box, which is §7's contract for a choice set: a screen-reader user hears
 * "Request types" once instead of five unrelated toggles. Disabling a rule is
 * destructive but recoverable — the same rule can be added again — so §6.2 arms
 * it in place through `TwoStepButton`.
 *
 * The tester's answer is text plus a tone chip, never colour alone, and a
 * denial is announced as an alert because it is the answer the reader came for.
 */

type AgentOption = { id: string; displayName: string };
type LaneOption = { id: string; name: string };

const requestTypeOptions = [
  "feature",
  "bug",
  "question",
  "investigation",
  "chore",
] as const;
const priorityOptions = ["urgent", "high", "normal", "low"] as const;
const humanRoleOptions = ["owner", "admin", "member"] as const;

const decisionOptions = [
  { label: "Allow", value: "allow" },
  { label: "Deny", value: "deny" },
];

const requestTypeItems = [
  { label: "Feature", value: "feature" },
  { label: "Bug", value: "bug" },
  { label: "Question", value: "question" },
  { label: "Investigation", value: "investigation" },
  { label: "Chore", value: "chore" },
];

const priorityItems = [
  { label: "Urgent", value: "urgent" },
  { label: "High", value: "high" },
  { label: "Normal", value: "normal" },
  { label: "Low", value: "low" },
];

function projectItems(projects: OrganizationProject[]) {
  return projects.map((project) => ({
    label: project.name,
    value: project.id,
  }));
}

const ruleFields = ["sourceProjectId", "targetProjectId", "decision"] as const;

/**
 * The fixed result line for a rule write, and the tester's own decision.
 *
 * A decision is not a failure, so an allowed route is a `status` region and a
 * denial an `alert`: both carry the word as well as the tone.
 */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: RoutingActionState;
}) {
  if (state.status === "decision") {
    const allowed = state.allowed;
    return (
      <div role={allowed ? "status" : "alert"}>
        <Stack align="center" direction="row" gap={2} wrap>
          <Chip tone={allowed ? "ok" : "danger"}>
            {allowed ? "Allowed" : "Denied"}
          </Chip>
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
  if (state.status !== "success") return null;

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
 * One constraint axis: a named group of boxes sharing a single submitted field.
 *
 * Each box carries the same `name` and its own `value`, which is what makes the
 * server's `formData.getAll(name)` read exactly the ticked set.
 */
function ConstraintGroup({
  hint,
  label,
  name,
  options,
  selected,
}: {
  hint?: ReactNode;
  label: string;
  name: string;
  options: readonly { label: string; value: string }[];
  selected?: readonly string[];
}) {
  return (
    <Field name={name}>
      <FieldLabel>{label}</FieldLabel>
      <CheckboxGroup aria-label={label} defaultValue={[...(selected ?? [])]}>
        <Stack direction="row" gap={3} wrap>
          {options.map((option) => (
            <Checkbox
              key={option.value}
              label={option.label}
              name={name}
              size="sm"
              value={option.value}
            />
          ))}
        </Stack>
      </CheckboxGroup>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

function constraintOptions(values: readonly string[]) {
  return values.map((value) => ({ label: value, value }));
}

function laneOptions(lanes: LaneOption[]) {
  return lanes.map((lane) => ({ label: lane.name, value: lane.id }));
}

function agentOptions(agents: AgentOption[]) {
  return agents.map((agent) => ({ label: agent.displayName, value: agent.id }));
}

/** The route ends and the decision, shared by the create and edit forms. */
function RuleRoute({
  decision,
  projects,
  sourceProjectId,
  state,
  targetProjectId,
}: {
  decision?: "allow" | "deny";
  projects: OrganizationProject[];
  sourceProjectId?: string;
  state: RoutingActionState;
  targetProjectId?: string;
}) {
  return (
    <>
      <Field name="sourceProjectId">
        <FieldLabel>Source</FieldLabel>
        <Select
          defaultValue={sourceProjectId ?? ""}
          items={[
            { label: "Human direct", value: "" },
            ...projectItems(projects),
          ]}
          name="sourceProjectId"
          size="sm"
        />
        <FieldError issues={actionFieldIssues(state, "sourceProjectId")} />
      </Field>
      <Field name="targetProjectId">
        <FieldLabel>Target</FieldLabel>
        <Select
          defaultValue={targetProjectId ?? null}
          items={projectItems(projects)}
          name="targetProjectId"
          placeholder="Select target"
          required
          size="sm"
        />
        <FieldError issues={actionFieldIssues(state, "targetProjectId")} />
      </Field>
      <Field name="decision">
        <FieldLabel>Decision</FieldLabel>
        <Select
          defaultValue={decision ?? "allow"}
          items={decisionOptions}
          name="decision"
          size="sm"
        />
        <FieldError issues={actionFieldIssues(state, "decision")} />
      </Field>
    </>
  );
}

export function CreateRoutingRuleForm({
  agents,
  idempotencyKey,
  lanes,
  projects,
}: {
  agents: AgentOption[];
  idempotencyKey: string;
  lanes: LaneOption[];
  projects: OrganizationProject[];
}) {
  const [state, action, pending] = useActionState(
    createRoutingRuleAction,
    initialRoutingActionState,
  );
  return (
    <form action={action}>
      <Stack direction="column" gap={4}>
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <RuleRoute projects={projects} state={state} />
        <ConstraintGroup
          hint="Empty matches every request type."
          label="Request types"
          name="requestTypes"
          options={constraintOptions(requestTypeOptions)}
        />
        <ConstraintGroup
          hint="Empty matches every priority."
          label="Priorities"
          name="priorities"
          options={constraintOptions(priorityOptions)}
        />
        <ConstraintGroup
          hint="Empty matches every organization role."
          label="Human roles"
          name="humanRoles"
          options={constraintOptions(humanRoleOptions)}
        />
        <ConstraintGroup
          hint="Empty matches every lane."
          label="Lanes"
          name="laneIds"
          options={laneOptions(lanes)}
        />
        <ConstraintGroup
          hint="Empty matches every principal."
          label="Agent principals"
          name="agentPrincipalIds"
          options={agentOptions(agents)}
        />
        <Status fields={ruleFields} state={state} />
        <Button disabled={pending} size="sm" type="submit" variant="primary">
          {pending ? "Adding…" : "Add rule"}
        </Button>
      </Stack>
    </form>
  );
}

export function DisableRoutingRuleForm({
  idempotencyKey,
  rule,
}: {
  idempotencyKey: string;
  rule: RoutingRule;
}) {
  const [state, action, pending] = useActionState(
    disableRoutingRuleAction,
    initialRoutingActionState,
  );
  const form = useRef<HTMLFormElement>(null);
  if (!rule.enabled) return <Chip tone="neutral">Disabled</Chip>;
  return (
    <form action={action} ref={form}>
      <Stack direction="column" gap={2}>
        <input name="ruleId" type="hidden" value={rule.id} />
        <input name="expectedVersion" type="hidden" value={rule.version} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        {/* Recoverable — the same rule can be added again — so the
            confirmation arms in place rather than opening a modal. */}
        <TwoStepButton
          disabled={pending}
          onConfirm={() => form.current?.requestSubmit()}
          size="sm"
        >
          Disable rule
        </TwoStepButton>
        <Status state={state} />
      </Stack>
    </form>
  );
}

export function UpdateRoutingRuleForm({
  agents,
  idempotencyKey,
  lanes,
  projects,
  rule,
}: {
  agents: AgentOption[];
  idempotencyKey: string;
  lanes: LaneOption[];
  projects: OrganizationProject[];
  rule: RoutingRule;
}) {
  const [state, action, pending] = useActionState(
    updateRoutingRuleAction,
    initialRoutingActionState,
  );
  return (
    <Disclosure label="Edit">
      <form action={action}>
        <Stack direction="column" gap={4}>
          <input name="ruleId" type="hidden" value={rule.id} />
          <input name="expectedVersion" type="hidden" value={rule.version} />
          <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
          <RuleRoute
            decision={rule.decision}
            projects={projects}
            sourceProjectId={rule.sourceProjectId}
            state={state}
            targetProjectId={rule.targetProjectId}
          />
          <ConstraintGroup
            label="Request types"
            name="requestTypes"
            options={constraintOptions(requestTypeOptions)}
            selected={rule.requestTypes}
          />
          <ConstraintGroup
            label="Priorities"
            name="priorities"
            options={constraintOptions(priorityOptions)}
            selected={rule.priorities}
          />
          <ConstraintGroup
            label="Human roles"
            name="humanRoles"
            options={constraintOptions(humanRoleOptions)}
            selected={rule.humanRoles}
          />
          <ConstraintGroup
            label="Lanes"
            name="laneIds"
            options={laneOptions(lanes)}
            selected={rule.laneIds}
          />
          <ConstraintGroup
            label="Agent principals"
            name="agentPrincipalIds"
            options={agentOptions(agents)}
            selected={rule.agentPrincipalIds}
          />
          <Status fields={ruleFields} state={state} />
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Saving…" : "Save rule"}
          </Button>
        </Stack>
      </form>
    </Disclosure>
  );
}

export function RoutingTester({
  agents,
  lanes,
  projects,
}: {
  agents: AgentOption[];
  lanes: LaneOption[];
  projects: OrganizationProject[];
}) {
  const [state, action, pending] = useActionState(
    testRoutingRuleAction,
    initialRoutingActionState,
  );
  return (
    <form action={action}>
      {/* A toolbar of route inputs: §7 lets a control whose surrounding
          structure already names it carry `aria-label` instead of its own
          visible field, which is what keeps this one row rather than six
          stacked labels. */}
      <Stack direction="column" gap={3}>
        <Stack align="center" direction="row" gap={2} wrap>
          <Select
            aria-label="Source"
            defaultValue=""
            items={[
              { label: "Human direct", value: "" },
              ...projectItems(projects),
            ]}
            name="sourceProjectId"
            size="sm"
          />
          <Select
            aria-label="Target"
            items={projectItems(projects)}
            name="targetProjectId"
            placeholder="Target"
            required
            size="sm"
          />
          <Select
            aria-label="Request type"
            defaultValue="feature"
            items={requestTypeItems}
            name="requestType"
            size="sm"
          />
          <Select
            aria-label="Priority"
            defaultValue="normal"
            items={priorityItems}
            name="priority"
            size="sm"
          />
          <Select
            aria-label="Lane"
            defaultValue=""
            items={[{ label: "Any lane", value: "" }, ...laneOptions(lanes)]}
            name="laneId"
            size="sm"
          />
          <Select
            aria-label="Principal"
            defaultValue=""
            items={[
              { label: "Current human", value: "" },
              ...agentOptions(agents),
            ]}
            name="agentPrincipalId"
            size="sm"
          />
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Testing…" : "Test route"}
          </Button>
        </Stack>
        <Status state={state} />
      </Stack>
    </form>
  );
}
