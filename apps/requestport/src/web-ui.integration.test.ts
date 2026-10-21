import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createTestStorage, rawQuery } from "@requestport/db/testing";
import { instanceLoginNames } from "@requestport/db/wiring";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { defaultSelfHostWebDirectory, locateSelfHostWeb } from "./serve/web.js";
import {
  credentialsIn,
  type Finished,
  freePort,
  runStart,
} from "./test-support/start-process.js";
import { scanSelfHostBuild } from "./test-support/web-ui-build.js";
import type {
  Construction,
  WebUiCounters,
} from "./test-support/web-ui-counters.js";
import {
  actionIdsOf,
  headingOf,
  WebUiDriver,
} from "./test-support/web-ui-drive.js";

/*
 * Done when 11 (manifest-h.md §2.7.1, §2.7.4's K1 and K10; rulings 143, 145
 * and 160): `requestport start` serves the web UI beside its host, Next's
 * request handler over the self-host build, in one process, on pg and on
 * PGlite, with one instance of each stateful object.
 *
 * Each start runs as a process of its own through
 * `test-support/web-ui.test-entry.ts`, which installs
 * `web-ui-counters.ts` before anything else loads. What is counted, and
 * where, is that module's: every storage built in the process (each copy of
 * `@requestport/db` records one handle per storage in a map they share), each
 * pg pool and PGlite engine constructed through Node's `require`, every
 * Better Auth instance built by any copy of better-auth, the handed Better
 * Auth's initialisations, and each marked webpack module's evaluations by
 * module id. A storage is attributed to the module copy that built it by
 * its call sites: the host's `packages/db/src/client.ts`, or a module id in
 * Next's server output (`web-ui-build.ts`, which reads the build without
 * running it); a Better Auth instance, likewise, to the host's
 * `better-auth/dist/auth/base.mjs` or a module id in Next's output.
 *
 * The self-host build is the integration project's global setup's
 * (`web/self-host-build.global-setup.ts`; ruling 160, item 2): it is built
 * when stale, and this suite fails, never skips, without it.
 *
 * Per storage, one instance and seven starts: the drive, with the error
 * paths (K10); the error paths again with the brand and the name taken away,
 * which must then fail; the handoff without each of its three members in
 * turn, each answered by the reader in Next's copy that reads it; Next's
 * copies of Better Auth's installer made to ignore the handoff, so that
 * `createAuth`'s own gate in Next's copy answers; and a GitHub and a Resend
 * pair in the start's environment, which the start removes.
 * The pg instance's database and owner carry the run's name and are dropped,
 * with the instance's logins, in `afterAll`, which checks that none is left
 * (ruling 158, item 15). Data directories are under this run's default
 * temporary directory, with a space in their names (ruling 152). The public
 * URL is http on loopback, as `requestport start` defaults to; the commands
 * driven fail or create a project, and none creates a notification intent,
 * which dead-letters on an http public URL (H.4, slice c).
 */

const SERVER = join(defaultSelfHostWebDirectory(), ".next-self-host", "server");
const workspace = resolve(import.meta.dirname, "..");
const hostClient = resolve(workspace, "../../packages/db/src/client.ts");
/** The host's copy of better-auth's `createBetterAuth`, wherever pnpm put it. */
const isHostBetterAuth = (file: string) =>
  /\/node_modules\/better-auth\/dist\/auth\/base\.mjs$/u.test(file);

/** One marker per module whose copies Done when 11 counts (H.0b's K9 markers, each in one source file). */
const MARKERS = {
  "packages/db/src/client.ts": "requestport.tenant-bindings",
  "packages/db/src/wiring.ts": "requestport.root-storages",
  "packages/auth/src/server.ts": "Magic link email delivered.",
  "apps/web/src/lib/server-web-request-port.ts": "get commandFingerprintKey()",
} as const;
type MarkedFile = keyof typeof MARKERS;

const run = `h5e_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const PASSWORD = `pw${randomBytes(12).toString("hex")}`;
const owner = `${run}_owner`;
const database = `${run}_web`;
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const EMAIL = "owner@example.com";
const bootstrapFlags = [
  "--email",
  EMAIL,
  "--organization",
  "acme",
  "--organization-name",
  "Acme",
];
const REFUSAL = "HostHandoffRefusalError";
/** `createAuth`'s refusal in Next's copy, whole, as it writes it where it is raised (ruling 145). */
const CREATE_AUTH_REFUSAL =
  `${REFUSAL}: RequestPort's createAuth refused: the host's handoff is ` +
  "present, and the caller passed no construction token it admits. While it " +
  "is present, the web answers the storage, Better Auth and RequestPort it " +
  "carries and builds none of its own (manifest-h.md §2.7.1).";
/**
 * A GitHub and a Resend pair, as a self-hoster's shell may export them. Each
 * value is this run's own, so that no output can carry it by chance.
 */
const INHERITED_PROVIDERS = {
  GITHUB_CLIENT_ID: `h5-github-client-${randomBytes(6).toString("hex")}`,
  GITHUB_CLIENT_SECRET: `h5-github-secret-${randomBytes(6).toString("hex")}`,
  RESEND_API_KEY: `re_h5_${randomBytes(6).toString("hex")}`,
  RESEND_FROM_EMAIL: `requestport-${randomBytes(3).toString("hex")}@example.invalid`,
};

const scratch = mkdtempSync(join(tmpdir(), "requestport-web-ui "));
let admin: ReturnType<typeof createTestStorage> | undefined;
const instanceIds = new Set<string>();
const sql = (text: string, values?: unknown[]) =>
  rawQuery(admin as ReturnType<typeof createTestStorage>, text, values);

let scan: ReturnType<typeof scanSelfHostBuild>;
let copies: Record<MarkedFile, string[]>;
let actionIds: Record<string, string>;

beforeAll(async () => {
  // The global setup builds it; without it every start below refuses.
  locateSelfHostWeb();
  scan = scanSelfHostBuild(SERVER);
  copies = Object.fromEntries(
    Object.entries(MARKERS).map(([file, marker]) => [
      file,
      scan.idsCarrying(marker),
    ]),
  ) as Record<MarkedFile, string[]>;
  for (const [file, ids] of Object.entries(copies)) {
    expect(ids.length, `${file}'s copies in Next's build`).toBeGreaterThan(0);
  }
  actionIds = actionIdsOf(SERVER);

  expect(
    ["127.0.0.1", "localhost", "[::1]"],
    "this suite creates roles: DATABASE_URL must name a PostgreSQL on this machine",
  ).toContain(base.hostname);
  admin = createTestStorage({
    driver: "pg",
    pool: { max: 2, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 15_000 },
  });
  await sql(`create role "${owner}" login password '${PASSWORD}' superuser`);
  await sql(`create database "${database}" owner "${owner}"`);
});

afterAll(async () => {
  try {
    if (admin !== undefined) {
      await sql(`drop database if exists "${database}" with (force)`);
      const logins = [...instanceIds].flatMap((id) =>
        Object.values(instanceLoginNames(id)),
      );
      for (const name of [...logins, owner]) {
        await sql(`drop role if exists "${name}"`);
      }
      const left = (
        await sql(
          `select (select count(*)::int from pg_catalog.pg_roles
                    where rolname like $1 or rolname = any($2::text[])) as roles,
                  (select count(*)::int from pg_catalog.pg_database where datname like $1) as databases`,
          [`${run}%`, logins],
        )
      ).rows[0];
      expect(left).toEqual({ roles: 0, databases: 0 });
    }
  } finally {
    await admin?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

type Storage = "pg" | "pglite";

interface Instance {
  storage: Storage;
  directory: string;
  port: number;
  url: string;
  credential: string;
  started: boolean;
}

const instances: Record<Storage, Instance> = {
  pg: {
    storage: "pg",
    directory: join(scratch, "data pg"),
    port: 0,
    url: "",
    credential: "",
    started: false,
  },
  pglite: {
    storage: "pglite",
    directory: join(scratch, "data pglite"),
    port: 0,
    url: "",
    credential: "",
    started: false,
  },
};

interface Served {
  finished: Finished;
  serving: {
    surface: string | null;
    handoff: string[] | null;
    providerVariables: string[];
  };
  closed: {
    surface: string | null;
    handoff: string[] | null;
    counters: WebUiCounters;
  };
  refusals: string[];
}

/**
 * Starts `instance` through the web UI's test entry (initialising it the
 * first time), runs `drive` while it serves, stops it, and answers what it
 * recorded. The start's environment is this process's, with `extra` over
 * it: `web-ui-counters.ts`'s controls, or a case's own variables. Whatever
 * GitHub or Resend pair this process holds (this workspace's Vitest
 * configuration loads the worktree's .env.local) is left in it, as a
 * self-hoster's shell may hold one; `requestport start` removes both.
 */
async function serve(
  instance: Instance,
  extra: Record<string, string>,
  drive: (driver: WebUiDriver) => Promise<void>,
): Promise<Served> {
  const record = join(scratch, `record ${randomUUID()}.jsonl`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RP_H5_RECORD: record,
    RP_H5_MODULE_IDS: Object.values(copies).flat().join(","),
    ...extra,
  };
  let args: string[];
  if (instance.started) {
    args = ["--data-dir", instance.directory];
  } else {
    instance.port = await freePort();
    instance.url = `http://127.0.0.1:${instance.port}`;
    args = [
      "--data-dir",
      instance.directory,
      ...bootstrapFlags,
      "--port",
      String(instance.port),
    ];
    if (instance.storage === "pglite") {
      args.push("--storage", "pglite");
    } else {
      const ownerFile = join(scratch, "owner.url");
      const url = new URL(base);
      url.username = owner;
      url.password = PASSWORD;
      url.pathname = `/${database}`;
      url.search = "";
      writeFileSync(ownerFile, `${url}\n`, { mode: 0o600 });
      args.push("--owner-url-file", ownerFile);
    }
  }
  const finished = await runStart("web-ui", args, {
    env,
    whileServing: async ({ stdout }) => {
      if (!instance.started) {
        const [credential] = credentialsIn(stdout());
        instance.credential = credential as string;
        instance.started = true;
        instanceIds.add(
          (
            JSON.parse(
              readFileSync(join(instance.directory, "init.json"), "utf8"),
            ) as { instanceId: string }
          ).instanceId,
        );
      }
      await drive(new WebUiDriver(instance.url, actionIds));
    },
  });
  expect(finished.code, finished.stderr).toBe(0);
  const [serving, closed] = readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return {
    finished,
    serving,
    closed,
    refusals: finished.stderr
      .split("\n")
      .filter((line) => line.includes(REFUSAL)),
  };
}

/**
 * The module copy that built it: `host`, or `next <module id>`, by its call
 * sites; `isHostFile` names the host's file (by default the host's
 * `client.ts`, which builds every storage, pool and engine).
 */
function copyThatBuilt(
  construction: Construction,
  isHostFile: (file: string) => boolean = (file) => file === hostClient,
): string {
  for (const site of construction.sites) {
    const file = site.file?.startsWith("file://")
      ? new URL(site.file).pathname
      : site.file;
    if (file === null || file === undefined) continue;
    if (file.startsWith(`${SERVER}/`)) {
      return `next ${scan.moduleAt(file, site.line ?? 0, site.column ?? 0) ?? `(no module at ${file}:${site.line}:${site.column})`}`;
    }
    if (isHostFile(decodeURIComponent(file))) return "host";
  }
  return `unattributed: ${JSON.stringify(construction.sites.slice(0, 4))}`;
}

const tally = (names: string[]) =>
  names.reduce<Record<string, number>>((counts, name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});

/** The project form's fields, for a project named `name`. */
const projectFields = (name: string, slug: string) => ({
  name,
  slug,
  keyPrefix: "WEBUI",
  description: "",
  repositoryUrl: "",
});

/** `transitionRequestAction` for a request that does not exist: core refuses it `not_found`. */
const transitionUnknownRequest = (driver: WebUiDriver) =>
  driver.action(
    "/requests",
    "app/(app)/requests/actions.ts",
    "transitionRequestAction",
    {
      requestId: randomUUID(),
      expectedVersion: "1",
      action: "begin_triage",
      reason: "",
      relatedRequestId: "",
      verificationEvidence: "",
      outcomeMd: "",
      changedRepositories: "",
      validationCommand: "",
      validationResult: "not_run",
      validationSummary: "",
      risksMd: "",
      followupsMd: "",
      verificationStepsMd: "",
      idempotencyKey: randomUUID(),
    },
  );

/** The error paths of K10, driven as one person: what each answered. */
async function errorPaths(driver: WebUiDriver) {
  const transition = await transitionUnknownRequest(driver);
  const agent = await driver.action(
    "/agents",
    "app/(app)/agents/actions.ts",
    "setAgentStatusAction",
    {
      agentPrincipalId: randomUUID(),
      expectedVersion: "1",
      status: "suspended",
      reason: "an agent that does not exist",
      idempotencyKey: randomUUID(),
    },
  );
  const page = await driver.get("/requests", { session: false });
  const action = await driver.action(
    "/settings/projects/new",
    "app/(app)/settings/projects/actions.ts",
    "createProjectAction",
    projectFields("Never made", `never-${randomBytes(3).toString("hex")}`),
    { session: false },
  );
  return {
    transition: [transition.code, transition.message],
    agent: [agent.code, agent.message],
    page: [page.status, page.location],
    action: [action.code, action.message],
  };
}

/** What each storage's host builds: the application storage, and on pg the worker's three, each its own pool; on PGlite one engine, which the worker shares. */
const EXPECTED: Record<
  Storage,
  { surface: string; storages: number; pools: number; engines: number }
> = {
  pg: { surface: "application", storages: 4, pools: 4, engines: 0 },
  pglite: { surface: "embedded", storages: 1, pools: 0, engines: 1 },
};

describe.each(["pg", "pglite"] as const)(
  "Done when 11 on %s: the web UI beside the host, one instance of each",
  (storage) => {
    const instance = instances[storage];

    test("serves the sign-in page, a sign-in, a project page and the consent page through Next, with the handoff set before Next prepares and taken back at close, no refusal, and the host's one storage, one Better Auth instance and one engine, counted per module copy", async () => {
      const tag = randomBytes(4).toString("hex");
      const name = `Web UI project ${tag}`;
      const clientName = `Web UI consent client ${tag}`;
      const seen: Record<string, unknown> = {};
      let errors: Awaited<ReturnType<typeof errorPaths>> | undefined;

      const served = await serve(instance, {}, async (driver) => {
        const signInPage = await driver.get("/sign-in", { session: false });
        seen.signInPage = [signInPage.status, headingOf(signInPage.text)];
        // proxy.ts's rule, in the build this start serves: an http public URL
        // on a loopback host drops the directive (H.5's slice d).
        seen.signInPolicy = signInPage.headers
          .get("content-security-policy")
          ?.includes("upgrade-insecure-requests");
        seen.signIn = await driver.signIn(EMAIL, instance.credential);

        const created = await driver.action(
          "/settings/projects/new",
          "app/(app)/settings/projects/actions.ts",
          "createProjectAction",
          projectFields(name, `web-ui-${tag}`),
        );
        seen.created = [created.code, created.redirect];
        const list = await driver.get("/settings/projects");
        const pages = [];
        for (const id of new Set(
          [
            ...list.text.matchAll(/\/settings\/projects\/([0-9a-f-]{36})/gu),
          ].map((match) => match[1] as string),
        )) {
          const page = await driver.get(`/settings/projects/${id}`);
          if (page.text.includes(name)) pages.push([page.status, id]);
        }
        seen.projectPages = pages.map(([status]) => status);

        const consent = await driver.consentPage(clientName);
        seen.consent = [
          consent.status,
          consent.url,
          consent.text.includes(clientName),
        ];
        errors = await errorPaths(driver);
      });

      expect(seen).toEqual({
        signInPage: [200, expect.any(String)],
        signInPolicy: false,
        signIn: 200,
        created: [null, expect.stringMatching(/^\/settings\/projects/u)],
        projectPages: [200],
        consent: [200, "/oauth/agent-consent", true],
      });
      // K10: the host's DomainError reaches Next's action with its own
      // message, and Better Auth's APIError, read by name, still sends a
      // person without a session to /sign-in, at both sites.
      expect(errors).toEqual({
        transition: ["not_found", "The requested record is unavailable."],
        agent: [null, "You do not have permission to manage this agent."],
        page: [307, expect.stringMatching(/^\/sign-in/u)],
        action: ["unauthenticated", "Sign in to continue."],
      });

      const expected = EXPECTED[storage];
      const { serving, closed, refusals } = served;
      const counters = closed.counters;
      // The handoff: set, whole, before any of Next's webpack runtimes
      // loaded, which happens only as Next prepares; taken back at close.
      expect(serving.handoff).toEqual([
        "admitsConstruction",
        "auth",
        "requestPort",
        "storage",
      ]);
      expect(
        counters.events.filter((event) => event === "handoff set"),
      ).toEqual(["handoff set"]);
      expect(counters.events[0]).toBe("handoff set");
      expect(
        counters.events.filter((event) =>
          event.startsWith("webpack runtime loaded"),
        ).length,
      ).toBeGreaterThan(0);
      expect(closed.handoff).toBeNull();
      // The surface: instrumentation.ts declared nothing over embedded.
      expect([serving.surface, closed.surface]).toEqual([
        expected.surface,
        expected.surface,
      ]);
      // No refusal, anywhere.
      expect(refusals).toEqual([]);
      // One of each, built by the host's copy; none by any of Next's copies.
      expect(
        tally(
          counters.storages.map((construction) => copyThatBuilt(construction)),
        ),
      ).toEqual({
        host: expected.storages,
      });
      expect(counters.pgPools.length).toBe(expected.pools);
      for (const pool of counters.pgPools) {
        expect(copyThatBuilt(pool)).toBe("host");
      }
      expect(
        tally(
          counters.pgliteEngines.map((construction) =>
            copyThatBuilt(construction),
          ),
        ),
      ).toEqual(expected.engines === 0 ? {} : { host: expected.engines });
      expect(counters.betterAuthInstances).toBe(1);
      // Every Better Auth instance built in the process, by any copy of
      // better-auth: the host's one, and none in Next's copies.
      expect(
        tally(
          counters.betterAuthConstructions.map((construction) =>
            copyThatBuilt(construction, isHostBetterAuth),
          ),
        ),
      ).toEqual({ host: 1 });
      // Per module copy (rulings 143 and 145): every copy of each marked
      // module in Next's build was evaluated once, so the drive reached the
      // action graph's copies as well as the first set's, and none was
      // evaluated again after a factory threw.
      for (const [file, ids] of Object.entries(copies)) {
        expect(
          Object.fromEntries(
            ids.map((id) => [id, counters.evaluations[id] ?? 0]),
          ),
          file,
        ).toEqual(Object.fromEntries(ids.map((id) => [id, 1])));
      }
    });

    test("the error paths fail with the brand and the name taken away: the host's DomainError gets the generic message, and a request without a session is not sent to /sign-in (each detector fires)", async () => {
      let errors: Awaited<ReturnType<typeof errorPaths>> | undefined;
      const served = await serve(
        instance,
        {
          RP_H5_REMOVE_DOMAIN_ERROR_BRAND: "1",
          RP_H5_UNNAME_API_ERROR: "1",
        },
        async (driver) => {
          expect(await driver.signIn(EMAIL, instance.credential)).toBe(200);
          errors = await errorPaths(driver);
        },
      );

      expect(served.closed.counters.controls).toEqual([
        "DomainError unbranded",
        "APIError unnamed",
      ]);
      expect(errors).toEqual({
        transition: [
          "unexpected_error",
          "RequestPort could not complete that action.",
        ],
        agent: [null, "The agent action could not be completed."],
        page: [500, null],
        action: [
          "unexpected_error",
          "RequestPort could not complete that action.",
        ],
      });
      expect(served.refusals).toEqual([]);
    });

    test("with Next's copies of Better Auth's installer made to ignore the handoff (a control), createAuth in Next's copy refuses, by name, where it is raised: the sign-in page answers 500, nothing else refuses, and no Better Auth or storage is built by any of Next's copies", async () => {
      let reached: number | undefined;
      const served = await serve(
        instance,
        { RP_H5_INSTALLER_IGNORES_HANDOFF: "1" },
        async (driver) => {
          // The sign-in page imports the installer.
          reached = (await driver.get("/sign-in", { session: false })).status;
        },
      );
      const counters = served.closed.counters;

      expect(counters.controls).toEqual([
        "Better Auth installer ignores the handoff",
      ]);
      // The control reached Next's copies of the installer, and the handoff
      // was set whole.
      expect(counters.installerReadsRewritten.length).toBeGreaterThan(0);
      for (const { file, copies } of counters.installerReadsRewritten) {
        expect(file).toContain("/.next-self-host/");
        expect(copies).toBe(1);
      }
      expect(counters.handoffMembers).toEqual([
        "admitsConstruction",
        "auth",
        "requestPort",
        "storage",
      ]);
      expect(reached).toBe(500);
      // createAuth's own line, at least once, and no other: the installer,
      // which found no handoff, did not refuse.
      const raised = served.refusals.filter((line) =>
        line.startsWith(`${REFUSAL}: `),
      );
      expect(raised.length).toBeGreaterThan(0);
      expect([...new Set(raised)]).toEqual([CREATE_AUTH_REFUSAL]);
      for (const line of served.refusals) {
        expect(line).toContain(
          CREATE_AUTH_REFUSAL.slice(`${REFUSAL}: `.length),
        );
      }
      // It refused before it composed: no Better Auth and no storage built
      // by any of Next's copies. (The host's Better Auth builds its instance
      // on first use, which no request here makes.)
      expect(
        counters.betterAuthConstructions
          .map((construction) => copyThatBuilt(construction, isHostBetterAuth))
          .filter((copy) => copy !== "host"),
      ).toEqual([]);
      expect(
        counters.storages
          .map((construction) => copyThatBuilt(construction))
          .filter((copy) => copy !== "host"),
      ).toEqual([]);
    });

    test("with a GitHub and a Resend pair in the start's environment, the sign-in page Next renders offers the local credential alone, the owner signs in with it, and the serving process holds neither pair, having said so by name and never by value", async () => {
      let page: { status: number; text: string } | undefined;
      let signIn: number | undefined;
      const served = await serve(
        instance,
        INHERITED_PROVIDERS,
        async (driver) => {
          const answer = await driver.get("/sign-in", { session: false });
          page = { status: answer.status, text: answer.text };
          signIn = await driver.signIn(EMAIL, instance.credential);
        },
      );

      // What the page offers is what the host's Better Auth serves: the
      // local credential, and neither GitHub nor an e-mailed link.
      expect(page?.status).toBe(200);
      expect(page?.text).toContain(
        "Use the local credential your operator issued.",
      );
      expect(page?.text).toContain("Sign in with credential");
      expect(page?.text).not.toContain("Continue with GitHub");
      expect(page?.text).not.toContain("an approved email address");
      expect(signIn).toBe(200);
      expect(served.serving.providerVariables).toEqual([]);
      for (const name of Object.keys(INHERITED_PROVIDERS)) {
        expect(served.finished.stderr).toContain(
          `requestport start: removed ${name} from the serving process's environment: requestport start offers no GitHub sign-in and sends no e-mail, and the sign-in page Next serves reads this environment.\n`,
        );
      }
      for (const value of Object.values(INHERITED_PROVIDERS)) {
        expect(served.finished.stderr).not.toContain(value);
        expect(served.finished.stdout).not.toContain(value);
      }
      expect(served.refusals).toEqual([]);
    });

    /** The refusal a reader writes where it is raised (ruling 145), whole. */
    const refusalLine = (site: string, member: string) =>
      `${REFUSAL}: RequestPort's ${site} refused: the host's handoff is ` +
      `present, and it carries no ${member}. While it is present, the web ` +
      "answers the storage, Better Auth and RequestPort it carries and " +
      "builds none of its own (manifest-h.md §2.7.1).";

    test.each([
      {
        member: "storage",
        site: "application root (rootStorageFromEnv)",
        // An (app) page reads the web root's storage once the session is known.
        reach: async (driver: WebUiDriver) =>
          (await driver.get("/requests")).status,
        answered: 500,
      },
      {
        member: "auth",
        site: "Better Auth installer (@requestport/auth/server)",
        // The sign-in page imports the installer.
        reach: async (driver: WebUiDriver) =>
          (await driver.get("/sign-in", { session: false })).status,
        answered: 500,
      },
      {
        member: "requestPort",
        site: "webRequestPort()",
        // A server action runs its command through the web's RequestPort.
        reach: async (driver: WebUiDriver) => {
          const { code, message } = await transitionUnknownRequest(driver);
          return [code, message];
        },
        answered: [
          "unexpected_error",
          "RequestPort could not complete that action.",
        ],
      },
    ])(
      "with the handoff's $member removed, the reader in Next's copy that answers it refuses, by name, where it is raised, and nothing else refuses",
      async ({ member, site, reach, answered }) => {
        let reached: unknown;
        const served = await serve(
          instance,
          { RP_H5_HANDOFF_OMIT: member },
          async (driver) => {
            if (member !== "auth") {
              expect(await driver.signIn(EMAIL, instance.credential)).toBe(200);
            }
            reached = await reach(driver);
          },
        );

        expect(served.closed.counters.handoffMembers).toEqual(
          ["admitsConstruction", "auth", "requestPort", "storage"].filter(
            (name) => name !== member,
          ),
        );
        expect(reached).toEqual(answered);
        // The line the reader writes where it refuses, naming it: at least
        // once, and no other. One request can raise it more than once:
        // webpack evaluates a module again after its factory threw (K1b),
        // and Next renders a layout and its page each asking.
        const raised = served.refusals.filter((line) =>
          line.startsWith(`${REFUSAL}: `),
        );
        expect(raised.length).toBeGreaterThan(0);
        expect([...new Set(raised)]).toEqual([refusalLine(site, member)]);
        // Every other line naming the error is Next reporting the same one.
        for (const line of served.refusals) {
          expect(line).toContain(
            refusalLine(site, member).slice(`${REFUSAL}: `.length),
          );
        }
        // Still nothing built in any of Next's copies.
        expect(
          served.closed.counters.storages
            .map((construction) => copyThatBuilt(construction))
            .filter((copy) => copy !== "host"),
        ).toEqual([]);
        expect(
          served.closed.counters.betterAuthConstructions
            .map((construction) =>
              copyThatBuilt(construction, isHostBetterAuth),
            )
            .filter((copy) => copy !== "host"),
        ).toEqual([]);
      },
    );
  },
);
