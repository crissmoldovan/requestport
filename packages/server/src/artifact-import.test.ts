import { createHash } from "node:crypto";

import type { AgentAuthContext } from "@requestport/auth";
import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  ARTIFACT_IMPORT_MAX_BODY,
  type ArtifactImportOptions,
  handleArtifactImport,
  type ImportRepository,
} from "./artifact-import.js";
import { reauthorizeWithResourceDescription } from "./bearer-challenge.js";

/**
 * The import repositories the stand-in import transaction hands the handler:
 * each one records the transaction it belongs to and every call it received,
 * and answers what `answers` says.
 */
const imports = {
  repositories: [] as Array<{ transaction: number; calls: string[] }>,
  answers: {} as Record<string, (input: unknown) => unknown>,
  inputs: [] as Array<[string, unknown]>,
};

/** A recording import repository, for the transaction numbered `transaction`. */
function recordingRepository(transaction: number): ImportRepository {
  const repository = { transaction, calls: [] as string[] };
  imports.repositories.push(repository);
  return new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method !== "string" || method === "then") return;
        return async (input: unknown) => {
          repository.calls.push(method);
          imports.inputs.push([method, input]);
          return imports.answers[method]?.(input);
        };
      },
    },
  ) as ImportRepository;
}

const url = "https://requestport.test/api/v1/imports/artifacts";
const ids = {
  source: "018f0000-0000-7000-8000-00000000c104",
  snapshot: "018f0000-0000-7000-8000-00000000c105",
};
const meta = {
  expectedVersion: 0,
  idempotencyKey: "unit-import-idempotency-01",
};

function artifact(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return {
    relativePath: "notes/unit.md",
    mediaType: "text/markdown",
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64Bytes: bytes.toString("base64"),
  };
}

const payloads = {
  start: {
    ...meta,
    action: "start",
    repositoryUrl: null,
    repositoryId: null,
    gitCommitSha: null,
    dirty: false,
    manifestSha256: "b".repeat(64),
  },
  append: {
    ...meta,
    action: "append",
    sourceId: ids.source,
    snapshotId: ids.snapshot,
    artifacts: [artifact("# One\n"), artifact("# Two\n")],
  },
  finalize: {
    ...meta,
    action: "finalize",
    sourceId: ids.source,
    snapshotId: ids.snapshot,
  },
} as const;

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer a-unit-credential",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function agent(overrides: Partial<AgentAuthContext> = {}): AgentAuthContext {
  return {
    actor: {
      type: "agent",
      id: "agent-unit",
      delegatedBy: { type: "user", id: "user-unit" },
    },
    audience: "api",
    organizationId: "organization-unit",
    projectId: "project-unit",
    scopes: new Set(["import:write"]),
    laneIds: new Set(),
    authorizationId: "authorization-unit",
    credentialId: "credential-unit",
    correlationId: "correlation-unit",
    ...overrides,
  };
}

/** The handler's collaborators, as stand-ins that record what they are asked. */
function collaborators(overrides: Partial<ArtifactImportOptions> = {}) {
  imports.repositories.length = 0;
  imports.inputs.length = 0;
  imports.answers = {
    beginCapture: () => ({ sourceId: ids.source, version: 1 }),
    appendCaptureArtifacts: () => ({ appended: 2, version: 2 }),
    finalizeCapture: () => ({ finalized: true, version: 3 }),
  };
  let transactions = 0;
  const stand = {
    authenticateAgentBearer: vi.fn(
      async (_request: Request, _audience: string) => agent(),
    ),
    withProject: vi.fn((context: AgentAuthContext) => {
      if (!context.projectId)
        throw new DomainError("forbidden", "No project for this credential");
      return { ...context, projectId: context.projectId };
    }),
    fingerprint: vi.fn(
      (...parts: Array<string | null | undefined>) =>
        `fingerprint(${parts.join(" | ")})`,
    ),
    enforce: vi.fn(async (_input: unknown) => ({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    })),
    challenge: vi.fn(
      (path: string, options: { reauthorizeWithResource?: boolean }) =>
        `challenge(${path}, ${String(options.reauthorizeWithResource)})`,
    ),
    importTransaction: vi.fn(
      async (work: (repository: ImportRepository) => Promise<unknown>) => {
        transactions += 1;
        return work(recordingRepository(transactions));
      },
    ),
    fingerprintSecret: vi.fn(() => "the-secret"),
  };
  const options = {
    authenticateAgentBearer: stand.authenticateAgentBearer,
    withProject: stand.withProject,
    rateLimiter: { fingerprint: stand.fingerprint, enforce: stand.enforce },
    challenge: stand.challenge,
    importTransaction: stand.importTransaction,
    fingerprintSecret: stand.fingerprintSecret,
    ...overrides,
  } as ArtifactImportOptions;
  return { options, stand };
}

describe("handleArtifactImport, over the collaborators it is handed", () => {
  test("authenticates the request for the api audience", async () => {
    const { options, stand } = collaborators();
    const request = post(payloads.start);

    const response = await handleArtifactImport(request, options);

    expect(response.status).toBe(201);
    expect(stand.authenticateAgentBearer).toHaveBeenCalledExactlyOnceWith(
      request,
      "api",
    );
  });

  test("runs its work in one import transaction, on the repository that transaction hands it", async () => {
    const { options, stand } = collaborators();

    const response = await handleArtifactImport(post(payloads.start), options);

    expect(response.status).toBe(201);
    expect(await response.text()).toBe(
      `{"sourceId":"${ids.source}","version":1}`,
    );
    expect(stand.importTransaction).toHaveBeenCalledOnce();
    expect(imports.repositories).toEqual([
      { transaction: 1, calls: ["requireAgentAccess", "beginCapture"] },
    ]);
  });

  test.each([
    ["start", "beginCapture"],
    ["append", "appendCaptureArtifacts"],
    ["finalize", "finalizeCapture"],
  ] as const)(
    "a %s keys its receipt with the secret read as the receipt is keyed, after the access check",
    async (action, method) => {
      const readAfter: string[][] = [];
      const fingerprintSecret = vi.fn(() => {
        readAfter.push([...(imports.repositories[0]?.calls ?? [])]);
        return `the-secret-read-${readAfter.length}`;
      });
      const { options } = collaborators({ fingerprintSecret });

      const response = await handleArtifactImport(
        post(payloads[action]),
        options,
      );

      expect(response.status).toBe(action === "start" ? 201 : 200);
      expect(readAfter).toEqual([["requireAgentAccess"]]);
      expect(imports.inputs.at(-1)).toEqual([
        method,
        expect.objectContaining({ fingerprintSecret: "the-secret-read-1" }),
      ]);
    },
  );

  test("measures the idempotency key in UTF-16 code units, as zod 4.4.3 did: eight emoji, sixteen units, start a capture", async () => {
    const { options } = collaborators();

    const response = await handleArtifactImport(
      post({ ...payloads.start, idempotencyKey: "\u{1F600}".repeat(8) }),
      options,
    );

    expect(response.status).toBe(201);
  });

  test("measures an artifact's relative path in UTF-16 code units, as zod 4.4.3 did: 1,025 emoji, 2,050 units, are over its 2,048, 422", async () => {
    const { options } = collaborators();

    const response = await handleArtifactImport(
      post({
        ...payloads.append,
        artifacts: [
          { ...artifact("# One\n"), relativePath: "\u{1F600}".repeat(1_025) },
        ],
      }),
      options,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "validation_failed" });
  });

  test("reads no secret for a request it refuses", async () => {
    const { options, stand } = collaborators({
      authenticateAgentBearer: async () => agent({ scopes: new Set() }),
    });

    const response = await handleArtifactImport(post(payloads.start), options);

    expect(response.status).toBe(403);
    expect(stand.fingerprintSecret).not.toHaveBeenCalled();
    expect(stand.importTransaction).not.toHaveBeenCalled();
  });

  test("limits the import_ingestion class through the limiter it is handed, keyed by the grant and the agent, an append costing one per artifact", async () => {
    const { options, stand } = collaborators();

    const response = await handleArtifactImport(post(payloads.append), options);

    expect(response.status).toBe(200);
    expect(stand.fingerprint).toHaveBeenCalledExactlyOnceWith(
      "authorization-unit",
      "agent-unit",
    );
    expect(stand.enforce).toHaveBeenCalledExactlyOnceWith({
      endpointClass: "import_ingestion",
      fingerprint: "fingerprint(authorization-unit | agent-unit)",
      cost: 2,
    });
  });

  test("answers the limiter's refusal 429, with retry-after", async () => {
    const { options, stand } = collaborators();
    stand.enforce.mockRejectedValueOnce(
      new DomainError("rate_limited", "Too many requests", {
        retryAfterSeconds: 42,
      }),
    );

    const response = await handleArtifactImport(post(payloads.start), options);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toEqual({
      error: "rate_limited",
      message: "Too many import records. Retry later.",
    });
    expect(stand.importTransaction).not.toHaveBeenCalled();
  });

  test("scopes the import by the project scope it is handed, and answers its refusal 403", async () => {
    const { options, stand } = collaborators({
      authenticateAgentBearer: async () => agent({ projectId: null }),
    });

    const response = await handleArtifactImport(post(payloads.start), options);

    expect(stand.withProject).toHaveBeenCalledOnce();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "forbidden",
      message: "The credential is not permitted to capture imports.",
    });
    expect(stand.importTransaction).not.toHaveBeenCalled();
  });

  test.each([
    [false, "A valid agent credential is required."],
    [true, reauthorizeWithResourceDescription],
  ])(
    "answers a refused credential 401 with the challenge it is handed for /api/v1's document (asking for the resource indicator: %s)",
    async (reauthorizeWithResource, message) => {
      const { options, stand } = collaborators({
        authenticateAgentBearer: async () => {
          throw new DomainError(
            "unauthenticated",
            "Refused",
            reauthorizeWithResource ? { reauthorizeWithResource: true } : {},
          );
        },
      });

      const response = await handleArtifactImport(
        post(payloads.start),
        options,
      );

      expect(response.status).toBe(401);
      expect(stand.challenge).toHaveBeenCalledExactlyOnceWith(
        "/.well-known/oauth-protected-resource/api/v1",
        { reauthorizeWithResource },
      );
      expect(response.headers.get("www-authenticate")).toBe(
        `challenge(/.well-known/oauth-protected-resource/api/v1, ${reauthorizeWithResource})`,
      );
      expect(await response.json()).toEqual({
        error: "unauthenticated",
        message,
      });
    },
  );

  test("bounds the body at 9 MiB unless it is handed another bound", async () => {
    const body = JSON.stringify(payloads.start);
    const { options } = collaborators();

    expect(ARTIFACT_IMPORT_MAX_BODY).toBe(9 * 1_024 * 1_024);
    expect((await handleArtifactImport(post(body), options)).status).toBe(201);
    const declared = await handleArtifactImport(
      post(body, { "content-length": String(ARTIFACT_IMPORT_MAX_BODY + 1) }),
      options,
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "request_too_large" });

    const bounded = await handleArtifactImport(post(body), {
      ...options,
      maxBody: body.length - 1,
    });
    expect(bounded.status).toBe(413);
    const fits = await handleArtifactImport(post(body), {
      ...options,
      maxBody: body.length,
    });
    expect(fits.status).toBe(201);
  });

  test("answers what no collaborator explains 500, and every answer no-store", async () => {
    const { options } = collaborators({
      importTransaction: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await handleArtifactImport(post(payloads.start), options);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"error":"unexpected_error"}');
  });
});
