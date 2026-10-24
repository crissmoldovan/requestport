import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * The authorization half of a checkout's binding.
 *
 * `project.ts` answers "which project"; this answers "may I", and the two are
 * deliberately different files because they have different lifetimes and
 * different custody. Nothing here is ever written to the repository.
 *
 * Every request is made through an injected `fetch`. The default is the global
 * one, so a caller passes nothing; a test passes a stub, which is what keeps
 * this suite from registering junk clients against the real server.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One error type, and a rule about what may go in it: the endpoint and the HTTP
 * status, and nothing else.
 *
 * A code, a verifier or a token in an error message outlives the request it
 * came from — it lands in a log, a CI transcript, a bug report — and the value
 * is still valid when it gets there. Every `throw` below is written against
 * that rule, and `oauth.test.ts` holds it to it.
 */
export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/**
 * The token endpoint's refusals that can be told apart: RFC 6749 §5.2's error
 * codes, and RFC 8707's `invalid_target`. A fixed set of words, so one can be
 * carried in a message; the `error_description` beside it is free text, which
 * a server may fill with the value it refused, so it is never read.
 */
const TOKEN_ERROR_CODES = [
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "invalid_target",
  "unauthorized_client",
  "unsupported_grant_type",
] as const;

export type TokenErrorCode = (typeof TOKEN_ERROR_CODES)[number];

/**
 * The token endpoint refused a request: its HTTP status and, when the body
 * named one from the fixed set, its error code. `invalid_grant` is what the
 * provider answers for every refresh token it will not honour, which is
 * what tells a dead credential from a failing server.
 */
export class TokenRequestError extends OAuthError {
  readonly error: TokenErrorCode | undefined;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    error: TokenErrorCode | undefined,
  ) {
    super(message);
    this.name = "TokenRequestError";
    this.error = error;
    this.status = status;
  }
}

export const WELL_KNOWN_PATH = "/.well-known/oauth-authorization-server";

/**
 * The scopes RequestPort grants an agent, listed so a CLI can offer them.
 *
 * Deliberately not a default anywhere in this file. The consent screen exists to
 * let a developer grant the few capabilities their agent actually needs, and a
 * default of "all of them" is the same as not having asked.
 *
 * Every *working* scope the domain defines. The first version of this list held
 * twelve — `import:write` and `webhook:manage` were missing, so an agent that
 * needed either could not ask for it through this client at all, and would have
 * failed at the first call with a scope error rather than at consent where the
 * reason is visible. A contract test holds the two lists to the same answer.
 *
 * `project:provision` is deliberately absent. It is not a working scope: it is
 * organization-wide, exclusive of every scope here, and belongs to a separate
 * grant obtained by a separate consent. Offering it beside these would invite
 * exactly the combination the database refuses — a credential that can both
 * mint projects and act inside them.
 */
export const AGENT_SCOPES = [
  "agent:register",
  "import:write",
  "org:read",
  "project:read",
  "question:answer",
  "request:complete",
  "request:create",
  "request:read",
  "request:triage",
  "request:verify",
  "request:write",
  "webhook:manage",
  "work:claim",
  "work:update",
] as const;

/**
 * Without this scope the server issues no refresh token, so the grant dies at
 * the first access-token expiry and the developer consents again. Named here
 * because the alternative is discovering it fifteen minutes into a session.
 */
export const REFRESH_SCOPE = "offline_access";

/*
  `z.url()` keeping a tab or newline inside a URL: what zod 4.4.3 answered
  for the client at 0.2.0, kept on zod 4.6.7. `@requestport/domain`'s
  `shared/zod-compat.ts` holds the same helper and says what moved; this
  package depends on no other workspace, so it keeps a copy here, beside
  its four uses.
*/
function parsesAsUrl(value: string) {
  return URL.canParse(value.trim());
}

function trimmedUrl() {
  return z
    .stringFormat("url", parsesAsUrl)
    .overwrite((value) => (parsesAsUrl(value) ? value.trim() : value));
}

/**
 * Not `strict()`, unlike the binding schema in `project.ts`, and for the
 * opposite reason: that file is ours and must not grow a secret, while this
 * document is the server's and is expected to grow fields as RFCs land.
 * Refusing an unknown key here would break the client on the server's next
 * deploy. Unknown keys are dropped instead of trusted.
 */
const MetadataSchema = z.object({
  authorization_endpoint: trimmedUrl(),
  /**
   * RFC 9207: true when every authorization response names its issuer in an
   * `iss` parameter. `authorize` turns it into what `readCallback` requires.
   */
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  /**
   * Required, though RFC 8414 makes it optional. A server that will not say it
   * can do S256 is a server we will not send a challenge to — and "it probably
   * can" is how a client ends up falling back to `plain`, which proves nothing.
   */
  code_challenge_methods_supported: z
    .array(z.string())
    .refine((methods) => methods.includes("S256"), {
      message: "the server must support the S256 code challenge method",
    }),
  grant_types_supported: z.array(z.string()).optional(),
  issuer: trimmedUrl(),
  registration_endpoint: trimmedUrl().optional(),
  response_types_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
  token_endpoint: trimmedUrl(),
});

export type AuthorizationServerMetadata = z.infer<typeof MetadataSchema>;

const RegisteredClientSchema = z.object({
  client_id: z.string().min(1),
  client_id_issued_at: z.number().optional(),
  scope: z.string().optional(),
});

export type RegisteredClient = z.infer<typeof RegisteredClientSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  /**
   * Compared case-insensitively because RFC 6749 says the type is, and refused
   * otherwise: anything but Bearer needs a different Authorization header, and
   * sending a Bearer header for a token that is not one leaks it to a server
   * that will reject it.
   */
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer", {
    message: "only a Bearer token can be presented to this server",
  }),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export type Pkce = {
  readonly challenge: string;
  readonly method: "S256";
  readonly verifier: string;
};

export type AuthorizationRequest = {
  readonly pkce: Pkce;
  readonly state: string;
  readonly url: string;
};

function originOf(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(`The ${label} is not a valid absolute url.`);
  }
  return url.origin;
}

type EndpointName =
  | "authorization_endpoint"
  | "registration_endpoint"
  | "token_endpoint";

/**
 * The single place an endpoint is turned into a URL to call, so the same
 * question is asked every time: does this endpoint belong to the issuer?
 *
 * Metadata is a document that says where to send credentials. One field of it
 * pointing at another host is all it takes to have the code, the verifier and
 * the refresh token posted to somebody else — and the caller would see a
 * perfectly ordinary-looking flow. Checked again here rather than only at
 * discovery, because metadata can also be handed to these functions directly.
 */
function endpoint(
  metadata: AuthorizationServerMetadata,
  name: EndpointName,
): string {
  const value = metadata[name];
  if (value === undefined) {
    throw new OAuthError(
      `${metadata.issuer} publishes no ${name}, so this step is not available on this server.`,
    );
  }

  const issuer = originOf(metadata.issuer, "issuer");
  if (originOf(value, name) !== issuer) {
    throw new OAuthError(
      `The ${name} ${value} is not on the issuer's origin ${issuer}. Refusing rather than sending this project's credentials to another host.`,
    );
  }

  return value;
}

async function readJson(response: Response, where: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // The body is never echoed. What we know about a body we could not parse is
    // that we do not know what is in it — an HTML login page, a proxy error, or
    // a token in a field we were not expecting.
    throw new OAuthError(`${where} did not return JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Scopes are space-delimited on the wire, so a scope containing a space is two
 * scopes by the time the server reads it. Refused here rather than sent, because
 * the failure is silent: the developer is shown a consent screen for something
 * other than what the caller asked for.
 */
function joinScopes(scopes: readonly string[]): string {
  if (scopes.length === 0) {
    throw new OAuthError(
      "No scope was asked for. A grant with no scope can do nothing, so this is a caller mistake rather than a minimal request.",
    );
  }

  for (const scope of scopes) {
    if (scope === "" || /\s/u.test(scope)) {
      throw new OAuthError(
        `The scope ${JSON.stringify(scope)} is empty or contains whitespace, and scopes are space-delimited on the wire.`,
      );
    }
  }

  return scopes.join(" ");
}

/**
 * RFC 8252's rule for a client with no secret: https anywhere, or plain http
 * only on the loopback interface, where "the network" is this machine. Any
 * other http redirect hands the authorization code to whoever is between the
 * browser and that host.
 */
function assertRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("The redirect uri is not a valid absolute url.");
  }

  if (url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new OAuthError(
      `The redirect uri ${value} carries a fragment or credentials, and the authorization server will refuse it.`,
    );
  }

  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  ) {
    return;
  }

  throw new OAuthError(
    `The redirect uri ${value} must be https, or http on the loopback interface.`,
  );
}

/**
 * Fetch and validate the server's own description of itself.
 *
 * The `server` argument is the one from `.requestport/project.json` — the
 * origin a developer committed — and everything this client does afterwards is
 * addressed from the document found there.
 */
export async function discover(
  server: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<AuthorizationServerMetadata> {
  const origin = originOf(server, "server");
  const document = `${origin}${WELL_KNOWN_PATH}`;

  const response = await fetch(document, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new OAuthError(
      `${document} did not return authorization-server metadata (HTTP ${response.status}).`,
    );
  }

  const result = MetadataSchema.safeParse(await readJson(response, document));
  if (!result.success) {
    // Field names and reasons, never values: the document is public, but this
    // is the one response that has not been established as the real server's.
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");

    throw new OAuthError(`${document} is not valid metadata — ${detail}.`);
  }
  const metadata = result.data;

  /**
   * The check that makes the rest of the file safe.
   *
   * A document served from one origin that names another as its issuer is not a
   * misconfiguration to work around — it is a redirect, and the thing being
   * redirected is every credential in the flow. A compromised or merely
   * mistaken `/.well-known` could otherwise point the token endpoint at
   * `requestport.com.evil.example` and the developer would see a normal login.
   */
  if (originOf(metadata.issuer, "issuer") !== origin) {
    throw new OAuthError(
      `${document} names issuer ${metadata.issuer}, which is not ${origin}. Refusing: metadata for another origin sends every later request, including the token exchange, somewhere nobody here named.`,
    );
  }

  // Resolved now so a foreign endpoint fails at discovery rather than at the
  // moment a credential would have been posted to it.
  endpoint(metadata, "authorization_endpoint");
  endpoint(metadata, "token_endpoint");
  if (metadata.registration_endpoint !== undefined) {
    endpoint(metadata, "registration_endpoint");
  }

  return metadata;
}

/**
 * A verifier, and the challenge derived from it.
 *
 * PKCE is the whole of this client's proof of possession — a public client has
 * no secret — so the verifier is generated from the CSPRNG and never leaves
 * this process until the exchange. 32 bytes is 256 bits, and base64url-encodes
 * to the 43 characters that are RFC 7636's minimum.
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");

  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    // `plain` is the other method the RFC allows and this client never emits
    // it: it puts the verifier itself in a URL, in a browser, in history.
    method: "S256",
    verifier,
  };
}

export function createState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Register the agent as a public client.
 *
 * Public is the honest description of software on a developer's laptop: there
 * is no place to keep a client secret that the developer — or anything else
 * running as them — cannot read. So we ask for none, and prove possession with
 * PKCE instead.
 */
export async function registerClient(
  options: {
    readonly clientName: string;
    readonly metadata: AuthorizationServerMetadata;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
  },
  fetch: FetchLike = globalThis.fetch,
): Promise<RegisteredClient> {
  const target = endpoint(options.metadata, "registration_endpoint");
  assertRedirectUri(options.redirectUri);
  const scope = joinScopes(options.scopes);

  const response = await fetch(target, {
    body: JSON.stringify({
      client_name: options.clientName,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [options.redirectUri],
      require_pkce: true,
      response_types: ["code"],
      scope,
      token_endpoint_auth_method: "none",
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new OAuthError(
      `${target} refused the client registration (HTTP ${response.status}).`,
    );
  }

  const body = await readJson(response, target);

  /**
   * We registered with `token_endpoint_auth_method: "none"`. A secret in the
   * answer means the server thinks this is a confidential client, and accepting
   * it would mean writing a long-lived secret to a developer's disk to satisfy
   * a disagreement. Refusing is the only option that does not end in a secret
   * stored badly.
   */
  if (isRecord(body) && body.client_secret !== undefined) {
    throw new OAuthError(
      `${target} issued a client secret to a client that registered with no authentication method. Refusing: this client has nowhere to keep one.`,
    );
  }

  const result = RegisteredClientSchema.safeParse(body);
  if (!result.success) {
    throw new OAuthError(
      `${target} did not return a usable client registration.`,
    );
  }

  return result.data;
}

/**
 * The URL the developer opens, plus the two values this process must keep to
 * finish the flow: the state it will check the callback against, and the
 * verifier it will present at the exchange.
 *
 * `state` and `pkce` are accepted so a caller resuming a flow can supply the
 * ones it stored; left out, both are freshly random, which is the case that
 * matters.
 */
export function buildAuthorizationUrl(options: {
  readonly clientId: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly pkce?: Pkce;
  readonly redirectUri: string;
  readonly resource?: string;
  readonly scopes: readonly string[];
  readonly state?: string;
}): AuthorizationRequest {
  const target = endpoint(options.metadata, "authorization_endpoint");
  assertRedirectUri(options.redirectUri);
  const scope = joinScopes(options.scopes);
  const pkce = options.pkce ?? createPkce();
  const state = options.state ?? createState();

  const url = new URL(target);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  // The challenge, never the verifier — the point of S256 is that this URL can
  // be read by the browser, the history file and anything watching, and still
  // not be enough to redeem the code.
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  if (options.resource !== undefined) {
    url.searchParams.set("resource", options.resource);
  }

  return { pkce, state, url: url.toString() };
}

/**
 * The state is a per-flow secret, so it is compared the way a secret is. The
 * length is not the secret and is allowed to short-circuit.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * What a callback must match to be this flow's.
 *
 * `issuer` is RFC 9207's half. `identifier` is the issuer discovery
 * established, and `required` is whether that server's metadata promised to
 * name itself in every authorization response
 * (`authorization_response_iss_parameter_supported`). Without `issuer` an
 * `iss` in the callback is not read at all, which is how this function
 * behaved before it knew the parameter.
 */
export type ExpectedCallback = {
  readonly issuer?: {
    readonly identifier: string;
    readonly required: boolean;
  };
  readonly state: string;
};

/**
 * RFC 9207 §2.4: compare `iss` with the expected issuer, as a plain string.
 *
 * Exact, not by origin: the issuer identifier is a string the server chose,
 * and a near match is a different server's name. A server that never
 * advertised the parameter but sends one is left by the RFC to local policy;
 * this client's is to compare a name that is present either way, because a
 * foreign issuer is foreign whether or not it was promised.
 *
 * The callback's own value is never repeated. It arrived from the browser,
 * so it is text an attacker chose, and the expected issuer — established by
 * discovery — is the one name a message can safely carry.
 */
function assertIssuer(
  query: URLSearchParams,
  issuer: NonNullable<ExpectedCallback["issuer"]>,
): void {
  const named = query.get("iss");

  if (named === null) {
    if (!issuer.required) return;
    throw new OAuthError(
      `The authorization callback did not name its issuer, though ${issuer.identifier} says every one of its responses does (RFC 9207). Refusing: a response without the name could have come from another authorization server.`,
    );
  }

  if (named !== issuer.identifier) {
    throw new OAuthError(
      `The authorization callback names an issuer other than ${issuer.identifier} (RFC 9207). Refusing rather than exchanging a code, or believing an error, from an authorization server this flow did not start with.`,
    );
  }
}

/**
 * Read the redirect the browser landed on.
 *
 * This is the one message in the flow that arrives from outside the process, so
 * it is the one an attacker can try to write. The state is what says the
 * authorization being finished is the one this process started; without that
 * check a link a developer clicks can graft somebody else's authorization onto
 * this session. The issuer, when one is expected, is what says which server
 * finished it, and it is judged before an error in the response is believed:
 * RFC 9207 §2.4 says an error must not be assumed to come from the intended
 * server either.
 */
export function readCallback(
  callbackUrl: string,
  expected: ExpectedCallback,
): { readonly code: string } {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new OAuthError("The authorization callback is not a valid url.");
  }

  const query = url.searchParams;
  const state = query.get("state");
  // Neither state nor the code appears in this message. Both are live secrets
  // at the moment it is thrown, and a mismatch is exactly when someone will
  // paste the error somewhere to ask what went wrong.
  if (state === null || !constantTimeEquals(state, expected.state)) {
    throw new OAuthError(
      "The authorization callback carried a state that does not match this flow's. Refusing rather than exchanging a code from an authorization this process did not start.",
    );
  }

  if (expected.issuer !== undefined) assertIssuer(query, expected.issuer);

  const failure = query.get("error");
  if (failure !== null) {
    throw new OAuthError(
      `The authorization server refused the request: ${failure}.`,
    );
  }

  const code = query.get("code");
  if (code === null || code === "") {
    throw new OAuthError("The authorization callback carried no code.");
  }

  return { code };
}

/** The refusal's `error`, when it is one of the fixed set; nothing else. */
async function refusalCode(
  response: Response,
): Promise<TokenErrorCode | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  const code = isRecord(body) ? body.error : undefined;
  return TOKEN_ERROR_CODES.find((known) => known === code);
}

async function requestTokens(
  metadata: AuthorizationServerMetadata,
  parameters: Readonly<Record<string, string>>,
  fetch: FetchLike,
): Promise<TokenResponse> {
  const target = endpoint(metadata, "token_endpoint");

  const response = await fetch(target, {
    body: new URLSearchParams(parameters).toString(),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    // The endpoint, the status and the error code from the fixed set, and
    // deliberately nothing else from the body: an `error_description`
    // routinely quotes the code or token back at you, and this message is the
    // most likely thing in the whole flow to be pasted into an issue tracker.
    const code = await refusalCode(response);
    throw new TokenRequestError(
      `${target} refused the token request (HTTP ${response.status}${code === undefined ? "" : `, ${code}`}).`,
      response.status,
      code,
    );
  }

  const result = TokenResponseSchema.safeParse(
    await readJson(response, target),
  );
  if (!result.success) {
    // No field detail either, unlike discovery: this is the one response that
    // is made of secrets, and a body shaped wrongly is precisely where a token
    // sits in a field nobody expected.
    throw new OAuthError(`${target} did not return a usable token response.`);
  }

  return result.data;
}

export function exchangeCode(
  options: {
    readonly clientId: string;
    readonly code: string;
    readonly metadata: AuthorizationServerMetadata;
    readonly redirectUri: string;
    readonly resource?: string;
    readonly verifier: string;
  },
  fetch: FetchLike = globalThis.fetch,
): Promise<TokenResponse> {
  const parameters: Record<string, string> = {
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.verifier,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
  };
  if (options.resource !== undefined) parameters.resource = options.resource;

  return requestTokens(options.metadata, parameters, fetch);
}

/**
 * Scopes are optional and may only narrow — RFC 6749 allows a refresh to ask
 * for less than the grant holds and never for more. Passing none keeps what the
 * developer consented to.
 */
export function refresh(
  options: {
    readonly clientId: string;
    readonly metadata: AuthorizationServerMetadata;
    readonly refreshToken: string;
    readonly resource?: string;
    readonly scopes?: readonly string[];
  },
  fetch: FetchLike = globalThis.fetch,
): Promise<TokenResponse> {
  const parameters: Record<string, string> = {
    client_id: options.clientId,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  };
  if (options.scopes !== undefined) {
    parameters.scope = joinScopes(options.scopes);
  }
  if (options.resource !== undefined) parameters.resource = options.resource;

  return requestTokens(options.metadata, parameters, fetch);
}
