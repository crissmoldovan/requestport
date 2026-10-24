import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createAgentAuthRepository,
  createAgentRepository,
  createCommandAuthorizationRepository,
  createWebhookRepository,
  type Storage,
} from "@requestport/db";
import {
  createTestStorage,
  openSession,
  rawQuery,
  type TestSession,
} from "@requestport/db/testing";
import {
  type AuthorizedCommandContext,
  DomainError,
  serializeEncryptedEnvelope,
} from "@requestport/domain";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  createAgentApiKeyService,
  createAgentGrantService,
} from "./agent-services/index.js";
import { humanScopes } from "./command-bus.js";
import { createWebhookManagement } from "./mcp-only/webhooks.js";
import { createRequestPort, type RequestPort } from "./request-port.js";
import { createKeyRingEncryption } from "./secrets.js";

/*
 * Off the command bus, a person's context is re-checked as the bus re-checks
 * a person (J.10, ruling 233 item 2), on PostgreSQL, through the compositions
 * a caller gets: `port.mcpOnly.webhooks` as `createRequestPort` composes it
 * over a storage, and `./agent-services`' `issue` and `bindConsent` composed
 * over repositories on the storage's handle, with db's
 * `createCommandAuthorizationRepository` on that handle as `authorization`,
 * as `createAuth` composes them over its database. On the handle, the
 * re-check binds the organisation in a transaction of its own, unlike db's
 * own suite of the repository, which runs it on a transaction it is given
 * (`command-authorization.integration.test.ts`).
 *
 * An admin whose session has expired or has been deleted (Better Auth's
 * revocation deletes the row), a person with a live session who is not a
 * member, and an admin naming another member's live session are each refused
 * in the bus's words, and each call writes nothing: no subscription, no
 * credential and no minted key, no grant. Each input is one the method acts
 * on once its caller is admitted: the subscription's endpoint is a loopback
 * address the RequestPort admits, the key names an active agent of an active
 * project (the minter is a stand-in that records any call and throws), and
 * the consent names a client the admin consented to. The admin with a live
 * session is the control: the same compositions let them past the re-check,
 * where `list` answers with the organisation's subscriptions, and `issue`
 * and `bindConsent` reach a later check of their own that refuses before
 * anything is written.
 *
 * That re-check is taken at one point in time: its transaction ends before
 * the method's own work starts. Ruling 234 (c) closes the window after it in
 * the writes themselves, and the second part of this suite shows it: a
 * session ended (deleted or expired) after the early re-check passed and
 * before the write's own transaction reads it is refused there, in the bus's
 * words, by db's locked check of each of the three writes (the webhook
 * repository's `canManage`, `reserveCredentialIssuance` and
 * `bindOAuthConsent`), and nothing is written; a revocation in flight when
 * that check reads the session is waited for, then refused; and a revocation
 * begun after that check has read the session waits until the write's own
 * transaction has ended. The third part shows `provisionAgent` reading its
 * grant before either write (ruling 233 item 4).
 *
 * Each case counts what it wrote as the difference it made to the
 * organisation's rows, so a write that one case lets through fails that case
 * and not the cases after it.
 *
 * The suite builds its storage over this run's database (`DATABASE_URL`)
 * with `createTestStorage`, which refuses production and staging's own
 * database unless the opt-in reads `approved`, on `pg`, the driver the gate
 * selects. It commits its fixture, since the methods open their own
 * transactions, and deletes every row of it afterwards; seeding no owner
 * fires no appearance trigger, so no append-only row refers to it.
 */

const refusal = {
  code: "forbidden",
  message: "Current human authorization is no longer active",
};

let storage: Storage;
let port: RequestPort;
const minted: Array<{ name: string; userId: string }> = [];
const fingerprintSecret = randomBytes(32).toString("hex");
const webhookKeys = {
  current: { version: "local-v1", key: randomBytes(32).toString("base64") },
};

const organizationId = randomUUID();
const projectId = randomUUID();
const agentPrincipalId = randomUUID();
const clientId = `client_${randomUUID()}`;
const admin = { userId: `user_${randomUUID()}` };
const outsider = { userId: `user_${randomUUID()}` };
// A member of the organisation, not an owner or admin, who maintains its
// project.
const maintainer = { userId: `user_${randomUUID()}` };
const sessions = {
  live: `session_${randomUUID()}`,
  expired: `session_${randomUUID()}`,
  deleted: `session_${randomUUID()}`,
  outsider: `session_${randomUUID()}`,
  member: `session_${randomUUID()}`,
};
const userIds = [admin.userId, outsider.userId, maintainer.userId];
const emailOf = (userId: string) => `${userId}@example.invalid`;

function query(text: string, values: unknown[] = []) {
  return rawQuery(storage, text, values);
}

async function count(table: string) {
  const result = await query(
    `select count(*)::int as n from "${table}" where "organization_id" = $1`,
    [organizationId],
  );
  return Number(result.rows[0]?.n);
}

/**
 * What has been written for the organisation, counted: subscriptions,
 * credentials, grants, command receipts, audit records and domain events;
 * and the keys the minter was asked for.
 */
async function written() {
  return {
    subscriptions: await count("webhook_subscriptions"),
    credentials: await count("agent_credentials"),
    grants: await count("agent_oauth_grants"),
    receipts: await count("command_receipts"),
    audits: await count("security_audit_records"),
    events: await count("domain_events"),
    minted: minted.length,
  };
}

type Written = Awaited<ReturnType<typeof written>>;

/**
 * What has been written since `before` was counted, as the difference: what
 * a case's own calls wrote, whatever an earlier case left behind.
 */
async function writtenSince(before: Written) {
  const after = await written();
  return Object.fromEntries(
    Object.entries(after).map(([name, n]) => [
      name,
      n - before[name as keyof Written],
    ]),
  );
}

/**
 * The ids of the organisation's subscriptions, read directly, sorted: what
 * `list` answers for a person it admits, whatever an earlier case left.
 */
async function subscriptionIds() {
  const result = await query(
    `select "id" from "webhook_subscriptions" where "organization_id" = $1`,
    [organizationId],
  );
  return result.rows.map((row) => String(row.id)).sort();
}

const idsOf = (records: ReadonlyArray<{ id: string }>) =>
  records.map((record) => record.id).sort();

const nothingWritten = {
  subscriptions: 0,
  credentials: 0,
  grants: 0,
  receipts: 0,
  audits: 0,
  events: 0,
  minted: 0,
};

function person(
  userId: string,
  credentialId: string,
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(humanScopes),
    credentialId,
    correlationId: `person-recheck_${randomUUID()}`,
  };
}

const meta = () => ({ expectedVersion: 0, idempotencyKey: randomUUID() });

function services() {
  const dependencies = {
    authRepository: createAgentAuthRepository(storage.db),
    agentRepository: createAgentRepository(storage.db),
    authorization: createCommandAuthorizationRepository(storage.db),
    fingerprintSecret,
  };
  return {
    keys: createAgentApiKeyService({
      ...dependencies,
      createApiKey: async (input) => {
        minted.push({ name: input.name, userId: input.userId });
        throw new Error("The minter is never reached for a refused person");
      },
    }),
    grants: createAgentGrantService(dependencies),
  };
}

function webhooks() {
  const management = port.mcpOnly.webhooks;
  if (!management) throw new Error("The RequestPort composed no webhooks");
  return management;
}

async function refusedWith(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("The call was answered, not refused");
}

beforeAll(async () => {
  storage = createTestStorage({ driver: "pg" });
  port = createRequestPort({
    storage,
    secrets: {
      commandFingerprintKey: fingerprintSecret,
      webhookKeys,
    },
    publicUrl: "http://127.0.0.1:3999",
    privateWebhookReceivers: true,
  });

  for (const userId of userIds) {
    await query(
      `insert into "signup_allowlist" ("normalized_email", "status") values ($1, 'active')`,
      [emailOf(userId)],
    );
    await query(
      `insert into "user" ("id", "name", "email", "updated_at") values ($1, 'Person re-check', $2, now())`,
      [userId, emailOf(userId)],
    );
  }
  await query(
    `insert into "organizations" ("id", "name", "slug", "status") values ($1, 'Person re-check', $2, 'active')`,
    [organizationId, `person-recheck-${organizationId}`],
  );
  await query(
    `insert into "organization_members" ("organization_id", "user_id", "role", "status") values ($1, $2, 'admin', 'active'), ($1, $3, 'member', 'active')`,
    [organizationId, admin.userId, maintainer.userId],
  );
  const session = (id: string, userId: string, expires: string) =>
    query(
      `insert into "session" ("id", "expires_at", "token", "updated_at", "user_id") values ($1, now() + $2::interval, $3, now(), $4)`,
      [id, expires, `token_${randomUUID()}`, userId],
    );
  await session(sessions.live, admin.userId, "1 hour");
  await session(sessions.expired, admin.userId, "-1 minute");
  await session(sessions.deleted, admin.userId, "1 hour");
  await query(`delete from "session" where "id" = $1`, [sessions.deleted]);
  await session(sessions.outsider, outsider.userId, "1 hour");
  await session(sessions.member, maintainer.userId, "1 hour");
  await query(
    `insert into "projects" ("id", "organization_id", "name", "slug", "key_prefix", "status") values ($1, $2, 'Person re-check', $3, 'PRC', 'active')`,
    [projectId, organizationId, `person-recheck-${projectId}`],
  );
  await query(
    `insert into "project_members" ("organization_id", "project_id", "user_id", "role", "status") values ($1, $2, $3, 'maintainer', 'active')`,
    [organizationId, projectId, maintainer.userId],
  );
  await query(
    `insert into "agent_principals" ("id", "organization_id", "project_id", "display_name", "slug", "software_name", "status", "version", "created_by_user_id")
     values ($1, $2, $3, 'Person re-check agent', $4, 'Person re-check', 'active', 1, $5)`,
    [
      agentPrincipalId,
      organizationId,
      projectId,
      `person-recheck-${agentPrincipalId}`,
      admin.userId,
    ],
  );
  await query(
    `insert into "oauth_client" ("id", "client_id", "disabled", "name", "redirect_uris", "token_endpoint_auth_method") values ($1, $1, false, 'Person re-check', array['http://127.0.0.1:41999/callback'], 'none')`,
    [clientId],
  );
  for (const userId of userIds) {
    await query(
      `insert into "oauth_consent" ("id", "client_id", "user_id", "scopes", "created_at", "updated_at") values ($1, $2, $3, array['request:read'], now(), now())`,
      [`consent_${randomUUID()}`, clientId, userId],
    );
  }
}, 60_000);

afterAll(async () => {
  if (!storage) return;
  try {
    await query(`delete from "oauth_consent" where "client_id" = $1`, [
      clientId,
    ]);
    await query(`delete from "oauth_client" where "id" = $1`, [clientId]);
    await query(`delete from "agent_principals" where "id" = $1`, [
      agentPrincipalId,
    ]);
    // The project's members go with it.
    await query(`delete from "projects" where "id" = $1`, [projectId]);
    await query(
      `delete from "organization_members" where "organization_id" = $1`,
      [organizationId],
    );
    await query(`delete from "organizations" where "id" = $1`, [
      organizationId,
    ]);
    // Their sessions go with them.
    await query(`delete from "user" where "id" = any($1::text[])`, [userIds]);
    await query(
      `delete from "signup_allowlist" where "normalized_email" = any($1::citext[])`,
      [userIds.map(emailOf)],
    );
  } finally {
    await port?.close();
    await storage.close();
  }
}, 60_000);

const refusedPersons: Array<[string, () => AuthorizedCommandContext]> = [
  [
    "an admin whose session has expired",
    () => person(admin.userId, sessions.expired),
  ],
  [
    "an admin whose session was deleted",
    () => person(admin.userId, sessions.deleted),
  ],
  [
    "a person with a live session who is not a member",
    () => person(outsider.userId, sessions.outsider),
  ],
  [
    "an admin naming another member's live session",
    () => person(admin.userId, sessions.member),
  ],
];

describe.sequential("off the bus, a person's context is re-checked as the bus re-checks a person, on PostgreSQL (ruling 233 item 2)", () => {
  test.each(refusedPersons)(
    "port.mcpOnly.webhooks.create refuses %s in the bus's words, and writes nothing",
    async (_who, context) => {
      const before = await written();
      const error = await refusedWith(
        webhooks().create(
          context(),
          {
            organizationId,
            name: "Person re-check",
            endpointUrl: "http://127.0.0.1:9/person-recheck",
          },
          meta(),
        ),
      );

      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  test.each(refusedPersons)(
    "./agent-services' issue refuses %s in the bus's words, before the minter, and writes nothing",
    async (_who, context) => {
      const before = await written();
      const error = await refusedWith(
        services().keys.issue(
          context(),
          {
            organizationId,
            agentPrincipalId,
            projectId,
            name: "Person re-check key",
            audience: "api",
            scopes: ["request:read"],
          },
          meta(),
        ),
      );

      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  test.each(refusedPersons)(
    "./agent-services' bindConsent refuses %s in the bus's words, and writes nothing",
    async (_who, context) => {
      const before = await written();
      const error = await refusedWith(
        services().grants.bindConsent(context(), {
          organizationId,
          agentPrincipalId,
          projectId,
          clientId,
          audience: "mcp",
          scopes: ["request:read"],
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
        }),
      );

      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  test("the control: the admin with a live session passes the same re-check, where list answers and issue and bindConsent reach a later check, and nothing is written", async () => {
    const before = await written();
    const live = () => person(admin.userId, sessions.live);

    expect(idsOf(await webhooks().list(live(), organizationId))).toEqual(
      await subscriptionIds(),
    );

    // An agent that does not exist: the key service's own check after the
    // re-check and the role.
    const unknownAgent = await refusedWith(
      services().keys.issue(
        live(),
        {
          organizationId,
          agentPrincipalId: randomUUID(),
          projectId,
          name: "Person re-check key",
          audience: "api",
          scopes: ["request:read"],
        },
        meta(),
      ),
    );
    expect({
      code: unknownAgent.code,
      message: unknownAgent.message,
    }).toEqual({
      code: "forbidden",
      message: "Agent project binding is invalid",
    });

    // A provisioning scope beside another: the grant service's own check
    // after the re-check.
    const mixedScopes = await refusedWith(
      services().grants.bindConsent(live(), {
        organizationId,
        agentPrincipalId,
        projectId: null,
        clientId,
        audience: "mcp",
        scopes: ["project:provision", "request:read"],
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(mixedScopes.code).toBe("validation_failed");
    expect(mixedScopes.message).toBe(
      "A project:provision grant may carry no other scope, but this one also carries request:read",
    );

    expect(await writtenSince(before)).toEqual(nothingWritten);
  }, 30_000);
});

/*
 * Ruling 234 (c). Each case below lets the early re-check pass on a live
 * session of the admin, then ends that session before the write's own
 * transaction reads it, and shows the write refusing in the bus's words with
 * nothing written. The session is ended as Better Auth's revocation ends it
 * (the row deleted) or as time does (its `expires_at` moved a second into
 * the past), by one committed statement on the pool.
 *
 * Where the session is ended: for `verify`, by the endpoint itself while it
 * answers the verification POST, through `port.mcpOnly.webhooks` as
 * `createRequestPort` composes it; for the other methods, just before the
 * write reaches db's repository, through the same compositions
 * (`createWebhookManagement` over db's webhook repository built with the
 * person's credential, and `./agent-services` over db's repositories, each
 * with the bus's re-check on the storage's handle), with the named
 * repository method wrapped to end the session first. Each such case counts
 * that the wrapper ran, so the call is known to have passed the early
 * re-check.
 */

type Ending = "deleted" | "expired";

/** Ends a session as `how` says, in one committed statement. */
function endSession(how: Ending, sessionId: string) {
  return how === "deleted"
    ? query(`delete from "session" where "id" = $1`, [sessionId])
    : query(
        `update "session" set "expires_at" = now() - interval '1 second' where "id" = $1`,
        [sessionId],
      );
}

/** A live session of `userId`, made for one case. */
async function liveSession(userId: string) {
  const sessionId = `session_${randomUUID()}`;
  await query(
    `insert into "session" ("id", "expires_at", "token", "updated_at", "user_id") values ($1, now() + interval '1 hour', $2, now(), $3)`,
    [sessionId, `token_${randomUUID()}`, userId],
  );
  return sessionId;
}

/**
 * `target`, with each of `methods` run through `around`, which is handed the
 * call to make.
 */
function wrapping<T extends object>(
  target: T,
  methods: ReadonlyArray<keyof T>,
  around: (call: () => Promise<unknown>) => Promise<unknown>,
): T {
  const wrapped = { ...target } as Record<PropertyKey, unknown>;
  for (const name of methods) {
    const method = target[name] as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    wrapped[name] = (...args: unknown[]) => around(() => method(...args));
  }
  return wrapped as T;
}

type WebhookRepository = ReturnType<typeof createWebhookRepository>;

/**
 * The webhook methods as `createRequestPort` composes them over this storage
 * (db's repository built with a person's credential, the bus's re-check on
 * the storage's handle), with `around` wrapping each of `writes` where the
 * service reaches db's repository.
 */
function webhooksAround(
  writes: ReadonlyArray<keyof WebhookRepository>,
  around: (call: () => Promise<unknown>) => Promise<unknown>,
) {
  const management = createWebhookManagement({
    repository: (personCredentialId) =>
      wrapping(
        createWebhookRepository(
          storage.db,
          personCredentialId === undefined ? {} : { personCredentialId },
        ),
        writes,
        around,
      ),
    authorization: () => createCommandAuthorizationRepository(storage.db),
    keys: webhookKeys,
    secrets: { commandFingerprintKey: fingerprintSecret },
    production: false,
    privateReceivers: true,
  });
  if (!management) throw new Error("No webhook management for a key ring");
  return management;
}

type AgentAuthRepository = ReturnType<typeof createAgentAuthRepository>;

/**
 * `./agent-services` composed as `createAuth` composes them over this
 * storage's handle, with `around` wrapping each of `writes` where the
 * services reach db's agent auth repository. The minter records each call
 * in `mintedHere` and throws.
 */
function servicesAround(
  writes: ReadonlyArray<keyof AgentAuthRepository>,
  around: (call: () => Promise<unknown>) => Promise<unknown>,
  mintedHere: unknown[],
) {
  const dependencies = {
    authRepository: wrapping(
      createAgentAuthRepository(storage.db),
      writes,
      around,
    ),
    agentRepository: createAgentRepository(storage.db),
    authorization: createCommandAuthorizationRepository(storage.db),
    fingerprintSecret,
  };
  return {
    keys: createAgentApiKeyService({
      ...dependencies,
      createApiKey: async (input) => {
        mintedHere.push(input);
        throw new Error("The stand-in minter mints no key");
      },
    }),
    grants: createAgentGrantService(dependencies),
  };
}

/**
 * A subscription of the organisation, written directly so that no audit
 * record or event refers to it, its current secret sealed under this
 * suite's key ring as the service seals one.
 */
async function subscriptionAt(endpointUrl: string) {
  const id = randomUUID();
  const envelope = await createKeyRingEncryption(webhookKeys).encrypt(
    { secret: randomBytes(32).toString("base64url") },
    new TextEncoder().encode(
      `requestport:webhook:${organizationId}:${id}:current`,
    ),
  );
  await query(
    `insert into "webhook_subscriptions" ("id", "organization_id", "name", "endpoint_url", "status", "version", "current_secret_ciphertext", "current_secret_key_id", "created_by")
     values ($1, $2, 'Person re-check', $3, 'pending_verification', 1, $4::jsonb, $5, $6)`,
    [
      id,
      organizationId,
      endpointUrl,
      JSON.stringify(serializeEncryptedEnvelope(envelope)),
      `whk_${randomUUID()}`,
      admin.userId,
    ],
  );
  return id;
}

/** What the writes change on a subscription. */
async function subscriptionState(id: string) {
  const result = await query(
    `select "status", "version", "verified_at", "next_secret_key_id", "overlap_ends_at" from "webhook_subscriptions" where "id" = $1`,
    [id],
  );
  return result.rows[0];
}

function deleteSubscription(id: string) {
  return query(`delete from "webhook_subscriptions" where "id" = $1`, [id]);
}

/**
 * A receiver on a loopback port the system chooses, which runs `onPost`
 * before it answers each POST with 200.
 */
async function receiver(onPost: () => Promise<unknown>) {
  let posts = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      posts += 1;
      onPost().then(
        () => response.writeHead(200).end(),
        () => response.writeHead(500).end(),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port: listening } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${listening}/person-recheck`,
    posts: () => posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const endings: Ending[] = ["deleted", "expired"];

describe.sequential("a person's session, read again inside each write's locked check, on PostgreSQL (ruling 234 (c))", () => {
  test.each(endings)(
    "port.mcpOnly.webhooks.verify: a session %s while the endpoint answers the verification POST is refused at markVerified's locked check, in the bus's words, and the subscription is unchanged",
    async (how) => {
      const before = await written();
      const sessionId = await liveSession(admin.userId);
      const endpoint = await receiver(() => endSession(how, sessionId));
      const id = await subscriptionAt(endpoint.url);
      try {
        const before = await subscriptionState(id);
        const error = await refusedWith(
          webhooks().verify(
            person(admin.userId, sessionId),
            { organizationId, id },
            { expectedVersion: 1, idempotencyKey: randomUUID() },
          ),
        );

        expect({ code: error.code, message: error.message }).toEqual(refusal);
        // The early re-check and `find`'s locked check passed: the POST was
        // made.
        expect(endpoint.posts()).toBe(1);
        expect(await subscriptionState(id)).toEqual(before);
      } finally {
        await endpoint.close();
        await deleteSubscription(id);
      }
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  test.each(endings)(
    "webhooks.create: a session %s after the early re-check and before the write is refused at the write's locked check, in the bus's words, and nothing is written",
    async (how) => {
      const before = await written();
      const sessionId = await liveSession(admin.userId);
      let ended = 0;
      const management = webhooksAround(["create"], async (call) => {
        ended += 1;
        await endSession(how, sessionId);
        return call();
      });

      const error = await refusedWith(
        management.create(
          person(admin.userId, sessionId),
          {
            organizationId,
            name: "Person re-check",
            endpointUrl: "http://127.0.0.1:9/person-recheck",
          },
          meta(),
        ),
      );

      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(ended).toBe(1);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  test.each(
    endings.flatMap((how) => [
      ["rotate", how, "setNextSecret"] as const,
      ["setStatus", how, "setStatus"] as const,
    ]),
  )(
    "webhooks.%s: a session %s after the early re-check and before %s is refused at that write's locked check, in the bus's words, and the subscription is unchanged",
    async (method, how, write) => {
      const before = await written();
      const sessionId = await liveSession(admin.userId);
      const id = await subscriptionAt("http://127.0.0.1:9/person-recheck");
      let ended = 0;
      const management = webhooksAround([write], async (call) => {
        ended += 1;
        await endSession(how, sessionId);
        return call();
      });
      try {
        const before = await subscriptionState(id);
        const context = person(admin.userId, sessionId);
        const subscriptionMeta = {
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
        };
        const error = await refusedWith(
          method === "rotate"
            ? management.rotate(
                context,
                { organizationId, id, overlapMinutes: 5 },
                subscriptionMeta,
              )
            : management.setStatus(
                context,
                { organizationId, id, status: "disabled" },
                subscriptionMeta,
              ),
        );

        expect({ code: error.code, message: error.message }).toEqual(refusal);
        expect(ended).toBe(1);
        expect(await subscriptionState(id)).toEqual(before);
      } finally {
        await deleteSubscription(id);
      }
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  test("webhooks.list: a session deleted after the early re-check is refused at list's locked check, in the bus's words", async () => {
    const sessionId = await liveSession(admin.userId);
    let ended = 0;
    const management = webhooksAround(["list"], async (call) => {
      ended += 1;
      await endSession("deleted", sessionId);
      return call();
    });

    const error = await refusedWith(
      management.list(person(admin.userId, sessionId), organizationId),
    );

    expect({ code: error.code, message: error.message }).toEqual(refusal);
    expect(ended).toBe(1);
  }, 30_000);

  test.each(endings)(
    "./agent-services' issue: a session %s after the early re-check and before the reservation is refused at reserveCredentialIssuance's locked check, in the bus's words, before the minter, and nothing is written",
    async (how) => {
      const before = await written();
      const sessionId = await liveSession(admin.userId);
      const mintedHere: unknown[] = [];
      let ended = 0;
      const { keys } = servicesAround(
        ["reserveCredentialIssuance"],
        async (call) => {
          ended += 1;
          await endSession(how, sessionId);
          return call();
        },
        mintedHere,
      );

      const error = await refusedWith(
        keys.issue(
          person(admin.userId, sessionId),
          {
            organizationId,
            agentPrincipalId,
            projectId,
            name: "Person re-check key",
            audience: "api",
            scopes: ["request:read"],
          },
          meta(),
        ),
      );

      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(ended).toBe(1);
      expect(mintedHere).toEqual([]);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  /*
   * `rotate` issues the replacement through `issue`, so its first write is
   * the same reservation. The credential it rotates is a summary the caller
   * hands in, as the web's agents page hands one it has read; the refusal
   * comes at the reservation, before anything reads or writes that
   * credential, so none is stored here.
   */
  test.each(endings)(
    "./agent-services' rotate: a session %s after the early re-check and before the replacement's reservation is refused at reserveCredentialIssuance's locked check, in the bus's words, before the minter, and nothing is written",
    async (how) => {
      const before = await written();
      const sessionId = await liveSession(admin.userId);
      const mintedHere: unknown[] = [];
      let ended = 0;
      const { keys } = servicesAround(
        ["reserveCredentialIssuance"],
        async (call) => {
          ended += 1;
          await endSession(how, sessionId);
          return call();
        },
        mintedHere,
      );

      const error = await refusedWith(
        keys.rotate(person(admin.userId, sessionId), {
          organizationId,
          credential: {
            id: randomUUID(),
            issuedByGrantId: null,
            agentPrincipalId,
            name: "Person re-check key",
            prefix: "rp_",
            fingerprint: "person-recheck",
            audience: "api",
            projectId,
            laneIds: [],
            scopes: ["request:read"],
            version: 1,
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
            revokedAt: null,
            overlapExpiresAt: null,
            lastUsedAt: null,
            createdByUserId: admin.userId,
            createdAt: new Date(),
          },
          overlapMinutes: 5,
          meta: meta(),
        }),
      );

      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(ended).toBe(1);
      expect(mintedHere).toEqual([]);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  test.each(endings)(
    "./agent-services' bindConsent: a session %s after the early re-check and before the binding is refused at bindOAuthConsent's locked check, in the bus's words, and nothing is written",
    async (how) => {
      const before = await written();
      const sessionId = await liveSession(admin.userId);
      let ended = 0;
      const { grants } = servicesAround(
        ["bindOAuthConsent"],
        async (call) => {
          ended += 1;
          await endSession(how, sessionId);
          return call();
        },
        [],
      );

      const error = await refusedWith(
        grants.bindConsent(person(admin.userId, sessionId), {
          organizationId,
          agentPrincipalId,
          projectId,
          clientId,
          audience: "mcp",
          scopes: ["request:read"],
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
        }),
      );

      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(ended).toBe(1);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  /*
   * The read is under the write's lock. A revocation in flight (the session
   * row deleted in a transaction left open on a connection of its own) when
   * the write's check reads the session makes that read wait, as `FOR SHARE`
   * waits on a row another transaction is deleting; the revocation is
   * committed once a backend is seen waiting on it, and the write then finds
   * no session and refuses. A read without the lock would not wait: it would
   * see the row whose deletion the open transaction has not yet committed,
   * and the write would go ahead.
   */
  async function revocationInFlight(sessionId: string) {
    const revoker = await openSession(storage);
    let open = true;
    await revoker.query("begin");
    await revoker.query(`delete from "session" where "id" = $1`, [sessionId]);
    const { rows } = await revoker.query("select pg_backend_pid() as pid");
    const pid = Number(rows[0]?.pid);
    const close = async (statement: "commit" | "rollback") => {
      if (!open) return;
      open = false;
      try {
        await revoker.query(statement);
      } finally {
        revoker.release();
      }
    };
    return {
      /**
       * Commits the revocation once a backend waits on it, or `writing`
       * settles, or ten seconds pass; answers whether one waited.
       */
      async commitOnceWaitedOn(writing: Promise<unknown>) {
        let settled = false;
        writing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        let waited = false;
        const deadline = Date.now() + 10_000;
        while (!settled && Date.now() < deadline) {
          const blocked = await query(
            `select exists (select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as "blocked"`,
            [pid],
          );
          if (blocked.rows[0]?.blocked === true) {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await close("commit");
        return waited;
      },
      abandon: () => close("rollback"),
    };
  }

  /** `around` for one write: the revocation in flight while it runs. */
  function revokedDuring(sessionId: string, waits: boolean[]) {
    return async (call: () => Promise<unknown>) => {
      const revocation = await revocationInFlight(sessionId);
      try {
        const writing = call();
        waits.push(await revocation.commitOnceWaitedOn(writing));
        return await writing;
      } finally {
        await revocation.abandon();
      }
    };
  }

  test.each([
    [
      "webhooks.create",
      (sessionId: string, waits: boolean[]) =>
        webhooksAround(["create"], revokedDuring(sessionId, waits)).create(
          person(admin.userId, sessionId),
          {
            organizationId,
            name: "Person re-check",
            endpointUrl: "http://127.0.0.1:9/person-recheck",
          },
          meta(),
        ),
    ],
    [
      "./agent-services' issue",
      (sessionId: string, waits: boolean[]) =>
        servicesAround(
          ["reserveCredentialIssuance"],
          revokedDuring(sessionId, waits),
          [],
        ).keys.issue(
          person(admin.userId, sessionId),
          {
            organizationId,
            agentPrincipalId,
            projectId,
            name: "Person re-check key",
            audience: "api",
            scopes: ["request:read"],
          },
          meta(),
        ),
    ],
    [
      "./agent-services' bindConsent",
      (sessionId: string, waits: boolean[]) =>
        servicesAround(
          ["bindOAuthConsent"],
          revokedDuring(sessionId, waits),
          [],
        ).grants.bindConsent(person(admin.userId, sessionId), {
          organizationId,
          agentPrincipalId,
          projectId,
          clientId,
          audience: "mcp",
          scopes: ["request:read"],
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
        }),
    ],
  ] as const)(
    "%s: a revocation in flight when the write's locked check reads the session is waited for, and the write is then refused in the bus's words, writing nothing",
    async (_method, call) => {
      const before = await written();
      const sessionId = await liveSession(admin.userId);
      const waits: boolean[] = [];

      const error = await refusedWith(call(sessionId, waits));

      expect(waits).toEqual([true]);
      expect({ code: error.code, message: error.message }).toEqual(refusal);
      expect(await writtenSince(before)).toEqual(nothingWritten);
    },
    30_000,
  );

  /*
   * The lock lasts as long as the write's own transaction. Each case below
   * holds the write still once its locked check has read the session: a
   * blocker, on a connection of its own, in a transaction left open, holds a
   * row lock the write needs only after that check. For `issue`, the
   * maintainer's project membership, which the reservation reads, for a
   * person who is not an owner or admin, after the session. For
   * `bindConsent`, the OAuth client, which the binding reads after the
   * session. For `create`, the project a new subscription names, which the
   * insert's foreign key check reads; the blocker deletes it.
   *
   * With the write held there, the session is deleted on a third connection,
   * as Better Auth's revocation deletes it. That delete must wait on the
   * write's own backend, and must not complete while the write is held. The
   * blocker then ends its transaction, the write goes on to the end of its
   * own, and only then does the revocation complete. Had the session been
   * read in a transaction of its own, ended before the write's, nothing would
   * hold the row, and the delete would complete at once.
   */

  /** What a held write let the case see. */
  type Held = {
    /** The write's backend waited on the blocker. */
    held: boolean;
    /** The revocation waited on the write's backend. */
    revocationWaitedOnWrite: boolean;
    /** The revocation completed while the write was held. */
    revokedWhileHeld: boolean;
  };

  const heldThrough: Held = {
    held: true,
    revocationWaitedOnWrite: true,
    revokedWhileHeld: false,
  };

  async function backendPid(connection: TestSession) {
    const { rows } = await connection.query("select pg_backend_pid() as pid");
    return Number(rows[0]?.pid);
  }

  /** The backends waiting on `pid`. */
  async function waitingOn(pid: number) {
    const result = await query(
      `select "pid" from pg_stat_activity where $1 = any(pg_blocking_pids("pid"))`,
      [pid],
    );
    return result.rows.map((row) => Number(row.pid));
  }

  /** The backends `pid` is waiting on. */
  async function blockersOf(pid: number) {
    const result = await query(`select pg_blocking_pids($1) as "pids"`, [pid]);
    return ((result.rows[0]?.pids ?? []) as unknown[]).map(Number);
  }

  /** Answers whether `check` answered true within `ms`, polling every 25 ms. */
  async function within(ms: number, check: () => Promise<boolean>) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  /**
   * `around` for one write. `take` runs in the blocker's open transaction
   * before the write starts; once the write's backend is seen waiting on the
   * blocker, the session is deleted on a connection of its own, and the
   * blocker's transaction then ends with `end`. What it saw goes in `seen`.
   */
  function heldAfterCheck(
    sessionId: string,
    take: (blocker: TestSession) => Promise<unknown>,
    end: "commit" | "rollback",
    seen: Partial<Held>,
  ) {
    return async (call: () => Promise<unknown>) => {
      const blocker = await openSession(storage);
      let blocking = true;
      const endBlocker = async (statement: "commit" | "rollback") => {
        if (!blocking) return;
        blocking = false;
        try {
          await blocker.query(statement);
        } finally {
          blocker.release();
        }
      };
      try {
        await blocker.query("begin");
        await take(blocker);
        const blockerPid = await backendPid(blocker);
        let settled = false;
        const writing = call();
        writing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        let writerPid: number | undefined;
        seen.held = await within(10_000, async () => {
          if (settled) return true;
          [writerPid] = await waitingOn(blockerPid);
          return writerPid !== undefined;
        });
        seen.held = seen.held && writerPid !== undefined;
        if (writerPid === undefined) {
          await endBlocker(end);
          return await writing;
        }
        const writer = writerPid;
        const revoker = await openSession(storage);
        try {
          const revokerPid = await backendPid(revoker);
          let revoked = false;
          const revocation = revoker
            .query(`delete from "session" where "id" = $1`, [sessionId])
            .then(() => {
              revoked = true;
            });
          const waited = await within(5_000, async () =>
            revoked ? true : (await blockersOf(revokerPid)).includes(writer),
          );
          seen.revocationWaitedOnWrite = waited && !revoked;
          seen.revokedWhileHeld = revoked;
          await endBlocker(end);
          try {
            return await writing;
          } finally {
            await revocation;
          }
        } finally {
          revoker.release();
        }
      } finally {
        await endBlocker("rollback");
      }
    };
  }

  async function sessionExists(sessionId: string) {
    const result = await query(`select 1 from "session" where "id" = $1`, [
      sessionId,
    ]);
    return result.rows.length > 0;
  }

  /** The PostgreSQL error code along `error`'s chain of causes, if any. */
  function databaseCode(error: unknown) {
    let current: unknown = error;
    for (let depth = 0; depth < 5; depth += 1) {
      if (typeof current !== "object" || current === null) return undefined;
      const candidate = current as { code?: unknown; cause?: unknown };
      if (
        typeof candidate.code === "string" &&
        /^[0-9A-Z]{5}$/u.test(candidate.code)
      )
        return candidate.code;
      current = candidate.cause;
    }
    return undefined;
  }

  test("./agent-services' issue: a revocation begun after the reservation's locked check has read the session waits until the reservation commits", async () => {
    const before = await written();
    const sessionId = await liveSession(maintainer.userId);
    const mintedHere: unknown[] = [];
    const seen: Partial<Held> = {};
    const { keys } = servicesAround(
      ["reserveCredentialIssuance"],
      heldAfterCheck(
        sessionId,
        (blocker) =>
          blocker.query(
            `select 1 from "project_members" where "organization_id" = $1 and "project_id" = $2 and "user_id" = $3 for update`,
            [organizationId, projectId, maintainer.userId],
          ),
        "rollback",
        seen,
      ),
      mintedHere,
    );

    // Let go, the reservation is made and committed; the stand-in minter
    // then throws, and the key service cancels the reservation.
    await expect(
      keys.issue(
        person(maintainer.userId, sessionId),
        {
          organizationId,
          agentPrincipalId,
          projectId,
          name: "Person re-check key",
          audience: "api",
          scopes: ["request:read"],
        },
        meta(),
      ),
    ).rejects.toThrow("The stand-in minter mints no key");

    expect(seen).toEqual(heldThrough);
    expect(mintedHere).toHaveLength(1);
    expect(await sessionExists(sessionId)).toBe(false);
    expect(await writtenSince(before)).toEqual(nothingWritten);
  }, 30_000);

  test("./agent-services' bindConsent: a revocation begun after the binding's locked check has read the session waits until the binding's transaction ends", async () => {
    const before = await written();
    const sessionId = await liveSession(admin.userId);
    const seen: Partial<Held> = {};
    const { grants } = servicesAround(
      ["bindOAuthConsent"],
      heldAfterCheck(
        sessionId,
        (blocker) =>
          blocker.query(
            `select 1 from "oauth_client" where "client_id" = $1 for update`,
            [clientId],
          ),
        "rollback",
        seen,
      ),
      [],
    );

    // Let go, the binding reads the client and refuses a lane that does not
    // exist, before anything is written, and its transaction rolls back.
    const unknownLane = await refusedWith(
      grants.bindConsent(person(admin.userId, sessionId), {
        organizationId,
        agentPrincipalId,
        projectId,
        clientId,
        audience: "mcp",
        laneIds: [randomUUID()],
        scopes: ["request:read"],
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      }),
    );

    expect(seen).toEqual(heldThrough);
    expect({ code: unknownLane.code, message: unknownLane.message }).toEqual({
      code: "validation_failed",
      message: "OAuth agent lane binding is invalid",
    });
    expect(await sessionExists(sessionId)).toBe(false);
    expect(await writtenSince(before)).toEqual(nothingWritten);
  }, 30_000);

  test("webhooks.create: a revocation begun after the write's locked check has read the session waits until the write's transaction ends", async () => {
    const before = await written();
    const sessionId = await liveSession(admin.userId);
    // A project of this case's own, which the blocker deletes.
    const heldProjectId = randomUUID();
    await query(
      `insert into "projects" ("id", "organization_id", "name", "slug", "key_prefix", "status") values ($1, $2, 'Person re-check held', $3, 'PRH', 'active')`,
      [heldProjectId, organizationId, `person-recheck-${heldProjectId}`],
    );
    const seen: Partial<Held> = {};
    try {
      const management = webhooksAround(
        ["create"],
        heldAfterCheck(
          sessionId,
          (blocker) =>
            blocker.query(`delete from "projects" where "id" = $1`, [
              heldProjectId,
            ]),
          "commit",
          seen,
        ),
      );

      // Let go, the insert finds the project it names deleted, and the
      // write's transaction rolls back.
      let thrown: unknown;
      try {
        await management.create(
          person(admin.userId, sessionId),
          {
            organizationId,
            name: "Person re-check",
            endpointUrl: "http://127.0.0.1:9/person-recheck",
            projectId: heldProjectId,
          },
          meta(),
        );
      } catch (error) {
        thrown = error;
      }

      expect(seen).toEqual(heldThrough);
      // foreign_key_violation: the subscription's project.
      expect(databaseCode(thrown)).toBe("23503");
      expect(await sessionExists(sessionId)).toBe(false);
    } finally {
      await query(`delete from "projects" where "id" = $1`, [heldProjectId]);
    }
    expect(await writtenSince(before)).toEqual(nothingWritten);
  }, 30_000);

  test("the control: with the admin's session live, the same locked checks pass: list answers, issue's reservation is made and reaches the minter, and bindConsent's binding reaches its lane check, and nothing is left written", async () => {
    const before = await written();
    const sessionId = await liveSession(admin.userId);
    const mintedHere: unknown[] = [];
    const passed: string[] = [];
    const record = (name: string) => async (call: () => Promise<unknown>) => {
      const answer = await call();
      passed.push(name);
      return answer;
    };
    const { keys } = servicesAround(
      ["reserveCredentialIssuance"],
      record("reserveCredentialIssuance"),
      mintedHere,
    );

    expect(
      idsOf(
        await webhooksAround(["list"], record("list")).list(
          person(admin.userId, sessionId),
          organizationId,
        ),
      ),
    ).toEqual(await subscriptionIds());

    // The reservation passes; the stand-in minter then throws, and the key
    // service cancels the reservation.
    await expect(
      keys.issue(
        person(admin.userId, sessionId),
        {
          organizationId,
          agentPrincipalId,
          projectId,
          name: "Person re-check key",
          audience: "api",
          scopes: ["request:read"],
        },
        meta(),
      ),
    ).rejects.toThrow("The stand-in minter mints no key");
    expect(mintedHere).toHaveLength(1);

    // The binding passes the session read, then refuses a lane that does
    // not exist, before anything is written.
    const unknownLane = await refusedWith(
      servicesAround(
        ["bindOAuthConsent"],
        record("bindOAuthConsent"),
        [],
      ).grants.bindConsent(person(admin.userId, sessionId), {
        organizationId,
        agentPrincipalId,
        projectId,
        clientId,
        audience: "mcp",
        laneIds: [randomUUID()],
        scopes: ["request:read"],
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      }),
    );
    expect({ code: unknownLane.code, message: unknownLane.message }).toEqual({
      code: "validation_failed",
      message: "OAuth agent lane binding is invalid",
    });

    expect(passed).toEqual(["list", "reserveCredentialIssuance"]);
    expect(await writtenSince(before)).toEqual(nothingWritten);
  }, 30_000);
});

/*
 * J.10's F9, its remainder (ruling 233 item 4), on PostgreSQL through
 * `port.mcpOnly.provisionAgent` as `createRequestPort` composes it: the grant
 * is read before either write, and anything but an active organisation-wide
 * provisioning grant of the delegating person, while they are an active
 * owner or admin, is refused in the bus's words with nothing written. The
 * case the bus alone let through is the person's own live session named in
 * the grant's place with an id shaped as a UUID (an embedder's id generator
 * could make one): the bus's re-check admitted it, the principal was
 * written, and the minter was asked for a key (Better Auth's would mint one,
 * which db's `createCredential` then refuses, the session's id naming no
 * active grant of the organisation). The other refusals were already the bus's, inside the
 * command's transaction, which writes nothing either; each case therefore
 * also counts the commands handed to the RequestPort's bus, none for a
 * refusal at the grant read, and one for the control that passes it.
 *
 * A second organisation of its own, so that its grants are not counted by
 * the first part's `written()`: an admin and a member, an active project,
 * an organisation-wide principal, and one OAuth client and consent per grant
 * (an active grant is unique per person and client). The minter is a
 * stand-in that records any call and throws.
 */
describe.sequential("provisionAgent reads its grant before either write, on PostgreSQL (ruling 233 item 4)", () => {
  const provisioningOrganizationId = randomUUID();
  const provisioningProjectId = randomUUID();
  const provisioningPrincipalId = randomUUID();
  const delegating = { userId: `user_${randomUUID()}` };
  const member = { userId: `user_${randomUUID()}` };
  const people = [delegating.userId, member.userId];
  const clients: string[] = [];
  const grants = {
    active: randomUUID(),
    revoked: randomUUID(),
    expired: randomUUID(),
    projects: randomUUID(),
    members: randomUUID(),
  };
  // A live session of the admin whose id is shaped as a grant id is.
  const uuidSession = randomUUID();
  const mintedHere: unknown[] = [];
  let provisioning: RequestPort;

  async function countIn(table: string) {
    const result = await query(
      `select count(*)::int as n from "${table}" where "organization_id" = $1`,
      [provisioningOrganizationId],
    );
    return Number(result.rows[0]?.n);
  }

  async function rows() {
    return {
      principals: await countIn("agent_principals"),
      credentials: await countIn("agent_credentials"),
      receipts: await countIn("command_receipts"),
      events: await countIn("domain_events"),
      minted: mintedHere.length,
    };
  }

  /**
   * What `call` wrote for the organisation, counted as the difference it
   * made: principals, credentials, command receipts, events, and the keys
   * the minter was asked for; what it threw, or null; and how many commands
   * it handed the RequestPort's bus. A refusal the bus makes, in the
   * command's own transaction, also writes nothing, so the count is what
   * tells a refusal at the grant read from one on the bus.
   */
  async function provisioned(call: () => Promise<unknown>) {
    const before = await rows();
    const bus = vi.spyOn(provisioning.commandBus, "execute");
    let thrown: unknown = null;
    try {
      await call();
    } catch (error) {
      thrown = error;
    }
    const busCalls = bus.mock.calls.length;
    bus.mockRestore();
    const after = await rows();
    const difference = Object.fromEntries(
      Object.entries(after).map(([name, n]) => [
        name,
        n - before[name as keyof typeof before],
      ]),
    );
    return { thrown, difference, busCalls };
  }

  /** The refusal's code and words, once it is known to be a `DomainError`. */
  function words(thrown: unknown) {
    expect(thrown).toBeInstanceOf(DomainError);
    const { code, message } = thrown as DomainError;
    return { code, message };
  }

  const nothingProvisioned = {
    principals: 0,
    credentials: 0,
    receipts: 0,
    events: 0,
    minted: 0,
  };

  async function grant(
    id: string,
    userId: string,
    shape: {
      projectId?: string;
      status?: "active" | "revoked";
      expired?: boolean;
    } = {},
  ) {
    const clientId = `client_${randomUUID()}`;
    clients.push(clientId);
    await query(
      `insert into "oauth_client" ("id", "client_id", "disabled", "name", "redirect_uris", "token_endpoint_auth_method") values ($1, $1, false, 'Provisioning re-check', array['http://127.0.0.1:41999/callback'], 'none')`,
      [clientId],
    );
    const consentId = `consent_${randomUUID()}`;
    await query(
      `insert into "oauth_consent" ("id", "client_id", "user_id", "scopes", "created_at", "updated_at") values ($1, $2, $3, array['project:provision'], now(), now())`,
      [consentId, clientId, userId],
    );
    const revoked = shape.status === "revoked";
    await query(
      `insert into "agent_oauth_grants" ("id", "organization_id", "agent_principal_id", "user_id", "oauth_client_id", "provider_grant_id", "refresh_family_id", "audience", "project_id", "lane_ids", "scopes", "status", "expires_at", "revoked_at")
       values ($1, $2, $3, $4, $5, $6, $7, 'mcp', $8, '[]'::jsonb, $9::jsonb, $10, now() + $11::interval, ${revoked ? "now()" : "null"})`,
      [
        id,
        provisioningOrganizationId,
        provisioningPrincipalId,
        userId,
        clientId,
        consentId,
        randomUUID(),
        shape.projectId ?? null,
        JSON.stringify(
          shape.projectId ? ["request:read"] : ["project:provision"],
        ),
        revoked ? "revoked" : "active",
        shape.expired ? "-1 minute" : "1 hour",
      ],
    );
  }

  beforeAll(async () => {
    for (const userId of people) {
      await query(
        `insert into "signup_allowlist" ("normalized_email", "status") values ($1, 'active')`,
        [emailOf(userId)],
      );
      await query(
        `insert into "user" ("id", "name", "email", "updated_at") values ($1, 'Provisioning re-check', $2, now())`,
        [userId, emailOf(userId)],
      );
    }
    await query(
      `insert into "organizations" ("id", "name", "slug", "status") values ($1, 'Provisioning re-check', $2, 'active')`,
      [
        provisioningOrganizationId,
        `provisioning-recheck-${provisioningOrganizationId}`,
      ],
    );
    await query(
      `insert into "organization_members" ("organization_id", "user_id", "role", "status") values ($1, $2, 'admin', 'active'), ($1, $3, 'member', 'active')`,
      [provisioningOrganizationId, delegating.userId, member.userId],
    );
    await query(
      `insert into "projects" ("id", "organization_id", "name", "slug", "key_prefix", "status") values ($1, $2, 'Provisioning re-check', $3, 'PVR', 'active')`,
      [
        provisioningProjectId,
        provisioningOrganizationId,
        `provisioning-recheck-${provisioningProjectId}`,
      ],
    );
    await query(
      `insert into "agent_principals" ("id", "organization_id", "project_id", "display_name", "slug", "software_name", "status", "version", "created_by_user_id")
       values ($1, $2, null, 'Provisioning re-check agent', $3, 'Provisioning re-check', 'active', 1, $4)`,
      [
        provisioningPrincipalId,
        provisioningOrganizationId,
        `provisioning-recheck-${provisioningPrincipalId}`,
        delegating.userId,
      ],
    );
    await grant(grants.active, delegating.userId);
    await grant(grants.revoked, delegating.userId, { status: "revoked" });
    await grant(grants.expired, delegating.userId, { expired: true });
    await grant(grants.projects, delegating.userId, {
      projectId: provisioningProjectId,
    });
    await grant(grants.members, member.userId);
    await query(
      `insert into "session" ("id", "expires_at", "token", "updated_at", "user_id") values ($1, now() + interval '1 hour', $2, now(), $3)`,
      [uuidSession, `token_${randomUUID()}`, delegating.userId],
    );
    provisioning = createRequestPort({
      storage,
      secrets: { commandFingerprintKey: fingerprintSecret },
      publicUrl: "http://127.0.0.1:3999",
      betterAuth: {
        createAgentApiKey: async (input) => {
          mintedHere.push(input);
          throw new Error("The stand-in minter mints no key");
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      // The grants and the consents go with their clients.
      await query(`delete from "oauth_client" where "id" = any($1::text[])`, [
        clients,
      ]);
      await query(
        `delete from "agent_principals" where "organization_id" = $1`,
        [provisioningOrganizationId],
      );
      await query(`delete from "projects" where "id" = $1`, [
        provisioningProjectId,
      ]);
      await query(
        `delete from "organization_members" where "organization_id" = $1`,
        [provisioningOrganizationId],
      );
      await query(`delete from "organizations" where "id" = $1`, [
        provisioningOrganizationId,
      ]);
      // Their sessions go with them.
      await query(`delete from "user" where "id" = any($1::text[])`, [people]);
      await query(
        `delete from "signup_allowlist" where "normalized_email" = any($1::citext[])`,
        [people.map(emailOf)],
      );
    } finally {
      await provisioning?.close();
    }
  }, 60_000);

  const provisionAs = (
    userId: string,
    issuingGrantId: string,
    projectId = provisioningProjectId,
  ) =>
    provisioning.mcpOnly.provisionAgent({
      idempotencyKey: randomUUID(),
      delegatedByUserId: userId,
      issuingGrantId,
      organizationId: provisioningOrganizationId,
      provision: {
        displayName: "Provisioned agent",
        projectId,
        scopes: ["request:read"],
        slug: `provisioned-${randomUUID().slice(0, 8)}`,
      },
    });

  test("refuses the admin's own live session named in the grant's place, its id shaped as a UUID, at the grant read, before the bus and either write, in the bus's words", async () => {
    const { thrown, difference, busCalls } = await provisioned(() =>
      provisionAs(delegating.userId, uuidSession),
    );

    expect(difference).toEqual(nothingProvisioned);
    expect(words(thrown)).toEqual(refusal);
    expect(busCalls).toBe(0);
  }, 30_000);

  test.each([
    ["a revoked grant", () => [delegating.userId, grants.revoked]],
    ["an expired grant", () => [delegating.userId, grants.expired]],
    [
      "a project's grant, not a provisioning one",
      () => [delegating.userId, grants.projects],
    ],
    [
      "a grant whose person is a member, not an owner or admin",
      () => [member.userId, grants.members],
    ],
    ["another person's grant", () => [member.userId, grants.active]],
    ["a grant that does not exist", () => [delegating.userId, randomUUID()]],
  ] as const)(
    "refuses %s at the grant read, before the bus and either write, in the bus's words",
    async (_which, args) => {
      const [userId, grantId] = args();

      const { thrown, difference, busCalls } = await provisioned(() =>
        provisionAs(userId, grantId),
      );

      expect(difference).toEqual(nothingProvisioned);
      expect(words(thrown)).toEqual(refusal);
      expect(busCalls).toBe(0);
    },
    30_000,
  );

  test("the control: the admin's active provisioning grant passes the read and reaches the bus, where create_agent_principal's own check refuses a project that does not exist, in its words, and nothing is written", async () => {
    const { thrown, difference, busCalls } = await provisioned(() =>
      provisionAs(delegating.userId, grants.active, randomUUID()),
    );

    expect(difference).toEqual(nothingProvisioned);
    expect(words(thrown)).toEqual({
      code: "forbidden",
      message: "Agent management access is denied",
    });
    expect(busCalls).toBe(1);
  }, 30_000);
});
