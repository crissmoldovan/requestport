import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { defaultSelfHostWebDirectory, locateSelfHostWeb } from "./serve/web.js";
import { SERVER_ACTION_KEY_FILE } from "./server-action-key.js";
import {
  type Finished,
  freePort,
  runStart,
} from "./test-support/start-process.js";

/*
 * The web UI's server-action key, served (ruling 201 item 4): a first start
 * in a fresh data directory, then a later one, each a process of its own
 * through `test-support/action-key.test-entry.ts`, which asks Next, inside
 * the started process and once it serves, for the key it encrypts server
 * actions' bound arguments with, and records an argument it encrypted with
 * that key as Next's `encodeActionBoundArg` does. Here that argument is
 * decrypted with the data directory's key, which must open it, and with the
 * key Next's build wrote into the server-reference manifest, which must not.
 * The output of both starts must never carry the key.
 *
 * On PGlite, so that no PostgreSQL is needed: the key is handed to Next by
 * the serving step whatever the storage (`serve/run.ts`). The self-host
 * build is the integration project's global setup's, as for every suite
 * that serves the web UI. The data directory is under this run's default
 * temporary directory, with a space in its name (ruling 152). No key is
 * written to the output of this suite: an assertion compares, and a failed
 * one names the case.
 */

const MANIFEST = join(
  defaultSelfHostWebDirectory(),
  ".next-self-host",
  "server",
  "server-reference-manifest.json",
);
const scratch = mkdtempSync(join(tmpdir(), "requestport-action-key "));
const directory = join(scratch, "data pglite");
const keyFile = join(directory, SERVER_ACTION_KEY_FILE);
const ACTION = `h11-action-${randomBytes(4).toString("hex")}`;
const ARGUMENT = `h11-argument-${randomBytes(4).toString("hex")}`;

interface Started {
  finished: Finished;
  probe: { status?: number; sealed?: string; failure?: string };
  /** The key file's contents and mode once the start had stopped. */
  keyFile: { contents: string; mode: number };
}

const starts: Started[] = [];
let manifestKey: string;

/** Runs a start of the instance in `directory`, the first time initialising it. */
async function start(first: boolean, port: number): Promise<Started> {
  const record = join(scratch, `record ${randomUUID()}.jsonl`);
  const finished = await runStart(
    "action-key",
    first
      ? [
          "--data-dir",
          directory,
          "--storage",
          "pglite",
          "--port",
          String(port),
          "--email",
          "owner@example.com",
          "--organization",
          "acme",
          "--organization-name",
          "Acme",
        ]
      : ["--data-dir", directory],
    {
      env: {
        ...process.env,
        RP_H11_RECORD: record,
        RP_H11_PROBE_ACTION: ACTION,
        RP_H11_PROBE_ARGUMENT: ARGUMENT,
      },
      whileServing: async () => {
        const until = Date.now() + 60_000;
        while (!existsSync(record) && Date.now() < until) {
          await new Promise((settle) => setTimeout(settle, 100));
        }
      },
    },
  );
  const [probe] = existsSync(record)
    ? readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [{ failure: "the start recorded no probe" }];
  return {
    finished,
    probe,
    keyFile: {
      contents: readFileSync(keyFile, "utf8"),
      mode: statSync(keyFile).mode & 0o777,
    },
  };
}

/** What `sealed` holds under `rawKey`, as Next's `decodeActionBoundArg` reads it, or `undefined` where the key does not open it. */
async function openWith(rawKey: string, sealed: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(rawKey, "base64"),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const bytes = Buffer.from(sealed, "base64");
  try {
    const text = new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 16) },
        key,
        bytes.subarray(16),
      ),
    );
    return text.startsWith(ACTION) ? text.slice(ACTION.length) : undefined;
  } catch {
    return undefined;
  }
}

beforeAll(async () => {
  // The global setup builds it; without it every start below refuses.
  locateSelfHostWeb();
  manifestKey = (
    JSON.parse(readFileSync(MANIFEST, "utf8")) as { encryptionKey: string }
  ).encryptionKey;
  const port = await freePort();
  starts.push(await start(true, port));
  starts.push(await start(false, port));
}, 300_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("requestport start's server-action key (ruling 201 item 4)", () => {
  test("a first start in a fresh data directory makes one key, at mode 0600, and a second start keeps it", () => {
    for (const { finished } of starts) {
      expect(finished.code, finished.stderr).toBe(0);
      expect(finished.served).toBe(true);
    }
    const [first, second] = starts as [Started, Started];

    // Booleans, so that a failure prints no key.
    expect(first.keyFile.mode).toBe(0o600);
    expect(second.keyFile.mode).toBe(0o600);
    expect(
      /^[A-Za-z0-9+/]{43}=\n$/u.test(first.keyFile.contents),
      "the key file holds base64 of 32 bytes and a line break",
    ).toBe(true);
    expect(
      second.keyFile.contents === first.keyFile.contents,
      "the second start kept the first start's key",
    ).toBe(true);
    expect(
      first.keyFile.contents.trim() === manifestKey,
      "the data directory's key is the manifest's",
    ).toBe(false);
  });

  test("Next, in the started process, encrypts a bound argument with the data directory's key and not with the key its build wrote into the server-reference manifest", async () => {
    const key = (starts[0] as Started).keyFile.contents.trim();
    expect(typeof manifestKey).toBe("string");

    for (const { probe } of starts) {
      expect(probe.failure).toBeUndefined();
      expect(probe.status).toBe(200);
      const sealed = probe.sealed as string;
      expect(
        await openWith(key, sealed),
        "the data directory's key opens it",
      ).toBe(ARGUMENT);
      expect(
        await openWith(manifestKey, sealed),
        "the manifest's key opens it",
      ).toBeUndefined();
    }
  });

  test("neither start's standard output nor its standard error, log events included, carries the key, in base64, base64url or hex", () => {
    const raw = Buffer.from(
      (starts[0] as Started).keyFile.contents.trim(),
      "base64",
    );
    const forms = [
      raw.toString("base64"),
      raw.toString("base64url"),
      raw.toString("hex"),
    ];
    for (const { finished } of starts) {
      expect(finished.stdout.length).toBeGreaterThan(0);
      for (const [stream, text] of [
        ["stdout", finished.stdout],
        ["stderr", finished.stderr],
      ] as const) {
        expect(
          forms.filter((form) => text.includes(form)).length,
          `${stream} carries the key`,
        ).toBe(0);
      }
    }
  });
});
