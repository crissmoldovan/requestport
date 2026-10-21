import { createHmac } from "node:crypto";

import {
  createEnvelopeEncryption,
  decodeBase64Key,
  type EnvelopeEncryption,
  LocalAesKeyEncryptionKeyProvider,
} from "@requestport/domain";

import type { RequestPortKeyRing } from "./options.js";

/*
 * The secrets port (manifest-g.md §2.3): what core derives from the secrets
 * it is given. Each derivation is the one the web made from `serverEnv`
 * before core existed, so a receipt or an envelope written before a deploy
 * still matches after it.
 */

/**
 * The key both command buses fingerprint actors and idempotency keys with:
 * HMAC-SHA256 keyed by `commandFingerprintKey` (`BETTER_AUTH_SECRET` today)
 * over `"requestport-command-fingerprint-v1"`, in hex.
 *
 * `BETTER_AUTH_SECRET` reaches two other keys, and neither is this one: the
 * web's off-bus receipts take it raw, and the stale-session sweep in
 * `packages/jobs` derives its own key from it under
 * `"requestport-work-sweep-v1"`.
 */
export function commandFingerprintSecret(commandFingerprintKey: string) {
  return createHmac("sha256", commandFingerprintKey)
    .update("requestport-command-fingerprint-v1")
    .digest("hex");
}

/**
 * Envelope encryption over a key ring: the current key wraps; the previous
 * one, when given, still unwraps. Its keys go into the provider's map current
 * first, as the web has always put them, so a previous key of the same
 * version replaces the current one, as it did there.
 */
export function createKeyRingEncryption(
  keys: RequestPortKeyRing,
): EnvelopeEncryption {
  return createEnvelopeEncryption(
    new LocalAesKeyEncryptionKeyProvider(
      keys.current.version,
      new Map([
        [keys.current.version, decodeBase64Key(keys.current.key)],
        ...(keys.previous
          ? [
              [
                keys.previous.version,
                decodeBase64Key(keys.previous.key),
              ] as const,
            ]
          : []),
      ]),
    ),
  );
}

/**
 * The workspace envelope encryption the command registry is composed with
 * (`createKeyRingEncryption`), or none when no key ring is given.
 */
export function createWorkspaceEncryption(
  keys: RequestPortKeyRing | undefined,
): EnvelopeEncryption | undefined {
  return keys ? createKeyRingEncryption(keys) : undefined;
}
