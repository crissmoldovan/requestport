import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { WORKER_DATABASE_URL_VARIABLES } from "@requestport/db";
import {
  applicationStorageOptionsFromEnv,
  storageOptionsFromEnv,
} from "@requestport/db/wiring";
import { decodeBase64Key } from "@requestport/domain";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  CONFIG_FILE,
  ConfigurationError,
  canonicalEnvironment,
  generateSecrets,
  type InstanceConfiguration,
  LOGIN_KINDS,
  LOGIN_URL_VARIABLES,
  type LoginKind,
  PGLITE_DATABASE_DIRECTORY,
  parseConfiguration,
  parseSecrets,
  readConfiguration,
  readSecrets,
  SECRETS_FILE,
  writeCanonicalEnvironment,
  writeConfiguration,
  writeSecrets,
} from "./configuration.js";

type ParseServerEnv = (env: Record<string, unknown>) => unknown;
let parseServerEnv: ParseServerEnv;

/*
 * `@requestport/config/server` parses `process.env` as it is imported, which
 * is what a serving process relies on; here it is imported once under a
 * configuration of its own, and its parser is then asked about each
 * canonical environment.
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
    ({ parseServerEnv } = await import("@requestport/config/server"));
  } finally {
    process.env = ambient;
  }
});

const directories: string[] = [];

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "requestport-config-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const pgConfiguration: InstanceConfiguration = parseConfiguration({
  version: 1,
  storage: "pg",
  publicUrl: "http://127.0.0.1:3412/",
  port: 3412,
  host: "127.0.0.1",
});

const pgliteConfiguration: InstanceConfiguration = parseConfiguration({
  version: 1,
  storage: "pglite",
  publicUrl: "http://127.0.0.1:3412",
  port: 3412,
  host: "127.0.0.1",
});

const loginUrls = Object.fromEntries(
  LOGIN_KINDS.map((kind) => [
    kind,
    `postgres://rp_instance_${kind}:password_${kind}@127.0.0.1:5432/requestport`,
  ]),
) as Record<LoginKind, string>;

describe("secrets, generated once", () => {
  test("each at or above the schema's minimum, each key 32 bytes as the bodies decode it, and on pg one URL-safe password per login", () => {
    const secrets = generateSecrets("pg");

    expect(secrets.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
    for (const name of [
      "REQUESTPORT_WORKSPACE_KEK",
      "REQUESTPORT_WEBHOOK_KEK",
      "REQUESTPORT_WEBHOOK_SIGNING_KEY",
    ] as const) {
      expect(secrets[name].length).toBeGreaterThanOrEqual(43);
      expect(decodeBase64Key(secrets[name]).byteLength).toBe(32);
    }
    expect(Object.keys(secrets.loginPasswords ?? {})).toEqual([...LOGIN_KINDS]);
    for (const password of Object.values(secrets.loginPasswords ?? {})) {
      expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
    const values = [
      secrets.BETTER_AUTH_SECRET,
      secrets.REQUESTPORT_WORKSPACE_KEK,
      secrets.REQUESTPORT_WEBHOOK_KEK,
      secrets.REQUESTPORT_WEBHOOK_SIGNING_KEY,
      ...Object.values(secrets.loginPasswords ?? {}),
    ];
    expect(new Set(values).size).toBe(8);
  });

  test("with PGlite, no login and so no password", () => {
    expect(generateSecrets("pglite").loginPasswords).toBeUndefined();
  });

  test("a short key, a missing or stray password list, or an unknown name is refused, and no value is repeated", () => {
    const secrets = generateSecrets("pg");
    const short = secrets.REQUESTPORT_WEBHOOK_KEK.slice(0, 42);

    const refusal = (value: unknown, storage: "pg" | "pglite") => {
      try {
        parseSecrets(value, storage);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        return (error as Error).message;
      }
      throw new Error("not refused");
    };

    const shortMessage = refusal(
      { ...secrets, REQUESTPORT_WEBHOOK_KEK: short },
      "pg",
    );
    expect(shortMessage).toMatch(/^secrets\.json: REQUESTPORT_WEBHOOK_KEK /u);
    expect(shortMessage).not.toContain(short);
    expect(refusal({ ...secrets, loginPasswords: undefined }, "pg")).toBe(
      "secrets.json: loginPasswords is required on pg.",
    );
    expect(refusal(secrets, "pglite")).toBe(
      "secrets.json: loginPasswords and loginUrls are not allowed with PGlite, which has no logins.",
    );
    expect(refusal({ ...secrets, DATABASE_URL: "postgres://x" }, "pg")).toMatch(
      /DATABASE_URL/u,
    );
  });

  test("measures BETTER_AUTH_SECRET in UTF-16 code units, as zod 4.4.3 did: sixteen emoji are its 32", () => {
    const secrets = {
      ...generateSecrets("pglite"),
      BETTER_AUTH_SECRET: "\u{1F600}".repeat(16),
    };

    expect(parseSecrets(secrets, "pglite").BETTER_AUTH_SECRET).toBe(
      "\u{1F600}".repeat(16),
    );
  });

  test("holds the four login URLs the operator step adds, each a postgres: URL with its credentials, and only on pg", () => {
    const secrets = generateSecrets("pg");
    const passwords = secrets.loginPasswords as Record<string, string>;
    const loginUrls = Object.fromEntries(
      Object.entries(passwords).map(([kind, password]) => [
        kind,
        `postgres://rp_0123456789abcdef_${kind}:${password}@127.0.0.1:5432/requestport`,
      ]),
    );

    expect(parseSecrets({ ...secrets, loginUrls }, "pg").loginUrls).toEqual(
      loginUrls,
    );
    for (const broken of [
      "http://u:p@127.0.0.1/requestport",
      "postgres://127.0.0.1/requestport",
      "not a url",
    ]) {
      expect(() =>
        parseSecrets(
          { ...secrets, loginUrls: { ...loginUrls, maintenance: broken } },
          "pg",
        ),
      ).toThrow(
        /^secrets\.json: loginUrls\.maintenance must be a postgres: URL/u,
      );
    }
    expect(() =>
      parseSecrets({ ...generateSecrets("pglite"), loginUrls }, "pglite"),
    ).toThrow(/not allowed with PGlite/u);
  });
});

describe("config.json", () => {
  const cases = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../packages/client/src/origin-rule.cases.json",
      ),
      "utf8",
    ),
  ) as { cases: { url: string; accepted: boolean }[] };

  test("holds the public URL to the client's rule for a server, path refused, and stores it as its origin", () => {
    expect(cases.cases.length).toBeGreaterThan(0);
    for (const row of cases.cases) {
      const configuration = { ...pgConfiguration, publicUrl: row.url };
      if (row.accepted) {
        expect(parseConfiguration(configuration).publicUrl).toBe(
          new URL(row.url).origin,
        );
      } else {
        expect(() => parseConfiguration(configuration), row.url).toThrowError(
          ConfigurationError,
        );
      }
    }
    expect(pgConfiguration.publicUrl).toBe("http://127.0.0.1:3412");
    expect(() =>
      parseConfiguration({
        ...pgConfiguration,
        publicUrl: "https://rp.example.com/app",
      }),
    ).toThrowError(
      /^config\.json: publicUrl must be https, or http on a loopback host/u,
    );
  });

  test("a refusal does not repeat a public URL's password", () => {
    try {
      parseConfiguration({
        ...pgConfiguration,
        publicUrl: "https://owner:SENTINEL_PASSWORD@rp.example.com",
      });
      throw new Error("not refused");
    } catch (error) {
      expect((error as Error).message).not.toContain("SENTINEL_PASSWORD");
    }
  });

  test("binds PGlite to a loopback host only", () => {
    for (const host of ["127.0.0.1", "127.8.9.10", "::1", "localhost"]) {
      expect(parseConfiguration({ ...pgliteConfiguration, host }).host).toBe(
        host,
      );
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.4", "rp.example.com"]) {
      expect(() =>
        parseConfiguration({ ...pgliteConfiguration, host }),
      ).toThrowError(
        "config.json: host must be a loopback address with PGlite (localhost, 127.0.0.0/8 or ::1).",
      );
      expect(parseConfiguration({ ...pgConfiguration, host }).host).toBe(host);
    }
  });

  test("refuses a trusted proxy that is not an address, a port out of range, and an unknown name", () => {
    expect(() =>
      parseConfiguration({ ...pgConfiguration, trustedProxy: "proxy.local" }),
    ).toThrowError("config.json: trustedProxy must be an IP address.");
    expect(
      parseConfiguration({ ...pgConfiguration, trustedProxy: "10.0.0.2" })
        .trustedProxy,
    ).toBe("10.0.0.2");
    expect(() =>
      parseConfiguration({ ...pgConfiguration, port: 0 }),
    ).toThrowError(/port/u);
    expect(() =>
      parseConfiguration({ ...pgConfiguration, port: 65_536 }),
    ).toThrowError(/port/u);
    expect(() =>
      parseConfiguration({ ...pgConfiguration, ownerUrl: "x" }),
    ).toThrowError(/ownerUrl/u);
  });
});

describe("the files", () => {
  test("are written atomically, mode 0600, and read back as written", () => {
    const directory = dataDirectory();
    const secrets = generateSecrets("pg");

    expect(readConfiguration(directory)).toBeUndefined();
    expect(readSecrets(directory, "pg")).toBeUndefined();

    writeConfiguration(directory, {
      ...pgConfiguration,
      publicUrl: "http://127.0.0.1:3412/",
    });
    writeSecrets(directory, secrets, "pg");

    for (const file of [CONFIG_FILE, SECRETS_FILE]) {
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    }
    expect(readConfiguration(directory)).toEqual(pgConfiguration);
    expect(readSecrets(directory, "pg")).toEqual(secrets);
  });

  test("a file that is not JSON is refused by name, its text not repeated", () => {
    const directory = dataDirectory();
    writeFileSync(
      join(directory, SECRETS_FILE),
      "BETTER_AUTH_SECRET=SENTINEL",
      {
        mode: 0o600,
      },
    );

    expect(() => readSecrets(directory, "pg")).toThrowError(
      new ConfigurationError(
        `${join(directory, SECRETS_FILE)} is not valid JSON.`,
      ),
    );
  });

  test("secrets read for the other storage are refused", () => {
    const directory = dataDirectory();
    writeSecrets(directory, generateSecrets("pglite"), "pglite");

    expect(() => readSecrets(directory, "pg")).toThrowError(
      /loginPasswords is required on pg/u,
    );
  });
});

describe("the canonical names", () => {
  test("with PGlite: the names the code reads, its database inside the data directory, and no database URL", () => {
    const directory = dataDirectory();
    const secrets = generateSecrets("pglite");

    const environment = canonicalEnvironment({
      dataDirectory: directory,
      configuration: pgliteConfiguration,
      secrets,
    });

    expect(environment).toEqual({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "http://127.0.0.1:3412",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3412",
      BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
      REQUESTPORT_WORKSPACE_KEK: secrets.REQUESTPORT_WORKSPACE_KEK,
      REQUESTPORT_WEBHOOK_KEK: secrets.REQUESTPORT_WEBHOOK_KEK,
      REQUESTPORT_WEBHOOK_SIGNING_KEY: secrets.REQUESTPORT_WEBHOOK_SIGNING_KEY,
      REQUESTPORT_JOB_RUNNER: "postgres",
      REQUESTPORT_DATABASE_DRIVER: "pglite",
      REQUESTPORT_PGLITE_DATA_DIR: join(directory, PGLITE_DATABASE_DIRECTORY),
    });
    expect(storageOptionsFromEnv(environment)).toEqual({
      driver: "pglite",
      dataDir: join(directory, PGLITE_DATABASE_DIRECTORY),
    });
    expect(() => parseServerEnv(environment)).not.toThrow();
  });

  test("on pg: the four login URLs under the names the storages read, and no DATABASE_URL", () => {
    const secrets = generateSecrets("pg");

    const environment = canonicalEnvironment({
      dataDirectory: dataDirectory(),
      configuration: pgConfiguration,
      secrets,
      loginUrls,
    });

    expect(environment.REQUESTPORT_DATABASE_DRIVER).toBe("pg");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("REQUESTPORT_PGLITE_DATA_DIR");
    expect(
      Object.fromEntries(
        Object.entries(WORKER_DATABASE_URL_VARIABLES).map(([kind, name]) => [
          kind,
          environment[name],
        ]),
      ),
    ).toEqual({
      dispatcher: loginUrls.dispatcher,
      processor: loginUrls.processor,
      maintenance: loginUrls.maintenance,
    });
    expect(LOGIN_URL_VARIABLES).toMatchObject(WORKER_DATABASE_URL_VARIABLES);
    // The application root's options (`rootStorageFromEnv("application")`)
    // dial the application login. The owner's, `storageOptionsFromEnv`'s,
    // find no DATABASE_URL here, and refuse.
    const options = applicationStorageOptionsFromEnv(environment);
    expect(options.driver).toBe("pg");
    expect(
      typeof options.connectionString === "function"
        ? options.connectionString()
        : options.connectionString,
    ).toBe(loginUrls.application);
    const owner = storageOptionsFromEnv(environment);
    expect(() =>
      typeof owner.connectionString === "function"
        ? owner.connectionString()
        : owner.connectionString,
    ).toThrow("RequestPort database configuration is invalid.");
    expect(() => parseServerEnv(environment)).not.toThrow();
  });

  test("an operator's REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS=enabled beside the canonical names parses as enabled, on either storage, because they name the postgres job runner; without that runner it is refused (Plan 13, H.10)", () => {
    for (const environment of [
      canonicalEnvironment({
        dataDirectory: dataDirectory(),
        configuration: pgliteConfiguration,
        secrets: generateSecrets("pglite"),
      }),
      canonicalEnvironment({
        dataDirectory: dataDirectory(),
        configuration: pgConfiguration,
        secrets: generateSecrets("pg"),
        loginUrls,
      }),
    ]) {
      const operator = {
        ...environment,
        REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "enabled",
      };

      expect(environment.REQUESTPORT_JOB_RUNNER).toBe("postgres");
      expect(
        (parseServerEnv(operator) as Record<string, unknown>)
          .REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS,
      ).toBe("enabled");
      expect(() =>
        parseServerEnv({ ...operator, REQUESTPORT_JOB_RUNNER: undefined }),
      ).toThrow(
        /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused unless REQUESTPORT_JOB_RUNNER is postgres/,
      );
    }
  });

  test("on pg the login URLs are required, and with PGlite refused", () => {
    expect(() =>
      canonicalEnvironment({
        dataDirectory: "/x",
        configuration: pgConfiguration,
        secrets: generateSecrets("pg"),
      }),
    ).toThrowError(ConfigurationError);
    expect(() =>
      canonicalEnvironment({
        dataDirectory: "/x",
        configuration: pgliteConfiguration,
        secrets: generateSecrets("pglite"),
        loginUrls,
      }),
    ).toThrowError(ConfigurationError);
  });

  test("are written into the environment given, over what it held, and nothing else of it changes", () => {
    const target: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      HOME: "/home/ada",
    };
    const environment = canonicalEnvironment({
      dataDirectory: "/data",
      configuration: pgliteConfiguration,
      secrets: generateSecrets("pglite"),
    });

    writeCanonicalEnvironment(target, environment);

    expect(target).toEqual({ ...environment, HOME: "/home/ada" });
  });
});
