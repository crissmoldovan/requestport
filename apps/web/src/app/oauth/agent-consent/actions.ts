"use server";

import { agentGrantService, auth } from "@requestport/auth/server";
import { serverEnv } from "@requestport/config/server";
import { createAgentAuthRepository } from "@requestport/db";
import {
  agentScopes,
  DomainError,
  keyedFingerprint,
} from "@requestport/domain";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { namedValidationFailure } from "../../../lib/action-field-issues.js";
import { carryingIntoSignIn } from "../../../lib/application-context.js";
import { webLogger } from "../../../lib/observability.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { humanCommandContext } from "../../../lib/server-core-commands.js";
import { webStorage } from "../../../lib/server-request-port.js";
import type { ConsentActionState } from "./consent-action-state.js";
import {
  consentFieldNames,
  newAgentPrincipalValue,
} from "./consent-action-state.js";
import { uuidFromDigest } from "./uuid-from-digest.js";

const resources = new Map([
  [new URL("/mcp", serverEnv.BETTER_AUTH_URL).toString(), "mcp"],
  [new URL("/api/v1", serverEnv.BETTER_AUTH_URL).toString(), "api"],
] as const);

const decisionSchema = z.object({
  oauthQuery: z.string().min(1).max(16_384),
  clientId: z.string().min(1).max(255),
  /**
   * `<organizationId>:<projectId>`, or `<organizationId>:` for an
   * organization-wide grant.
   *
   * The bound was an exact 73 — the length of two uuids and a colon — which
   * rejected every provisioning approval before the parser below ever saw it.
   * The page had been changed to submit 37 characters and this had not, so the
   * organization branch, the null-project parser, and every rule behind them
   * were unreachable. The shape is still checked, by the parser, against uuids
   * rather than against a character count.
   */
  projectBinding: z.string().min(37).max(73),
  laneIds: z.array(z.uuid()).max(100),
  agentPrincipalId: z.union([z.literal(newAgentPrincipalValue), z.uuid()]),
  displayName: z.string().trim().max(160).optional(),
  slug: z.string().trim().toLowerCase().max(63).optional(),
  softwareName: z.string().trim().max(160).optional(),
});

const newPrincipalSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
  softwareName: z.string().trim().min(1).max(160),
});

/**
 * Every refusal this surface can render, as fixed copy.
 *
 * The message is chosen by the domain's own code rather than echoed from the
 * error, so no provider, driver or query text can reach a consent page that an
 * unauthenticated browser can navigate to.
 */
const consentFailureMessages: Record<string, string> = {
  conflict:
    "That connection conflicts with the current state. Reload the request and try again.",
  forbidden: "You do not have permission to authorize this connection.",
  idempotency_conflict:
    "This consent was already recorded with different values.",
  not_found: "That project, lane, or principal is no longer available.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  validation_failed: "Check the supplied values and try again.",
  version_conflict: "This request changed. Reload it and try again.",
};

const consentFailureMessage = "That connection could not be authorized.";

/**
 * A rejected submission, addressed to the control it is about.
 *
 * A schema rejection travels with the name of the field it belongs to, which
 * is what routes it to that control's own error line; the form declares which
 * of those names it draws, so a rejection about a hidden value stays in the
 * banner instead of disappearing. Everything else is fixed copy.
 */
/**
 * What refused, as a token an operator can act on.
 *
 * The browser gets fixed copy on purpose — this page is reachable
 * unauthenticated and no provider, driver or query text may reach it. But the
 * error was being discarded rather than merely withheld, so a consent that
 * failed left nothing behind anywhere: not in the response, not in the logs.
 *
 * Every consent submitted against production failed for a week and the only
 * way to find out why was to reproduce it by hand against the database. This
 * is the missing half: the person still sees fixed copy, and the operator gets
 * the name of the check that refused.
 *
 * Only tokens are emitted — a domain code, or an OAuth error identifier, both
 * fixed vocabularies. Never a message, and never anything the request carried.
 */
/**
 * The refusal's own words, when they are plainly words.
 *
 * This was a closed map of the literals that seemed to matter, and it was
 * twice wrong: production refused with a description neither entry held, so
 * the log said `oauth_invalid_request` and nothing more — twice, each time
 * costing a deployment to learn nothing.
 *
 * A description is admitted only if it is short and made of letters, digits,
 * spaces, underscores and hyphens. Every phrase this library raises looks like
 * that — "missing oauth query", "redirect_uri mismatch". A url, an address, a
 * token or anything long does not, and is dropped rather than logged. The
 * point is to stop guessing which phrases matter while still never printing
 * something a request carried.
 */
const PLAIN_WORDS = /^[A-Za-z0-9 _-]{1,80}$/u;

function describedAs(description: unknown) {
  if (typeof description !== "string" || !PLAIN_WORDS.test(description)) {
    return undefined;
  }
  return description.trim().toLowerCase().replaceAll(" ", "_");
}

function failureCode(error: unknown) {
  if (error instanceof z.ZodError) return "schema_rejected";
  if (error instanceof DomainError) return error.code;
  const body = (
    error as {
      body?: { error?: unknown; error_description?: unknown };
    } | null
  )?.body;
  if (typeof body?.error === "string") {
    const named = describedAs(body.error_description);
    return named ? `oauth_${body.error}.${named}` : `oauth_${body.error}`;
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "string") return `api_${status.toLowerCase()}`;
  return "unhandled";
}

/**
 * How long to wait, when the refusal is that you did not.
 *
 * The limiter knows, and said so — it carries `retryAfterSeconds` on the
 * refusal. Without it the person is told only that there were too many
 * attempts, which reads as an invitation to make another one immediately, and
 * the next attempt is refused for the same reason. The number is the only part
 * of this particular refusal anybody can act on.
 */
function withRetryAfter(message: string, error: unknown) {
  const seconds = (
    error as { details?: { retryAfterSeconds?: unknown } } | null
  )?.details?.retryAfterSeconds;
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return message;
  }
  return `${message.replace(/\.$/u, "")} in about ${Math.ceil(seconds)} seconds.`;
}

/**
 * Which attempt, by whom, against which client.
 *
 * A refusal used to log its cause and nothing else, so two failures a minute
 * apart were one indistinguishable line — and diagnosing the last one meant
 * rebuilding the request against the production database by hand.
 *
 * The client is read from the form rather than from a parse of the signed
 * query, and read before anything that can throw. Every refusal this surface
 * can make still knows which client it was about, including the ones that
 * happen because the query cannot be parsed at all — which were precisely the
 * refusals that most needed naming.
 *
 * It is fingerprinted rather than named. A client id is not a secret, but it
 * is request-supplied, and the logger's discipline is that nothing a request
 * carried appears verbatim; a digest joins two lines together just as well.
 */
type RefusalIdentity = {
  actorId?: string;
  clientId?: unknown;
};

function errorState(
  error: unknown,
  identity: RefusalIdentity = {},
): ConsentActionState {
  // Absent fields are left out rather than sent as `undefined`, so a line says
  // what was known and the shape stays closed enough to assert against.
  webLogger.warn("oauth.agent_consent_refused", {
    ...(identity.actorId
      ? { actorId: identity.actorId, actorType: "user" as const }
      : {}),
    ...(typeof identity.clientId === "string" && identity.clientId
      ? {
          credentialFingerprint: keyedFingerprint(
            serverEnv.BETTER_AUTH_SECRET,
            identity.clientId,
          ),
        }
      : {}),
    errorCode: failureCode(error),
  });
  if (error instanceof z.ZodError) {
    return { status: "error", ...namedValidationFailure(error.issues) };
  }
  if (error instanceof DomainError) {
    const message = consentFailureMessages[error.code] ?? consentFailureMessage;
    /*
      A refusal about one field belongs on that field.

      The binder names the control when it can — a stable slug already taken is
      something the person can fix where they typed it, and the banner for this
      code says to reload, which would fail again for the same reason.
    */
    const field = error.details.field;
    if (
      typeof field === "string" &&
      (consentFieldNames as readonly string[]).includes(field)
    ) {
      return { field, message: error.message, status: "error" };
    }

    return {
      message:
        error.code === "rate_limited"
          ? withRetryAfter(message, error)
          : message,
      status: "error",
    };
  }
  return { message: consentFailureMessage, status: "error" };
}

function parseSignedRequest(oauthQuery: string) {
  const query = new URLSearchParams(oauthQuery);
  const clientId = query.get("client_id");
  const named = query.getAll("resource");
  const requestedScopes = [
    ...new Set((query.get("scope") ?? "").split(" ").filter(Boolean)),
  ];
  /**
   * One known resource is that audience; absent means MCP; anything else is
   * refused.
   *
   * Better Auth 1.7.6 signs every `resource` the agent sent onto the consent
   * redirect — its authorisation query schema admits the parameter, once or
   * several times — so what arrives here is what the agent asked for. A grant
   * binds exactly one audience, so a request naming two values (even the same
   * one twice) cannot be consented as asked, and choosing one for the person
   * would grant what nobody chose. An unknown value is a request for something
   * this server does not serve.
   *
   * An agent may still send none, as RFC 8707 allows. Absence stays `mcp`,
   * because that is the audience this product's agents connect on and the one
   * the consent screen has always described. The provider then leaves the
   * token's resource to the token request, and the grant bound here is what
   * the bearer path holds that token to.
   */
  const audience =
    named.length === 0
      ? "mcp"
      : named.length === 1
        ? resources.get(named[0] as string)
        : undefined;
  if (!clientId || !audience) {
    throw new DomainError("validation_failed", "OAuth request is invalid");
  }
  const grantedAgentScopes = requestedScopes.filter((scope) =>
    (agentScopes as readonly string[]).includes(scope),
  );
  if (!grantedAgentScopes.length) {
    throw new DomainError(
      "validation_failed",
      "No RequestPort agent scopes were requested",
    );
  }
  if (
    requestedScopes.some(
      (scope) =>
        scope !== "openid" &&
        scope !== "offline_access" &&
        !(agentScopes as readonly string[]).includes(scope),
    )
  ) {
    throw new DomainError(
      "validation_failed",
      "OAuth request contains an unsupported scope",
    );
  }
  return {
    audience,
    clientId,
    grantedAgentScopes,
    requestedScopes,
  };
}

/**
 * Both actions here resolve the session before they read the submission.
 *
 * Consent is reachable from an unauthenticated browser, and `parseSignedRequest`
 * answers a series of increasingly specific questions about the query it is
 * handed — unsupported scope, no agent scope, unknown resource. Reading first
 * made those answers available to a caller who had not signed in, from an
 * endpoint whose limiter is resolved after the very call they had skipped.
 *
 * The limiter itself stays where it is, and cannot move above the parse: its
 * fingerprint is keyed by the OAuth client, and the only place the client is
 * named is the submission. Authentication is what bounds the asking now, and
 * the limiter still runs before anything is written or granted.
 */
export async function approveAgentConsentAction(
  _previous: ConsentActionState,
  formData: FormData,
): Promise<ConsentActionState> {
  /*
    Filled in by the step that authorizes, never before it.

    Reading the submission here named the client on every refusal, including
    the ones raised before anybody had been authorized — which is the one
    ordering this application does not allow: an action reaches the session
    and the limiter before it touches what was submitted. A refusal that
    predates authorization now names no client, because at that point nothing
    has established the right to ask about one.
  */
  const identity: RefusalIdentity = {};
  try {
    return await approveConsent(formData, identity);
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error, identity);
  }
}

/**
 * Better Auth's consent endpoint finishes by running its own authorization
 * handler, and that handler's first act is `if (!ctx.request) throw`. A server
 * action has no HTTP request to hand it — `auth.api.*` is a direct call — so
 * the endpoint recorded the consent and then refused, every time, with
 * `invalid_request` and the words "request not found".
 *
 * That is why Better Auth's half of every consent succeeded and this
 * application's half never ran: the failure lands between them.
 *
 * The endpoint accepts a `request`, so it gets one. The headers are the
 * browser's, forwarded, because the session cookie travels on them; the url is
 * the endpoint's own, which is what the handler reads it for.
 */
/**
 * Where to send the browser, and whether anything was actually authorized.
 *
 * The consent endpoint has one answer shape, `{ redirect: true, url }`: it
 * forces `accept: application/json` onto its own context before delegating, so
 * the branch of `handleRedirect` that throws a 302 is unreachable from here.
 * There is no `location` header on this path and never was.
 *
 * **A url is not proof of consent.** Denial answers with a url. So does every
 * refusal the authorization step can make — unknown client, bad redirect uri,
 * missing PKCE — and so does a re-prompt. Each carries the person somewhere
 * sensible and none of them issued anything. The single positive signal is a
 * `code` in the destination, and a grant may be bound on nothing less.
 */
function authorizedDestination(result: unknown) {
  const url = (result as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new DomainError(
      "validation_failed",
      "The authorization server named no destination to return to",
    );
  }
  const destination = new URL(url, serverEnv.BETTER_AUTH_URL);
  if (!destination.searchParams.has("code")) {
    throw new DomainError(
      "validation_failed",
      destination.searchParams.get("error") ?? "consent_not_issued",
    );
  }
  return url;
}

/**
 * The principal id a consent proposes, derived rather than minted.
 *
 * The page used to render `randomUUID()`, which is evaluated per render — so a
 * retry submitted a different id, and the idempotency receipt covers
 * `newPrincipal`. Same key, different input: `idempotency_conflict`, forever,
 * because each retry minted another one. Retrying is the only thing a person
 * can do at that point, and it could never work.
 *
 * Keyed on the command secret because the value must not be computable by
 * anyone holding the public query; keyed on the user because two people
 * approving the same agent's link must not be handed one principal — the
 * repository's fallback lookup matches on organization and id alone, so the
 * second consent would silently bind to the first person's principal.
 */
function proposedPrincipalId(oauthQuery: string, userId: string) {
  return uuidFromDigest(
    keyedFingerprint(
      serverEnv.BETTER_AUTH_SECRET,
      `oauth-consent-principal:${userId}:${oauthQuery}`,
    ),
  );
}

async function consentRequest() {
  return new Request(
    new URL("/api/auth/oauth2/consent", serverEnv.BETTER_AUTH_URL),
    { method: "POST", headers: await headers() },
  );
}

/**
 * The gate, holding the request this submission is about.
 *
 * A consent screen is read slowly and a session can lapse underneath it — a
 * timeout, or a sign-out in another tab — and the gate then sends the browser
 * to sign in. Bare, that discarded the authorization: sign-in had nothing to
 * resume, the person landed on the application with no mention of the agent,
 * and the agent waited out its loopback callback. The signed query is on the
 * submission, and it is all `(auth)/sign-in/authorization-resume.ts` needs.
 *
 * Handed over as a thunk, and read only if that redirect happens — so this
 * action still resolves the session before it touches what was submitted.
 */
function consentApplicationContext(formData: FormData) {
  return carryingIntoSignIn(
    () => formData.get("oauthQuery"),
    () => getApplicationContext(),
  );
}

async function approveConsent(
  formData: FormData,
  identity: RefusalIdentity,
): Promise<never> {
  const application = await consentApplicationContext(formData);
  identity.actorId = application.session.user.id;
  const input = decisionSchema.parse({
    oauthQuery: formData.get("oauthQuery"),
    clientId: formData.get("clientId"),
    projectBinding: formData.get("projectBinding"),
    laneIds: formData.getAll("laneIds"),
    agentPrincipalId: formData.get("agentPrincipalId"),
    displayName: formData.get("displayName"),
    slug: formData.get("slug"),
    softwareName: formData.get("softwareName"),
  });
  identity.clientId = input.clientId;
  const request = parseSignedRequest(input.oauthQuery);
  // Derived from the signed query and the person, never from the form: a value
  // the browser chooses is a value a retry can change, and changing it is what
  // made retrying impossible.
  const newPrincipalId = proposedPrincipalId(
    input.oauthQuery,
    application.session.user.id,
  );
  if (request.clientId !== input.clientId) {
    throw new DomainError("validation_failed", "OAuth client binding changed");
  }
  const [organizationId, projectId, extra] = input.projectBinding.split(":");
  /**
   * An empty project half means an organization-wide grant.
   *
   * A provisioning grant names no project, and the consent screen submits that
   * as `organizationId:` — explicit rather than inferred from a missing field,
   * so the one parser here still reads the one shape. Anything else in that
   * position is still a uuid or a refusal.
   */
  const boundProjectId = projectId === "" ? null : projectId;
  if (
    extra ||
    !z.uuid().safeParse(organizationId).success ||
    (boundProjectId !== null && !z.uuid().safeParse(boundProjectId).success)
  ) {
    throw new DomainError(
      "validation_failed",
      "OAuth project binding is invalid",
    );
  }
  await enforceRateLimit({
    endpointClass: "token",
    fingerprint: rateLimitFingerprint(
      application.session.user.id,
      input.clientId,
      "oauth-consent",
    ),
  });
  const context = humanCommandContext(application.session, organizationId);
  const proposed =
    input.agentPrincipalId === newAgentPrincipalValue
      ? newPrincipalSchema.parse({
          displayName: input.displayName,
          slug: input.slug,
          softwareName: input.softwareName,
        })
      : null;
  /**
   * No `scope`, deliberately.
   *
   * Better Auth treats it as optional and documents the omission: "If none is
   * provided, then all originally requested scopes are accepted." That is
   * exactly what this screen means — the person approved the request in front
   * of them, whole.
   *
   * Sending it bought nothing and could only disagree. The value was rebuilt
   * from the same signed query Better Auth had already parsed, and every
   * scope it contains was compared against every scope it contains; the one
   * outcome that check could add was a refusal if the two derivations ever
   * differed by a separator, an ordering, or a duplicate. `invalid_request`
   * is what that refusal looks like from here, and it is indistinguishable
   * from several others.
   */
  /**
   * `asResponse: false`, deliberately and explicitly.
   *
   * Better Auth reads `asResponse ?? isRequestLike(request)`, so supplying the
   * request that `ctx.request` requires *also* switches the whole call into
   * Response mode — where the answer arrives as a 200 whose json body holds the
   * destination, `.url` is the empty string, and every refusal is returned
   * rather than thrown. Two attempts to read a destination failed on that one
   * default, and the refusals it swallowed are why they were hard to see.
   */
  const result = await auth.api.oauth2Consent({
    body: { accept: true, oauth_query: input.oauthQuery },
    headers: new Headers(await headers()),
    request: await consentRequest(),
    asResponse: false,
  });
  /**
   * Before anything is written. A refused authorization must not leave a grant
   * behind, and binding one revokes whatever the agent held before — so an
   * unchecked result does not merely fail to help, it takes something away.
   */
  const destination = authorizedDestination(result);
  try {
    await agentGrantService.bindConsent(context, {
      organizationId,
      agentPrincipalId:
        input.agentPrincipalId === newAgentPrincipalValue
          ? newPrincipalId
          : input.agentPrincipalId,
      projectId: boundProjectId,
      clientId: input.clientId,
      audience: request.audience,
      laneIds: input.laneIds,
      scopes: request.grantedAgentScopes,
      expectedVersion: 0,
      idempotencyKey: keyedFingerprint(
        serverEnv.BETTER_AUTH_SECRET,
        `oauth-consent:${application.session.user.id}:${input.oauthQuery}`,
      ),
      ...(proposed
        ? {
            newPrincipal: {
              id: newPrincipalId,
              ...proposed,
            },
          }
        : {}),
    });
  } catch (error) {
    const storage = webStorage();
    await createAgentAuthRepository(
      storage.db,
    ).invalidateUnboundOAuthProviderAuthorization({
      userId: application.session.user.id,
      clientId: input.clientId,
    });
    throw error;
  }
  redirect(destination);
}

export async function denyAgentConsentAction(
  _previous: ConsentActionState,
  formData: FormData,
): Promise<ConsentActionState> {
  // Filled in by the step that authorizes, for the reason written on approve.
  const identity: RefusalIdentity = {};
  try {
    return await denyConsent(formData, identity);
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error, identity);
  }
}

async function denyConsent(
  formData: FormData,
  identity: RefusalIdentity,
): Promise<never> {
  // Denial is the answer that ends the agent's wait, so a session that lapses
  // here costs exactly what it costs on approve, and carries the same request.
  const application = await consentApplicationContext(formData);
  identity.actorId = application.session.user.id;
  const oauthQuery = z
    .string()
    .min(1)
    .max(16_384)
    .parse(formData.get("oauthQuery"));
  /**
   * Taken from the form, not from a parse of the signed query.
   *
   * `parseSignedRequest` refuses a request that names no agent scope, or one
   * whose resource this server does not answer — and those are exactly the
   * requests the consent page draws a "this cannot be approved" screen for. So
   * denial, the only action left on those screens, threw before it did
   * anything. A person shown a dead end was given a dead end to leave by.
   *
   * The value is only ever used to bucket the rate limiter, which is a
   * fingerprint and not an authorization: nothing downstream trusts it, and
   * Better Auth verifies the signed query itself. Approve reads it from the
   * form for the same reason and is held to the same bucket — declining is not
   * cheaper than approving, and a separate allowance would be one.
   */
  const clientId = z.string().min(1).max(255).parse(formData.get("clientId"));
  identity.clientId = clientId;
  await enforceRateLimit({
    endpointClass: "token",
    fingerprint: rateLimitFingerprint(
      application.session.user.id,
      clientId,
      "oauth-consent",
    ),
  });
  const result = await auth.api.oauth2Consent({
    body: { accept: false, oauth_query: oauthQuery },
    headers: new Headers(await headers()),
    request: await consentRequest(),
    asResponse: false,
  });
  // Denial's url carries `error=access_denied` on purpose — it is the answer,
  // not a failure, so it is read directly rather than through the code check.
  const denied = (result as { url?: unknown } | null)?.url;
  if (typeof denied !== "string" || denied.length === 0) {
    throw new DomainError(
      "validation_failed",
      "The authorization server named no destination to return to",
    );
  }
  redirect(denied);
}
