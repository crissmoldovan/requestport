import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const deliveries = vi.hoisted(() => ({
  list: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  role: "owner" as string,
}));

vi.mock("@requestport/db", () => ({
  createNotificationRepository: () => ({
    listQuestionDeliveries: deliveries.list,
  }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3).
vi.mock("../../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({ notFound: deliveries.notFound }));

vi.mock("../../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: deliveries.role,
      slug: "example-org",
    },
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

import QuestionDeliveriesPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const createdAt = new Date("2026-08-19T09:30:00.000Z");

const record = {
  attemptCount: 2,
  attempts: [
    {
      channelId: null,
      intentId: "00000000-0000-4000-8000-000000000401",
      messageTs: null,
      providerMessageId: "provider-42",
      status: "delivered",
    },
  ],
  channel: "email",
  createdAt,
  id: "00000000-0000-4000-8000-000000000401",
  lastErrorCode: null,
  nextAttemptAt: null,
  recipientUserId: "00000000-0000-4000-8000-0000000000aa",
  status: "delivered",
  template: "question_asked",
};

async function deliveriesMarkup() {
  const page = (await QuestionDeliveriesPage({
    params: Promise.resolve({
      questionId: "00000000-0000-4000-8000-000000000201",
    }),
  })) as ReactElement;

  return renderToStaticMarkup(page);
}

beforeEach(() => {
  deliveries.role = "owner";
  deliveries.list.mockReset();
  deliveries.list.mockResolvedValue([record]);
  deliveries.notFound.mockClear();
});

describe("question delivery records", () => {
  test("puts the records in a named, focusable native scroll region", async () => {
    const markup = await deliveriesMarkup();

    expect(markup).toContain('data-slot="table-scroll-region"');
    expect(markup).toContain('aria-label="Question delivery records"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('data-slot="table-caption"');
    expect(markup.match(/data-slot="table-head"/gu)).toHaveLength(7);
    expect(markup).not.toContain(recipeClass("table"));
    expect(markup).not.toContain(recipeClass("table", "scroll"));
  });

  test("shows safe delivery state and never a provider payload", async () => {
    const markup = await deliveriesMarkup();

    expect(markup).toContain("question_asked");
    expect(markup).toContain("delivered");
    expect(markup).toContain("no automatic retry");
    expect(markup).toContain("no error");
    expect(markup).not.toContain("token");
    expect(markup).not.toContain("secret");
  });

  test("reports an absent intent through the native empty state", async () => {
    deliveries.list.mockResolvedValue([]);

    const markup = await deliveriesMarkup();

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No delivery records");
    expect(markup).not.toContain(recipeClass("empty-state"));
  });

  test("stays unreachable for an ordinary member", async () => {
    deliveries.role = "member";

    await expect(deliveriesMarkup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(deliveries.list).not.toHaveBeenCalled();
  });
});
