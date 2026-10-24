import type { ParsedServerEnv } from "@requestport/config/server";
import type { RequestPortLogger } from "@requestport/core";
import type { Storage } from "@requestport/db";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  canonicalEnvironment,
  generateSecrets,
  type InstanceConfiguration,
  LOGIN_KINDS,
  type LoginKind,
  parseConfiguration,
} from "../configuration.js";
import { serveInstance } from "./serve.js";

/*
 * What `requestport start`'s serving composition hands core (Plan 13, H.10):
 * the operator's REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS, as parsed, reaches
 * `createRequestPort` as `privateWebhookReceivers`, which core applies at
 * registration and verification and hands its `postgres` background's
 * worker settings, so the in-process worker's deliveries get it too
 * (`packages/core`'s `request-port.test.ts` and
 * `postgres-background.test.ts`). Everything `serveInstance` composes is a
 * stand-in here: no database, no worker and no listener; what is recorded is
 * the options core's `createRequestPort` was given.
 */

const handed = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@requestport/core", () => ({
  createRequestPort: (options: Record<string, unknown>) => {
    handed.push(options);
    return {
      start: async () => undefined,
      close: async () => undefined,
    };
  },
}));

vi.mock("@requestport/auth/create-auth", () => ({
  createAuth: () => ({ createAgentApiKey: async () => undefined }),
}));

/*
 * The worker's storages are a stand-in too, except in the cases that set
 * `realWorkerStorages.on`, which hand `@requestport/db`'s own
 * `createWorkerStorages` what `serveInstance` hands it.
 */
const realWorkerStorages = vi.hoisted(() => ({ on: false }));

vi.mock("@requestport/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@requestport/db")>();

  return {
    ...original,
    createWorkerStorages: (
      ...args: Parameters<typeof original.createWorkerStorages>
    ) =>
      realWorkerStorages.on
        ? original.createWorkerStorages(...args)
        : {
            close: async () => undefined,
            roleReports: async () => null,
          },
  };
});

vi.mock("@requestport/server", () => ({
  createRequestPortHost: () => () => undefined,
  listen: async () => ({
    url: "http://127.0.0.1:3412",
    close: async () => undefined,
  }),
}));

type ParseServerEnv = (env: Record<string, unknown>) => ParsedServerEnv;
let parseServerEnv: ParseServerEnv;

/*
 * `@requestport/config/server` parses `process.env` as it is imported; here
 * it is imported once under a configuration of its own, and its parser is
 * then asked about each canonical environment, as `configuration.test.ts`
 * does.
 */
beforeAll(async () => {
  const ambient = process.env;
  process.env = {
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "s".repeat(32),
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    DATABASE_URL: "postgres://u:p@127.0.0.1:5432/import_only",
  };
  try {
    ({ parseServerEnv } = (await import(
      "@requestport/config/server"
    )) as unknown as { parseServerEnv: ParseServerEnv });
  } finally {
    process.env = ambient;
  }
});

beforeEach(() => {
  handed.length = 0;
});

const loginUrls = Object.fromEntries(
  LOGIN_KINDS.map((kind) => [
    kind,
    `postgres://rp_instance_${kind}:password_${kind}@127.0.0.1:5432/requestport`,
  ]),
) as Record<LoginKind, string>;

function instance(storage: "pg" | "pglite"): {
  configuration: InstanceConfiguration;
  environment: Record<string, string>;
} {
  const configuration = parseConfiguration({
    version: 1,
    storage,
    publicUrl: "http://127.0.0.1:3412",
    port: 3412,
    host: "127.0.0.1",
  });
  return {
    configuration,
    environment: canonicalEnvironment({
      dataDirectory: "/requestport-serve-test",
      configuration,
      secrets: generateSecrets(storage),
      ...(storage === "pg" ? { loginUrls } : {}),
    }),
  };
}

const logger: RequestPortLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const storageStandIn = {
  db: {},
  driver: "stand-in",
  close: async () => undefined,
} as unknown as Storage;

describe("requestport start's composition", () => {
  test.each([
    ["pg", "enabled", true],
    ["pg", undefined, false],
    ["pglite", "enabled", true],
    ["pglite", undefined, false],
  ] as const)(
    "on %s, with REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS %j beside the canonical names, hands core privateWebhookReceivers %s",
    async (storage, value, admitted) => {
      const { configuration, environment } = instance(storage);
      const env = {
        ...environment,
        ...(value === undefined
          ? {}
          : { REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: value }),
      };

      const serving = await serveInstance(
        {
          configuration,
          serverEnv: parseServerEnv(env),
          env,
          logger,
        },
        () => storageStandIn,
      );
      await serving.close();

      expect(handed).toHaveLength(1);
      expect(handed[0]?.privateWebhookReceivers).toBe(admitted);
      expect(handed[0]?.environment).toBe("production");
    },
  );
});

describe("requestport start's worker guard modes (X30)", () => {
  test.each(["pg", "pglite"] as const)(
    "on %s, a leftover warn handed as workerGuardModes reaches createWorkerStorages, which refuses it, so core is never composed",
    async (storage) => {
      const { configuration, environment } = instance(storage);

      realWorkerStorages.on = true;
      try {
        await expect(
          serveInstance(
            {
              configuration,
              serverEnv: parseServerEnv(environment),
              env: environment,
              logger,
              // warn left the type with its code path (X30).
              workerGuardModes: { role: "warn" } as never,
            },
            () => storageStandIn,
          ),
        ).rejects.toThrow(
          /has no other, warn mode included: it was handed role: "warn"\.$/u,
        );
      } finally {
        realWorkerStorages.on = false;
      }
      expect(handed).toEqual([]);
    },
  );
});
