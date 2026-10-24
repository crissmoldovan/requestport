"use server";

import { randomUUID } from "node:crypto";
import { serverEnv } from "@requestport/config/server";
import { createImportRepository } from "@requestport/db";
import {
  DomainError,
  importReviewDecisions,
  utf16Max,
  utf16Min,
} from "@requestport/domain";
import { LEGACY_PARSER_VERSION } from "@requestport/importer";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import type { ActionValidationIssue } from "../../../lib/action-field-issues.js";
import { namedValidationFailure } from "../../../lib/action-field-issues.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import {
  coreCommandBus,
  humanCommandContext,
} from "../../../lib/server-core-commands.js";
import {
  relationshipsFromLines,
  splitImportEntry,
  splitLinesFromText,
} from "../../../lib/server-import-actions.js";
import { webStorage } from "../../../lib/server-request-port.js";
import { dispatchImportTask } from "../../../lib/trigger-client.js";
import type { ImportActionState } from "./import-action-state.js";

function errorState(error: unknown): ImportActionState {
  if (error instanceof DomainError) {
    const messages: Record<string, string> = {
      conflict: "The import changed or still has unresolved review work.",
      forbidden: "Only organization owners and admins can manage imports.",
      not_found: "That import is no longer available.",
      rate_limited: "Too many import changes. Wait a moment and try again.",
      validation_failed: "The import data or confirmation hash is invalid.",
      version_conflict: "The import changed. Refresh before trying again.",
      idempotency_conflict:
        "This import action key was already used with different input. Refresh and retry.",
    };
    // A domain rejection that already knows which value it is about keeps that
    // name, so the message lands on the control the reader has to change —
    // most of all the manifest prefix, which is the last gate before a write
    // that cannot be undone.
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message: messages[error.code] ?? "Import action failed.",
    };
  }
  return { status: "error", message: "Import action failed." };
}

/**
 * A rejected submission, addressed to the control that owns the value.
 *
 * The review form, the split form and the apply form each draw a field for
 * what they ask for, so section 7 puts a schema rejection on that control's own
 * error line. The analyse, approve and correct controls draw none — they carry
 * hidden metadata only — and keep the fixed banner.
 */
function rejected(issues: readonly ActionValidationIssue[]): ImportActionState {
  return { status: "error", ...namedValidationFailure(issues) };
}

const commandMetaSchema = z.object({
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
  expectedVersion: z.coerce.number().int().nonnegative(),
});

/**
 * The session, the organization check and the `import_ingestion` limiter.
 *
 * Every action in this module resolves this before it reads a single value out
 * of the submission. Parsing first turns an owner/admin-only mutation into an
 * oracle an anonymous caller can query: they learn which of the values an
 * import form asks for the server rejects without ever costing a session
 * lookup, and — because the limiter lives behind the same call — without any
 * bound on how often they may ask again.
 */
async function managerContext() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) {
    throw new DomainError("forbidden", "Import management access is denied");
  }
  await enforceRateLimit({
    endpointClass: "import_ingestion",
    fingerprint: rateLimitFingerprint(organization.id, context.session.user.id),
  });
  return { context, organization };
}

export async function analyzeImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const { context, organization } = await managerContext();
    const input = commandMetaSchema
      .extend({ sourceId: z.uuid(), snapshotId: z.uuid() })
      .parse(Object.fromEntries(formData));
    const storage = webStorage();
    const run = await storage.transaction(async (transaction) => {
      const repository = createImportRepository(transaction);
      await repository.requireManagerAccess(
        organization.id,
        context.session.user.id,
      );
      return repository.createRun({
        organizationId: organization.id,
        ...input,
        actorType: "user",
        actorId: context.session.user.id,
        parserVersion: LEGACY_PARSER_VERSION,
        fingerprintSecret: serverEnv.BETTER_AUTH_SECRET,
      });
    });
    const dispatch = await dispatchImportTask(run.dispatchId, organization.id);
    revalidatePath("/imports");
    return {
      status: "success",
      message: dispatch.accepted
        ? "Import analysis queued."
        : "Import analysis is durable and will be queued by the repair sweep.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function reviewImportEntryAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const { context, organization } = await managerContext();
    const parsed = commandMetaSchema
      .extend({
        runId: z.uuid(),
        entryId: z.uuid(),
        decision: z.enum(importReviewDecisions),
        proposedCanonicalId: z.union([z.literal(""), z.uuid()]).optional(),
        targetProjectId: z.union([z.literal(""), z.uuid()]).optional(),
        relationships: z.string().check(utf16Max(4_000)).optional().default(""),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return rejected(parsed.error.issues);
    const input = parsed.data;
    const relationships = relationshipsFromLines(input.relationships);
    // `review_legacy_import_entry` (Plan 13, F.2.6) checks import:write, the
    // organisation and that the reviewer is an owner or admin before the bus
    // answers a replay or writes; the bus keeps the one receipt.
    await coreCommandBus.execute({
      name: "review_legacy_import_entry",
      context: humanCommandContext(context.session, organization.id),
      input: {
        organizationId: organization.id,
        runId: input.runId,
        entryId: input.entryId,
        decision: input.decision,
        proposedCanonicalId: input.proposedCanonicalId || null,
        targetProjectId: input.targetProjectId || null,
        relationships,
      },
      meta: {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    });
    revalidatePath(`/imports/${input.runId}`);
    return { status: "success", message: "Import decision saved." };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function splitImportEntryAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const { context, organization } = await managerContext();
    const parsed = commandMetaSchema
      .extend({
        runId: z.uuid(),
        entryId: z.uuid(),
        splitLines: z.string().trim().min(1).check(utf16Max(500)),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return rejected(parsed.error.issues);
    const input = parsed.data;
    const splitLines = splitLinesFromText(input.splitLines);
    // In the split's own transaction, the split handler re-checks the
    // credential (`assertCurrent`), then `importReviewTarget` checks the scope
    // `import:write`, the organisation and that the actor is a person, then
    // the port's `authorize` that the reviewer is an owner or admin; the
    // split keeps the repository's receipt (Plan 13, F.2.6).
    const split = await splitImportEntry(
      humanCommandContext(context.session, organization.id),
      {
        organizationId: organization.id,
        runId: input.runId,
        entryId: input.entryId,
        splitLines,
      },
      {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    );
    revalidatePath(`/imports/${input.runId}`);
    return {
      status: "success",
      message: `Bundle split into ${split.entryIds.length} records for individual review.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function freezeImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const { context, organization } = await managerContext();
    const input = commandMetaSchema
      .extend({ runId: z.uuid() })
      .parse(Object.fromEntries(formData));
    const storage = webStorage();
    const frozen = await storage.transaction(async (transaction) => {
      const repository = createImportRepository(transaction);
      await repository.requireManagerAccess(
        organization.id,
        context.session.user.id,
      );
      return repository.freeze({
        organizationId: organization.id,
        runId: input.runId,
        reviewerId: context.session.user.id,
        correlationId: randomUUID(),
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: serverEnv.BETTER_AUTH_SECRET,
      });
    });
    revalidatePath(`/imports/${input.runId}`);
    return {
      status: "success",
      message: `Manifest approved. Confirm hash ${frozen.manifestSha256} before applying.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function applyImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const { context, organization } = await managerContext();
    const parsed = commandMetaSchema
      .extend({
        runId: z.uuid(),
        manifestConfirmation: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{12,64}$/u),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return rejected(parsed.error.issues);
    const input = parsed.data;
    const storage = webStorage();
    const detail = await storage.transaction(async (transaction) => {
      const repository = createImportRepository(transaction);
      await repository.requireManagerAccess(
        organization.id,
        context.session.user.id,
      );
      return repository.detail(organization.id, input.runId);
    });
    if (!detail) throw new DomainError("not_found", "Import run was not found");
    const manifestSha256 = detail.run.manifestSha256;
    if (!manifestSha256?.startsWith(input.manifestConfirmation))
      throw new DomainError(
        "validation_failed",
        "Approved import manifest hash does not match",
        // The reader typed this one, so the rejection belongs on the control
        // they typed it into rather than in the form's banner.
        { field: "manifestConfirmation" },
      );
    const queued = await storage.transaction(async (transaction) => {
      const repository = createImportRepository(transaction);
      await repository.requireManagerAccess(
        organization.id,
        context.session.user.id,
      );
      return repository.queueApply({
        organizationId: organization.id,
        runId: input.runId,
        manifestSha256,
        actorType: "user",
        actorId: context.session.user.id,
        taskActor: { type: "user", id: context.session.user.id },
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: serverEnv.BETTER_AUTH_SECRET,
      });
    });
    const dispatch = await dispatchImportTask(
      queued.dispatchId,
      organization.id,
    );
    revalidatePath(`/imports/${input.runId}`);
    return {
      status: "success",
      message: dispatch.accepted
        ? "Approved import application queued."
        : "Approved import application is durable and will be queued by the repair sweep.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function correctImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const { context, organization } = await managerContext();
    const input = commandMetaSchema
      .extend({ runId: z.uuid() })
      .parse(Object.fromEntries(formData));
    const storage = webStorage();
    const correction = await storage.transaction(async (tx) => {
      const repository = createImportRepository(tx);
      await repository.requireManagerAccess(
        organization.id,
        context.session.user.id,
      );
      return repository.createCorrectionRun({
        organizationId: organization.id,
        originalRunId: input.runId,
        actorType: "user",
        actorId: context.session.user.id,
        correlationId: randomUUID(),
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: serverEnv.BETTER_AUTH_SECRET,
      });
    });
    revalidatePath("/imports");
    return {
      status: "success",
      message: `Correction review ${correction.id.slice(0, 8)} created from preserved source.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}
