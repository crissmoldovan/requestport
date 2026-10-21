/**
 * Actions with no machine surface, by design. Each reason names who decided
 * it: F.0's inventory (`capability-inventory.md`), or a driver ruling in
 * `docs/implementation/plans/2026-09-27-13/r9-rulings.md`.
 */
export const rows = [
  {
    module: "app/(app)/settings/appearance/actions.ts",
    action: "updatePersonalAppearanceAction",
    status: "human-only",
    reason:
      "F.0: a person's own appearance preferences, on the authenticated-user bus.",
  },
  {
    module: "app/oauth/agent-consent/actions.ts",
    action: "approveAgentConsentAction",
    status: "human-only",
    reason: "F.0: OAuth consent is a person's decision.",
  },
  {
    module: "app/oauth/agent-consent/actions.ts",
    action: "denyAgentConsentAction",
    status: "human-only",
    reason: "F.0: OAuth consent is a person's decision.",
  },
  {
    module: "app/(app)/agents/actions.ts",
    action: "createAgentAction",
    status: "human-only",
    reason:
      "Ruling 3: it mints authority; a machine credential that can mint credentials is an escalation path.",
  },
  {
    module: "app/(app)/agents/actions.ts",
    action: "issueAgentKeyAction",
    status: "human-only",
    reason: "Ruling 3: it mints a credential.",
  },
  {
    module: "app/(app)/agents/actions.ts",
    action: "rotateAgentKeyAction",
    status: "human-only",
    reason: "Ruling 3: it mints a credential.",
  },
  {
    module: "app/(app)/agents/actions.ts",
    action: "revealWorkspaceTelemetryAction",
    status: "human-only",
    reason:
      "Ruling 3: it decrypts private telemetry for a person who states a reason.",
  },
  {
    module: "app/(app)/imports/actions.ts",
    action: "freezeImportAction",
    status: "human-only",
    reason: "Ruling 3: freezing is the human approval of an import.",
  },
  {
    module: "app/(app)/requests/actions.ts",
    action: "markRequestReadAction",
    status: "human-only",
    reason:
      "Ruling 29: the marker records a person's attention, keyed by their user id.",
  },
  {
    module: "app/(app)/settings/operators/actions.ts",
    action: "issueOperatorCredentialAction",
    status: "human-only",
    reason: "Ruling 3: it mints a credential.",
  },
  {
    module: "app/(app)/settings/operators/actions.ts",
    action: "rotateOperatorCredentialAction",
    status: "human-only",
    reason: "Ruling 3: it mints a credential.",
  },
];
