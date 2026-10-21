import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const detail = vi.hoisted(() => ({
  list: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  operations: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
}));

vi.mock("@requestport/db", () => ({
  createOutboxRepository: () => ({ listWebhookOperations: detail.operations }),
  createWebhookRepository: () => ({ list: detail.list }),
}));

// The web root, whose storage the page builds its repositories over when it
// runs (Plan 13, G.3).
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({ notFound: detail.notFound }));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: detail.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("../actions.js", () => ({
  replayWebhookAction: async () => ({ message: "", status: "idle" }),
}));

import WebhookDetailPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const subscriptionId = "00000000-0000-4000-8000-000000000101";

const subscription = {
  currentSecretKeyId: "key_1",
  endpointUrl: "https://hooks.example.invalid/requestport",
  eventTypes: [],
  id: subscriptionId,
  laneIds: [],
  name: "Release feed",
  nextSecretKeyId: "key_2",
  overlapEndsAt: new Date("2026-08-20T10:00:00.000Z"),
  projectIds: [],
  requestTypes: [],
  status: "active",
  verifiedAt: new Date("2026-08-02T00:00:00.000Z"),
  version: 3,
};

const delivery = {
  createdAt: new Date("2026-08-19T10:00:00.000Z"),
  eventId: "00000000-0000-4000-8000-000000000301",
  id: "00000000-0000-4000-8000-000000000201",
  replayNumber: 0,
  status: "dead_letter",
};

const attempt = {
  deliveryId: delivery.id,
  errorCode: null as string | null,
  nextAttemptAt: null,
  responseExcerpt: "gateway timed out",
  responseStatus: 504,
};

async function markup() {
  return renderToStaticMarkup(
    (await WebhookDetailPage({
      params: Promise.resolve({ subscriptionId }),
    })) as ReactElement,
  );
}

beforeEach(() => {
  detail.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  detail.list.mockReset();
  detail.notFound.mockClear();
  detail.operations.mockReset();
  detail.list.mockResolvedValue([subscription]);
  detail.operations.mockResolvedValue({
    attempts: [attempt],
    deliveries: [delivery],
  });
});

describe("one webhook subscription", () => {
  test("reads the subscription policy as a description list", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="description-list"');
    expect(html).toContain("All projects");
    expect(html).toContain("All event types");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("names the signing key in progress without printing a secret", async () => {
    const html = await markup();

    expect(html).toContain("key_2");
    expect(html).not.toContain("whsec_");
    expect(html).not.toContain("Bearer");
  });

  test("puts the delivery table in a named, keyboard-reachable region", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('aria-label="Webhook delivery attempts"');
    expect(html).not.toContain(recipeClass("table"));
  });

  test("reports an exhausted delivery and offers its replay", async () => {
    const html = await markup();

    expect(html).toContain("Attempts exhausted");
    expect(html).toContain("gateway timed out");
    expect(html).toContain("Replay");
  });

  test("reports a subscription with no deliveries as a native empty state", async () => {
    detail.operations.mockResolvedValue({ attempts: [], deliveries: [] });
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No deliveries yet");
    expect(html).not.toContain(recipeClass("empty", "state"));
  });

  test("reports an unknown subscription as absent", async () => {
    detail.list.mockResolvedValue([]);

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(detail.notFound).toHaveBeenCalled();
  });
});
