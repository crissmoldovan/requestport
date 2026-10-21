import { randomBytes, randomUUID } from "node:crypto";

import {
  createAgentAuthRepository,
  createAgentRepository,
  createCommandAuthorizationRepository,
  type Storage,
} from "@requestport/db";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import {
  type AuthorizedCommandContext,
  DomainError,
} from "@requestport/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createAgentApiKeyService,
  createAgentGrantService,
} from "./agent-services/index.js";
import { humanScopes } from "./command-bus.js";
import { createRequestPort, type RequestPort } from "./request-port.js";

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
 * revocation deletes the row), and a person with a live session who is not a
 * member, are each refused in the bus's words, and each call writes nothing:
 * no subscription, no credential and no minted key, no grant. Each input is
 * one the method acts on once its caller is admitted: the subscription's
 * endpoint is a loopback address the RequestPort admits, the key names an
 * active agent of an active project (the minter is a stand-in that records
 * any call and throws), and the consent names a client the admin consented
 * to. The admin with a live session is the control: the same compositions
 * let them past the re-check, where `list` answers, and `issue` and
 * `bindConsent` reach a later check of their own that refuses before
 * anything is written.
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

const organizationId = randomUUID();
const projectId = randomUUID();
const agentPrincipalId = randomUUID();
const clientId = `client_${randomUUID()}`;
const admin = { userId: `user_${randomUUID()}` };
const outsider = { userId: `user_${randomUUID()}` };
const sessions = {
  live: `session_${randomUUID()}`,
  expired: `session_${randomUUID()}`,
  deleted: `session_${randomUUID()}`,
  outsider: `session_${randomUUID()}`,
};
const userIds = [admin.userId, outsider.userId];
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
 * What a call let past the re-check writes for the organisation, counted:
 * subscriptions, credentials, grants and command receipts; and the keys the
 * minter was asked for.
 */
async function written() {
  return {
    subscriptions: await count("webhook_subscriptions"),
    credentials: await count("agent_credentials"),
    grants: await count("agent_oauth_grants"),
    receipts: await count("command_receipts"),
    minted: minted.length,
  };
}

const nothingWritten = {
  subscriptions: 0,
  credentials: 0,
  grants: 0,
  receipts: 0,
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
      webhookKeys: {
        current: {
          version: "local-v1",
          key: randomBytes(32).toString("base64"),
        },
      },
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
    `insert into "organization_members" ("organization_id", "user_id", "role", "status") values ($1, $2, 'admin', 'active')`,
    [organizationId, admin.userId],
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
  await query(
    `insert into "projects" ("id", "organization_id", "name", "slug", "key_prefix", "status") values ($1, $2, 'Person re-check', $3, 'PRC', 'active')`,
    [projectId, organizationId, `person-recheck-${projectId}`],
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
];

describe.sequential("off the bus, a person's context is re-checked as the bus re-checks a person, on PostgreSQL (ruling 233 item 2)", () => {
  test.each(refusedPersons)(
    "port.mcpOnly.webhooks.create refuses %s in the bus's words, and writes nothing",
    async (_who, context) => {
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
      expect(await written()).toEqual(nothingWritten);
    },
    30_000,
  );

  test.each(refusedPersons)(
    "./agent-services' issue refuses %s in the bus's words, before the minter, and writes nothing",
    async (_who, context) => {
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
      expect(await written()).toEqual(nothingWritten);
    },
    30_000,
  );

  test.each(refusedPersons)(
    "./agent-services' bindConsent refuses %s in the bus's words, and writes nothing",
    async (_who, context) => {
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
      expect(await written()).toEqual(nothingWritten);
    },
    30_000,
  );

  test("the control: the admin with a live session passes the same re-check, where list answers and issue and bindConsent reach a later check, and nothing is written", async () => {
    const live = () => person(admin.userId, sessions.live);

    await expect(webhooks().list(live(), organizationId)).resolves.toEqual([]);

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

    expect(await written()).toEqual(nothingWritten);
  }, 30_000);
});
