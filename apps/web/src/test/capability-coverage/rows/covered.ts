/**
 * Actions a machine surface already reaches: the same command or service,
 * through a REST command or MCP tool that existed before F.2 (F.0's
 * `capability-inventory.md`, class `covered`). `registry` names an entry of
 * `capabilityRegistry`; `mcpOnly` names a tool in `mcpOnlyTools`, which no
 * registry entry holds yet.
 */
const requests = "app/(app)/requests/actions.ts";
const imports = "app/(app)/imports/actions.ts";
const webhooks = "app/(app)/webhooks/actions.ts";

export const rows = [
  {
    module: "app/(app)/settings/projects/actions.ts",
    action: "createProjectAction",
    status: "covered",
    surfaces: [{ mcpOnly: "create_project" }],
  },
  {
    module: imports,
    action: "analyzeImportAction",
    status: "covered",
    surfaces: [{ mcpOnly: "analyze_legacy_import" }],
  },
  {
    module: imports,
    action: "applyImportAction",
    status: "covered",
    surfaces: [{ mcpOnly: "apply_legacy_import" }],
  },
  {
    module: imports,
    action: "correctImportAction",
    status: "covered",
    surfaces: [{ mcpOnly: "correct_legacy_import" }],
  },
  {
    module: webhooks,
    action: "createWebhookAction",
    status: "covered",
    surfaces: [{ mcpOnly: "create_event_subscription" }],
  },
  {
    module: webhooks,
    action: "verifyWebhookAction",
    status: "covered",
    surfaces: [{ mcpOnly: "verify_event_subscription" }],
  },
  {
    module: webhooks,
    action: "rotateWebhookSecretAction",
    status: "covered",
    surfaces: [{ mcpOnly: "rotate_event_subscription_secret" }],
  },
  {
    module: webhooks,
    action: "setWebhookStatusAction",
    status: "covered",
    surfaces: [{ mcpOnly: "set_event_subscription_status" }],
  },
  {
    module: webhooks,
    action: "replayWebhookAction",
    status: "covered",
    surfaces: [{ mcpOnly: "replay_event_delivery" }],
  },
  {
    module: requests,
    action: "createRequestAction",
    status: "covered",
    surfaces: [
      { registry: "create_request_draft" },
      { registry: "submit_request" },
    ],
  },
  {
    module: requests,
    action: "transitionRequestAction",
    status: "covered",
    surfaces: [{ registry: "transition_request" }],
  },
  {
    module: requests,
    action: "postMessageAction",
    status: "covered",
    surfaces: [{ registry: "post_message" }],
  },
  {
    module: requests,
    action: "updateRequestAction",
    status: "covered",
    surfaces: [{ registry: "update_request" }],
  },
  {
    module: requests,
    action: "linkRequestsAction",
    status: "covered",
    surfaces: [{ registry: "link_requests" }],
  },
  {
    module: requests,
    action: "unlinkRequestsAction",
    status: "covered",
    surfaces: [{ registry: "unlink_requests" }],
  },
  {
    module: requests,
    action: "closeQuestionAction",
    status: "covered",
    surfaces: [{ registry: "close_question" }],
  },
  {
    module: requests,
    action: "askQuestionAction",
    status: "covered",
    surfaces: [{ registry: "ask_question" }],
  },
  {
    module: requests,
    action: "answerQuestionAction",
    status: "covered",
    surfaces: [{ registry: "answer_question" }],
  },
  {
    module: requests,
    action: "attachArtifactAction",
    status: "covered",
    surfaces: [{ registry: "attach_artifact" }],
  },
  {
    module: "app/(app)/settings/operators/actions.ts",
    action: "revokeOperatorCredentialAction",
    status: "covered",
    surfaces: [{ registry: "revoke_operator_credential" }],
  },
];
