/**
 * The one place a shared, non-delegated credential belongs.
 *
 * Every other credential in this client is bound to a person: they consent to
 * the scopes, they can be removed from the project, and the audit record names
 * them. CI is none of those things — there is nobody to consent and nobody to
 * name — so it carries an agent credential issued from the UI and passed as a
 * secret.
 *
 * That exception lives here, alone and visible, on purpose. A resolver that
 * quietly fell back to an environment variable would let it spread to developer
 * machines, where a shared credential is exactly the wrong answer and where the
 * delegated flow already works.
 */
export const CI_CREDENTIAL_VARIABLE = "REQUESTPORT_AGENT_TOKEN";

export type CiCredential = Readonly<{ accessToken: string }>;

/**
 * Blank is absent, not empty.
 *
 * A variable set to the empty string is what a misconfigured pipeline produces —
 * a secret that did not exist, or a substitution that resolved to nothing. It
 * arrives looking like a value and would authenticate as one, so it is treated
 * as unset and the caller falls through to the delegated flow or fails there.
 */
export function readCiCredential(
  environment: Readonly<Record<string, string | undefined>>,
): CiCredential | undefined {
  const raw = environment[CI_CREDENTIAL_VARIABLE];
  const value = typeof raw === "string" ? raw.trim() : "";

  return value.length > 0 ? { accessToken: value } : undefined;
}

/**
 * Say where a credential came from, never what it is.
 *
 * Resolution is worth logging — an agent that authenticated the wrong way is a
 * real fault and hard to see — but the only safe thing to say about a token is
 * the name of the variable that carried it.
 */
export function describeCiCredential(
  credential: CiCredential | undefined,
): string {
  return credential === undefined
    ? `${CI_CREDENTIAL_VARIABLE} is not set`
    : `credential supplied by ${CI_CREDENTIAL_VARIABLE}`;
}
