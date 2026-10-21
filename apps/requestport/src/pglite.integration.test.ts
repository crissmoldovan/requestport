import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRequestPort } from "@requestport/core";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import {
  createEnvelopeEncryption,
  decodeBase64Key,
  LocalAesKeyEncryptionKeyProvider,
  serializeEncryptedEnvelope,
  verifyLocalCredential,
} from "@requestport/domain";
import { afterAll, describe, expect, test } from "vitest";

import {
  LOGIN_URL_VARIABLES,
  PGLITE_DATABASE_DIRECTORY,
} from "./configuration.js";
import { SERVER_ACTION_KEY_FILE } from "./server-action-key.js";
import {
  credentialsIn,
  freePort,
  runStart,
  sessionLives,
  signIn,
} from "./test-support/start-process.js";

/*
 * `requestport start` on PGlite (manifest-h.md §2.6; Done when 9, and Done
 * when 6a's PGlite boundaries, B1, B2, B3, B7, B10 and B11). No server: each
 * instance's database is the PGlite directory inside its data directory,
 * which this process opens only while no start runs, and closes before the
 * next one. Data directories are under this run's default temporary
 * directory, with a space in their names (ruling 152).
 *
 * Starts run as processes of their own (`test-support/start-process.ts`):
 * the shipped executable; the start's test entry, which records each
 * boundary, the operator child's declared surface, and the serving
 * process's environment and declared surface (`start/start.test-entry.ts`);
 * or, to crash at a boundary, `test-support/crashing-start.test-entry.ts`.
 */

const workspace = resolve(import.meta.dirname, "..");
const journalTags = (
  JSON.parse(
    readFileSync(
      resolve(workspace, "../../packages/db/migrations/meta/_journal.json"),
      "utf8",
    ),
  ) as { entries: { tag: string }[] }
).entries.map((entry) => entry.tag);

const scratch = mkdtempSync(join(tmpdir(), "requestport-pglite "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let directories = 0;
function dataDirectoryPath() {
  directories += 1;
  return join(scratch, `data ${directories}`);
}

const EMAIL = "owner@example.com";
/**
 * A GitHub and a Resend pair the start inherits, set by the case rather than
 * left to whatever the worktree's .env.local holds, which this workspace's
 * Vitest configuration loads. Composed into Better Auth, the GitHub pair
 * would turn the owner's local credential off (`localCredentialEnabled`,
 * `@requestport/config`), and the sign-in would fail; `requestport start`
 * composes neither (`authEnvironment`).
 */
const INHERITED_PROVIDERS = {
  GITHUB_CLIENT_ID: "h4-inherited-github-client",
  GITHUB_CLIENT_SECRET: "h4-inherited-github-secret",
  RESEND_API_KEY: "re_h4_inherited",
  RESEND_FROM_EMAIL: "requestport-h4@example.invalid",
} as const;
const bootstrapFlags = [
  "--email",
  EMAIL,
  "--organization",
  "acme",
  "--organization-name",
  "Acme",
];

/** Runs `work` over the instance's PGlite database, opened in this process and closed after. */
async function onPglite<T>(
  directory: string,
  work: (
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<Record<string, unknown>[]>,
  ) => Promise<T>,
): Promise<T> {
  const storage = createTestStorage({
    driver: "pglite",
    dataDir: join(directory, PGLITE_DATABASE_DIRECTORY),
  });
  try {
    return await work(
      async (text, values) => (await rawQuery(storage, text, values)).rows,
    );
  } finally {
    await storage.close();
  }
}

/** The journal's length, `null` before PGlite's directory exists, and the active owners once there is a table to hold them. */
async function databaseState(directory: string) {
  if (!existsSync(join(directory, PGLITE_DATABASE_DIRECTORY))) {
    return { journal: null, owners: 0 };
  }
  return onPglite(directory, async (query) => {
    const [{ present } = {}] = await query(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
    );
    if (present !== true) return { journal: null, owners: 0 };
    const [{ n: journal } = {}] = await query(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    const [{ n: owners } = {}] = await query(
      "select count(*)::int as n from organization_members where role = 'owner' and status = 'active'",
    );
    return { journal, owners };
  });
}

const markerOf = (directory: string) =>
  JSON.parse(readFileSync(join(directory, "init.json"), "utf8")) as {
    instanceId: string;
    complete?: boolean;
  };

/** The entries a first start on PGlite writes before it serves. */
const DATA_ENTRIES = ["config.json", "init.json", "pglite", "secrets.json"];

/**
 * What a start that served leaves: those, and the web UI's server-action
 * key, which the serving step makes (ruling 201 item 4).
 */
const SERVED_ENTRIES = [...DATA_ENTRIES, SERVER_ACTION_KEY_FILE].sort();

/**
 * What a converged first start on PGlite leaves once it has served (Done
 * when 6a): the data directory's three files and the web UI's server-action
 * key, each 0600, beside PGlite's directory, no `*.tmp-*` and no
 * `owner.json`; `init.json` complete; the journal complete; one active
 * owner, whose stored hash accepts `credential`. PGlite has no logins to
 * count.
 */
async function expectConverged(directory: string, credential: string) {
  const entries = readdirSync(directory).sort();
  expect(entries).toEqual(SERVED_ENTRIES);
  expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  for (const file of entries.filter((entry) => entry !== "pglite")) {
    expect(statSync(join(directory, file)).mode & 0o777, file).toBe(0o600);
  }
  expect(markerOf(directory).complete).toBe(true);
  expect(await databaseState(directory)).toEqual({
    journal: journalTags.length,
    owners: 1,
  });
  const [owner] = await onPglite(directory, (query) =>
    query(
      `select u.email, o.slug, a.password as hash
         from organization_members m
         join organizations o on o.id = m.organization_id
         join "user" u on u.id = m.user_id
         left join account a on a.user_id = u.id and a.provider_id = 'credential'
        where m.role = 'owner' and m.status = 'active'`,
    ),
  );
  expect(owner).toMatchObject({ email: EMAIL, slug: "acme" });
  expect(
    await verifyLocalCredential({
      hash: owner?.hash as string,
      password: credential,
    }),
  ).toBe(true);
}

/** The reasons of the owner's bootstrap audit records, oldest first. */
const bootstrapAudit = (directory: string) =>
  onPglite(directory, async (query) =>
    (
      await query(
        `select reason from security_audit_records
          where action = 'organization.owner_bootstrapped' order by occurred_at, id`,
      )
    ).map((row) => row.reason as string),
  );

const HONESTY =
  "requestport start: PGlite serves one user on this machine: this instance binds 127.0.0.1 only, and row-level security does not apply to its database, which it opens as PGlite's superuser.\n";

describe("Done when 9: requestport start on PGlite", () => {
  test("refuses a non-loopback --host before it writes anything", async () => {
    const directory = dataDirectoryPath();
    const refused = await runStart("bin", [
      "--data-dir",
      directory,
      "--storage",
      "pglite",
      "--host",
      "0.0.0.0",
      ...bootstrapFlags,
    ]);

    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      "requestport start: --host: PGlite serves one user on this machine, and row-level security does not apply to it, so it binds a loopback address only (localhost, 127.0.0.0/8 or ::1).\n",
    );
    expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
  });

  test("migrates on boot, serving as embedded with an operator child; a command's outbox row is completed by the in-process worker, with the delivery and the notification intent it creates, and the delivery to a loopback receiver is refused by the endpoint policy", async () => {
    const directory = dataDirectoryPath();
    const port = await freePort();
    // The public URL is the address the host serves, over http on loopback,
    // as a self-host's default public URL is (`http://127.0.0.1:3200`): the
    // notification view models take a deep link on loopback http
    // (`packages/notifications`' `view-model.ts`; ruling 163, item 1), so the
    // invitation's notification intent links to it.
    const serverUrl = `http://127.0.0.1:${port}`;
    const publicUrl = serverUrl;
    const recordFile = join(scratch, `record ${randomUUID()}.jsonl`);
    // Names a server: the serving process on PGlite carries none of them.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...INHERITED_PROVIDERS,
      RP_H4_TEST_RECORD: recordFile,
      [LOGIN_URL_VARIABLES.application]: "postgres://a:b@127.0.0.1:1/x",
    };
    let cookie = "";

    // The first start, through the start's test entry.
    const first = await runStart(
      "entry",
      [
        "--data-dir",
        directory,
        "--storage",
        "pglite",
        ...bootstrapFlags,
        "--port",
        String(port),
        "--public-url",
        publicUrl,
      ],
      {
        env,
        whileServing: async ({ stdout }) => {
          const [credential] = credentialsIn(stdout());
          const signedIn = await signIn(
            serverUrl,
            EMAIL,
            credential as string,
            publicUrl,
          );
          expect(signedIn.status).toBe(200);
          cookie = signedIn.cookie;
        },
      },
    );
    expect(first.code, first.stderr).toBe(0);
    const real = realpathSync(directory);
    expect(first.stderr).toContain(
      `requestport start: applied ${journalTags.length} migrations from ${resolve(workspace, "../../packages/db/migrations")} to the PGlite database in ${join(real, "pglite")}.\n`,
    );
    expect(first.stderr).toContain(HONESTY);
    expect(first.stderr).toContain(
      `requestport start: storage application: driver pglite, surface embedded, PGlite's superuser (no role check), in ${join(real, "pglite")}.\n`,
    );
    expect(first.stderr).toContain(
      "requestport start: storage worker: unbound, on the application storage, with the in-process exclusive runner.\n",
    );
    expect(credentialsIn(first.stdout)).toHaveLength(1);

    const records = readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      records.map(
        (record) =>
          `${record.process} ${record.boundary ?? record.event ?? ""}`,
      ),
    ).toEqual([
      "parent B1",
      "parent B2",
      "parent B3",
      "spawn ",
      "operator B7",
      "operator B10",
      "operator B11",
      "serve serving",
      "serve closed",
    ]);
    // The operator child declared `operator`, and the serving process the
    // ruled surface, `embedded` (ruling 73), in the module its storage
    // reads.
    for (const record of records.filter(
      (entry) => entry.process === "operator",
    )) {
      expect(record.surface, String(record.boundary)).toBe("operator");
    }
    const serving = records.find((record) => record.event === "serving") as {
      surface: string;
      env: Record<string, string>;
    };
    expect(serving.surface).toBe("embedded");
    expect(
      Object.keys(serving.env).filter(
        (name) =>
          name === "DATABASE_URL" ||
          name.startsWith("POSTGRES_") ||
          /^PG[A-Z0-9_]*$/u.test(name) ||
          Object.values(LOGIN_URL_VARIABLES).includes(name),
      ),
    ).toEqual([]);
    expect(serving.env.REQUESTPORT_DATABASE_DRIVER).toBe("pglite");
    // The GitHub and Resend pairs this case gave it are removed from the
    // serving process's environment, one line each, never the value (H.5,
    // after its independent review): Next's sign-in page reads that
    // environment. Better Auth is composed without them as well
    // (authEnvironment, pinned in serve/environment.test.ts).
    for (const [name, value] of Object.entries(INHERITED_PROVIDERS)) {
      expect(serving.env[name], name).toBeUndefined();
      expect(first.stderr).toContain(
        `requestport start: removed ${name} from the serving process's environment: requestport start offers no GitHub sign-in and sends no e-mail, and the sign-in page Next serves reads this environment.\n`,
      );
      expect(first.stderr).not.toContain(value);
    }
    expect(first.stderr).toContain(
      `requestport start: removed ${LOGIN_URL_VARIABLES.application} from the serving process's environment: on PGlite it connects to no server.\n`,
    );

    // With no start running: the bootstrap's outbox row was completed by
    // the worker; a webhook subscription with a loopback receiver is seeded
    // directly, as no command creates one (the endpoint policy refuses it);
    // and the owner invites a member through core, in this process, as the
    // web's invitation form does.
    const secrets = JSON.parse(
      readFileSync(join(directory, "secrets.json"), "utf8"),
    ) as Record<string, string>;
    const subscriptionId = randomUUID();
    const invited = await onPglite(directory, async (query) => {
      expect(
        await query(
          "select e.type, o.state from outbox o join domain_events e on e.id = o.event_id",
        ),
      ).toEqual([
        {
          type: "appearance.organization_defaults_initialized.v1",
          state: "completed",
        },
      ]);
      const [session] = await query(
        `select s.id, s.user_id as "userId", m.organization_id as "organizationId"
           from session s join organization_members m on m.user_id = s.user_id
          order by s.created_at desc limit 1`,
      );
      expect(session).toBeDefined();
      const organizationId = session?.organizationId as string;
      const envelope = await createEnvelopeEncryption(
        new LocalAesKeyEncryptionKeyProvider(
          "local-v1",
          new Map([
            [
              "local-v1",
              decodeBase64Key(secrets.REQUESTPORT_WEBHOOK_KEK as string),
            ],
          ]),
        ),
      ).encrypt(
        { secret: `whsec_${randomUUID()}` },
        new TextEncoder().encode(
          `requestport:webhook:${organizationId}:${subscriptionId}:current`,
        ),
      );
      await query(
        `insert into webhook_subscriptions (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, created_by, status, verified_at)
         values ($1, $2, 'loopback receiver', 'https://127.0.0.1/hook', $3::jsonb, 'k1', $4, 'active', now())`,
        [
          subscriptionId,
          organizationId,
          JSON.stringify(serializeEncryptedEnvelope(envelope)),
          session?.userId,
        ],
      );
      return { session, organizationId };
    });
    const storage = createTestStorage({
      driver: "pglite",
      dataDir: join(directory, PGLITE_DATABASE_DIRECTORY),
    });
    const meta = { expectedVersion: 0, idempotencyKey: randomUUID() };
    try {
      const requestPort = createRequestPort({
        storage,
        secrets: {
          commandFingerprintKey: secrets.BETTER_AUTH_SECRET as string,
          workspaceKeys: {
            current: {
              version: "local-v1",
              key: secrets.REQUESTPORT_WORKSPACE_KEK as string,
            },
          },
        },
        background: { kind: "none" },
        publicUrl,
      });
      const invite = () =>
        requestPort.execute(
          "invite_organization_member",
          {
            organizationId: invited.organizationId,
            email: "member@example.com",
            role: "member",
          },
          {
            person: {
              id: invited.session?.id as string,
              userId: invited.session?.userId as string,
            },
            organizationId: invited.organizationId,
            meta,
          },
        );
      const result = await invite();
      // The same key replays the stored result: PGlite's one session is a
      // superuser, which no row policy binds (migration 0024's FORCE
      // included).
      expect(await invite()).toEqual(result);
    } finally {
      await storage.close();
    }
    expect(
      await onPglite(directory, (query) =>
        query(
          `select organization_id as "organizationId" from command_receipts
            where command_name = 'invite_organization_member'`,
        ),
      ),
    ).toEqual([{ organizationId: invited.organizationId }]);

    // The second start, through the executable: nothing to migrate or
    // bootstrap; it serves until its worker has routed the invitation and
    // attempted the delivery.
    const logged = (stdout: string) =>
      stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const attempted = (stdout: string) =>
      logged(stdout).filter((line) => line.event === "webhook.attempt_failed");
    // The outbox job's result, recorded once its body has returned: `routed`
    // only after `markCompleted` settled the row (`outbox-delivery.ts`).
    const routed = (stdout: string) =>
      logged(stdout).filter(
        (line) =>
          line.metricName === "task.result_total" &&
          line.taskId === "outbox-delivery" &&
          line.status === "routed",
      );
    const second = await runStart("bin", ["--data-dir", directory], {
      whileServing: async ({ stdout }) => {
        // The session the first start's sign-in made still lives.
        expect(await sessionLives(serverUrl, cookie)).toBe(true);
        const deadline = Date.now() + 90_000;
        while (
          (attempted(stdout()).length === 0 || routed(stdout()).length === 0) &&
          Date.now() < deadline
        ) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        }
      },
    });
    expect(routed(second.stdout), second.stdout).toHaveLength(1);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain(
      `requestport start: no migration to apply to the PGlite database in ${join(real, "pglite")}.\n`,
    );
    expect(credentialsIn(second.stdout)).toEqual([]);
    expect(second.stderr).toContain(HONESTY);
    // The observable (Done when 9): the worker's attempt, refused by the
    // endpoint policy for its loopback address before any connection.
    expect(attempted(second.stdout)[0]).toMatchObject({
      errorCode: "unsafe_endpoint_address",
      status: "retry",
    });

    await onPglite(directory, async (query) => {
      // Both outbox rows completed, none dead-lettered.
      expect(
        await query(
          "select e.type, o.state from outbox o join domain_events e on e.id = o.event_id order by e.type",
        ),
      ).toEqual([
        {
          type: "appearance.organization_defaults_initialized.v1",
          state: "completed",
        },
        { type: "organization.invitation_created.v1", state: "completed" },
      ]);
      const [event] = await query(
        "select id from domain_events where type = 'organization.invitation_created.v1'",
      );
      // The delivery it created, to the loopback receiver, and its
      // attempts, each refused by the endpoint policy.
      const deliveries = await query(
        "select id, subscription_id, status from webhook_deliveries where event_id = $1",
        [event?.id],
      );
      expect(deliveries).toEqual([
        {
          id: expect.any(String),
          subscription_id: subscriptionId,
          status: "retry",
        },
      ]);
      const attempts = await query(
        "select error_code, response_status from webhook_attempts where delivery_id = $1",
        [deliveries[0]?.id],
      );
      expect(attempts.length).toBeGreaterThan(0);
      for (const attempt of attempts) {
        expect(attempt).toEqual({
          error_code: "unsafe_endpoint_address",
          response_status: null,
        });
      }
      // The notification intent it created: the invitation's email, its link
      // on the http public URL.
      expect(
        await query(
          `select channel, template, view_model->>'deepLink' as deep_link
             from notification_intents where event_id = $1`,
          [event?.id],
        ),
      ).toEqual([
        {
          channel: "email",
          template: expect.any(String),
          deep_link: `${publicUrl}/sign-in`,
        },
      ]);
    });
  }, 400_000);
});

const BOUNDARIES = ["B1", "B2", "B3", "B7", "B10", "B11"] as const;
type Boundary = (typeof BOUNDARIES)[number];

/**
 * What a first start on PGlite killed at each boundary leaves (§2.3.1's
 * table, its PGlite rows): the data directory's entries (the parent's lock
 * stays when the parent itself was killed), the journal and the active
 * owners. Every boundary comes before the serving step, so none leaves the
 * server-action key.
 */
const LEFT: Record<
  Boundary,
  { entries: string[]; journal: number | null; owners: number }
> = {
  B1: { entries: ["init.json", "lock"], journal: null, owners: 0 },
  B2: {
    entries: ["config.json", "init.json", "lock"],
    journal: null,
    owners: 0,
  },
  B3: {
    entries: ["config.json", "init.json", "lock", "secrets.json"],
    journal: null,
    owners: 0,
  },
  B7: { entries: DATA_ENTRIES, journal: journalTags.length, owners: 0 },
  B10: { entries: DATA_ENTRIES, journal: journalTags.length, owners: 1 },
  B11: { entries: DATA_ENTRIES, journal: journalTags.length, owners: 1 },
};

const ROTATED =
  "already holds a local credential: an earlier start bootstrapped them and stopped before init.json was complete, so it may never have been shown. This start rotates it: a credential an earlier start printed no longer signs in, and their sessions end.";

describe("Done when 6a on PGlite: a first start killed at each of its boundaries, then started again, converges", () => {
  test.each(BOUNDARIES)(
    "killed with SIGKILL at %s, then started normally",
    async (boundary) => {
      const directory = dataDirectoryPath();
      const port = await freePort();
      const publicUrl = `http://127.0.0.1:${port}`;
      const parentKilled =
        boundary === "B1" || boundary === "B2" || boundary === "B3";

      const crashed = await runStart(
        "crashing",
        [
          "--data-dir",
          directory,
          "--storage",
          "pglite",
          ...bootstrapFlags,
          "--port",
          String(port),
        ],
        { env: { ...process.env, RP_H4_TEST_CRASH_AT: boundary } },
      );

      expect(crashed.served, crashed.stderr).toBe(false);
      if (parentKilled) {
        expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
      } else {
        expect(crashed.code, crashed.stderr).toBe(1);
        expect(crashed.stderr).toContain(
          "requestport start: the operator step was stopped by SIGKILL.\n",
        );
      }
      expect({
        entries: readdirSync(directory).sort(),
        ...(await databaseState(directory)),
      }).toEqual(LEFT[boundary]);
      expect(markerOf(directory).complete).toBeUndefined();
      const printedBefore = credentialsIn(crashed.stdout);
      expect(printedBefore).toHaveLength(boundary === "B11" ? 1 : 0);

      const resumed = await runStart(
        "bin",
        [
          "--data-dir",
          directory,
          // What the killed start had not yet recorded is given again: the
          // storage and the port before B2, the bootstrap's details before
          // they were recorded, after B3.
          ...(boundary === "B1"
            ? ["--storage", "pglite", "--port", String(port)]
            : []),
          ...(parentKilled ? bootstrapFlags : []),
        ],
        {
          whileServing: async ({ stdout }) => {
            const [credential] = credentialsIn(stdout());
            expect(
              (await signIn(publicUrl, EMAIL, credential as string)).status,
            ).toBe(200);
            if (printedBefore[0] !== undefined) {
              expect(
                (await signIn(publicUrl, EMAIL, printedBefore[0])).status,
              ).toBe(401);
            }
          },
        },
      );

      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.served).toBe(true);
      if (parentKilled) {
        expect(resumed.stderr).toContain(
          `requestport: taking over a stale lock on ${realpathSync(directory)}, left by requestport start (pid ${crashed.pid} is gone)`,
        );
      }
      const printed = credentialsIn(resumed.stdout);
      expect(printed).toHaveLength(1);
      await expectConverged(directory, printed[0] as string);

      if (boundary === "B10" || boundary === "B11") {
        expect(resumed.stderr).toContain(
          `requestport start: ${EMAIL} ${ROTATED}`,
        );
        expect(await bootstrapAudit(directory)).toEqual([
          "First organization owner activated with a local credential",
          "Local owner credential rotated and sessions revoked",
        ]);
      } else {
        expect(resumed.stderr).not.toContain(ROTATED);
        expect(await bootstrapAudit(directory)).toEqual([
          "First organization owner activated with a local credential",
        ]);
      }
    },
    300_000,
  );
});
