import {
  createEnvelopeEncryption,
  decodeBase64Key,
  type EncryptedEnvelope,
  LocalAesKeyEncryptionKeyProvider,
} from "@requestport/domain";

import { workerSettings } from "./worker-storages.js";

/** The workspace key ring from the worker settings (`worker-storages.ts`). */
function encryption() {
  const keys = workerSettings().secrets.workspaceKeys;
  if (!keys) throw new Error("Slack encryption is unavailable");
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

export async function decryptSlackInstallationToken(input: {
  organizationId: string;
  installationId: string;
  envelope: EncryptedEnvelope;
}) {
  const value = await encryption().decrypt<{ token: string }>(
    input.envelope,
    new TextEncoder().encode(
      `requestport:slack:${input.organizationId}:${input.installationId}:bot-token`,
    ),
  );
  if (!value.token) throw new Error("Slack installation token is unavailable");
  return value.token;
}

export function slackTokenSecret() {
  const secret = workerSettings().secrets.slackStateSecret;
  if (!secret) throw new Error("Slack token hashing is unavailable");
  return secret;
}
