import { Card } from "@cueplusplus/ui/layout";
import {
  readSignInMethods,
  type SignInMethods,
} from "@requestport/config/sign-in-methods";
import { WaysIn } from "../ways-in.js";
import { authorizationResumeTarget } from "./authorization-resume.js";
import { LostCredentialHelp, SignInForm } from "./sign-in-form.js";

export default async function SignInPage({
  searchParams,
}: {
  // The provider sends an agent's whole authorization request here when it
  // arrives without a session. Reading it is what lets sign-in hand the
  // request back rather than drop it.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries((await searchParams) ?? {})) {
    for (const one of Array.isArray(value) ? value : [value ?? ""]) {
      if (one !== "") params.append(name, one);
    }
  }
  const resumeTo = authorizationResumeTarget(params);

  // Read the way `parseServerEnv` reads it, from the unparsed environment: a
  // page must not turn a missing database URL into a rendering error, and the
  // server has already refused to boot on anything this could misread.
  const methods = readSignInMethods(process.env);
  const anyMethod =
    methods.github || methods.magicLink || methods.localCredential;

  const host = hostOf(process.env.BETTER_AUTH_URL);

  // The reference build's sign-in (ruling 259): where this signs in to and
  // what it offers under the heading, then one card holding every way in this
  // deployment offers, and the way back from a lost credential where one is.
  return (
    <WaysIn
      lines={
        <>
          {host ? <p className="text-fg-muted">to {host}</p> : null}
          <p className="text-center text-fg-muted">{subtitleFor(methods)}</p>
        </>
      }
      title="Sign in"
    >
      {anyMethod ? (
        <Card.Root className="w-full">
          <Card.Content>
            <SignInForm methods={methods} resumeTo={resumeTo} />
          </Card.Content>
        </Card.Root>
      ) : null}
      {methods.localCredential ? <LostCredentialHelp /> : null}
    </WaysIn>
  );
}

/**
 * The host this page signs in to, read from the address the deployment's
 * authentication is configured for, the way the methods are read: unparsed,
 * and a value that is missing or is not a URL is simply not shown.
 */
function hostOf(url: string | undefined) {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** One sentence naming exactly the ways in this deployment offers. */
function subtitleFor(methods: SignInMethods) {
  const ways = [
    methods.github ? "your GitHub account" : undefined,
    methods.magicLink ? "an approved email address" : undefined,
    methods.localCredential
      ? "the local credential your operator issued"
      : undefined,
  ].filter((way) => way !== undefined);

  if (ways.length === 0) {
    return "No sign-in method is configured for this deployment.";
  }
  const last = ways.pop();
  return ways.length === 0
    ? `Use ${last}.`
    : `Use ${ways.join(", ")} or ${last}.`;
}
