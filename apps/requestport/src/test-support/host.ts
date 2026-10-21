import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { createAuth } from "@requestport/auth/create-auth";
import { createRequestPort } from "@requestport/core";
import { migrate } from "@requestport/core/migrate";
import type { Storage } from "@requestport/db";
import { createRequestPortHost, listen } from "@requestport/server";

/**
 * A RequestPort host for the agent commands' end-to-end tests: migrated,
 * composed and served in this process, as K8's stand-in composes it
 * (`spikes/h0-probe/k8-requestport.mts`: Better Auth from `./create-auth`
 * over the storage, core's RequestPort with no background, the host with no
 * web UI, `listen` on 127.0.0.1). Its issuer is
 * `http://127.0.0.1:<port>`, so the port is chosen before Better Auth is
 * composed, and it is never 3100, the acceptance server's.
 *
 * The test hands it the storage of a database the test created for itself,
 * and drops that database afterwards; this module migrates it and serves
 * over it.
 */
export interface TestHost {
  /** Better Auth and what is built over it, as the host serves them. */
  readonly auth: ReturnType<typeof createAuth>;
  /** What core and the host logged, for a failing case to show. */
  readonly events: readonly { level: string; event: string }[];
  /** `BETTER_AUTH_SECRET`: it signs the session cookie a person presents. */
  readonly secret: string;
  /** The public URL and issuer, `http://127.0.0.1:<port>`. */
  readonly url: string;
  close(): Promise<void>;
}

const ACCEPTANCE_PORT = 3100;

/** A port the system says is free now, and not the acceptance server's. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() =>
          typeof address === "object" && address !== null
            ? resolve(address.port)
            : reject(new Error("no port")),
        );
      });
    });
    if (port !== ACCEPTANCE_PORT) return port;
  }
}

/** `lock_not_available`, anywhere along an error's `cause` chain. */
function isLockNotAvailable(error: unknown): boolean {
  for (
    let found: unknown = error, depth = 0;
    typeof found === "object" && found !== null && depth < 5;
    found = (found as { cause?: unknown }).cause, depth += 1
  ) {
    if ((found as { code?: unknown }).code === "55P03") return true;
  }
  return false;
}

/**
 * `migrate`, tried again for up to two minutes while it fails with
 * `lock_not_available` (55P03). Migration 0019 grants `requestport_definer`
 * to the current user, a row of the cluster-wide `pg_auth_members`, under a
 * 100 ms `lock_timeout`. Every integration file here migrates a database of
 * its own on the same server, and vitest runs the files at once, so that
 * grant can wait for another file's uncommitted migration and give up:
 * measured 2026-10-06, with three such files, `login`'s failed in one run and
 * `link`'s and `mcp`'s in the next. Drizzle's pg migrator applies every
 * pending migration in one transaction (0019's header), so a try that failed
 * left nothing applied, and the next starts from the same journal.
 */
async function migrateWhenFree(storage: Storage): Promise<void> {
  const givesUpAt = Date.now() + 120_000;
  for (;;) {
    try {
      await migrate(storage);
      return;
    } catch (error) {
      if (!isLockNotAvailable(error) || Date.now() > givesUpAt) throw error;
      await new Promise((resume) =>
        setTimeout(resume, 200 + Math.random() * 800),
      );
    }
  }
}

export async function startTestHost(storage: Storage): Promise<TestHost> {
  await migrateWhenFree(storage);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString("base64url");
  const events: { level: string; event: string }[] = [];
  const record = (level: string) => (event: string) => {
    events.push({ event, level });
  };
  const logger = {
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  };

  // `NODE_ENV: "test"`, as `packages/auth`'s
  // `cross-audience-token.integration.test.ts` composes Better Auth: the
  // session cookie keeps its plain name, and the issuer's own origin is among
  // the trusted origins (`createAuthOptions`). Better Auth's own rate limit
  // follows the process's `NODE_ENV`, which Vitest sets to `test`, so a file
  // of several authorizations from one address is not limited by it.
  const auth = createAuth({
    database: () => storage.db,
    env: {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: url,
      NODE_ENV: "test",
    },
  });
  const requestPort = createRequestPort({
    background: { kind: "none" },
    betterAuth: { createAgentApiKey: auth.createAgentApiKey },
    environment: "test",
    logger,
    publicUrl: url,
    secrets: { commandFingerprintKey: secret },
    storage,
  });
  const handler = createRequestPortHost({
    auth,
    environment: "test",
    logger,
    mcp: { modernProtocol: false, privateTelemetry: false },
    publicUrl: url,
    requestPort,
    secrets: { fingerprintKey: secret },
    storage,
  });
  const running = await listen(handler, {
    host: "127.0.0.1",
    port,
    publicUrl: url,
  });

  return {
    auth,
    events,
    secret,
    url,
    async close() {
      await running.close();
      await requestPort.close();
    },
  };
}
