import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { DomainError } from "../shared/errors.js";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type EncryptedEnvelope = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  wrappedDek: Uint8Array;
  kekVersion: string;
};

export type SerializedEncryptedEnvelope = {
  ciphertext: string;
  nonce: string;
  wrappedDek: string;
  kekVersion: string;
};

export function serializeEncryptedEnvelope(
  envelope: EncryptedEnvelope,
): SerializedEncryptedEnvelope {
  return {
    ciphertext: Buffer.from(envelope.ciphertext).toString("base64url"),
    nonce: Buffer.from(envelope.nonce).toString("base64url"),
    wrappedDek: Buffer.from(envelope.wrappedDek).toString("base64url"),
    kekVersion: envelope.kekVersion,
  };
}

export function deserializeEncryptedEnvelope(
  value: Record<string, unknown>,
): EncryptedEnvelope {
  if (
    typeof value.ciphertext !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.wrappedDek !== "string" ||
    typeof value.kekVersion !== "string"
  )
    throw new DomainError("validation_failed", "Encrypted envelope is invalid");
  return {
    ciphertext: Buffer.from(value.ciphertext, "base64url"),
    nonce: Buffer.from(value.nonce, "base64url"),
    wrappedDek: Buffer.from(value.wrappedDek, "base64url"),
    kekVersion: value.kekVersion,
  };
}

export interface KeyEncryptionKeyProvider {
  activeVersion(): Promise<string>;
  wrap(version: string, dek: Uint8Array): Promise<Uint8Array>;
  unwrap(version: string, wrapped: Uint8Array): Promise<Uint8Array>;
}

export interface EnvelopeEncryption {
  encrypt<T>(value: T, aad: Uint8Array): Promise<EncryptedEnvelope>;
  decrypt<T>(envelope: EncryptedEnvelope, aad: Uint8Array): Promise<T>;
  rewrap(
    envelope: EncryptedEnvelope,
    nextVersion: string,
  ): Promise<EncryptedEnvelope>;
}

function encryptBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]);
}

function decryptBytes(
  encrypted: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
) {
  if (encrypted.byteLength <= TAG_BYTES) {
    throw new DomainError("validation_failed", "Encrypted value is invalid");
  }
  const ciphertext = Buffer.from(encrypted).subarray(0, -TAG_BYTES);
  const tag = Buffer.from(encrypted).subarray(-TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DomainError(
      "forbidden",
      "Encrypted value could not be authenticated",
    );
  }
}

export class LocalAesKeyEncryptionKeyProvider
  implements KeyEncryptionKeyProvider
{
  constructor(
    private readonly active: string,
    private readonly keys: ReadonlyMap<string, Uint8Array>,
  ) {
    if (!keys.has(active)) {
      throw new Error("The active key-encryption-key version is unavailable");
    }
    for (const key of keys.values()) {
      if (key.byteLength !== KEY_BYTES) {
        throw new Error(
          "Every key-encryption key must contain exactly 32 bytes",
        );
      }
    }
  }

  activeVersion() {
    return Promise.resolve(this.active);
  }

  async wrap(version: string, dek: Uint8Array) {
    const key = this.keys.get(version);
    if (!key)
      throw new Error(
        "The requested key-encryption-key version is unavailable",
      );
    const nonce = randomBytes(NONCE_BYTES);
    const aad = Buffer.from(`requestport:kek:${version}`, "utf8");
    return Buffer.concat([nonce, encryptBytes(dek, key, nonce, aad)]);
  }

  async unwrap(version: string, wrapped: Uint8Array) {
    const key = this.keys.get(version);
    if (!key)
      throw new Error(
        "The requested key-encryption-key version is unavailable",
      );
    if (wrapped.byteLength <= NONCE_BYTES + TAG_BYTES) {
      throw new DomainError("validation_failed", "Wrapped key is invalid");
    }
    const nonce = Buffer.from(wrapped).subarray(0, NONCE_BYTES);
    const encrypted = Buffer.from(wrapped).subarray(NONCE_BYTES);
    return decryptBytes(
      encrypted,
      key,
      nonce,
      Buffer.from(`requestport:kek:${version}`, "utf8"),
    );
  }
}

export function createEnvelopeEncryption(
  provider: KeyEncryptionKeyProvider,
): EnvelopeEncryption {
  return {
    async encrypt<T>(value: T, aad: Uint8Array) {
      const dek = randomBytes(KEY_BYTES);
      const nonce = randomBytes(NONCE_BYTES);
      const version = await provider.activeVersion();
      const plaintext = Buffer.from(JSON.stringify(value), "utf8");
      return {
        ciphertext: encryptBytes(plaintext, dek, nonce, aad),
        nonce,
        wrappedDek: await provider.wrap(version, dek),
        kekVersion: version,
      };
    },

    async decrypt<T>(envelope: EncryptedEnvelope, aad: Uint8Array) {
      const dek = await provider.unwrap(
        envelope.kekVersion,
        envelope.wrappedDek,
      );
      const plaintext = decryptBytes(
        envelope.ciphertext,
        dek,
        envelope.nonce,
        aad,
      );
      try {
        return JSON.parse(plaintext.toString("utf8")) as T;
      } catch {
        throw new DomainError("validation_failed", "Encrypted JSON is invalid");
      }
    },

    async rewrap(envelope, nextVersion) {
      const dek = await provider.unwrap(
        envelope.kekVersion,
        envelope.wrappedDek,
      );
      return {
        ...envelope,
        wrappedDek: await provider.wrap(nextVersion, dek),
        kekVersion: nextVersion,
      };
    },
  };
}

export function decodeBase64Key(value: string) {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== KEY_BYTES) {
    throw new Error("Workspace KEK must be a base64url-encoded 32-byte key");
  }
  return decoded;
}
