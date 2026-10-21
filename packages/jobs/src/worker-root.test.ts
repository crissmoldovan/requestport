import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  DatabaseSurfaceError,
  declareDatabaseSurface,
  declaredDatabaseSurface,
  WORKER_DATABASE_URL_VARIABLES,
  type WorkerStorages,
} from "@requestport/db";
import {
  createEnvelopeEncryption,
  decodeBase64Key,
  LocalAesKeyEncryptionKeyProvider,
} from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The worker's composition root (manifest-g.md §2.9, §2.10; M2, branch (b)):
 * the worker's three storages come from it, only after the process has
 * declared the worker surface, and only from the three variables (Plan 13,
 * I.2b's b5; ruling 214 item 1): it asks for neither of
 * `createWorkerStorages`' exceptions, and builds no storage of its own. This
 * unit project declares nothing, so the first cases run in an undeclared
 * process; the later ones declare `worker`, as the worker's entry points do.
 * The three name a server nothing listens on: building opens nothing.
 */

const built = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("@requestport/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@requestport/db")>();
  return {
    ...actual,
    createWorkerStorages: (
      ...args: Parameters<typeof actual.createWorkerStorages>
    ) => {
      built.calls.push(args);
      return actual.createWorkerStorages(...args);
    },
  };
});

// The package's own module, which registers the worker root the holder fills
// from (`index.ts`), loaded as each Trigger.dev task module loads it.
await import("./index.js");
const { workerStoragesFromRoot } = await import("./worker-root.js");
const { useWorkerStorages, workerStorages } = await import(
  "./worker-storages.js"
);
const { runJobWorkerCli } = await import("./cli.js");

/** The process environment, with the worker's three variables unset. */
const unsetEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries(
    Object.values(WORKER_DATABASE_URL_VARIABLES).map((name) => [
      name,
      undefined,
    ]),
  ),
};
/** A placeholder: the pg path refuses a URL without a password. */
const PLACEHOLDER_PASSWORD = "worker";
/** The three, each naming a server nothing listens on, on pg. */
const boundVariables: Record<string, string> = {
  REQUESTPORT_DATABASE_DRIVER: "pg",
  ...Object.fromEntries(
    Object.values(WORKER_DATABASE_URL_VARIABLES).map((name) => [
      name,
      `postgres://worker:${PLACEHOLDER_PASSWORD}@127.0.0.1:1/requestport`,
    ]),
  ),
};
const boundEnv: NodeJS.ProcessEnv = { ...unsetEnv, ...boundVariables };

/** The worker root's storage, if this process holds one (`@requestport/db/wiring`). */
function heldRootStorage(): unknown {
  const holder = globalThis as Record<
    symbol,
    Record<string, unknown> | undefined
  >;
  return holder[Symbol.for("requestport.root-storages")]?.worker;
}

const opened: WorkerStorages[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((storages) => storages.close()));
});

describe("in a process that has declared nothing", () => {
  test("the root throws before it builds the worker's storages, the three set or not", () => {
    expect(declaredDatabaseSurface()).toBeUndefined();
    built.calls.length = 0;

    for (const env of [unsetEnv, boundEnv]) {
      expect(() => workerStoragesFromRoot(env)).toThrow(DatabaseSurfaceError);
    }
    expect(built.calls).toEqual([]);
  });

  test("so does a body's first workerStorages(), which builds through the root", () => {
    useWorkerStorages(undefined);
    built.calls.length = 0;

    expect(() => workerStorages()).toThrow(DatabaseSurfaceError);
    expect(built.calls).toEqual([]);
  });
});

describe("once the worker surface is declared", () => {
  test("the root builds the three storages from the three variables, with the options it is given, and no storage of its own", () => {
    declareDatabaseSurface("worker");
    built.calls.length = 0;

    const storages = workerStoragesFromRoot(boundEnv, {
      poolSizes: { dispatcher: 3 },
    });
    opened.push(storages);

    expect(built.calls).toEqual([[boundEnv, { poolSizes: { dispatcher: 3 } }]]);
    expect(storages.bound).toBe(true);
    expect(heldRootStorage()).toBeUndefined();
  });

  test("with DATABASE_URL beside the three, as on Trigger.dev until b6, workerStoragesFromRoot looks it up nowhere and builds no storage from it (ruling 214 item 3; the configuration still judges it, ruling 215 item 8)", () => {
    declareDatabaseSurface("worker");
    built.calls.length = 0;
    const lookups: string[] = [];
    /** `source`, recording each lookup of DATABASE_URL in it. */
    const recording = (source: NodeJS.ProcessEnv, where: string) =>
      new Proxy(source, {
        get(target, key) {
          if (key === "DATABASE_URL") lookups.push(`${where}: get`);
          return Reflect.get(target, key);
        },
        has(target, key) {
          if (key === "DATABASE_URL") lookups.push(`${where}: has`);
          return Reflect.has(target, key);
        },
      });
    const ownerUrl = `postgres://owner:${PLACEHOLDER_PASSWORD}@127.0.0.1:1/owner`;
    const env = recording({ ...boundEnv, DATABASE_URL: ownerUrl }, "env");
    const processEnv = process.env;
    process.env = recording(
      { ...processEnv, DATABASE_URL: ownerUrl },
      "process.env",
    );

    try {
      const storages = workerStoragesFromRoot(env);
      opened.push(storages);

      expect(storages.bound).toBe(true);
      expect(built.calls).toHaveLength(1);
      expect(heldRootStorage()).toBeUndefined();
      expect(lookups).toEqual([]);
    } finally {
      process.env = processEnv;
    }
  });

  test("with none of the three set, the root is refused, naming them, asks for no exception, and builds no storage of its own", () => {
    built.calls.length = 0;

    expect(() => workerStoragesFromRoot(unsetEnv)).toThrow(
      "RequestPort's worker connects as its three roles, and REQUESTPORT_DISPATCHER_DATABASE_URL, REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL and REQUESTPORT_MAINTENANCE_DATABASE_URL are unset. Set all three, each to a login in its worker group.",
    );
    expect(built.calls).toEqual([[unsetEnv, {}]]);
    expect(heldRootStorage()).toBeUndefined();
  });

  test("a body's first workerStorages() builds them through the root, from the process's three variables, once, and again after they are forgotten", () => {
    for (const [name, value] of Object.entries(boundVariables)) {
      vi.stubEnv(name, value);
    }
    try {
      useWorkerStorages(undefined);
      built.calls.length = 0;

      const first = workerStorages();
      opened.push(first);

      expect(workerStorages()).toBe(first);
      expect(first.bound).toBe(true);
      expect(built.calls).toEqual([[process.env, {}]]);

      useWorkerStorages(undefined);
      opened.push(workerStorages());
      expect(built.calls).toHaveLength(2);
    } finally {
      useWorkerStorages(undefined);
      vi.unstubAllEnvs();
    }
  });

  test("installed storages are used as they are, and the root is not asked", () => {
    const installed = workerStoragesFromRoot(boundEnv);
    opened.push(installed);
    useWorkerStorages(installed);
    built.calls.length = 0;

    expect(workerStorages()).toBe(installed);
    expect(built.calls).toEqual([]);
    useWorkerStorages(undefined);
  });
});

describe("requestport-jobs", () => {
  test("builds its storages through the root, with its own pool sizes", () => {
    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /storages = workerStoragesFromRoot\(env, \{\s*poolSizes: POSTGRES_WORKER_POOL_SIZES,\s*\}\);/u,
    );
    expect(source).not.toMatch(/\bcreateWorkerStorages\(/u);
  });

  // Read from the source because the shutdown runs in the executable, which
  // `process.exit`s once it returns: bin.integration.test.ts's SIGTERM case
  // runs it to a clean exit, and cannot see which pools it ended.
  test("closes the worker's three storages when it stops, and builds and closes no storage of the root's", () => {
    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /await storages\.close\(\)\.catch\(\(\) => undefined\);\s*return drained \? 0 : 1;/u,
    );
    expect(source).not.toMatch(/\brootStorageFromEnv\b/u);
    expect(source).not.toMatch(/\bcloseDatabase\b/u);
  });

  test("its usage says it needs the worker's three database logins, and names them", async () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runJobWorkerCli(["--help"], {})).toBe(0);
    } finally {
      write.mockRestore();
    }
    const usage = written.join("");

    expect(usage).toContain(
      "and the worker's three database logins, one in each worker\ngroup:",
    );
    for (const name of Object.values(WORKER_DATABASE_URL_VARIABLES)) {
      expect(usage).toContain(`\n  ${name}\n`);
    }
    expect(usage).toContain(
      "It refuses to start without all three, and refuses to start beside a\nvariable that can reach the database as its owner: DATABASE_URL, any\nDATABASE_URL_* name, any PG* name or any POSTGRES_* name.",
    );
    expect(usage).not.toContain("the application's database");
  });
});

/*
 * What the job bodies read besides their storages (manifest-g.md §2.3;
 * ruling 65): the worker settings, kept beside the storages in
 * worker-storages.ts and filled by the root from this process's
 * configuration unless something installed its own, as core's Postgres
 * background does. Each case loads the modules afresh, so that the
 * configuration (`serverEnv`, parsed once per module graph) is the one the
 * case stubs.
 */
describe("the worker's settings", () => {
  const key = () => randomBytes(32).toString("base64");
  /** A valid server configuration with every optional group unset. */
  const configuration: Record<string, string | undefined> = {
    NODE_ENV: "test",
    VERCEL_ENV: undefined,
    BETTER_AUTH_SECRET: "worker-settings-secret-of-forty-characters",
    BETTER_AUTH_URL: "https://requestport.example",
    DATABASE_URL: "postgres://requestport@127.0.0.1:1/worker_settings",
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    RESEND_API_KEY: undefined,
    RESEND_FROM_EMAIL: undefined,
    REQUESTPORT_JOB_RUNNER: undefined,
    REQUESTPORT_WORKSPACE_KEK: undefined,
    REQUESTPORT_WORKSPACE_KEK_VERSION: undefined,
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS: undefined,
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: undefined,
    REQUESTPORT_WEBHOOK_KEK: undefined,
    REQUESTPORT_WEBHOOK_KEK_VERSION: undefined,
    REQUESTPORT_WEBHOOK_KEK_PREVIOUS: undefined,
    REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION: undefined,
    REQUESTPORT_WEBHOOK_SIGNING_KEY: undefined,
    REQUESTPORT_SLACK_SIGNING_SECRET: undefined,
    REQUESTPORT_SLACK_CLIENT_ID: undefined,
    REQUESTPORT_SLACK_CLIENT_SECRET: undefined,
    REQUESTPORT_SLACK_STATE_SECRET: undefined,
    TRIGGER_SECRET_KEY: undefined,
    TRIGGER_PROJECT_REF: undefined,
    REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: undefined,
  };
  const configure = (overrides: Record<string, string | undefined> = {}) => {
    for (const [name, value] of Object.entries({
      ...configuration,
      ...overrides,
    })) {
      vi.stubEnv(name, value);
    }
  };
  /**
   * The root, the holder and the bodies' observability, loaded afresh, after
   * the package's own module, which registers the root with the holder.
   */
  const load = async () => {
    await import("./index.js");
    return {
      ...(await import("./worker-root.js")),
      ...(await import("./worker-storages.js")),
      ...(await import("./observability.js")),
    };
  };
  const installed = (
    overrides: Partial<import("./worker-storages.js").WorkerSettings> = {},
  ): import("./worker-storages.js").WorkerSettings => ({
    environment: "installed-environment",
    publicUrl: "https://installed.example",
    productionWebhookEndpoints: false,
    privateWebhookReceivers: false,
    secrets: {
      workSweepFingerprintSecret: "installed-sweep-key",
      workspaceKeys: undefined,
      slackStateSecret: undefined,
      webhookKeys: undefined,
      email: undefined,
    },
    ...overrides,
  });
  /** The JSON lines `console.log` was given while `run` ran. */
  const linesOf = (run: () => void) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      run();
      return log.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
    } finally {
      log.mockRestore();
    }
  };

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("the root's label is VERCEL_ENV, else NODE_ENV, read once, when the settings are built, and absent with neither", async () => {
    const { workerSettingsFromRoot } = await load();

    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    const built = workerSettingsFromRoot();
    vi.stubEnv("VERCEL_ENV", "production");
    expect(built.environment).toBe("preview");

    vi.stubEnv("VERCEL_ENV", undefined);
    expect(workerSettingsFromRoot().environment).toBe("production");
    vi.stubEnv("NODE_ENV", undefined);
    expect(workerSettingsFromRoot().environment).toBeUndefined();
  });

  test("the root's webhook endpoint policy is whether NODE_ENV is production, read each time it is read, whatever VERCEL_ENV is", async () => {
    const { workerSettingsFromRoot } = await load();
    const built = workerSettingsFromRoot();

    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    expect(built.productionWebhookEndpoints).toBe(true);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "development");
    expect(built.productionWebhookEndpoints).toBe(false);
    vi.stubEnv("NODE_ENV", undefined);
    expect(built.productionWebhookEndpoints).toBe(false);
  });

  test("the root's private receivers switch is whether the configuration's REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is enabled, and is refused, naming it, when the configuration refuses it: on the Trigger.dev worker's shape, with no REQUESTPORT_JOB_RUNNER and no VERCEL_ENV, included", async () => {
    configure();
    let { workerSettingsFromRoot } = await load();
    expect(workerSettingsFromRoot().privateWebhookReceivers).toBe(false);

    vi.resetModules();
    configure({
      REQUESTPORT_JOB_RUNNER: "postgres",
      REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "enabled",
    });
    ({ workerSettingsFromRoot } = await load());
    expect(workerSettingsFromRoot().privateWebhookReceivers).toBe(true);

    for (const refused of [
      {
        REQUESTPORT_JOB_RUNNER: "postgres",
        REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "yes",
      },
      {
        REQUESTPORT_JOB_RUNNER: "postgres",
        REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "",
      },
      {
        REQUESTPORT_JOB_RUNNER: "postgres",
        REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "enabled",
        VERCEL_ENV: "",
      },
      // The Trigger.dev worker's shape: neither VERCEL_ENV nor a runner.
      { REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "enabled" },
      {
        REQUESTPORT_JOB_RUNNER: "trigger",
        REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "enabled",
      },
    ]) {
      vi.resetModules();
      configure(refused);
      ({ workerSettingsFromRoot } = await load());
      const settings = workerSettingsFromRoot();
      expect(() => settings.privateWebhookReceivers).toThrow(
        /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS/u,
      );
    }
  });

  test("the root's other members are the configuration's, parsed only when a body reads one, and refused then when it is invalid", async () => {
    configure({ DATABASE_URL: "mysql://requestport@127.0.0.1/requestport" });
    const { workerSettingsFromRoot } = await load();

    const settings = workerSettingsFromRoot();

    expect(settings.environment).toBe("test");
    expect(() => settings.publicUrl).toThrow(/DATABASE_URL/u);
    expect(() => settings.secrets.email).toThrow(/DATABASE_URL/u);
  });

  test("the root's links' origin, key rings, Slack secret and Resend pair are read as the bodies read them, each absent where its variables are", async () => {
    const workspace = { current: key(), previous: key() };
    const webhook = { kek: key(), signing: key() };
    configure({
      REQUESTPORT_WORKSPACE_KEK: workspace.current,
      REQUESTPORT_WORKSPACE_KEK_VERSION: "workspace-v2",
      REQUESTPORT_WORKSPACE_KEK_PREVIOUS: workspace.previous,
      REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: "workspace-v1",
      REQUESTPORT_WEBHOOK_SIGNING_KEY: webhook.signing,
      REQUESTPORT_SLACK_SIGNING_SECRET: "slack-signing-secret-1",
      REQUESTPORT_SLACK_CLIENT_ID: "slack-client",
      REQUESTPORT_SLACK_CLIENT_SECRET: "slack-client-secret",
      REQUESTPORT_SLACK_STATE_SECRET: "slack-state-secret-of-thirty-two-chars",
      RESEND_API_KEY: "resend-key",
      RESEND_FROM_EMAIL: "requestport@example.invalid",
    });
    let { workerSettingsFromRoot } = await load();

    expect(workerSettingsFromRoot()).toMatchObject({
      publicUrl: "https://requestport.example",
      secrets: {
        workspaceKeys: {
          current: { version: "workspace-v2", key: workspace.current },
          previous: { version: "workspace-v1", key: workspace.previous },
        },
        // No KEK: the signing key is the current key, under the KEK's
        // version, which defaults as the variable does.
        webhookKeys: {
          current: { version: "local-v1", key: webhook.signing },
          previous: undefined,
        },
        slackStateSecret: "slack-state-secret-of-thirty-two-chars",
        email: {
          apiKey: "resend-key",
          from: "requestport@example.invalid",
        },
      },
    });

    vi.resetModules();
    configure({
      REQUESTPORT_WORKSPACE_KEK: workspace.current,
      REQUESTPORT_WEBHOOK_KEK: webhook.kek,
      REQUESTPORT_WEBHOOK_KEK_VERSION: "webhook-v3",
      REQUESTPORT_WEBHOOK_SIGNING_KEY: webhook.signing,
    });
    ({ workerSettingsFromRoot } = await load());
    const { secrets } = workerSettingsFromRoot();

    expect(secrets.workspaceKeys).toEqual({
      current: { version: "local-v1", key: workspace.current },
      previous: undefined,
    });
    expect(secrets.webhookKeys).toEqual({
      current: { version: "webhook-v3", key: webhook.kek },
      previous: undefined,
    });
    expect(secrets.slackStateSecret).toBeUndefined();
    expect(secrets.email).toBeUndefined();

    vi.resetModules();
    configure();
    ({ workerSettingsFromRoot } = await load());
    expect(workerSettingsFromRoot().secrets).toMatchObject({
      workspaceKeys: undefined,
      webhookKeys: undefined,
    });
  });

  test("the root's sweep key is workSweepFingerprintSecret of the authentication secret: its HMAC-SHA256 over requestport-work-sweep-v1, in hex", async () => {
    configure();
    const { workerSettingsFromRoot, workSweepFingerprintSecret } = await load();
    const secret = configuration.BETTER_AUTH_SECRET as string;
    const expected = createHmac("sha256", secret)
      .update("requestport-work-sweep-v1")
      .digest("hex");

    expect(workerSettingsFromRoot().secrets.workSweepFingerprintSecret).toBe(
      expected,
    );
    expect(workSweepFingerprintSecret(secret)).toBe(expected);
  });

  test("workerSettings() builds through the root once, uses installed settings as they are, and builds again once they are forgotten", async () => {
    configure();
    const { useWorkerSettings, workerSettings } = await load();

    const first = workerSettings();
    expect(workerSettings()).toBe(first);
    expect(first.environment).toBe("test");

    const own = installed();
    useWorkerSettings(own);
    expect(workerSettings()).toBe(own);

    useWorkerSettings(undefined);
    const again = workerSettings();
    expect(again).not.toBe(first);
    expect(again.environment).toBe("test");
  });

  test("a body's logger and the metric sink carry the installed label and their own service, with their old defaults, and are rebuilt for other settings", async () => {
    configure();
    const { triggerMetrics, useWorkerSettings, workerLogger } = await load();
    const logger = workerLogger("trigger-retention");

    useWorkerSettings(installed());
    expect(
      linesOf(() => {
        logger.info("retention.category_completed", { count: 1 });
        triggerMetrics.count("task.result_total", 1, { taskId: "t" });
      }),
    ).toMatchObject([
      {
        event: "retention.category_completed",
        service: "trigger-retention",
        environment: "installed-environment",
      },
      {
        event: "metric.recorded",
        service: "requestport-trigger",
        environment: "installed-environment",
        metricName: "task.result_total",
      },
    ]);

    useWorkerSettings(installed({ environment: undefined }));
    expect(
      linesOf(() => {
        logger.warn("retention.category_completed");
        triggerMetrics.gauge("outbox.pending_total", 2);
      }),
    ).toMatchObject([
      { service: "trigger-retention", environment: "unknown" },
      { service: "requestport-trigger", environment: "development" },
    ]);
    useWorkerSettings(undefined);
  });

  test("the Slack and webhook envelopes open with the installed key rings, the previous key included, and refuse without them", async () => {
    configure();
    const { useWorkerSettings } = await load();
    const { decryptSlackInstallationToken, slackTokenSecret } = await import(
      "./slack-encryption.js"
    );
    const { webhookAad, webhookEncryption } = await import(
      "./webhook-encryption.js"
    );
    const ring = {
      current: { version: "v2", key: key() },
      previous: { version: "v1", key: key() },
    };
    const sealedUnder = (version: string, base64: string) =>
      createEnvelopeEncryption(
        new LocalAesKeyEncryptionKeyProvider(
          version,
          new Map([[version, decodeBase64Key(base64)]]),
        ),
      );
    const slackAad = new TextEncoder().encode(
      "requestport:slack:org-1:installation-1:bot-token",
    );

    useWorkerSettings(
      installed({
        secrets: {
          ...installed().secrets,
          workspaceKeys: ring,
          webhookKeys: ring,
          slackStateSecret: "installed-slack-state-secret",
        },
      }),
    );
    const slackEnvelope = await sealedUnder(
      ring.previous.version,
      ring.previous.key,
    ).encrypt({ token: "xoxb-installed" }, slackAad);
    await expect(
      decryptSlackInstallationToken({
        organizationId: "org-1",
        installationId: "installation-1",
        envelope: slackEnvelope,
      }),
    ).resolves.toBe("xoxb-installed");
    expect(slackTokenSecret()).toBe("installed-slack-state-secret");
    const webhookEnvelope = await webhookEncryption().encrypt(
      { secret: "whsec" },
      webhookAad("org-1", "subscription-1", "current"),
    );
    expect(webhookEnvelope.kekVersion).toBe("v2");
    await expect(
      sealedUnder(ring.current.version, ring.current.key).decrypt(
        webhookEnvelope,
        webhookAad("org-1", "subscription-1", "current"),
      ),
    ).resolves.toEqual({ secret: "whsec" });

    useWorkerSettings(installed());
    await expect(
      decryptSlackInstallationToken({
        organizationId: "org-1",
        installationId: "installation-1",
        envelope: slackEnvelope,
      }),
    ).rejects.toThrow("Slack encryption is unavailable");
    expect(() => slackTokenSecret()).toThrow(
      "Slack token hashing is unavailable",
    );
    expect(() => webhookEncryption()).toThrow(
      "Webhook encryption is unavailable",
    );
    useWorkerSettings(undefined);
  });

  /*
   * The Trigger.dev worker once I.2b's b6 has removed `DATABASE_URL`, `PG*`
   * and `POSTGRES_*` from `prod` (ruling 214 item 3): a task's first asks,
   * with the three set and none of those names in the environment, each
   * lookup of such a name recorded with whether the configuration's parse
   * made it, as the survey's probe recorded them (track-i2.md, "I.2b b5,
   * the survey", §(c)); the modules load in that environment too. The
   * configuration is the Trigger.dev worker's shape (`server.test.ts`): no
   * `REQUESTPORT_JOB_RUNNER`, `REQUESTPORT_DATABASE_DRIVER` or `VERCEL_ENV`,
   * and no other variable ending in `DATABASE_URL` either. The three name a
   * server nothing listens on: nothing here connects.
   */
  test("in the Trigger.dev worker's shape with DATABASE_URL, PG* and POSTGRES_* absent, workerStorages() is bound and looks none up, and workerSettings() reads every member the root builds, looking up only DATABASE_URL, in the configuration's parse, which finds it absent", async () => {
    const ownerCapable = (name: string) =>
      name === "DATABASE_URL" ||
      /^PG[A-Z0-9_]*$/u.test(name) ||
      name.startsWith("POSTGRES_");
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value === undefined ||
        ownerCapable(name) ||
        name.endsWith("DATABASE_URL") ||
        name === "REQUESTPORT_DATABASE_DRIVER" ||
        Object.hasOwn(configuration, name)
      ) {
        continue;
      }
      values[name] = value;
    }
    Object.assign(values, {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: configuration.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: "https://requestport.example",
      TRIGGER_PROJECT_REF: "proj_example",
      TRIGGER_SECRET_KEY: "trigger-secret",
      REQUESTPORT_WORKSPACE_KEK: key(),
      REQUESTPORT_WEBHOOK_KEK: key(),
      ...Object.fromEntries(
        Object.entries(WORKER_DATABASE_URL_VARIABLES).map(([role, name]) => [
          name,
          `postgres://rp_${role}:${role}-password@127.0.0.1:1/requestport`,
        ]),
      ),
    });
    const lookups: { name: string; inParse: boolean }[] = [];
    const record = (key: string | symbol) => {
      if (typeof key !== "string" || !ownerCapable(key)) return;
      lookups.push({
        name: key,
        inParse: (new Error().stack ?? "").includes(
          "packages/config/src/server-schema.ts",
        ),
      });
    };
    const original = process.env;
    const stackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = Number.POSITIVE_INFINITY;
    process.env = new Proxy(values, {
      get(target, key) {
        record(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        record(key);
        return Reflect.has(target, key);
      },
    }) as NodeJS.ProcessEnv;
    let fresh: Awaited<ReturnType<typeof load>> | undefined;
    try {
      declareDatabaseSurface("worker");
      // The holder and the root, loaded afresh in this environment, as a
      // task module loads them.
      fresh = await load();
      fresh.useWorkerStorages(undefined);
      fresh.useWorkerSettings(undefined);

      const storages = fresh.workerStorages();
      opened.push(storages);

      expect(storages.bound).toBe(true);
      expect(lookups).toEqual([]);

      const settings = fresh.workerSettings();

      expect({
        environment: settings.environment,
        publicUrl: settings.publicUrl,
        productionWebhookEndpoints: settings.productionWebhookEndpoints,
        privateWebhookReceivers: settings.privateWebhookReceivers,
        workSweepFingerprintSecret: settings.secrets.workSweepFingerprintSecret,
        workspaceKeys: settings.secrets.workspaceKeys?.current.version,
        slackStateSecret: settings.secrets.slackStateSecret,
        webhookKeys: settings.secrets.webhookKeys?.current.version,
        email: settings.secrets.email,
      }).toEqual({
        environment: "production",
        publicUrl: "https://requestport.example",
        productionWebhookEndpoints: true,
        privateWebhookReceivers: false,
        workSweepFingerprintSecret: expect.stringMatching(/^[0-9a-f]{64}$/u),
        workspaceKeys: "local-v1",
        slackStateSecret: undefined,
        webhookKeys: "local-v1",
        email: undefined,
      });
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups.filter((lookup) => !lookup.inParse)).toEqual([]);
      expect([...new Set(lookups.map((lookup) => lookup.name))]).toEqual([
        "DATABASE_URL",
      ]);
    } finally {
      process.env = original;
      Error.stackTraceLimit = stackTraceLimit;
      fresh?.useWorkerStorages(undefined);
      fresh?.useWorkerSettings(undefined);
    }
  });

  // Read from the source: what each module does as it loads, which a case
  // that imports it cannot see once it has loaded. Core's import test
  // (packages/core/src/import.test.ts) holds the same modules to reading
  // nothing in a process with an empty environment.
  test("the five bodies that log build their loggers lazily under their own services, and no module the hand-over names reads the configuration itself", () => {
    const source = (file: string) =>
      readFileSync(new URL(file, import.meta.url), "utf8");
    const loggers = {
      "./jobs/import-analyze.ts": "trigger-import-analyze",
      "./jobs/import-apply.ts": "trigger-import-apply",
      "./jobs/webhook-delivery.ts": "trigger-webhook-delivery",
      "./jobs/retention-cleanup.ts": "trigger-retention",
      "./jobs/outbox-delivery.ts": "trigger-outbox-delivery",
    };
    const handedOver = [
      ...Object.keys(loggers),
      "./jobs/email-delivery.ts",
      "./jobs/question-reminders.ts",
      "./jobs/stale-sessions.ts",
      "./observability.ts",
      "./slack-encryption.ts",
      "./webhook-encryption.ts",
    ];

    for (const [file, service] of Object.entries(loggers)) {
      expect(source(file), file).toContain(
        `const logger = workerLogger("${service}");`,
      );
      expect(source(file), file).not.toMatch(/\bcreateLogger\(/u);
    }
    const environmentReads = handedOver.flatMap((file) =>
      source(file)
        .split("\n")
        .filter((line) => /process\.env|serverEnv|server-deferred/u.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(environmentReads).toEqual([]);
  });
});
