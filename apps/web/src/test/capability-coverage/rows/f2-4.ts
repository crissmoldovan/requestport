/**
 * F.2.4 — operations and retention holds. Each action dispatches its command
 * on the tenant bus, and `/api/v1` reaches the same command for an operator
 * credential through its registry entry (`credentialKinds: ["operator"]`,
 * ruling 25).
 */
const module = "app/(app)/settings/operations/actions.ts";

export const rows = [
  {
    module,
    action: "requeueOutboxAction",
    status: "ported",
    surfaces: [{ registry: "requeue_outbox" }],
  },
  {
    module,
    action: "requeueNotificationAction",
    status: "ported",
    surfaces: [{ registry: "requeue_notification" }],
  },
  {
    module,
    action: "requeueSlackOperationAction",
    status: "ported",
    surfaces: [{ registry: "requeue_slack_operation" }],
  },
  {
    module,
    action: "requeueImportDispatchAction",
    status: "ported",
    surfaces: [{ registry: "requeue_import_dispatch" }],
  },
  {
    module,
    action: "createRetentionHoldAction",
    status: "ported",
    surfaces: [{ registry: "create_retention_hold" }],
  },
  {
    module,
    action: "releaseRetentionHoldAction",
    status: "ported",
    surfaces: [{ registry: "release_retention_hold" }],
  },
];
