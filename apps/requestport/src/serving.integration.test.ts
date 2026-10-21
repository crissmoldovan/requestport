import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createRequestPort } from "@requestport/core";
import {
  createDatabaseRoleGuard,
  createStorage,
  DatabaseRoleGuardError,
  declareDatabaseSurface,
} from "@requestport/db";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import {
  applicationStorageOptionsFromEnv,
  INSTANCE_LOGIN_GROUPS,
  instanceLoginNames,
} from "@requestport/db/wiring";
import {
  createEnvelopeEncryption,
  decodeBase64Key,
  LocalAesKeyEncryptionKeyProvider,
  serializeEncryptedEnvelope,
} from "@requestport/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// By path: `@requestport/config/server` parses this process's environment as
// it loads, and the schema's own module parses nothing.
import { parseServerEnv } from "../../../packages/config/src/server-schema.js";
import {
  canonicalEnvironment,
  generateSecrets,
  type InstanceConfiguration,
  readSecrets,
  writeConfiguration,
  writeSecrets,
} from "./configuration.js";
import { newInstanceId, writeInstanceMarker } from "./instance-marker.js";
import { runOperatorStep } from "./operator/operator-step.js";
import { writeOwnerFile } from "./owner-url.js";
import { namedLoginUrls, withApplicationName } from "./serve/environment.js";
import { serveInstance } from "./serve/serve.js";

/*
 * `requestport start` serving on pg (manifest-h.md Done when 5, the serving
 * half, and Done when 10), and saying why when its worker is not ready
 * (ruling 163, item 2), on the run's PostgreSQL, as its superuser,
 * `DATABASE_URL`. Every database and role here carries the run's name, or is
 * a login of an instance this file started, and `afterAll` drops each and
 * checks that none is left (ruling 158, item 15). Each case has a database of
 * its own: the worker claims every claimable row in its database.
 *
 * This process declares `operator`, as the operator step's entry does, for
 * the case that initialises an instance here and then serves it in this
 * process with the application storage's guard forced to `enforce` (ruling
 * 158, item 16) and the worker storages' guards in their default modes,
 * which enforce the declaration and role checks since I.2b's b5 (ruling 214
 * item 2). The application storage's guard is handed `application`. The
 * worker storages' guards are handed no surface: `createWorkerStorages` has
 * each judge `worker` once this process has declared a surface (ruling 215
 * item 4), so this declaration is what keeps them from being refused as
 * undeclared. Only a Vitest setup file declares `test`
 * (`packages/db/src/tenant-context.test.ts`). The other cases run the start
 * as a process of its own, through its test entry, or `requestport worker`
 * through the executable.
 */
declareDatabaseSurface("operator");

const workspace = resolve(import.meta.dirname, "..");
const startTestEntry = join(workspace, "src", "start", "start.test-entry.ts");
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx/esm"),
).href;

const run = `h4c_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
/** The owner's password: in their URL, and so in `owner.json`, and nowhere else. */
const SENTINEL = `S3NT1NEL${randomBytes(12).toString("hex")}`;
/** The value of each owner-capable variable the start inherits. */
const INHERITED = `INHER1TED${randomBytes(12).toString("hex")}`;
/**
 * A GitHub and a Resend pair the start inherits. Composed into Better Auth,
 * the GitHub pair would turn the owner's local credential off
 * (`localCredentialEnabled`, `@requestport/config`), and the sign-in below
 * would fail; `requestport start` composes neither (`authEnvironment`).
 */
const INHERITED_PROVIDERS = {
  GITHUB_CLIENT_ID: "h4-inherited-github-client",
  GITHUB_CLIENT_SECRET: `h4-inherited-github-secret-${randomBytes(8).toString("hex")}`,
  RESEND_API_KEY: `re_h4_inherited_${randomBytes(8).toString("hex")}`,
  RESEND_FROM_EMAIL: "requestport-h4@example.invalid",
} as const;
const owner = `${run}_owner`;
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const admin = createTestStorage({
  driver: "pg",
  pool: { max: 3, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 15_000 },
});
const sql = (text: string, values?: unknown[]) => rawQuery(admin, text, values);

const databases: string[] = [];
const instanceIds = new Set<string>();
const scratch = mkdtempSync(join(tmpdir(), "requestport-serving-"));

const ENFORCE = {
  declaration: "enforce",
  role: "enforce",
  environment: "enforce",
} as const;

/** Every check at warn: what a mode handed to a worker storage's guard cannot relax it to. */
const ALL_WARN = {
  declaration: "warn",
  role: "warn",
  environment: "warn",
} as const;

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function ownerUrlFor(database: string) {
  const url = new URL(base);
  url.username = owner;
  url.password = SENTINEL;
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

let databaseCount = 0;
async function scratchDatabase() {
  databaseCount += 1;
  const name = `${run}_${databaseCount}`;
  await sql(`create database "${name}" owner "${owner}"`);
  databases.push(name);
  return name;
}

/** A port nothing listens on now, which the system chose: never 3100. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

/** The connections to `database`, as the superuser sees them. */
async function connections(database: string) {
  return (
    await sql(
      `select usename::text as login, application_name as name
         from pg_catalog.pg_stat_activity
        where datname = $1 and usename is not null`,
      [database],
    )
  ).rows as { login: string; name: string }[];
}

/** As the superuser, on `database`. */
async function onDatabase<T>(
  database: string,
  work: (query: typeof sql) => Promise<T>,
): Promise<T> {
  const url = new URL(base);
  url.pathname = `/${database}`;
  const storage = createTestStorage({
    driver: "pg",
    connectionString: url.toString(),
  });
  try {
    return await work((text, values) => rawQuery(storage, text, values));
  } finally {
    await storage.close();
  }
}

/**
 * The owner-capable names among `names`: the rule of the role guard's
 * `ownerCapableVariableNames`, which `serve/environment.ts` writes out
 * (`DATABASE_URL`, every `DATABASE_URL_*`, every `POSTGRES_*` and `PG*`).
 */
const ownerCapable = (names: readonly string[]) =>
  names.filter(
    (name) =>
      name === "DATABASE_URL" ||
      name.startsWith("DATABASE_URL_") ||
      name.startsWith("POSTGRES_") ||
      /^PG[A-Z0-9_]*$/u.test(name),
  );

beforeAll(async () => {
  expect(
    ["127.0.0.1", "localhost", "[::1]"],
    "these suites create roles: DATABASE_URL must name a PostgreSQL on this machine",
  ).toContain(base.hostname);
  const self = (
    await sql(
      "select rolsuper from pg_catalog.pg_roles where rolname = current_user",
    )
  ).rows[0] as { rolsuper: boolean };
  expect(self.rolsuper, "DATABASE_URL must name a superuser").toBe(true);
  await sql(`create role "${owner}" login password '${SENTINEL}' superuser`);
});

afterAll(async () => {
  try {
    for (const database of databases) {
      await sql(`drop database if exists "${database}" with (force)`);
    }
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
  } finally {
    await admin.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

const bootstrapFlags = [
  "--email",
  "owner@example.com",
  "--organization",
  "acme",
  "--organization-name",
  "Acme",
];

interface Started {
  child: ChildProcess;
  output: { stdout: string; stderr: string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** `requestport start`, through its test entry, as a process of its own. */
function startProcess(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Started {
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, startTestEntry, ...args],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr += chunk;
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  return { child, output, exited };
}

const records = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

/** The worker's JSON log lines on a start's standard output. */
const logged = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Done when 10, and Done when 5's serving half: the start process serves", () => {
  test("one process, from its own pid, serves the host and runs the worker as the instance's four logins on pg, completes a command's outbox row with the delivery and the notification intent it creates, its delivery to a loopback receiver refused by the endpoint policy, and on SIGTERM drains, closes every storage and exits 0", async () => {
    const database = await scratchDatabase();
    const directory = join(scratch, `data ${database}`);
    const ownerFile = join(scratch, `owner-${database}.url`);
    writeFileSync(ownerFile, `${ownerUrlFor(database)}\n`, { mode: 0o600 });
    const port = await freePort();
    // The public URL is the address the host serves, over http on loopback,
    // as a self-host's default public URL is (`http://127.0.0.1:3200`): the
    // notification view models take a deep link on loopback http
    // (`packages/notifications`' `view-model.ts`; ruling 163, item 1), so the
    // invitation's notification intent links to it.
    const serverUrl = `http://127.0.0.1:${port}`;
    const publicUrl = serverUrl;
    const recordFile = join(scratch, `record-${database}.jsonl`);
    // DATABASE_URL, from this run's environment, and three more names the
    // serving process must not carry (ruling 158, item 11),
    // DATABASE_URL_UNPOOLED among them (ruling 217 item 2): its worker
    // storages would refuse their first use while it carried one (I.2b's
    // b6). And the GitHub
    // and Resend pairs, set here rather than left to whatever the
    // worktree's .env.local holds, which this workspace's Vitest
    // configuration loads.
    expect(process.env.DATABASE_URL).toBeDefined();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...INHERITED_PROVIDERS,
      DATABASE_URL_UNPOOLED: INHERITED,
      PGCONNECT_TIMEOUT: "7",
      POSTGRES_PASSWORD: INHERITED,
      RP_H4_TEST_RECORD: recordFile,
      RP_H4_TEST_HOLD_AFTER_CLOSE: "1",
    };

    const started = startProcess(
      [
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerFile,
        ...bootstrapFlags,
        "--port",
        String(port),
        "--public-url",
        publicUrl,
      ],
      env,
    );
    try {
      const serving = await until(
        async () =>
          records(recordFile).find((record) => record.event === "serving"),
        (record) => record !== undefined || started.child.exitCode !== null,
        "the start to serve",
        180_000,
      );
      expect(serving, started.output.stderr).toBeDefined();
      const pid = started.child.pid as number;
      const name = `requestport start ${pid}`;
      const { instanceId } = JSON.parse(
        readFileSync(join(directory, "init.json"), "utf8"),
      ) as { instanceId: string };
      instanceIds.add(instanceId);
      const logins = instanceLoginNames(instanceId);
      const { stderr } = started.output;

      // The serving process is this pid, it declared `application`, and its
      // environment holds no owner-capable name; the start said each it
      // removed, never a value.
      expect(serving?.pid).toBe(pid);
      expect(serving?.url).toBe(serverUrl);
      expect(serving?.surface).toBe("application");
      expect(
        ownerCapable(Object.keys(serving?.env as Record<string, string>)),
      ).toEqual([]);
      for (const removed of [
        "DATABASE_URL",
        "DATABASE_URL_UNPOOLED",
        "PGCONNECT_TIMEOUT",
        "POSTGRES_PASSWORD",
      ]) {
        expect(stderr).toContain(
          `requestport start: removed ${removed} from the serving process's environment`,
        );
      }
      // The GitHub and Resend pairs this case gave it are removed from the
      // serving process's environment, one line each, never the value
      // (H.5, after its independent review): Next's sign-in page reads that
      // environment. Better Auth is composed without them as well
      // (authEnvironment, pinned in serve/environment.test.ts).
      const servingEnv = serving?.env as Record<string, string> | undefined;
      for (const [name, value] of Object.entries(INHERITED_PROVIDERS)) {
        expect(servingEnv?.[name], name).toBeUndefined();
        expect(stderr).toContain(
          `requestport start: removed ${name} from the serving process's environment: requestport start offers no GitHub sign-in and sends no e-mail, and the sign-in page Next serves reads this environment.\n`,
        );
        expect(stderr).not.toContain(value);
      }
      expect(stderr).not.toContain(INHERITED);
      expect(stderr).not.toContain(SENTINEL);
      expect(stderr).not.toContain(base.password);
      // The start log's line per storage: the driver, and the login each
      // connects as, the worker's three bound and their role checks passed.
      expect(stderr).toContain(
        `requestport start: storage application: driver pg, login ${logins.application}.\n`,
      );
      for (const [storage, login] of [
        ["dispatcher", logins.dispatcher],
        ["processor", logins.processor],
        ["maintenance", logins.maintenance],
      ] as const) {
        expect(stderr).toContain(
          `requestport start: storage ${storage}: driver pg, bound, login ${login} (role check passed).\n`,
        );
      }
      expect(stderr).toContain(
        `requestport start: serving ${publicUrl}; the in-process worker is ready.\n`,
      );

      // The three worker logins connect while the worker runs, each named by
      // the serving process's pid; nothing else connects as the instance.
      const seen = new Set<string>();
      await until(
        async () => {
          for (const row of await connections(database)) {
            if (row.name === name) seen.add(row.login);
          }
          return seen;
        },
        (logged) =>
          [logins.dispatcher, logins.processor, logins.maintenance].every(
            (login) => logged.has(login),
          ),
        "the worker's three logins in pg_stat_activity",
      );
      for (const row of await connections(database)) {
        if (Object.values(logins).includes(row.login)) {
          expect(row.name, row.login).toBe(name);
        }
      }

      // The printed credential signs in through the host, on the
      // application login.
      const credentials = started.output.stdout
        .split("\n")
        .filter((line) => /^[A-Za-z0-9_-]{43}$/u.test(line));
      expect(credentials).toHaveLength(1);
      const signIn = await fetch(`${serverUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: publicUrl },
        body: JSON.stringify({
          email: "owner@example.com",
          password: credentials[0],
        }),
      });
      expect(signIn.status, await signIn.clone().text()).toBe(200);
      await until(
        async () =>
          (await connections(database)).some(
            (row) => row.login === logins.application && row.name === name,
          ),
        Boolean,
        "the application login in pg_stat_activity",
      );

      // The bootstrap's outbox row (0019's trigger, as the owner became a
      // member), completed by the serving process's worker before anything
      // below is seeded, so that it creates no delivery.
      await until(
        () =>
          onDatabase(
            database,
            async (query) =>
              (
                await query(
                  `select e.type, o.state from outbox o
                     join domain_events e on e.id = o.event_id`,
                )
              ).rows as { type: string; state: string }[],
          ),
        (rows) =>
          rows.length === 1 &&
          (rows[0]?.state === "completed" || rows[0]?.state === "dead_letter"),
        "the bootstrap's outbox row to settle",
      );

      // A webhook subscription with a loopback receiver, seeded directly as
      // the superuser, its secret encrypted under the instance's webhook key,
      // because no command creates one (the endpoint policy refuses it). Then
      // a command, as the signed-in owner, in this test's own process, as the
      // web's invitation form runs it; its outbox row is left for the
      // pollers, and the serving process's worker completes it.
      const [session] = await onDatabase(
        database,
        async (query) =>
          (
            await query(
              `select s.id, s.user_id as "userId", m.organization_id as "organizationId"
                 from session s
                 join organization_members m on m.user_id = s.user_id
                order by s.created_at desc limit 1`,
            )
          ).rows as { id: string; userId: string; organizationId: string }[],
      );
      expect(session).toBeDefined();
      const organizationId = session?.organizationId as string;
      const secrets = readSecrets(directory, "pg");
      const subscriptionId = randomUUID();
      const envelope = await createEnvelopeEncryption(
        new LocalAesKeyEncryptionKeyProvider(
          "local-v1",
          new Map([
            [
              "local-v1",
              decodeBase64Key(secrets?.REQUESTPORT_WEBHOOK_KEK as string),
            ],
          ]),
        ),
      ).encrypt(
        { secret: `whsec_${randomUUID()}` },
        new TextEncoder().encode(
          `requestport:webhook:${organizationId}:${subscriptionId}:current`,
        ),
      );
      await onDatabase(database, (query) =>
        query(
          `insert into webhook_subscriptions (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, created_by, status, verified_at)
           values ($1, $2, 'loopback receiver', 'https://127.0.0.1/hook', $3::jsonb, 'k1', $4, 'active', now())`,
          [
            subscriptionId,
            organizationId,
            JSON.stringify(serializeEncryptedEnvelope(envelope)),
            session?.userId,
          ],
        ),
      );
      const applicationUrl = secrets?.loginUrls?.application as string;
      const commandStorage = createTestStorage({
        driver: "pg",
        connectionString: withApplicationName(
          applicationUrl,
          "requestport serving test",
        ),
        tenantBinding: "wrapped",
      });
      const meta = { expectedVersion: 0, idempotencyKey: randomUUID() };
      try {
        const requestPort = createRequestPort({
          storage: commandStorage,
          secrets: {
            commandFingerprintKey: secrets?.BETTER_AUTH_SECRET as string,
            workspaceKeys: {
              current: {
                version: "local-v1",
                key: secrets?.REQUESTPORT_WORKSPACE_KEK as string,
              },
            },
          },
          background: { kind: "none" },
          publicUrl,
        });
        const invite = () =>
          requestPort.execute(
            "invite_organization_member",
            { organizationId, email: "member@example.com", role: "member" },
            {
              person: {
                id: session?.id as string,
                userId: session?.userId as string,
              },
              organizationId,
              meta,
            },
          );
        const invited = await invite();
        // The same key, on the application login, under the receipts
        // policy (migration 0024): the stored result, and no second
        // invitation or event.
        expect(await invite()).toEqual(invited);
      } finally {
        await commandStorage.close();
      }
      expect(
        await onDatabase(
          database,
          async (query) =>
            (
              await query(
                `select organization_id as "organizationId" from command_receipts
                  where command_name = 'invite_organization_member'`,
              )
            ).rows,
        ),
      ).toEqual([{ organizationId }]);

      // The worker routes the invitation and attempts the delivery: the
      // attempt is refused by the endpoint policy for its loopback address,
      // before any connection, and the outbox job's result is `routed` only
      // after `markCompleted` settled the row (`outbox-delivery.ts`).
      const attempted = () =>
        logged(started.output.stdout).filter(
          (line) => line.event === "webhook.attempt_failed",
        );
      const routed = () =>
        logged(started.output.stdout).filter(
          (line) =>
            line.metricName === "task.result_total" &&
            line.taskId === "outbox-delivery" &&
            line.status === "routed",
        );
      await until(
        async () => ({
          attempted: attempted().length,
          routed: routed().length,
        }),
        (seen) => seen.attempted > 0 && seen.routed === 2,
        "the worker to route the invitation and attempt its delivery",
        90_000,
      );
      expect(attempted()[0]).toMatchObject({
        errorCode: "unsafe_endpoint_address",
        status: "retry",
      });
      // The bootstrap's row and the command's, each completed, not
      // dead-lettered, by the worker in the serving process; the delivery and
      // the notification intent the invitation's event created, and nothing
      // for the bootstrap's (an appearance event names no recipient, and its
      // row was completed before the subscription existed).
      await onDatabase(database, async (query) => {
        expect(
          (
            await query(
              `select e.type, o.state from outbox o
                 join domain_events e on e.id = o.event_id
                order by e.type`,
            )
          ).rows,
        ).toEqual([
          {
            type: "appearance.organization_defaults_initialized.v1",
            state: "completed",
          },
          { type: "organization.invitation_created.v1", state: "completed" },
        ]);
        const event = (
          await query(
            "select id from domain_events where type = 'organization.invitation_created.v1'",
          )
        ).rows[0] as { id: string } | undefined;
        const deliveries = (
          await query(
            "select id, event_id, subscription_id, status from webhook_deliveries",
          )
        ).rows as { id: string }[];
        expect(deliveries).toEqual([
          {
            id: expect.any(String),
            event_id: event?.id,
            subscription_id: subscriptionId,
            status: "retry",
          },
        ]);
        const attempts = (
          await query(
            "select error_code, response_status from webhook_attempts where delivery_id = $1",
            [deliveries[0]?.id],
          )
        ).rows;
        expect(attempts.length).toBeGreaterThan(0);
        for (const attempt of attempts) {
          expect(attempt).toEqual({
            error_code: "unsafe_endpoint_address",
            response_status: null,
          });
        }
        expect(
          (
            await query(
              `select event_id, channel, template, view_model->>'deepLink' as deep_link
                 from notification_intents`,
            )
          ).rows,
        ).toEqual([
          {
            event_id: event?.id,
            channel: "email",
            template: expect.any(String),
            deep_link: `${publicUrl}/sign-in`,
          },
        ]);
      });
      expect(
        started.output.stdout
          .split("\n")
          .filter((line) => line.includes('"event":"outbox.routed"')).length,
      ).toBe(2);
      // The job bodies and the metrics write under the self-host's service
      // names, never the Trigger.dev worker's (ruling 145; ruling 158, item
      // 9).
      expect(
        logged(started.output.stdout)
          .filter((line) => line.event === "outbox.routed")
          .map((line) => line.service),
      ).toEqual(["requestport-outbox-delivery", "requestport-outbox-delivery"]);
      expect(routed().map((line) => line.service)).toEqual([
        "requestport-worker",
        "requestport-worker",
      ]);
      expect(
        logged(started.output.stdout)
          .map((line) => line.service)
          .filter((service) =>
            /^(?:trigger-|requestport-trigger$|requestport-jobs$)/u.test(
              String(service),
            ),
          ),
      ).toEqual([]);

      // SIGTERM: it drains, closes every storage, and then, before it exits,
      // no login of the instance is connected.
      started.child.kill("SIGTERM");
      await until(
        async () =>
          records(recordFile).find((record) => record.event === "closed"),
        (record) => record !== undefined || started.child.exitCode !== null,
        "the serving process to close its storages",
      );
      expect(started.child.exitCode).toBeNull();
      expect(
        (await connections(database)).filter((row) =>
          Object.values(logins).includes(row.login),
        ),
      ).toEqual([]);
      writeFileSync(`${recordFile}.closed-seen`, "");
      expect(await started.exited).toEqual({ code: 0, signal: null });
      expect(started.output.stderr).toContain(
        "requestport start: SIGTERM: stopping.\n",
      );
      expect(started.output.stderr).toContain(
        "requestport start: stopped: the listener, the worker and every storage are closed.\n",
      );
      expect(
        started.output.stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.event === "worker.stopped"),
      ).toEqual([
        expect.objectContaining({ service: "requestport", status: "drained" }),
      ]);

      // From before it read anything until it had closed, the serving
      // process opened config.json and secrets.json, and never owner.json.
      const closed = records(recordFile).find(
        (record) => record.event === "closed",
      ) as { opened: string[] };
      const inDirectory = closed.opened
        .filter((path) => dirname(path) === realpathSync(directory))
        .map((path) => basename(path));
      expect(inDirectory).toContain("config.json");
      expect(inDirectory).toContain("secrets.json");
      expect(
        closed.opened.filter((path) => basename(path) === "owner.json"),
      ).toEqual([]);
    } finally {
      writeFileSync(`${recordFile}.closed-seen`, "");
      if (started.child.exitCode === null) started.child.kill("SIGKILL");
      await started.exited;
    }
  });
});

describe("a serving start whose worker logins cannot authenticate (ruling 163, item 2)", () => {
  test("listens, and once its worker has not been ready for 30 s, writes one line naming the cause, PostgreSQL's refusal of a worker login, with no password; it goes on waiting, and on SIGTERM stops and exits 0", async () => {
    const database = await scratchDatabase();
    const directory = join(scratch, `data ${database}`);
    const ownerFile = join(scratch, `owner-${database}.url`);
    writeFileSync(ownerFile, `${ownerUrlFor(database)}\n`, { mode: 0o600 });
    const port = await freePort();
    // The start's test entry gives each login URL in secrets.json a password
    // its login does not have, once the operator step has set them.
    const started = startProcess(
      [
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerFile,
        ...bootstrapFlags,
        "--port",
        String(port),
      ],
      { ...process.env, RP_H4_TEST_MISMATCH_LOGIN_PASSWORDS: "1" },
    );
    const NOT_READY =
      "requestport start: the in-process worker is not ready after 30 s; ";
    const notReadyLines = () =>
      started.output.stderr
        .split("\n")
        .filter((line) => line.startsWith(NOT_READY));
    try {
      await until(
        async () => started.output.stderr,
        (stderr) =>
          stderr.includes("requestport start: listening on ") ||
          started.child.exitCode !== null,
        "the start to listen",
        180_000,
      );
      const listened = Date.now();
      expect(started.child.exitCode, started.output.stderr).toBeNull();
      const { instanceId } = JSON.parse(
        readFileSync(join(directory, "init.json"), "utf8"),
      ) as { instanceId: string };
      instanceIds.add(instanceId);
      const logins = instanceLoginNames(instanceId);

      await until(
        async () => notReadyLines().length,
        (count) => count > 0 || started.child.exitCode !== null,
        "the line that says why the worker is not ready",
        90_000,
      );
      // 30 s after it listened, with a 1 s margin for this test's polling.
      // The line comes from one setTimeout (run.ts), so it is written at
      // most once; the 5 s below show it is not repeated meanwhile.
      expect(Date.now() - listened).toBeGreaterThanOrEqual(29_000);
      const worker = [logins.dispatcher, logins.processor, logins.maintenance];
      expect(notReadyLines()).toHaveLength(1);
      // Whichever of the three worker storages fails first is the one named.
      expect(notReadyLines()[0]).toMatch(
        new RegExp(
          `^requestport start: the in-process worker is not ready after 30 s; a worker storage cannot run a query: password authentication failed for user "(?:${worker.join("|")})"\\. Still waiting while the worker retries\\.$`,
          "u",
        ),
      );

      // It goes on waiting: still running, not serving, and saying nothing
      // more of it.
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
      expect(started.child.exitCode).toBeNull();
      expect(started.output.stderr).not.toContain(
        "requestport start: serving ",
      );
      expect(notReadyLines()).toHaveLength(1);

      // No password: neither the logins' own nor the ones it was handed.
      const secrets = readSecrets(directory, "pg");
      const passwords = [
        ...Object.values(secrets?.loginPasswords ?? {}),
        ...Object.values(secrets?.loginUrls ?? {}).map(
          (url) => new URL(url).password,
        ),
      ];
      expect(passwords).toHaveLength(8);
      for (const password of passwords) {
        expect(started.output.stderr).not.toContain(password);
        expect(started.output.stdout).not.toContain(password);
      }
      expect(started.output.stderr).not.toContain(SENTINEL);

      started.child.kill("SIGTERM");
      expect(await started.exited).toEqual({ code: 0, signal: null });
      expect(started.output.stderr).toContain(
        "requestport start: SIGTERM: stopping.\n",
      );
    } finally {
      if (started.child.exitCode === null) started.child.kill("SIGKILL");
      await started.exited;
    }
  }, 240_000);
});

describe("Done when 5's enforce modes and Done when 10's second group, serving in this process", () => {
  test("with the application storage's guard forced to enforce and the worker storages' guards in their default modes, the four pass their role checks; a worker login added to a second group is then refused by its storage's role check, in the default modes and with every check handed to the worker storages' guards at warn", async () => {
    const database = await scratchDatabase();
    const directory = mkdtempSync(join(scratch, "enforce-"));
    const instanceId = newInstanceId();
    instanceIds.add(instanceId);
    const port = await freePort();
    const configuration: InstanceConfiguration = {
      version: 1,
      storage: "pg",
      publicUrl: `http://127.0.0.1:${port}`,
      port,
      host: "127.0.0.1",
    };
    writeInstanceMarker(directory, {
      version: 1,
      instanceId,
      bootstrap: {
        email: "owner@example.com",
        organizationSlug: "acme",
        organizationName: "Acme",
      },
    });
    writeConfiguration(directory, configuration);
    writeSecrets(directory, generateSecrets("pg"), "pg");
    writeOwnerFile(directory, ownerUrlFor(database));
    const operator = { stdout: "", stderr: "" };
    expect(
      await runOperatorStep({
        dataDirectory: directory,
        env: {},
        output: {
          stdout: (text) => {
            operator.stdout += text;
          },
          stderr: (text) => {
            operator.stderr += text;
          },
        },
      }),
      operator.stderr,
    ).toBe(0);

    const secrets = readSecrets(directory, "pg");
    const canonical = canonicalEnvironment({
      dataDirectory: directory,
      configuration,
      secrets: secrets as NonNullable<typeof secrets>,
      loginUrls: secrets?.loginUrls,
    });
    const env: NodeJS.ProcessEnv = {
      ...canonical,
      ...namedLoginUrls(canonical, "requestport serving test enforce"),
    };
    const serverEnv = parseServerEnv(env);
    const logins = instanceLoginNames(instanceId);

    /** The application storage as the root builds it, its guard's modes forced. */
    const enforced = () => {
      const guard = createDatabaseRoleGuard({
        env,
        modes: ENFORCE,
        surface: () => "application",
        write: () => undefined,
      });
      return {
        guard,
        build: () =>
          createStorage({
            ...applicationStorageOptionsFromEnv(env),
            guard,
            tenantBinding: "wrapped",
          }),
      };
    };

    const application = enforced();
    // No mode handed to the worker storages' guards: theirs by default.
    const instance = await serveInstance(
      {
        configuration,
        serverEnv,
        env,
        logger: silent,
      },
      application.build,
    );
    try {
      await instance.ready;
      const ready = await fetch(`${configuration.publicUrl}/api/health/ready`);
      expect(ready.status, await ready.clone().text()).toBe(200);
      const report = application.guard.report();
      expect(report.surface).toBe("application");
      expect(
        Object.fromEntries(
          report.findings.map((finding) => [finding.check, finding.status]),
        ),
      ).toEqual({
        declaration: "passed",
        environment: "passed",
        role: "passed",
      });
      expect(
        report.findings.find((finding) => finding.check === "role")?.role,
      ).toBe(logins.application);
      const reports = await instance.roleReports();
      for (const [storage, login] of [
        ["dispatcher", logins.dispatcher],
        ["processor", logins.processor],
        ["maintenance", logins.maintenance],
      ] as const) {
        const role = reports?.[storage].findings.find(
          (finding) => finding.check === "role",
        );
        expect(reports?.[storage].surface, storage).toBe("worker");
        expect(role, storage).toMatchObject({ status: "passed", role: login });
      }
    } finally {
      await instance.close();
    }

    // The converse: the dispatcher's login in a second group, refused in the
    // worker storages' default modes, and with every check handed to their
    // guards at warn, which relaxes none (ruling 214 item 2).
    const second = INSTANCE_LOGIN_GROUPS.maintenance;
    await sql(`grant "${second}" to "${logins.dispatcher}"`);
    try {
      for (const workerGuardModes of [undefined, ALL_WARN]) {
        const handed = workerGuardModes === undefined ? "default" : "all warn";
        const refusedPort = await freePort();
        const refused = await serveInstance(
          {
            configuration: {
              ...configuration,
              port: refusedPort,
              publicUrl: `http://127.0.0.1:${refusedPort}`,
            },
            serverEnv,
            env,
            logger: silent,
            ...(workerGuardModes === undefined ? {} : { workerGuardModes }),
          },
          enforced().build,
        );
        try {
          // The storage's first use throws the guard's refusal, which the
          // driver's query error carries as its cause.
          let refusal = await refused.roleReports().then(
            () => undefined,
            (error: unknown) => error,
          );
          while (
            refusal instanceof Error &&
            !(refusal instanceof DatabaseRoleGuardError)
          ) {
            refusal = refusal.cause;
          }
          expect(refusal, handed).toBeInstanceOf(DatabaseRoleGuardError);
          expect(
            (refusal as DatabaseRoleGuardError).finding,
            handed,
          ).toMatchObject({
            check: "role",
            status: "refused",
            role: logins.dispatcher,
          });
        } finally {
          await refused.close();
        }
      }
    } finally {
      await sql(`revoke "${second}" from "${logins.dispatcher}"`);
    }
  });
});

describe("requestport worker on pg (manifest-h.md §2.5; ruling 158, items 7 and 9)", () => {
  test("given an initialised instance's canonical environment, it completes the bootstrap's outbox row as the worker logins, and it, its job bodies and its metrics write under the self-host's service names, never the Trigger.dev worker's or requestport-jobs'", async () => {
    const database = await scratchDatabase();
    const directory = mkdtempSync(join(scratch, "worker-"));
    const instanceId = newInstanceId();
    instanceIds.add(instanceId);
    const port = await freePort();
    const configuration: InstanceConfiguration = {
      version: 1,
      storage: "pg",
      publicUrl: `http://127.0.0.1:${port}`,
      port,
      host: "127.0.0.1",
    };
    writeInstanceMarker(directory, {
      version: 1,
      instanceId,
      bootstrap: {
        email: "owner@example.com",
        organizationSlug: "acme",
        organizationName: "Acme",
      },
    });
    writeConfiguration(directory, configuration);
    writeSecrets(directory, generateSecrets("pg"), "pg");
    writeOwnerFile(directory, ownerUrlFor(database));
    const operator = { stdout: "", stderr: "" };
    expect(
      await runOperatorStep({
        dataDirectory: directory,
        env: {},
        output: {
          stdout: (text) => {
            operator.stdout += text;
          },
          stderr: (text) => {
            operator.stderr += text;
          },
        },
      }),
      operator.stderr,
    ).toBe(0);
    const secrets = readSecrets(directory, "pg");
    const canonical = canonicalEnvironment({
      dataDirectory: directory,
      configuration,
      secrets: secrets as NonNullable<typeof secrets>,
      loginUrls: secrets?.loginUrls,
    });
    const applicationName = `requestport worker test ${database}`;
    const readyFile = join(directory, "worker.ready");

    // What a second machine's environment holds (§2.5): the instance's
    // canonical names, and no DATABASE_URL.
    const worker = spawn(
      process.execPath,
      [
        join(workspace, "bin", "requestport.mjs"),
        "worker",
        "--ready-file",
        readyFile,
      ],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          ...canonical,
          ...namedLoginUrls(canonical, applicationName),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = { stdout: "", stderr: "" };
    worker.stdout?.on("data", (chunk) => {
      output.stdout += chunk;
    });
    worker.stderr?.on("data", (chunk) => {
      output.stderr += chunk;
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) =>
      worker.once("exit", (code, signal) => resolveExit({ code, signal })),
    );
    try {
      await until(
        async () => existsSync(readyFile) || worker.exitCode !== null,
        Boolean,
        "the worker's ready file",
        90_000,
      );
      expect(existsSync(readyFile), output.stderr).toBe(true);
      // The bootstrap's outbox row, completed by this worker, as the
      // instance's worker logins.
      await until(
        () =>
          onDatabase(
            database,
            async (query) =>
              (
                await query(
                  `select e.type, o.state from outbox o
                     join domain_events e on e.id = o.event_id`,
                )
              ).rows as { type: string; state: string }[],
          ),
        (rows) => rows.length === 1 && rows[0]?.state === "completed",
        "the bootstrap's outbox row to complete",
        90_000,
      );
      // Its three worker logins connect, each named by this worker's
      // environment, and nothing it opens connects as anything but one of
      // the instance's four logins.
      const logins = instanceLoginNames(instanceId);
      const seen = new Set<string>();
      await until(
        async () => {
          for (const row of await connections(database)) {
            if (row.name === applicationName) seen.add(row.login);
          }
          return seen;
        },
        (named) =>
          [logins.dispatcher, logins.processor, logins.maintenance].every(
            (login) => named.has(login),
          ),
        "the worker's three logins in pg_stat_activity",
      );
      expect(
        [...seen].filter((login) => !Object.values(logins).includes(login)),
      ).toEqual([]);
      await until(
        async () =>
          logged(output.stdout).filter(
            (line) =>
              line.metricName === "task.result_total" &&
              line.taskId === "outbox-delivery",
          ),
        (lines) => lines.length > 0,
        "the outbox job's result",
      );
    } finally {
      if (worker.exitCode === null) worker.kill("SIGTERM");
    }
    expect(await exited).toEqual({ code: 0, signal: null });

    const lines = logged(output.stdout);
    expect(
      lines
        .filter((line) =>
          ["worker.ready", "worker.stopped"].includes(String(line.event)),
        )
        .map((line) => [line.event, line.service]),
    ).toEqual([
      ["worker.ready", "requestport-worker"],
      ["worker.stopped", "requestport-worker"],
    ]);
    expect(
      lines
        .filter((line) => line.event === "outbox.routed")
        .map((line) => line.service),
    ).toEqual(["requestport-outbox-delivery"]);
    expect(
      lines
        .filter((line) => line.metricName === "task.result_total")
        .map((line) => line.service),
    ).toContain("requestport-worker");
    expect(
      lines
        .map((line) => line.service)
        .filter((service) =>
          /^(?:trigger-|requestport-trigger$|requestport-jobs$)/u.test(
            String(service),
          ),
        ),
    ).toEqual([]);
  });
});
