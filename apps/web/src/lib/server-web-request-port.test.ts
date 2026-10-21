import type { RequestPortOptions } from "@requestport/core";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

/*
 * The web's RequestPort's options (Plan 13, G.6; ruling 140): what
 * `webRequestPort()` (`server-web-request-port.ts`) hands
 * `createRequestPort`, captured. `createRequestPort` is replaced, so nothing
 * here composes or runs a capability; the suites that drive the real
 * composition (the REST and MCP routes', the actions', the importers test)
 * hold what it does with these. Those suites stayed green with Better Auth's
 * minter removed, the environment forced to production or the metrics
 * dropped (the round-2 review's plants), so each option is pinned here as it
 * is handed: the storage, the environment, the metrics, the minter, each
 * background member and the secrets, from the web root and `serverEnv`.
 */

/** Each background member, with arguments of the shape `BackgroundPort` gives it. */
const BACKGROUND_CALLS: ReadonlyArray<[string, unknown[]]> = [
  ["dispatchCommittedCorrelation", ["correlation-1", "organization-1"]],
  ["dispatchCommittedEvents", [[{ id: "event-1" }]]],
  ["dispatchCommittedOutbox", ["outbox-1", "organization-1"]],
  ["dispatchImportTask", ["dispatch-1", "organization-1"]],
  ["triggerNotificationDelivery", ["intent-1", "email"]],
  ["triggerSlackConnectionTest", ["operation-1"]],
  ["triggerSlackMessageUpdate", ["operation-2"]],
  ["triggerWebhookDelivery", ["delivery-1"]],
];
const BACKGROUND_MEMBERS = BACKGROUND_CALLS.map(([name]) => name);

const hoisted = vi.hoisted(() => {
  const configured = {
    BETTER_AUTH_SECRET: "web-request-port-test-signing-material-0001",
    BETTER_AUTH_URL: "https://requestport.test",
    // Unlike this process's own NODE_ENV, and with VERCEL_ENV set to
    // "preview" below, as on a Vercel preview: so the environment case tells
    // serverEnv's NODE_ENV apart from process.env's and from the label's
    // `VERCEL_ENV ?? NODE_ENV`, which ruling 140 rejected.
    NODE_ENV: "production",
    REQUESTPORT_OPERATOR_CREDENTIALS: "enabled",
    REQUESTPORT_WORKSPACE_KEK: "workspace-key-current",
    REQUESTPORT_WORKSPACE_KEK_VERSION: "workspace-v2",
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS: "workspace-key-previous",
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: "workspace-v1",
    REQUESTPORT_WEBHOOK_KEK: "webhook-key-current",
    REQUESTPORT_WEBHOOK_KEK_VERSION: "webhook-v2",
    REQUESTPORT_WEBHOOK_KEK_PREVIOUS: "webhook-key-previous",
    REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION: "webhook-v1",
    REQUESTPORT_WEBHOOK_SIGNING_KEY: "webhook-signing-key",
  };
  const trigger: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of [
    "dispatchCommittedCorrelation",
    "dispatchCommittedEvents",
    "dispatchCommittedOutbox",
    "dispatchImportTask",
    "triggerNotificationDelivery",
    "triggerSlackConnectionTest",
    "triggerSlackMessageUpdate",
    "triggerWebhookDelivery",
  ])
    trigger[name] = async (...args: unknown[]) => ({ answeredBy: name, args });
  return {
    configured,
    /** `serverEnv`, which a case may change between reads. */
    serverEnv: { ...configured } as Record<string, string | undefined>,
    /** What `createRequestPort` was handed, call by call. */
    handed: [] as RequestPortOptions[],
    storage: { the: "web root's storage" },
    metrics: { the: "web's metrics" },
    createAgentApiKey: async (input: unknown) => ({ minted: input }),
    trigger,
  };
});

vi.mock("@requestport/config/server", () => ({
  serverEnv: hoisted.serverEnv,
}));
vi.mock("@requestport/core", () => ({
  createRequestPort: (options: RequestPortOptions) => {
    hoisted.handed.push(options);
    return { composedFrom: options };
  },
}));
vi.mock("./server-request-port.js", () => ({
  webStorage: vi.fn(() => hoisted.storage),
}));
vi.mock("./observability.js", () => ({ webMetrics: hoisted.metrics }));
vi.mock("./trigger-client.js", () =>
  Object.fromEntries(
    Object.entries(hoisted.trigger).map(([name, run]) => [name, vi.fn(run)]),
  ),
);
vi.mock("@requestport/auth/server", () => ({
  createAgentApiKey: vi.fn(hoisted.createAgentApiKey),
}));

vi.stubEnv("VERCEL_ENV", "preview");
afterAll(() => {
  vi.unstubAllEnvs();
});

const { webRequestPort } = await import("./server-web-request-port.js");
const trigger = await import("./trigger-client.js");
const auth = await import("@requestport/auth/server");
const { webStorage } = await import("./server-request-port.js");

/** The options of the one composition this module's copy keeps. */
function handed(): RequestPortOptions {
  webRequestPort();
  const [options] = hoisted.handed;
  if (!options) throw new Error("createRequestPort was handed nothing");
  return options;
}

afterEach(() => {
  Object.assign(hoisted.serverEnv, hoisted.configured);
  vi.clearAllMocks();
});

describe("the web's RequestPort, as createRequestPort receives it", () => {
  test("is composed once, over webStorage(), and answered at every ask", () => {
    const port = webRequestPort();

    expect(webRequestPort()).toBe(port);
    expect(hoisted.handed).toHaveLength(1);
    expect(handed().storage).toBe(hoisted.storage);
    expect(vi.mocked(webStorage)).toHaveBeenCalledTimes(1);
  });

  test("takes its environment from serverEnv's NODE_ENV, not VERCEL_ENV, its metrics from webMetrics, and its public URL from BETTER_AUTH_URL", () => {
    const options = handed();

    expect(options.environment).toBe("production");
    expect(options.environment).toBe(hoisted.configured.NODE_ENV);
    expect(options.metrics).toBe(hoisted.metrics);
    expect(options.publicUrl).toBe("https://requestport.test");
  });

  test("mints an agent's key through @requestport/auth/server's createAgentApiKey, with what it is given", async () => {
    const minter = handed().betterAuth?.createAgentApiKey;
    const input = { the: "key's input" } as unknown as Parameters<
      NonNullable<typeof minter>
    >[0];

    expect(minter).toBeTypeOf("function");
    await expect(minter?.(input)).resolves.toEqual({ minted: input });
    expect(vi.mocked(auth.createAgentApiKey)).toHaveBeenCalledExactlyOnceWith(
      input,
    );
  });

  test.each(BACKGROUND_CALLS)(
    "starts %s through trigger-client's function of the same name, with what it is given",
    async (name, args) => {
      const port = handed().backgroundPort as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;

      expect(Object.keys(port).sort()).toEqual([...BACKGROUND_MEMBERS]);
      await expect(port[name]?.(...args)).resolves.toEqual({
        answeredBy: name,
        args,
      });
      for (const other of BACKGROUND_MEMBERS) {
        const called = vi.mocked(
          (trigger as unknown as Record<string, () => unknown>)[other],
        );
        if (other === name)
          expect(called).toHaveBeenCalledExactlyOnceWith(...args);
        else expect(called).not.toHaveBeenCalled();
      }
    },
  );

  test("reads BETTER_AUTH_SECRET and REQUESTPORT_OPERATOR_CREDENTIALS from serverEnv each time they are read", () => {
    const { secrets } = handed();

    expect(secrets.commandFingerprintKey).toBe(
      hoisted.configured.BETTER_AUTH_SECRET,
    );
    expect(secrets.operatorCredentials).toBe("enabled");

    hoisted.serverEnv.BETTER_AUTH_SECRET =
      "web-request-port-test-signing-material-0002";
    hoisted.serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS = "disabled";

    expect(secrets.commandFingerprintKey).toBe(
      "web-request-port-test-signing-material-0002",
    );
    expect(secrets.operatorCredentials).toBe("disabled");
  });

  test("carries the workspace and webhook key rings serverEnv holds, each previous key with its version", () => {
    const { secrets } = handed();

    expect(secrets.workspaceKeys).toEqual({
      current: { version: "workspace-v2", key: "workspace-key-current" },
      previous: { version: "workspace-v1", key: "workspace-key-previous" },
    });
    expect(secrets.webhookKeys).toEqual({
      current: { version: "webhook-v2", key: "webhook-key-current" },
      previous: { version: "webhook-v1", key: "webhook-key-previous" },
      signingKey: "webhook-signing-key",
    });
  });

  test("without the KEKs, carries no workspace ring and a webhook ring whose current key is the signing key, as server-webhooks.ts built it", async () => {
    hoisted.serverEnv.REQUESTPORT_WORKSPACE_KEK = undefined;
    hoisted.serverEnv.REQUESTPORT_WEBHOOK_KEK = undefined;
    hoisted.serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS = undefined;
    vi.resetModules();
    const fresh = await import("./server-web-request-port.js");

    fresh.webRequestPort();
    const options = hoisted.handed.at(-1);

    expect(hoisted.handed).toHaveLength(2);
    expect(options?.secrets.workspaceKeys).toBeUndefined();
    expect(options?.secrets.webhookKeys).toEqual({
      current: { version: "webhook-v2", key: "webhook-signing-key" },
      signingKey: "webhook-signing-key",
    });
  });

  test("admits private and loopback webhook receivers exactly when serverEnv's REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is enabled, read as it composes", async () => {
    expect(handed().privateWebhookReceivers).toBe(false);

    hoisted.serverEnv.REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS = "enabled";
    try {
      vi.resetModules();
      const fresh = await import("./server-web-request-port.js");
      const before = hoisted.handed.length;

      fresh.webRequestPort();
      expect(hoisted.handed).toHaveLength(before + 1);
      expect(hoisted.handed.at(-1)?.privateWebhookReceivers).toBe(true);
    } finally {
      delete hoisted.serverEnv.REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS;
    }
  });
});

/*
 * The web's RequestPort and the host's handoff (Plan 13, H.5; manifest-h.md
 * §2.7.1; rulings 141, 145 and 160). While
 * `globalThis[Symbol.for("requestport.host")]` is set, `webRequestPort()`
 * answers the RequestPort it carries and composes none; a handoff without
 * one is refused, by name, with one console line. Unset, as on Vercel, which
 * never sets it, it composes as the cases above hold.
 */
describe("the web's RequestPort and the host's handoff", () => {
  const HOST = Symbol.for("requestport.host");
  const holder = globalThis as Record<symbol, unknown>;

  afterEach(() => {
    delete holder[HOST];
    vi.restoreAllMocks();
  });

  /** A copy of the module that has composed nothing yet. */
  async function freshModule() {
    vi.resetModules();
    return import("./server-web-request-port.js");
  }

  test("present, it answers the handoff's RequestPort at every ask, and composes none", async () => {
    const fresh = await freshModule();
    const requestPort = { the: "host's RequestPort" };
    const before = hoisted.handed.length;
    holder[HOST] = { requestPort };

    expect(fresh.webRequestPort()).toBe(requestPort);
    expect(fresh.webRequestPort()).toBe(requestPort);
    expect(hoisted.handed).toHaveLength(before);
  });

  test("present without a RequestPort, it refuses with HostHandoffRefusalError and one console line naming webRequestPort(), and composes none", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fresh = await freshModule();
    const before = hoisted.handed.length;
    holder[HOST] = { storage: {}, auth: {}, admitsConstruction: () => true };
    const line =
      "HostHandoffRefusalError: RequestPort's webRequestPort() refused: the " +
      "host's handoff is present, and it carries no requestPort. While it " +
      "is present, the web answers the storage, Better Auth and RequestPort " +
      "it carries and builds none of its own (manifest-h.md §2.7.1).";

    let refusal: unknown;
    try {
      fresh.webRequestPort();
    } catch (error) {
      refusal = error;
    }

    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect(`${(refusal as Error).name}: ${(refusal as Error).message}`).toBe(
      line,
    );
    expect(logged.mock.calls).toEqual([[line]]);
    expect(hoisted.handed).toHaveLength(before);
  });

  test("absent, a fresh copy composes once, as before", async () => {
    const fresh = await freshModule();
    const before = hoisted.handed.length;

    expect(HOST in holder).toBe(false);
    const port = fresh.webRequestPort();

    expect(fresh.webRequestPort()).toBe(port);
    expect(hoisted.handed).toHaveLength(before + 1);
  });
});
