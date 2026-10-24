export const dynamic = "force-dynamic";

/*
  requestport.com's security.txt (RFC 9116; Plan 13, J.4; ruling 175, J
  question 6). It sends a reporter to the one route the owner chose, GitHub
  private vulnerability reporting on the public repository, and to
  SECURITY.md as GitHub renders it. There is no security email.

  Expires must stay in the future: RFC 9116 says a file is stale after it.
  `route.test.ts` beside this file fails on any run that executes it once
  Expires is under 30 days away (a gate that replays Turbo's cached pass
  does not execute it), and
  `docs/implementation/runbooks/vulnerability-intake.md` says how to renew
  it.

  Canonical names the one URL this file is written for. RFC 9116 says a file
  fetched from a URL that no Canonical field lists should not be trusted. So
  the copy every self-hosted installation of this application serves at its
  own host, and the one at requestport.vercel.app, each say of themselves
  that they are not that host's policy.

  Unlike the four discovery documents beside it, which set their own
  `cache-control`, this handler sets only the content type. Under
  `next start` it is served with the proxy's `cache-control: private,
  no-store` (`src/proxy.ts`). What Vercel serves is not measured: there a
  route's own `cache-control` wins over the proxy's, and this route sets
  none (`docs/implementation/gotchas.md`, 2026-10-06).
*/
const BODY = [
  "Contact: https://github.com/crissmoldovan/requestport/security/advisories/new",
  "Expires: 2027-10-01T00:00:00Z",
  "Policy: https://github.com/crissmoldovan/requestport/security/policy",
  "Preferred-Languages: en",
  "Canonical: https://requestport.com/.well-known/security.txt",
  "",
].join("\n");

export function GET() {
  return new Response(BODY, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
