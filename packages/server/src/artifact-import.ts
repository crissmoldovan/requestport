/**
 * The artifact import (Plan 13, H.1; manifest-h.md §1.2, §2.2): the handler
 * behind `POST /api/v1/imports/artifacts`, where the private CLI's
 * `import-capture` starts a capture, appends its artifacts and finalizes it.
 *
 * Moved here from `apps/web/src/app/api/v1/imports/artifacts/route.ts`, whose
 * `POST` now hands each request to `handleArtifactImport` with the web's own
 * collaborators; the host (`host.ts`) hands it its own. The schemas, the 9 MiB
 * bound, the error mapping and the document the challenge names are the
 * route's, unchanged. It is handed, and uses at the point in each request
 * where the route used its own:
 *
 * - the agent bearer authenticator, asked for the `api` audience;
 * - the project scope (`withProject`);
 * - the rate limiter, for the `import_ingestion` class;
 * - the `WWW-Authenticate` challenge, for `/api/v1`'s protected-resource
 *   document;
 * - the import transaction, one per request, which runs the request's work
 *   in one transaction and hands it the import repository built on that
 *   transaction's handle, where the storage is: the caller builds it, so the
 *   handle never reaches this module, and `packages/db`'s tenant-scope sweep
 *   follows it in the web's route, where the web root's storage is;
 * - the receipts' fingerprint secret (`BETTER_AUTH_SECRET`), read as each
 *   receipt is keyed;
 * - the body's bound, `ARTIFACT_IMPORT_MAX_BODY` unless given.
 */
import type {
  AgentAudience,
  AgentAuthContext,
} from "@requestport/auth/create-auth";
import type { createImportRepository } from "@requestport/db";
import { DomainError, utf16Max, utf16Min } from "@requestport/domain";
import { validatePreservedArtifact } from "@requestport/importer";
import { z } from "zod";

import {
  reauthorizeWithResourceDescription,
  wantsResourceIndicator,
} from "./bearer-challenge.js";
import {
  assertJsonDepth,
  RequestTooLargeError,
  readBoundedRequestText,
} from "./input-limits.js";
import type { RateLimiter } from "./rate-limit.js";

/** The most bytes of a request body the artifact import reads: 9 MiB. */
export const ARTIFACT_IMPORT_MAX_BODY = 9 * 1_024 * 1_024;

/** `@requestport/db`'s import repository, as `createImportRepository` builds it. */
export type ImportRepository = ReturnType<typeof createImportRepository>;

export interface ArtifactImportOptions {
  /** Authenticates the request's agent bearer; asked for the `api` audience. */
  authenticateAgentBearer: (
    request: Request,
    audience: AgentAudience,
  ) => Promise<AgentAuthContext>;
  /** The context, proven to name a project, or the `forbidden` refusal. */
  withProject: (context: AgentAuthContext) => { projectId: string };
  /** The fingerprint and the decision, for the `import_ingestion` class. */
  rateLimiter: Pick<RateLimiter, "enforce" | "fingerprint">;
  /** The `WWW-Authenticate` value for a protected-resource document's path. */
  challenge: (
    resourceMetadataPath: string,
    options: { reauthorizeWithResource?: boolean },
  ) => string;
  /**
   * Runs `work` in one transaction, handing it the import repository built
   * on that transaction's handle (`createImportRepository(tx)`).
   */
  importTransaction: <T>(
    work: (repository: ImportRepository) => Promise<T>,
  ) => Promise<T>;
  /** The receipts' fingerprint secret, read as each receipt is keyed. */
  fingerprintSecret: () => string;
  /** The most bytes of a body read: `ARTIFACT_IMPORT_MAX_BODY` unless given. */
  maxBody?: number;
}

const commandMeta = {
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
};
const artifactSchema = z.object({
  relativePath: z.string().min(1).check(utf16Max(2_048)),
  mediaType: z.enum(["text/markdown", "text/plain"]),
  byteSize: z.number().int().min(0).max(1_048_576),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  base64Bytes: z.string().check(utf16Max(1_500_000)),
});
const payloadSchema = z.discriminatedUnion("action", [
  z.object({
    ...commandMeta,
    action: z.literal("start"),
    repositoryUrl: z
      .string()
      .trim()
      .check(utf16Max(2_048))
      .nullable()
      .default(null),
    repositoryId: z.uuid().nullable().default(null),
    gitCommitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    dirty: z.boolean(),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.object({
    ...commandMeta,
    action: z.literal("append"),
    sourceId: z.uuid(),
    snapshotId: z.uuid(),
    artifacts: z.array(artifactSchema).min(1).max(8),
  }),
  z.object({
    ...commandMeta,
    action: z.literal("finalize"),
    sourceId: z.uuid(),
    snapshotId: z.uuid(),
  }),
]);

function json(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
}

export async function handleArtifactImport(
  request: Request,
  options: ArtifactImportOptions,
): Promise<Response> {
  try {
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      throw new DomainError(
        "validation_failed",
        "JSON content type is required",
      );
    }
    const context = await options.authenticateAgentBearer(request, "api");
    if (!context.scopes.has("import:write"))
      throw new DomainError("forbidden", "Import capability is required");
    if (context.laneIds.size > 0)
      throw new DomainError(
        "forbidden",
        "Imports require project-wide authorization",
      );
    const rawBody = await readBoundedRequestText(
      request,
      options.maxBody ?? ARTIFACT_IMPORT_MAX_BODY,
    );
    const parsed = JSON.parse(rawBody) as unknown;
    assertJsonDepth(parsed);
    const input = payloadSchema.parse(parsed);
    await options.rateLimiter.enforce({
      endpointClass: "import_ingestion",
      fingerprint: options.rateLimiter.fingerprint(
        context.authorizationId,
        context.actor.id,
      ),
      cost: input.action === "append" ? input.artifacts.length : 1,
    });
    // Legacy import is project-scoped work; a provisioning grant has no project
    // and no business here.
    const scoped = options.withProject(context);
    const result = await options.importTransaction(async (repository) => {
      await repository.requireAgentAccess({
        organizationId: context.organizationId,
        projectId: scoped.projectId,
        agentPrincipalId: context.actor.id,
        authorizationId: context.authorizationId,
        delegatedByUserId: context.actor.delegatedBy?.id ?? null,
      });
      if (input.action === "start")
        return repository.beginCapture({
          organizationId: context.organizationId,
          projectId: scoped.projectId,
          actorId: context.actor.id,
          actorType: "agent",
          repositoryUrl: input.repositoryUrl,
          repositoryId: input.repositoryId,
          gitCommitSha: input.gitCommitSha,
          dirty: input.dirty,
          manifestSha256: input.manifestSha256,
          expectedVersion: input.expectedVersion,
          idempotencyKey: input.idempotencyKey,
          fingerprintSecret: options.fingerprintSecret(),
        });
      if (input.action === "append") {
        const artifacts = input.artifacts.map((artifact) => {
          const validated = validatePreservedArtifact(artifact);
          if (validated.secretScanStatus === "blocked") {
            throw new DomainError(
              "validation_failed",
              "Import artifact contains a prohibited secret candidate",
            );
          }
          return {
            relativePath: artifact.relativePath,
            mediaType: artifact.mediaType,
            byteSize: artifact.byteSize,
            sha256: artifact.sha256,
            exactBytes: validated.bytes,
            secretScanStatus: validated.secretScanStatus,
          };
        });
        return repository.appendCaptureArtifacts({
          organizationId: context.organizationId,
          projectId: scoped.projectId,
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          artifacts,
          actorId: context.actor.id,
          actorType: "agent",
          expectedVersion: input.expectedVersion,
          idempotencyKey: input.idempotencyKey,
          fingerprintSecret: options.fingerprintSecret(),
        });
      }
      return repository.finalizeCapture({
        organizationId: context.organizationId,
        projectId: scoped.projectId,
        sourceId: input.sourceId,
        snapshotId: input.snapshotId,
        actorId: context.actor.id,
        actorType: "agent",
        correlationId: context.correlationId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: options.fingerprintSecret(),
      });
    });
    return json(result, { status: input.action === "start" ? 201 : 200 });
  } catch (error) {
    if (error instanceof RequestTooLargeError)
      return json({ error: "request_too_large" }, { status: 413 });
    if (error instanceof DomainError) {
      const message =
        error.code === "unauthenticated"
          ? wantsResourceIndicator(error)
            ? reauthorizeWithResourceDescription
            : "A valid agent credential is required."
          : error.code === "forbidden"
            ? "The credential is not permitted to capture imports."
            : error.code === "rate_limited"
              ? "Too many import records. Retry later."
              : "The import capture input is invalid.";
      return json(
        { error: error.code, message },
        {
          status:
            error.code === "unauthenticated"
              ? 401
              : error.code === "forbidden"
                ? 403
                : error.code === "rate_limited"
                  ? 429
                  : 422,
          // The artifact route once answered a 401 with no challenge at all,
          // so a client was refused without being told what scheme to use or
          // where to read this resource's metadata. RFC 6750 asks for one; the
          // sibling routes already sent one.
          headers: {
            ...(error.code === "rate_limited" &&
            typeof error.details.retryAfterSeconds === "number"
              ? { "retry-after": String(error.details.retryAfterSeconds) }
              : {}),
            ...(error.code === "unauthenticated"
              ? {
                  "www-authenticate": options.challenge(
                    "/.well-known/oauth-protected-resource/api/v1",
                    {
                      reauthorizeWithResource: wantsResourceIndicator(error),
                    },
                  ),
                }
              : {}),
          },
        },
      );
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return json({ error: "validation_failed" }, { status: 422 });
    return json({ error: "unexpected_error" }, { status: 500 });
  }
}
