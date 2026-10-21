import { Eyebrow, PageShell, Panel } from "@cueplusplus/ui/chrome";
import {
  readSignInMethods,
  type SignInMethods,
} from "@requestport/config/sign-in-methods";

import { authorizationResumeTarget } from "./authorization-resume.js";
import { SignInForm } from "./sign-in-form.js";

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

  return (
    <main>
      <PageShell
        eyebrow={<Eyebrow>RequestPort access</Eyebrow>}
        subtitle={subtitleFor(methods)}
        title="Sign in"
        width="narrow"
      >
        {anyMethod ? (
          // A panel is a rim and a surface, never padding: the density token
          // is what puts the controls off the hairline at every rung.
          <Panel className="p-(--cue-space-5)">
            <SignInForm methods={methods} resumeTo={resumeTo} />
          </Panel>
        ) : null}
      </PageShell>
    </main>
  );
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
