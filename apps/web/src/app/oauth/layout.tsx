import type { ReactNode } from "react";

import { getApplicationLayoutContext } from "../../lib/server-application-context.js";

/**
 * The consent segment's authentication boundary, and nothing else.
 *
 * It draws no chrome — the consent surface is deliberately outside the
 * application shell — and exists only to make the decision *here*, above
 * everything this segment renders.
 *
 * The page below already reads the same context, so this costs the request no
 * database work: the load beneath both is memoised per request. What it changes
 * is where the answer is settled. `redirect()` can only become a redirect
 * status while nothing has been sent, and this segment's loading boundary is a
 * Suspense boundary React can complete the document around — so a decision left
 * to the page would be made after the response was committed and could only
 * emit a meta refresh. Deciding in the layout keeps the boundary hard while the
 * boundary below it keeps the segment's failures recoverable inside the
 * document the root layout already stamped.
 *
 * `src/test/authentication-boundary.test.ts` holds that ordering.
 *
 * Deciding here has a cost, and it is not paid off. A document GET of a consent
 * URL without a session is turned away by this boundary, above the page, and
 * the signed authorization in the URL is dropped with it: sign-in has nothing
 * to resume, the person lands on the application with no mention of the agent,
 * and the agent waits out its loopback callback. That is any arrival with no
 * session at the moment the browser gets here — among them a consent link
 * opened on its own, opened in another browser or profile, reopened later, or
 * one whose session lapsed between the provider's redirect and the arrival.
 *
 * `lib/application-context.ts` carries that query out of the consent *POST*,
 * where the Server Action is holding the submission. Nothing here holds
 * anything equivalent. On the 16.4.2 in this repository the query does not
 * reach a layout at all:
 *
 * - a layout is given no `searchParams`, and Next documents why — layouts do
 *   not re-render on navigation, so the params would go stale
 *   (`next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md`);
 * - `headers()` is a sealed view of the request's own headers (`getHeaders` in
 *   `next/dist/server/async-storage/request-store.js`), which adds nothing
 *   about the route being rendered, so the query is there only if something
 *   upstream of the render put it there;
 * - the framework does keep the request's `pathname` and `search`, on the
 *   store behind that view
 *   (`next/dist/server/app-render/work-unit-async-storage.external`), and that
 *   store is not part of any documented API.
 *
 * A client component below could read `location.search` — but only once a
 * response has been sent, which turns the refusal into a script or a meta
 * refresh instead of a status, and that is the one thing deciding here buys.
 *
 * So closing it means putting the query on a request header before rendering
 * begins, which is `src/proxy.ts` — the file that already hands this tree
 * `x-nonce` the same way — and then wrapping the call below in
 * `carryingIntoSignIn`. That is outside this file and is not attempted here.
 * `agent-consent/page.test.tsx` pins the gap as it stands, so closing it turns
 * that test red rather than passing unnoticed.
 */
export default async function AgentConsentSegmentLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  await getApplicationLayoutContext();

  return children;
}
