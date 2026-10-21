import { randomBytes, randomUUID } from "node:crypto";
import { createStorage, identitySchema } from "@requestport/db";
import { testPool } from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import {
  APIError,
  betterAuth,
  type DBAdapter,
  type DBAdapterInstance,
} from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  composeAuthDatabase,
  wrapCimdClientGuardAdapter,
  wrapSignupGuardAdapter,
} from "./restricted-adapter.js";
import { createAuthOptions } from "./server-options.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

afterAll(async () => {
  await suiteStorage.close();
});

const marker = {
  code: "P0001",
  constraint: "requestport_user_signup_eligibility_guard",
  message: "requestport_signup_disabled",
};

function adapterThrowing(error: unknown) {
  const create: DBAdapter["create"] = vi.fn(async () => {
    throw error;
  });
  return (base: DBAdapterInstance): DBAdapterInstance =>
    (options) => ({
      ...base(options),
      create,
    });
}

function createTransactionalAuth() {
  return betterAuth({
    database: wrapSignupGuardAdapter(
      drizzleAdapter(suiteStorage.db, {
        provider: "pg",
        schema: identitySchema,
        transaction: true,
      }),
    ),
    secret: "transaction-integration-secret".padEnd(32, "!"),
  });
}

async function createInvitation(email: string) {
  const organizationId = randomUUID();
  const invitationId = randomUUID();
  await testPool(suiteStorage).query(
    `INSERT INTO "organizations" ("id", "name", "slug", "status")
     VALUES ($1, 'OAuth transaction test', $2, 'active')`,
    [organizationId, `oauth-${randomUUID()}`],
  );
  await testPool(suiteStorage).query(
    `INSERT INTO "invitations"
      ("id", "organization_id", "normalized_email", "role", "token_hash",
       "expires_at", "created_by_user_id")
     VALUES ($1, $2, $3, 'member', $4,
       clock_timestamp() + interval '5 minutes', 'oauth-test')`,
    [invitationId, organizationId, email, randomUUID()],
  );
  return { invitationId, organizationId };
}

async function deleteIdentityByEmail(email: string) {
  await testPool(suiteStorage).query('DELETE FROM "user" WHERE "email" = $1', [
    email,
  ]);
}

describe("signup guard adapter boundary", () => {
  test("maps the exact marker from a transaction's inner adapter", async () => {
    const base = (await import("better-auth/adapters/memory")).memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    });
    const factory: DBAdapterInstance = (options) => {
      const adapter = base(options);
      return {
        ...adapter,
        transaction: async (callback) =>
          callback({
            ...adapter,
            create: async () => {
              throw { cause: marker };
            },
          }),
      };
    };
    const wrapped = wrapSignupGuardAdapter(factory)({} as never);

    await expect(
      wrapped.transaction((transaction) =>
        transaction.create({ model: "user", data: {} } as never),
      ),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "signup_disabled", message: "signup_disabled" },
    });
  });

  test("maps the exact live database trigger error through the production adapter", async () => {
    const auth = betterAuth({
      database: wrapSignupGuardAdapter(
        drizzleAdapter(suiteStorage.db, {
          provider: "pg",
          schema: identitySchema,
        }),
      ),
      secret: "adapter-integration-secret".padEnd(32, "!"),
    });
    const context = await auth.$context;

    await expect(
      context.adapter.create({
        model: "user",
        data: {
          name: "Denied adapter user",
          email: `${randomUUID()}@example.invalid`,
        },
      }),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "signup_disabled", message: "signup_disabled" },
    });
  });

  test("rolls back OAuth user creation and invitation consumption when account creation fails", async () => {
    const existingEmail = `${randomUUID()}@example.invalid`;
    const newEmail = `${randomUUID()}@example.invalid`;
    const existingUserId = randomUUID();
    const providerId = "github";
    const accountId = randomUUID();
    const { invitationId, organizationId } = await createInvitation(newEmail);
    await testPool(suiteStorage).query(
      `INSERT INTO "signup_allowlist" ("normalized_email", "status")
       VALUES ($1, 'active')`,
      [existingEmail],
    );
    await testPool(suiteStorage).query(
      'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
      [existingUserId, "Existing OAuth user", existingEmail],
    );
    await testPool(suiteStorage).query(
      `INSERT INTO "account"
        ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp())`,
      [randomUUID(), accountId, providerId, existingUserId],
    );

    try {
      const context = await createTransactionalAuth().$context;

      await expect(
        context.internalAdapter.createOAuthUser(
          {
            name: "New OAuth user",
            email: newEmail,
            emailVerified: true,
            image: null,
          },
          { accountId, providerId },
        ),
      ).rejects.toBeDefined();

      const [createdUser, invitation, memberships] = await Promise.all([
        testPool(suiteStorage).query<{ id: string }>(
          'SELECT "id" FROM "user" WHERE "email" = $1',
          [newEmail],
        ),
        testPool(suiteStorage).query<{ accepted_at: Date | null }>(
          'SELECT "accepted_at" FROM "invitations" WHERE "id" = $1',
          [invitationId],
        ),
        testPool(suiteStorage).query<{ id: string }>(
          'SELECT "id" FROM "organization_members" WHERE "organization_id" = $1',
          [organizationId],
        ),
      ]);
      expect(createdUser.rows).toEqual([]);
      expect(invitation.rows).toEqual([{ accepted_at: null }]);
      expect(memberships.rows).toEqual([]);
    } finally {
      await deleteIdentityByEmail(newEmail);
      await deleteIdentityByEmail(existingEmail);
      await testPool(suiteStorage).query(
        'DELETE FROM "signup_allowlist" WHERE "normalized_email" = $1',
        [existingEmail],
      );
      await testPool(suiteStorage).query(
        'DELETE FROM "organizations" WHERE "id" = $1',
        [organizationId],
      );
    }
  });

  test("creates an OAuth user and account atomically while consuming the invitation", async () => {
    const email = `${randomUUID()}@example.invalid`;
    const accountId = randomUUID();
    const { invitationId, organizationId } = await createInvitation(email);

    try {
      const context = await createTransactionalAuth().$context;
      const result = await context.internalAdapter.createOAuthUser(
        {
          name: "Atomic OAuth user",
          email,
          emailVerified: true,
          image: null,
        },
        { accountId, providerId: "github" },
      );
      const [invitation, membership] = await Promise.all([
        testPool(suiteStorage).query<{
          accepted_at: Date | null;
        }>('SELECT "accepted_at" FROM "invitations" WHERE "id" = $1', [
          invitationId,
        ]),
        testPool(suiteStorage).query<{
          role: string;
          status: string;
          user_id: string;
        }>(
          `SELECT "role", "status", "user_id"
           FROM "organization_members"
           WHERE "organization_id" = $1`,
          [organizationId],
        ),
      ]);

      expect(result.user.email).toBe(email);
      expect(result.account.accountId).toBe(accountId);
      expect(invitation.rows[0]?.accepted_at).toBeInstanceOf(Date);
      expect(membership.rows).toEqual([
        { role: "member", status: "active", user_id: result.user.id },
      ]);
    } finally {
      await deleteIdentityByEmail(email);
      await testPool(suiteStorage).query(
        'DELETE FROM "organizations" WHERE "id" = $1',
        [organizationId],
      );
    }
  });

  test("maps a revocation race inside OAuth creation without leaking a Drizzle error", async () => {
    const email = `${randomUUID()}@example.invalid`;
    const revoker = await testPool(suiteStorage).connect();
    await testPool(suiteStorage).query(
      `INSERT INTO "signup_allowlist" ("normalized_email", "status")
       VALUES ($1, 'active')`,
      [email],
    );

    try {
      await revoker.query("BEGIN");
      await revoker.query(
        `UPDATE "signup_allowlist" SET "status" = 'revoked'
         WHERE "normalized_email" = $1`,
        [email],
      );
      const context = await createTransactionalAuth().$context;
      let creationSettled = false;
      const creation = context.internalAdapter
        .createOAuthUser(
          {
            name: "Revoked OAuth user",
            email,
            emailVerified: true,
            image: null,
          },
          { accountId: randomUUID(), providerId: "github" },
        )
        .finally(() => {
          creationSettled = true;
        });

      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(creationSettled).toBe(false);
      await revoker.query("COMMIT");

      await expect(creation).rejects.toMatchObject({
        status: "FORBIDDEN",
        body: { code: "signup_disabled", message: "signup_disabled" },
      });
      const users = await testPool(suiteStorage).query<{ id: string }>(
        'SELECT "id" FROM "user" WHERE "email" = $1',
        [email],
      );
      expect(users.rows).toEqual([]);
    } finally {
      await revoker.query("ROLLBACK").catch(() => undefined);
      revoker.release();
      await deleteIdentityByEmail(email);
      await testPool(suiteStorage).query(
        'DELETE FROM "signup_allowlist" WHERE "normalized_email" = $1',
        [email],
      );
    }
  });

  test("maps only the exact user-insert database marker", async () => {
    const base = (await import("better-auth/adapters/memory")).memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    });
    const wrapped = wrapSignupGuardAdapter(
      adapterThrowing({ cause: marker })(base),
    )({} as never);

    await expect(
      wrapped.create({ model: "user", data: {} } as never),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "signup_disabled", message: "signup_disabled" },
    });
  });

  test.each([
    new Error("database unavailable"),
    { ...marker, code: "23505" },
    { ...marker, constraint: "another_constraint" },
    { ...marker, message: "another_message" },
  ])("does not disguise an unexpected database error", async (unexpected) => {
    const base = (await import("better-auth/adapters/memory")).memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    });
    const wrapped = wrapSignupGuardAdapter(adapterThrowing(unexpected)(base))(
      {} as never,
    );

    await expect(
      wrapped.create({ model: "user", data: {} } as never),
    ).rejects.toBe(unexpected);
    expect(unexpected).not.toBeInstanceOf(APIError);
  });

  test("does not translate the marker for another model", async () => {
    const base = (await import("better-auth/adapters/memory")).memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    });
    const wrapped = wrapSignupGuardAdapter(adapterThrowing(marker)(base))(
      {} as never,
    );

    await expect(
      wrapped.create({ model: "session", data: {} } as never),
    ).rejects.toBe(marker);
  });
});

/**
 * An adapter that records every write it is handed and performs none, with a
 * transaction that hands its callback the same recorder.
 */
function recordingAdapter() {
  const writes: { action: string; input: unknown }[] = [];
  const consumeOne = vi.fn(async () => null);
  const incrementOne = vi.fn(async () => null);
  const record = (action: string) =>
    vi.fn(async (input: unknown) => {
      writes.push({ action, input });
      return { id: "stored" };
    });
  const factory: DBAdapterInstance = () => {
    const adapter = {
      id: "recording",
      create: record("create"),
      update: record("update"),
      consumeOne,
      incrementOne,
    } as unknown as ReturnType<DBAdapterInstance>;
    return {
      ...adapter,
      transaction: async (callback) => callback(adapter),
    };
  };
  return { factory, writes, consumeOne, incrementOne };
}

const refusedCimdClient = {
  status: "BAD_REQUEST",
  body: { error: "invalid_client_metadata" },
};

describe("the CIMD client guard adapter boundary", () => {
  const cimdClient = (method: string | undefined) => ({
    clientId: "https://agents.example/c.json",
    clientDiscoveryId: "cimd",
    ...(method === undefined ? {} : { tokenEndpointAuthMethod: method }),
  });

  test.each([["private_key_jwt"], ["client_secret_basic"], [undefined]])(
    "refuses to create a CIMD client whose method is %s, directly and in a transaction",
    async (method) => {
      const { factory, writes } = recordingAdapter();
      const wrapped = wrapCimdClientGuardAdapter(factory)({} as never);
      const input = { model: "oauthClient", data: cimdClient(method) } as never;

      await expect(wrapped.create(input)).rejects.toMatchObject(
        refusedCimdClient,
      );
      await expect(
        wrapped.transaction((transaction) => transaction.create(input)),
      ).rejects.toMatchObject(refusedCimdClient);
      expect(writes).toEqual([]);
    },
  );

  test("refuses to update a CIMD client to private_key_jwt, named in the values or only in the where clause", async () => {
    const { factory, writes } = recordingAdapter();
    const wrapped = wrapCimdClientGuardAdapter(factory)({} as never);

    await expect(
      wrapped.update({
        model: "oauthClient",
        where: [{ field: "clientId", value: "https://agents.example/c.json" }],
        update: cimdClient("private_key_jwt"),
      } as never),
    ).rejects.toMatchObject(refusedCimdClient);
    await expect(
      wrapped.transaction((transaction) =>
        transaction.update({
          model: "oauthClient",
          where: [
            { field: "clientId", value: "https://agents.example/c.json" },
            { field: "clientDiscoveryId", value: "cimd" },
          ],
          update: { tokenEndpointAuthMethod: "private_key_jwt" },
        } as never),
      ),
    ).rejects.toMatchObject(refusedCimdClient);
    expect(writes).toEqual([]);
  });

  test("admits a public CIMD client, an update that leaves the method alone, and any other client", async () => {
    const { factory, writes } = recordingAdapter();
    const wrapped = wrapCimdClientGuardAdapter(factory)({} as never);

    await wrapped.create({
      model: "oauthClient",
      data: cimdClient("none"),
    } as never);
    await wrapped.transaction((transaction) =>
      transaction.update({
        model: "oauthClient",
        where: [{ field: "clientDiscoveryId", value: "cimd" }],
        update: { disabled: true },
      } as never),
    );
    await wrapped.create({
      model: "oauthClient",
      data: {
        clientId: "registered",
        clientDiscoveryId: null,
        tokenEndpointAuthMethod: "client_secret_basic",
      },
    } as never);
    await wrapped.create({
      model: "session",
      data: { clientDiscoveryId: "cimd", tokenEndpointAuthMethod: "x" },
    } as never);

    expect(writes.map((write) => write.action)).toEqual([
      "create",
      "update",
      "create",
      "create",
    ]);
  });

  test("hands 1.7's consumeOne and incrementOne to the wrapped adapter, under both wrappers", async () => {
    const { factory, consumeOne, incrementOne } = recordingAdapter();
    const wrapped = wrapCimdClientGuardAdapter(wrapSignupGuardAdapter(factory))(
      {} as never,
    );

    expect(wrapped.consumeOne).toBe(consumeOne);
    expect(wrapped.incrementOne).toBe(incrementOne);
  });

  test("the composition production uses applies both guards", async () => {
    // create-auth.ts, which server.ts installs, hands Better Auth
    // composeAuthDatabase((options) => drizzleAdapter(database(), ...)(options));
    // server.test.ts pins that call. This pins what the call does: without
    // either wrapper here, one of the two expectations below fails.
    const { factory, writes } = recordingAdapter();
    const composed = composeAuthDatabase(factory)({} as never);

    await expect(
      composed.create({
        model: "oauthClient",
        data: cimdClient("private_key_jwt"),
      } as never),
    ).rejects.toMatchObject(refusedCimdClient);
    await expect(
      composed.transaction((transaction) =>
        transaction.create({
          model: "oauthClient",
          data: cimdClient("private_key_jwt"),
        } as never),
      ),
    ).rejects.toMatchObject(refusedCimdClient);
    expect(writes).toEqual([]);

    const base = (await import("better-auth/adapters/memory")).memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    });
    const guarded = composeAuthDatabase(
      adapterThrowing({ cause: marker })(base),
    )({} as never);
    await expect(
      guarded.create({ model: "user", data: {} } as never),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "signup_disabled", message: "signup_disabled" },
    });
  });

  test("composes over the Drizzle adapter with consumeOne and incrementOne present and the signup translation intact", async () => {
    const drizzle = drizzleAdapter(suiteStorage.db, {
      provider: "pg",
      schema: identitySchema,
      transaction: true,
    });
    const auth = betterAuth({
      database: wrapCimdClientGuardAdapter(wrapSignupGuardAdapter(drizzle)),
      secret: "cimd-guard-integration-secret".padEnd(32, "!"),
    });
    const context = await auth.$context;

    expect(typeof context.adapter.consumeOne).toBe("function");
    expect(typeof context.adapter.incrementOne).toBe("function");
    await expect(
      context.adapter.create({
        model: "user",
        data: {
          name: "Denied adapter user",
          email: `${randomUUID()}@example.invalid`,
        },
      }),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "signup_disabled", message: "signup_disabled" },
    });
  });
});

/**
 * An adapter whose `create` throws `error`, directly and inside a
 * transaction.
 */
function adapterCreateThrowing(error: unknown): DBAdapterInstance {
  const adapter = {
    id: "throwing",
    create: vi.fn(async () => {
      throw error;
    }),
  } as unknown as ReturnType<DBAdapterInstance>;
  return () => ({
    ...adapter,
    transaction: async (callback) => callback(adapter),
  });
}

// What Postgres reports when a second `oauth_resource` insert names an
// identifier the table already holds: the shape pg's, the hosted driver's and
// PGlite's `DatabaseError` all carry, Drizzle's `DrizzleQueryError` around it.
const duplicateIdentifier = {
  code: "23505",
  constraint: "oauth_resource_identifier_unique",
  message:
    'duplicate key value violates unique constraint "oauth_resource_identifier_unique"',
};
const drizzleFailure = (cause: unknown) =>
  Object.assign(new Error('Failed query: insert into "oauth_resource" …'), {
    cause,
  });
// The test the OAuth provider's seed applies to the error's message before it
// skips a row another instance inserted first
// (`@better-auth/oauth-provider@1.7.6` `introspect-CbYi2MJT.mjs:848`).
const upstreamDuplicateCheck = /unique|duplicate|UNIQUE/i;

describe("the OAuth resource seed's duplicate, through the composition", () => {
  test("a duplicate resource identifier reaches the seed with Postgres's message and the original as its cause", async () => {
    const original = drizzleFailure(duplicateIdentifier);
    const composed = composeAuthDatabase(adapterCreateThrowing(original))(
      {} as never,
    );

    const rejection = await composed
      .create({ model: "oauthResource", data: {} } as never)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(original);
    expect((rejection as Error).message).toBe(duplicateIdentifier.message);
    expect((rejection as Error).cause).toBe(original);
    expect((rejection as Error).message).toMatch(upstreamDuplicateCheck);
    expect(original.message).not.toMatch(upstreamDuplicateCheck);
  });

  test.each([
    [
      "another constraint's 23505",
      drizzleFailure({
        ...duplicateIdentifier,
        constraint: "oauth_client_resource_client_id_resource_id_unique",
      }),
    ],
    [
      "another code on the same constraint",
      drizzleFailure({ ...duplicateIdentifier, code: "23502" }),
    ],
    ["an error with no database cause", new Error("database unavailable")],
    [
      "the marker itself, not on a cause",
      Object.assign(new Error(duplicateIdentifier.message), {
        code: duplicateIdentifier.code,
        constraint: duplicateIdentifier.constraint,
      }),
    ],
  ])("passes %s through untouched", async (_label, unexpected) => {
    const composed = composeAuthDatabase(adapterCreateThrowing(unexpected))(
      {} as never,
    );

    await expect(
      composed.create({ model: "oauthResource", data: {} } as never),
    ).rejects.toBe(unexpected);
  });

  test("passes the same duplicate through untouched for another model, and inside a transaction", async () => {
    const original = drizzleFailure(duplicateIdentifier);
    const composed = composeAuthDatabase(adapterCreateThrowing(original))(
      {} as never,
    );

    await expect(
      composed.create({ model: "oauthClient", data: {} } as never),
    ).rejects.toBe(original);
    await expect(
      composed.transaction((transaction) =>
        transaction.create({ model: "oauthResource", data: {} } as never),
      ),
    ).rejects.toBe(original);
  });
});

/**
 * The race itself, over the pool. A first instance seeds the resource rows;
 * a second is built as one that loses the race sees it: its lookup is forced
 * to find nothing, so its seed inserts a row that already exists. The issuer is
 * this file's own, so no other suite holds or races for these rows, and they
 * are deleted afterwards.
 */
describe("an instance that loses the resource seed race", () => {
  const issuer = `https://race-${randomBytes(4).toString("hex")}.requestport.test`;

  function composeOver(
    database: Parameters<typeof createAuthOptions>[0]["database"],
  ) {
    return createAuthOptions({
      database,
      env: {
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "resource-seed-race-secret".padEnd(32, "!"),
        BETTER_AUTH_URL: issuer,
      },
      assertSignupAllowed: async () => ({ allowed: true }),
      sendMagicLink: async () => undefined,
    });
  }

  const drizzle = () =>
    drizzleAdapter(suiteStorage.db, {
      provider: "pg",
      schema: identitySchema,
      transaction: true,
    });

  // As if another instance's insert committed after this one looked.
  function lookupMissesResources(
    factory: DBAdapterInstance,
  ): DBAdapterInstance {
    return (options) => {
      const adapter = factory(options);
      const findOne: DBAdapter["findOne"] = async (input) =>
        input.model === "oauthResource" ? null : adapter.findOne(input);
      return { ...adapter, findOne };
    };
  }

  async function resourceRows() {
    const result = await testPool(suiteStorage).query<{
      id: string;
      identifier: string;
      name: string;
      updated_at: Date;
    }>(
      `SELECT "id", "identifier", "name", "updated_at" FROM "oauth_resource"
       WHERE "identifier" LIKE $1 ORDER BY "identifier"`,
      [`${issuer}/%`],
    );
    return result.rows;
  }

  let seeded: Awaited<ReturnType<typeof resourceRows>>;

  beforeAll(async () => {
    await betterAuth(composeOver(composeAuthDatabase(drizzle()))).$context;
    seeded = await resourceRows();
    expect(seeded.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await testPool(suiteStorage).query(
      'DELETE FROM "oauth_resource" WHERE "identifier" LIKE $1',
      [`${issuer}/%`],
    );
  });

  test("without the composition, its initialisation rejects with the duplicate Drizzle wrapped", async () => {
    const loser = betterAuth(composeOver(lookupMissesResources(drizzle())));

    await expect(loser.$context).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint: "oauth_resource_identifier_unique",
      },
    });
    expect(await resourceRows()).toEqual(seeded);
  });

  test("through composeAuthDatabase, its initialisation resolves and the rows are as the winner left them", async () => {
    const loser = betterAuth(
      composeOver(composeAuthDatabase(lookupMissesResources(drizzle()))),
    );

    await expect(loser.$context).resolves.toBeDefined();
    expect(await resourceRows()).toEqual(seeded);
  });
});
