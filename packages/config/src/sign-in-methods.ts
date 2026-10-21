/**
 * Which ways into the application a configuration enables.
 *
 * Two external methods, each switched on by its own pair of values: GitHub by
 * `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, the emailed magic link by
 * `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. Either, both or neither may be
 * configured; `parseServerEnv` refuses half a pair, and refuses a Vercel
 * production deployment without both.
 *
 * The third method is the local owner credential that the private operator
 * CLI's `requestport-operator bootstrap-owner --local-credential` issues, or
 * that a self-host's first `requestport start` prints. It exists for local
 * and self-hosted use, so wherever `VERCEL_ENV` is set — any value, Preview and
 * development included — it is off, and `REQUESTPORT_LOCAL_CREDENTIAL` cannot
 * turn it on: a bootstrap credential on a public URL is what that closes.
 * Without `VERCEL_ENV`, with no external method configured it is on unless
 * switched off, because otherwise the deployment boots with no way in at all;
 * beside an external method it is off unless `REQUESTPORT_LOCAL_CREDENTIAL=enabled`
 * says otherwise.
 *
 * This module parses nothing and imports nothing, so a page can ask the
 * question without making a missing database URL a rendering error.
 */
export type SignInMethods = {
  github: boolean;
  magicLink: boolean;
  localCredential: boolean;
};

export type SignInMethodEnvironment = Readonly<{
  GITHUB_CLIENT_ID?: string | undefined;
  GITHUB_CLIENT_SECRET?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  RESEND_FROM_EMAIL?: string | undefined;
  REQUESTPORT_LOCAL_CREDENTIAL?: "enabled" | "disabled" | undefined;
  VERCEL_ENV?: string | undefined;
}>;

function present(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

/**
 * The local credential's rule, for a caller that has already decided the two
 * external methods — the auth composition knows the magic link by whether it
 * was handed a sender, not by the Resend values.
 *
 * `vercelEnv` is required, not optional, so that no caller can leave it out
 * and be read as "not Vercel": any string, empty included, means a Vercel
 * deployment and the answer is off before the switch is consulted.
 */
export function localCredentialEnabled({
  github,
  magicLink,
  localCredentialSwitch,
  vercelEnv,
}: {
  github: boolean;
  magicLink: boolean;
  localCredentialSwitch: SignInMethodEnvironment["REQUESTPORT_LOCAL_CREDENTIAL"];
  vercelEnv: string | undefined;
}) {
  if (vercelEnv !== undefined) return false;

  return (
    localCredentialSwitch === "enabled" ||
    (localCredentialSwitch !== "disabled" && !github && !magicLink)
  );
}

/** The answer for a configuration that uses the canonical names. */
export function signInMethodsFor(env: SignInMethodEnvironment): SignInMethods {
  const github =
    present(env.GITHUB_CLIENT_ID) && present(env.GITHUB_CLIENT_SECRET);
  const magicLink =
    present(env.RESEND_API_KEY) && present(env.RESEND_FROM_EMAIL);

  return {
    github,
    magicLink,
    localCredential: localCredentialEnabled({
      github,
      magicLink,
      localCredentialSwitch: env.REQUESTPORT_LOCAL_CREDENTIAL,
      vercelEnv: env.VERCEL_ENV,
    }),
  };
}

function localCredentialSwitch(value: unknown) {
  return value === "enabled" || value === "disabled" ? value : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

/**
 * The same answer from an unparsed environment, reading the names
 * `parseServerEnv` would read: in a Vercel Preview, the
 * `REQUESTPORT_PREVIEW_`-prefixed values and never the canonical ones, which
 * belong to production.
 */
export function readSignInMethods(
  env: Readonly<Record<string, unknown>>,
): SignInMethods {
  const preview = env.VERCEL_ENV === "preview";
  const read = (name: string) =>
    text(preview ? env[`REQUESTPORT_PREVIEW_${name}`] : env[name]);

  return signInMethodsFor({
    GITHUB_CLIENT_ID: read("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: read("GITHUB_CLIENT_SECRET"),
    RESEND_API_KEY: read("RESEND_API_KEY"),
    RESEND_FROM_EMAIL: read("RESEND_FROM_EMAIL"),
    REQUESTPORT_LOCAL_CREDENTIAL: localCredentialSwitch(
      env.REQUESTPORT_LOCAL_CREDENTIAL,
    ),
    VERCEL_ENV: text(env.VERCEL_ENV),
  });
}
