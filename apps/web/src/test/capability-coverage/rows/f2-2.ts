/**
 * F.2.2 — agent administration, reduced to its three reduce-only capabilities
 * (ruling 3). The status form runs `set_agent_principal_status` on the bus;
 * the two revocation forms run their handlers, core's, through
 * `lib/server-agent-actions.ts`. `/api/v1` reaches the same command and the
 * same two handlers for an operator credential holding `agent:revoke`,
 * through their registry entries (`credentialKinds: ["operator"]`, ruling 25).
 */
const module = "app/(app)/agents/actions.ts";

export const rows = [
  {
    module,
    action: "setAgentStatusAction",
    status: "ported",
    surfaces: [{ registry: "set_agent_principal_status" }],
  },
  {
    module,
    action: "revokeAgentKeyAction",
    status: "ported",
    surfaces: [{ registry: "revoke_agent_credential" }],
  },
  {
    module,
    action: "revokeAgentOauthGrantAction",
    status: "ported",
    surfaces: [{ registry: "revoke_agent_oauth_grant" }],
  },
];
