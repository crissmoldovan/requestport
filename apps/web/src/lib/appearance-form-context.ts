import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The render-context token that every appearance form carries.
 *
 * It is *not* an authorization grant. The action always derives the actor and
 * the current organization from the authenticated request; this token only
 * records which actor and tenant the form in the user's hand was rendered for,
 * so a stale document — a second tab that switched organization, a form left
 * open across an account switch, an expired page — is rejected with a fixed
 * `context_conflict` instead of writing to whichever tenant happens to be
 * current now. It therefore carries no session or credential material, and
 * knowing it grants nothing.
 */

/** Domain separation: this key never overlaps another HMAC use of the secret. */
export const appearanceFormContextDomain = "appearance-form-context-v1";

/** A rendered appearance form stays submittable for fifteen minutes. */
export const appearanceFormContextTtlSeconds = 900;

/** Tolerated clock skew between the rendering and verifying processes. */
export const appearanceFormContextSkewSeconds = 60;

/** Enough for the sealed payload; anything larger is refused before parsing. */
export const appearanceFormContextMaxLength = 512;

/** The same floor `keyedFingerprint` enforces on the command secret. */
const minimumSecretLength = 32;

const tokenVersion = "v1";

export type AppearanceFormContextClaims = {
  actorId: string;
  /** `null` for a personal form: personal preferences are global to the user. */
  organizationId: string | null;
};

type SealedPayload = {
  a: string;
  o: string | null;
  t: number;
};

function domainKey(secret: string) {
  if (typeof secret !== "string" || secret.length < minimumSecretLength) {
    throw new Error("RequestPort appearance form-context secret is invalid");
  }
  return createHmac("sha256", secret)
    .update(appearanceFormContextDomain)
    .digest();
}

function seal(secret: string, payload: string) {
  return createHmac("sha256", domainKey(secret)).update(payload).digest();
}

/**
 * Seals the claims for one rendered form. `issuedAt` is injectable so the tests
 * can pin the clock; production always uses the current time.
 */
export function createAppearanceFormContext(input: {
  claims: AppearanceFormContextClaims;
  issuedAt?: number;
  secret: string;
}): string {
  const payload: SealedPayload = {
    a: input.claims.actorId,
    o: input.claims.organizationId,
    t: Math.floor((input.issuedAt ?? Date.now()) / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${tokenVersion}.${encoded}.${seal(input.secret, encoded).toString("base64url")}`;
}

/**
 * The two scopes a form can be minted for, as separate functions rather than
 * one `claims` argument.
 *
 * A personal form is global to the actor and must carry no tenant; an
 * organization form must carry exactly the tenant it edits. Spelling that out
 * at each call site put a `null`/`organizationId` choice in front of every
 * composition root, where the wrong branch is silent: the write returns a fixed
 * `context_conflict` forever and no type objects. Here the choice is the
 * function name, and neither signature can express the other's mistake.
 */
export function createPersonalAppearanceFormContext(input: {
  actorId: string;
  issuedAt?: number;
  secret: string;
}): string {
  return createAppearanceFormContext({
    claims: { actorId: input.actorId, organizationId: null },
    issuedAt: input.issuedAt,
    secret: input.secret,
  });
}

export function createOrganizationAppearanceFormContext(input: {
  actorId: string;
  issuedAt?: number;
  organizationId: string;
  secret: string;
}): string {
  return createAppearanceFormContext({
    claims: { actorId: input.actorId, organizationId: input.organizationId },
    issuedAt: input.issuedAt,
    secret: input.secret,
  });
}

function parsePayload(encoded: string): SealedPayload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  const organizationId = record.o;
  if (
    typeof record.a !== "string" ||
    record.a.length === 0 ||
    !(organizationId === null || typeof organizationId === "string") ||
    typeof record.t !== "number" ||
    !Number.isSafeInteger(record.t)
  ) {
    return null;
  }
  return { a: record.a, o: organizationId, t: record.t };
}

function equalBytes(left: Buffer, right: Buffer) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * Verifies the signature in constant time, then compares the sealed claims with
 * the freshly authenticated context. Every failure — tamper, unknown version,
 * expiry, account switch, organization switch — returns the same `false`, so
 * the caller has exactly one fixed outcome to map and the token leaks nothing
 * about which check rejected it.
 */
export function verifyAppearanceFormContext(input: {
  expected: AppearanceFormContextClaims;
  now?: number;
  secret: string;
  token: unknown;
  ttlSeconds?: number;
}): boolean {
  const { token } = input;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > appearanceFormContextMaxLength
  ) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, encoded, signature] = parts as [string, string, string];
  if (version !== tokenVersion || encoded.length === 0) return false;

  let expectedMac: Buffer;
  try {
    expectedMac = seal(input.secret, encoded);
  } catch {
    return false;
  }
  if (!equalBytes(Buffer.from(signature, "base64url"), expectedMac)) {
    return false;
  }

  const payload = parsePayload(encoded);
  if (!payload) return false;

  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const age = nowSeconds - payload.t;
  const ttl = input.ttlSeconds ?? appearanceFormContextTtlSeconds;
  if (age > ttl || age < -appearanceFormContextSkewSeconds) return false;

  return (
    payload.a === input.expected.actorId &&
    payload.o === input.expected.organizationId
  );
}
