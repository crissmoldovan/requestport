import { createHmac } from "node:crypto";

import type { Storage } from "@requestport/db";
import {
  BOOTSTRAP_OWNER_ACTOR,
  type BootstrapOwnerInput,
  capabilityRegistry,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { RequestPortOptions } from "./options.js";

/*
 * createRequestPort (manifest-g.md §2.1): calling it builds nothing, reads
 * none of what it is given and opens no connection; what it composes on first
 * use is the bus the web composes, over the storage and secrets it was given;
 * execute runs a registry command through it and through the off-bus
 * handlers, each over the same storage (§2.5), for a network credential or,
 * in process, a person (ruling 63); signIn goes through the caller's Better
 * Auth; and migrate() and bootstrapOwner() run on ownerStorage, refusing
 * without it (§2.2; ruling 66).
 */

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  managers: [] as Array<{
    database: unknown;
    portFactory: (name: string, database: unknown) => unknown;
  }>,
  migrated: [] as unknown[],
  bootstrapped: [] as unknown[][],
  registered: [] as unknown[][],
  /** Each context the bus's re-check was asked about, in order. */
  rechecked: [] as unknown[],
  /** The handle each re-check repository was built on, in order. */
  recheckHandles: [] as unknown[],
  /** What the bus's re-check throws; absent, it passes. */
  recheckRefusal: undefined as Error | undefined,
  /** Each context `assertProvisioningGrant` was asked about, in order. */
  grantsRead: [] as unknown[],
  /** What `assertProvisioningGrant` throws; absent, it passes. */
  grantRefusal: undefined as Error | undefined,
  webhookServices: [] as Array<{
    production?: boolean;
    privateReceivers?: boolean;
    repository: unknown;
  }>,
}));

vi.mock("@requestport/db", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const bound =
    (kind: string) => (organizationId: string, database: unknown) => {
      mocks.calls.push(
        `bound ${kind} ${organizationId} ${String((database as { name?: string }).name)}`,
      );
      return {
        idsForEvents: async (eventIds: string[]) => {
          mocks.calls.push(`${kind}.idsForEvents ${eventIds.join(",")}`);
          return eventIds.map((id) => ({ id: `outbox-of-${id}` }));
        },
        claimOne: async (id: string) => {
          mocks.calls.push(`${kind}.claimOne ${id}`);
          return { id, eventId: "event-1", attemptCount: 1 };
        },
        markAccepted: async (id: string, _owner: string, runId: string) => {
          mocks.calls.push(`${kind}.markAccepted ${id} ${runId}`);
          return true;
        },
        loadWebhookDelivery: async (deliveryId: string) => {
          mocks.calls.push(`${kind}.loadWebhookDelivery ${deliveryId}`);
          return {
            delivery: {
              id: deliveryId,
              organizationId: "018f0000-0000-7000-8000-0000000c1201",
            },
            subscription: { projectId: "018f0000-0000-7000-8000-0000000c1202" },
          };
        },
      };
    };
  return {
    ...original,
    boundOutboxRepository: bound("outbox"),
    boundImportTaskDispatchRepository: bound("import"),
    createFoundationRepository: (
      database: unknown,
      runner?: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown>,
    ) => {
      mocks.calls.push(
        `foundation ${String((database as { name?: string }).name)}`,
      );
      if (!runner) return { foundationOver: database };
      // Opened on a transaction with the runner that keeps its work there,
      // as `create_project` opens it: the work runs through that runner, and
      // the organisation it asks for is not found.
      return {
        transaction: (run: (tx: unknown) => Promise<unknown>) =>
          runner(() =>
            run({
              findOrganizationAuthorization: async () => {
                mocks.calls.push("findOrganizationAuthorization");
                return { organization: null, membership: null };
              },
            }),
          ),
      };
    },
    createCommandTransactionManager: (
      database: unknown,
      portFactory: (name: string, database: unknown) => unknown,
    ) => {
      mocks.managers.push({ database, portFactory });
      return { run: vi.fn() };
    },
    createProjectRegistrationRepository: (database: unknown) => {
      mocks.calls.push(
        `registration ${String((database as { name?: string }).name)}`,
      );
      return {
        register: async (...args: unknown[]) => {
          mocks.registered.push(args);
          return { registered: true };
        },
      };
    },
    // The Slack connection test's two repositories, on whatever transaction
    // they are handed: the re-check records its context and passes unless a
    // case sets a refusal, as does the provisioning grant read, and the queue
    // answers one operation.
    createCommandAuthorizationRepository: (tx: unknown) => {
      mocks.calls.push(`authorization ${String(tx)}`);
      mocks.recheckHandles.push(tx);
      return {
        assertCurrent: async (context: unknown) => {
          mocks.rechecked.push(context);
          if (mocks.recheckRefusal) throw mocks.recheckRefusal;
        },
        assertProvisioningGrant: async (context: unknown) => {
          mocks.grantsRead.push(context);
          if (mocks.grantRefusal) throw mocks.grantRefusal;
        },
      };
    },
    createSlackRepository: (tx: unknown) => {
      mocks.calls.push(`slack ${String(tx)}`);
      return { queueConnectionTest: async () => ({ id: "operation-1" }) };
    },
    // The legacy import tools' repository, on whatever transaction it is
    // handed: the agent's access passes, the snapshot and the run are the
    // bound project's, and each queued write answers its own dispatch.
    createImportRepository: (tx: unknown) => {
      mocks.calls.push(`imports ${String(tx)}`);
      return {
        requireAgentAccess: async () => {},
        findCaptureForProject: async () => ({ id: "capture-1" }),
        createRun: async () => ({
          id: "run-analysis",
          state: "queued",
          dispatchId: "dispatch-of-the-analysis",
        }),
        detail: async () => ({
          run: { manifestSha256: "manifest-sha256" },
          source: { projectId: "018f0000-0000-7000-8000-0000000c1202" },
        }),
        queueApply: async () => ({ dispatchId: "dispatch-of-the-apply" }),
      };
    },
    createAgentQueryRepository: (database: unknown) => {
      mocks.calls.push(
        `agent queries ${String((database as { name?: string }).name)}`,
      );
      return {
        listEvents: async (...args: unknown[]) => ({ events: args }),
      };
    },
    createWebhookRepository: (
      database: unknown,
      options?: { personCredentialId?: string },
    ) => ({
      webhooksOver: (database as { name?: string }).name,
      ...options,
    }),
    createOutboxRepository: (database: unknown) => ({
      createWebhookReplay: async () => {
        mocks.calls.push(
          `outbox.createWebhookReplay ${String((database as { name?: string }).name)}`,
        );
        return { id: "replay-1" };
      },
    }),
  };
});
vi.mock("@requestport/webhooks", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    createWebhookManagementService: (dependencies: {
      production?: boolean;
      privateReceivers?: boolean;
      repository: unknown;
    }) => {
      mocks.webhookServices.push(dependencies);
      return {
        list: async () => [],
        create: async () => ({}),
        verify: async () => ({}),
        rotate: async () => ({}),
        setStatus: async () => ({}),
      };
    },
  };
});
vi.mock("@requestport/db/migrate", () => ({
  migrate: async (storage: unknown) => {
    mocks.migrated.push(storage);
    return { applied: [] };
  },
}));
vi.mock("@requestport/domain", async (importOriginal) => {
  const original = await importOriginal<typeof import("@requestport/domain")>();
  return {
    ...original,
    bootstrapOwner: async (...args: unknown[]) => {
      mocks.bootstrapped.push(args);
      return { organizationId: "bootstrapped" };
    },
  };
});

const { createRequestPort, requestPortComposition } = await import(
  "./request-port.js"
);
const { administrationReads } = await import("./administration-reads.js");

const organizationId = "018f0000-0000-7000-8000-0000000c1201";

/**
 * A stand-in storage that records every member read and refuses every call,
 * so a case shows what createRequestPort touched.
 */
function recordingStorage(name: string) {
  const touched: string[] = [];
  const db = { name };
  const storage = new Proxy({} as Storage, {
    get(_target, property) {
      touched.push(String(property));
      if (property === "db") return db;
      return () => {
        throw new Error(`${name}.${String(property)} was called`);
      };
    },
  });
  return { storage, db, touched };
}

/** Secrets whose every read is recorded. */
function recordingSecrets(read: string[]): RequestPortOptions["secrets"] {
  return {
    get commandFingerprintKey() {
      read.push("commandFingerprintKey");
      return "request-port-test-signing-material-000000000001";
    },
    get operatorCredentials() {
      read.push("operatorCredentials");
      return "enabled" as const;
    },
    get workspaceKeys() {
      read.push("workspaceKeys");
      return undefined;
    },
  };
}

beforeEach(() => {
  mocks.webhookServices.length = 0;
  mocks.calls.length = 0;
  mocks.managers.length = 0;
  mocks.migrated.length = 0;
  mocks.bootstrapped.length = 0;
  mocks.registered.length = 0;
  mocks.rechecked.length = 0;
  mocks.recheckHandles.length = 0;
  mocks.recheckRefusal = undefined;
  mocks.grantsRead.length = 0;
  mocks.grantRefusal = undefined;
});

describe("creating a RequestPort", () => {
  test("builds nothing, reads none of its options' secrets or storages, starts nothing, and freezes nothing", () => {
    const application = recordingStorage("application");
    const owner = recordingStorage("owner");
    const read: string[] = [];
    const startTask = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    createRequestPort({
      storage: application.storage,
      ownerStorage: owner.storage,
      secrets: recordingSecrets(read),
      background: { kind: "trigger", startTask },
      publicUrl: "https://requestport.test",
      logger,
      metrics: { count: vi.fn(), gauge: vi.fn(), observe: vi.fn() },
    });

    expect(application.touched).toEqual([]);
    expect(owner.touched).toEqual([]);
    expect(read).toEqual([]);
    expect(startTask).not.toHaveBeenCalled();
    expect(Object.values(logger).flatMap((line) => line.mock.calls)).toEqual(
      [],
    );
    expect(mocks.managers).toEqual([]);
    expect(mocks.calls).toEqual([]);
    // The registry is frozen when it is first read through a RequestPort,
    // not as one is created: the web composes one in every process, whose
    // suites add probe entries to the registry (Plan 13, G.6).
    expect(Object.isFrozen(capabilityRegistry)).toBe(false);
  });

  test("exposes the capability registry itself, frozen", () => {
    const port = createRequestPort({
      storage: recordingStorage("application").storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
    });

    expect(port.capabilities).toBe(capabilityRegistry);
    expect(Object.isFrozen(port.capabilities)).toBe(true);
  });
});

describe("what a RequestPort composes, on first use", () => {
  test("a transaction manager over its storage's handle, with ports that read its secrets' switch, and the fingerprint key derived from its secret, once", () => {
    const application = recordingStorage("application");
    const read: string[] = [];
    const port = createRequestPort({
      storage: application.storage,
      secrets: recordingSecrets(read),
      publicUrl: "https://requestport.test",
    });

    const composition = requestPortComposition(port);

    expect(requestPortComposition(port)).toBe(composition);
    expect(application.touched).toEqual(["db"]);
    expect(mocks.managers).toHaveLength(1);
    expect(mocks.managers[0]?.database).toBe(application.db);
    expect(composition.fingerprintSecret).toBe(
      createHmac("sha256", "request-port-test-signing-material-000000000001")
        .update("requestport-command-fingerprint-v1")
        .digest("hex"),
    );
    expect(composition.workspaceEncryption).toBeUndefined();
    expect(read).toEqual(["workspaceKeys", "commandFingerprintKey"]);
    // The switch is read when the port opens, not when it is composed.
    mocks.managers[0]?.portFactory("commandAuthorization", {});
    expect(read).toEqual([
      "workspaceKeys",
      "commandFingerprintKey",
      "operatorCredentials",
    ]);
    expect(
      (
        composition.commandBus as unknown as {
          dependencies: Record<string, unknown>;
        }
      ).dependencies,
    ).toMatchObject({
      transactions: { run: expect.any(Function) },
      fingerprintSecret: composition.fingerprintSecret,
      metrics: undefined,
    });
  });

  test("a bus that records to the metrics it was given", () => {
    const metrics = { count: vi.fn(), gauge: vi.fn(), observe: vi.fn() };
    const port = createRequestPort({
      storage: recordingStorage("application").storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
      metrics,
    });

    expect(
      (
        requestPortComposition(port).commandBus as unknown as {
          dependencies: { metrics: unknown };
        }
      ).dependencies.metrics,
    ).toBe(metrics);
  });

  test("by default a background of kind none: the bus's committed rows are read bound to their organisation, and none is claimed", async () => {
    const port = createRequestPort({
      storage: recordingStorage("application").storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
    });
    const afterCommit = (
      requestPortComposition(port).commandBus as unknown as {
        dependencies: {
          afterCommit: (events: readonly unknown[]) => Promise<void>;
        };
      }
    ).dependencies.afterCommit;

    await afterCommit([{ id: "event-1", organizationId: "org-a" }]);

    expect(mocks.calls).toEqual([
      "bound outbox org-a application",
      "outbox.idsForEvents event-1",
      "bound outbox org-a application",
      "bound import org-a application",
    ]);
  });

  test("with a trigger background, the bus's committed rows are claimed, started and accepted bound to their organisation, over its storage", async () => {
    const startTask = vi.fn(async () => ({ id: "run_1" }));
    const port = createRequestPort({
      storage: recordingStorage("application").storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
      background: { kind: "trigger", startTask },
    });
    const afterCommit = (
      requestPortComposition(port).commandBus as unknown as {
        dependencies: {
          afterCommit: (events: readonly unknown[]) => Promise<void>;
        };
      }
    ).dependencies.afterCommit;

    await afterCommit([{ id: "event-1", organizationId: "org-a" }]);

    expect(mocks.calls).toEqual([
      "bound outbox org-a application",
      "outbox.idsForEvents event-1",
      "bound outbox org-a application",
      "bound import org-a application",
      "outbox.claimOne outbox-of-event-1",
      "outbox.markAccepted outbox-of-event-1 run_1",
    ]);
    expect(startTask).toHaveBeenCalledWith(
      "outbox-delivery",
      { outboxId: "outbox-of-event-1" },
      { idempotencyKey: "outbox:outbox-of-event-1:1" },
    );
  });
});

describe("migrate and bootstrapOwner", () => {
  const input = {
    organizationName: "CUE++",
  } as unknown as BootstrapOwnerInput;

  test.each([
    ["migrate", (port: ReturnType<typeof createRequestPort>) => port.migrate()],
    [
      "bootstrapOwner",
      (port: ReturnType<typeof createRequestPort>) =>
        port.bootstrapOwner(input),
    ],
  ])(
    "%s refuses without an ownerStorage, and touches the storage it has",
    async (operation, run) => {
      const application = recordingStorage("application");
      const port = createRequestPort({
        storage: application.storage,
        secrets: recordingSecrets([]),
        publicUrl: "https://requestport.test",
      });

      const refusal = await run(port).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(DomainError);
      expect(refusal).toMatchObject({
        code: "configuration_error",
        message: `${operation}() runs on an owner storage, and this RequestPort was created without ownerStorage`,
      });
      expect(application.touched).toEqual([]);
      expect(mocks.migrated).toEqual([]);
      expect(mocks.bootstrapped).toEqual([]);
    },
  );

  test("migrate runs on the ownerStorage, never the storage", async () => {
    const application = recordingStorage("application");
    const owner = recordingStorage("owner");
    const port = createRequestPort({
      storage: application.storage,
      ownerStorage: owner.storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
    });

    await expect(port.migrate()).resolves.toEqual({ applied: [] });

    expect(mocks.migrated).toHaveLength(1);
    expect(mocks.migrated[0]).toBe(owner.storage);
    expect(application.touched).toEqual([]);
  });

  test("bootstrapOwner registers through a foundation repository over the ownerStorage's handle, as the bootstrap actor", async () => {
    const application = recordingStorage("application");
    const owner = recordingStorage("owner");
    const port = createRequestPort({
      storage: application.storage,
      ownerStorage: owner.storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
    });

    await expect(port.bootstrapOwner(input)).resolves.toEqual({
      organizationId: "bootstrapped",
    });

    expect(mocks.calls).toEqual(["foundation owner"]);
    expect(mocks.bootstrapped).toEqual([
      [
        { foundationOver: owner.db },
        {
          actor: BOOTSTRAP_OWNER_ACTOR,
          correlationId: expect.stringMatching(/^core_[0-9a-f-]{36}$/u),
        },
        input,
      ],
    ]);
    expect(application.touched).toEqual([]);
  });
});

describe("execute, over what a RequestPort composes", () => {
  const meta = {
    idempotencyKey: "request-port-execute-key",
    expectedVersion: 0,
  };
  const projectId = "018f0000-0000-7000-8000-0000000c1202";
  const agent = {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c1203" },
    organizationId,
    projectId,
    scopes: new Set(["request:write", "agent:register"]),
    credentialId: "request-port-execute-agent",
    correlationId: "018f0000-0000-7000-8000-0000000c1204",
  } as const;
  const operator = {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000c1205",
      memberUserId: "018f0000-0000-7000-8000-0000000c1206",
    }),
    credentialKind: "operator" as const,
    organizationId,
    projectId: null,
    scopes: new Set(["agent:revoke", "import:write", "slack:manage"]),
    credentialId: "request-port-execute-operator",
    correlationId: "018f0000-0000-7000-8000-0000000c1207",
  };

  function port(
    storage: Storage = recordingStorage("application").storage,
    background?: RequestPortOptions["background"],
  ) {
    return createRequestPort({
      storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
      background,
    });
  }

  test("refuses a name no entry holds, and a kind the entry excludes, before any target", async () => {
    const application = recordingStorage("application");
    const requestPort = port(application.storage);

    await expect(
      requestPort.execute(
        "no_such_command",
        {},
        {
          context: agent,
          credentialKind: "agent",
          meta,
        },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      requestPort.execute(
        "revoke_agent_credential",
        {},
        {
          context: agent,
          credentialKind: "agent",
          meta,
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(application.touched).toEqual(["db"]);
    expect(mocks.calls).toEqual([]);
  });

  test("runs a bus command on the bus it composed", async () => {
    const requestPort = port();
    const bus = requestPortComposition(requestPort).commandBus;
    const execute = vi
      .spyOn(bus, "execute")
      .mockResolvedValue({ posted: true } as never);
    const input = { bodyMd: "Hello" };

    await expect(
      requestPort.execute("post_message", input, {
        context: agent,
        credentialKind: "agent",
        meta,
      }),
    ).resolves.toEqual({ posted: true });

    expect(execute).toHaveBeenCalledWith({
      name: "post_message",
      input,
      context: agent,
      meta,
    });
  });

  test("registers a project through a repository over its storage's handle, keyed with the raw secret", async () => {
    const input = { alias: "core" };

    await expect(
      port().execute("register_project", input, {
        context: agent,
        credentialKind: "agent",
        meta,
      }),
    ).resolves.toEqual({ registered: true });

    expect(mocks.calls).toEqual(["registration application"]);
    expect(mocks.registered).toEqual([
      [
        { ...agent, projectId },
        input,
        meta,
        "request-port-test-signing-material-000000000001",
      ],
    ]);
  });

  test.each([
    [
      "revoke_agent_credential",
      {
        organizationId,
        agentPrincipalId: "018f0000-0000-7000-8000-0000000c1208",
        credentialId: "018f0000-0000-7000-8000-0000000c1209",
      },
    ],
    [
      "revoke_agent_oauth_grant",
      {
        organizationId,
        agentPrincipalId: "018f0000-0000-7000-8000-0000000c1208",
        grantId: "018f0000-0000-7000-8000-0000000c120a",
        reason: "The laptop holding it was lost",
      },
    ],
    [
      "split_legacy_import_entry",
      {
        organizationId,
        runId: "018f0000-0000-7000-8000-0000000c120b",
        entryId: "018f0000-0000-7000-8000-0000000c120c",
        splitLines: [2],
      },
    ],
    [
      "send_slack_connection_test",
      {
        organizationId,
        installationId: "018f0000-0000-7000-8000-0000000c120d",
        channelId: "C012ABCDEF",
      },
    ],
  ])("%s opens its one transaction on its storage", async (name, input) => {
    const application = recordingStorage("application");

    await expect(
      port(application.storage).execute(name, input, {
        context: operator,
        credentialKind: "operator",
        meta,
      }),
    ).rejects.toThrow("application.transaction was called");

    expect(application.touched).toEqual(["db", "transaction"]);
  });

  test("runs a person's command, in process, on the bus it composed, as the person", async () => {
    const requestPort = port();
    const bus = requestPortComposition(requestPort).commandBus;
    const execute = vi
      .spyOn(bus, "execute")
      .mockResolvedValue({ id: "principal-1" } as never);
    const person = {
      id: "request-port-session",
      userId: "018f0000-0000-7000-8000-0000000c1210",
    };
    const input = { displayName: "Build agent" };

    await expect(
      requestPort.execute("create_agent_principal", input, {
        person,
        organizationId,
        meta,
      }),
    ).resolves.toEqual({ id: "principal-1" });

    expect(execute).toHaveBeenCalledWith({
      name: "create_agent_principal",
      input,
      context: expect.objectContaining({
        actor: { type: "user", id: person.userId },
        organizationId,
        credentialId: person.id,
      }),
      meta,
    });
  });

  test("refuses a person a command the in-process rule does not hold, before any target runs", async () => {
    const application = recordingStorage("application");

    await expect(
      port(application.storage).execute(
        "register_project",
        { alias: "core" },
        {
          person: { id: "request-port-session", userId: "user-1" },
          organizationId,
          meta,
        },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "A person is not admitted to this command in process",
    });

    expect(mocks.calls).toEqual([]);
    expect(mocks.registered).toEqual([]);
  });

  test.each([
    [
      "by default, none: the start is refused, and answered as not started",
      undefined,
      false,
    ],
    ["trigger: the task is started", "trigger", true],
  ] as const)(
    "the Slack connection test starts its task through the background, after its transaction: %s",
    async (_, kind, dispatched) => {
      const startTask = vi.fn(async () => ({ id: "run_1" }));
      const storage = {
        db: { name: "application" },
        transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work("the-transaction"),
      } as unknown as Storage;

      await expect(
        port(
          storage,
          kind === "trigger" ? { kind, startTask } : undefined,
        ).execute(
          "send_slack_connection_test",
          {
            organizationId,
            installationId: "018f0000-0000-7000-8000-0000000c120d",
            channelId: "C012ABCDEF",
          },
          { context: operator, credentialKind: "operator", meta },
        ),
      ).resolves.toEqual({ operationId: "operation-1", dispatched });

      expect(mocks.calls).toEqual([
        "authorization the-transaction",
        "slack the-transaction",
      ]);
      // A direct start carries no idempotency option.
      expect(startTask.mock.calls).toEqual(
        dispatched
          ? [
              [
                "slack-connection-test",
                { operationId: "operation-1" },
                undefined,
              ],
            ]
          : [],
      );
    },
  );
});

describe("signIn, through the caller's Better Auth (ruling 63)", () => {
  test("refuses without betterAuth.signInWithLocalCredential, and touches nothing", async () => {
    const application = recordingStorage("application");
    const port = createRequestPort({
      storage: application.storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
      betterAuth: {},
    });

    await expect(
      port.signIn({ email: "owner@example.com", credential: "credential" }),
    ).rejects.toMatchObject({ code: "configuration_error" });
    expect(application.touched).toEqual([]);
  });

  test("answers the session Better Auth wrote, and touches neither the storage nor the secrets", async () => {
    const application = recordingStorage("application");
    const read: string[] = [];
    const session = { id: "session-1", userId: "user-1" };
    const signInWithLocalCredential = vi.fn(async () => session);
    const port = createRequestPort({
      storage: application.storage,
      secrets: recordingSecrets(read),
      publicUrl: "https://requestport.test",
      betterAuth: { signInWithLocalCredential },
    });
    const credential = { email: "owner@example.com", credential: "secret" };

    await expect(port.signIn(credential)).resolves.toBe(session);
    expect(signInWithLocalCredential.mock.calls).toEqual([[credential]]);
    expect(application.touched).toEqual([]);
    expect(read).toEqual([]);
  });
});

describe("closing a RequestPort", () => {
  test("closes neither storage: both are the caller's", async () => {
    const application = recordingStorage("application");
    const owner = recordingStorage("owner");
    const port = createRequestPort({
      storage: application.storage,
      ownerStorage: owner.storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
    });

    await expect(port.close()).resolves.toBeUndefined();

    expect(application.touched).toEqual([]);
    expect(owner.touched).toEqual([]);
  });
});

describe("starting a RequestPort (ruling 158, item 5)", () => {
  test("without a postgres background, start() composes once, starts nothing, reads only its storage's handle, and resolves", async () => {
    const application = recordingStorage("application");
    const owner = recordingStorage("owner");
    const startTask = vi.fn();
    const port = createRequestPort({
      storage: application.storage,
      ownerStorage: owner.storage,
      secrets: recordingSecrets([]),
      background: { kind: "trigger", startTask },
      publicUrl: "https://requestport.test",
    });

    await expect(port.start()).resolves.toBeUndefined();
    await expect(port.start()).resolves.toBeUndefined();

    expect(mocks.managers).toHaveLength(1);
    expect(requestPortComposition(port).worker).toBeUndefined();
    expect(mocks.managers).toHaveLength(1);
    expect(startTask).not.toHaveBeenCalled();
    expect(application.touched).toEqual(["db"]);
    expect(owner.touched).toEqual([]);
  });
});

describe("query, the agent queries, the MCP-only capabilities and the composed members (ruling 137)", () => {
  const projectId = "018f0000-0000-7000-8000-0000000c1202";
  const meta = { idempotencyKey: "request-port-query-key", expectedVersion: 0 };
  const agent = {
    actor: {
      type: "agent" as const,
      id: "018f0000-0000-7000-8000-0000000c1303",
      delegatedBy: { type: "user" as const, id: "user-delegating" },
    },
    organizationId,
    projectId,
    laneIds: new Set<string>(),
    scopes: new Set(["request:read", "webhook:manage"]),
    credentialId: "request-port-query-grant",
    correlationId: "018f0000-0000-7000-8000-0000000c1304",
    audience: "api",
    authorizationId: "request-port-query-grant",
  };
  const operator = {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000c1305",
      memberUserId: "018f0000-0000-7000-8000-0000000c1306",
    }),
    credentialKind: "operator" as const,
    organizationId,
    projectId: null,
    scopes: new Set(["routing:manage"]),
    credentialId: "request-port-query-operator",
    correlationId: "018f0000-0000-7000-8000-0000000c1307",
    authorizationId: "request-port-query-operator",
  };
  const webhookKeys = {
    current: {
      version: "request-port-test-v1",
      key: Buffer.alloc(32, 9).toString("base64url"),
    },
    signingKey: "request-port-test-signing-key",
  };

  function port(options: Partial<RequestPortOptions> = {}) {
    return createRequestPort({
      storage: recordingStorage("application").storage,
      secrets: recordingSecrets([]),
      publicUrl: "https://requestport.test",
      ...options,
    });
  }

  test("commandBus and background are the bus and the background port it composed, once, and taking them composes it", () => {
    const requestPort = port();

    const { commandBus, background } = requestPort;
    const composition = requestPortComposition(requestPort);

    expect(commandBus).toBe(composition.commandBus);
    expect(background).toBe(composition.background);
    expect(requestPort.commandBus).toBe(commandBus);
    expect(mocks.managers).toHaveLength(1);
  });

  test("execute's bus target is the commandBus it exposes", async () => {
    const requestPort = port();
    const execute = vi
      .spyOn(requestPort.commandBus, "execute")
      .mockResolvedValue({ ran: "on the composed bus" } as never);

    await expect(
      requestPort.execute(
        "post_message",
        { marker: "post" },
        { context: agent, credentialKind: "agent", meta },
      ),
    ).resolves.toEqual({ ran: "on the composed bus" });
    expect(execute).toHaveBeenCalledOnce();
  });

  test("query runs an agent query over a repository built on its storage's handle when the query runs, and agentQueries are what it dispatches to", async () => {
    const requestPort = port();

    await expect(
      requestPort.query(
        "list_events",
        { searchParams: new URLSearchParams([["cursor", "c-1"]]) },
        { context: agent, credentialKind: "agent" },
      ),
    ).resolves.toEqual({ events: [{ ...agent, projectId }, "c-1"] });
    expect(mocks.calls).toEqual(["agent queries application"]);
    expect(requestPortComposition(requestPort).agentQueries).toBe(
      requestPort.agentQueries,
    );

    await requestPort.agentQueries.listEvents(agent, "c-2");
    expect(mocks.calls).toEqual([
      "agent queries application",
      "agent queries application",
    ]);
  });

  test("agentQueries refuses an agent's context lacking the scope its query asks, in query's words, before a repository is built on its storage's handle (ruling 230)", async () => {
    const requestPort = port();
    const webhooksOnly = { ...agent, scopes: new Set(["webhook:manage"]) };

    // Called as a consumer calls it: the refusal is the promise's rejection.
    const error = await requestPort.agentQueries
      .getRequest(webhooksOnly, "018f0000-0000-7000-8000-0000000c1308")
      .then(
        () => undefined,
        (refusal: unknown) => refusal,
      );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "forbidden",
      message: "Agent scope is not sufficient",
    });
    expect(mocks.calls).toEqual([]);
  });

  test("query runs an administration read with its storage's handle and its secrets, refusing an agent first", async () => {
    const application = recordingStorage("application");
    const read: string[] = [];
    const secrets = recordingSecrets(read);
    const requestPort = port({ storage: application.storage, secrets });
    const reads = administrationReads as Record<
      string,
      (input: unknown) => Promise<unknown>
    >;
    const original = reads.list_administration_routing_rules;
    const recorded = vi.fn(async (_input: unknown) => ({ rules: [] }));
    reads.list_administration_routing_rules = recorded;
    try {
      await expect(
        requestPort.query(
          "list_administration_routing_rules",
          {},
          { context: agent, credentialKind: "agent" },
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(recorded).not.toHaveBeenCalled();

      await expect(
        requestPort.query(
          "list_administration_routing_rules",
          {},
          { context: operator, credentialKind: "operator" },
        ),
      ).resolves.toEqual({ rules: [] });
      expect(recorded).toHaveBeenCalledExactlyOnceWith({
        context: operator,
        pathParameters: {},
        searchParams: new URLSearchParams(),
        reading: { database: application.db, secrets },
      });
    } finally {
      if (original) reads.list_administration_routing_rules = original;
    }
  });

  describe("mcpOnly.createProject requires the delegating person to be present (ruling 230 item 2)", () => {
    const userId = "018f0000-0000-7000-8000-0000000c1309";
    const created = {
      correlationId: "018f0000-0000-7000-8000-0000000c130a",
      delegatedByUserId: userId,
      organizationId,
      project: { name: "Core", slug: "core", keyPrefix: "CORE" },
    };
    /** A transaction whose name both repository stand-ins print. */
    const theTransaction = {
      name: "the-transaction",
      toString: () => "the-transaction",
    };
    const transactional = () =>
      ({
        db: { name: "application" },
        transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work(theTransaction),
      }) as unknown as Storage;

    test("refuses a call naming no credential for the delegating person before its storage's transaction opens", async () => {
      const application = recordingStorage("application");

      await expect(
        port({ storage: application.storage }).mcpOnly.createProject({
          ...created,
          credentialId: undefined,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message:
          "Creating a project requires the credential the delegating person acts on, a provisioning grant or a live session",
      });

      expect(application.touched).not.toContain("transaction");
      expect(mocks.calls).toEqual([]);
      expect(mocks.rechecked).toEqual([]);
    });

    test("re-checks the person's credential on the transaction it opens on its storage, and a refusal there stops it before the foundation repository is opened", async () => {
      const stale = new DomainError(
        "forbidden",
        "Current human authorization is no longer active",
      );
      mocks.recheckRefusal = stale;

      await expect(
        port({ storage: transactional() }).mcpOnly.createProject({
          ...created,
          credentialId: "request-port-session",
        }),
      ).rejects.toBe(stale);

      expect(mocks.calls).toEqual(["authorization the-transaction"]);
      expect(mocks.rechecked).toEqual([
        expect.objectContaining({
          actor: { type: "user", id: userId },
          organizationId,
          credentialId: "request-port-session",
        }),
      ]);
    });

    test("with the credential admitted, ProjectService runs over the foundation repository opened on that same transaction, after the re-check", async () => {
      await expect(
        port({ storage: transactional() }).mcpOnly.createProject({
          ...created,
          credentialId: "018f0000-0000-7000-8000-0000000c130b",
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "An active organization is required",
      });

      expect(mocks.calls).toEqual([
        "authorization the-transaction",
        "foundation the-transaction",
        "findOrganizationAuthorization",
      ]);
      expect(mocks.rechecked).toHaveLength(1);
    });
  });

  test("mcpOnly.provisionAgent refuses without betterAuth.createAgentApiKey before anything runs on the bus, and with it runs create_agent_principal on the bus it composed", async () => {
    const provision = {
      idempotencyKey: "request-port-provision-key",
      delegatedByUserId: "user-delegating",
      // A grant's id is a UUID; anything else is refused before the bus.
      issuingGrantId: "018f0000-0000-7000-8000-0000000c130c",
      organizationId,
      provision: {
        displayName: "Agent",
        projectId,
        scopes: ["request:read"],
        slug: "agent",
      },
    };
    const without = port();
    const withoutBus = vi.spyOn(without.commandBus, "execute");

    await expect(
      without.mcpOnly.provisionAgent(provision),
    ).rejects.toMatchObject({ code: "configuration_error" });
    expect(withoutBus).not.toHaveBeenCalled();

    const createAgentApiKey = vi.fn();
    const minting = port({ betterAuth: { createAgentApiKey } });
    const refusal = new Error("stopped at the bus");
    const bus = vi
      .spyOn(minting.commandBus, "execute")
      .mockRejectedValue(refusal);

    await expect(minting.mcpOnly.provisionAgent(provision)).rejects.toBe(
      refusal,
    );
    expect(bus).toHaveBeenCalledWith(
      expect.objectContaining({ name: "create_agent_principal" }),
    );
    expect(createAgentApiKey).not.toHaveBeenCalled();
  });

  test.each([
    ["production", true],
    ["preview", false],
    [undefined, false],
  ] as const)(
    "mcpOnly.webhooks, under environment %j, holds endpoints to the production policy: %s",
    async (environment, production) => {
      const requestPort = port({
        environment,
        secrets: {
          ...recordingSecrets([]),
          commandFingerprintKey: "request-port-test-signing-material-0001",
          webhookKeys,
        },
      });

      await requestPort.mcpOnly.webhooks?.list(agent, organizationId);

      expect(mocks.webhookServices).toEqual([
        { ...mocks.webhookServices[0], production },
      ]);
      expect(mocks.webhookServices[0]?.repository).toEqual({
        webhooksOver: "application",
      });
    },
  );

  test.each(
    (["production", "development", undefined] as const).flatMap((environment) =>
      (
        [
          [true, true],
          [false, false],
          [undefined, false],
        ] as const
      ).map(
        ([privateWebhookReceivers, privateReceivers]) =>
          [privateWebhookReceivers, environment, privateReceivers] as const,
      ),
    ),
  )(
    "mcpOnly.webhooks, with privateWebhookReceivers %j under the environment %j, admits private and loopback receivers: %s",
    async (privateWebhookReceivers, environment, privateReceivers) => {
      const requestPort = port({
        environment,
        ...(privateWebhookReceivers === undefined
          ? {}
          : { privateWebhookReceivers }),
        secrets: {
          ...recordingSecrets([]),
          commandFingerprintKey: "request-port-test-signing-material-0001",
          webhookKeys,
        },
      });

      await requestPort.mcpOnly.webhooks?.list(agent, organizationId);

      expect(mocks.webhookServices).toHaveLength(1);
      expect(mocks.webhookServices[0]?.privateReceivers).toBe(privateReceivers);
      expect(mocks.webhookServices[0]?.production).toBe(
        environment === "production",
      );
    },
  );

  test("mcpOnly.webhooks is null without webhook keys", () => {
    expect(port().mcpOnly.webhooks).toBeNull();
  });

  test("mcpOnly.webhooks re-checks a person's context with the bus's re-check over its storage's handle before the service is built, and refuses with its refusal; an agent's context is not re-checked there (ruling 233 item 2)", async () => {
    const application = recordingStorage("application");
    const requestPort = port({
      storage: application.storage,
      secrets: {
        ...recordingSecrets([]),
        commandFingerprintKey: "request-port-test-signing-material-0001",
        webhookKeys,
      },
    });
    const person = {
      actor: { type: "user" as const, id: "user-request-port" },
      organizationId,
      scopes: new Set(["webhook:manage"]),
      credentialId: "session-request-port",
      correlationId: "018f0000-0000-7000-8000-0000000c1310",
    };
    const refusal = new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );
    mocks.recheckRefusal = refusal;

    await expect(
      requestPort.mcpOnly.webhooks?.list(person, organizationId),
    ).rejects.toBe(refusal);
    expect(mocks.rechecked).toEqual([person]);
    expect(mocks.recheckHandles).toHaveLength(1);
    expect(mocks.recheckHandles[0]).toBe(application.db);
    expect(mocks.webhookServices).toEqual([]);

    mocks.recheckRefusal = undefined;
    await requestPort.mcpOnly.webhooks?.list(person, organizationId);
    await requestPort.mcpOnly.webhooks?.list(agent, organizationId);
    expect(mocks.rechecked).toEqual([person, person]);
    expect(mocks.webhookServices).toHaveLength(2);
  });

  test("mcpOnly.webhooks runs a person's call over db's webhook repository built on its storage's handle with the person's credentialId, which its locked checks read again, and an agent's over one given none (ruling 234 (c))", async () => {
    const application = recordingStorage("application");
    const requestPort = port({
      storage: application.storage,
      secrets: {
        ...recordingSecrets([]),
        commandFingerprintKey: "request-port-test-signing-material-0001",
        webhookKeys,
      },
    });
    const person = {
      actor: { type: "user" as const, id: "user-request-port" },
      organizationId,
      scopes: new Set(["webhook:manage"]),
      credentialId: "session-request-port",
      correlationId: "018f0000-0000-7000-8000-0000000c1314",
    };

    await requestPort.mcpOnly.webhooks?.list(person, organizationId);
    await requestPort.mcpOnly.webhooks?.list(agent, organizationId);

    expect(mocks.webhookServices.map(({ repository }) => repository)).toEqual([
      {
        webhooksOver: "application",
        personCredentialId: "session-request-port",
      },
      { webhooksOver: "application" },
    ]);
  });

  test("mcpOnly.provisionAgent's key issuance re-checks the delegated context with the bus's re-check over its storage's handle, and mints nothing when it refuses (ruling 233 item 2)", async () => {
    const application = recordingStorage("application");
    const createAgentApiKey = vi.fn();
    const requestPort = port({
      storage: application.storage,
      betterAuth: { createAgentApiKey },
    });
    vi.spyOn(requestPort.commandBus, "execute").mockResolvedValue({
      id: "018f0000-0000-7000-8000-0000000c1311",
    } as never);
    const refusal = new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );
    mocks.recheckRefusal = refusal;
    const grant = "018f0000-0000-7000-8000-0000000c1312";

    await expect(
      requestPort.mcpOnly.provisionAgent({
        idempotencyKey: "request-port-provision-recheck",
        delegatedByUserId: "user-delegating",
        issuingGrantId: grant,
        organizationId,
        provision: {
          displayName: "Agent",
          projectId,
          scopes: ["request:read"],
          slug: "agent",
        },
      }),
    ).rejects.toBe(refusal);
    expect(mocks.rechecked).toEqual([
      expect.objectContaining({
        actor: { type: "user", id: "user-delegating" },
        credentialId: grant,
      }),
    ]);
    // Two repositories over the storage's handle: the grant read's, before
    // the bus, and the key service's re-check.
    expect(mocks.recheckHandles).toEqual([application.db, application.db]);
    expect(createAgentApiKey).not.toHaveBeenCalled();
  });

  test("mcpOnly.provisionAgent reads its grant (assertProvisioningGrant) over its storage's handle before anything runs on the bus, and its refusal is the call's (ruling 233 item 4)", async () => {
    const application = recordingStorage("application");
    const createAgentApiKey = vi.fn();
    const requestPort = port({
      storage: application.storage,
      betterAuth: { createAgentApiKey },
    });
    const bus = vi.spyOn(requestPort.commandBus, "execute");
    const refusal = new DomainError(
      "forbidden",
      "Current human authorization is no longer active",
    );
    mocks.grantRefusal = refusal;
    const grant = "018f0000-0000-7000-8000-0000000c1313";

    await expect(
      requestPort.mcpOnly.provisionAgent({
        idempotencyKey: "request-port-provision-grant-read",
        delegatedByUserId: "user-delegating",
        issuingGrantId: grant,
        organizationId,
        provision: {
          displayName: "Agent",
          projectId,
          scopes: ["request:read"],
          slug: "agent",
        },
      }),
    ).rejects.toBe(refusal);
    expect(mocks.grantsRead).toEqual([
      expect.objectContaining({
        actor: { type: "user", id: "user-delegating" },
        organizationId,
        credentialId: grant,
      }),
    ]);
    expect(mocks.recheckHandles).toEqual([application.db]);
    expect(bus).not.toHaveBeenCalled();
    expect(mocks.rechecked).toEqual([]);
    expect(createAgentApiKey).not.toHaveBeenCalled();
  });

  test("mcpOnly.webhooks is composed when it is first read, once: a malformed webhook key fails the webhook capabilities alone, not the RequestPort's composition (ruling 140)", async () => {
    const malformed = port({
      secrets: {
        ...recordingSecrets([]),
        webhookKeys: {
          current: { version: "request-port-test-v1", key: "not-32-bytes" },
        },
      },
    });

    // Everything else composes, and runs.
    expect(malformed.commandBus).toBe(
      requestPortComposition(malformed).commandBus,
    );
    expect(mocks.managers).toHaveLength(1);
    await expect(
      malformed.query(
        "list_events",
        { searchParams: new URLSearchParams() },
        { context: agent, credentialKind: "agent" },
      ),
    ).resolves.toEqual({ events: [{ ...agent, projectId }, undefined] });
    expect(Object.keys(malformed.handlers)).toHaveLength(4);
    expect(Object.keys(malformed.mcpOnly.imports).sort()).toEqual([
      "analyze",
      "apply",
      "correct",
      "detail",
      "list",
    ]);
    // The webhook capabilities refuse, each time they are asked for.
    // As `configuration_error`, an operator's fault, which MCP answers with
    // 503, not with the 403 it gives a credential it refuses.
    for (const _read of [1, 2]) {
      let refusal: unknown;
      try {
        void malformed.mcpOnly.webhooks;
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DomainError);
      expect(refusal).toMatchObject({
        code: "configuration_error",
        message: expect.stringContaining(
          "must be a base64url-encoded 32-byte key",
        ),
      });
    }

    // A well-formed ring: the same service at every read.
    const composed = port({
      secrets: {
        ...recordingSecrets([]),
        commandFingerprintKey: "request-port-test-signing-material-0001",
        webhookKeys,
      },
    });
    const webhooks = composed.mcpOnly.webhooks;

    expect(webhooks).not.toBeNull();
    expect(composed.mcpOnly.webhooks).toBe(webhooks);
  });

  test("the webhook replay reads and writes over its storage's handle, and starts the replay through the background it composed", async () => {
    const requestPort = port({
      secrets: {
        ...recordingSecrets([]),
        commandFingerprintKey: "request-port-test-signing-material-0001",
        webhookKeys,
      },
    });
    const start = vi
      .spyOn(requestPort.background, "triggerWebhookDelivery")
      .mockResolvedValue({ id: "run-1" });

    await expect(
      requestPort.mcpOnly.webhooks?.replay("delivery-1", {
        context: agent,
        credentialKind: "agent",
        meta,
      }),
    ).resolves.toEqual({ deliveryId: "replay-1" });
    expect(mocks.calls).toEqual([
      `bound outbox ${organizationId} application`,
      "outbox.loadWebhookDelivery delivery-1",
      "outbox.createWebhookReplay application",
    ]);
    expect(start).toHaveBeenCalledExactlyOnceWith("replay-1");
  });

  test("the webhook replay refuses an agent whose context lacks webhook:manage before its storage is touched, and starts nothing (ruling 230)", async () => {
    const requestPort = port({
      secrets: {
        ...recordingSecrets([]),
        commandFingerprintKey: "request-port-test-signing-material-0001",
        webhookKeys,
      },
    });
    const start = vi
      .spyOn(requestPort.background, "triggerWebhookDelivery")
      .mockResolvedValue({ id: "run-1" });

    await expect(
      requestPort.mcpOnly.webhooks?.replay("delivery-1", {
        context: { ...agent, scopes: new Set(["request:read"]) },
        credentialKind: "agent",
        meta,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Required capability is missing",
    });
    expect(mocks.calls).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  test("a background port given in place of a background is the one it uses: the bus hands it its committed events, and the off-bus and MCP-only capabilities start through it; none is composed over its storage", async () => {
    const recorded: unknown[][] = [];
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        recorded.push([name, ...args]);
        return undefined;
      };
    const given = {
      dispatchCommittedOutbox: record("dispatchCommittedOutbox"),
      dispatchImportTask: record("dispatchImportTask"),
      dispatchCommittedEvents: record("dispatchCommittedEvents"),
      dispatchCommittedCorrelation: record("dispatchCommittedCorrelation"),
      triggerNotificationDelivery: record("triggerNotificationDelivery"),
      triggerSlackConnectionTest: record("triggerSlackConnectionTest"),
      triggerSlackMessageUpdate: record("triggerSlackMessageUpdate"),
      triggerWebhookDelivery: record("triggerWebhookDelivery"),
    } as unknown as RequestPortOptions["backgroundPort"];
    const requestPort = port({
      backgroundPort: given,
      secrets: {
        ...recordingSecrets([]),
        commandFingerprintKey: "request-port-test-signing-material-0001",
        webhookKeys,
      },
    });
    const events = [{ id: "event-1", organizationId }];

    expect(requestPort.background).toBe(given);
    await (
      requestPort.commandBus as unknown as {
        dependencies: { afterCommit(events: unknown[]): Promise<void> };
      }
    ).dependencies.afterCommit(events);
    await requestPort.mcpOnly.webhooks?.replay("delivery-1", {
      context: agent,
      credentialKind: "agent",
      meta,
    });

    expect(recorded).toEqual([
      ["dispatchCommittedEvents", events],
      ["triggerWebhookDelivery", "replay-1"],
    ]);
    // The replay's read is the capability's own; no committed row was read
    // through a background port composed over the storage.
    expect(mocks.calls).toEqual([
      `bound outbox ${organizationId} application`,
      "outbox.loadWebhookDelivery delivery-1",
      "outbox.createWebhookReplay application",
    ]);
  });

  test("the legacy import analysis and apply, and the Slack connection test, start their work through the background port it was given: each start carries its own id, and each import dispatch the context's organisation (D5)", async () => {
    const recorded: unknown[][] = [];
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        recorded.push([name, ...args]);
        return undefined;
      };
    const given = {
      dispatchCommittedOutbox: record("dispatchCommittedOutbox"),
      dispatchImportTask: record("dispatchImportTask"),
      dispatchCommittedEvents: record("dispatchCommittedEvents"),
      dispatchCommittedCorrelation: record("dispatchCommittedCorrelation"),
      triggerNotificationDelivery: record("triggerNotificationDelivery"),
      triggerSlackConnectionTest: record("triggerSlackConnectionTest"),
      triggerSlackMessageUpdate: record("triggerSlackMessageUpdate"),
      triggerWebhookDelivery: record("triggerWebhookDelivery"),
    } as unknown as RequestPortOptions["backgroundPort"];
    const requestPort = port({
      backgroundPort: given,
      storage: {
        db: { name: "application" },
        transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work("the-transaction"),
      } as unknown as Storage,
    });
    const call = { context: agent, credentialKind: "agent" as const, meta };

    await expect(
      requestPort.mcpOnly.imports.analyze(
        { sourceId: "source-1", snapshotId: "snapshot-1" },
        call,
      ),
    ).resolves.toEqual({ runId: "run-analysis", state: "queued" });
    await expect(
      requestPort.mcpOnly.imports.apply(
        { runId: "run-analysis", manifestSha256: "manifest-sha256" },
        call,
      ),
    ).resolves.toEqual({ runId: "run-analysis", state: "queued" });
    await expect(
      requestPort.handlers.queueSlackConnectionTest(
        { ...operator, scopes: new Set(["slack:manage"]) },
        {
          organizationId,
          installationId: "018f0000-0000-7000-8000-0000000c1308",
          channelId: "C012ABCDEF",
        },
        meta,
      ),
    ).resolves.toEqual({ operationId: "operation-1", dispatched: true });

    // The Slack connection test's start carries the operation's id alone,
    // as `triggerSlackConnectionTest` takes it.
    expect(recorded).toEqual([
      ["dispatchImportTask", "dispatch-of-the-analysis", organizationId],
      ["dispatchImportTask", "dispatch-of-the-apply", organizationId],
      ["triggerSlackConnectionTest", "operation-1"],
    ]);
  });

  test("refuses, as it composes, a background and a background port together", async () => {
    const requestPort = port({
      background: { kind: "none" },
      backgroundPort: {} as RequestPortOptions["backgroundPort"],
    });

    await expect(
      requestPort.execute(
        "post_message",
        {},
        { context: agent, credentialKind: "agent", meta },
      ),
    ).rejects.toMatchObject({
      code: "configuration_error",
      message:
        "A RequestPort takes a background or a background port, not both",
    });
    expect(mocks.managers).toEqual([]);
  });

  test("handlers are the off-bus handlers execute dispatches to, composed once, each taking its caller's context as it is given", async () => {
    const requestPort = port({
      storage: {
        db: { name: "application" },
        transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work("the-transaction"),
      } as unknown as Storage,
    });
    const { handlers } = requestPort;

    expect(requestPort.handlers).toBe(handlers);
    expect(Object.keys(handlers).sort()).toEqual([
      "queueSlackConnectionTest",
      "revokeAgentCredential",
      "revokeAgentOauthGrant",
      "splitImportEntry",
    ]);
    await expect(
      handlers.queueSlackConnectionTest(
        { ...operator, scopes: new Set(["slack:manage"]) },
        {
          organizationId,
          installationId: "018f0000-0000-7000-8000-0000000c1308",
          channelId: "C012ABCDEF",
        },
        meta,
      ),
    ).resolves.toEqual({ operationId: "operation-1", dispatched: false });
    expect(mocks.calls).toEqual([
      "authorization the-transaction",
      "slack the-transaction",
    ]);
  });
});
