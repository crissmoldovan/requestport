import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export function createOpaqueSlackToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashSlackToken(secret: string, token: string) {
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

export function verifySlackTokenHash(
  secret: string,
  token: string,
  expectedHash: string,
) {
  if (!/^[0-9a-f]{64}$/u.test(expectedHash)) return false;
  const actual = Buffer.from(hashSlackToken(secret, token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  );
}
