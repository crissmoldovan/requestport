import { AsyncLocalStorage } from "node:async_hooks";

import type { FoundationQueryRepository } from "@requestport/domain";
import { isUnauthorizedAPIError } from "@requestport/server/better-auth-errors";

import {
  type CurrentOrganizationContext,
  resolveCurrentOrganization,
} from "./current-organization.js";

export type HumanSession = {
  session: { id: string; userId: string };
  user: {
    id: string;
    email: string;
    name: string;
    image: string | null;
  };
};

function isHumanSession(value: unknown): value is HumanSession {
  if (typeof value !== "object" || value === null) return false;
  const session = (value as { session?: unknown }).session;
  const user = (value as { user?: unknown }).user;
  return (
    typeof session === "object" &&
    session !== null &&
    typeof (session as { id?: unknown }).id === "string" &&
    typeof (session as { userId?: unknown }).userId === "string" &&
    typeof user === "object" &&
    user !== null &&
    typeof (user as { id?: unknown }).id === "string" &&
    typeof (user as { email?: unknown }).email === "string" &&
    typeof (user as { name?: unknown }).name === "string"
  );
}

/**
 * The authorization this request is holding, if it is holding one.
 *
 * When an agent's authorization arrives at the provider without a session,
 * Better Auth does not refuse it: it hands the whole signed request to
 * `/sign-in`, and `(auth)/sign-in/authorization-resume.ts` exists to hand it
 * back once there is somebody to ask. A session that lapses *after* the consent
 * screen was drawn took the other road — the gate below sent the browser to a
 * bare `/sign-in`, which left sign-in nothing to resume. The person signed in,
 * landed on the application with no sign that an agent was waiting, and the
 * agent waited out its loopback callback on a request nobody ever answered.
 *
 * It is a store rather than a parameter because the gate is reached through
 * `getApplicationContext`, which every surface calls the same way and which
 * carries nothing of its caller; and a store rather than a module variable
 * because several requests are in flight at once, and one must never be sent
 * to sign-in holding another's authorization.
 */
const pendingAuthorization = new AsyncLocalStorage<() => unknown>();

/**
 * Run `within` with an authorization for sign-in to resume.
 *
 * The query arrives as a thunk rather than a value because the caller reads it
 * out of a Server Action's submission, and this application's actions resolve
 * the session before they touch what was submitted. It is called only once that
 * session has already failed, at a point where there is nothing left to answer.
 */
export function carryingIntoSignIn<Loaded>(
  carried: () => unknown,
  within: () => Promise<Loaded>,
): Promise<Loaded> {
  return pendingAuthorization.run(carried, within);
}

/**
 * How much of an authorization may travel in a redirect.
 *
 * A signed authorization request is a few hundred characters; a `Location`
 * shares the response's header budget with everything else. Anything longer is
 * not carried at all, which leaves exactly the bare sign-in this used to send.
 *
 * It is measured against the *rebuilt* query rather than the submission,
 * because those are not the same size. Percent-encoding expands as it escapes,
 * and by an amount that depends on the bytes: a newline trebles, and a
 * character that is several UTF-8 bytes grows further still. A cap read before
 * re-serialising would therefore bound the header only loosely, at some
 * multiple of the number it names rather than at the number itself.
 */
const longestCarriedQuery = 2_048;

/**
 * The carried query, rebuilt rather than echoed.
 *
 * What arrives here is request-supplied — the consent form's own hidden field —
 * and it is about to become a header. So it is parsed and re-serialised, which
 * is what makes the result a query: a newline, a `#`, a space, anything that
 * could end the header or reach past the path, comes back percent-encoded
 * instead of trusted. The destination is a constant of this application either
 * way; only the query travels.
 *
 * What travelling does *not* do is get the query checked on arrival, and it is
 * worth being exact about that, because this file has already carried one
 * comment claiming otherwise. In `@better-auth/oauth-provider@1.7.6` the
 * signature is verified in one function, `verifyOAuthQueryParams`, and both of
 * its call sites read `ctx.body.oauth_query` — a POST body. `GET
 * /oauth2/authorize`, which is where `(auth)/sign-in/authorization-resume.ts`
 * points the browser, never calls it. Nor is a forged query caught later:
 * `signParams` mints a fresh `exp`, deletes the incoming `sig` and re-signs
 * before redirecting to consent, so what the consent POST verifies is the
 * provider's own new signature and never the one that travelled. A `sig`
 * carried from here reaches nothing that reads it.
 *
 * That is not a hole this carrying opens. Everything the provider enforces on
 * the way through — that the client exists, that the `redirect_uri` is one it
 * registered, that the scopes are ones it may ask for — it enforces against
 * its own records, whatever the query says. What carrying buys is only that
 * the request is still there to be approved.
 *
 * The same re-minting is why carrying rescues a slow lapse as well as a quick
 * one. The provider's `exp` is ten minutes out — `codeExpiresIn` defaults to
 * 600 seconds and this application does not set it — so a session that lapses
 * by *timeout* arrives with an `exp` long gone by. It does not matter: nothing
 * reads it, and authorize issues a new one on the way to consent.
 */
function carriedQuery(): string {
  const written = pendingAuthorization.getStore()?.();
  if (typeof written !== "string") return "";
  const rebuilt = new URLSearchParams(written).toString();

  return rebuilt.length > longestCarriedQuery ? "" : rebuilt;
}

export type LoadedApplicationContext = {
  session: HumanSession;
} & CurrentOrganizationContext;

export async function loadApplicationContext({
  preferredOrganizationId,
  query,
  redirect,
  requireSession,
}: {
  preferredOrganizationId: string | undefined;
  query: FoundationQueryRepository;
  redirect: (path: "/sign-in" | `/sign-in?${string}`) => void;
  requireSession: () => Promise<unknown>;
}) {
  /**
   * The two ways a request arrives without a human session end in one place,
   * because a request holding an authorization takes it along either road.
   * Nothing else has anything to take, and is sent exactly where it always was.
   */
  const toSignIn: () => never = () => {
    const carried = carriedQuery();
    if (carried) redirect(`/sign-in?${carried}`);
    else redirect("/sign-in");

    throw new Error("Authentication redirect did not terminate");
  };
  let session: unknown;
  try {
    session = await requireSession();
  } catch (error) {
    if (isUnauthorizedAPIError(error)) {
      toSignIn();
    }
    throw error;
  }
  if (!isHumanSession(session)) toSignIn();
  const organizationContext = await resolveCurrentOrganization({
    preferredOrganizationId,
    query,
    userId: session.user.id,
  });
  return { session, ...organizationContext };
}
