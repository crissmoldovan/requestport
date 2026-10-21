import { createHmac } from "node:crypto";

import {
  createEnvelopeEncryption,
  decodeBase64Key,
  LocalAesKeyEncryptionKeyProvider,
} from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  commandFingerprintSecret,
  createWorkspaceEncryption,
} from "./secrets.js";

/*
 * The secrets port's derivations (manifest-g.md §2.3), each against the one
 * the web made from `serverEnv` before core existed
 * (`apps/web/src/lib/server-core-commands.ts`), written out here as it was.
 * A different fingerprint key misses every receipt written before a deploy,
 * and a different key ring cannot open the envelopes already stored.
 */

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
const aad = new TextEncoder().encode("organization:secrets-test");

/** The web's workspace encryption, as it built it from `serverEnv`. */
function webWorkspaceEncryption(env: {
  REQUESTPORT_WORKSPACE_KEK: string;
  REQUESTPORT_WORKSPACE_KEK_VERSION: string;
  REQUESTPORT_WORKSPACE_KEK_PREVIOUS?: string;
  REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION?: string;
}) {
  return createEnvelopeEncryption(
    new LocalAesKeyEncryptionKeyProvider(
      env.REQUESTPORT_WORKSPACE_KEK_VERSION,
      new Map([
        [
          env.REQUESTPORT_WORKSPACE_KEK_VERSION,
          decodeBase64Key(env.REQUESTPORT_WORKSPACE_KEK),
        ],
        ...(env.REQUESTPORT_WORKSPACE_KEK_PREVIOUS &&
        env.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION
          ? [
              [
                env.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION,
                decodeBase64Key(env.REQUESTPORT_WORKSPACE_KEK_PREVIOUS),
              ] as const,
            ]
          : []),
      ]),
    ),
  );
}

describe("the command fingerprint key", () => {
  test.each([
    "secrets-test-signing-material-0000000000000001",
    "an entirely different secret, also of thirty-two characters or more",
  ])("is the web's HMAC of the secret over its label, %j", (secret) => {
    const web = createHmac("sha256", secret)
      .update("requestport-command-fingerprint-v1")
      .digest("hex");

    expect(commandFingerprintSecret(secret)).toBe(web);
  });

  test("is neither the raw secret nor the stale-session sweep's key", () => {
    const secret = "secrets-test-signing-material-0000000000000001";
    const sweep = createHmac("sha256", secret)
      .update("requestport-work-sweep-v1")
      .digest("hex");

    expect(commandFingerprintSecret(secret)).not.toBe(secret);
    expect(commandFingerprintSecret(secret)).not.toBe(sweep);
  });
});

describe("the workspace encryption", () => {
  test("is absent without a key ring, as the web's was without the variable", () => {
    expect(createWorkspaceEncryption(undefined)).toBeUndefined();
  });

  test("seals under the current key, which the web's opens, and opens what the web's sealed", async () => {
    const env = {
      REQUESTPORT_WORKSPACE_KEK: key(1),
      REQUESTPORT_WORKSPACE_KEK_VERSION: "secrets-v2",
    };
    const web = webWorkspaceEncryption(env);
    const core = createWorkspaceEncryption({
      current: { version: "secrets-v2", key: key(1) },
    });
    if (!core) throw new Error("no encryption for a key ring");

    const sealed = await core.encrypt({ token: "from core" }, aad);
    expect(sealed.kekVersion).toBe("secrets-v2");
    await expect(web.decrypt(sealed, aad)).resolves.toEqual({
      token: "from core",
    });
    await expect(
      core.decrypt(await web.encrypt({ token: "from the web" }, aad), aad),
    ).resolves.toEqual({ token: "from the web" });
  });

  test("still opens what the previous key sealed, and seals under the current one", async () => {
    const previous = webWorkspaceEncryption({
      REQUESTPORT_WORKSPACE_KEK: key(1),
      REQUESTPORT_WORKSPACE_KEK_VERSION: "secrets-v1",
    });
    const core = createWorkspaceEncryption({
      current: { version: "secrets-v2", key: key(2) },
      previous: { version: "secrets-v1", key: key(1) },
    });
    if (!core) throw new Error("no encryption for a key ring");

    await expect(
      core.decrypt(await previous.encrypt({ token: "old" }, aad), aad),
    ).resolves.toEqual({ token: "old" });
    expect((await core.encrypt({ token: "new" }, aad)).kekVersion).toBe(
      "secrets-v2",
    );
  });

  test("puts the current key into its map first, as the web did, so a previous key of the same version replaces it", async () => {
    // The web's map took the current key, then the previous one; a previous
    // key sharing the current version therefore won. Kept, not corrected:
    // the order decides which key a stored envelope opens with.
    const env = {
      REQUESTPORT_WORKSPACE_KEK: key(1),
      REQUESTPORT_WORKSPACE_KEK_VERSION: "secrets-v1",
      REQUESTPORT_WORKSPACE_KEK_PREVIOUS: key(2),
      REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION: "secrets-v1",
    };
    const web = webWorkspaceEncryption(env);
    const core = createWorkspaceEncryption({
      current: { version: "secrets-v1", key: key(1) },
      previous: { version: "secrets-v1", key: key(2) },
    });
    if (!core) throw new Error("no encryption for a key ring");

    await expect(
      core.decrypt(await web.encrypt({ token: "same" }, aad), aad),
    ).resolves.toEqual({ token: "same" });
    const underSecondKey = createWorkspaceEncryption({
      current: { version: "secrets-v1", key: key(2) },
    });
    await expect(
      underSecondKey?.decrypt(await core.encrypt({ token: "x" }, aad), aad),
    ).resolves.toEqual({ token: "x" });
  });

  test("refuses a key that is not 32 bytes, as the web's did", () => {
    expect(() =>
      createWorkspaceEncryption({
        current: { version: "secrets-v1", key: "c2hvcnQ" },
      }),
    ).toThrow("Workspace KEK must be a base64url-encoded 32-byte key");
  });
});
