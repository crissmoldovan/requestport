import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs, { appendFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

import { readSecrets, writeSecrets } from "../configuration.js";
import { serveFromDataDirectory } from "../serve/run.js";
import { runStart } from "./start.js";

/*
 * A test's `requestport start` (manifest-h.md Done when 5 and 10): `runStart`
 * as the executable runs it, over this process's arguments and environment,
 * with test-only parameters. The spawn wrapper records the command and each
 * argument it is handed; the operator child is the operator step's test
 * entry; and at each boundary this process records its own `process.argv`
 * and `process.env`. Records are JSON lines appended to the file
 * `RP_H4_TEST_RECORD` names. Only the tests start this module.
 *
 * The serving step is the shipped one with hooks:
 * - before it reads anything, when `RP_H4_TEST_MISMATCH_LOGIN_PASSWORDS` is
 *   `1`, each of the four login URLs in the data directory's `secrets.json`
 *   is given a new random password, which its login does not have, so that
 *   no login authenticates as the serving step connects, as under the
 *   `g-6a-login-password` plant (ruling 163, item 2);
 * - before it reads anything, `node:fs`'s functions that open a file
 *   (`open`, `openSync`, `readFile`, `readFileSync`, `createReadStream`,
 *   `promises.open`, `promises.readFile`) are wrapped to record every path
 *   they are asked to open in this process from then on, and the ES module
 *   bindings of `node:fs` are synced to the wrapped functions;
 * - once it serves, it records `process.pid`, `process.argv`, `process.env`,
 *   the paths opened so far and the surface the serving step reads as this
 *   process's declaration;
 * - once every storage has closed, it records the paths opened, and, when
 *   `RP_H4_TEST_HOLD_AFTER_CLOSE` is `1`, waits until the file named by the
 *   record file's name with `.closed-seen` appended exists, so that a test
 *   can read the database after `close()` and before this process exits.
 */
const recordFile = process.env.RP_H4_TEST_RECORD;
const holdAfterClose = process.env.RP_H4_TEST_HOLD_AFTER_CLOSE === "1";
const mismatchLoginPasswords =
  process.env.RP_H4_TEST_MISMATCH_LOGIN_PASSWORDS === "1";
const record = (entry: Record<string, unknown>) => {
  if (recordFile !== undefined) {
    appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
  }
};

const opened: string[] = [];
function watchFileOpens() {
  const note = (path: unknown) => {
    opened.push(
      typeof path === "string"
        ? path
        : path instanceof URL
          ? fileURLToPath(path)
          : Buffer.isBuffer(path)
            ? path.toString()
            : `<descriptor ${String(path)}>`,
    );
  };
  const wrap = <T extends object, K extends keyof T>(target: T, name: K) => {
    const original = target[name] as unknown as (...args: unknown[]) => unknown;
    (target as Record<K, unknown>)[name] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      note(args[0]);
      return original.apply(this, args);
    };
  };
  wrap(fs, "open");
  wrap(fs, "openSync");
  wrap(fs, "readFile");
  wrap(fs, "readFileSync");
  wrap(fs, "createReadStream");
  wrap(fs.promises, "open");
  wrap(fs.promises, "readFile");
  syncBuiltinESMExports();
}

/** Gives each login URL in `secrets.json` a password its login does not have. */
function giveLoginUrlsOtherPasswords(dataDirectory: string) {
  const secrets = readSecrets(dataDirectory, "pg");
  if (secrets?.loginUrls === undefined) {
    throw new Error("secrets.json holds no login URLs to change.");
  }
  const loginUrls = Object.fromEntries(
    Object.entries(secrets.loginUrls).map(([kind, value]) => {
      const url = new URL(value);
      url.password = randomBytes(32).toString("base64url");
      return [kind, url.toString()];
    }),
  ) as typeof secrets.loginUrls;
  writeSecrets(dataDirectory, { ...secrets, loginUrls }, "pg");
}

process.exitCode = await runStart(process.argv.slice(2), process.env, {
  operatorEntry: fileURLToPath(
    new URL("../operator/operator.test-entry.ts", import.meta.url),
  ),
  spawnOperator: (command, args, options) => {
    record({ process: "spawn", command, args });
    return spawn(command, args, options);
  },
  afterBoundary: (boundary) => {
    record({
      process: "parent",
      boundary,
      argv: process.argv,
      env: process.env,
    });
  },
  serve: (context) =>
    serveFromDataDirectory({
      ...context,
      hooks: {
        beforeServing: () => {
          if (mismatchLoginPasswords) {
            giveLoginUrlsOtherPasswords(context.dataDirectory);
          }
          watchFileOpens();
        },
        afterServing: ({ url, pid, surface }) => {
          record({
            process: "serve",
            event: "serving",
            url,
            pid,
            argv: process.argv,
            env: process.env,
            opened: [...opened],
            surface: surface ?? null,
          });
        },
        afterClose: async () => {
          record({ process: "serve", event: "closed", opened: [...opened] });
          if (!holdAfterClose || recordFile === undefined) return;
          const seen = `${recordFile}.closed-seen`;
          const until = Date.now() + 90_000;
          while (!existsSync(seen) && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
      },
    }),
});
