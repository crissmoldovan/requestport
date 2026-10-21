import type { RequestPort } from "@requestport/core";
import { webRequestPort } from "./server-web-request-port.js";

/*
  The web's Slack connection test, the one Slack administration capability
  that stays off the command bus (Plan 13, F.2.5; `manifest-f2.md` §4,
  Scope 1). Its form calls this handler as the signed-in person, and
  `/api/v1` reaches it for an operator credential: the registry entry
  `send_slack_connection_test` is dispatched to `slack-connection-test` and
  admits operators only (F.2.5's connection test follow-up; ruling 25).

  It is core's, as the web's RequestPort composes it
  (`webRequestPort().handlers`; Plan 13, G.6, ruling 137):
  `packages/core/src/slack-connection-test.ts` writes down what it checks
  before any transaction, what it re-checks inside it, its operation key and
  its start after the commit. The RequestPort opens its one transaction on
  the web root's storage, with every repository it asks for opened on it —
  the re-check's under the deployment's REQUESTPORT_OPERATOR_CREDENTIALS,
  read from `serverEnv` as that repository opens, so it refuses every
  operator unless that is `enabled`. The operation key is keyed with
  `BETTER_AUTH_SECRET`, read from `serverEnv` when each call runs. The task
  is started, once the transaction has committed, through the RequestPort's
  background port, which is the web's (`triggerSlackConnectionTest`,
  `trigger-client.ts`); a failed or deferred start leaves the operation
  pending for the scheduled `slack-connection-test-repair` run.
*/

/**
 * Queue a Slack connection test, then start it (core's
 * `queueSlackConnectionTest`). It answers the operation's id, and whether the
 * task was started.
 */
export const queueSlackConnectionTest: RequestPort["handlers"]["queueSlackConnectionTest"] =
  (context, input, meta) =>
    webRequestPort().handlers.queueSlackConnectionTest(context, input, meta);
