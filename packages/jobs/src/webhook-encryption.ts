import {
  createEnvelopeEncryption,
  decodeBase64Key,
  LocalAesKeyEncryptionKeyProvider,
} from "@requestport/domain";

import { workerSettings } from "./worker-storages.js";

/** The webhook key ring from the worker settings (`worker-storages.ts`). */
export function webhookEncryption() {
  const keys = workerSettings().secrets.webhookKeys;
  if (!keys) throw new Error("Webhook encryption is unavailable");
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

export function webhookAad(
  organizationId: string,
  subscriptionId: string,
  slot: "current" | "next",
) {
  return new TextEncoder().encode(
    `requestport:webhook:${organizationId}:${subscriptionId}:${slot}`,
  );
}
