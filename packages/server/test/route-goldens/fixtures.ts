/**
 * The collaborators the pre-move goldens run the web's routes over (Plan 13,
 * H.1; manifest-h.md §2.2, Done when 1).
 *
 * They are B1's fakes (`apps/web/src/test/api-v1/fake-database.ts`), imported
 * by relative path because new test files under `apps/web` are not H.1's,
 * with what B1's fakes do not carry and these families reach:
 *
 * - a stand-in for Better Auth's `auth.handler`, which records what the auth
 *   route hands it and answers by path, so the auth goldens pin the route's
 *   wrapper and `createAuthRouteHandler` (the real one, which the auth
 *   handlers import from `@requestport/auth/auth-handler`, unmocked) and not
 *   Better Auth;
 * - a recording `createImportRepository`, for the artifact import;
 * - a web root storage with `ready()`, for readiness, and one that refuses;
 * - Better Auth's own identity schema, and a handle whose `select` answers as
 *   a database without the `oauth_resource` table does, so that the Better
 *   Auth `@requestport/auth/server` installs can serve its two discovery
 *   documents: its OAuth provider seeds that table as it starts, and defers
 *   the seed when the table is missing. No other collaborator in these
 *   families queries through the handle: every repository they build over it
 *   is a fake.
 *
 * The test file's `vi.mock` factories hand these to the routes, and the
 * families run in one module registry, so a case arranges its knobs here and
 * the routes see them. (The file's last case resets that registry, after
 * every other case has run.)
 */
import { createHmac } from "node:crypto";

import { vi } from "vitest";

import {
  fakeAuthServerModule,
  fakeDatabaseModule,
  fakeServerEnv,
  fakeWiringModule,
} from "../../../../apps/web/src/test/api-v1/fake-database.js";

/** What `auth.handler` answers, by default, for a path the case leaves alone. */
function standInAnswer(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/api/auth/oauth2/register") {
    return Response.json(
      {
        client_id: "stand-in-client-id",
        client_id_issued_at: 1_790_000_000,
        token_endpoint_auth_method: "none",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }
  if (pathname === "/api/auth/unknown/path") {
    return Response.json(
      { message: "Not Found" },
      { status: 404, headers: { "x-stand-in": "auth.handler" } },
    );
  }
  const headers = new Headers({
    "content-type": "application/json",
    "x-stand-in": "auth.handler",
  });
  // Two cookies, so a golden shows each reaching the response.
  headers.append("set-cookie", "stand-in.one=1; Path=/; HttpOnly");
  headers.append("set-cookie", "stand-in.two=2; Path=/; HttpOnly");
  return new Response(
    JSON.stringify({ handledBy: "auth.handler", method: request.method }),
    { status: 200, headers },
  );
}

export const goldenState = {
  /** What the web root's storage's `ready()` does. */
  readiness: async (): Promise<void> => {},
  /** Whether the web root refuses to hand out its storage. */
  rootRefuses: false,
  /** A case's own answer for `auth.handler`, in place of the default. */
  authAnswer: undefined as ((request: Request) => Response) | undefined,
  /** What `auth.handler` was handed, in order: the body read as it arrived. */
  authReceived: [] as Array<{
    method: string;
    url: string;
    headers: [string, string][];
    body: string;
  }>,
  /** What the import repository's methods answer; a case replaces one. */
  importBehaviour: {} as Record<string, (input: unknown) => Promise<unknown>>,
};

/** Better Auth's `auth`, as far as the auth route reaches it: its handler. */
export const authStandIn = {
  handler: vi.fn(async (request: Request): Promise<Response> => {
    goldenState.authReceived.push({
      method: request.method,
      url: request.url,
      headers: [...request.headers],
      body: request.body ? await request.clone().text() : "",
    });
    return (goldenState.authAnswer ?? standInAnswer)(request);
  }),
};

/** Each call the import repository received: its method, and its input. */
export const importCall = vi.fn(
  async (method: string, input: unknown): Promise<unknown> => {
    const behaviour = goldenState.importBehaviour[method];
    return behaviour ? behaviour(input) : undefined;
  },
);

/** Each time readiness asked the web root's storage whether it is ready. */
export const readyCall = vi.fn(async () => goldenState.readiness());

/** Every knob above back to its neutral state. */
export function resetGoldenState() {
  goldenState.readiness = async () => {};
  goldenState.rootRefuses = false;
  goldenState.authAnswer = undefined;
  goldenState.authReceived = [];
  goldenState.importBehaviour = {};
  authStandIn.handler.mockClear();
  importCall.mockClear();
  readyCall.mockClear();
}

/**
 * The import repository the artifact route builds in its transaction, as
 * the host does: each method a call on `importCall`, which a case gives its
 * answer.
 */
function recordingImportRepository(_tx: unknown) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string" || property === "then") {
          return undefined;
        }
        return (input: unknown) => importCall(property, input);
      },
    },
  );
}

/** What `vi.mock("@requestport/db", …)` resolves to in the goldens. */
export async function goldenDatabaseModule() {
  const actual =
    await vi.importActual<typeof import("@requestport/db")>("@requestport/db");
  return {
    ...fakeDatabaseModule,
    createImportRepository: recordingImportRepository,
    identitySchema: actual.identitySchema,
  };
}

/** What `vi.mock("@requestport/db/wiring", …)` resolves to in the goldens. */
export const goldenWiringModule = {
  applicationStorageFromEnv: () => {
    if (goldenState.rootRefuses) {
      throw new Error("RequestPort database surface not declared");
    }
    const storage = fakeWiringModule.applicationStorageFromEnv();
    return {
      ...storage,
      db: Object.assign(Object.create(storage.db), {
        select() {
          throw new Error('relation "oauth_resource" does not exist');
        },
      }),
      ready: () => readyCall(),
    };
  },
};

/**
 * What `vi.mock("@requestport/auth/server", …)` resolves to: B1's two bearer
 * authenticators, the stand-in `auth`, and, from the module itself, the two
 * discovery handlers of the Better Auth it installs over the configuration
 * and the storage faked here.
 */
export async function goldenAuthServerModule() {
  const actual = await vi.importActual<
    typeof import("@requestport/auth/server")
  >("@requestport/auth/server");
  return {
    ...fakeAuthServerModule,
    auth: authStandIn,
    oauthAuthorizationServerMetadata: actual.oauthAuthorizationServerMetadata,
    oauthOpenIdConfiguration: actual.oauthOpenIdConfiguration,
  };
}

/**
 * A rate-limit fingerprint the goldens can name: the HMAC over the
 * configuration's secret, computed here as `rateLimitFingerprint`
 * (`apps/web/src/lib/security/rate-limit.ts`, since H.1's slice b a
 * composition of `packages/server/src/rate-limit.ts`'s) computes it, for
 * parts a case sends. A golden
 * writes `hmac(<parts>)` for a fingerprint it recognises, so a reader sees
 * which value was keyed; one it does not recognise stays hex.
 */
export function fingerprintLabel(
  parts: ReadonlyArray<string | null | undefined>,
) {
  const hex = createHmac("sha256", fakeServerEnv.BETTER_AUTH_SECRET)
    .update(
      parts.map((part) => part?.trim().toLowerCase() ?? "-").join("\u0000"),
    )
    .digest("hex");
  return [
    hex,
    `hmac(${parts.map((part) => part ?? "-").join(" | ")})`,
  ] as const;
}
