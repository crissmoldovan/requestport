/**
 * F.2.5 — Slack administration. Three actions dispatch their commands on the
 * tenant bus, and `/api/v1` reaches the same command for an operator
 * credential through its registry entry (`credentialKinds: ["operator"]`,
 * ruling 25). The connection test calls its one off-bus handler, core's,
 * through `lib/server-slack-actions.ts`, and `/api/v1` reaches the same
 * handler for an operator credential through its registry entry
 * `send_slack_connection_test`, dispatched to `slack-connection-test` (F.2.5's
 * connection test follow-up, once F.2.2's off-bus form was on `main`). Off
 * the bus, REST dispatches to project registration, to F.2.2's
 * `agent-administration`, which names the two agent revocations alone, to
 * F.2.6's `import-split`, the import split, and to this group's
 * `slack-connection-test`.
 */
const module = "app/(app)/slack/actions.ts";

export const rows = [
  {
    module,
    action: "mapSlackUserAction",
    status: "ported",
    surfaces: [{ registry: "set_slack_user_mapping" }],
  },
  {
    module,
    action: "setSlackRouteAction",
    status: "ported",
    surfaces: [{ registry: "set_slack_route" }],
  },
  {
    module,
    action: "setSlackInstallationStatusAction",
    status: "ported",
    surfaces: [{ registry: "set_slack_installation_status" }],
  },
  {
    module,
    action: "sendSlackConnectionTestAction",
    status: "ported",
    surfaces: [{ registry: "send_slack_connection_test" }],
  },
];
