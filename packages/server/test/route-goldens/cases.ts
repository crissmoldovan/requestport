/**
 * The request shapes of the pre-move goldens, per family (`track-h.md`, "The
 * goldens' plan", "The request shapes, per family"). Each family's cases run
 * in this order, and each golden file holds them in this order.
 */
import { createHash } from "node:crypto";

import {
  admitsCredentialKind,
  createCoreCommandRegistry,
  DomainError,
  normalizedInputHash,
  operatorActor,
  operatorScopes,
  type RestCommandTransport,
  type RestQueryTransport,
  restCommandTransports,
  restQueryTransports,
} from "@requestport/domain";

import {
  agentContext,
  ids,
} from "../../../../apps/web/src/test/api-v1/agent-client.js";
import { apiV1 } from "../../../../apps/web/src/test/api-v1/fake-database.js";
import {
  restCommands,
  restQueries,
} from "../../../../apps/web/src/test/api-v1/rest-surface.js";
import { fingerprintLabel, goldenState } from "./fixtures.js";
import type { GoldenCase } from "./harness.js";

/** The public origin: `BETTER_AUTH_URL` in B1's configuration. */
export const origin = "https://requestport.test";

const bearer = { authorization: "Bearer golden-fake-credential" };
const json = { "content-type": "application/json" };

export const goldenIds = {
  lineage: "018f0000-0000-7000-8000-00000000c101",
  operatorCredential: "018f0000-0000-7000-8000-00000000c102",
  operatorCorrelation: "018f0000-0000-7000-8000-00000000c103",
  memberUser: "user_golden_member",
  source: "018f0000-0000-7000-8000-00000000c104",
  snapshot: "018f0000-0000-7000-8000-00000000c105",
  repository: "018f0000-0000-7000-8000-00000000c106",
  otherId: "018f0000-0000-7000-8000-00000000c107",
} as const;

const clientIp = "203.0.113.7";
const forwardedFor = "198.51.100.9, 10.0.0.1";
const email = "Golden.Person@Example.test";

/** The parts every fingerprint a case keys is computed from. */
export function knownFingerprints(): ReadonlyMap<string, string> {
  const operator = operatorActor({
    lineageId: goldenIds.lineage,
    memberUserId: goldenIds.memberUser,
  });
  return new Map(
    [
      [clientIp],
      ["198.51.100.9"],
      ["unknown"],
      [clientIp, email],
      [clientIp, "invalid"],
      [ids.authorization, ids.agent],
      [goldenIds.operatorCredential, operator.id],
    ].map((parts) => fingerprintLabel(parts)),
  );
}

function signIn(context: object) {
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

function agent(overrides: Parameters<typeof agentContext>[0] = {}) {
  return signIn(agentContext(overrides));
}

function operator(projectId: string | null) {
  return signIn({
    actor: operatorActor({
      lineageId: goldenIds.lineage,
      memberUserId: goldenIds.memberUser,
    }),
    credentialKind: "operator",
    organizationId: ids.organization,
    projectId,
    laneIds: new Set<string>(),
    scopes: new Set(operatorScopes),
    credentialId: goldenIds.operatorCredential,
    credentialFingerprint: "golden-operator-fingerprint",
    correlationId: goldenIds.operatorCorrelation,
    authorizationId: goldenIds.operatorCredential,
  });
}

function refuseAuthentication(error: Error) {
  apiV1.authenticate.mockRejectedValue(error);
}

const unauthenticated = () =>
  new DomainError("unauthenticated", "Bearer credential is required");
const wantsResource = () =>
  new DomainError("unauthenticated", "Access token is opaque", {
    reauthorizeWithResource: true,
  });

function limitDenied(retryAfterSeconds = 17) {
  apiV1.rateLimitConsume.mockResolvedValue({
    allowed: false,
    remaining: 0,
    retryAfterSeconds,
  });
}

/* ------------------------------------------------------------------ auth */

function authRequest(
  method: "GET" | "POST",
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
) {
  return () =>
    new Request(`${origin}${path}`, {
      method,
      headers: init.headers,
      body: init.body,
    });
}

function authCase(
  name: string,
  method: "GET" | "POST",
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
  arrange?: () => void,
): GoldenCase {
  return {
    name,
    route: "auth",
    method,
    request: authRequest(method, path, init),
    params: {
      all: path.slice("/api/auth/".length).split("?", 1)[0]?.split("/") ?? [],
    },
    ...(arrange ? { arrange } : {}),
  };
}

const registration = {
  redirect_uris: ["http://127.0.0.1:43211/callback"],
  token_endpoint_auth_method: "none",
  require_pkce: true,
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "Golden agent",
};

const forwarded = {
  "x-vercel-forwarded-for": clientIp,
  "x-forwarded-for": forwardedFor,
};

const signupDenied = () =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${origin}/sign-in?error=signup_disabled&error_description=Sign-up%20is%20not%20open`,
    },
  });

export const authCases: GoldenCase[] = [
  authCase(
    "GET /api/auth/ok passes through to auth.handler",
    "GET",
    "/api/auth/ok",
  ),
  authCase(
    "GET an unknown path passes through, and the handler's 404 with it",
    "GET",
    "/api/auth/unknown/path",
  ),
  authCase(
    "POST a public registration with a loopback redirect and no application_type: handed on as native",
    "POST",
    "/api/auth/oauth2/register",
    { body: JSON.stringify(registration), headers: json },
  ),
  authCase(
    "POST a registration naming its application_type: handed on unchanged",
    "POST",
    "/api/auth/oauth2/register",
    {
      body: JSON.stringify({ ...registration, application_type: "web" }),
      headers: json,
    },
  ),
  authCase(
    "POST a registration without PKCE: 400 invalid_client_metadata, never handed on",
    "POST",
    "/api/auth/oauth2/register",
    {
      body: JSON.stringify({ ...registration, require_pkce: false }),
      headers: json,
    },
  ),
  authCase(
    "POST a body of 262,145 bytes: 413",
    "POST",
    "/api/auth/sign-in/email",
    { body: "a".repeat(262_145), headers: json },
  ),
  authCase(
    "POST a body of 262,144 bytes: handed on",
    "POST",
    "/api/auth/sign-in/email",
    { body: "a".repeat(262_144), headers: json },
  ),
  authCase(
    "POST an invalid content-length: 500",
    "POST",
    "/api/auth/sign-in/email",
    { body: "{}", headers: { ...json, "content-length": "lots" } },
  ),
  authCase(
    "POST /oauth2/token, the token class allowed, keyed by x-vercel-forwarded-for",
    "POST",
    "/api/auth/oauth2/token",
    {
      body: "grant_type=refresh_token&refresh_token=golden",
      headers: {
        ...forwarded,
        "content-type": "application/x-www-form-urlencoded",
      },
    },
  ),
  authCase(
    "POST /oauth2/token, the token class refused: 429 with retry-after",
    "POST",
    "/api/auth/oauth2/token",
    {
      body: "grant_type=refresh_token&refresh_token=golden",
      headers: {
        ...forwarded,
        "content-type": "application/x-www-form-urlencoded",
      },
    },
    () => limitDenied(30),
  ),
  authCase(
    "POST a path containing /token, keyed by x-forwarded-for's first entry when Vercel's is absent",
    "POST",
    "/api/auth/device/token",
    {
      body: "{}",
      headers: { ...json, "x-forwarded-for": forwardedFor },
    },
  ),
  authCase(
    "POST /oauth2/consent with no forwarding header: keyed as unknown",
    "POST",
    "/api/auth/oauth2/consent",
    { body: JSON.stringify({ accept: true }), headers: json },
  ),
  authCase(
    "POST /sign-in/magic-link, the auth_initiation class keyed by address and email",
    "POST",
    "/api/auth/sign-in/magic-link",
    { body: JSON.stringify({ email }), headers: { ...json, ...forwarded } },
  ),
  authCase(
    "POST /sign-in/magic-link without a JSON body: keyed as invalid",
    "POST",
    "/api/auth/sign-in/magic-link",
    { body: "not json", headers: { ...json, ...forwarded } },
  ),
  authCase(
    "POST /sign-in/magic-link, the class refused: 429",
    "POST",
    "/api/auth/sign-in/magic-link",
    { body: JSON.stringify({ email }), headers: { ...json, ...forwarded } },
    () => limitDenied(600),
  ),
  authCase(
    "POST /sign-in/magic-link with a limiter that throws: 500",
    "POST",
    "/api/auth/sign-in/magic-link",
    { body: JSON.stringify({ email }), headers: { ...json, ...forwarded } },
    () => {
      apiV1.rateLimitConsume.mockRejectedValue(new Error("limiter down"));
    },
  ),
  authCase(
    "POST /sign-in/email: no class, handed on",
    "POST",
    "/api/auth/sign-in/email",
    {
      body: JSON.stringify({ email, password: "golden-password" }),
      headers: { ...json, ...forwarded },
    },
  ),
  authCase(
    "GET /magic-link/verify refused by the signup policy (1.7.6's redirect): 302 to /auth-error",
    "GET",
    "/api/auth/magic-link/verify?token=golden",
    {},
    () => {
      goldenState.authAnswer = signupDenied;
    },
  ),
  authCase(
    "GET /magic-link/verify refused by the signup policy (1.6.29's 403): 302 to /auth-error",
    "GET",
    "/api/auth/magic-link/verify?token=golden",
    {},
    () => {
      goldenState.authAnswer = () =>
        Response.json(
          { code: "signup_disabled", message: "Sign-up is not open" },
          { status: 403 },
        );
    },
  ),
  authCase(
    "GET /magic-link/verify answered with a cookie: passed through",
    "GET",
    "/api/auth/magic-link/verify?token=golden",
    {},
    () => {
      goldenState.authAnswer = () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `${origin}/welcome?error=signup_disabled`,
            "set-cookie": "stand-in.session=1; Path=/; HttpOnly",
          },
        });
    },
  ),
];

/* ------------------------------------------------------------- discovery */

function discoveryCase(route: string, path: string): GoldenCase {
  return {
    name: `GET ${path}`,
    route,
    method: "GET",
    request: () => new Request(`${origin}${path}`),
  };
}

export const discoveryCases: GoldenCase[] = [
  discoveryCase(
    "authorization-server",
    "/.well-known/oauth-authorization-server",
  ),
  discoveryCase("openid-configuration", "/.well-known/openid-configuration"),
  discoveryCase(
    "protected-resource-api",
    "/.well-known/oauth-protected-resource/api/v1",
  ),
  discoveryCase(
    "protected-resource-mcp",
    "/.well-known/oauth-protected-resource/mcp",
  ),
];

/* ------------------------------------------------------------------ REST */

/** A path's parts as Next hands them to the optional catch-all: none for `/api/v1`. */
function restCase(
  name: string,
  method: "GET" | "POST",
  parts: readonly string[],
  init: {
    query?: string;
    body?: string;
    headers?: Record<string, string>;
    arrange?: () => void;
  } = {},
): GoldenCase {
  const path = parts.length === 0 ? "/api/v1" : `/api/v1/${parts.join("/")}`;
  return {
    name,
    route: "rest",
    method,
    request: () =>
      new Request(`${origin}${path}${init.query ?? ""}`, {
        method,
        headers: { ...bearer, ...init.headers },
        body: init.body,
      }),
    params: parts.length === 0 ? {} : { path: [...parts] },
    ...(init.arrange ? { arrange: init.arrange } : {}),
  };
}

function envelope(
  input: Record<string, unknown>,
  expectedVersion: number,
): string {
  return JSON.stringify({
    input,
    idempotencyKey: "golden-idempotency-key-0001",
    expectedVersion,
  });
}

const registry = createCoreCommandRegistry();

function commandCase(transport: RestCommandTransport): GoldenCase {
  const row = restCommands.find((command) => command.name === transport.name);
  if (row && admitsCredentialKind(transport, "agent")) {
    return restCase(
      `POST commands/${transport.name} as an agent`,
      "POST",
      ["commands", transport.name],
      {
        body: envelope(row.input, row.expectedVersion),
        headers: json,
        arrange: () => {
          agent();
          if (row.busCommand) {
            // Answered from a stored receipt, as `route.surface.test.ts` does:
            // the one success the bus has that reaches no repository, and
            // only for exactly the input the table says the bus receives.
            const definition = registry.resolve(row.busCommand);
            if (!definition) throw new Error(`${row.busCommand} is unknown`);
            apiV1.receipts.find.mockResolvedValue({
              normalizedInputHash: normalizedInputHash(
                definition.parse({ ...row.input, ...row.injected }),
              ),
              result: { characterised: row.name } as never,
            });
          } else {
            apiV1.registerProject.mockResolvedValue({
              projectId: ids.project,
              characterised: row.name,
            });
          }
        },
      },
    );
  }
  return restCase(
    `POST commands/${transport.name} as an operator`,
    "POST",
    ["commands", transport.name],
    {
      body: envelope({}, 1),
      headers: json,
      arrange: () => {
        operator(transport.routeRequiresProject ? ids.project : null);
      },
    },
  );
}

const pathValues: Record<string, string> = {
  projectId: ids.project,
  requestId: ids.request,
  agentPrincipalId: ids.agent,
};

function partsOf(path: string) {
  return path
    .slice("/api/v1/".length)
    .split("/")
    .map((segment) =>
      segment.startsWith("{")
        ? (pathValues[segment.slice(1, -1)] ?? goldenIds.otherId)
        : segment,
    );
}

function answerAdministrationReads() {
  for (const [name, read] of Object.entries(apiV1.administrationReads)) {
    read.mockResolvedValue({ characterised: name });
  }
  apiV1.ports.administrationReads = {
    listAdministrationProjects: async () => [
      { id: ids.project, characterised: "listAdministrationProjects" },
    ],
    listAdministrationLanes: async () => [],
    listAdministrationMembers: async () => [],
  };
}

function queryCase(transport: RestQueryTransport): GoldenCase {
  const parts = partsOf(transport.path);
  const row = restQueries.find(
    (query) => query.path.join("/") === parts.join("/"),
  );
  if (row && admitsCredentialKind(transport, "agent")) {
    return restCase(`GET ${transport.path} as an agent`, "GET", parts, {
      arrange: () => {
        agent();
        apiV1.agentQueries[row.repositoryMethod].mockResolvedValue(
          row.repositoryMethod === "getAgentPolicy"
            ? { heartbeatIntervalSeconds: 60 }
            : { items: [{ characterised: row.repositoryMethod }] },
        );
      },
    });
  }
  return restCase(`GET ${transport.path} as an operator`, "GET", parts, {
    arrange: () => {
      operator(transport.routeRequiresProject ? ids.project : null);
      answerAdministrationReads();
    },
  });
}

const firstOperatorOnly = restCommandTransports.find(
  (transport) => !admitsCredentialKind(transport, "agent"),
);

export const restCases: GoldenCase[] = [
  ...restCommandTransports.map(commandCase),
  ...restQueryTransports.map(queryCase),
  restCase("GET whoami as an operator", "GET", ["whoami"], {
    arrange: () => {
      operator(null);
    },
  }),
  restCase(
    "GET requests forwards cursor, limit and every state",
    "GET",
    ["requests"],
    {
      query: "?cursor=c1&limit=25&state=submitted&state=triage&ignored=yes",
      arrange: () => {
        agent();
        apiV1.agentQueries.listRequests.mockResolvedValue({ items: [] });
      },
    },
  ),
  restCase("GET requests with an unknown state: 422", "GET", ["requests"], {
    query: "?state=archived",
    arrange: () => void agent(),
  }),
  restCase("GET /api/v1: 404", "GET", [], { arrange: () => void agent() }),
  restCase("GET an unknown path: 404", "GET", ["agents"], {
    arrange: () => void agent(),
  }),
  restCase(
    "GET organizations without org:read: 403",
    "GET",
    ["organizations"],
    { arrange: () => void agent({ scopes: ["request:read"] }) },
  ),
  restCase(
    "GET requests with a grant bound to no project: refused",
    "GET",
    ["requests"],
    { arrange: () => void agent({ projectId: null }) },
  ),
  restCase(
    "GET whoami with no bearer: 401 with the challenge",
    "GET",
    ["whoami"],
    {
      arrange: () => refuseAuthentication(unauthenticated()),
    },
  ),
  restCase(
    "GET whoami with an opaque token: 401 asking for the resource indicator",
    "GET",
    ["whoami"],
    { arrange: () => refuseAuthentication(wantsResource()) },
  ),
  restCase("GET whoami, the token class refused: 429", "GET", ["whoami"], {
    arrange: () => {
      agent();
      limitDenied();
    },
  }),
  restCase("GET whoami when the authenticator throws: 500", "GET", ["whoami"], {
    arrange: () => refuseAuthentication(new Error("authenticator down")),
  }),
  restCase(
    "POST with no bearer: 401 with the challenge",
    "POST",
    ["commands", "submit_request"],
    {
      body: envelope({ requestId: ids.request }, 1),
      headers: json,
      arrange: () => refuseAuthentication(unauthenticated()),
    },
  ),
  restCase(
    "POST with an opaque token: 401 asking for the resource indicator",
    "POST",
    ["commands", "submit_request"],
    {
      body: envelope({ requestId: ids.request }, 1),
      headers: json,
      arrange: () => refuseAuthentication(wantsResource()),
    },
  ),
  restCase("POST text/plain: 415", "POST", ["commands", "submit_request"], {
    body: envelope({ requestId: ids.request }, 1),
    headers: { "content-type": "text/plain" },
    arrange: () => void agent(),
  }),
  restCase(
    "POST an unknown command: 404",
    "POST",
    ["commands", "not_a_command"],
    {
      body: envelope({}, 0),
      headers: json,
      arrange: () => void agent(),
    },
  ),
  restCase("POST /api/v1: 404", "POST", [], {
    body: envelope({}, 0),
    headers: json,
    arrange: () => void agent(),
  }),
  restCase(
    `POST commands/${firstOperatorOnly?.name} as an agent: 403`,
    "POST",
    ["commands", firstOperatorOnly?.name ?? "missing"],
    {
      body: envelope({}, 1),
      headers: json,
      arrange: () => void agent(),
    },
  ),
  restCase(
    "POST a declared body of 524,289 bytes: 413",
    "POST",
    ["commands", "submit_request"],
    {
      body: envelope({ requestId: ids.request }, 1),
      headers: { ...json, "content-length": "524289" },
      arrange: () => void agent(),
    },
  ),
  restCase("POST invalid JSON: 422", "POST", ["commands", "submit_request"], {
    body: "{not json",
    headers: json,
    arrange: () => void agent(),
  }),
  restCase(
    "POST an envelope that is an array: 422",
    "POST",
    ["commands", "submit_request"],
    { body: "[]", headers: json, arrange: () => void agent() },
  ),
  restCase(
    "POST an envelope without its idempotency key: 422",
    "POST",
    ["commands", "submit_request"],
    {
      body: JSON.stringify({ input: {}, expectedVersion: 1 }),
      headers: json,
      arrange: () => void agent(),
    },
  ),
  restCase(
    "POST JSON nested too deep: 422",
    "POST",
    ["commands", "submit_request"],
    {
      body: `${"[".repeat(22)}${"]".repeat(22)}`,
      headers: json,
      arrange: () => void agent(),
    },
  ),
  restCase(
    "POST, the mutation class refused: 429",
    "POST",
    ["commands", "submit_request"],
    {
      body: envelope({ requestId: ids.request }, 1),
      headers: json,
      arrange: () => {
        agent();
        limitDenied();
      },
    },
  ),
  restCase(
    "POST when the authenticator throws: 500",
    "POST",
    ["commands", "submit_request"],
    {
      body: envelope({ requestId: ids.request }, 1),
      headers: json,
      arrange: () => refuseAuthentication(new Error("authenticator down")),
    },
  ),
];

/* ------------------------------------------------------- artifact import */

const artifactText = "# Characterised\n\nAn artifact the goldens upload.\n";
const blockedText = "password: characterised-not-a-secret-value\n";

function artifact(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return {
    relativePath: "notes/characterised.md",
    mediaType: "text/markdown",
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64Bytes: bytes.toString("base64"),
  };
}

const importMeta = {
  expectedVersion: 0,
  idempotencyKey: "golden-import-idempotency-0001",
};

const startPayload = {
  ...importMeta,
  action: "start",
  repositoryUrl: "https://example.test/golden.git",
  repositoryId: goldenIds.repository,
  gitCommitSha: "a".repeat(40),
  dirty: false,
  manifestSha256: "b".repeat(64),
};

function importCase(
  name: string,
  init: {
    body?: string;
    headers?: Record<string, string>;
    arrange?: () => void;
  },
): GoldenCase {
  return {
    name,
    route: "artifact-import",
    method: "POST",
    request: () =>
      new Request(`${origin}/api/v1/imports/artifacts`, {
        method: "POST",
        headers: { ...bearer, ...(init.headers ?? json) },
        body: init.body ?? JSON.stringify(startPayload),
      }),
    ...(init.arrange ? { arrange: init.arrange } : {}),
  };
}

function importAnswers() {
  goldenState.importBehaviour = {
    requireAgentAccess: async () => undefined,
    beginCapture: async () => ({
      sourceId: goldenIds.source,
      snapshotId: goldenIds.snapshot,
      version: 1,
    }),
    appendCaptureArtifacts: async () => ({ appended: 1, version: 2 }),
    finalizeCapture: async () => ({ finalized: true, version: 3 }),
  };
}

export const artifactImportCases: GoldenCase[] = [
  importCase("an accepted start: 201", {
    arrange: () => {
      agent();
      importAnswers();
    },
  }),
  importCase("an accepted append: 200", {
    body: JSON.stringify({
      ...importMeta,
      expectedVersion: 1,
      action: "append",
      sourceId: goldenIds.source,
      snapshotId: goldenIds.snapshot,
      artifacts: [artifact(artifactText)],
    }),
    arrange: () => {
      agent();
      importAnswers();
    },
  }),
  importCase("an accepted finalize: 200", {
    body: JSON.stringify({
      ...importMeta,
      expectedVersion: 2,
      action: "finalize",
      sourceId: goldenIds.source,
      snapshotId: goldenIds.snapshot,
    }),
    arrange: () => {
      agent();
      importAnswers();
    },
  }),
  importCase("an append with a blocked secret candidate: 422", {
    body: JSON.stringify({
      ...importMeta,
      expectedVersion: 1,
      action: "append",
      sourceId: goldenIds.source,
      snapshotId: goldenIds.snapshot,
      artifacts: [artifact(blockedText)],
    }),
    arrange: () => {
      agent();
      importAnswers();
    },
  }),
  importCase("a declared body over 9 MiB: 413", {
    headers: { ...json, "content-length": String(9 * 1_024 * 1_024 + 1) },
    arrange: () => void agent(),
  }),
  importCase("no bearer: 401 with the challenge", {
    arrange: () => refuseAuthentication(unauthenticated()),
  }),
  importCase("an opaque token: 401 asking for the resource indicator", {
    arrange: () => refuseAuthentication(wantsResource()),
  }),
  importCase("text/plain: 422", {
    headers: { "content-type": "text/plain" },
    arrange: () => void agent(),
  }),
  importCase("invalid JSON: 422", {
    body: "{not json",
    arrange: () => void agent(),
  }),
  importCase("a payload the schema refuses: 422", {
    body: JSON.stringify({ ...startPayload, action: "replace" }),
    arrange: () => void agent(),
  }),
  importCase("a grant without import:write: 403", {
    arrange: () => void agent({ scopes: ["request:read"] }),
  }),
  importCase("a lane-bound grant: 403", {
    arrange: () => void agent({ laneIds: new Set(["lane-golden"]) }),
  }),
  importCase("a grant bound to no project: refused", {
    arrange: () => {
      agent({ projectId: null });
      importAnswers();
    },
  }),
  importCase("the import_ingestion class refused: 429", {
    arrange: () => {
      agent();
      limitDenied(42);
    },
  }),
  importCase("a repository that throws: 500", {
    arrange: () => {
      agent();
      importAnswers();
      goldenState.importBehaviour.beginCapture = async () => {
        throw new Error("database unavailable");
      };
    },
  }),
];

/* ------------------------------------------------------------------- MCP */

const mcpAccept = { accept: "application/json, text/event-stream" };

function mcpAgent(overrides: Parameters<typeof agentContext>[0] = {}) {
  return signIn({ ...agentContext(overrides), audience: "mcp" });
}

function mcpCase(
  name: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    body?: string;
    headers?: Record<string, string>;
    arrange?: () => void;
    headOnly?: boolean;
  },
): GoldenCase {
  const method = init.method ?? "POST";
  return {
    name,
    route: "mcp",
    method,
    request: () =>
      new Request(`${origin}/mcp`, {
        method,
        headers: {
          ...bearer,
          ...mcpAccept,
          ...(method === "POST" ? json : {}),
          ...init.headers,
        },
        body: init.body,
      }),
    arrange: init.arrange ?? (() => void mcpAgent()),
    ...(init.headOnly ? { headOnly: true } : {}),
  };
}

function rpc(id: number, method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const protocol = { "mcp-protocol-version": "2025-06-18" };

export const mcpCases: GoldenCase[] = [
  mcpCase("initialize at 2025-06-18", {
    body: rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "RequestPort goldens", version: "1.0.0" },
    }),
  }),
  mcpCase("tools/list with every working agent scope", {
    body: rpc(2, "tools/list", {}),
    headers: protocol,
  }),
  mcpCase("tools/call whoami", {
    body: rpc(3, "tools/call", { name: "whoami", arguments: {} }),
    headers: protocol,
    arrange: () => {
      mcpAgent();
      apiV1.agentQueries.getAgentPolicy.mockResolvedValue({
        heartbeatIntervalSeconds: 60,
      });
    },
  }),
  mcpCase("tools/call list_requests, the repository throwing", {
    body: rpc(4, "tools/call", { name: "list_requests", arguments: {} }),
    headers: protocol,
    arrange: () => {
      mcpAgent();
      apiV1.agentQueries.listRequests.mockRejectedValue(
        Object.assign(new Error("relation is gone"), {
          code: "42P01",
          constraint: "requests_pkey",
        }),
      );
    },
  }),
  mcpCase("no bearer: 401 with the challenge", {
    body: rpc(5, "tools/list", {}),
    headers: protocol,
    arrange: () => refuseAuthentication(unauthenticated()),
  }),
  mcpCase("an opaque token: 401 asking for the resource indicator", {
    body: rpc(6, "tools/list", {}),
    headers: protocol,
    arrange: () => refuseAuthentication(wantsResource()),
  }),
  mcpCase("text/plain: 415", {
    body: rpc(7, "tools/list", {}),
    headers: { ...protocol, "content-type": "text/plain" },
  }),
  mcpCase("invalid JSON: 400", {
    body: "{not json",
    headers: protocol,
  }),
  mcpCase("a declared body of 524,289 bytes: 413", {
    body: rpc(8, "tools/list", {}),
    headers: { ...protocol, "content-length": "524289" },
  }),
  mcpCase("the mutation class refused: 429", {
    body: rpc(9, "tools/list", {}),
    headers: protocol,
    arrange: () => {
      mcpAgent();
      limitDenied(11);
    },
  }),
  mcpCase("GET, an event stream: its head", {
    method: "GET",
    headers: { accept: "text/event-stream", ...protocol },
    headOnly: true,
  }),
  mcpCase("DELETE", { method: "DELETE", headers: protocol }),
];

/* ---------------------------------------------------------------- health */

export const healthCases: GoldenCase[] = [
  {
    name: "GET /api/health/live",
    route: "health-live",
    method: "GET",
    request: () => new Request(`${origin}/api/health/live`),
  },
  {
    name: "GET /api/health/ready, the storage ready: 200",
    route: "health-ready",
    method: "GET",
    request: () => new Request(`${origin}/api/health/ready`),
  },
  {
    name: "GET /api/health/ready, the storage not ready: 503",
    route: "health-ready",
    method: "GET",
    request: () => new Request(`${origin}/api/health/ready`),
    arrange: () => {
      goldenState.readiness = async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      };
    },
  },
  {
    name: "GET /api/health/ready, the storage silent past 2,000 ms: 503",
    route: "health-ready",
    method: "GET",
    request: () => new Request(`${origin}/api/health/ready`),
    arrange: () => {
      goldenState.readiness = () => new Promise<void>(() => {});
    },
  },
  {
    name: "GET /api/health/ready, the web root refusing its storage: 503",
    route: "health-ready",
    method: "GET",
    request: () => new Request(`${origin}/api/health/ready`),
    arrange: () => {
      goldenState.rootRefuses = true;
    },
  },
];
