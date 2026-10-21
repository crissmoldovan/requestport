import { z } from "zod";

/**
 * The same shape `readDatabaseUrl` enforces before it opens a connection.
 *
 * `z.string().url()` accepts `mysql://host/db` and `postgres://host` with no
 * database named, and `@requestport/db` refuses both. While the pool read its
 * connection string as it was constructed, that refusal happened at import and
 * the application could not boot on a malformed value. The read moved into the
 * connection, so without this the application boots and fails per query — a
 * half-rendered page carrying a configuration error instead of a refusal.
 *
 * Duplicated rather than imported: this package cannot depend on the one that
 * owns the connection. `packages/db/src/database-url.ts` is the other copy and
 * a test holds them to the same answers.
 */
export function isPostgresDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.length > 0 &&
      url.pathname.startsWith("/") &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

const sharedServerEnvShape = {
  NODE_ENV: z.enum(["development", "test", "production"]),
  BETTER_AUTH_SECRET: z.string().min(32),
  // Whether this can be the OAuth issuer is checked where Better Auth is
  // composed (`createAuthOptions` in @requestport/auth), not here: the Trigger
  // worker parses this and never composes Better Auth.
  BETTER_AUTH_URL: z.string().url(),
  REQUESTPORT_LOCAL_CREDENTIAL: z.enum(["enabled", "disabled"]).optional(),
  /*
    Plan 13, F.3 (F3-14): operator credentials are issued and used only when
    this is `enabled`, the migration's table exists, and the deployment's
    Better Auth composition closes `/change-password`. Unset means off.
  */
  REQUESTPORT_OPERATOR_CREDENTIALS: z.enum(["enabled", "disabled"]).optional(),
  /*
    Plan 13, H.10 (rulings 175 and 176): the operator's opt-in for private and
    loopback webhook receivers, which `@requestport/webhooks`' endpoint
    policy takes as `privateReceivers`. Exactly `enabled` or unset: any other
    value, empty included, refuses to boot. Refused wherever `VERCEL_ENV` is
    set, and unless `REQUESTPORT_JOB_RUNNER` is `postgres`
    (`assertPrivateWebhookReceiversSelfHosted`, below).
  */
  REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: z.literal("enabled").optional(),
  REQUESTPORT_WORKSPACE_KEK: z.string().min(43).optional(),
  REQUESTPORT_WORKSPACE_KEK_VERSION: z
    .string()
    .min(1)
    .max(64)
    .default("local-v1"),
  REQUESTPORT_WORKSPACE_KEK_PREVIOUS: z.string().min(43).optional(),
  REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: z
    .string()
    .min(1)
    .max(64)
    .optional(),
  REQUESTPORT_WEBHOOK_KEK: z.string().min(43).optional(),
  REQUESTPORT_WEBHOOK_KEK_VERSION: z
    .string()
    .min(1)
    .max(64)
    .default("local-v1"),
  REQUESTPORT_WEBHOOK_KEK_PREVIOUS: z.string().min(43).optional(),
  REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION: z
    .string()
    .min(1)
    .max(64)
    .optional(),
  REQUESTPORT_WEBHOOK_SIGNING_KEY: z.string().min(43).optional(),
  REQUESTPORT_SLACK_SIGNING_SECRET: z.string().min(16).optional(),
  REQUESTPORT_SLACK_CLIENT_ID: z.string().min(1).optional(),
  REQUESTPORT_SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  REQUESTPORT_SLACK_STATE_SECRET: z.string().min(32).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(16).optional(),
  TRIGGER_SECRET_KEY: z.string().min(1).optional(),
  TRIGGER_PROJECT_REF: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // The MCP route's 2026-07-28 leg. A plain string on purpose: the route
  // judges it (only "enabled" turns the leg on). The Trigger worker parses
  // this schema and never serves MCP, so a stray value here must not make its
  // parse throw.
  REQUESTPORT_MCP_MODERN: z.string().optional(),
  // Client ID Metadata Documents. Plain strings on purpose: `createAuthOptions`
  // in @requestport/auth judges them (only "enabled" turns CIMD on, and then
  // the origin list must be valid or the composition throws). The Trigger
  // worker parses this schema and never composes Better Auth, so a stray value
  // here must not make its parse throw.
  REQUESTPORT_OAUTH_CIMD: z.string().optional(),
  REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS: z.string().optional(),
};

const canonicalProviderEnvShape = {
  // Required, unless something stands for it (`databaseUrlStandIn`, below):
  // a PGlite storage, the application login's URL, or the worker's three
  // logins' URLs.
  DATABASE_URL: z.string().url().refine(isPostgresDatabaseUrl, {
    message: "must be a postgres URL naming a database",
  }),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
};

/**
 * The two external sign-in methods, each a pair that is complete or absent.
 *
 * These replaced one gate over all four values, which either enabled GitHub
 * and the magic link together or neither — and with neither, dropped the
 * signup policy and the grant repair from the composition as well.
 */
const signInMethodPairs = [
  ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
] as const;

function validateSignInMethodPairs(
  env: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
  prefix: "" | "REQUESTPORT_PREVIEW_",
) {
  for (const pair of signInMethodPairs) {
    const fields = pair.map((field) => `${prefix}${field}`);
    const configured = fields.filter((field) => Boolean(env[field]));
    if (configured.length === 0 || configured.length === fields.length) {
      continue;
    }
    for (const field of fields) {
      if (env[field]) continue;
      context.addIssue({
        code: "custom",
        message: `${field} is missing: a sign-in method must be configured completely or not at all`,
        path: [field],
      });
    }
  }
}

function validateServerConfiguration(
  env: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
) {
  for (const rotation of [
    {
      currentKey: env.REQUESTPORT_WORKSPACE_KEK,
      currentVersion: env.REQUESTPORT_WORKSPACE_KEK_VERSION,
      previousKey: env.REQUESTPORT_WORKSPACE_KEK_PREVIOUS,
      previousVersion: env.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION,
      previousKeyField: "REQUESTPORT_WORKSPACE_KEK_PREVIOUS",
      previousVersionField: "REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION",
    },
    {
      currentKey:
        env.REQUESTPORT_WEBHOOK_KEK ?? env.REQUESTPORT_WEBHOOK_SIGNING_KEY,
      currentVersion: env.REQUESTPORT_WEBHOOK_KEK_VERSION,
      previousKey: env.REQUESTPORT_WEBHOOK_KEK_PREVIOUS,
      previousVersion: env.REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION,
      previousKeyField: "REQUESTPORT_WEBHOOK_KEK_PREVIOUS",
      previousVersionField: "REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION",
    },
  ] as const) {
    if (Boolean(rotation.previousKey) !== Boolean(rotation.previousVersion)) {
      context.addIssue({
        code: "custom",
        message: "Previous encryption keys require a matching version",
        path: [
          rotation.previousKey
            ? rotation.previousVersionField
            : rotation.previousKeyField,
        ],
      });
    }
    if (rotation.previousKey && !rotation.currentKey) {
      context.addIssue({
        code: "custom",
        message: "A previous encryption key requires an active key",
        path: [rotation.previousKeyField],
      });
    }
    if (
      rotation.previousVersion &&
      rotation.previousVersion === rotation.currentVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "Active and previous encryption key versions must differ",
        path: [rotation.previousVersionField],
      });
    }
  }

  for (const group of [
    [
      "REQUESTPORT_SLACK_SIGNING_SECRET",
      "REQUESTPORT_SLACK_CLIENT_ID",
      "REQUESTPORT_SLACK_CLIENT_SECRET",
      "REQUESTPORT_SLACK_STATE_SECRET",
    ],
    ["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"],
  ] as const) {
    const configured = group.filter((field) => Boolean(env[field]));
    if (configured.length > 0 && configured.length !== group.length) {
      for (const field of group) {
        if (env[field]) continue;
        context.addIssue({
          code: "custom",
          message: "Optional integration configuration must be complete",
          path: [field],
        });
      }
    }
  }
}

function serverEnvironmentSchema<
  T extends z.ZodRawShape & typeof sharedServerEnvShape,
>(shape: T, signInPrefix: "" | "REQUESTPORT_PREVIEW_" = "") {
  return z.object(shape).superRefine((env, context) => {
    validateServerConfiguration(env, context);
    validateSignInMethodPairs(env, context, signInPrefix);
  });
}

export const ServerEnvSchema = serverEnvironmentSchema({
  ...sharedServerEnvShape,
  ...canonicalProviderEnvShape,
});

/*
  Named here as `@requestport/db` names them (`DATABASE_DRIVER_VARIABLE` in
  `client.ts`, `APPLICATION_DATABASE_URL_VARIABLE` in `database-url.ts`,
  `WORKER_DATABASE_URL_VARIABLES` in `tenant-context.ts`): this package
  cannot import that one. `server.test.ts` holds the worker's three to that
  file's spelling.
*/
const DATABASE_DRIVER_VARIABLE = "REQUESTPORT_DATABASE_DRIVER";
const APPLICATION_DATABASE_URL_VARIABLE =
  "REQUESTPORT_APPLICATION_DATABASE_URL";
const WORKER_DATABASE_URL_VARIABLES = [
  "REQUESTPORT_DISPATCHER_DATABASE_URL",
  "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
  "REQUESTPORT_MAINTENANCE_DATABASE_URL",
] as const;

/**
 * The same configuration with nothing in `DATABASE_URL`, for a PGlite
 * storage, which has no connection string: its database is a directory,
 * `REQUESTPORT_PGLITE_DATA_DIR`, which `storageOptionsFromEnv` in
 * `@requestport/db` reads and requires.
 */
const PgliteServerEnvSchema = serverEnvironmentSchema({
  ...sharedServerEnvShape,
  ...canonicalProviderEnvShape,
  DATABASE_URL: canonicalProviderEnvShape.DATABASE_URL.optional(),
});

/**
 * The same configuration with the application login's URL standing where
 * `DATABASE_URL` is absent. It is held to `DATABASE_URL`'s rule, because it
 * is the string the application then dials (`readApplicationDatabaseUrl` in
 * `@requestport/db`), and dropped from the result, which keeps the shape
 * every reader of `serverEnv` already has: no reader takes a connection
 * string from it.
 */
const ApplicationLoginServerEnvSchema = serverEnvironmentSchema({
  ...sharedServerEnvShape,
  ...canonicalProviderEnvShape,
  DATABASE_URL: canonicalProviderEnvShape.DATABASE_URL.optional(),
  [APPLICATION_DATABASE_URL_VARIABLE]: canonicalProviderEnvShape.DATABASE_URL,
}).transform(
  ({ [APPLICATION_DATABASE_URL_VARIABLE]: _applicationUrl, ...env }) => env,
);

/** Each of the worker's three URLs, under `DATABASE_URL`'s rule. */
const workerDatabaseUrlShape = {
  REQUESTPORT_DISPATCHER_DATABASE_URL: canonicalProviderEnvShape.DATABASE_URL,
  REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL:
    canonicalProviderEnvShape.DATABASE_URL,
  REQUESTPORT_MAINTENANCE_DATABASE_URL: canonicalProviderEnvShape.DATABASE_URL,
} satisfies Record<(typeof WORKER_DATABASE_URL_VARIABLES)[number], unknown>;

/**
 * The same configuration with the worker's three logins' URLs standing where
 * `DATABASE_URL` is absent (Plan 13, I.2b's b5; ruling 214 item 3). Each is
 * held to `DATABASE_URL`'s rule, because each is a string the worker then
 * dials (`createWorkerStorages` in `@requestport/db`, which holds them to its
 * own copy of that rule as well), and all three are dropped from the result,
 * which keeps the shape every reader of `serverEnv` already has: no reader
 * takes a connection string from it.
 */
const WorkerLoginsServerEnvSchema = serverEnvironmentSchema({
  ...sharedServerEnvShape,
  ...canonicalProviderEnvShape,
  DATABASE_URL: canonicalProviderEnvShape.DATABASE_URL.optional(),
  ...workerDatabaseUrlShape,
}).transform(
  ({
    REQUESTPORT_DISPATCHER_DATABASE_URL: _dispatcherUrl,
    REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL: _processorUrl,
    REQUESTPORT_MAINTENANCE_DATABASE_URL: _maintenanceUrl,
    ...env
  }) => env,
);

/** Set to something other than blanks, as `@requestport/db` reads a URL. */
function isNonBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * What stands for `DATABASE_URL` when it is absent, or `undefined` when
 * nothing may (Plan 13, H.3; manifest-h.md §2.3; and I.2b's b5).
 *
 * - `pglite`: `REQUESTPORT_DATABASE_DRIVER=pglite` with `VERCEL_ENV` unset,
 *   the same condition under which `selectDriver` in `@requestport/db`
 *   accepts PGlite. A PGlite storage is one user's, in one process
 *   (manifest-h.md §2.6), and has no connection string at all.
 * - `application`: any other driver, and `REQUESTPORT_APPLICATION_DATABASE_URL`
 *   set to something other than blanks, which is when `@requestport/db`
 *   connects through it (`applicationDatabaseUrlSelected`). A process that
 *   connects as the application login needs no owner URL: a self-host's
 *   serving process on pg (manifest-h.md §2.4), and Vercel production, on
 *   its hosted driver, once I.2's step 6 has removed the owner's URL. Accepting
 *   that is step 5's schema change (manifest-i2.md §3), which H.3 made first
 *   (ruling 68), which is why this is not limited to the `pg` driver. Step 5
 *   then removed `@requestport/db`'s fallback to `DATABASE_URL`, so outside a
 *   preview the application's storage connects only through this variable and
 *   refuses without it (`readApplicationDatabaseUrl`); when the variable is
 *   read did not change, so neither did this case.
 * - `worker`: any driver but PGlite, no application URL, `VERCEL_ENV` unset,
 *   and all three of the worker's variables set to something other than
 *   blanks, which is when `createWorkerStorages` in `@requestport/db` binds
 *   the worker's storages to its three logins (a blank one counts as unset
 *   there, and a partial set is refused). A worker so configured connects
 *   only as those logins and needs no owner URL: the Trigger.dev worker once
 *   I.2b's b6 has removed `DATABASE_URL`, `PG*` and `POSTGRES_*` from its
 *   environment, and `requestport-jobs` (ruling 214 item 3). Not where
 *   `VERCEL_ENV` is set, whatever its value: no worker runs on Vercel, and a
 *   deployment there holding only the worker's URLs would boot and then fail
 *   on every query, the half-boot this schema exists to refuse.
 *
 * Only an absent `DATABASE_URL` asks. One that is present, empty included, is
 * judged by the canonical schema as it always was, whatever stands beside it,
 * and the result carries it as before. So a configuration that names
 * `DATABASE_URL` and no application URL still parses outside Vercel
 * production, as the worker's must, although an application process on pg
 * or the hosted driver so configured is refused when its storage first
 * connects (`readApplicationDatabaseUrl`, I.2 step 5). Under
 * `VERCEL_ENV=production` it is refused before this is asked
 * (`assertProductionApplicationLogin`).
 */
function databaseUrlStandIn(
  env: Record<string, unknown>,
): "pglite" | "application" | "worker" | undefined {
  if (env.DATABASE_URL !== undefined) return undefined;

  if (env[DATABASE_DRIVER_VARIABLE] === "pglite") {
    return env.VERCEL_ENV === undefined ? "pglite" : undefined;
  }

  if (isNonBlank(env[APPLICATION_DATABASE_URL_VARIABLE])) return "application";

  return env.VERCEL_ENV === undefined &&
    WORKER_DATABASE_URL_VARIABLES.every((name) => isNonBlank(env[name]))
    ? "worker"
    : undefined;
}

type CanonicalProviderKey = keyof typeof canonicalProviderEnvShape;
export type ParsedServerEnv = Omit<
  z.infer<typeof ServerEnvSchema>,
  CanonicalProviderKey
> &
  Partial<Pick<z.infer<typeof ServerEnvSchema>, CanonicalProviderKey>>;

const PreviewServerEnvSchema = serverEnvironmentSchema(
  {
    ...sharedServerEnvShape,
    REQUESTPORT_PREVIEW_DATABASE_URL: z
      .string()
      .url()
      .refine(isPostgresDatabaseUrl, {
        message: "must be a postgres URL naming a database",
      }),
    REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID: z.string().min(1).optional(),
    REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    REQUESTPORT_PREVIEW_RESEND_API_KEY: z.string().min(1).optional(),
    REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL: z.string().email().optional(),
  },
  "REQUESTPORT_PREVIEW_",
).transform(
  ({
    REQUESTPORT_PREVIEW_DATABASE_URL,
    REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID,
    REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET,
    REQUESTPORT_PREVIEW_RESEND_API_KEY,
    REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL,
    ...sharedEnv
  }) => ({
    ...sharedEnv,
    DATABASE_URL: REQUESTPORT_PREVIEW_DATABASE_URL,
    GITHUB_CLIENT_ID: REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET,
    RESEND_API_KEY: REQUESTPORT_PREVIEW_RESEND_API_KEY,
    RESEND_FROM_EMAIL: REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL,
  }),
);

/**
 * Production keeps both external methods, as it always has.
 *
 * Everywhere else either method may be absent. A Vercel production deployment
 * is the product, and a missing GitHub or Resend value there is a mistake
 * rather than a choice, so it is still a refusal to start — the same refusal
 * the schema gave when the four values were required everywhere. Kept apart
 * from `assertProductionWorkerIsReachable` below, for the reason given there:
 * `VERCEL_ENV` is not part of the shape.
 */
function assertProductionSignInMethods(env: Record<string, unknown>) {
  const missing = signInMethodPairs.flat().filter((field) => !env[field]);

  if (missing.length === 0) return;

  throw new z.ZodError(
    missing.map((field) => ({
      code: "custom" as const,
      message: `${field} is missing: a Vercel production deployment requires both GitHub and magic-link sign-in`,
      path: [field],
    })),
  );
}

/**
 * A Vercel production deployment's application connects only through
 * `REQUESTPORT_APPLICATION_DATABASE_URL` (Plan 13, I.2 step 5; ruling 221
 * item 4): `readApplicationDatabaseUrl` in `@requestport/db` never reads
 * `DATABASE_URL` for it, and refuses an unset or blank variable when its
 * pool first constructs a client. A deployment without the variable would
 * therefore boot and then refuse every query, which is the half-boot this
 * schema exists to refuse, so it is refused here, whatever `DATABASE_URL`
 * says. A blank value counts as unset, as `@requestport/db` reads it. Asked
 * of the raw environment for the reason `assertProductionWorkerIsReachable`
 * gives: `VERCEL_ENV` is not part of the shape. Only `VERCEL_ENV=production`
 * asks: a preview's configuration is parsed before this (its application
 * reads its own variable), and the Trigger.dev worker's environments carry
 * no `VERCEL_ENV` (`progress.md`, measured 2026-09-27, names only).
 */
function assertProductionApplicationLogin(env: Record<string, unknown>) {
  if (isNonBlank(env[APPLICATION_DATABASE_URL_VARIABLE])) return;

  throw new z.ZodError([
    {
      code: "custom" as const,
      message: `${APPLICATION_DATABASE_URL_VARIABLE} is missing: a Vercel production deployment's application connects only through it, never through DATABASE_URL`,
      path: [APPLICATION_DATABASE_URL_VARIABLE],
    },
  ]);
}

/**
 * Empty is a valid answer to the all-or-nothing group above, and in production
 * it is the wrong one.
 *
 * On a Vercel production deployment nothing but Trigger.dev drains the outbox.
 * There is no cron in `apps/web/vercel.json` and no sweep route, and the other
 * runner — the `requestport-jobs` worker in `packages/jobs`, selected by
 * `REQUESTPORT_JOB_RUNNER=postgres` — is a long-lived process, which Vercel
 * does not run. `dispatchCommittedOutbox` catches its own failure and logs
 * `outbox.dispatch_failed`, so a production deployment holding neither Trigger
 * variable boots, serves, accepts work, and silently delivers none of it. That
 * is exactly how Production was configured on 2026-09-05, and it would have
 * launched that way.
 *
 * So `REQUESTPORT_JOB_RUNNER` is asked first. Unset (as production leaves it),
 * empty or `trigger` goes on to the Trigger check, unchanged. `postgres` is
 * refused, as `resolveJobRunnerKind` in `packages/jobs/src/selection.ts`
 * refuses it wherever `VERCEL_ENV` is set. The web server asks that at boot,
 * but this runs wherever the configuration is parsed with
 * `VERCEL_ENV=production` — `server.ts` on import, `server-deferred.ts` on
 * first read — and it must not accept what that check refuses, nor point an
 * operator who chose `postgres` at Trigger variables that would not get the
 * deployment past it. Any other value is refused rather than read as
 * Trigger.dev. The variable is read here, not through `@requestport/jobs`,
 * because that package depends on this one.
 *
 * This lives outside `validateServerConfiguration` because that refinement runs
 * on the schema's *output*, and neither `VERCEL_ENV` nor
 * `REQUESTPORT_JOB_RUNNER` is part of the shape — both are stripped before the
 * refinement ever sees them. The raw environment is the only place the question
 * can be asked.
 *
 * `VERCEL_ENV` is the discriminator rather than `NODE_ENV`, which is
 * `production` in Preview, in CI and in the E2E lanes as well. None of those
 * deploy a worker and none of them should be refused.
 */
function assertProductionWorkerIsReachable(env: Record<string, unknown>) {
  const runner = env.REQUESTPORT_JOB_RUNNER;

  if (runner !== undefined && runner !== "" && runner !== "trigger") {
    throw new z.ZodError([
      {
        code: "custom" as const,
        message:
          runner === "postgres"
            ? "REQUESTPORT_JOB_RUNNER=postgres is refused on a Vercel production deployment: no requestport-jobs worker runs on Vercel, so nothing would drain the outbox. Leave it unset to use Trigger.dev"
            : 'REQUESTPORT_JOB_RUNNER is neither "trigger" nor "postgres": leave it unset on a Vercel production deployment to use Trigger.dev',
        path: ["REQUESTPORT_JOB_RUNNER"],
      },
    ]);
  }

  const missing = (
    ["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"] as const
  ).filter((field) => !env[field]);

  if (missing.length === 0) return;

  throw new z.ZodError(
    missing.map((field) => ({
      code: "custom" as const,
      message:
        "Production requires a reachable Trigger.dev worker: without it the outbox is never drained and no email, webhook or reminder is delivered",
      path: [field],
    })),
  );
}

/**
 * Private and loopback webhook receivers are a self-hoster's choice, never
 * the hosted service's (ruling 176). Setting
 * `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS` at all, whatever its value, refuses
 * to boot
 * - wherever `VERCEL_ENV` is set, whatever its value, empty included; and
 * - unless `REQUESTPORT_JOB_RUNNER` is `postgres`. A self-host runs the
 *   Postgres job runner: `requestport start` writes
 *   `REQUESTPORT_JOB_RUNNER=postgres` among its canonical names, and
 *   `requestport-jobs` and `requestport worker` will not start without it.
 *   The hosted Trigger.dev worker carries neither that nor `VERCEL_ENV` (its
 *   shape in `server.test.ts`), so the first refusal alone would never fire
 *   there.
 *
 * Asked of the raw environment, before any schema, for the reason
 * `assertProductionWorkerIsReachable` gives: neither `VERCEL_ENV` nor
 * `REQUESTPORT_JOB_RUNNER` is part of the shape.
 */
function assertPrivateWebhookReceiversSelfHosted(env: Record<string, unknown>) {
  if (env.REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS === undefined) return;

  if (env.VERCEL_ENV !== undefined) {
    throw new z.ZodError([
      {
        code: "custom" as const,
        message:
          "REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused wherever VERCEL_ENV is set: private and loopback webhook receivers are for a self-hosted RequestPort, never a Vercel deployment. Leave it unset",
        path: ["REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS"],
      },
    ]);
  }

  if (env.REQUESTPORT_JOB_RUNNER !== "postgres") {
    throw new z.ZodError([
      {
        code: "custom" as const,
        message:
          "REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused unless REQUESTPORT_JOB_RUNNER is postgres: private and loopback webhook receivers are for a self-hosted RequestPort, which runs the Postgres job runner, never the Trigger.dev worker. Leave it unset",
        path: ["REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS"],
      },
    ]);
  }
}

export function parseServerEnv(env: Record<string, unknown>): ParsedServerEnv {
  assertPrivateWebhookReceiversSelfHosted(env);

  if (env.VERCEL_ENV === "preview") return PreviewServerEnvSchema.parse(env);

  if (env.VERCEL_ENV === "production") {
    assertProductionWorkerIsReachable(env);
    assertProductionSignInMethods(env);
    assertProductionApplicationLogin(env);
  }

  switch (databaseUrlStandIn(env)) {
    case "pglite":
      return PgliteServerEnvSchema.parse(env);
    case "application":
      return ApplicationLoginServerEnvSchema.parse(env);
    case "worker":
      return WorkerLoginsServerEnvSchema.parse(env);
    default:
      return ServerEnvSchema.parse(env);
  }
}
