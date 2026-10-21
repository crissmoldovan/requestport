/**
 * The Slack settings the guarded acceptance server is started with.
 *
 * Read these as placeholders, because that is all they are: a fixed
 * identifier, three fixed strings long enough for the server schema, and an
 * encryption key of thirty-two zero bytes. None of them authenticates
 * anything, none came from Slack, and none is a credential to rotate. The
 * loopback server never reaches Slack — the run refuses every request to any
 * other origin before it is made, and no case follows an install link.
 *
 * They exist because of what `/slack` prints without them. The surface draws
 * "Slack configuration required" for two different reasons — a provider the
 * run made unreachable, and a provider nobody configured — and the five
 * settings are optional, so every local and CI run had the second reason. The
 * provider-unavailable case's assertion was therefore satisfied whether the
 * injected fault reached the page or not, which is not a case at all. With the
 * settings present the sentence has exactly one cause left, and the case is
 * the difference between the surface inside the run and outside it.
 *
 * The server schema treats the four Slack fields as one all-or-nothing group,
 * so a partial group refuses to start rather than quietly restoring the
 * tautology.
 */
export const acceptanceProviderSettings = {
  REQUESTPORT_SLACK_CLIENT_ID: "e2e-acceptance-not-a-real-slack-client",
  REQUESTPORT_SLACK_CLIENT_SECRET: "e2e-acceptance-not-a-secret-client",
  REQUESTPORT_SLACK_SIGNING_SECRET: "e2e-acceptance-not-a-secret-signing",
  REQUESTPORT_SLACK_STATE_SECRET: "e2e-acceptance-not-a-secret-state-value",
  /**
   * Thirty-two zero bytes, base64url. `decodeBase64Key` accepts nothing but a
   * base64url-encoded thirty-two-byte key and the application builds its
   * envelope encryption from this at import, so the placeholder has to be a
   * real key shape. A key of zeroes protects nothing and hides nothing.
   */
  REQUESTPORT_WORKSPACE_KEK: "A".repeat(43),
} as const;

export type AcceptanceProviderSetting = keyof typeof acceptanceProviderSettings;
