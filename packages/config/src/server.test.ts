import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { databaseProjectVariables } from "../../../scripts/hosted-deployment.mjs";

const requiredEnv = {
  NODE_ENV: "test",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/requestport",
  BETTER_AUTH_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  RESEND_API_KEY: "re_test_api_key",
  RESEND_FROM_EMAIL: "hello@example.com",
  LOG_LEVEL: "info",
} as const;

const { NEXT_PUBLIC_APP_URL: _nextPublicAppUrl, ...requiredServerInput } =
  requiredEnv;
const requiredServerEnv = {
  ...requiredServerInput,
  REQUESTPORT_WORKSPACE_KEK_VERSION: "local-v1",
  REQUESTPORT_WEBHOOK_KEK_VERSION: "local-v1",
};

const requiredServerKeys = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
] as const;

const previewProviderValues = {
  REQUESTPORT_PREVIEW_DATABASE_URL:
    "postgres://preview:preview@localhost:5432/requestport_preview",
  REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID: "preview-github-client-id",
  REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET: "preview-github-client-secret",
  REQUESTPORT_PREVIEW_RESEND_API_KEY: "re_preview_api_key",
  REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL: "preview@example.com",
} as const;

const previewProviderKeys = Object.keys(previewProviderValues) as Array<
  keyof typeof previewProviderValues
>;

/**
 * The application login's URL, which a Vercel production configuration must
 * name since I.2's step 5 (`assertProductionApplicationLogin`), and which
 * production has named since step 3. It is not carried into the result.
 */
const productionApplicationLogin = {
  REQUESTPORT_APPLICATION_DATABASE_URL:
    "postgres://requestport_application_login:application-password@localhost:5432/requestport",
} as const;

const controlledImportEnvironmentKeys = [
  ...Object.keys(requiredEnv),
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "REQUESTPORT_WORKSPACE_KEK",
  "REQUESTPORT_WORKSPACE_KEK_VERSION",
  "REQUESTPORT_WORKSPACE_KEK_PREVIOUS",
  "REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION",
  "REQUESTPORT_WEBHOOK_KEK",
  "REQUESTPORT_WEBHOOK_KEK_VERSION",
  "REQUESTPORT_WEBHOOK_KEK_PREVIOUS",
  "REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION",
  "REQUESTPORT_WEBHOOK_SIGNING_KEY",
  "REQUESTPORT_SLACK_SIGNING_SECRET",
  "REQUESTPORT_SLACK_CLIENT_ID",
  "REQUESTPORT_SLACK_CLIENT_SECRET",
  "REQUESTPORT_SLACK_STATE_SECRET",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_PROJECT_REF",
  "REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS",
  // The private receivers switch is refused unless it is `postgres`, so an
  // ambient value would let an import pass that is meant to refuse.
  "REQUESTPORT_JOB_RUNNER",
  // Each lets DATABASE_URL be absent (the last describe block), so an
  // ambient value would let an import pass that is meant to refuse.
  "REQUESTPORT_DATABASE_DRIVER",
  "REQUESTPORT_APPLICATION_DATABASE_URL",
  "REQUESTPORT_DISPATCHER_DATABASE_URL",
  "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
  "REQUESTPORT_MAINTENANCE_DATABASE_URL",
  ...Object.keys(previewProviderValues),
];

function stubServerEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();

  for (const key of controlledImportEnvironmentKeys) {
    vi.stubEnv(
      key,
      Object.hasOwn(overrides, key)
        ? overrides[key]
        : (requiredEnv[key as keyof typeof requiredEnv] ?? undefined),
    );
  }
}

async function importServerWithEnv(
  overrides: Record<string, string | undefined> = {},
) {
  stubServerEnv(overrides);

  return import("./server.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("parseServerEnv reports missing required environment variables", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(() => parseServerEnv({ NODE_ENV: "test" })).toThrow(/DATABASE_URL/);
});

test.each(requiredServerKeys)(
  "throws during startup when %s is missing",
  async (key) => {
    await expect(importServerWithEnv({ [key]: undefined })).rejects.toThrow(
      new RegExp(key),
    );
  },
);

test("applies the default server log level", async () => {
  const { parseServerEnv } = await importServerWithEnv({
    LOG_LEVEL: undefined,
  });

  expect(parseServerEnv(requiredEnv).LOG_LEVEL).toBe("info");
});

test("clears ambient Preview selection and provider values before import", async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  for (const [key, value] of Object.entries(previewProviderValues)) {
    vi.stubEnv(key, value);
  }

  const { serverEnv } = await importServerWithEnv();

  expect(serverEnv).toEqual(requiredServerEnv);
});

test("selects Preview-only provider values behind the canonical server keys", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(
    parseServerEnv({
      ...requiredEnv,
      ...previewProviderValues,
      VERCEL_ENV: "preview",
      DATABASE_URL:
        "postgres://production:production@localhost:5432/requestport",
      GITHUB_CLIENT_ID: "production-github-client-id",
      GITHUB_CLIENT_SECRET: "production-github-client-secret",
      RESEND_API_KEY: "re_production_api_key",
      RESEND_FROM_EMAIL: "production@example.com",
    }),
  ).toEqual({
    ...requiredServerEnv,
    DATABASE_URL: previewProviderValues.REQUESTPORT_PREVIEW_DATABASE_URL,
    GITHUB_CLIENT_ID:
      previewProviderValues.REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET:
      previewProviderValues.REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET,
    RESEND_API_KEY: previewProviderValues.REQUESTPORT_PREVIEW_RESEND_API_KEY,
    RESEND_FROM_EMAIL:
      previewProviderValues.REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL,
  });
});

test("allows a Preview to configure no external sign-in method", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  const parsed = parseServerEnv({
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: requiredEnv.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: requiredEnv.BETTER_AUTH_URL,
    REQUESTPORT_PREVIEW_DATABASE_URL:
      previewProviderValues.REQUESTPORT_PREVIEW_DATABASE_URL,
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "codex/implementation",
  });

  expect(parsed).toEqual({
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: requiredEnv.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: requiredEnv.BETTER_AUTH_URL,
    DATABASE_URL: previewProviderValues.REQUESTPORT_PREVIEW_DATABASE_URL,
    LOG_LEVEL: "info",
    REQUESTPORT_WORKSPACE_KEK_VERSION: "local-v1",
    REQUESTPORT_WEBHOOK_KEK_VERSION: "local-v1",
  });
});

test("fails closed when a Preview has half a sign-in method", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(() =>
    parseServerEnv({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: requiredEnv.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: requiredEnv.BETTER_AUTH_URL,
      REQUESTPORT_PREVIEW_DATABASE_URL:
        previewProviderValues.REQUESTPORT_PREVIEW_DATABASE_URL,
      REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID:
        previewProviderValues.REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID,
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "codex/implementation",
    }),
  ).toThrow(/REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET/);
});

test.each(previewProviderKeys)(
  "fails closed in Preview when %s is absent, even if an unprefixed value exists",
  async (key) => {
    const { parseServerEnv } = await importServerWithEnv();
    const missingValue = "preview-provider-value-must-not-leak";

    expect(() =>
      parseServerEnv({
        ...requiredEnv,
        ...previewProviderValues,
        VERCEL_ENV: "preview",
        [key]: undefined,
      }),
    ).toThrow(new RegExp(key));

    try {
      parseServerEnv({
        ...requiredEnv,
        ...previewProviderValues,
        VERCEL_ENV: "preview",
        [key]: undefined,
        DATABASE_URL: `postgres://preview:${missingValue}@localhost:5432/requestport`,
        GITHUB_CLIENT_ID: missingValue,
        GITHUB_CLIENT_SECRET: missingValue,
        RESEND_API_KEY: missingValue,
        RESEND_FROM_EMAIL: "production@example.com",
      });
    } catch (error) {
      expect(String(error)).not.toContain(missingValue);
    }
  },
);

test("ignores Preview-prefixed provider values outside Vercel Preview", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(
    parseServerEnv({
      ...requiredEnv,
      ...previewProviderValues,
      ...productionApplicationLogin,
      TRIGGER_PROJECT_REF: "proj_example",
      TRIGGER_SECRET_KEY: "trigger-secret",
      VERCEL_ENV: "production",
    }),
  ).toEqual({
    ...requiredServerEnv,
    TRIGGER_PROJECT_REF: "proj_example",
    TRIGGER_SECRET_KEY: "trigger-secret",
  });
});

test("accepts complete active and previous workspace and webhook key rotations", async () => {
  const { parseServerEnv } = await importServerWithEnv();
  const parsed = parseServerEnv({
    ...requiredEnv,
    REQUESTPORT_WORKSPACE_KEK: "w".repeat(43),
    REQUESTPORT_WORKSPACE_KEK_VERSION: "workspace-v2",
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS: "x".repeat(43),
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: "workspace-v1",
    REQUESTPORT_WEBHOOK_KEK: "h".repeat(43),
    REQUESTPORT_WEBHOOK_KEK_VERSION: "webhook-v2",
    REQUESTPORT_WEBHOOK_KEK_PREVIOUS: "i".repeat(43),
    REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION: "webhook-v1",
  });

  expect(parsed.REQUESTPORT_WORKSPACE_KEK_VERSION).toBe("workspace-v2");
  expect(parsed.REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION).toBe("webhook-v1");
});

test.each([
  {
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS: "x".repeat(43),
  },
  {
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: "workspace-v1",
  },
  {
    REQUESTPORT_WORKSPACE_KEK: "w".repeat(43),
    REQUESTPORT_WORKSPACE_KEK_VERSION: "workspace-v1",
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS: "x".repeat(43),
    REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: "workspace-v1",
  },
])(
  "rejects incomplete or ambiguous encryption rotation %#",
  async (rotation) => {
    const { parseServerEnv } = await importServerWithEnv();
    expect(() => parseServerEnv({ ...requiredEnv, ...rotation })).toThrow();
  },
);

test("accepts the legacy webhook signing key as the current rotation key", async () => {
  const { parseServerEnv } = await importServerWithEnv();
  expect(
    parseServerEnv({
      ...requiredEnv,
      REQUESTPORT_WEBHOOK_SIGNING_KEY: "s".repeat(43),
      REQUESTPORT_WEBHOOK_KEK_VERSION: "webhook-v2",
      REQUESTPORT_WEBHOOK_KEK_PREVIOUS: "p".repeat(43),
      REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION: "webhook-v1",
    }).REQUESTPORT_WEBHOOK_SIGNING_KEY,
  ).toBe("s".repeat(43));
});

test.each([
  { REQUESTPORT_SLACK_CLIENT_ID: "slack-client" },
  { TRIGGER_SECRET_KEY: "trigger-secret" },
])(
  "rejects a partially configured optional integration %#",
  async (partial) => {
    const { parseServerEnv } = await importServerWithEnv();
    expect(() => parseServerEnv({ ...requiredEnv, ...partial })).toThrow(
      /Optional integration configuration must be complete/,
    );
  },
);

/**
 * Empty is a valid answer everywhere except production.
 *
 * `["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"]` is an all-or-nothing group, so
 * configuring neither passes — which is right for a developer who is not running
 * the worker, and wrong for the deployment that is the product. Production held
 * neither on 2026-09-05 and booted perfectly: nothing else drains the outbox, no
 * cron exists, and `dispatchCommittedOutbox` catches its own failure and logs
 * `outbox.dispatch_failed`. Every email, webhook and reminder would have been
 * dropped with nothing shown to anyone.
 *
 * So production is held to a stricter rule than the group's own. The
 * discriminator is `VERCEL_ENV`, not `NODE_ENV`: a production build runs under
 * `NODE_ENV=production` in preview, in CI and in the E2E lanes, none of which
 * deploy a worker, and only a Vercel production deployment sets
 * `VERCEL_ENV=production`.
 */
test("refuses a production deployment that cannot reach its worker", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(() =>
    parseServerEnv({ ...requiredEnv, VERCEL_ENV: "production" }),
  ).toThrow(/Production requires a reachable Trigger.dev worker/);
});

test.each(["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"] as const)(
  "names %s when production is missing it",
  async (field) => {
    const { parseServerEnv } = await importServerWithEnv();
    const complete = {
      ...requiredEnv,
      TRIGGER_PROJECT_REF: "proj_example",
      TRIGGER_SECRET_KEY: "trigger-secret",
      VERCEL_ENV: "production",
    };

    expect(() => parseServerEnv({ ...complete, [field]: undefined })).toThrow(
      /Production requires a reachable Trigger.dev worker/,
    );
  },
);

test("accepts a production deployment that has both", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(
    parseServerEnv({
      ...requiredEnv,
      ...productionApplicationLogin,
      TRIGGER_PROJECT_REF: "proj_example",
      TRIGGER_SECRET_KEY: "trigger-secret",
      VERCEL_ENV: "production",
    }).TRIGGER_PROJECT_REF,
  ).toBe("proj_example");
});

/**
 * Since I.2's step 5 a Vercel production deployment's application connects
 * only through `REQUESTPORT_APPLICATION_DATABASE_URL`: `@requestport/db`'s
 * `readApplicationDatabaseUrl` never reads `DATABASE_URL` for it. Without
 * that variable such a deployment would boot and then refuse every query, so
 * it is refused at parse (review of I.2 step 5; ruling 221 item 4).
 */
describe("the application login's URL on a Vercel production deployment", () => {
  const production = {
    ...requiredEnv,
    TRIGGER_PROJECT_REF: "proj_example",
    TRIGGER_SECRET_KEY: "trigger-secret",
    VERCEL_ENV: "production",
  };
  const applicationUrl =
    "postgres://requestport_application_login:application-password@localhost:5432/requestport";

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])(
    "refuses it %s, naming it, whatever DATABASE_URL says",
    async (_label, value) => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(() =>
        parseServerEnv({
          ...production,
          REQUESTPORT_APPLICATION_DATABASE_URL: value,
        }),
      ).toThrow(
        /REQUESTPORT_APPLICATION_DATABASE_URL is missing: a Vercel production deployment's application connects only through it/u,
      );
    },
  );

  test("parses one that names it beside DATABASE_URL, as production has since I.2's step 3, to the configuration it parsed to before", async () => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(
      parseServerEnv({
        ...production,
        REQUESTPORT_APPLICATION_DATABASE_URL: applicationUrl,
      }),
    ).toEqual({
      ...requiredServerEnv,
      TRIGGER_PROJECT_REF: "proj_example",
      TRIGGER_SECRET_KEY: "trigger-secret",
    });
  });

  test("asks nothing of the Trigger.dev worker's shape, which carries no VERCEL_ENV", async () => {
    const { parseServerEnv } = await importServerWithEnv();
    const { VERCEL_ENV: _vercelEnv, ...worker } = production;

    expect(parseServerEnv(worker).TRIGGER_PROJECT_REF).toBe("proj_example");
  });
});

test.each([undefined, "preview", "development"])(
  "leaves %s free to configure no worker at all",
  async (vercelEnv) => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(() =>
      parseServerEnv({
        ...requiredEnv,
        ...previewProviderValues,
        VERCEL_ENV: vercelEnv,
      }),
    ).not.toThrow();
  },
);

/**
 * `REQUESTPORT_JOB_RUNNER` on a Vercel production deployment.
 *
 * Production leaves it unset, in Vercel and in Trigger.dev, and with it unset
 * the worker check must answer exactly as it did before the variable existed.
 * `postgres` is refused there, as `resolveJobRunnerKind` in `@requestport/jobs`
 * refuses it wherever `VERCEL_ENV` is set: no `requestport-jobs` worker runs on
 * Vercel. Any other value is refused at the variable rather than read as
 * Trigger.dev.
 */
describe("REQUESTPORT_JOB_RUNNER on a Vercel production deployment", () => {
  const production = {
    ...requiredEnv,
    ...productionApplicationLogin,
    VERCEL_ENV: "production",
  };
  const triggerEnv = {
    TRIGGER_PROJECT_REF: "proj_example",
    TRIGGER_SECRET_KEY: "trigger-secret",
  };
  const workerUnreachable =
    "Production requires a reachable Trigger.dev worker: without it the outbox is never drained and no email, webhook or reminder is delivered";

  // The module is re-imported per test, zod with it, so the error is read by
  // shape rather than by `instanceof`.
  async function issuesOf(env: Record<string, unknown>) {
    const { parseServerEnv } = await importServerWithEnv();
    try {
      parseServerEnv(env);
    } catch (error) {
      return (error as { issues?: unknown }).issues;
    }
    return "parsed";
  }

  const triggerSelections = [
    ["unset, as production leaves it", {}],
    ["empty", { REQUESTPORT_JOB_RUNNER: "" }],
    ['"trigger"', { REQUESTPORT_JOB_RUNNER: "trigger" }],
  ] as const;

  test.each(triggerSelections)(
    "%s, still refuses production without the Trigger variables, exactly as before",
    async (_label, runner) => {
      expect(await issuesOf({ ...production, ...runner })).toEqual([
        {
          code: "custom",
          message: workerUnreachable,
          path: ["TRIGGER_SECRET_KEY"],
        },
        {
          code: "custom",
          message: workerUnreachable,
          path: ["TRIGGER_PROJECT_REF"],
        },
      ]);
    },
  );

  test.each(triggerSelections)(
    "%s, parses production with both Trigger variables to the same configuration",
    async (_label, runner) => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(
        parseServerEnv({ ...production, ...triggerEnv, ...runner }),
      ).toEqual({ ...requiredServerEnv, ...triggerEnv });
    },
  );

  test.each([
    ["with both Trigger variables", triggerEnv],
    ["without them", {}],
  ] as const)(
    "refuses postgres at REQUESTPORT_JOB_RUNNER %s: no requestport-jobs worker runs on Vercel",
    async (_label, trigger) => {
      expect(
        await issuesOf({
          ...production,
          ...trigger,
          REQUESTPORT_JOB_RUNNER: "postgres",
        }),
      ).toEqual([
        {
          code: "custom",
          message: expect.stringMatching(
            /^REQUESTPORT_JOB_RUNNER=postgres is refused on a Vercel production deployment/u,
          ),
          path: ["REQUESTPORT_JOB_RUNNER"],
        },
      ]);
    },
  );

  test.each(["postgres ", " postgres", "Postgres", "trigger ", "garbage"])(
    "refuses %j at REQUESTPORT_JOB_RUNNER rather than reading it as Trigger.dev",
    async (value) => {
      expect(
        await issuesOf({
          ...production,
          ...triggerEnv,
          REQUESTPORT_JOB_RUNNER: value,
        }),
      ).toEqual([
        {
          code: "custom",
          message: expect.stringMatching(
            /^REQUESTPORT_JOB_RUNNER is neither "trigger" nor "postgres"/u,
          ),
          path: ["REQUESTPORT_JOB_RUNNER"],
        },
      ]);
    },
  );

  // The `requestport-jobs` worker reads this configuration too, with
  // `postgres` selected and no Trigger variable. Off Vercel that must parse.
  test("leaves postgres to parse off Vercel, where the requestport-jobs worker runs", async () => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(
      parseServerEnv({ ...requiredEnv, REQUESTPORT_JOB_RUNNER: "postgres" }),
    ).toEqual(requiredServerEnv);
  });
});

test("client configuration contains only the public application URL", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", requiredEnv.NEXT_PUBLIC_APP_URL);
  const { clientEnv } = await import("./client.js");

  expect(clientEnv).toEqual({
    NEXT_PUBLIC_APP_URL: requiredEnv.NEXT_PUBLIC_APP_URL,
  });
});

/**
 * Two separate sign-in switches, not one all-or-nothing gate.
 *
 * GitHub is a pair and the magic link is a pair; each is complete or absent,
 * and either may be absent outside a Vercel production deployment. A
 * self-hosted deployment with neither boots, and the local owner credential is
 * how anyone signs in to it.
 */
const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  ...providerlessEnv
} = requiredEnv;
const githubEnv = { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET };
const magicLinkEnv = { RESEND_API_KEY, RESEND_FROM_EMAIL };

test.each([
  { name: "neither method", env: providerlessEnv },
  { name: "GitHub only", env: { ...providerlessEnv, ...githubEnv } },
  { name: "magic link only", env: { ...providerlessEnv, ...magicLinkEnv } },
  {
    name: "both methods",
    env: { ...providerlessEnv, ...githubEnv, ...magicLinkEnv },
  },
])("boots outside Vercel production with $name", async ({ env }) => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(() => parseServerEnv(env)).not.toThrow();
});

test.each([
  ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ["GITHUB_CLIENT_SECRET", "GITHUB_CLIENT_ID"],
  ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
  ["RESEND_FROM_EMAIL", "RESEND_API_KEY"],
] as const)("refuses %s without %s", async (present, missing) => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(() =>
    parseServerEnv({ ...providerlessEnv, [present]: requiredEnv[present] }),
  ).toThrow(new RegExp(`${missing}[\\s\\S]*sign-in method`));
});

test.each(requiredServerKeys.filter((key) => /GITHUB|RESEND/u.test(key)))(
  "still refuses a Vercel production deployment without %s",
  async (key) => {
    const { parseServerEnv } = await importServerWithEnv();
    const production = {
      ...requiredEnv,
      TRIGGER_PROJECT_REF: "proj_example",
      TRIGGER_SECRET_KEY: "trigger-secret",
      VERCEL_ENV: "production",
    };
    const { [key]: _omitted, ...withoutKey } = production;

    expect(() => parseServerEnv(withoutKey)).toThrow(new RegExp(key));
  },
);

// Removing one key of a pair is refused by the pair rule on its own, so these
// remove whole pairs: only the production assertion can refuse them.
const wholeSignInPairs = {
  GitHub: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  "the magic link": ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
  "both methods": [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
  ],
} as const;

function withoutKeys(env: Record<string, string>, keys: readonly string[]) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !keys.includes(key)),
  );
}

test.each(Object.entries(wholeSignInPairs))(
  "still refuses a Vercel production deployment without %s configured at all",
  async (_label, keys) => {
    const { parseServerEnv } = await importServerWithEnv();
    const production = withoutKeys(
      {
        ...requiredEnv,
        TRIGGER_PROJECT_REF: "proj_example",
        TRIGGER_SECRET_KEY: "trigger-secret",
        VERCEL_ENV: "production",
      },
      keys,
    );

    expect(() => parseServerEnv(production)).toThrow(
      /Vercel production deployment requires both GitHub and magic-link sign-in/u,
    );
  },
);

test.each(Object.entries(wholeSignInPairs))(
  "boots outside Vercel production without %s configured at all",
  async (_label, keys) => {
    const { parseServerEnv } = await importServerWithEnv();

    const parsed = parseServerEnv(withoutKeys(requiredEnv, keys));

    for (const key of keys) expect(parsed).not.toHaveProperty(key);
  },
);

test.each(["enabled", "disabled"])(
  "carries an explicit local credential switch of %s",
  async (value) => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(
      parseServerEnv({ ...requiredEnv, REQUESTPORT_LOCAL_CREDENTIAL: value })
        .REQUESTPORT_LOCAL_CREDENTIAL,
    ).toBe(value);
  },
);

test("refuses a local credential switch it does not recognise", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(() =>
    parseServerEnv({ ...requiredEnv, REQUESTPORT_LOCAL_CREDENTIAL: "yes" }),
  ).toThrow(/REQUESTPORT_LOCAL_CREDENTIAL/);
});

test("lets a feature Preview configure one sign-in method without the other", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  const parsed = parseServerEnv({
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: requiredEnv.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: requiredEnv.BETTER_AUTH_URL,
    REQUESTPORT_PREVIEW_DATABASE_URL:
      previewProviderValues.REQUESTPORT_PREVIEW_DATABASE_URL,
    REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID:
      previewProviderValues.REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID,
    REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET:
      previewProviderValues.REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET,
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "codex/implementation",
  });

  expect(parsed.GITHUB_CLIENT_ID).toBe(
    previewProviderValues.REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID,
  );
  expect(parsed.RESEND_API_KEY).toBeUndefined();
});

/**
 * The configuration carries `BETTER_AUTH_URL`; it does not judge it as an
 * issuer.
 *
 * Whether a URL can be the OAuth issuer is Better Auth's question, asked where
 * Better Auth is composed (`createAuthOptions` in `@requestport/auth`, which
 * refuses it). The Trigger worker parses this configuration and never composes
 * Better Auth, so a refusal here would be a way for every task that reads
 * `serverEnv` to throw over a check it cannot need.
 */
describe("which BETTER_AUTH_URL the configuration carries", () => {
  const issuersBetterAuthRefuses = [
    "http://requestport.internal:3000",
    "http://10.0.0.5:3000",
    "http://requestport.com",
    "https://requestport.com/?tenant=a",
    "https://requestport.com/#fragment",
  ];

  test.each(issuersBetterAuthRefuses)(
    "parses %s, which only the Better Auth composition refuses",
    async (url) => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(
        parseServerEnv({ ...requiredEnv, BETTER_AUTH_URL: url })
          .BETTER_AUTH_URL,
      ).toBe(url);
    },
  );

  test("parses it in a Preview too", async () => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(
      parseServerEnv({
        ...requiredEnv,
        ...previewProviderValues,
        BETTER_AUTH_URL: "http://preview.internal",
        VERCEL_ENV: "preview",
      }).BETTER_AUTH_URL,
    ).toBe("http://preview.internal");
  });

  test("the worker's deferred reading does not throw on it", async () => {
    const url = "http://requestport.internal:3000";
    stubServerEnv({ BETTER_AUTH_URL: url });

    const { serverEnv } = await import("./server-deferred.js");

    expect(serverEnv.BETTER_AUTH_URL).toBe(url);
    expect(serverEnv.DATABASE_URL).toBe(requiredEnv.DATABASE_URL);
  });

  test("still refuses a value that is not a URL at all", async () => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(() =>
      parseServerEnv({ ...requiredEnv, BETTER_AUTH_URL: "requestport.com" }),
    ).toThrow(/BETTER_AUTH_URL/);
  });
});

/**
 * `REQUESTPORT_MCP_MODERN` turns on the MCP route's 2026-07-28 leg (Plan 13
 * K.1). It is carried as written and judged only where it is used
 * (`apps/web/src/app/mcp/route.ts`: exactly "enabled" turns the leg on), for
 * the reason `BETTER_AUTH_URL` is above: the Trigger worker parses this
 * configuration and never serves MCP, so a stray value must not make its
 * parse throw.
 */
describe("the MCP 2026-07-28 switch", () => {
  test.each(["enabled", "disabled", "yes", ""])(
    "is carried as written, %j included, in production and in a Preview",
    async (value) => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(
        parseServerEnv({ ...requiredEnv, REQUESTPORT_MCP_MODERN: value }),
      ).toMatchObject({ REQUESTPORT_MCP_MODERN: value });
      expect(
        parseServerEnv({
          ...requiredEnv,
          ...previewProviderValues,
          REQUESTPORT_MCP_MODERN: value,
          VERCEL_ENV: "preview",
        }),
      ).toMatchObject({ REQUESTPORT_MCP_MODERN: value });
    },
  );

  test("is absent when unset", async () => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(parseServerEnv(requiredEnv)).not.toHaveProperty(
      "REQUESTPORT_MCP_MODERN",
    );
  });
});

/**
 * The two Client ID Metadata Document variables are carried as written and
 * judged only where Better Auth is composed (`createAuthOptions` in
 * `@requestport/auth`), for the reason `BETTER_AUTH_URL` is above: the
 * Trigger worker parses this configuration and never composes Better Auth.
 */
describe("the Client ID Metadata Document variables", () => {
  test("are carried as written, in production and in a Preview", async () => {
    const { parseServerEnv } = await importServerWithEnv();
    const cimd = {
      REQUESTPORT_OAUTH_CIMD: "enabled",
      REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS: "https://agents.example",
    };

    expect(parseServerEnv({ ...requiredEnv, ...cimd })).toMatchObject(cimd);
    expect(
      parseServerEnv({
        ...requiredEnv,
        ...previewProviderValues,
        ...cimd,
        VERCEL_ENV: "preview",
      }),
    ).toMatchObject(cimd);
  });

  test.each([
    ["an unrecognised switch", { REQUESTPORT_OAUTH_CIMD: "yes" }],
    [
      "an invalid list",
      {
        REQUESTPORT_OAUTH_CIMD: "enabled",
        REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS: "http://*.example",
      },
    ],
    ["the switch on and no list", { REQUESTPORT_OAUTH_CIMD: "enabled" }],
  ])(
    "parse with %s, which only the Better Auth composition refuses",
    async (_, values) => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(parseServerEnv({ ...requiredEnv, ...values })).toMatchObject(
        values,
      );
    },
  );

  test("are absent when unset", async () => {
    const { parseServerEnv } = await importServerWithEnv();
    const parsed = parseServerEnv(requiredEnv);

    expect(parsed).not.toHaveProperty("REQUESTPORT_OAUTH_CIMD");
    expect(parsed).not.toHaveProperty("REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS");
  });
});

/*
  Plan 13, F.3 (F3-14, ruling 46): operator credentials are off unless this
  switch is `enabled`, and it is declared as the local credential's switch is,
  so any other value, empty included, refuses to boot.
*/
test.each(["enabled", "disabled"])(
  "carries an explicit operator credential switch of %s",
  async (value) => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(
      parseServerEnv({
        ...requiredEnv,
        REQUESTPORT_OPERATOR_CREDENTIALS: value,
      }).REQUESTPORT_OPERATOR_CREDENTIALS,
    ).toBe(value);
  },
);

test("parses an unset operator credential switch as off, not as a value", async () => {
  const { parseServerEnv } = await importServerWithEnv();

  expect(parseServerEnv(requiredEnv).REQUESTPORT_OPERATOR_CREDENTIALS).toBe(
    undefined,
  );
});

test.each(["", "yes", "true", "Enabled"])(
  "refuses an operator credential switch of %j",
  async (value) => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(() =>
      parseServerEnv({
        ...requiredEnv,
        REQUESTPORT_OPERATOR_CREDENTIALS: value,
      }),
    ).toThrow(/REQUESTPORT_OPERATOR_CREDENTIALS/);
  },
);

/*
  Plan 13, H.10 (rulings 175 and 176): the operator's opt-in for private and
  loopback webhook receivers. It is exactly `enabled` or unset: any other
  value, empty included, refuses to boot, naming the variable, as the
  operator credential switch does. Wherever VERCEL_ENV is set, whatever its
  value, empty included, setting it at all refuses to boot. And it is
  refused unless REQUESTPORT_JOB_RUNNER is `postgres`, which every
  self-host's process sets (`requestport start`'s canonical names, and
  `requestport-jobs`, which will not start without it) and the hosted
  Trigger.dev worker does not, with no VERCEL_ENV either (the worker's
  shape, "when DATABASE_URL may be absent" below): so the hosted service can
  never turn it on, on Vercel or on Trigger.dev.
*/
describe("REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS", () => {
  const variable = "REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS";
  /** Complete for every VERCEL_ENV below, so a refusal can only be the switch's. */
  const complete = {
    ...requiredEnv,
    ...previewProviderValues,
    ...productionApplicationLogin,
    TRIGGER_PROJECT_REF: "proj_example",
    TRIGGER_SECRET_KEY: "trigger-secret",
  };
  /** A self-host's job runner, without which the switch is refused. */
  const selfHosted = { ...requiredEnv, REQUESTPORT_JOB_RUNNER: "postgres" };

  test("carries the switch when it is enabled where REQUESTPORT_JOB_RUNNER is postgres", async () => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(parseServerEnv({ ...selfHosted, [variable]: "enabled" })).toEqual({
      ...requiredServerEnv,
      [variable]: "enabled",
    });
  });

  test("parses an unset switch as off, not as a value", async () => {
    const { parseServerEnv } = await importServerWithEnv();

    expect(parseServerEnv(requiredEnv)).not.toHaveProperty(variable);
  });

  test.each(["", "disabled", "yes", "true", "Enabled", " enabled", "enabled "])(
    "refuses a switch of %j, naming the variable",
    async (value) => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(() =>
        parseServerEnv({ ...selfHosted, [variable]: value }),
      ).toThrow(/REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS/);
    },
  );

  test("refuses to boot on a switch it does not recognise", async () => {
    await expect(
      importServerWithEnv({
        REQUESTPORT_JOB_RUNNER: "postgres",
        [variable]: "yes",
      }),
    ).rejects.toThrow(/REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS/);
  });

  test.each([
    ["unset", undefined],
    ["trigger", "trigger"],
    ["empty", ""],
  ])(
    "refuses the switch where REQUESTPORT_JOB_RUNNER is %s, and parses the same configuration without it",
    async (_label, runner) => {
      const { parseServerEnv } = await importServerWithEnv();
      const triggerRun = { ...requiredEnv, REQUESTPORT_JOB_RUNNER: runner };

      for (const value of ["enabled", "", "yes"]) {
        expect(() =>
          parseServerEnv({ ...triggerRun, [variable]: value }),
        ).toThrow(
          /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused unless REQUESTPORT_JOB_RUNNER is postgres/,
        );
      }
      expect(parseServerEnv(triggerRun)).not.toHaveProperty(variable);
    },
  );

  test("refuses to boot with the switch enabled and no REQUESTPORT_JOB_RUNNER, and with it postgres boots", async () => {
    await expect(
      importServerWithEnv({ [variable]: "enabled" }),
    ).rejects.toThrow(
      /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused unless REQUESTPORT_JOB_RUNNER is postgres/,
    );
    const { serverEnv } = await importServerWithEnv({
      REQUESTPORT_JOB_RUNNER: "postgres",
      [variable]: "enabled",
    });
    expect(serverEnv[variable]).toBe("enabled");
  });

  test.each(["production", "preview", "development", ""])(
    "refuses the switch wherever VERCEL_ENV is set (%j), and parses the same configuration without it",
    async (vercelEnv) => {
      const { parseServerEnv } = await importServerWithEnv();
      const hosted = { ...complete, VERCEL_ENV: vercelEnv };

      for (const value of ["enabled", "", "yes"]) {
        expect(() => parseServerEnv({ ...hosted, [variable]: value })).toThrow(
          /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused wherever VERCEL_ENV is set/,
        );
      }
      expect(parseServerEnv(hosted)).not.toHaveProperty(variable);
    },
  );

  test("refuses to boot with the switch enabled under VERCEL_ENV", async () => {
    await expect(
      importServerWithEnv({
        ...complete,
        VERCEL_ENV: "production",
        [variable]: "enabled",
      }),
    ).rejects.toThrow(
      /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused wherever VERCEL_ENV is set/,
    );
  });
});

/**
 * When `DATABASE_URL` may be absent (Plan 13, H.3; manifest-h.md §1.5, §2.3;
 * and I.2b's b5, ruling 214 item 3).
 *
 * Three configurations carry no `DATABASE_URL`, and are meant to:
 *
 * - a PGlite storage (`REQUESTPORT_DATABASE_DRIVER=pglite`), which has no
 *   connection string at all: `REQUESTPORT_PGLITE_DATA_DIR` names its
 *   database. Never where `VERCEL_ENV` is set, which `selectDriver` in
 *   `@requestport/db` refuses for PGlite;
 * - a process that connects as the application login, whose URL is
 *   `REQUESTPORT_APPLICATION_DATABASE_URL`: a self-host's serving process on
 *   pg (manifest-h.md §2.4), and Vercel production once I.2's step 6 has
 *   removed the owner's URL. Accepting that is step 5's schema change
 *   (manifest-i2.md §3), which H.3 made first (ruling 68). Since step 5 the
 *   application's storage reads only that variable outside a preview, and
 *   refuses without it;
 * - a worker that connects as its three logins, whose URLs are the worker's
 *   three variables: the Trigger.dev worker once I.2b's b6 has removed the
 *   owner's names from its environment, and `requestport-jobs`. Never where
 *   `VERCEL_ENV` is set: no worker runs on Vercel.
 *
 * None of those variables is carried into the parsed configuration, and none
 * is judged while `DATABASE_URL` is present, so every configuration that
 * parsed before parses to the object it did. The production-shaped sets
 * below pin that for the configurations that reach production.
 */
describe("when DATABASE_URL may be absent", () => {
  const { DATABASE_URL: _databaseUrl, ...withoutDatabaseUrl } = requiredEnv;
  const { DATABASE_URL: _parsedDatabaseUrl, ...parsedWithoutDatabaseUrl } =
    requiredServerEnv;
  const applicationUrl =
    "postgres://rp_instance_application:application-password@127.0.0.1:5432/requestport";
  const workerUrls = {
    REQUESTPORT_DISPATCHER_DATABASE_URL:
      "postgres://rp_instance_dispatcher:dispatcher-password@127.0.0.1:5432/requestport",
    REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL:
      "postgres://rp_instance_processor:processor-password@127.0.0.1:5432/requestport",
    REQUESTPORT_MAINTENANCE_DATABASE_URL:
      "postgres://rp_instance_maintenance:maintenance-password@127.0.0.1:5432/requestport",
  };
  const triggerEnv = {
    TRIGGER_PROJECT_REF: "proj_example",
    TRIGGER_SECRET_KEY: "trigger-secret",
  };
  const keys = {
    REQUESTPORT_WORKSPACE_KEK: "w".repeat(43),
    REQUESTPORT_WEBHOOK_KEK: "h".repeat(43),
  };

  /**
   * The names manifest-h.md §2.3 says `requestport start` writes into
   * `process.env`, less the database's: a self-host serves under
   * `NODE_ENV=production` on its public URL, with the Postgres job runner and
   * no external sign-in method.
   */
  const selfHost = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: requiredEnv.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    REQUESTPORT_JOB_RUNNER: "postgres",
    ...keys,
  };
  const parsedSelfHost = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: requiredEnv.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    LOG_LEVEL: "info",
    ...keys,
    REQUESTPORT_WORKSPACE_KEK_VERSION: "local-v1",
    REQUESTPORT_WEBHOOK_KEK_VERSION: "local-v1",
  };

  async function refusalOf(env: Record<string, unknown>) {
    const { parseServerEnv } = await importServerWithEnv();
    try {
      parseServerEnv(env);
    } catch (error) {
      return String(error);
    }
    throw new Error("parsed a configuration this case expects to be refused");
  }

  describe("on PGlite", () => {
    test("parses a self-host's configuration, which names no DATABASE_URL", async () => {
      const { parseServerEnv } = await importServerWithEnv();
      const parsed = parseServerEnv({
        ...selfHost,
        REQUESTPORT_DATABASE_DRIVER: "pglite",
        REQUESTPORT_PGLITE_DATA_DIR: "/home/owner/.local/share/requestport/db",
      });

      expect(parsed).toEqual(parsedSelfHost);
      expect(parsed).not.toHaveProperty("DATABASE_URL");
    });

    test("parses the shared test values with DATABASE_URL removed", async () => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(
        parseServerEnv({
          ...withoutDatabaseUrl,
          REQUESTPORT_DATABASE_DRIVER: "pglite",
        }),
      ).toEqual(parsedWithoutDatabaseUrl);
    });

    test("starts, and the deferred reading reads, with no DATABASE_URL", async () => {
      const { serverEnv } = await importServerWithEnv({
        DATABASE_URL: undefined,
        REQUESTPORT_DATABASE_DRIVER: "pglite",
      });

      expect(serverEnv).toEqual(parsedWithoutDatabaseUrl);

      stubServerEnv({
        DATABASE_URL: undefined,
        REQUESTPORT_DATABASE_DRIVER: "pglite",
      });
      const deferred = await import("./server-deferred.js");

      expect(deferred.serverEnv.DATABASE_URL).toBeUndefined();
      expect(deferred.serverEnv.BETTER_AUTH_URL).toBe(
        requiredEnv.BETTER_AUTH_URL,
      );
    });

    test.each(["production", "development", ""])(
      "still requires DATABASE_URL where VERCEL_ENV is %j, as selectDriver refuses PGlite there",
      async (vercelEnv) => {
        expect(
          await refusalOf({
            ...withoutDatabaseUrl,
            ...triggerEnv,
            REQUESTPORT_DATABASE_DRIVER: "pglite",
            VERCEL_ENV: vercelEnv,
          }),
        ).toMatch(/DATABASE_URL/u);
      },
    );
  });

  describe("with the application login's URL in DATABASE_URL's place", () => {
    test("parses a self-host's serving process on pg", async () => {
      const { parseServerEnv } = await importServerWithEnv();
      const parsed = parseServerEnv({
        ...selfHost,
        REQUESTPORT_DATABASE_DRIVER: "pg",
        REQUESTPORT_APPLICATION_DATABASE_URL: applicationUrl,
        ...workerUrls,
      });

      expect(parsed).toEqual(parsedSelfHost);
      expect(parsed).not.toHaveProperty("DATABASE_URL");
      expect(parsed).not.toHaveProperty("REQUESTPORT_APPLICATION_DATABASE_URL");
    });

    test("parses Vercel production with no owner URL, the shape I.2's step 6 leaves", async () => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(
        parseServerEnv({
          ...withoutDatabaseUrl,
          ...triggerEnv,
          NODE_ENV: "production",
          BETTER_AUTH_URL: "https://requestport.com",
          REQUESTPORT_APPLICATION_DATABASE_URL: applicationUrl,
          VERCEL_ENV: "production",
        }),
      ).toEqual({
        ...parsedWithoutDatabaseUrl,
        ...triggerEnv,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://requestport.com",
      });
    });

    test.each([
      [
        "a URL of another scheme",
        "mysql://user:sentinel-password@localhost/db",
      ],
      [
        "a postgres URL naming no database",
        "postgres://user:sentinel-password@localhost",
      ],
      ["a value that is not a URL", "sentinel-password"],
    ])(
      "refuses %s, names the variable, and does not echo it",
      async (_label, value) => {
        const refusal = await refusalOf({
          ...withoutDatabaseUrl,
          REQUESTPORT_APPLICATION_DATABASE_URL: value,
        });

        expect(refusal).toMatch(/REQUESTPORT_APPLICATION_DATABASE_URL/u);
        expect(refusal).toMatch(/must be a postgres URL naming a database/u);
        expect(refusal).not.toContain("sentinel-password");
      },
    );

    test.each(["", "   "])(
      "reads a blank one (%j) as unset, as @requestport/db does, and requires DATABASE_URL",
      async (value) => {
        const refusal = await refusalOf({
          ...withoutDatabaseUrl,
          REQUESTPORT_APPLICATION_DATABASE_URL: value,
        });

        // The refusal is DATABASE_URL's own. A blank application URL read as
        // set would stand in for it, and the refusal would name the
        // application variable instead.
        expect(refusal).toMatch(/DATABASE_URL/u);
        expect(refusal).not.toMatch(/REQUESTPORT_APPLICATION_DATABASE_URL/u);
      },
    );
  });

  describe("with the worker's three logins' URLs in DATABASE_URL's place", () => {
    /** The names that could carry the owner's connection: none here. */
    const ownerNames = (env: Record<string, unknown>) =>
      Object.keys(env).filter(
        (name) =>
          name === "DATABASE_URL" ||
          /^PG[A-Z0-9_]*$/u.test(name) ||
          name.startsWith("POSTGRES_"),
      );
    /** A refusal that names `name` as an issue's path, not as a substring. */
    const naming = (name: string) => new RegExp(`"${name}"`, "u");

    /**
     * The Trigger.dev worker's shape (the next describe block's) once I.2b's
     * b6 has removed `DATABASE_URL`, `PG*` and `POSTGRES_*` from it: the
     * three logins' URLs, the Trigger.dev pair and the keys, and still no
     * `REQUESTPORT_JOB_RUNNER`, `REQUESTPORT_DATABASE_DRIVER` or `VERCEL_ENV`.
     */
    test("parses the Trigger.dev worker's shape with DATABASE_URL, PG* and POSTGRES_* removed, and carries none of the four URLs", async () => {
      const { parseServerEnv } = await importServerWithEnv();
      const worker = {
        ...withoutDatabaseUrl,
        ...triggerEnv,
        ...keys,
        ...workerUrls,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://requestport.com",
      };

      expect(ownerNames(worker)).toEqual([]);
      const parsed = parseServerEnv(worker);

      expect(parsed).toEqual({
        ...parsedWithoutDatabaseUrl,
        ...triggerEnv,
        ...keys,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://requestport.com",
      });
      for (const name of ["DATABASE_URL", ...Object.keys(workerUrls)]) {
        expect(parsed).not.toHaveProperty(name);
      }
    });

    test("parses requestport-jobs' shape: the Postgres runner on pg, with the three and no DATABASE_URL", async () => {
      const { parseServerEnv } = await importServerWithEnv();

      expect(
        parseServerEnv({
          ...selfHost,
          REQUESTPORT_DATABASE_DRIVER: "pg",
          ...workerUrls,
        }),
      ).toEqual(parsedSelfHost);
    });

    test("starts, and the deferred configuration the worker reads parses, with no DATABASE_URL", async () => {
      const { serverEnv } = await importServerWithEnv({
        DATABASE_URL: undefined,
        ...workerUrls,
      });

      expect(serverEnv).toEqual(parsedWithoutDatabaseUrl);

      stubServerEnv({ DATABASE_URL: undefined, ...workerUrls });
      const deferred = await import("./server-deferred.js");

      expect(deferred.serverEnv.DATABASE_URL).toBeUndefined();
      expect(deferred.serverEnv.BETTER_AUTH_URL).toBe(
        requiredEnv.BETTER_AUTH_URL,
      );
    });

    test.each(
      Object.keys(workerUrls).flatMap((name) => [
        [
          name,
          "a URL of another scheme",
          "mysql://user:sentinel-password@localhost/db",
        ],
        [
          name,
          "a postgres URL naming no database",
          "postgres://user:sentinel-password@localhost",
        ],
        [name, "a value that is not a URL", "sentinel-password"],
      ]),
    )(
      "refuses %s set to %s, names it, and does not echo it",
      async (name, _label, value) => {
        const refusal = await refusalOf({
          ...withoutDatabaseUrl,
          ...workerUrls,
          [name]: value,
        });

        expect(refusal).toMatch(naming(name));
        expect(refusal).toMatch(/must be a postgres URL naming a database/u);
        expect(refusal).not.toContain("sentinel-password");
        expect(refusal).not.toMatch(naming("DATABASE_URL"));
      },
    );

    test.each(
      Object.keys(workerUrls).flatMap((name) => [
        [`${name} empty`, { ...workerUrls, [name]: "" }],
        [`${name} blank`, { ...workerUrls, [name]: "   " }],
        [`${name} unset`, { ...workerUrls, [name]: undefined }],
      ]),
    )(
      "reads a partial set as none, as @requestport/db refuses one, and requires DATABASE_URL: %s",
      async (_label, urls) => {
        const refusal = await refusalOf({ ...withoutDatabaseUrl, ...urls });

        expect(refusal).toMatch(naming("DATABASE_URL"));
        for (const name of Object.keys(workerUrls)) {
          expect(refusal).not.toMatch(naming(name));
        }
      },
    );

    test.each(["development", ""])(
      "still requires DATABASE_URL where VERCEL_ENV is %j: no worker runs on Vercel",
      async (vercelEnv) => {
        expect(
          await refusalOf({
            ...withoutDatabaseUrl,
            ...triggerEnv,
            ...workerUrls,
            VERCEL_ENV: vercelEnv,
          }),
        ).toMatch(naming("DATABASE_URL"));
      },
    );

    test("still refuses them where VERCEL_ENV is production, now first for the application login's URL", async () => {
      // Since I.2's step 5 a Vercel production configuration must name the
      // application login (`assertProductionApplicationLogin`), which is
      // asked before DATABASE_URL is. The worker's three stand in for
      // nothing there either.
      const refusal = await refusalOf({
        ...withoutDatabaseUrl,
        ...triggerEnv,
        ...workerUrls,
        VERCEL_ENV: "production",
      });

      expect(refusal).toMatch(naming("REQUESTPORT_APPLICATION_DATABASE_URL"));
      for (const name of Object.keys(workerUrls)) {
        expect(refusal).not.toMatch(naming(name));
      }
    });

    test("beside the application login's URL, that URL is the one judged, as before", async () => {
      const refusal = await refusalOf({
        ...withoutDatabaseUrl,
        ...workerUrls,
        REQUESTPORT_APPLICATION_DATABASE_URL: "sentinel-password",
      });

      expect(refusal).toMatch(naming("REQUESTPORT_APPLICATION_DATABASE_URL"));
      expect(refusal).not.toContain("sentinel-password");
    });

    // The schema restates the three because this package cannot import
    // `@requestport/db`; the cases above use these spellings, so a rename
    // there fails here.
    test("names the three as @requestport/db's WORKER_DATABASE_URL_VARIABLES spells them", () => {
      const source = readFileSync(
        new URL("../../db/src/tenant-context.ts", import.meta.url),
        "utf8",
      );
      const declared =
        source.match(
          /export const WORKER_DATABASE_URL_VARIABLES = Object\.freeze\(\{([^}]*)\}/u,
        )?.[1] ?? "";

      expect(
        [...declared.matchAll(/"(REQUESTPORT_[A-Z_]+)"/gu)].map(
          (match) => match[1],
        ),
      ).toEqual(Object.keys(workerUrls));
    });
  });

  describe("everything that names DATABASE_URL, or neither, is read as before", () => {
    test("refuses a configuration that names neither", async () => {
      const refusal = await refusalOf({
        ...withoutDatabaseUrl,
        REQUESTPORT_DATABASE_DRIVER: "pg",
      });

      expect(refusal).toMatch(/DATABASE_URL/u);
      expect(refusal).not.toMatch(/REQUESTPORT_APPLICATION_DATABASE_URL/u);
    });

    test.each([
      ["PGlite", { REQUESTPORT_DATABASE_DRIVER: "pglite" }],
      [
        "the application login",
        { REQUESTPORT_APPLICATION_DATABASE_URL: applicationUrl },
      ],
      ["the worker's three logins", workerUrls],
    ])(
      "judges a DATABASE_URL that is present, beside %s",
      async (_label, standIn) => {
        for (const value of [
          "",
          "mysql://localhost/db",
          "postgres://localhost",
        ]) {
          expect(
            await refusalOf({
              ...requiredEnv,
              ...standIn,
              DATABASE_URL: value,
            }),
          ).toMatch(/DATABASE_URL/u);
        }
      },
    );

    test.each([
      ["PGlite", { REQUESTPORT_DATABASE_DRIVER: "pglite" }],
      [
        "a valid application URL",
        { REQUESTPORT_APPLICATION_DATABASE_URL: applicationUrl },
      ],
      [
        "an application URL that is not one",
        { REQUESTPORT_APPLICATION_DATABASE_URL: "not-a-url" },
      ],
      ["the worker's three logins", workerUrls],
      [
        "a worker URL that is not one",
        { ...workerUrls, REQUESTPORT_DISPATCHER_DATABASE_URL: "not-a-url" },
      ],
    ])(
      "parses DATABASE_URL beside %s to the object it parsed to before",
      async (_label, standIn) => {
        const { parseServerEnv } = await importServerWithEnv();

        expect(parseServerEnv({ ...requiredEnv, ...standIn })).toEqual(
          requiredServerEnv,
        );
      },
    );

    /**
     * Worker-shaped, as Trigger.dev `prod`'s names were read (names only):
     * the owner's `DATABASE_URL` with `PG*` and `POSTGRES_*` beside it, and
     * no `REQUESTPORT_JOB_RUNNER`, `REQUESTPORT_DATABASE_DRIVER` or
     * `VERCEL_ENV` (`progress.md`, 2026-09-27; the driver's absence again in
     * `track-i2.md`, 2026-09-30); the three worker logins' URLs, imported on
     * 2026-10-02 (`environment-inventory.md`, "Worker database logins"); and
     * no `REQUESTPORT_APPLICATION_DATABASE_URL` (ruling 135, read on
     * 2026-10-04). The full list of the worker's names is not recorded in the
     * repository; these are the ones that bear on the database rule.
     */
    test("parses the Trigger.dev worker's shape to the object it parsed to before", async () => {
      const { parseServerEnv } = await importServerWithEnv();
      const ownerUrl =
        "postgres://appdb_owner:owner-password@ep-example-pooler.eu-central-1.aws.example.test/appdb?sslmode=require";

      expect(
        parseServerEnv({
          ...requiredEnv,
          ...triggerEnv,
          ...keys,
          ...workerUrls,
          NODE_ENV: "production",
          BETTER_AUTH_URL: "https://requestport.com",
          DATABASE_URL: ownerUrl,
          POSTGRES_URL: ownerUrl,
          PGHOST: "ep-example-pooler.eu-central-1.aws.example.test",
          PGUSER: "appdb_owner",
        }),
      ).toEqual({
        ...requiredServerEnv,
        ...triggerEnv,
        ...keys,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://requestport.com",
        DATABASE_URL: ownerUrl,
      });
    });

    /**
     * The same shape with the private receivers switch (Plan 13, H.10): it
     * carries no `VERCEL_ENV`, so the refusal under `VERCEL_ENV` cannot fire
     * there, and no `REQUESTPORT_JOB_RUNNER`, so the refusal unless that is
     * `postgres` does.
     */
    test("refuses the private receivers switch on the Trigger.dev worker's shape, which carries neither VERCEL_ENV nor REQUESTPORT_JOB_RUNNER", async () => {
      const { parseServerEnv } = await importServerWithEnv();
      const ownerUrl =
        "postgres://appdb_owner:owner-password@ep-example-pooler.eu-central-1.aws.example.test/appdb?sslmode=require";
      const worker = {
        ...requiredEnv,
        ...triggerEnv,
        ...keys,
        ...workerUrls,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://requestport.com",
        DATABASE_URL: ownerUrl,
        POSTGRES_URL: ownerUrl,
        PGHOST: "ep-example-pooler.eu-central-1.aws.example.test",
        PGUSER: "appdb_owner",
      };

      expect(worker).not.toHaveProperty("VERCEL_ENV");
      expect(worker).not.toHaveProperty("REQUESTPORT_JOB_RUNNER");
      expect(() =>
        parseServerEnv({
          ...worker,
          REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS: "enabled",
        }),
      ).toThrow(
        /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused unless REQUESTPORT_JOB_RUNNER is postgres/,
      );
    });

    /**
     * Vercel production as the Marketplace connection leaves it: the owner's
     * `DATABASE_URL` with `POSTGRES_*`, `PG*` and, where the hosted deployment
     * names one, its database project's id (`databaseProjectVariables` in
     * `scripts/hosted-deployment.mjs`) beside it
     * (`environment-inventory.md`), the Trigger.dev pair and both sign-in
     * methods, with the application login's URL that I.2's step 3 set
     * (2026-10-15) before step 6 removes the owner's. Without that URL, as
     * production was before step 3, it is refused since step 5.
     */
    const vercelProduction = (extra: Record<string, unknown>) => {
      const ownerUrl =
        "postgres://appdb_owner:owner-password@ep-example-pooler.eu-central-1.aws.example.test/appdb?sslmode=require";

      return {
        ownerUrl,
        env: {
          ...requiredEnv,
          ...triggerEnv,
          ...keys,
          ...extra,
          NODE_ENV: "production",
          BETTER_AUTH_URL: "https://requestport.com",
          DATABASE_URL: ownerUrl,
          POSTGRES_URL: ownerUrl,
          PGHOST: "ep-example-pooler.eu-central-1.aws.example.test",
          PGUSER: "appdb_owner",
          ...(databaseProjectVariables === null
            ? {}
            : {
                [databaseProjectVariables.production]:
                  "example-project-00000000",
              }),
          VERCEL_ENV: "production",
        },
      };
    };

    test("parses Vercel production as it is since I.2's step 3, with the application login's URL, to the object it parsed to before", async () => {
      const { parseServerEnv } = await importServerWithEnv();
      const { ownerUrl, env } = vercelProduction({
        REQUESTPORT_APPLICATION_DATABASE_URL: applicationUrl,
      });

      expect(parseServerEnv(env)).toEqual({
        ...requiredServerEnv,
        ...triggerEnv,
        ...keys,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://requestport.com",
        DATABASE_URL: ownerUrl,
      });
    });

    test("refuses Vercel production as it was before I.2's step 3, with no application login's URL, naming it", async () => {
      expect(await refusalOf(vercelProduction({}).env)).toMatch(
        /"REQUESTPORT_APPLICATION_DATABASE_URL"/u,
      );
    });
  });
});
