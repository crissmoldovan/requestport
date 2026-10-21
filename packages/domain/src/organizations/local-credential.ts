import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * The local owner credential: a secret the operator command issues, so a
 * deployment with no GitHub app and no email provider still has a way in.
 *
 * It lives in Better Auth's own `account` table, as the row Better Auth's
 * email-and-password sign-in reads (`providerId` "credential", the hash in
 * `password`). Better Auth is configured to hash and verify with these two
 * functions rather than its own, so the operator command — which runs without
 * Better Auth — writes exactly what sign-in checks. Nothing else in this
 * repository writes that column.
 */
export const LOCAL_CREDENTIAL_PROVIDER_ID = "credential";

/*
  Better Auth's own defaults for its scrypt hasher (N 16384, r 16, p 1, 64-byte
  key). Node's scrypt refuses anything needing more than 32 MiB unless told,
  and 128 * N * r is exactly 32 MiB, so the ceiling is raised explicitly.
*/
const parameters = { N: 16_384, r: 16, p: 1, keyLength: 64 } as const;
const maxmem = 64 * 1024 * 1024;
const scheme = "scrypt";
const version = "v1";

function derive(password: string, salt: Buffer, keyLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      keyLength,
      { N: parameters.N, r: parameters.r, p: parameters.p, maxmem },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** 32 random bytes, base64url: 43 printable characters, 256 bits. */
export function generateLocalCredential() {
  return randomBytes(32).toString("base64url");
}

/** `scrypt$v1$N$r$p$<salt>$<key>`, salt and key base64url. */
export async function hashLocalCredential(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, parameters.keyLength);

  return [
    scheme,
    version,
    parameters.N,
    parameters.r,
    parameters.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Whether `password` is the credential `hash` was made from.
 *
 * Only a value this module wrote is accepted, at exactly the parameters it
 * writes: anything else — another scheme, other parameters, a truncated row —
 * is a refusal, never an attempt to derive with whatever the row says.
 */
export async function verifyLocalCredential({
  hash,
  password,
}: {
  hash: string;
  password: string;
}) {
  const parts = hash.split("$");
  if (parts.length !== 7) return false;
  const [storedScheme, storedVersion, n, r, p, salt, key] = parts;
  if (
    storedScheme !== scheme ||
    storedVersion !== version ||
    n !== String(parameters.N) ||
    r !== String(parameters.r) ||
    p !== String(parameters.p) ||
    !salt ||
    !key
  ) {
    return false;
  }
  const expected = Buffer.from(key, "base64url");
  if (expected.length !== parameters.keyLength) return false;
  const actual = await derive(
    password,
    Buffer.from(salt, "base64url"),
    expected.length,
  );

  return timingSafeEqual(actual, expected);
}
