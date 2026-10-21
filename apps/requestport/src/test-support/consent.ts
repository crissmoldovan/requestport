import { createHmac, randomUUID } from "node:crypto";

import { createAgentAuthRepository, type Storage } from "@requestport/db";

import type { TestHost } from "./host.js";

/**
 * The person on the other side of `requestport login`, scripted: who they
 * are in the database, their signed-in session, and what they do with the
 * authorization URL the command prints. The steps are the ones
 * `packages/auth`'s `cross-audience-token.integration.test.ts` takes (its
 * `connect` and `bindGrant`): `GET /api/auth/oauth2/authorize` with the
 * session, which answers with the consent page; `POST
 * /api/auth/oauth2/consent`, which answers with the redirect carrying the
 * code; and the grant bound for the project the person chose, through the
 * repository's `bindOAuthConsent`. The web's consent action makes the same
 * two moves after its page (`apps/web/src/app/oauth/agent-consent/actions.ts`:
 * `oauth2Consent`, then core's `bindConsent`, which binds through that
 * repository). Then the browser follows the redirect, which lands on the
 * command's own loopback receiver.
 */
export interface Person {
  readonly agentPrincipalId: string;
  readonly organizationId: string;
  /** Two projects in the organization, so a case can grant the other one. */
  readonly projects: { readonly a: string; readonly b: string };
  readonly userId: string;
}

/**
 * Runs one statement on the test's database. The integration test hands in
 * `@requestport/db/testing`'s `rawQuery` over the storage of the database it
 * created; this module holds the statements and runs none of its own.
 */
export type RunStatement = (
  text: string,
  values?: readonly unknown[],
) => Promise<unknown>;

export function newPerson(): Person {
  return {
    agentPrincipalId: randomUUID(),
    organizationId: randomUUID(),
    projects: { a: randomUUID(), b: randomUUID() },
    userId: `h6_${randomUUID()}`,
  };
}

/**
 * The person's rows: allowed to sign up, a user, the owner of an
 * organization with two active projects, and an agent principal of the
 * organization's (no project of its own, so it may serve a grant for
 * either).
 */
export async function seedPerson(
  person: Person,
  run: RunStatement,
): Promise<void> {
  const email = `${person.userId}@example.invalid`;
  await run(
    `insert into "signup_allowlist" ("normalized_email", "status") values ($1, 'active')`,
    [email],
  );
  await run(
    `insert into "user" ("id", "name", "email", "updated_at") values ($1, 'H.6 person', $2, now())`,
    [person.userId, email],
  );
  await run(
    `insert into "organizations" ("id", "name", "slug", "status") values ($1, 'H.6 organization', $2, 'active')`,
    [person.organizationId, `h6-${person.organizationId}`],
  );
  await run(
    `insert into "organization_members" ("organization_id", "user_id", "role", "status") values ($1, $2, 'owner', 'active')`,
    [person.organizationId, person.userId],
  );
  for (const projectId of [person.projects.a, person.projects.b]) {
    await run(
      `insert into "projects" ("id", "organization_id", "name", "slug", "key_prefix", "status") values ($1, $2, 'H.6 project', $3, $4, 'active')`,
      [
        projectId,
        person.organizationId,
        `project-${projectId}`,
        `H${projectId.slice(0, 6)}`,
      ],
    );
  }
  await run(
    `insert into "agent_principals" ("id", "organization_id", "project_id", "display_name", "slug", "status", "created_by_user_id") values ($1, $2, null, 'H.6 agent', $3, 'active', $4)`,
    [
      person.agentPrincipalId,
      person.organizationId,
      `agent-${person.agentPrincipalId}`,
      person.userId,
    ],
  );
}

/**
 * A signed-in session for the person, as Better Auth reads one off a
 * request: a session row from its own adapter, and the cookie signed with
 * the secret as `better-call`'s `serializeSignedCookie` signs it (an
 * HMAC-SHA256 of the token, in base64, after a dot, URI-encoded).
 */
export async function sessionCookie(
  host: TestHost,
  userId: string,
): Promise<string> {
  const context = await host.auth.auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", host.secret)
    .update(session.token)
    .digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
}

/** Where a response sends its reader, as a redirect or as JSON's `url`. */
async function redirectTarget(response: Response, base: string): Promise<URL> {
  const location = response.headers.get("location");
  if (location !== null) return new URL(location, base);
  const body = (await response.json().catch(() => ({}))) as { url?: unknown };
  if (typeof body.url !== "string") {
    throw new Error(`Expected a redirect, got HTTP ${response.status}`);
  }
  return new URL(body.url, base);
}

export interface Consented {
  /** The URL the browser landed on: the command's receiver, with the code. */
  readonly callback: URL;
  readonly clientId: string;
}

/**
 * The person approves `authorizationUrl` for `projectId`: the consent page's
 * query from the authorize endpoint, the consent posted, the grant bound for
 * that project and the audience the URL's resource names, with the scopes
 * the URL asked for but `offline_access`; then the browser follows the
 * redirect to the command's receiver. With `scopes`, the grant is bound with
 * those instead, and the host's bearer check (`packages/auth`'s
 * `authenticate-bearer.ts`) gives a request no scope the binding lacks.
 */
export async function consentTo(options: {
  readonly authorizationUrl: string;
  readonly cookie: string;
  readonly host: TestHost;
  readonly person: Person;
  readonly projectId: string;
  readonly scopes?: readonly string[];
  readonly storage: Storage;
}): Promise<Consented> {
  const { cookie, host, person } = options;
  const request = new URL(options.authorizationUrl);
  if (request.origin !== host.url) {
    throw new Error("The authorization URL is not the test host's");
  }
  const clientId = request.searchParams.get("client_id") ?? "";
  const resource = request.searchParams.get("resource") ?? "";
  const audience = resource === `${host.url}/api/v1` ? "api" : "mcp";
  const scopes = (request.searchParams.get("scope") ?? "")
    .split(" ")
    .filter((scope) => scope !== "" && scope !== "offline_access");

  const consentPage = await redirectTarget(
    await fetch(request, { headers: { cookie }, redirect: "manual" }),
    host.url,
  );
  if (consentPage.pathname !== "/oauth/agent-consent") {
    throw new Error(
      `The authorize endpoint sent the person to ${consentPage.pathname}`,
    );
  }

  const consented = await fetch(`${host.url}/api/auth/oauth2/consent`, {
    body: JSON.stringify({
      accept: true,
      oauth_query: consentPage.search.slice(1),
    }),
    headers: {
      "content-type": "application/json",
      cookie,
      origin: host.url,
    },
    method: "POST",
    redirect: "manual",
  });
  const callback = await redirectTarget(consented, host.url);

  await createAgentAuthRepository(options.storage.db).bindOAuthConsent({
    agentPrincipalId: person.agentPrincipalId,
    audience,
    clientId,
    correlationId: randomUUID(),
    expectedVersion: 0,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    fingerprintSecret: host.secret,
    idempotencyKey: randomUUID(),
    laneIds: [],
    organizationId: person.organizationId,
    projectId: options.projectId,
    scopes: options.scopes === undefined ? scopes : [...options.scopes],
    userId: person.userId,
  });

  const landed = await fetch(callback, { redirect: "manual" });
  await landed.arrayBuffer();
  if (!landed.ok) {
    throw new Error(`The command's receiver answered HTTP ${landed.status}`);
  }
  return { callback, clientId };
}
