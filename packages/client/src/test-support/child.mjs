/**
 * A second process, for the tests that need one: a lock between processes is
 * proved only by more than one process.
 *
 *   node child.mjs <scenario> <input as JSON>
 *
 * It runs this package's TypeScript sources as they are, by Node's type
 * stripping, with a resolve hook (`module.registerHooks`) mapping the
 * sources' `./x.js` specifiers to the `./x.ts` files beside them. Both are
 * there without a flag in the Node this was written against, 22.22.3
 * (`process.features.typescript` is "strip"); on a Node without them the
 * child fails to start and the test that spawned it fails with its stderr.
 * It writes one JSON object per line on stdout, and the last is its result.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL !== undefined
    ) {
      const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

function say(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const pause = (ms) => new Promise((resume) => setTimeout(resume, ms));

/** Report ready, then wait for the parent's go file, so children start together. */
async function startTogether(go) {
  say({ ready: true });
  while (!existsSync(go)) await pause(5);
}

const scenarios = {
  /**
   * Write one audience's record `count` times, reading it back after each
   * write. A read that does not find the record just written means another
   * writer replaced the file with a copy read before that write: a lost
   * update.
   */
  async "write-many"({ audience, count, go, home, projectId, server }) {
    const { createFileStore, resourceFor } = await import("../credentials.js");
    const store = createFileStore({ home });
    await startTogether(go);

    let lost = 0;
    for (let index = 0; index < count; index += 1) {
      const refreshToken = `${audience}-${index}`;
      store.write(server, projectId, audience, {
        audience,
        clientId: `client-${audience}`,
        obtained: "2026-10-01T00:00:00.000Z",
        refreshToken,
        resource: resourceFor(server, audience),
        version: 2,
      });
      if (
        store.read(server, projectId, audience)?.refreshToken !== refreshToken
      ) {
        lost += 1;
      }
    }
    say({ lost });
  },

  /** Hold the file store's writers' lock for `holdMs`, then give it up. */
  async "hold-file-lock"({ holdMs, home }) {
    const { join } = await import("node:path");
    const { CREDENTIAL_DIRECTORY, CREDENTIAL_FILE } = await import(
      "../credentials.js"
    );
    const { acquireLockSync, releaseLock } = await import("../lock.js");
    const lock = acquireLockSync(
      join(home, CREDENTIAL_DIRECTORY, `${CREDENTIAL_FILE}.lock`),
      { staleAfterMs: 10_000, waitMs: 1_000 },
    );
    say({ held: true });
    await pause(holdMs);
    const releasedAt = Date.now();
    releaseLock(lock);
    say({ releasedAt });
  },

  /**
   * Get an access token from a token source over the file store, starting
   * with no access token, then spend it on the server's `whoami`. Reports
   * the token, so the parent can ask the server about it afterwards, and
   * the status `whoami` answered; or the error's name and message.
   */
  async "access-token"({
    audience,
    go,
    home,
    lockDirectory,
    projectId,
    server,
  }) {
    const { createFileStore } = await import("../credentials.js");
    const { createTokenSource } = await import("../token-source.js");
    const source = createTokenSource({
      audience,
      lockDirectory,
      projectId,
      server,
      store: createFileStore({ home }),
    });
    await startTogether(go);

    try {
      const accessToken = await source.accessToken();
      const whoami = await fetch(`${server}/api/v1/whoami`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      say({ accessToken, whoami: whoami.status });
    } catch (error) {
      say({ error: error.name, message: error.message });
    }
  },
};

const [scenario, input] = process.argv.slice(2);
const run = scenarios[scenario];
if (run === undefined) {
  say({ error: `no scenario named ${scenario}` });
  process.exitCode = 2;
} else {
  await run(JSON.parse(input));
}
