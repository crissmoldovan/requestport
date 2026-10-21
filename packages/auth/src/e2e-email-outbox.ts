import { normalizeSignupEmail } from "./signup-policy.js";

export const E2E_TOKEN_HEADER = "x-requestport-e2e-token";

export type E2EEnvironment = Readonly<{
  NODE_ENV?: string;
  REQUESTPORT_E2E_MODE?: string;
  REQUESTPORT_E2E_TOKEN?: string;
}>;

type MagicLinkEntry = Readonly<{
  email: string;
  url: string;
}>;

type E2EOutboxGlobal = typeof globalThis & {
  [outboxKey]?: Map<string, MagicLinkEntry>;
};

const minimumTokenLength = 32;
const outboxKey = Symbol.for("requestport.e2e.magic-link-outbox");

function outbox() {
  const shared = globalThis as E2EOutboxGlobal;
  shared[outboxKey] ??= new Map<string, MagicLinkEntry>();
  return shared[outboxKey];
}

export function isE2EEmailMode(env: E2EEnvironment = process.env) {
  return (
    (env.NODE_ENV === "development" || env.NODE_ENV === "test") &&
    env.REQUESTPORT_E2E_MODE === "1" &&
    typeof env.REQUESTPORT_E2E_TOKEN === "string" &&
    env.REQUESTPORT_E2E_TOKEN.length >= minimumTokenLength
  );
}

function assertE2EEmailMode(env: E2EEnvironment) {
  if (!isE2EEmailMode(env)) {
    throw new Error("E2E email outbox is unavailable");
  }
}

export function captureE2EMagicLink(
  input: MagicLinkEntry,
  env: E2EEnvironment = process.env,
) {
  assertE2EEmailMode(env);
  const email = normalizeSignupEmail(input.email);
  outbox().set(email, { email, url: input.url });
}

export function readE2EMagicLink(
  email: string,
  env: E2EEnvironment = process.env,
) {
  assertE2EEmailMode(env);
  return outbox().get(normalizeSignupEmail(email)) ?? null;
}

export function clearE2EMagicLinks(env: E2EEnvironment = process.env) {
  assertE2EEmailMode(env);
  outbox().clear();
}
