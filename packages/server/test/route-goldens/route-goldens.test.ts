/**
 * The pre-move goldens (Plan 13, H.1; manifest-h.md §2.2, Done when 1).
 *
 * Each family's route handlers, as `apps/web/src/app` holds them, answer a
 * fixed set of requests over B1's fakes (`fixtures.ts`), behind the web's
 * proxy as Next runs it (`apps/web/src/proxy.ts`; ruling 147), and each
 * answer is compared with the golden recorded from the routes before H.1
 * moved any of their bodies: the status, every header as Next serves it (the
 * proxy's over the route's, `next-proxy.ts`), the body's exact text, and
 * what the collaborators were asked (`harness.ts`). After each move, the
 * rebuilt routes must reproduce every golden byte for byte. The host,
 * `createRequestPortHost`, replays the goldens of every family (below), but
 * for two health cases it names, with their reasons.
 *
 * Recording: `REQUESTPORT_RECORD_ROUTE_GOLDENS=1` writes the six files from
 * whatever routes the tree holds, observing every case twice and refusing a
 * golden whose two observations still differ once `normalisation.ts` is
 * applied, or an entry there that names a field that never differed (then
 * `biome check --write` them, which reflows the JSON and changes no value).
 * They were recorded from the routes at 29a3aac6 (main, the merge of G.7a,
 * #198), behind the proxy at the same commit. Recording again is a
 * deliberate change to what neutrality is measured against, and belongs in a
 * commit of its own that says why. Two cases have been added since, each
 * the registry's new REST command, recorded on its branch: `POST
 * commands/resend_organization_invitation as an operator` (ruling 263), whose
 * recording changed no case already held, and `POST commands/assign_request
 * as an agent` (ruling 264), whose recording changed one: `tools/list with
 * every working agent scope` in the MCP family lists the new `assign_request`
 * tool, every other tool as it was.
 *
 * Turbo does not hash `apps/web` into this package's test task, so a cached
 * pass can outlive a change to a route: run this suite with `--force`, or
 * with Vitest directly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test, vi } from "vitest";
import { apiV1 } from "../../../../apps/web/src/test/api-v1/fake-database.js";
import { createRequestPortHost } from "../../src/host.js";
import {
  artifactImportCases,
  authCases,
  discoveryCases,
  healthCases,
  knownFingerprints,
  mcpCases,
  origin,
  restCases,
} from "./cases.js";
import {
  authStandIn,
  goldenState,
  importCall,
  readyCall,
  resetGoldenState,
} from "./fixtures.js";
import {
  differences,
  type GoldenCase,
  normalise,
  type Observation,
  observe,
  pathOf,
  type RouteModule,
  type Sources,
  type WebProxy,
} from "./harness.js";
import { proxyMatches } from "./next-proxy.js";
import { normalisation, normalisationFor } from "./normalisation.js";

vi.mock("@requestport/db", async () =>
  (await import("./fixtures.js")).goldenDatabaseModule(),
);
vi.mock(
  "@requestport/db/wiring",
  async () => (await import("./fixtures.js")).goldenWiringModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../../apps/web/src/test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock("@requestport/auth/server", async () =>
  (await import("./fixtures.js")).goldenAuthServerModule(),
);
vi.mock(
  "../../../../apps/web/src/lib/observability.js",
  async () =>
    (await import("../../../../apps/web/src/test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../../../apps/web/src/lib/trigger-client.js",
  async () =>
    (await import("../../../../apps/web/src/test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);

/*
  The rate limiter labels its rows with `VERCEL_ENV ?? NODE_ENV`, read per
  call. Fixed here, so a golden does not depend on the shell it was run from.
*/
vi.stubEnv("VERCEL_ENV", undefined);
vi.stubEnv("NODE_ENV", "test");

const { fakeObservabilityModule, fakeServerEnv, resetApiV1Fakes } =
  await import("../../../../apps/web/src/test/api-v1/fake-database.js");

const routes: Record<string, RouteModule> = {
  auth: await import("../../../../apps/web/src/app/api/auth/[...all]/route.js"),
  "authorization-server": await import(
    "../../../../apps/web/src/app/.well-known/oauth-authorization-server/route.js"
  ),
  "openid-configuration": await import(
    "../../../../apps/web/src/app/.well-known/openid-configuration/route.js"
  ),
  "protected-resource-api": await import(
    "../../../../apps/web/src/app/.well-known/oauth-protected-resource/api/v1/route.js"
  ),
  "protected-resource-mcp": await import(
    "../../../../apps/web/src/app/.well-known/oauth-protected-resource/mcp/route.js"
  ),
  rest: await import(
    "../../../../apps/web/src/app/api/v1/[[...path]]/route.js"
  ),
  "artifact-import": await import(
    "../../../../apps/web/src/app/api/v1/imports/artifacts/route.js"
  ),
  mcp: await import("../../../../apps/web/src/app/mcp/route.js"),
  "health-live": await import(
    "../../../../apps/web/src/app/api/health/live/route.js"
  ),
  "health-ready": await import(
    "../../../../apps/web/src/app/api/health/ready/route.js"
  ),
};

/*
  The web's proxy, which Next runs before every route its matcher covers
  (ruling 147): each case's response is what Next serves, the proxy's headers
  over the route's (`next-proxy.ts`). It is handed a `NextRequest`, as Next
  hands it one, from the `next` the web resolves.

  `proxy.ts` imports `next/server` as the web's bundler resolves it, which
  this package's NodeNext resolution cannot, so tsc here would refuse it. It
  is loaded by a specifier tsc does not follow and typed by what this file
  calls of it; `apps/web`'s own typecheck covers the module itself.
*/
const proxyModule: string = fileURLToPath(
  new URL("../../../../apps/web/src/proxy.ts", import.meta.url),
);
const { NextRequest } = (await import(
  pathToFileURL(
    createRequire(
      new URL("../../../../apps/web/package.json", import.meta.url),
    ).resolve("next/server"),
  ).href
)) as typeof import("../../../../apps/web/node_modules/next/server.js");
const webProxy = (await import(proxyModule)) as {
  proxy: (request: InstanceType<typeof NextRequest>) => Response;
  config: { matcher: string[] };
};
const proxy: WebProxy = {
  run: (request) => webProxy.proxy(new NextRequest(request)),
  covers: (pathname) => proxyMatches(webProxy.config.matcher, pathname),
};

/*
  The web's RequestPort (`server-web-request-port.ts`) is built once per
  module copy, the first time it is asked for, and the routes ask the same
  function. Its `execute` and `query` are watched, calling through, so a
  golden records what it received.
*/
const { webRequestPort } = await import(
  "../../../../apps/web/src/lib/server-web-request-port.js"
);
const port = webRequestPort();
const execute = vi.spyOn(port, "execute");
const query = vi.spyOn(port, "query");

const labels = knownFingerprints();

const sources: Sources = {
  recorders: () => [
    {
      name: "authenticate",
      mock: apiV1.authenticate,
      args: (args) => [args[1]],
    },
    { name: "rateLimit.consume", mock: apiV1.rateLimitConsume },
    { name: "requestPort.execute", mock: execute },
    { name: "requestPort.query", mock: query },
    ...Object.entries(apiV1.agentQueries).map(([name, mock]) => ({
      name: `agentQueries.${name}`,
      mock,
    })),
    ...Object.entries(apiV1.administrationReads).map(([name, mock]) => ({
      name: `administrationReads.${name}`,
      mock,
    })),
    { name: "registerProject", mock: apiV1.registerProject },
    { name: "receipts.lock", mock: apiV1.receipts.lock },
    { name: "receipts.find", mock: apiV1.receipts.find },
    { name: "receipts.save", mock: apiV1.receipts.save },
    { name: "dispatchCommittedEvents", mock: apiV1.dispatchCommittedEvents },
    {
      name: "triggerSlackConnectionTest",
      mock: apiV1.triggerSlackConnectionTest,
    },
    {
      name: "auth.handler",
      mock: authStandIn.handler,
      args: (_args, index) => [goldenState.authReceived[index]],
    },
    { name: "imports", mock: importCall },
    { name: "storage.ready", mock: readyCall },
  ],
  counters: () => ({
    ...(apiV1.portCalls.length > 0 ? { ports: apiV1.portCalls } : {}),
    ...(apiV1.transactionsRun > 0
      ? { transactions: apiV1.transactionsRun }
      : {}),
    ...(apiV1.readTransactionOrganizations.length > 0
      ? { readTransactionOrganizations: apiV1.readTransactionOrganizations }
      : {}),
    ...(apiV1.appendedEvents.length > 0
      ? { appendedEvents: apiV1.appendedEvents.length }
      : {}),
    ...(apiV1.metrics.length > 0 ? { metrics: apiV1.metrics } : {}),
  }),
  labels: () => labels,
  reset: () => {
    resetApiV1Fakes();
    resetGoldenState();
    execute.mockClear();
    query.mockClear();
  },
};

/*
  The readiness route in a process whose server configuration does not parse
  (ruling 140; `route.configuration.test.ts`): the configuration's module is
  loaded as itself, from a secret too short to parse, and the route afresh.
  It is the last case in the file, because it resets the module registry;
  every route above keeps the modules it was loaded with, and the
  configuration is mocked again once it has run.
*/
let savedSecret: string | undefined;
const invalidConfiguration: GoldenCase = {
  name: "GET /api/health/ready in a process whose server configuration does not parse: 503",
  route: "health-ready",
  method: "GET",
  request: () => new Request(`${origin}/api/health/ready`),
  arrange: () => {
    savedSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "too-short";
  },
  load: async () => {
    vi.doUnmock("@requestport/config/server");
    vi.resetModules();
    await expect(import("@requestport/config/server")).rejects.toMatchObject({
      name: "ZodError",
    });
    return import("../../../../apps/web/src/app/api/health/ready/route.js");
  },
  cleanup: () => {
    if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = savedSecret;
    vi.doMock(
      "@requestport/config/server",
      async () =>
        (await import("../../../../apps/web/src/test/api-v1/fake-database.js"))
          .fakeServerConfigModule,
    );
  },
};

const families: ReadonlyArray<readonly [string, readonly GoldenCase[]]> = [
  ["auth", authCases],
  ["discovery", discoveryCases],
  ["rest", restCases],
  ["artifact-import", artifactImportCases],
  ["mcp", mcpCases],
  ["health", [...healthCases, invalidConfiguration]],
];

const recordedFrom =
  "apps/web/src/app at 29a3aac6 (main, the merge of G.7a, #198), behind apps/web/src/proxy.ts as Next serves them (ruling 147)";
const recording = process.env.REQUESTPORT_RECORD_ROUTE_GOLDENS === "1";

type GoldenFile = {
  routes: string;
  normalisation: string[];
  cases: Observation[];
};

function goldenUrl(family: string) {
  return new URL(`./${family}.json`, import.meta.url);
}

function readGolden(family: string): GoldenFile {
  return JSON.parse(readFileSync(goldenUrl(family), "utf8")) as GoldenFile;
}

test("every case has a name of its own", () => {
  const names = families.flatMap(([family, cases]) =>
    cases.map((goldenCase) => `${family}: ${goldenCase.name}`),
  );
  expect(new Set(names).size).toBe(names.length);
});

test("every normalisation entry names a family that has a golden", () => {
  const known = new Set(families.map(([family]) => family));
  for (const entry of normalisation) expect(known).toContain(entry.family);
});

/*
  The host (Plan 13, H.1, slices b to e; manifest-h.md §5, Done when 1),
  composed by `createRequestPortHost` over the same fakes the routes run over,
  replays the goldens of every family: the auth family, discovery, REST, the
  artifact import, MCP and health. The goldens already hold what Next serves,
  the proxy's headers over the route's (ruling 147), and the host sets those
  headers itself, so its expectation is the golden, under the same
  normalisation. Beside that, the route's answer behind the proxy, observed
  again, must equal the host's: the consistency check. Neutrality is the
  golden's alone.

  The host is handed, from the `@requestport/auth/server` mocked above,
  Better Auth's stand-in `auth`, its two discovery handlers and B1's agent
  and API authenticators; the web's RequestPort, the one the REST and MCP
  routes ask for, whose `execute` and `query` are watched above; its
  storage from the mocked `@requestport/db/wiring`, whose `ready()` the
  admission records as `storage.ready` and whose `transaction` it counts;
  the configuration's secret as its fingerprint key; MCP's two switches as
  the MCP route judges them under this configuration (the modern leg off,
  as `REQUESTPORT_MCP_MODERN` is unset in B1's, and private telemetry as the
  web's workspace encryption is configured); and the observability fake's
  logger and metrics. Its rate limiter's repository and its import
  repository come from the mocked `@requestport/db`, which `packages/server`
  imports as the web does. It names no environment, so its rate limiter
  labels its rows `VERCEL_ENV ?? NODE_ENV`, fixed above, as the web's does.
  It runs before the route families below, because the health family's last
  case resets the module registry.
*/
const hostAuth = await import("@requestport/auth/server");
const { applicationStorageFromEnv } = await import("@requestport/db/wiring");
const { workspaceEncryption } = await import(
  "../../../../apps/web/src/lib/server-core-commands.js"
);
const host = createRequestPortHost({
  requestPort: port,
  auth: {
    auth: hostAuth.auth,
    authenticateAgentBearer: hostAuth.authenticateAgentBearer,
    authenticateApiBearer: hostAuth.authenticateApiBearer,
    oauthAuthorizationServerMetadata: hostAuth.oauthAuthorizationServerMetadata,
    oauthOpenIdConfiguration: hostAuth.oauthOpenIdConfiguration,
  },
  publicUrl: origin,
  storage: applicationStorageFromEnv(),
  secrets: { fingerprintKey: fakeServerEnv.BETTER_AUTH_SECRET },
  mcp: {
    modernProtocol:
      (fakeServerEnv as { REQUESTPORT_MCP_MODERN?: string })
        .REQUESTPORT_MCP_MODERN === "enabled",
    privateTelemetry: Boolean(workspaceEncryption),
  },
  logger: fakeObservabilityModule.webLogger,
  metrics: fakeObservabilityModule.webMetrics,
});
/** Every route's module, its methods answered by the host instead. */
const throughHost: Record<string, RouteModule> = Object.fromEntries(
  Object.keys(routes).map((name) => [
    name,
    { GET: host, POST: host, DELETE: host },
  ]),
);

/** The cases the host does not replay, each with its reason. */
const notReplayedByTheHost: Readonly<Record<string, string>> = {
  "GET /api/health/ready, the web root refusing its storage: 503":
    "the host is handed its storage, so there is no web root to refuse it",
  [invalidConfiguration.name]:
    "the host reads no configuration: its caller parses it before composing the host",
};

if (!recording) {
  describe("the host replays every family's goldens", () => {
    test("names each case it does not replay, and why", () => {
      const cases = families.flatMap(([, familyCases]) =>
        familyCases.map((goldenCase) => goldenCase.name),
      );
      expect(cases).toEqual(
        expect.arrayContaining(Object.keys(notReplayedByTheHost)),
      );
      // Health's 4 of 6, and every one of the auth family's 20, discovery's
      // 4, REST's 122, the artifact import's 15 and MCP's 12.
      expect(
        cases.filter((name) => !(name in notReplayedByTheHost)),
      ).toHaveLength(177);
    });

    for (const [family, cases] of families) {
      const golden = readGolden(family);
      test.each(
        cases
          .filter((goldenCase) => !(goldenCase.name in notReplayedByTheHost))
          .map((goldenCase) => [goldenCase.name, goldenCase] as const),
      )(
        `${family}: %s`,
        async (name, goldenCase) => {
          const expected = golden.cases.find(
            (recorded) => recorded.name === name,
          );
          const observed = normalise(
            family,
            await observe(goldenCase, throughHost, sources),
          );
          expect(observed.response.status).toBe(expected?.response.status);
          expect(observed.response.headers).toStrictEqual(
            expected?.response.headers,
          );
          expect(observed.response.body).toBe(expected?.response.body);
          expect(observed.admission).toStrictEqual(expected?.admission);
          expect(JSON.stringify(observed)).toBe(JSON.stringify(expected));

          // Consistency: the route, behind the proxy, over the same fakes.
          const route = normalise(
            family,
            await observe(goldenCase, routes, sources, proxy),
          );
          expect(JSON.stringify(observed)).toBe(JSON.stringify(route));
        },
        30_000,
      );
    }
  });
}

/*
  Ruling 149, settled by ruling 160 (item 7): the host follows `next start`'s
  header order, not Vercel's, and `host.ts` records the choice. For the two
  protected-resource documents the orders differ. The route's own
  `cache-control: public, max-age=300` is what Vercel serves (measured in
  production after #200; `docs/implementation/gotchas.md`, 2026-10-06) and
  what the bare goldens hold. The proxy's `private, no-store` is what
  `next start` serves (H.0b, K1a), what the proxied goldens hold, and what
  the host serves. The replay above already holds the host to the proxied
  goldens; this names the difference, so that a host moved to Vercel's order
  fails here by name. It runs before the families below, whose health
  family's last case resets the module registry.
*/
if (!recording) {
  describe("ruling 149: the host serves next start's header order, which Vercel does not", () => {
    const proxied = readGolden("discovery");
    const bare = JSON.parse(
      readFileSync(new URL("./bare/discovery.json", import.meta.url), "utf8"),
    ) as GoldenFile;
    const cacheControl = (observation: Observation | undefined) =>
      (observation?.response.headers ?? [])
        .filter(([name]) => name === "cache-control")
        .map(([, value]) => value);

    test.each([
      "GET /.well-known/oauth-protected-resource/api/v1",
      "GET /.well-known/oauth-protected-resource/mcp",
    ])(
      "%s: private, no-store through the host and behind the proxy; public, max-age=300 from the route alone, as Vercel serves it",
      async (name) => {
        const goldenCase = discoveryCases.find(
          (candidate) => candidate.name === name,
        );
        if (!goldenCase) throw new Error(`no discovery case named ${name}`);

        const throughTheHost = await observe(goldenCase, throughHost, sources);
        const behindTheProxy = await observe(
          goldenCase,
          routes,
          sources,
          proxy,
        );
        const routeAlone = await observe(goldenCase, routes, sources);

        expect(cacheControl(throughTheHost)).toEqual(["private, no-store"]);
        expect(cacheControl(behindTheProxy)).toEqual(["private, no-store"]);
        expect(
          cacheControl(
            proxied.cases.find((recorded) => recorded.name === name),
          ),
        ).toEqual(["private, no-store"]);
        expect(cacheControl(routeAlone)).toEqual(["public, max-age=300"]);
        expect(
          cacheControl(bare.cases.find((recorded) => recorded.name === name)),
        ).toEqual(["public, max-age=300"]);
      },
      30_000,
    );
  });
}

for (const [family, cases] of families) {
  describe(`${family}.json`, () => {
    if (recording) {
      test("records every case twice, and writes the golden", async () => {
        const recorded: Observation[] = [];
        const differed: Array<{ name: string; path: string }> = [];
        const residual: Array<{ name: string; path: string }> = [];
        for (const goldenCase of cases) {
          const first = await observe(goldenCase, routes, sources, proxy);
          const second = await observe(goldenCase, routes, sources, proxy);
          for (const path of differences(first, second)) {
            differed.push({ name: goldenCase.name, path });
          }
          for (const path of differences(
            normalise(family, first),
            normalise(family, second),
          )) {
            residual.push({ name: goldenCase.name, path });
          }
          recorded.push(normalise(family, first));
        }
        const named = new Set(normalisationFor(family).map(pathOf));
        expect(
          residual,
          "what still differed between the two recordings once the list was applied",
        ).toEqual([]);
        expect(
          [...named].filter(
            (path) => !differed.some((difference) => difference.path === path),
          ),
          "entries that name a field that never differed",
        ).toEqual([]);
        const file: GoldenFile = {
          routes: recordedFrom,
          normalisation: normalisationFor(family).map((entry) => entry.name),
          cases: recorded,
        };
        writeFileSync(goldenUrl(family), `${JSON.stringify(file, null, 2)}\n`);
      }, 300_000);
      return;
    }

    const golden = readGolden(family);

    test("the golden names the routes it was recorded from, and holds every case in order", () => {
      expect(golden.routes).toBe(recordedFrom);
      expect(golden.normalisation).toEqual(
        normalisationFor(family).map((entry) => entry.name),
      );
      expect(golden.cases.map((recorded) => recorded.name)).toEqual(
        cases.map((goldenCase) => goldenCase.name),
      );
    });

    test.each(
      cases.map((goldenCase) => [goldenCase.name, goldenCase] as const),
    )(
      "%s",
      async (name, goldenCase) => {
        const expected = golden.cases.find(
          (recorded) => recorded.name === name,
        );
        const observed = normalise(
          family,
          await observe(goldenCase, routes, sources, proxy),
        );
        expect(observed.request).toStrictEqual(expected?.request);
        expect(observed.response.status).toBe(expected?.response.status);
        expect(observed.response.headers).toStrictEqual(
          expected?.response.headers,
        );
        // The body's exact text: compared as a string, never re-serialised.
        expect(observed.response.body).toBe(expected?.response.body);
        expect(observed.response.bodyNotRead).toBe(
          expected?.response.bodyNotRead,
        );
        expect(observed.admission).toStrictEqual(expected?.admission);
        // As serialised text too, so a reordered key fails as surely as a value.
        expect(JSON.stringify(observed)).toBe(JSON.stringify(expected));
      },
      30_000,
    );
  });
}

/*
  The routes' own answers, without the proxy (ruling 148). The goldens above
  hold what Next serves, the proxy's headers over the route's (ruling 147), so
  a route's own `cache-control` is hidden behind the proxy's. Vercel's merge of
  a route's headers with the middleware's was never measured, so the routes
  are also replayed bare against the goldens as first recorded, at 366ad0a7
  (the ten routes at 29a3aac6, before ruling 147), under the same
  normalisation. The two cases added since are derived, and the replay below
  compares each with what the route answers bare: ruling 263's resend is
  `revoke_organization_invitation`'s bare entry under the new name, its
  proxied recording equalling revoke's under that substitution; ruling 264's
  assign is its proxied recording with the route's own headers, which every
  agent command's bare entry holds (`update_request`'s, taken). The MCP
  `tools/list` case's body, which the proxy does not touch, is the proxied
  recording's, with the new tool.
*/
if (!recording) {
  describe("the routes' own answers, without the proxy, against the recording before ruling 147", () => {
    for (const [family, cases] of families) {
      const bare = JSON.parse(
        readFileSync(new URL(`./bare/${family}.json`, import.meta.url), "utf8"),
      ) as GoldenFile;
      describe(family, () => {
        test("holds every case, in order", () => {
          expect(bare.cases.map((recorded) => recorded.name)).toEqual(
            cases.map((goldenCase) => goldenCase.name),
          );
        });
        test.each(
          cases.map((goldenCase) => [goldenCase.name, goldenCase] as const),
        )(
          "%s",
          async (name, goldenCase) => {
            const expected = bare.cases.find(
              (recorded) => recorded.name === name,
            );
            const observed = normalise(
              family,
              await observe(goldenCase, routes, sources),
            );
            expect(observed.response.headers).toStrictEqual(
              expected?.response.headers,
            );
            expect(JSON.stringify(observed)).toBe(JSON.stringify(expected));
          },
          30_000,
        );
      });
    }
  });
}
