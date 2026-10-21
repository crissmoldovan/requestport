"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  Textarea,
} from "@cueplusplus/ui/forms";
import { Link as CueLink, Disclosure, Stack } from "@cueplusplus/ui/layout";
import { AlertDialog } from "@cueplusplus/ui/overlays";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import Link from "next/link";
import { useActionState, useRef } from "react";

import {
  type ImportActionState,
  initialImportActionState,
} from "../app/(app)/imports/import-action-state.js";
import {
  actionBannerMessage,
  actionFieldIssues,
} from "../lib/action-field-issues.js";

/**
 * The legacy-import review controls, on native CUE++ controls.
 *
 * Two gates stand in front of the one action in the product that rewrites
 * history, and they are deliberately different shapes. Freezing a manifest
 * closes the review for good, so §6.2 asks in an `AlertDialog`. Applying the
 * frozen manifest asks the reviewer to type its immutable hash prefix back —
 * a stronger confirmation than a dialog, and the one the importer's own
 * contract is written against, so it stays exactly as it was.
 */

type Action = (
  previous: ImportActionState,
  formData: FormData,
) => Promise<ImportActionState>;

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({
  fields = [],
  state,
}: {
  fields?: readonly string[];
  state: ImportActionState;
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

export function AnalyzeImportButton({
  action,
  idempotencyKey,
  snapshotId,
  sourceId,
}: {
  action: Action;
  idempotencyKey: string;
  snapshotId: string;
  sourceId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialImportActionState,
  );
  return (
    <form action={formAction}>
      <Stack direction="column" gap={2}>
        <input name="snapshotId" type="hidden" value={snapshotId} />
        <input name="sourceId" type="hidden" value={sourceId} />
        <input name="expectedVersion" type="hidden" value="0" />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <div>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Queuing…" : "Analyze"}
          </Button>
        </div>
        <Status state={state} />
      </Stack>
    </form>
  );
}

const reviewFields = [
  "decision",
  "targetProjectId",
  "proposedCanonicalId",
  "relationships",
] as const;

export function ImportEntryReviewForm({
  action,
  correction = false,
  entry,
  idempotencyKey,
  projects,
  runId,
}: {
  action: Action;
  correction?: boolean;
  entry: {
    id: string;
    decision: string;
    proposedCanonicalId: string | null;
    parsedJson: Record<string, unknown>;
    version: number;
  };
  idempotencyKey: string;
  projects: Array<{ id: string; name: string }>;
  runId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialImportActionState,
  );
  const targetProjectId =
    typeof entry.parsedJson.targetProjectId === "string"
      ? entry.parsedJson.targetProjectId
      : "";
  const relationships = Array.isArray(entry.parsedJson.reviewedRelationships)
    ? entry.parsedJson.reviewedRelationships
        .flatMap((relationship) =>
          relationship &&
          typeof relationship === "object" &&
          "type" in relationship &&
          "targetRequestId" in relationship &&
          typeof relationship.type === "string" &&
          typeof relationship.targetRequestId === "string"
            ? [`${relationship.type}:${relationship.targetRequestId}`]
            : [],
        )
        .join("\n")
    : "";
  return (
    <form action={formAction}>
      <input name="entryId" type="hidden" value={entry.id} />
      <input name="runId" type="hidden" value={runId} />
      <input name="expectedVersion" type="hidden" value={entry.version} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={4}>
        <Field name="decision">
          <FieldLabel>Decision</FieldLabel>
          <Select
            defaultValue={
              entry.decision === "pending"
                ? correction
                  ? "message"
                  : "create"
                : entry.decision
            }
            items={[
              {
                label: correction
                  ? "Create corrected request"
                  : "Create request",
                value: "create",
              },
              { label: "Confirm existing mapping", value: "map_existing" },
              { label: "Add compensating message", value: "message" },
              { label: "No corrective change", value: "skip" },
              { label: "Keep blocked", value: "blocked" },
            ]}
            name="decision"
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "decision")} />
        </Field>
        <Field name="targetProjectId">
          <FieldLabel>Target project</FieldLabel>
          <Select
            defaultValue={targetProjectId}
            items={[
              { label: "Select for create", value: "" },
              ...projects.map((project) => ({
                label: project.name,
                value: project.id,
              })),
            ]}
            name="targetProjectId"
            size="sm"
          />
          <FieldError issues={actionFieldIssues(state, "targetProjectId")} />
        </Field>
        <Field name="proposedCanonicalId">
          <FieldLabel>Existing canonical request UUID</FieldLabel>
          <Input
            defaultValue={entry.proposedCanonicalId ?? ""}
            name="proposedCanonicalId"
            size="sm"
          />
          <FieldDescription>
            Required for map or message decisions.
          </FieldDescription>
          <FieldError
            issues={actionFieldIssues(state, "proposedCanonicalId")}
          />
        </Field>
        <Field name="relationships">
          <FieldLabel>Reviewed relationships</FieldLabel>
          <Textarea
            defaultValue={relationships}
            name="relationships"
            placeholder="derived_from:00000000-0000-0000-0000-000000000000"
            rows={2}
          />
          <FieldDescription>
            Optional, one per line as type:request-uuid. The imported or mapped
            request is the source endpoint.
          </FieldDescription>
          <FieldError issues={actionFieldIssues(state, "relationships")} />
        </Field>
        <Status fields={reviewFields} state={state} />
        <div>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Saving…" : "Save decision"}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

export function SplitImportBundleForm({
  action,
  entryId,
  expectedVersion,
  idempotencyKey,
  runId,
}: {
  action: Action;
  entryId: string;
  expectedVersion: number;
  idempotencyKey: string;
  runId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialImportActionState,
  );
  return (
    <Disclosure label="Split bundled source into separate records">
      <form action={formAction}>
        <input name="entryId" type="hidden" value={entryId} />
        <input name="runId" type="hidden" value={runId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <Stack direction="column" gap={4}>
          <Field name="splitLines">
            <FieldLabel>New record start lines</FieldLabel>
            <Input name="splitLines" placeholder="24, 61" required size="sm" />
            <FieldDescription>
              Enter the 1-based line where each additional record begins,
              separated by commas. Every byte remains attached to exactly one
              resulting record.
            </FieldDescription>
            <FieldError issues={actionFieldIssues(state, "splitLines")} />
          </Field>
          <Status fields={["splitLines"]} state={state} />
          <div>
            <Button
              disabled={pending}
              size="sm"
              type="submit"
              variant="secondary"
            >
              {pending ? "Splitting…" : "Split for review"}
            </Button>
          </div>
        </Stack>
      </form>
    </Disclosure>
  );
}

export function FreezeImportButton({
  action,
  expectedVersion,
  idempotencyKey,
  runId,
}: {
  action: Action;
  expectedVersion: number;
  idempotencyKey: string;
  runId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialImportActionState,
  );
  const form = useRef<HTMLFormElement>(null);
  return (
    <form action={formAction} ref={form}>
      <Stack direction="column" gap={2}>
        <input name="runId" type="hidden" value={runId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        {/* No way back: freezing closes the review and fixes the manifest the
            apply step is checked against. */}
        <AlertDialog.Root>
          <AlertDialog.Trigger
            render={
              <Button disabled={pending} size="sm" variant="primary">
                {pending ? "Approving…" : "Approve manifest"}
              </Button>
            }
          />
          <AlertDialog.Content>
            <AlertDialog.Title>Approve this manifest?</AlertDialog.Title>
            <AlertDialog.Description>
              The review closes and every decision is fixed into an immutable
              manifest. Nothing is written to the product until that manifest
              hash is confirmed on the next step.
            </AlertDialog.Description>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Keep reviewing</AlertDialog.Cancel>
              <AlertDialog.Action onClick={() => form.current?.requestSubmit()}>
                Approve it
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
        <Status state={state} />
      </Stack>
    </form>
  );
}

export function ApplyImportForm({
  action,
  expectedVersion,
  idempotencyKey,
  manifestSha256,
  runId,
}: {
  action: Action;
  expectedVersion: number;
  idempotencyKey: string;
  manifestSha256: string;
  runId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialImportActionState,
  );
  const prefix = manifestSha256.slice(0, 12);
  return (
    <form action={formAction}>
      <input name="runId" type="hidden" value={runId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <Stack direction="column" gap={4}>
        <Field name="manifestConfirmation">
          <FieldLabel>Approved manifest hash prefix</FieldLabel>
          <Input
            autoComplete="off"
            minLength={12}
            name="manifestConfirmation"
            placeholder={prefix}
            required
            size="sm"
          />
          <FieldDescription>
            Type the immutable hash prefix {prefix}. Application is asynchronous
            and idempotent.
          </FieldDescription>
          <FieldError
            issues={actionFieldIssues(state, "manifestConfirmation")}
          />
        </Field>
        <Status fields={["manifestConfirmation"]} state={state} />
        <div>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Queuing…" : "Apply approved import"}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

export function ImportRunLink({ id }: { id: string }) {
  return (
    <CueLink render={<Link href={`/imports/${id}`} />} variant="underline">
      Review import
    </CueLink>
  );
}

export function CorrectImportButton({
  action,
  expectedVersion,
  idempotencyKey,
  runId,
}: {
  action: Action;
  expectedVersion: number;
  idempotencyKey: string;
  runId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialImportActionState,
  );
  return (
    <form action={formAction}>
      <Stack direction="column" gap={2}>
        <input name="runId" type="hidden" value={runId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <div>
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Creating…" : "Start correction review"}
          </Button>
        </div>
        <Status state={state} />
      </Stack>
    </form>
  );
}
