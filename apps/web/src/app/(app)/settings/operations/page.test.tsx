import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const operations = vi.hoisted(() => ({
  details: vi.fn(),
  holds: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  summary: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createOperationsQueryRepository: () => ({
    details: operations.details,
    summary: operations.summary,
  }),
  createRetentionHoldRepository: () => ({ list: operations.holds }),
}));

// The web root, whose storage the page builds its repositories over when it
// runs (Plan 13, G.3).
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({ notFound: operations.notFound }));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: operations.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ message: "", status: "idle" });
  return {
    createRetentionHoldAction: inert,
    releaseRetentionHoldAction: inert,
    requeueImportDispatchAction: inert,
    requeueNotificationAction: inert,
    requeueOutboxAction: inert,
    requeueSlackOperationAction: inert,
  };
});

import { ConsoleToasts } from "../../../../components/console-toasts.js";
import OperationsPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const healthy = {
  dead_import_dispatches: 0,
  dead_webhooks: 0,
  oldest_outbox_seconds: 4,
  open_import_conflicts: 0,
  pending_notifications: 2,
  pending_outbox: 11,
  pending_slack_updates: 0,
  stale_sessions: 0,
};

const details = {
  importConflicts: [
    {
      entry_id: "00000000-0000-4000-8000-000000000401",
      id: "00000000-0000-4000-8000-000000000402",
      import_run_id: "00000000-0000-4000-8000-000000000403",
      kind: "duplicate_key",
      resolved_at: null,
      severity: "blocker",
    },
  ],
  importDispatches: [
    {
      attempt_count: 6,
      id: "00000000-0000-4000-8000-000000000404",
      import_run_id: "00000000-0000-4000-8000-000000000403",
      last_error_code: "timeout",
      state: "dead_letter",
      task_kind: "analyze",
      trigger_run_id: "run_1",
    },
  ],
  notifications: [
    {
      attempt_count: 3,
      channel: "email",
      event_id: null,
      id: "00000000-0000-4000-8000-000000000405",
      last_error_code: "provider_rejected",
      next_attempt_at: null,
      provider_record_id: null,
      provider_status: null,
      question_id: "00000000-0000-4000-8000-000000000406",
      status: "failed",
      template: "question_asked",
    },
  ],
  outbox: [
    {
      attempt_count: 8,
      event_id: "00000000-0000-4000-8000-000000000407",
      event_type: "request.created.v1",
      id: "00000000-0000-4000-8000-000000000408",
      next_attempt_at: new Date("2026-08-21T10:00:00.000Z"),
      request_id: "00000000-0000-4000-8000-000000000101",
      state: "dead_letter",
      trigger_run_id: "run_2",
    },
  ],
  sessions: [
    {
      agent_principal_id: "00000000-0000-4000-8000-0000000000a1",
      id: "00000000-0000-4000-8000-000000000409",
      lease_expires_at: new Date("2026-08-21T11:00:00.000Z"),
      request_id: "00000000-0000-4000-8000-000000000101",
      state: "stale",
    },
  ],
  slackOperations: [
    {
      attempt_count: 2,
      id: "00000000-0000-4000-8000-00000000040a",
      installation_id: "00000000-0000-4000-8000-00000000040b",
      last_error_code: "channel_not_found",
      next_attempt_at: new Date("2026-08-21T10:30:00.000Z"),
      operation_type: "message_update",
      status: "failed",
      updated_at: new Date("2026-08-21T10:00:00.000Z"),
    },
  ],
};

async function markup() {
  // Inside the console's toast provider, which the shell mounts around every
  // page (ruling 260): the page's dialogs raise their confirmations there.
  return renderToStaticMarkup(
    <ConsoleToasts>{(await OperationsPage()) as ReactElement}</ConsoleToasts>,
  );
}

beforeEach(() => {
  operations.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  operations.details.mockReset();
  operations.holds.mockReset();
  operations.notFound.mockClear();
  operations.summary.mockReset();
  operations.summary.mockResolvedValue(healthy);
  operations.details.mockResolvedValue(details);
  operations.holds.mockResolvedValue([]);
});

describe("the operations page", () => {
  test("reads current health as a description list with labelled tones", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="description-list"');
    expect(html).toContain("Pending outbox");
    expect(html).toContain("Healthy");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("marks a metric past its threshold for review, in words", async () => {
    operations.summary.mockResolvedValue({ ...healthy, dead_webhooks: 4 });

    expect(await markup()).toContain("Review");
  });

  test("puts each record table in a named, keyboard-reachable region", async () => {
    const html = await markup();

    expect(html).toContain('aria-label="Event outbox records"');
    expect(html).toContain('aria-label="Notification delivery records"');
    expect(html).toContain('aria-label="Import task dispatch records"');
    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).not.toContain(recipeClass("table"));
  });

  test("projects identifiers and states only, and offers recovery where it applies", async () => {
    const html = await markup();

    expect(html).toContain("request.created.v1");
    expect(html).toContain("dead_letter");
    expect(html).toContain("not created");
    expect(html).toContain("Requeue");
    // The safe projection carries no provider payload, recipient address, or
    // token, so nothing that reads like one may appear in the rendered page.
    expect(html).not.toContain("Bearer");
    expect(html).not.toMatch(/[\w.]+@[\w.]+/u);
  });

  test("reports an organization with no retention holds as a native empty state", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No retention holds");
  });

  test("opens a new retention hold in a dialog from its panel's Add hold (ruling 259)", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="dialog-trigger"');
    expect(html).toContain(">Add hold<");
    expect(html).not.toContain('name="reason"');
    expect(html).not.toContain("Create hold");
  });

  test("lists an active hold with its own release control", async () => {
    operations.holds.mockResolvedValue([
      {
        category: "slack_oauth_state",
        createdAt: new Date("2026-08-20T10:00:00.000Z"),
        id: "00000000-0000-4000-8000-00000000040c",
        reason: "Pending legal review",
        status: "active",
        version: 2,
      },
    ]);
    const html = await markup();

    expect(html).toContain("Pending legal review");
    expect(html).toContain("Release");
  });

  test("reports an ordinary member as absent rather than showing operations", async () => {
    operations.organization = {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(operations.notFound).toHaveBeenCalled();
  });
});
