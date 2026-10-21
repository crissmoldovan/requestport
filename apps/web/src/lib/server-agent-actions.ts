import type { RequestPort } from "@requestport/core";
import { webRequestPort } from "./server-web-request-port.js";

/*
  The web's two agent administration handlers (Plan 13, F.2.2): revoking an
  agent's API key and revoking its OAuth grant. They are core's, as the web's
  RequestPort composes them (`webRequestPort().handlers`; Plan 13, G.6,
  ruling 137): `packages/core/src/agent-administration.ts` writes down what
  each checks, in which order, and which receipt it keeps, and the
  RequestPort opens each one's transaction on the web root's storage, with
  its repositories, the re-check's under the deployment's
  REQUESTPORT_OPERATOR_CREDENTIALS, and keys its receipt with
  `BETTER_AUTH_SECRET`, read when each call runs. The revocation forms call
  them as the signed-in person; `/api/v1` reaches the same handlers for an
  operator credential through the RequestPort's `execute`, by the name each
  registry entry dispatches under.
*/

/** Revoke one of an agent principal's API keys (core's handler). */
export const revokeAgentCredential: RequestPort["handlers"]["revokeAgentCredential"] =
  (context, input, meta) =>
    webRequestPort().handlers.revokeAgentCredential(context, input, meta);

/** Revoke one of an agent principal's OAuth grants (core's handler). */
export const revokeAgentOauthGrant: RequestPort["handlers"]["revokeAgentOauthGrant"] =
  (context, input, meta) =>
    webRequestPort().handlers.revokeAgentOauthGrant(context, input, meta);
