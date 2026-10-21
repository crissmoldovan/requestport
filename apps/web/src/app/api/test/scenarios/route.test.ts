import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { E2E_TOKEN_HEADER, isE2EEmailMode } from "@requestport/auth/e2e";
import { createStorage, ownerCapableVariableNames } from "@requestport/db";
import { E2E_OWNER_DATABASE_URL_VARIABLE } from "@requestport/db/e2e";
import { testPool } from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { e2eScenarioFailures } from "../../../../lib/e2e-scenario.js";
import {
  E2E_SCENARIO_COOKIE,
  e2eScenarioFaultFor,
  forgetE2EScenarioRuns,
} from "../../../../lib/e2e-scenario-fault.js";
import { e2eScenarioRowKeys } from "../../../../lib/e2e-scenario-seed.js";
import { createScenarioRouteHandlers } from "../../../../test/e2e-scenarios.js";
import * as route from "./route.js";

const token = "scenario-token-that-is-at-least-thirty-two-characters";
const enabledEnv = {
  NODE_ENV: "development",
  REQUESTPORT_E2E_MODE: "1",
  REQUESTPORT_E2E_TOKEN: token,
};
const endpoint = "http://localhost:3100/api/test/scenarios";

/**
 * Exactly the headers the checked-in `pnpm dev:e2e` server puts on a
 * route-handler request.
 *
 * They were read off the running server rather than imagined. `Host` arrives
 * verbatim; Next injects the whole `x-forwarded-*` family from the socket it
 * accepted, and rebuilds the request URL from a normalised `localhost` whatever
 * `--hostname` the server was started with. A hand-built request that omits all
 * of that is not the request this route has to answer.
 */
const runtimeHeaders = {
  host: "127.0.0.1:3100",
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-host": "127.0.0.1:3100",
  "x-forwarded-port": "3100",
  "x-forwarded-proto": "http",
} as const;

/**
 * A request that reports every attempt to read its body.
 *
 * "404 before parsing" is an ordering claim, and an ordering claim cannot be
 * checked by looking at a status code: a handler that parsed first and then
 * refused would answer identically. So the body is watched instead, and the
 * guard's contract is that nothing ever touched it.
 */
function watchedRequest(
  init: {
    body?: string;
    headers?: Record<string, string | null>;
    method?: string;
    token?: string | null;
    url?: string;
  } = {},
) {
  const {
    body,
    headers: overrides = {},
    method = "POST",
    token: provided = token,
    url = endpoint,
  } = init;
  const headers = new Headers({
    "content-type": "application/json",
    ...runtimeHeaders,
  });
  if (provided !== null) headers.set(E2E_TOKEN_HEADER, provided);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }

  const request = new Request(url, { body, headers, method });
  const reads: string[] = [];
  const watched = new Proxy(request, {
    get(target, property) {
      if (
        ["arrayBuffer", "blob", "body", "formData", "json", "text"].includes(
          String(property),
        )
      ) {
        reads.push(String(property));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Request;

  return { reads, request: watched };
}

function scenarioRequest(scenario: unknown, overrides = {}) {
  return watchedRequest({ body: JSON.stringify({ scenario }), ...overrides });
}

const webRoot = resolve(import.meta.dirname, "../../../../..");
const repositoryRoot = resolve(webRoot, "../..");

function sourceModules() {
  return readdirSync(resolve(webRoot, "src"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) =>
      relative(webRoot, resolve(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
}

/** Exactly the modules the guarded hook is built from. */
const hookModules = [
  "src/lib/e2e-scenario-fault.ts",
  "src/lib/e2e-scenario-seed.ts",
  "src/lib/e2e-scenario.ts",
  "src/test/e2e-scenarios.ts",
];

describe("guarded local-only scenario route", () => {
  test("exports nothing but the HTTP handlers Next.js may call", () => {
    expect(Object.keys(route).sort()).toEqual(["DELETE", "POST"]);
  });

  test("is disabled in the ambient test environment, without reading a body", async () => {
    const { reads, request } = scenarioRequest("loading-boundary");

    const response = await route.POST(request);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test.each([
    ["a production environment", { ...enabledEnv, NODE_ENV: "production" }],
    ["a missing mode", { ...enabledEnv, REQUESTPORT_E2E_MODE: undefined }],
    ["a disabled mode", { ...enabledEnv, REQUESTPORT_E2E_MODE: "0" }],
    ["a missing token", { ...enabledEnv, REQUESTPORT_E2E_TOKEN: undefined }],
    ["a short token", { ...enabledEnv, REQUESTPORT_E2E_TOKEN: "too-short" }],
  ])("answers 404 for %s before parsing", async (_name, env) => {
    const handlers = createScenarioRouteHandlers({ env });
    const { reads, request } = scenarioRequest("loading-boundary");

    const response = await handlers.POST(request);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(reads).toEqual([]);
  });

  test.each([
    ["a missing token header", { token: null }],
    ["a wrong token header", { token: `${token}-wrong` }],
    ["an empty token header", { token: "" }],
  ])("answers 404 for %s before parsing", async (_name, overrides) => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });
    const { reads, request } = scenarioRequest("loading-boundary", overrides);

    const response = await handlers.POST(request);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test.each([
    ["a request that names no authority", { host: null }],
    ["a public authority", { host: "staging.requestport.com" }],
    ["a named loopback authority", { host: "localhost:3100" }],
    ["a private network authority", { host: "10.0.0.4:3100" }],
    ["a forwarded public client", { "x-forwarded-for": "203.0.113.7" }],
    [
      "a rewritten forwarded host",
      { "x-forwarded-host": "staging.requestport.com" },
    ],
    ["a terminated TLS hop", { "x-forwarded-proto": "https" }],
    ["a rewritten forwarded port", { "x-forwarded-port": "443" }],
    [
      "an RFC 7239 proxy",
      { forwarded: "for=203.0.113.7;host=staging.requestport.com;proto=https" },
    ],
  ])("answers 404 for %s before parsing", async (_name, headers) => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });
    const { reads, request } = scenarioRequest("loading-boundary", { headers });

    const response = await handlers.POST(request);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test.each([
    ["an empty body", ""],
    ["a fragment of JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON string", '"loading-boundary"'],
    ["an object with no case", "{}"],
    ["a numeric case", '{"scenario":7}'],
    ["an inherited property name", '{"scenario":"__proto__"}'],
    ["an uncatalogued case", '{"scenario":"drop-everything"}'],
  ])("answers the same 404 to %s", async (_name, body) => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });
    const { request } = watchedRequest({ body });

    const response = await handlers.POST(request);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  test("names a case only from the request body", async () => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });
    const { request } = watchedRequest({
      body: "{}",
      headers: {
        cookie: "requestport-scenario=loading-boundary",
        "x-requestport-scenario": "loading-boundary",
      },
      url: `${endpoint}?scenario=loading-boundary`,
    });

    const response = await handlers.POST(request);

    expect(response.status).toBe(404);
    expect(handlers.activeNamespaces()).toEqual([]);
  });

  test("opens a namespaced run for a catalogued case and releases it", async () => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });

    const opened = await handlers.POST(
      scenarioRequest("loading-boundary").request,
    );
    const body = (await opened.json()) as {
      fault: string;
      namespace: string;
      scenario: string;
    };

    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(body.fault).toBe("loading");
    expect(body.scenario).toBe("loading-boundary");
    expect(body.namespace).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(handlers.activeNamespaces()).toEqual([body.namespace]);

    const released = await handlers.DELETE(
      watchedRequest({
        body: JSON.stringify({ namespace: body.namespace }),
        method: "DELETE",
      }).request,
    );

    expect(released.status).toBe(204);
    expect(handlers.activeNamespaces()).toEqual([]);
  });

  test("refuses to release a namespace it never opened", async () => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });

    const response = await handlers.DELETE(
      watchedRequest({
        body: JSON.stringify({
          namespace: "11111111-2222-4333-8444-555555555555",
        }),
        method: "DELETE",
      }).request,
    );

    expect(response.status).toBe(404);
  });

  test("tells a release that the register which opened its run is gone", async () => {
    // `next dev` restarts itself when its heap crosses the share it watches,
    // and the register the hook keeps its open runs in dies with the process
    // that held it. A release that arrives afterwards is answered by a *fresh*
    // process which has never heard of the namespace — truthfully, and
    // indistinguishably from a driver closing a run it never opened. The two
    // are not the same event and must not share an answer: one leaves seeded
    // rows behind that the caller can still sweep, the other is a defect.
    //
    // So the open names the register that holds the run, the release names it
    // back, and a register that is not this one is `410`: the run is gone
    // because its register is.
    const opened = await createScenarioRouteHandlers({
      env: enabledEnv,
      server: "register-before-the-restart",
    }).POST(scenarioRequest("loading-boundary").request);
    const { namespace, server } = (await opened.json()) as {
      namespace: string;
      server: string;
    };

    expect(server).toBe("register-before-the-restart");

    const restarted = createScenarioRouteHandlers({
      env: enabledEnv,
      server: "register-after-the-restart",
    });
    const response = await restarted.DELETE(
      watchedRequest({
        body: JSON.stringify({ namespace, server }),
        method: "DELETE",
      }).request,
    );

    expect(response.status).toBe(410);
  });

  test("refuses a release naming its own register for a run it never opened", async () => {
    const handlers = createScenarioRouteHandlers({
      env: enabledEnv,
      server: "one-register",
    });

    // Same process, same register, unknown namespace: nothing was restarted and
    // the run being closed is not a run this hook ever opened. That is the
    // defect the `404` exists to report, and it stays a `404`.
    for (const named of [{ server: "one-register" }, {}]) {
      const response = await handlers.DELETE(
        watchedRequest({
          body: JSON.stringify({
            namespace: "11111111-2222-4333-8444-555555555555",
            ...named,
          }),
          method: "DELETE",
        }).request,
      );

      expect(response.status).toBe(404);
    }
  });

  test("guards the release with the same predicate, before parsing", async () => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });
    const { reads, request } = watchedRequest({
      body: JSON.stringify({
        namespace: "11111111-2222-4333-8444-555555555555",
      }),
      method: "DELETE",
      token: null,
    });

    const response = await handlers.DELETE(request);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test("records created rows and removes them in reverse key order", async () => {
    const deleted: { ids: readonly string[]; table: string }[] = [];
    const handlers = createScenarioRouteHandlers({
      deleteRows: async (batch) => {
        deleted.push({ ids: [...batch.ids], table: batch.table });
      },
      env: enabledEnv,
      seedRows: async ({ run }) => {
        run.record("organizations", `organization-${run.namespace}`);
        run.record("projects", `project-${run.namespace}`);
      },
    });

    const opened = await handlers.POST(
      scenarioRequest("scenario-cleanup").request,
    );
    const { namespace } = (await opened.json()) as { namespace: string };
    await handlers.DELETE(
      watchedRequest({
        body: JSON.stringify({ namespace }),
        method: "DELETE",
      }).request,
    );

    expect(opened.status).toBe(200);
    expect(deleted).toEqual([
      { ids: [`project-${namespace}`], table: "projects" },
      { ids: [`organization-${namespace}`], table: "organizations" },
    ]);
  });

  test("reports the fixed failure when a row-creating case has no wired seeder", async () => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });

    const response = await handlers.POST(
      scenarioRequest("seeded-owner-identity").request,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      failure: e2eScenarioFailures.seed,
    });
    expect(handlers.activeNamespaces()).toEqual([]);
  });

  test("records the open run where the adapters read it, and forgets it", async () => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });
    const reading = (namespace: string) =>
      e2eScenarioFaultFor({
        cookieHeader: `${E2E_SCENARIO_COOKIE}=${namespace}`,
        env: enabledEnv,
      });

    const opened = await handlers.POST(
      scenarioRequest("loading-boundary").request,
    );
    const { namespace } = (await opened.json()) as { namespace: string };

    // What the browser will carry is this namespace and nothing else; the fault
    // it means lives here, where the guard has already run.
    expect(reading(namespace)).toBe("loading");

    await handlers.DELETE(
      watchedRequest({
        body: JSON.stringify({ namespace }),
        method: "DELETE",
      }).request,
    );

    expect(reading(namespace)).toBeNull();
  });

  test("records nothing for a request it refuses", async () => {
    const handlers = createScenarioRouteHandlers({ env: enabledEnv });
    forgetE2EScenarioRuns(enabledEnv);

    for (const refused of [
      scenarioRequest("drop-everything", { token: null }),
      scenarioRequest("drop-everything"),
      watchedRequest({ body: "{" }),
    ]) {
      expect((await handlers.POST(refused.request)).status).toBe(404);
    }

    expect(handlers.activeNamespaces()).toEqual([]);
  });

  test("is reachable from the guarded route and from nothing else", () => {
    const importers = sourceModules().filter((file) => {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return false;
      // The hook's own modules: the lifecycle primitive, the closed catalogue,
      // and the executor that turns a row-creating case into rows. Each is part
      // of the hook rather than a consumer of it, and each is covered by its own
      // suite; what this rule is about is that nothing *else* in the
      // application can reach them.
      if (hookModules.includes(file)) return false;
      const source = readFileSync(resolve(webRoot, file), "utf8");
      return (
        source.includes("e2e-scenario.js") ||
        source.includes("e2e-scenarios.js")
      );
    });

    expect(importers).toEqual(["src/app/api/test/scenarios/route.ts"]);
  });
});

/* ------------------------------------------------------------------ *
 * The lifecycle itself.
 * ------------------------------------------------------------------ */

/**
 * The binding the checked-in `pnpm dev:e2e` script declares.
 *
 * It is read rather than repeated, so a test that starts "the server" starts
 * the one the acceptance lifecycle starts, on the interface the lifecycle
 * binds. The interface is the half this proof depends on — the guard accepts a
 * literal loopback authority and refuses every other one — while the port
 * below is deliberately not the declared one; see `declaredPortHolder`.
 */
const webManifest = JSON.parse(
  readFileSync(resolve(webRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const bound = /--hostname (\S+) --port (\d+)/u.exec(
  webManifest.scripts["dev:e2e"] ?? "",
);
const boundHost = bound?.[1] ?? "";
const boundPort = Number(bound?.[2] ?? 0);
const boundOrigin = `http://${boundHost}:${boundPort}`;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const startBudgetMs = 150_000;

type LiveAnswer = Readonly<{ status: number; text: string }>;

/**
 * One HTTP request to the running server, written at the socket.
 *
 * A `Request` object built in this process is not evidence about a route
 * handler: the runtime decides what a handler is handed, and the whole defect
 * this suite exists to catch lived in that gap. Going over the wire also makes
 * the authority and the forwarded family settable one at a time, which a
 * `fetch` in a browser-shaped client would refuse to do.
 */
function liveRequest(
  init: Readonly<{
    body?: string;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
  }> = {},
): Promise<LiveAnswer> {
  const {
    body = "",
    headers = {},
    method = "POST",
    path = "/api/test/scenarios",
  } = init;

  return new Promise((answer, refuse) => {
    const payload = Buffer.from(body, "utf8");
    const call = httpRequest(
      {
        headers: {
          "content-length": String(payload.byteLength),
          "content-type": "application/json",
          ...headers,
        },
        host: boundHost,
        method,
        path,
        port: livePort,
      },
      (received) => {
        const chunks: Buffer[] = [];
        received.on("data", (chunk: Buffer) => chunks.push(chunk));
        received.on("end", () => {
          answer({
            status: received.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    call.on("error", refuse);
    call.end(payload);
  });
}

/**
 * The loopback port this run's server is actually reachable on.
 *
 * `0` until `startLifecycleServer` has picked one, which happens before any
 * case in the lifecycle suite runs.
 */
let livePort = 0;

/**
 * A loopback port nothing else on this host is listening on.
 *
 * The kernel picks it: a socket is bound to port 0, its number read back, and
 * the socket released before the server is handed the same number. The window
 * between the release and the server's own bind is the price of not parsing a
 * port out of the server's log output, and a loss there is reported as the
 * start-up timeout below with the server's own "port is in use" line attached.
 */
function reserveEphemeralPort(): Promise<number> {
  return new Promise((answer, refuse) => {
    const socket = createServer();
    socket.once("error", refuse);
    socket.listen({ host: boundHost, port: 0 }, () => {
      const address = socket.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      socket.close(() => {
        if (port === 0) refuse(new Error("no ephemeral port was available"));
        else answer(port);
      });
    });
  });
}

/**
 * Whatever is holding the lifecycle's *declared* port while this proof runs.
 *
 * Held on purpose, for the whole of the proof. `pnpm dev:e2e` binds 3100 and
 * so does the Playwright web server, so a developer with the acceptance server
 * already up, a second concurrent `pnpm test`, or two CI jobs sharing one
 * runner each made this suite red for a reason that has nothing to do with the
 * route. Occupying the port here is what keeps that from coming back: the
 * server below has to find an address of its own, and the day it goes back to
 * the declared one this is what it collides with.
 *
 * A bind that fails is not a failure. Something else already holding the port
 * is the very condition being reproduced, and there is then nothing to release.
 */
let declaredPortHolder: Server | null = null;

function holdDeclaredPort(): Promise<void> {
  return new Promise((held) => {
    const holder = createServer();
    holder.once("error", () => {
      declaredPortHolder = null;
      held();
    });
    holder.listen({ host: boundHost, port: boundPort }, () => {
      declaredPortHolder = holder;
      held();
    });
  });
}

function releaseDeclaredPort(): Promise<void> {
  const holder = declaredPortHolder;
  declaredPortHolder = null;
  if (holder === null) return Promise.resolve();

  return new Promise((released) => {
    holder.close(() => {
      released();
    });
  });
}

let lifecycleServer: ChildProcess | null = null;
let lifecycleToken = "";
let lifecycleOutput = "";
let lifecycleStopped: string | null = null;

/**
 * The one start-up refusal this proof can neither route around nor rebind.
 *
 * Next 16 allows a single `next dev` per *project directory*, and the port each
 * is given makes no difference to that: the second process prints its address,
 * reports "Another next dev server is already running" with the first one's PID,
 * and exits. An ephemeral port therefore buys what a port can buy — this suite
 * no longer needs 3100, so it coexists with anything else bound there and two
 * checkouts on one machine can run it at once — and nothing more. Two runs
 * against *this* directory remain one at a time, which is Next's rule rather
 * than this suite's, and is recorded as gotcha 0e.
 *
 * What is fixed here is the report. The condition used to surface as a
 * 150-second wait ending in a wall of captured output; it now ends the moment
 * the server exits, and says which server to stop.
 */
function developmentServerCollision(): string {
  return lifecycleOutput.includes("Another next dev server is already running")
    ? "Next 16 allows one `next dev` per project directory whatever port each is given, so this proof cannot start its own server while another one is running against apps/web. Stop that server — `pnpm dev`, `pnpm dev:e2e`, a Playwright acceptance run, or a second `pnpm test` — and run this again."
    : "";
}

async function startLifecycleServer() {
  // The interface is what the guard rules on: it accepts a literal loopback
  // authority and refuses every other, so a server bound anywhere else would be
  // refused for a reason that has nothing to do with this route. The port is
  // not part of that ruling — the guard compares a forwarded port against the
  // authority the caller addressed, never against a number — so this run takes
  // one of its own.
  expect(boundHost).toBe("127.0.0.1");
  livePort = await reserveEphemeralPort();
  const liveOrigin = `http://${boundHost}:${livePort}`;

  // The runner is plain JavaScript with no declaration file, so the specifier
  // is built rather than spelled: a literal would make the type checker refuse
  // the import outright, and an absolute file URL keeps the bundler from
  // resolving a repository-relative path against its own root.
  const runnerModule = pathToFileURL(
    resolve(repositoryRoot, "scripts/run-foundation-e2e.mjs"),
  ).href;
  const { createFoundationE2EEnvironment } = (await import(
    /* @vite-ignore */ runnerModule
  )) as {
    createFoundationE2EEnvironment: (input?: {
      baseEnvironment?: Record<string, string | undefined>;
    }) => Record<string, string | undefined>;
  };
  const runner = createFoundationE2EEnvironment();
  lifecycleToken = runner.REQUESTPORT_E2E_TOKEN ?? "";

  // The server is an application process, so since I.2 step 7 it is handed
  // no owner-capable name (ruling 224 item 3), as the acceptance server is
  // (`scripts/start-e2e-server.mjs`): its web root's storage would be
  // refused at its first use beside one. It connects as a login of its own
  // instead (`createLifecycleLogin`), and the hook's owner storage reads the
  // owner's URL under its own name. The readiness case below fails if the
  // server is handed such a name again, or no login.
  const ownerUrl = runner.DATABASE_URL ?? "";
  const serverEnvironment = { ...runner };
  for (const name of ownerCapableVariableNames(runner as NodeJS.ProcessEnv)) {
    delete serverEnvironment[name];
  }
  const applicationUrl = await createLifecycleLogin(ownerUrl);

  // The checked-in script runs verbatim, with one flag appended. Two tool
  // behaviours make that work and both were checked rather than assumed: pnpm
  // forwards trailing arguments to the script as they are — a `--` separator is
  // passed through literally, and `next` then reads it as a project directory
  // and exits — and `next dev` takes the last `--port` it is given, so the
  // script's own `--port 3100` is overridden rather than fought with.
  lifecycleServer = spawn(
    "pnpm",
    ["--filter", "@requestport/web", "dev:e2e", "--port", String(livePort)],
    {
      cwd: repositoryRoot,
      detached: true,
      env: {
        ...serverEnvironment,
        REQUESTPORT_APPLICATION_DATABASE_URL: applicationUrl,
        [E2E_OWNER_DATABASE_URL_VARIABLE]: ownerUrl,
        // Exactly the overrides `playwright.config.ts` hands its web server,
        // at the address this run bound.
        BETTER_AUTH_URL: liveOrigin,
        NEXT_PUBLIC_APP_URL: liveOrigin,
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [lifecycleServer.stdout, lifecycleServer.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      lifecycleOutput += chunk.toString("utf8");
    });
  }
  lifecycleStopped = null;
  lifecycleServer.once("exit", (code, signal) => {
    lifecycleStopped = `dev:e2e exited before it answered (code ${code ?? "none"}, signal ${signal ?? "none"})`;
  });

  const failed = (why: string) =>
    new Error(
      [why, developmentServerCollision(), lifecycleOutput.slice(-2000)]
        .filter(Boolean)
        .join("\n"),
    );

  const deadline = Date.now() + startBudgetMs;
  for (;;) {
    try {
      await liveRequest({ body: "{}" });
      return;
    } catch (error) {
      // A server that has already exited will never answer, and waiting out the
      // whole budget for it turns a one-line cause into a timeout that names
      // nothing.
      if (lifecycleStopped !== null) throw failed(lifecycleStopped);
      if (Date.now() > deadline) {
        throw failed(`dev:e2e never answered: ${String(error)}`);
      }
      await new Promise((wake) => setTimeout(wake, 250));
    }
  }
}

function stopLifecycleServer() {
  const running = lifecycleServer?.pid;
  lifecycleServer = null;
  lifecycleStopped = null;
  if (running === undefined) return;
  // `pnpm` is the child; `next` is its child. Signalling the group is what
  // stops both, so a run cannot leave the port bound behind it.
  try {
    process.kill(-running, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/**
 * This suite's own storage, built from this process's environment, as each
 * test lane sets it, for `countSeededRows` below and the lifecycle server's
 * login. It opens nothing until the lifecycle asks, and that closes it when
 * it ends.
 */
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

/**
 * The lifecycle server's application login (Plan 13, I.2 step 7), made as
 * the acceptance server's is (`scripts/start-e2e-server.mjs`): on this run's
 * database, by the owner this suite's storage connects as, a member of
 * `requestport_application` and nothing else, named from the database
 * (`<first 40 characters>_e2e_hook`) so tracks sharing a server never
 * collide, with a password made for this run, never written down and stored
 * with one SCRAM iteration, and replacing one a stopped run left.
 *
 * Dropped by the lifecycle's `afterAll`, before the server is stopped:
 * Vitest runs after hooks in reverse (`sequence.hooks` is `stack`), and
 * `stopLifecycleServer` is registered first, so it runs last. The server may
 * still hold sessions as the login when it is dropped; PostgreSQL drops a
 * login whose sessions are open, and they end when the server stops. A drop
 * that fails is left to the next run's replacement.
 */
let lifecycleLogin: string | null = null;

async function createLifecycleLogin(ownerUrl: string): Promise<string> {
  const pool = testPool(suiteStorage);
  const { rows } = await pool.query<{ role: string; ident: string }>(
    "SELECT left(current_database(), 40) || '_e2e_hook' AS role, quote_ident(left(current_database(), 40) || '_e2e_hook') AS ident",
  );
  const { role, ident } = rows[0] as { role: string; ident: string };
  const password = randomBytes(24).toString("hex");

  await pool.query(`DROP ROLE IF EXISTS ${ident}`);
  // One statement string, so one connection: the password is stored with one
  // SCRAM iteration, as the other local logins are, and the setting ends
  // with the transaction.
  await pool.query(
    `BEGIN; SET LOCAL scram_iterations = 1; CREATE ROLE ${ident} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION IN ROLE requestport_application; COMMIT`,
  );
  lifecycleLogin = ident;

  const url = new URL(ownerUrl);
  url.username = encodeURIComponent(role);
  url.password = encodeURIComponent(password);
  return url.toString();
}

async function dropLifecycleLogin() {
  const ident = lifecycleLogin;
  lifecycleLogin = null;
  if (ident === null) return;
  try {
    await testPool(suiteStorage).query(`DROP ROLE IF EXISTS ${ident}`);
  } catch {
    // Left for the next run's DROP ROLE IF EXISTS.
  }
}

/**
 * How many of the rows a run reported still exist, asked of the database the
 * server wrote them to.
 *
 * The key column differs by table — an organization's appearance default is
 * keyed by the organization — so the deleter's own map is reused rather than a
 * second idea of what addresses a row.
 */
async function countSeededRows(
  rows: readonly { id: string; table: string }[],
): Promise<{ found: number; table: string }[]> {
  const counted: { found: number; table: string }[] = [];

  for (const row of rows) {
    const key =
      e2eScenarioRowKeys[row.table as keyof typeof e2eScenarioRowKeys];
    const found = await testPool(suiteStorage).query<{ present: string }>(
      `SELECT count(*) AS "present" FROM "public"."${row.table}" WHERE "${key}"::text = $1`,
      [row.id],
    );
    counted.push({
      found: Number(found.rows[0]?.present ?? 0),
      table: row.table,
    });
  }

  return counted;
}

/**
 * The lifecycle the plan requires this hook to satisfy, exercised rather than
 * described.
 *
 * The predicate used to be checked against a `Request` this file built, which
 * differed from the runtime's in exactly the two ways that made the guard
 * refuse everything — a literal `127.0.0.1` in the URL, and none of the
 * `x-forwarded-*` headers Next injects. It passed for the whole of the hook's
 * implementation while the hook answered nothing. So the server is started the
 * way `pnpm dev:e2e` starts it, with the token the runner generates and the
 * environment `playwright.config.ts` supplies, and the answers below are the
 * answers that server gave.
 */
describe("the guarded hook under the real dev:e2e lifecycle", () => {
  beforeAll(holdDeclaredPort);
  beforeAll(startLifecycleServer, startBudgetMs + 30_000);
  afterAll(stopLifecycleServer);
  afterAll(releaseDeclaredPort);
  afterAll(() => suiteStorage.close());
  // After hooks run in reverse (Vitest's `stack`): this drop runs before
  // the storage it uses is closed.
  afterAll(dropLifecycleLogin);

  /*
   * The web root's application storage, answering. Readiness
   * (`/api/health/ready`) answers 200 only when a query through that storage
   * passes the role guard and is answered, and no other case here depends on
   * that storage. Beside an owner-capable name the guard refuses the query,
   * and without an application login the storage has nothing to connect
   * through; readiness answers 503 either way, and its console line, with
   * any guard line, says why.
   */
  test("answers readiness 200 from the server's own application login, beside no owner-capable name", async () => {
    const ready = await liveRequest({
      method: "GET",
      path: "/api/health/ready",
    });
    const why =
      ready.status === 200
        ? []
        : lifecycleOutput
            .split("\n")
            .filter((line) =>
              /RequestPort readiness|RequestPort database|role_guard/u.test(
                line,
              ),
            );

    expect({ status: ready.status, why }).toEqual({ status: 200, why: [] });
  });

  test("opens a namespaced run for a real POST and releases it", async () => {
    const opened = await liveRequest({
      body: JSON.stringify({ scenario: "loading-boundary" }),
      headers: { [E2E_TOKEN_HEADER]: lifecycleToken },
    });

    expect({ status: opened.status, text: opened.text.slice(0, 120) }).toEqual({
      status: 200,
      text: opened.text.slice(0, 120),
    });

    const body = JSON.parse(opened.text) as {
      fault: string;
      namespace: string;
      scenario: string;
    };

    expect(body.scenario).toBe("loading-boundary");
    expect(body.fault).toBe("loading");
    expect(body.namespace).toMatch(uuid);

    const released = await liveRequest({
      body: JSON.stringify({ namespace: body.namespace }),
      headers: { [E2E_TOKEN_HEADER]: lifecycleToken },
      method: "DELETE",
    });

    expect(released.status).toBe(204);
  });

  test("answers the same 404 to every refused shape", async () => {
    const catalogued = JSON.stringify({ scenario: "loading-boundary" });
    const carrying = (extra: Record<string, string> = {}) => ({
      [E2E_TOKEN_HEADER]: lifecycleToken,
      ...extra,
    });
    // "404 before parsing" cannot be watched from outside the process, so the
    // shapes below include the two bodies a parser would fail on: a handler
    // that read first would have to answer one of them differently.
    const refused = [
      ["no token", { body: catalogued, headers: {} }],
      [
        "a wrong token",
        {
          body: catalogued,
          headers: { [E2E_TOKEN_HEADER]: `${lifecycleToken}-wrong` },
        },
      ],
      ["a crashing body with no token", { body: "{", headers: {} }],
      ["a crashing body with the token", { body: "{", headers: carrying() }],
      [
        "an uncatalogued case",
        {
          body: JSON.stringify({ scenario: "drop-everything" }),
          headers: carrying(),
        },
      ],
      [
        "a public authority",
        {
          body: catalogued,
          headers: carrying({ host: "staging.requestport.com" }),
        },
      ],
      [
        "a named loopback authority",
        {
          body: catalogued,
          headers: carrying({ host: `localhost:${livePort}` }),
        },
      ],
      [
        "a forwarded public client",
        {
          body: catalogued,
          headers: carrying({ "x-forwarded-for": "203.0.113.7" }),
        },
      ],
      [
        "a rewritten forwarded host",
        {
          body: catalogued,
          headers: carrying({ "x-forwarded-host": "staging.requestport.com" }),
        },
      ],
      [
        "a terminated TLS hop",
        {
          body: catalogued,
          headers: carrying({ "x-forwarded-proto": "https" }),
        },
      ],
      [
        "a rewritten forwarded port",
        { body: catalogued, headers: carrying({ "x-forwarded-port": "443" }) },
      ],
      [
        "an RFC 7239 proxy",
        {
          body: catalogued,
          headers: carrying({
            forwarded:
              "for=203.0.113.7;host=staging.requestport.com;proto=https",
          }),
        },
      ],
      [
        "a release of a namespace nothing opened",
        {
          body: JSON.stringify({
            namespace: "11111111-2222-4333-8444-555555555555",
          }),
          headers: carrying(),
          method: "DELETE",
        },
      ],
    ] as const;

    const answered: Record<string, number> = {};
    for (const [name, init] of refused) {
      answered[name] = (await liveRequest(init)).status;
    }

    expect(answered).toEqual(
      Object.fromEntries(refused.map(([name]) => [name, 404])),
    );
  });

  test("creates the rows a seeded case declares, and removes them again", async () => {
    const opened = await liveRequest({
      body: JSON.stringify({ scenario: "seeded-owner-identity" }),
      headers: { [E2E_TOKEN_HEADER]: lifecycleToken },
    });

    // The whole point of the wired executor: a seeded case answers with a
    // namespace *and* with the rows it created. The unwired default answers 500
    // with the fixed seed failure instead of pretending to have seeded, so this
    // reads the status first — a 500 here says the port is not wired, and the
    // row assertions below would otherwise fail for a reason that sounds like a
    // database problem.
    expect({ status: opened.status, text: opened.text.slice(0, 200) }).toEqual({
      status: 200,
      text: opened.text.slice(0, 200),
    });

    const body = JSON.parse(opened.text) as {
      namespace: string;
      rows: { id: string; table: string }[];
    };

    expect(body.namespace).toMatch(uuid);
    expect(body.rows.map((row) => row.table)).toEqual([
      "signup_allowlist",
      "user",
      "organizations",
      "organization_members",
      "organization_appearance_defaults",
    ]);

    // The database is asked, not the response. A hook that recorded a ledger
    // entry for a row it never wrote would answer exactly the same JSON.
    expect(await countSeededRows(body.rows)).toEqual(
      body.rows.map((row) => ({ found: 1, table: row.table })),
    );

    const released = await liveRequest({
      body: JSON.stringify({ namespace: body.namespace }),
      headers: { [E2E_TOKEN_HEADER]: lifecycleToken },
      method: "DELETE",
    });

    expect(released.status).toBe(204);
    expect(await countSeededRows(body.rows)).toEqual(
      body.rows.map((row) => ({ found: 0, table: row.table })),
    );
  });

  test("points the browser suite at exactly that origin", () => {
    const config = readFileSync(
      resolve(webRoot, "playwright.config.ts"),
      "utf8",
    );

    expect(config).toContain(`const baseURL = "${boundOrigin}";`);
    expect(config).toContain('REQUESTPORT_E2E_MODE: "1"');

    // The mode the configuration hands its server is read back out of the
    // configuration and put to the fence itself, rather than compared against a
    // second copy of the answer written here. The lanes used to be handed
    // `development` because they ran `next dev`; they are handed `test` now
    // that they run a built server, and the thing that has to stay true across
    // that change is not either spelling — it is that whatever is handed over
    // is a mode `isE2EEmailMode` admits. A literal pinned here would have to be
    // edited to match any such change, which is exactly when it would stop
    // being a check.
    const handedMode = /^\s*NODE_ENV: "([^"]+)",$/mu.exec(config)?.[1];

    expect(handedMode).toBeTypeOf("string");
    expect(
      isE2EEmailMode({
        NODE_ENV: handedMode,
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: "a".repeat(32),
      }),
    ).toBe(true);
    // Planted: the same reader against the one mode the fence must refuse, so a
    // regex that matched nothing—or a fence that admitted everything—fails here
    // rather than passing the check above by accident.
    expect(
      isE2EEmailMode({
        NODE_ENV: "production",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: "a".repeat(32),
      }),
    ).toBe(false);
  });
});
