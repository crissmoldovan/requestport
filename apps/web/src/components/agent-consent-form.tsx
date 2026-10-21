"use client";

import { Panel } from "@cueplusplus/ui/chrome";
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
import { Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { useActionState, useState } from "react";

import type { ConsentActionState } from "../app/oauth/agent-consent/consent-action-state.js";
import {
  consentFieldNames,
  initialConsentActionState,
  newAgentPrincipalValue,
} from "../app/oauth/agent-consent/consent-action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";

/**
 * The two consent decisions, on the same form contract every other migrated
 * form follows.
 *
 * Section 7 asks three things of a form that can be refused server-side, and
 * this one used to do none of them: a rejected value lands on the control it
 * is about, a refusal that names no drawn control lands in one fixed banner,
 * and a decision in flight is visible on both submits — a reader must not be
 * able to authorize and decline the same request at once.
 *
 * The three new-principal values are required exactly while a new principal is
 * what the reader chose, so the browser asks for them before a round trip does
 * and stops asking the moment an existing principal is selected.
 */

export type ConsentDecision = (
  previous: ConsentActionState,
  formData: FormData,
) => Promise<ConsentActionState>;

export type ConsentOption = { label: string; value: string };

/** A lane carries the project it belongs to, because only that project's apply. */
export type ConsentLaneOption = ConsentOption & { projectId: string };

/**
 * A principal carries the project it is confined to; null serves any binding.
 *
 * The binder accepts an organization-scoped principal, or one belonging to the
 * very project the grant names. Anything else is refused, so anything else is
 * not offered.
 */
export type ConsentPrincipalOption = ConsentOption & {
  /** The organization this principal belongs to; null serves any binding. */
  organizationId: string | null;
  projectId: string | null;
};

/** The fixed refusal line: a tone chip and a message, never colour alone. */
function Refusal({ state }: { state: ConsentActionState }) {
  const message = actionBannerMessage(state, consentFieldNames);
  if (!message) return null;

  return (
    <div role="alert">
      <Stack align="center" direction="row" gap={2} wrap>
        <Chip tone="danger">Error</Chip>
        <span>{message}</span>
      </Stack>
    </div>
  );
}

export function AgentConsentDecision({
  approve,
  clientId,
  deny,
  laneOptions,
  oauthQuery,
  principalOptions,
  projectOptions,
  proposedName,
  proposedSlug,
}: {
  approve: ConsentDecision;
  clientId: string;
  deny: ConsentDecision;
  laneOptions: readonly ConsentLaneOption[];
  oauthQuery: string;
  principalOptions: readonly ConsentPrincipalOption[];
  projectOptions: readonly ConsentOption[];
  proposedName: string;
  proposedSlug: string;
}) {
  const [allowState, allowAction, allowing] = useActionState(
    approve,
    initialConsentActionState,
  );
  /*
    The denial runs from here rather than from inside the denial control.

    Both submits have to know that a decision is in flight, and only one of
    them can own the state that says so. While the denial owned its own, this
    component could see an approval start but not a denial — so Allow stayed
    live through the seconds a denial spends on its rate-limiter write and the
    provider call, and an impatient second click bound the very connection the
    first click had just declined.
  */
  const [denyState, denyAction, denying] = useActionState(
    deny,
    initialConsentActionState,
  );
  const [principal, setPrincipal] = useState(newAgentPrincipalValue);
  const [binding, setBinding] = useState(projectOptions[0]?.value ?? "");
  // The project half of `organizationId:projectId`. Empty for a provisioning
  // grant, which names no project and so has no lanes to restrict.
  const selectedProjectId = binding.split(":")[1] ?? "";
  const creatingPrincipal = principal === newAgentPrincipalValue;
  const [selectedOrganizationId = ""] = binding.split(":");
  const principalChoices = principalOptions.filter(
    (option) =>
      (option.organizationId === null ||
        option.organizationId === selectedOrganizationId) &&
      (option.projectId === null || option.projectId === selectedProjectId),
  );
  const deciding = allowing || denying;

  return (
    <>
      <form action={allowAction} aria-label="Allow connection">
        <input name="oauthQuery" type="hidden" value={oauthQuery} />
        <input name="clientId" type="hidden" value={clientId} />
        <Panel className="p-(--cue-space-5)">
          <Stack direction="column" gap={4}>
            <Field name="projectBinding">
              <FieldLabel>Organization and project</FieldLabel>
              <Select
                items={projectOptions}
                name="projectBinding"
                onValueChange={(next) => {
                  const value = String(next ?? "");
                  setBinding(value);
                  /*
                    The offer changed, so the choice does too. A principal
                    confined to the project just left is no longer offered, and
                    leaving it selected would post it anyway — a refusal the
                    person never chose and could not see coming.
                  */
                  const project = value.split(":")[1] ?? "";
                  setPrincipal((current) => {
                    const chosen = principalOptions.find(
                      (option) => option.value === current,
                    );
                    const organization = value.split(":")[0] ?? "";
                    const strandedByProject =
                      chosen?.projectId && chosen.projectId !== project;
                    const strandedByOrganization =
                      chosen?.organizationId &&
                      chosen.organizationId !== organization;

                    return strandedByProject || strandedByOrganization
                      ? newAgentPrincipalValue
                      : current;
                  });
                }}
                required
                value={binding}
              />
              <FieldError
                issues={actionFieldIssues(allowState, "projectBinding")}
              />
            </Field>
            {/*
              Only the lanes of the project selected above. A lane belongs to
              one project, and the binder refuses one from any other — so
              offering them all meant offering a choice that would be refused
              as a permission problem the person does not have.
            */}
            <CheckboxGroup aria-label="Lane restriction">
              {laneOptions
                .filter((lane) => lane.projectId === selectedProjectId)
                .map((lane) => (
                  <Checkbox
                    key={lane.value}
                    label={lane.label}
                    name="laneIds"
                    value={lane.value}
                  />
                ))}
            </CheckboxGroup>
            <p>
              Leave every lane unchecked for project-wide access. Any selected
              lane must belong to the project chosen above.
            </p>
            <Field name="agentPrincipalId">
              <FieldLabel>Agent principal</FieldLabel>
              <Select
                items={principalChoices}
                name="agentPrincipalId"
                onValueChange={(value) =>
                  setPrincipal(value ?? newAgentPrincipalValue)
                }
                required
                value={principal}
              />
              <FieldError
                issues={actionFieldIssues(allowState, "agentPrincipalId")}
              />
            </Field>
            <Field name="displayName">
              <FieldLabel>Display name</FieldLabel>
              <Input
                defaultValue={proposedName}
                maxLength={160}
                name="displayName"
                required={creatingPrincipal}
              />
              <FieldDescription>
                Required only when a new agent principal is created.
                Client-provided metadata is untrusted; review it before allowing
                access.
              </FieldDescription>
              <FieldError
                issues={actionFieldIssues(allowState, "displayName")}
              />
            </Field>
            <Field name="slug">
              <FieldLabel>Stable slug</FieldLabel>
              <Input
                defaultValue={proposedSlug}
                maxLength={63}
                name="slug"
                pattern="[a-z0-9][a-z0-9-]{1,62}"
                required={creatingPrincipal}
              />
              <FieldError issues={actionFieldIssues(allowState, "slug")} />
            </Field>
            <Field name="softwareName">
              <FieldLabel>Software name</FieldLabel>
              <Input
                defaultValue={proposedName}
                maxLength={160}
                name="softwareName"
                required={creatingPrincipal}
              />
              <FieldError
                issues={actionFieldIssues(allowState, "softwareName")}
              />
            </Field>
            <p>
              The grant expires after 30 days. The server verifies that the
              selected organization, project, lanes, and principal belong
              together. A token is refused unless the consent is bound
              successfully.
            </p>
            <Refusal state={allowState} />
            <Stack direction="row" gap={2} wrap>
              <Button disabled={deciding} type="submit" variant="primary">
                {allowing ? "Allowing…" : "Allow connection"}
              </Button>
            </Stack>
          </Stack>
        </Panel>
      </form>
      <ConsentDenialForm
        action={denyAction}
        clientId={clientId}
        denying={denying}
        disabled={deciding}
        oauthQuery={oauthQuery}
        state={denyState}
      />
    </>
  );
}

/**
 * The denial control, drawn from state somebody else holds.
 *
 * `denying` and `disabled` are two different facts and both are needed: the
 * label reports which decision is running, while the disabling reports that
 * some decision is. Beside an approval form they differ — Deny goes dead
 * reading "Deny" while an approval is in flight — and only the component that
 * can see both decisions knows that.
 */
function ConsentDenialForm({
  action,
  clientId,
  denying,
  disabled,
  oauthQuery,
  state,
}: {
  action: (formData: FormData) => void;
  clientId: string;
  denying: boolean;
  disabled: boolean;
  oauthQuery: string;
  state: ConsentActionState;
}) {
  return (
    <form action={action} aria-label="Deny connection">
      <input name="oauthQuery" type="hidden" value={oauthQuery} />
      {/*
        Deny carries the client too. It is the only action left on a screen
        that cannot be approved, and those screens exist precisely because the
        signed query cannot be parsed into a request — so the id has to come
        from here rather than from parsing it again.
      */}
      <input name="clientId" type="hidden" value={clientId} />
      <Stack direction="column" gap={2}>
        {/*
          The refusal stays on the control it is about: a denial that was
          refused is reported at the denial, not in the approval form's banner
          halfway up the page.
        */}
        <Refusal state={state} />
        <Button disabled={disabled} type="submit" variant="secondary">
          {denying ? "Denying…" : "Deny"}
        </Button>
      </Stack>
    </form>
  );
}

/**
 * The answer a person can always give.
 *
 * Every screen on this path that cannot be approved still has a client waiting
 * on a loopback callback, and denial is what ends that wait: the signed query
 * is intact, so the provider answers `access_denied` at the client's own
 * redirect address the moment somebody says no. A screen that offers advice
 * and no control leaves the agent waiting until it times out, which is the
 * same silence as a server that never answered.
 *
 * This is the standalone screen, where denial is the only decision on offer
 * and so is the only one that can be in flight. Where there is also something
 * to approve, `AgentConsentDecision` runs the denial itself, because there the
 * two decisions have to exclude each other.
 */
export function AgentConsentDenial({
  clientId,
  deny,
  oauthQuery,
}: {
  clientId: string;
  deny: ConsentDecision;
  oauthQuery: string;
}) {
  const [denyState, denyAction, denying] = useActionState(
    deny,
    initialConsentActionState,
  );

  return (
    <ConsentDenialForm
      action={denyAction}
      clientId={clientId}
      denying={denying}
      disabled={denying}
      oauthQuery={oauthQuery}
      state={denyState}
    />
  );
}
