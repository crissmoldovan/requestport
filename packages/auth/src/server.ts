import { serverEnv } from "@requestport/config/server";
import { applicationStorageFromEnv } from "@requestport/db/wiring";
import { createAuth } from "./create-auth.js";
import { createSafeResendClient } from "./email/resend-client.js";
import { createMagicLinkSender } from "./email/send-magic-link.js";
import {
  createE2EMagicLinkSender,
  selectServerMagicLinkSender,
} from "./server-magic-link.js";

export { createAuthRouteHandler } from "./auth-handler.js";

/*
  The web process's Better Auth: `createAuth` (create-auth.ts) composes it,
  and this module installs it, from this process's environment, as the
  module is imported (manifest-g.md §2.12, option (A)). Every export keeps
  the name it had when the composition was written here.
*/

const resendApiKey = serverEnv.RESEND_API_KEY;
const resendFromEmail = serverEnv.RESEND_FROM_EMAIL;
/*
  The parsed configuration does not carry VERCEL_ENV, and the local
  credential's rule needs it: wherever it is set the credential is off. Both
  the sign-in methods and the composition read it from this one object.
*/
const authEnv = {
  ...serverEnv,
  VERCEL_ENV: process.env.VERCEL_ENV,
};
const sendMagicLink =
  resendApiKey && resendFromEmail
    ? selectServerMagicLinkSender({
        env: process.env,
        createE2ESender: () => createE2EMagicLinkSender(process.env),
        createResendSender: () => {
          const resend = createSafeResendClient(resendApiKey);
          return createMagicLinkSender({
            sendEmail: (payload) => resend.emails.send(payload),
            fingerprintKey: serverEnv.BETTER_AUTH_SECRET,
            fromEmail: resendFromEmail,
            logger: {
              info(fields) {
                console.info("Magic link email delivered.", fields);
              },
              error(fields) {
                console.error("Magic link email delivery failed.", fields);
              },
            },
          });
        },
      })
    : undefined;

/*
  The database is the web process's one application storage, which the web
  root shares (`applicationStorageFromEnv`, `@requestport/db/wiring`, which
  builds it on the first ask and keeps it for the process). It is asked for
  when Better Auth builds its instance, after the entry point has declared
  the application surface, and never as this module is imported.

  While the host's handoff is set (Plan 13, H.5; manifest-h.md §2.7.1;
  rulings 141, 145 and 160), this module installs the Better Auth it
  carries, which is the whole object `createAuth` returns (H.0b), and calls
  no factory; a handoff that carries none is refused here, as the module is
  imported, with one console line (`handedAuth`, below). Where nothing sets
  it, as on Vercel, it composes as above.
*/
const handed = handedAuth();
const installed =
  handed ??
  createAuth({
    database: () => applicationStorageFromEnv().db,
    env: authEnv,
    sendMagicLink,
  });

export const {
  auth,
  signInMethods,
  requireHumanSession,
  authenticateAgentBearer,
  operatorCredentialsSwitch,
  operatorCredentialAvailability,
  authenticateApiBearer,
  operatorCredentialService,
  agentApiKeyService,
  createAgentApiKey,
  agentGrantService,
  oauthAuthorizationServerMetadata,
  oauthOpenIdConfiguration,
  assertSignupAllowed,
} = installed;

/*
  The host's handoff, `globalThis[Symbol.for("requestport.host")]`, read
  here with the rule `hostHandoffMember` applies in `@requestport/db/wiring`,
  rather than through that reader: H.1's route goldens
  (`packages/server/test/route-goldens/`) replace `@requestport/db/wiring`
  with a stand-in that carries `applicationStorageFromEnv` alone, and import
  this module as it is, so a reader imported from there fails them as they
  load.
*/
function handedAuth(): ReturnType<typeof createAuth> | undefined {
  const handoff: unknown = (globalThis as Record<symbol, unknown>)[
    Symbol.for("requestport.host")
  ];

  if (handoff === undefined) return undefined;
  const handedMember =
    typeof handoff === "object" && handoff !== null
      ? (handoff as { auth?: unknown }).auth
      : undefined;

  if (handedMember !== undefined && handedMember !== null) {
    return handedMember as ReturnType<typeof createAuth>;
  }
  const refusal = new Error(
    "RequestPort's Better Auth installer (@requestport/auth/server) refused: " +
      "the host's handoff is present, and it carries no auth. While it is " +
      "present, the web answers the storage, Better Auth and RequestPort it " +
      "carries and builds none of its own (manifest-h.md §2.7.1).",
  );

  refusal.name = "HostHandoffRefusalError";
  console.error(`${refusal.name}: ${refusal.message}`);
  throw refusal;
}
