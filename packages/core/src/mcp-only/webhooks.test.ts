import {
  type AuthorizedCommandContext,
  agentScopes,
  createEnvelopeEncryption,
  DomainError,
  decodeBase64Key,
  type EnvelopeEncryption,
  LocalAesKeyEncryptionKeyProvider,
  operatorActor,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The webhook management service's composition, moved into core
 * (manifest-g.md §2.5): none without a key ring; otherwise the service over
 * a repository built when each method runs, sealing with the ring the web
 * sealed with (its current key, the previous one still opening), its
 * receipts keyed with the raw fingerprint key, and the endpoint policy's
 * switch as given. The service itself is a stand-in that records what it was
 * built with, so nothing here opens a database or a socket.
 *
 * For a person's context, each of the five methods first runs the bus's own
 * re-check (`assertCurrent`), over a stand-in here, and refuses with its
 * refusal before the service or its repository is built (ruling 233 item 2),
 * and once it is admitted the repository is built with the person's
 * `credentialId`, which db's repository reads again in its locked checks
 * (ruling 234 (c)); an agent's context is handed to the service with no
 * re-check of core's, over a repository built with no credential.
 *
 * And the delivery replay MCP's `replay_webhook_delivery` runs, moved from
 * the MCP route with ruling 137, over stand-in outbox repositories that
 * record each call.
 */

const outbox = vi.hoisted(() => ({
  calls: [] as unknown[][],
  source: undefined as unknown,
  written: undefined as unknown,
}));

vi.mock("@requestport/db", () => ({
  boundOutboxRepository: (organizationId: string, database: unknown) => ({
    loadWebhookDelivery: async (deliveryId: string) => {
      outbox.calls.push([
        "loadWebhookDelivery",
        organizationId,
        database,
        deliveryId,
      ]);
      return outbox.source;
    },
  }),
  createOutboxRepository: (database: unknown) => ({
    createWebhookReplay: async (input: unknown) => {
      outbox.calls.push(["createWebhookReplay", database, input]);
      return outbox.written;
    },
  }),
}));

const built = vi.hoisted(
  () =>
    [] as Array<{
      repository: unknown;
      encryption: EnvelopeEncryption;
      fingerprintSecret: string;
      production?: boolean;
      privateReceivers?: boolean;
    }>,
);

vi.mock("@requestport/webhooks", () => ({
  createWebhookManagementService: (dependencies: (typeof built)[number]) => {
    built.push(dependencies);
    const answer =
      (method: string) =>
      async (...args: unknown[]) => ({ method, args });
    return {
      list: answer("list"),
      create: answer("create"),
      verify: answer("verify"),
      rotate: answer("rotate"),
      setStatus: answer("setStatus"),
    };
  },
}));

const { createWebhookManagement, createWebhookReplay } = await import(
  "./webhooks.js"
);

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
const aad = new TextEncoder().encode("webhooks-test");
const secret = "webhooks-test-signing-material-000000000001";

/** The web's webhook encryption, as `server-webhooks.ts` built it. */
function webEncryption(version: string, material: string) {
  return createEnvelopeEncryption(
    new LocalAesKeyEncryptionKeyProvider(
      version,
      new Map([[version, decodeBase64Key(material)]]),
    ),
  );
}

/**
 * An agent's call: its context is handed to the service with no re-check of
 * core's, so a case that composes `notRechecked` uses it.
 */
const agentCall = { actor: { type: "agent", id: "agent-1" } } as never;

/** The re-check, for a composition whose cases make no person's call. */
const notRechecked = () => {
  throw new Error("the re-check was built for a call that is not a person's");
};

beforeEach(() => {
  built.length = 0;
  outbox.calls.length = 0;
  outbox.source = undefined;
  outbox.written = undefined;
});

describe("the webhook management service", () => {
  test("is none without a key ring, and builds no repository and no re-check", () => {
    const repository = vi.fn();
    const authorization = vi.fn();

    expect(
      createWebhookManagement({
        repository,
        authorization,
        keys: undefined,
        secrets: { commandFingerprintKey: secret },
        production: true,
        privateReceivers: false,
      }),
    ).toBeNull();
    expect(repository).not.toHaveBeenCalled();
    expect(authorization).not.toHaveBeenCalled();
  });

  test.each([
    ["list", ["organization-1"]],
    ["create", [{ name: "Hook" }, { idempotencyKey: "k", expectedVersion: 0 }]],
    ["verify", [{ id: "s" }, { idempotencyKey: "k", expectedVersion: 1 }]],
    ["rotate", [{ id: "s" }, { idempotencyKey: "k", expectedVersion: 1 }]],
    ["setStatus", [{ id: "s" }, { idempotencyKey: "k", expectedVersion: 1 }]],
  ] as const)(
    "builds the service over a repository built when %s runs, and hands it the call",
    async (method, rest) => {
      let repositories = 0;
      const service = createWebhookManagement({
        repository: () => {
          repositories += 1;
          return { repository: repositories } as never;
        },
        // The person's re-check admits the call.
        authorization: () => ({ assertCurrent: async () => {} }),
        keys: { current: { version: "hooks-v1", key: key(3) } },
        secrets: { commandFingerprintKey: secret },
        production: false,
        privateReceivers: false,
      });
      if (!service) throw new Error("no service for a key ring");
      const context = { actor: { type: "user", id: "user-1" } };

      expect(repositories).toBe(0);
      expect(built).toEqual([]);
      await expect(
        (service[method] as (...args: unknown[]) => Promise<unknown>)(
          context,
          ...rest,
        ),
      ).resolves.toEqual({ method, args: [context, ...rest] });

      expect(repositories).toBe(1);
      expect(built).toHaveLength(1);
      expect(built[0]).toMatchObject({
        repository: { repository: 1 },
        fingerprintSecret: secret,
        production: false,
      });
    },
  );

  test("seals under the current key, which the web's opens, still opens what the previous key sealed, and hands on the endpoint switch", async () => {
    const service = createWebhookManagement({
      repository: () => ({}) as never,
      authorization: notRechecked,
      keys: {
        current: { version: "hooks-v2", key: key(2) },
        previous: { version: "hooks-v1", key: key(1) },
      },
      secrets: { commandFingerprintKey: secret },
      production: true,
      privateReceivers: false,
    });
    await service?.list(agentCall, "organization-1");
    const encryption = built[0]?.encryption;
    if (!encryption)
      throw new Error("the service was built with no encryption");

    const sealed = await encryption.encrypt({ secret: "from core" }, aad);
    expect(sealed.kekVersion).toBe("hooks-v2");
    await expect(
      webEncryption("hooks-v2", key(2)).decrypt(sealed, aad),
    ).resolves.toEqual({ secret: "from core" });
    await expect(
      encryption.decrypt(
        await webEncryption("hooks-v1", key(1)).encrypt({ secret: "old" }, aad),
        aad,
      ),
    ).resolves.toEqual({ secret: "old" });
    expect(built[0]?.production).toBe(true);
  });

  test("builds its encryption, and reads its fingerprint key, once, as it is composed", async () => {
    let reads = 0;
    const service = createWebhookManagement({
      repository: () => ({}) as never,
      authorization: notRechecked,
      keys: { current: { version: "hooks-v1", key: key(4) } },
      secrets: {
        get commandFingerprintKey() {
          reads += 1;
          return secret;
        },
      },
      production: true,
      privateReceivers: false,
    });

    expect(reads).toBe(1);
    await service?.list(agentCall, "organization-1");
    await service?.list(agentCall, "organization-1");
    expect(reads).toBe(1);
    expect(built[0]?.encryption).toBe(built[1]?.encryption);
  });

  test.each([true, false])(
    "hands the service the private receivers switch as given (%s), beside the production switch",
    async (privateReceivers) => {
      const service = createWebhookManagement({
        repository: () => ({}) as never,
        authorization: notRechecked,
        keys: { current: { version: "hooks-v1", key: key(5) } },
        secrets: { commandFingerprintKey: secret },
        production: true,
        privateReceivers,
      });
      await service?.list(agentCall, "organization-1");

      expect(built).toHaveLength(1);
      expect(built[0]?.privateReceivers).toBe(privateReceivers);
      expect(built[0]?.production).toBe(true);
    },
  );
});

describe("a person's context, re-checked first by the authorization the composition is given (ruling 233 item 2)", () => {
  const methods = [
    ["list", ["organization-1"]],
    ["create", [{ name: "Hook" }, { idempotencyKey: "k", expectedVersion: 0 }]],
    ["verify", [{ id: "s" }, { idempotencyKey: "k", expectedVersion: 1 }]],
    ["rotate", [{ id: "s" }, { idempotencyKey: "k", expectedVersion: 1 }]],
    ["setStatus", [{ id: "s" }, { idempotencyKey: "k", expectedVersion: 1 }]],
  ] as const;
  const person = {
    actor: { type: "user", id: "user-1" },
    organizationId: "organization-1",
    credentialId: "session-1",
  };
  const agent = {
    actor: { type: "agent", id: "agent-1" },
    organizationId: "organization-1",
    credentialId: "grant-1",
  };

  /**
   * The composition, with each repository and the re-check recording when it
   * is built or asked, in `order`, and each repository the credential it was
   * built with, in `credentials`.
   */
  function management(assertCurrent: (context: unknown) => Promise<void>) {
    const order: string[] = [];
    const credentials: unknown[][] = [];
    const service = createWebhookManagement({
      repository: (...args: unknown[]) => {
        order.push("repository");
        credentials.push(args);
        return {} as never;
      },
      authorization: () => {
        order.push("authorization");
        return {
          assertCurrent: async (context) => {
            order.push("assertCurrent");
            await assertCurrent(context);
          },
        };
      },
      keys: { current: { version: "hooks-v1", key: key(6) } },
      secrets: { commandFingerprintKey: secret },
      production: false,
      privateReceivers: false,
    });
    if (!service) throw new Error("no service for a key ring");
    const call = (
      method: (typeof methods)[number][0],
      context: unknown,
      rest: readonly unknown[],
    ) =>
      (service[method] as (...args: unknown[]) => Promise<unknown>)(
        context,
        ...rest,
      );
    return { call, credentials, order };
  }

  test.each(methods)(
    "%s refuses a person's context that the re-check (authorization().assertCurrent) refuses, with that refusal, before the service or its repository is built",
    async (method, rest) => {
      const refusal = new DomainError(
        "forbidden",
        "Current human authorization is no longer active",
      );
      const rechecked: unknown[] = [];
      const { call, order } = management(async (context) => {
        rechecked.push(context);
        throw refusal;
      });

      await expect(call(method, person, rest)).rejects.toBe(refusal);
      expect(rechecked).toHaveLength(1);
      expect(rechecked[0]).toBe(person);
      expect(order).toEqual(["authorization", "assertCurrent"]);
      expect(built).toEqual([]);
    },
  );

  test.each(methods)(
    "%s hands a person's context to the service once the re-check admits it, the re-check first",
    async (method, rest) => {
      const { call, order } = management(async () => {});

      await expect(call(method, person, rest)).resolves.toEqual({
        method,
        args: [person, ...rest],
      });
      expect(order).toEqual(["authorization", "assertCurrent", "repository"]);
      expect(built).toHaveLength(1);
    },
  );

  test.each(methods)(
    "%s builds no re-check for an agent's context: the service and its repository check an agent, as before",
    async (method, rest) => {
      const { call, order } = management(async () => {
        throw new Error("an agent's context was re-checked");
      });

      await expect(call(method, agent, rest)).resolves.toEqual({
        method,
        args: [agent, ...rest],
      });
      expect(order).toEqual(["repository"]);
    },
  );

  /*
   * Ruling 234 (c): the re-check above is taken at one point in time, so the
   * service runs over a repository built with the person's `credentialId`,
   * which db's repository reads again in each locked check of that person,
   * in the write's own transaction. An agent's repository is given none.
   */
  test.each(methods)(
    "%s builds the service's repository with a person's credentialId, which its locked checks read again (ruling 234 (c))",
    async (method, rest) => {
      const { call, credentials } = management(async () => {});

      await call(method, person, rest);

      expect(credentials).toEqual([["session-1"]]);
    },
  );

  test.each(methods)(
    "%s builds an agent's repository with no credential to read",
    async (method, rest) => {
      const { call, credentials } = management(async () => {
        throw new Error("an agent's context was re-checked");
      });

      await call(method, agent, rest);

      expect(credentials).toHaveLength(1);
      expect(credentials[0]?.[0]).toBeUndefined();
    },
  );
});

describe("the delivery replay", () => {
  const organizationId = "018f0000-0000-7000-8000-0000000c7001";
  const projectId = "018f0000-0000-7000-8000-0000000c7002";
  const agentId = "018f0000-0000-7000-8000-0000000c7003";
  const grantId = "018f0000-0000-7000-8000-0000000c7004";
  const delegatedBy = "018f0000-0000-7000-8000-0000000c7005";
  const deliveryId = "018f0000-0000-7000-8000-0000000c7006";
  const meta = {
    idempotencyKey: "webhook-replay-test-key",
    expectedVersion: 0,
  };
  const database = { handle: "the storage's" };

  function agentContext(
    project: string | null = projectId,
    scopes: readonly string[] = ["webhook:manage"],
  ): AuthorizedCommandContext {
    return {
      actor: {
        type: "agent",
        id: agentId,
        delegatedBy: { type: "user", id: delegatedBy },
      },
      organizationId,
      projectId: project,
      laneIds: new Set(["lane-1"]),
      scopes: new Set(scopes),
      credentialId: grantId,
      correlationId: "018f0000-0000-7000-8000-0000000c7007",
    };
  }

  function source(organization = organizationId, project = projectId) {
    return {
      delivery: { id: deliveryId, organizationId: organization },
      subscription: { projectId: project },
    };
  }

  function replaying(start = vi.fn(async (_id: string) => undefined)) {
    const { replay } = createWebhookReplay({
      database: database as never,
      secrets: { commandFingerprintKey: secret },
      startDelivery: start,
    });
    return { replay, start };
  }

  test("reads the delivery bound to the agent's organisation, writes the replay as the agent on its grant and lanes, then starts it, and answers the replay", async () => {
    outbox.source = source();
    outbox.written = { id: "replay-1" };
    const { replay, start } = replaying();
    const context = agentContext();

    await expect(
      replay(deliveryId, { context, credentialKind: "agent", meta }),
    ).resolves.toEqual({ deliveryId: "replay-1" });

    expect(outbox.calls).toEqual([
      ["loadWebhookDelivery", organizationId, database, deliveryId],
      [
        "createWebhookReplay",
        database,
        {
          organizationId,
          deliveryId,
          actorType: "agent",
          actorId: agentId,
          correlationId: context.correlationId,
          expectedVersion: 0,
          fingerprintSecret: secret,
          idempotencyKey: meta.idempotencyKey,
          authorization: {
            projectId,
            laneIds: ["lane-1"],
            authorizationId: grantId,
            delegatedByUserId: delegatedBy,
          },
        },
      ],
    ]);
    expect(start).toHaveBeenCalledExactlyOnceWith("replay-1");
  });

  test.each([
    ["a delivery that does not exist", () => undefined],
    [
      "a delivery of another organisation",
      () => source("018f0000-0000-7000-8000-0000000c70ff"),
    ],
    [
      "a delivery of a subscription in another project",
      () => source(organizationId, "018f0000-0000-7000-8000-0000000c70fe"),
    ],
  ])(
    "answers %s as not found, and writes and starts nothing",
    async (_, found) => {
      outbox.source = found();
      const { replay, start } = replaying();

      await expect(
        replay(deliveryId, {
          context: agentContext(),
          credentialKind: "agent",
          meta,
        }),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "Webhook delivery was not found",
      });
      expect(outbox.calls.map(([call]) => call)).toEqual([
        "loadWebhookDelivery",
      ]);
      expect(start).not.toHaveBeenCalled();
    },
  );

  test("answers a replay the repository does not write as not found, and starts nothing", async () => {
    outbox.source = source();
    outbox.written = null;
    const { replay, start } = replaying();

    await expect(
      replay(deliveryId, {
        context: agentContext(),
        credentialKind: "agent",
        meta,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(start).not.toHaveBeenCalled();
  });

  test("answers the replay even when its start fails: the delivery row is canonical", async () => {
    outbox.source = source();
    outbox.written = { id: "replay-1" };
    const { replay, start } = replaying(
      vi.fn(async () => {
        throw new Error("the background refused");
      }),
    );

    await expect(
      replay(deliveryId, {
        context: agentContext(),
        credentialKind: "agent",
        meta,
      }),
    ).resolves.toEqual({ deliveryId: "replay-1" });
    expect(start).toHaveBeenCalledOnce();
  });

  test("refuses a credential bound to no project once its delivery is read, and writes nothing", async () => {
    outbox.source = source();
    const { replay } = replaying();

    await expect(
      replay(deliveryId, {
        context: agentContext(null),
        credentialKind: "agent",
        meta,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message:
        "This credential is not bound to a project, so it cannot reach project data",
    });
    expect(outbox.calls.map(([call]) => call)).toEqual(["loadWebhookDelivery"]);
  });

  test("refuses anything but an agent's call before anything is read", async () => {
    const { replay } = replaying();

    await expect(
      replay(deliveryId, {
        context: {
          actor: operatorActor({
            lineageId: "018f0000-0000-7000-8000-0000000c7008",
            memberUserId: delegatedBy,
          }),
          credentialKind: "operator",
          organizationId,
          projectId,
          scopes: new Set(["webhook:manage"]),
          credentialId: "operator-credential",
          correlationId: "018f0000-0000-7000-8000-0000000c7009",
        },
        credentialKind: "operator",
        meta,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "This kind of credential is not admitted to this command",
    });
    expect(outbox.calls).toEqual([]);
  });

  // Ruling 230 (the survey's F3): the replay checks `webhook:manage` itself,
  // as the management service beside it does, so a caller of the published
  // API is refused what MCP never offers such a key.
  test.each([
    ["no scope", []],
    ["request:read alone", ["request:read"]],
    [
      "every other agent scope",
      agentScopes.filter((scope) => scope !== "webhook:manage"),
    ],
  ] as const)(
    "refuses an agent whose context holds %s, lacking webhook:manage, before its delivery is read, and writes and starts nothing",
    async (_, scopes) => {
      outbox.source = source();
      outbox.written = { id: "replay-1" };
      const { replay, start } = replaying();

      await expect(
        replay(deliveryId, {
          context: agentContext(projectId, scopes),
          credentialKind: "agent",
          meta,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Required capability is missing",
        details: { scope: "webhook:manage" },
      });
      expect(outbox.calls).toEqual([]);
      expect(start).not.toHaveBeenCalled();
    },
  );

  test("refuses an agent bound to no project and lacking webhook:manage on the scope, before its delivery is read", async () => {
    outbox.source = source();
    const { replay } = replaying();

    await expect(
      replay(deliveryId, {
        context: agentContext(null, ["request:read"]),
        credentialKind: "agent",
        meta,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Required capability is missing",
    });
    expect(outbox.calls).toEqual([]);
  });
});
