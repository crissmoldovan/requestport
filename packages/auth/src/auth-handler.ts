type AuthHandler = (request: Request) => Promise<Response>;

async function readBoundedBody(request: Request, maximumBytes: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("request_too_large");
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validPublicRedirectUri(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const schemeSeparator = value.indexOf("://");
    const rawAuthority =
      schemeSeparator >= 0
        ? value.slice(schemeSeparator + 3).split(/[/?#]/u, 1)[0]
        : undefined;
    if (
      !rawAuthority ||
      rawAuthority.includes("@") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return false;
    }
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * The `application_type` a registration that names none is filed under.
 *
 * Better Auth 1.7 treats a registration without `application_type` as `web`,
 * and a `web` client may not redirect to an `http` loopback address — which is
 * the only redirect RequestPort's own client, and any agent on the MCP SDK's
 * v1 client, ever registers. So the type is derived here, before Better Auth
 * reads the body, by the rule the MCP SDK's v2 client applies to itself
 * (`deriveApplicationType` in `@modelcontextprotocol/client@2.1.0`): a
 * loopback host or a scheme other than http(s) means `native`, anything else
 * `web`. Unlike that rule, a set that mixes the two is left without a type,
 * so Better Auth judges it as `web` and refuses its loopback redirect. A type
 * the request names is never replaced.
 */
function derivedApplicationType(redirects: readonly string[]) {
  const kinds = new Set(
    redirects.map((redirect) => {
      const url = new URL(redirect);
      return (url.protocol !== "http:" && url.protocol !== "https:") ||
        isLoopbackHost(url.hostname)
        ? "native"
        : "web";
    }),
  );
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

async function validateDynamicClientRegistration(
  request: Request,
): Promise<Record<string, unknown> | null> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return null;
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 16_384) return null;
  const bytes = await readBoundedBody(request.clone(), 16_384);
  if (!bytes) return null;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const redirects = body.redirect_uris;
  if (
    !Array.isArray(redirects) ||
    redirects.length < 1 ||
    redirects.length > 10 ||
    !redirects.every(validPublicRedirectUri) ||
    new Set(redirects).size !== redirects.length
  ) {
    return null;
  }
  if (
    body.token_endpoint_auth_method !== "none" ||
    body.require_pkce !== true
  ) {
    return null;
  }
  const grants = body.grant_types;
  if (
    grants !== undefined &&
    (!Array.isArray(grants) ||
      !grants.every(
        (grant) => grant === "authorization_code" || grant === "refresh_token",
      ))
  ) {
    return null;
  }
  const responses = body.response_types;
  if (
    responses !== undefined &&
    !(
      Array.isArray(responses) &&
      responses.length === 1 &&
      responses[0] === "code"
    )
  ) {
    return null;
  }
  return body;
}

/**
 * The registration as Better Auth should read it: unchanged when it names an
 * `application_type` or none can be derived, otherwise re-sent with the
 * derived one.
 */
function withApplicationType(request: Request, body: Record<string, unknown>) {
  if (body.application_type !== undefined) return request;
  const applicationType = derivedApplicationType(
    body.redirect_uris as string[],
  );
  if (!applicationType) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({ ...body, application_type: applicationType }),
    signal: request.signal,
  });
}

export function createAuthRouteHandler(handler: AuthHandler): AuthHandler {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/api/auth/oauth2/register") {
      const registration = await validateDynamicClientRegistration(request);
      if (!registration) {
        return Response.json(
          {
            error: "invalid_client_metadata",
            error_description: "Public client metadata is invalid.",
          },
          { status: 400 },
        );
      }
      return await handler(withApplicationType(request, registration));
    }
    const response = await handler(request);
    if (
      request.method !== "GET" ||
      pathname !== "/api/auth/magic-link/verify"
    ) {
      return response;
    }
    if (await isSignupPolicyDenial(request, response)) {
      return new Response(null, {
        status: 302,
        headers: { location: "/auth-error?error=signup_disabled" },
      });
    }
    return response;
  };
}

/**
 * Whether a magic-link verification was refused by the signup policy, whose
 * refusal carries the code `signup_disabled` (`server-options.ts`).
 *
 * Better Auth 1.7.6's verify endpoint catches that refusal and redirects to
 * the link's own `errorCallbackURL`, absolute, with `error` set to the code
 * and `error_description` to its message. Better Auth 1.6.29 answered it with
 * a 403 whose JSON body carried the code. Both are recognised, so a denied
 * person always lands on the one fixed page, whatever `errorCallbackURL` the
 * link was minted with.
 *
 * A redirect that sets a cookie is not treated as a denial. The success path
 * redirects to the link's `callbackURL` after `setSessionCookie`
 * (`index.mjs:184-194`), and that URL may itself carry
 * `error=signup_disabled`; rewriting it would build a fresh response without
 * the session cookie, leaving a session behind a page that says the person was
 * refused. The policy's refusal is redirected from the `createUser` call
 * (`index.mjs:164-170`), before a session is created or its cookie set.
 */
async function isSignupPolicyDenial(request: Request, response: Response) {
  if (response.status >= 300 && response.status < 400) {
    if (response.headers.has("set-cookie")) return false;
    const location = response.headers.get("location");
    if (!location) return false;
    try {
      return (
        new URL(location, request.url).searchParams.get("error") ===
        "signup_disabled"
      );
    } catch {
      return false;
    }
  }
  if (response.status !== 403) return false;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    body.code === "signup_disabled"
  );
}
