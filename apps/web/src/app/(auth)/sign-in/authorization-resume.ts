/**
 * Where sign-in returns to when an agent's authorization is waiting on it.
 *
 * An agent client opens `/api/auth/oauth2/authorize` in a browser. With no
 * session the provider does not refuse — it redirects here carrying the whole
 * request, signed, so that it can be resumed once there is somebody to ask.
 * This page used to ignore that query and send every successful sign-in to
 * `/`, which discarded the authorization: the person landed on the overview
 * with a session and no sign that anything was pending, the consent screen was
 * never drawn, and the agent waited on its loopback callback until it timed
 * out. Every fix on the consent path sits behind a screen that flow never
 * reached.
 *
 * Two earlier versions of this comment made a security claim that is false,
 * so it is worth writing down precisely what the signature in that query is
 * and is not. It is not checked here. It is not checked at the endpoint this
 * sends the browser to either: `verifyOAuthQueryParams` runs only where
 * `ctx.body.oauth_query` is present, which is a POST, and `GET
 * /oauth2/authorize` does not admit `sig` or `exp` into its query schema at
 * all, so zod drops both on the way in. And it is not checked later, because
 * there is nothing left to check by then — `signParams` mints a fresh `exp`
 * ten minutes out, deletes the incoming `sig`, and re-signs the parsed query
 * before redirecting to the consent screen. The signature the consent POST
 * verifies is one the provider made after the resume. The one in the link
 * reaches nothing.
 *
 * Which settles what a check here could be worth: nothing. A signature this
 * page validated would be discarded a moment later, and an attacker can mint
 * a genuine one anyway by starting an authorize flow for a client they
 * registered themselves. Reproducing the provider's canonicalisation would
 * buy no security and would tie this file to an internal free to change under
 * it.
 *
 * So what this relies on is narrower, and true: the destination is a constant
 * of this application. An address arriving in the query is data handed back to
 * the provider, never a place to send a browser. Everything the provider
 * enforces — the client, its registered `redirect_uri`, the scopes it may ask
 * for — it enforces on arrival, against its own records, whatever the query
 * claims.
 *
 * What is left for this function to decide is small: which prompt the person
 * has just satisfied by signing in, and which query is not an authorization at
 * all. That is a tidying, not a boundary. The authorize endpoint is reachable
 * from this origin without passing through sign-in, and several of its `GET`
 * paths redirect the browser to `query.redirect_uri` before they look for a
 * session — a requested scope the client is not permitted, a missing
 * `code_challenge` where PKCE is required, a `code_challenge_method` that is
 * not `S256`. Each needs no prompt at all. Nothing here closes that.
 */
const authorizeEndpoint = "/api/auth/oauth2/authorize";

/**
 * What makes a query an authorization rather than anybody's: a signature, an
 * expiry, and the client it is about. Absent any of them there is nothing to
 * resume and an ordinary sign-in must land where it always did.
 *
 * Present is all this asks of any of them. None of the three is read for its
 * value — `sig` and `exp` are replaced by the provider before they mean
 * anything, and `client_id` is checked against its own records — so requiring
 * them is a way of recognising the provider's own redirect, not of trusting it.
 */
const requiredNames = ["sig", "exp", "client_id"] as const;

/**
 * Prompts signing in has just answered, and which must therefore come off.
 *
 * `login` and `create` ask authorization to re-authenticate. The provider
 * honours that by returning to sign-in whether or not a session exists — the
 * check is ORed with the session rather than gated on it — so carrying the
 * prompt back returns the person here again, and again, with no way out.
 *
 * Stripping them is available, and is what the library does to itself: its own
 * in-process resume calls `removePromptFromQuery` for exactly these once they
 * are satisfied. It is available here for the reason set out above — the
 * signature in this query is never verified and is re-minted on arrival — so
 * removing a parameter cannot invalidate anything. An earlier version of this
 * file declined these requests instead, on the belief that the signature had
 * to be preserved intact. That belief was wrong, and declining cost the person
 * the authorization they had just signed in to approve.
 *
 * The person standing here has authenticated interactively a moment ago, which
 * is the thing `login` asked for and the thing `create` asks for on the way to
 * a first session. The prompt is satisfied; taking it off says so.
 */
const satisfiedPrompts = new Set(["login", "create"]);

/**
 * The prompt that means this URL was typed rather than issued.
 *
 * `none` forbids asking the person anything. A genuine one never reaches this
 * page: with no session the provider answers the client directly with
 * `login_required` instead of redirecting to sign-in. So its presence here
 * means somebody composed the `/sign-in` address by hand — and resuming it
 * arrives with a session, finds no consent stored for a client nobody has
 * approved, may not ask for one, and sends the browser to that client's
 * `redirect_uri` carrying `error=consent_required`. Registration is open and
 * unauthenticated, so that address is the registrant's to choose.
 *
 * Stripping is the wrong answer for this one. Sign-in satisfies `login`;
 * nothing about signing in satisfies a request to answer without asking, and
 * removing it would turn a silent request somebody composed into a consent
 * screen drawn for their client. Declining costs no real flow anything,
 * because no real flow arrives this way.
 *
 * Declining it is not what keeps this origin from bouncing a browser to an
 * address somebody registered, and must not be read as that — see the error
 * paths named in the module comment above.
 */
const unsatisfiablePrompts = new Set(["none"]);

export function authorizationResumeTarget(
  params: URLSearchParams,
): string | undefined {
  if (requiredNames.some((name) => !params.get(name))) return undefined;

  const prompts = (params.get("prompt") ?? "").split(/\s+/u).filter(Boolean);
  if (prompts.some((prompt) => unsatisfiablePrompts.has(prompt))) {
    return undefined;
  }
  const remaining = prompts.filter((prompt) => !satisfiedPrompts.has(prompt));

  // Rebuilt rather than re-serialised from the caller's string, so the only
  // thing that can reach the provider is a query this application assembled.
  const carried = new URLSearchParams();
  for (const [name, value] of params) {
    if (name === "prompt") continue;
    carried.append(name, value);
  }
  if (remaining.length > 0) carried.set("prompt", remaining.join(" "));

  return `${authorizeEndpoint}?${carried.toString()}`;
}
