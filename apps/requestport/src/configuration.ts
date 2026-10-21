import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";

import { isBindableServer } from "@requestport/client/project";
import { z } from "zod";

import { readDataFile, writeFileAtomic } from "./atomic-file.js";

/**
 * An instance's configuration and secrets, as the data directory holds them
 * (manifest-h.md §2.3), and the canonical names they reach the code as.
 *
 * - `config.json` holds what is not secret: the storage, the public URL, the
 *   port, the bind host and the trusted proxy.
 * - `secrets.json` holds `BETTER_AUTH_SECRET`, the workspace and webhook keys
 *   and the webhook signing key, generated once, and on pg the passwords of
 *   the instance's four logins, generated before any login exists
 *   (§2.3.1, Rule 1), and their URLs, which the operator step adds once it
 *   has provisioned the logins, since only it reads the owner URL's server.
 *
 * Both are written through `writeFileAtomic`, mode 0600. What writes them, and
 * when, is the first start's (§2.3.1); this module reads, checks and writes.
 */

export const CONFIG_FILE = "config.json";
export const SECRETS_FILE = "secrets.json";

/** The PGlite database's directory, inside the data directory. */
export const PGLITE_DATABASE_DIRECTORY = "pglite";

export type StorageKind = "pg" | "pglite";

/**
 * The instance's four logins on pg, keyed as `WORKER_DATABASE_URL_VARIABLES`
 * in `@requestport/db` keys the worker's three, with the application's beside
 * them.
 */
export const LOGIN_KINDS = Object.freeze([
  "application",
  "dispatcher",
  "processor",
  "maintenance",
] as const);

export type LoginKind = (typeof LOGIN_KINDS)[number];

/**
 * The variable each login's URL is written to. The worker's three are
 * `@requestport/db`'s `WORKER_DATABASE_URL_VARIABLES`, and the application's
 * is its `APPLICATION_DATABASE_URL_VARIABLE`. Written out here, so that this
 * module does not load `@requestport/db`: a start writes these names before
 * it imports what reads them (manifest-h.md §2.3). `configuration.test.ts`
 * holds the worker's three to that constant, and the application's to the
 * URL `applicationStorageOptionsFromEnv` (`@requestport/db/wiring`), the
 * application root's options, connects through.
 */
export const LOGIN_URL_VARIABLES: Readonly<Record<LoginKind, string>> =
  Object.freeze({
    application: "REQUESTPORT_APPLICATION_DATABASE_URL",
    dispatcher: "REQUESTPORT_DISPATCHER_DATABASE_URL",
    processor: "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
    maintenance: "REQUESTPORT_MAINTENANCE_DATABASE_URL",
  });

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** A bind host on this machine alone: `localhost`, 127.0.0.0/8 or `::1`. */
export function isLoopbackBindHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

/** What a public URL must be, as `config.json`'s refusal and `requestport start`'s say it. */
export const PUBLIC_URL_RULE =
  "must be https, or http on a loopback host, and an origin: no user name, password, path, query or fragment";

/**
 * Whether `value` is a public URL `config.json` may record (`publicUrl`
 * below): the client's rule for a server it may bind to.
 */
export function isRecordablePublicUrl(value: string): boolean {
  return isBindableServer(value);
}

const ConfigurationSchema = z
  .object({
    version: z.literal(1),
    storage: z.enum(["pg", "pglite"]),
    /*
      The issuer and the agent resources' origin. `isRecordablePublicUrl` is
      `isBindableServer`, the client's rule for a server it may bind to,
      which `requestport start` also holds `--public-url` to: the issuer's rule
      (`isServableIssuerUrl` in @requestport/auth, held to the same fixture,
      `packages/client/src/origin-rule.cases.json`) and no path, because the
      agent resources are this origin plus `/mcp` and `/api/v1`
      (manifest-h.md §2.8.1). Stored as its origin, with no trailing slash, as
      `BETTER_AUTH_URL` is written.
    */
    publicUrl: z
      .string()
      .refine(isRecordablePublicUrl, { message: PUBLIC_URL_RULE })
      // Zod runs a transform only on a value its checks passed.
      .transform((value) => new URL(value).origin),
    port: z.number().int().min(1).max(65_535),
    host: z.string().min(1),
    trustedProxy: z
      .string()
      .refine((value) => isIP(value) !== 0, {
        message: "must be an IP address",
      })
      .optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    // PGlite has no row security, so it serves one user on this machine
    // alone (manifest-h.md §2.6, item 5).
    if (
      configuration.storage === "pglite" &&
      !isLoopbackBindHost(configuration.host)
    ) {
      context.addIssue({
        code: "custom",
        path: ["host"],
        message:
          "must be a loopback address with PGlite (localhost, 127.0.0.0/8 or ::1)",
      });
    }
  });

export type InstanceConfiguration = z.output<typeof ConfigurationSchema>;
export type InstanceConfigurationInput = z.input<typeof ConfigurationSchema>;

/** 32 random bytes, base64url: 43 characters, with no character a URL must escape. */
const SECRET_BYTES = 32;

/**
 * A key as the bodies decode it: base64url of exactly 32 bytes
 * (`decodeBase64Key` in @requestport/domain), so at least the schema's 43
 * characters (`server-schema.ts` in @requestport/config).
 */
const key = z
  .string()
  .min(43)
  .refine(
    (value) => Buffer.from(value, "base64url").byteLength === SECRET_BYTES,
    { message: "must be base64url of exactly 32 bytes" },
  );

/** A login's password: URL-safe, so a login's URL needs no escaping. */
const password = z.string().regex(/^[A-Za-z0-9_-]{43,}$/u, {
  message: "must be 43 or more of A-Z, a-z, 0-9, _ and -",
});

/** A login's URL, as the operator step composes it from the owner URL's server. */
const loginUrl = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
        url.username !== "" &&
        url.password !== ""
      );
    } catch {
      return false;
    }
  },
  { message: "must be a postgres: URL with a user and a password" },
);

const SecretsSchema = z
  .object({
    version: z.literal(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    REQUESTPORT_WORKSPACE_KEK: key,
    REQUESTPORT_WEBHOOK_KEK: key,
    REQUESTPORT_WEBHOOK_SIGNING_KEY: key,
    loginPasswords: z
      .object({
        application: password,
        dispatcher: password,
        processor: password,
        maintenance: password,
      })
      .strict()
      .optional(),
    loginUrls: z
      .object({
        application: loginUrl,
        dispatcher: loginUrl,
        processor: loginUrl,
        maintenance: loginUrl,
      })
      .strict()
      .optional(),
  })
  .strict();

export type InstanceSecrets = z.output<typeof SecretsSchema>;

function describeIssues(file: string, error: z.ZodError): string {
  // The paths and the rules, never a value: this file holds secrets.
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
    .join("; ");
  return `${file}: ${issues}.`;
}

/** Checks a configuration, and answers it with its public URL as an origin. */
export function parseConfiguration(
  value: unknown,
  file = CONFIG_FILE,
): InstanceConfiguration {
  const result = ConfigurationSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigurationError(describeIssues(file, result.error));
  }
  return result.data;
}

/** Checks secrets against the storage: pg needs the four passwords, PGlite has no logins. */
export function parseSecrets(
  value: unknown,
  storage: StorageKind,
  file = SECRETS_FILE,
): InstanceSecrets {
  const result = SecretsSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigurationError(describeIssues(file, result.error));
  }
  if (storage === "pg" && result.data.loginPasswords === undefined) {
    throw new ConfigurationError(`${file}: loginPasswords is required on pg.`);
  }
  if (
    storage === "pglite" &&
    (result.data.loginPasswords !== undefined ||
      result.data.loginUrls !== undefined)
  ) {
    throw new ConfigurationError(
      `${file}: loginPasswords and loginUrls are not allowed with PGlite, which has no logins.`,
    );
  }
  return result.data;
}

/**
 * Every secret an instance needs, generated at once: `BETTER_AUTH_SECRET`
 * and each key 32 random bytes as base64url (43 characters: the schema asks
 * at least 32 of the first and 43 of each key), and on pg one password per
 * login, the same size.
 */
export function generateSecrets(
  storage: StorageKind,
  random: (size: number) => Buffer = randomBytes,
): InstanceSecrets {
  const secret = () => random(SECRET_BYTES).toString("base64url");
  return parseSecrets(
    {
      version: 1,
      BETTER_AUTH_SECRET: secret(),
      REQUESTPORT_WORKSPACE_KEK: secret(),
      REQUESTPORT_WEBHOOK_KEK: secret(),
      REQUESTPORT_WEBHOOK_SIGNING_KEY: secret(),
      ...(storage === "pg"
        ? {
            loginPasswords: Object.fromEntries(
              LOGIN_KINDS.map((kind) => [kind, secret()]),
            ),
          }
        : {}),
    },
    storage,
  );
}

function readJson(directory: string, file: string): unknown {
  const text = readDataFile(directory, file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigurationError(`${join(directory, file)} is not valid JSON.`);
  }
}

const serialise = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The data directory's `config.json`, or `undefined` before one is written. */
export function readConfiguration(
  directory: string,
): InstanceConfiguration | undefined {
  const value = readJson(directory, CONFIG_FILE);
  return value === undefined
    ? undefined
    : parseConfiguration(value, join(directory, CONFIG_FILE));
}

export function writeConfiguration(
  directory: string,
  configuration: InstanceConfigurationInput,
): InstanceConfiguration {
  const checked = parseConfiguration(configuration);
  writeFileAtomic(directory, CONFIG_FILE, serialise(checked));
  return checked;
}

/** The data directory's `secrets.json`, or `undefined` before one is written. */
export function readSecrets(
  directory: string,
  storage: StorageKind,
): InstanceSecrets | undefined {
  const value = readJson(directory, SECRETS_FILE);
  return value === undefined
    ? undefined
    : parseSecrets(value, storage, join(directory, SECRETS_FILE));
}

export function writeSecrets(
  directory: string,
  secrets: InstanceSecrets,
  storage: StorageKind,
): void {
  writeFileAtomic(
    directory,
    SECRETS_FILE,
    serialise(parseSecrets(secrets, storage)),
  );
}

export interface CanonicalEnvironmentInput {
  dataDirectory: string;
  configuration: InstanceConfiguration;
  secrets: InstanceSecrets;
  /** On pg, the URL of each of the instance's logins; with PGlite, none. */
  loginUrls?: Readonly<Record<LoginKind, string>>;
}

/**
 * The configuration as the names the code reads today (manifest-h.md §2.3):
 * `@requestport/config` and `@requestport/auth` parse `process.env` as they
 * are imported, and the worker storages read their driver and URLs from it.
 * The owner's URL is never among them (§2.4).
 */
export function canonicalEnvironment({
  dataDirectory,
  configuration,
  secrets,
  loginUrls,
}: CanonicalEnvironmentInput): Record<string, string> {
  const environment: Record<string, string> = {
    NODE_ENV: "production",
    BETTER_AUTH_URL: configuration.publicUrl,
    NEXT_PUBLIC_APP_URL: configuration.publicUrl,
    BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
    REQUESTPORT_WORKSPACE_KEK: secrets.REQUESTPORT_WORKSPACE_KEK,
    REQUESTPORT_WEBHOOK_KEK: secrets.REQUESTPORT_WEBHOOK_KEK,
    REQUESTPORT_WEBHOOK_SIGNING_KEY: secrets.REQUESTPORT_WEBHOOK_SIGNING_KEY,
    REQUESTPORT_JOB_RUNNER: "postgres",
    REQUESTPORT_DATABASE_DRIVER: configuration.storage,
  };
  if (configuration.storage === "pglite") {
    if (loginUrls !== undefined) {
      throw new ConfigurationError(
        "PGlite has no logins, so no login URL is written.",
      );
    }
    environment.REQUESTPORT_PGLITE_DATA_DIR = join(
      dataDirectory,
      PGLITE_DATABASE_DIRECTORY,
    );
    return environment;
  }
  if (loginUrls === undefined) {
    throw new ConfigurationError(
      "On pg the serving process connects as the instance's four logins, so their URLs are required.",
    );
  }
  for (const kind of LOGIN_KINDS) {
    environment[LOGIN_URL_VARIABLES[kind]] = loginUrls[kind];
  }
  return environment;
}

/** Writes each canonical name into `target`, which a start passes as `process.env`. */
export function writeCanonicalEnvironment(
  target: NodeJS.ProcessEnv,
  environment: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    target[name] = value;
  }
}
