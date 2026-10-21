import { createCoreEventSchemaRegistry } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import * as tasks from "./index.js";

describe("Trigger task discovery", () => {
  test("exports every durable delivery, repair, retention, and telemetry task", () => {
    expect(Object.keys(tasks)).toEqual(
      expect.arrayContaining([
        "deploymentPreflight",
        "emailDelivery",
        "importAnalyze",
        "importApply",
        "importDispatchRepair",
        "notificationDeliveryRepair",
        "operationalMetrics",
        "outboxDelivery",
        "outboxRepair",
        "questionReminders",
        "retentionCleanup",
        "slackConnectionTest",
        "slackConnectionTestRepair",
        "slackMessageUpdate",
        "slackMessageUpdateRepair",
        "slackQuestionDelivery",
        "staleSessions",
        "webhookDelivery",
        "webhookDeliveryRepair",
        "webhookSecretRotation",
      ]),
    );
  });

  test.each([
    ["deploymentPreflight", tasks.deploymentPreflight, "deployment-preflight"],
    ["emailDelivery", tasks.emailDelivery, "email-delivery"],
    ["outboxDelivery", tasks.outboxDelivery, "outbox-delivery"],
    ["outboxRepair", tasks.outboxRepair, "outbox-repair"],
    ["questionReminders", tasks.questionReminders, "question-reminders"],
    ["retentionCleanup", tasks.retentionCleanup, "retention-cleanup"],
    ["staleSessions", tasks.staleSessions, "stale-work-sessions"],
    ["webhookDelivery", tasks.webhookDelivery, "webhook-delivery"],
  ])("binds %s to the stable Trigger task id", (_exportName, task, taskId) => {
    expect(task).toMatchObject({ id: taskId });
  });

  test("exposes the routing body the outbox worker runs", () => {
    expect(typeof tasks.deliverOutboxEvent).toBe("function");
  });
});

describe("worker event registry", () => {
  const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
  const triple = { theme: "cue", density: "normal", mode: "dark" };

  // `outbox-delivery` dead-letters terminally on an unregistered type, and
  // migration 0014 is immutable. The registry the deployed worker builds has to
  // accept both appearance envelopes and every previously registered one.
  test.each([
    [
      "appearance.organization_defaults_initialized.v1",
      { organizationId, ...triple },
    ],
    [
      "appearance.organization_defaults_updated.v1",
      {
        organizationId,
        changedFields: ["theme"],
        before: { ...triple, theme: "requestport" },
        after: triple,
      },
    ],
    [
      "organization.created.v1",
      {
        organizationId,
        name: "RequestPort",
        slug: "requestport",
        status: "active",
      },
    ],
    [
      "organization.member_changed.v1",
      {
        membershipId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a2",
        role: "owner",
        status: "active",
      },
    ],
    [
      "project.registered.v1",
      {
        projectId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a3",
        name: "Core",
        slug: "core",
        keyPrefix: "COR",
        status: "active",
      },
    ],
    ["retention.hold_changed.v1", { category: "all", status: "active" }],
  ])("accepts %s", (type, data) => {
    expect(() =>
      createCoreEventSchemaRegistry().parse(type, data),
    ).not.toThrow();
  });
});
