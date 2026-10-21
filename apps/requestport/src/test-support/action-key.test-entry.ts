import type { webcrypto } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { serveFromDataDirectory } from "../serve/run.js";
import { runStart } from "../start/start.js";
import { SELF_HOST_DIST_DIR } from "../web/self-host-dist-dir.js";

/*
 * The server-action key's `requestport start`
 * (`server-action-key.integration.test.ts`; ruling 201 item 4): `runStart`
 * as the executable runs it, over this process's arguments and environment,
 * which, once the start serves, asks Next in this process which key it
 * encrypts server actions' bound arguments with, and appends what it
 * encrypted, as one JSON line, to the file `RP_H11_RECORD` names:
 *
 * 1. it fetches `/sign-in` from the start's own listener, so that Next
 *    renders an app page: it loads its manifests, which
 *    `getActionEncryptionKey` reads (`next@16.3.8`
 *    `dist/server/app-render/manifests-singleton.js:271-322`), and the
 *    page's server chunks into the build's webpack runtime, among them the
 *    one that carries Next's `encryption-utils` compiled into the build;
 * 2. it takes that webpack runtime from the build the start serves
 *    (`server/webpack-runtime.js`, which Node's module cache holds once for
 *    the process), finds the one module of the build whose code says
 *    "Missing encryption key for Server Actions", which is that copy of
 *    `encryption-utils`, and calls its `getActionEncryptionKey`: the key the
 *    build's server actions use for a bound argument, from
 *    `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` when it is set and from the
 *    server-reference manifest otherwise
 *    (`dist/server/app-render/encryption-utils.js:73-91`, as compiled);
 * 3. it encrypts the argument `RP_H11_PROBE_ARGUMENT` names under the action
 *    id `RP_H11_PROBE_ACTION` names with that key, as
 *    Next's `encodeActionBoundArg` does (`encryption.js:70-85`: 16 random
 *    bytes of IV, AES-GCM over the action id and the argument, base64), and
 *    records the result, `sealed`, and the page's status.
 *
 * It records no key: the test decrypts `sealed` with each key it reads.
 * Only the tests start this module.
 */

/** The build's webpack runtime, as `server/webpack-runtime.js` exports it. */
interface WebpackRuntime {
  (id: string): unknown;
  m: Record<string, unknown>;
}

interface EncryptionUtils {
  getActionEncryptionKey(): Promise<webcrypto.CryptoKey>;
  encrypt(
    key: webcrypto.CryptoKey,
    iv: Uint8Array,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  arrayBufferToString(buffer: ArrayBufferLike): string;
}

const recordFile = process.env.RP_H11_RECORD;
const action = process.env.RP_H11_PROBE_ACTION ?? "";
const argument = process.env.RP_H11_PROBE_ARGUMENT ?? "";
const record = (entry: Record<string, unknown>) => {
  if (recordFile !== undefined) {
    appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
  }
};

async function probe(url: string, webDirectory: string) {
  const page = await fetch(`${url}/sign-in`);
  await page.arrayBuffer();
  const runtime = createRequire(join(webDirectory, "package.json"))(
    join(webDirectory, SELF_HOST_DIST_DIR, "server", "webpack-runtime.js"),
  ) as WebpackRuntime;
  const ids = Object.keys(runtime.m).filter((id) =>
    String(runtime.m[id]).includes("Missing encryption key for Server Actions"),
  );
  if (ids.length !== 1) {
    throw new Error(
      `the build's webpack runtime holds ${ids.length} modules that read the server-action key after /sign-in, not one`,
    );
  }
  const utils = runtime(ids[0] as string) as EncryptionUtils;
  const key = await utils.getActionEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const sealed = await utils.encrypt(
    key,
    iv,
    new TextEncoder().encode(action + argument),
  );
  return {
    status: page.status,
    module: ids[0],
    sealed: btoa(
      utils.arrayBufferToString(iv.buffer) + utils.arrayBufferToString(sealed),
    ),
  };
}

let probing: Promise<void> = Promise.resolve();

process.exitCode = await runStart(process.argv.slice(2), process.env, {
  serve: (context) =>
    serveFromDataDirectory({
      ...context,
      hooks: {
        afterServing: ({ url }) => {
          probing = probe(url, context.webDirectory).then(
            (probed) => record({ event: "probe", ...probed }),
            (error: unknown) =>
              record({
                event: "probe",
                failure: error instanceof Error ? error.message : String(error),
              }),
          );
        },
        afterClose: () => probing,
      },
    }),
});
