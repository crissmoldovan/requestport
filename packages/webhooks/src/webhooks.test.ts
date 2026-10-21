import { describe, expect, test, vi } from "vitest";

import {
  createWebhookHeaders,
  deliverWebhook,
  isForbiddenAddress,
  matchesWebhookFilter,
  resolveWebhookEndpoint,
  verifyWebhookSignature,
} from "./index.js";

describe("webhook endpoint policy", () => {
  test("accepts a credential-free HTTPS endpoint only when every answer is public", async () => {
    const endpoint = await resolveWebhookEndpoint(
      "https://hooks.example.com/events",
      {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        ],
      },
    );
    expect(endpoint.url.toString()).toBe("https://hooks.example.com/events");
    expect(endpoint.addresses).toHaveLength(2);

    for (const value of [
      "https://hooks.example.com/events?",
      "https://hooks.example.com/events#",
      "https://user:pass@hooks.example.com/events",
      "https://@hooks.example.com/events",
      "https://hooks.example.com:8443/events",
    ]) {
      await expect(
        resolveWebhookEndpoint(value, {
          resolver: async () => [{ address: "93.184.216.34", family: 4 }],
        }),
      ).rejects.toThrow();
    }
    await expect(
      resolveWebhookEndpoint("https://hooks.example.com/events", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow("unsafe_endpoint_address");
  });

  test("covers private, loopback, mapped, documentation, and multicast addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "192.0.2.1",
      "224.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    expect(isForbiddenAddress("93.184.216.34")).toBe(false);
    expect(isForbiddenAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(
      false,
    );
  });

  test("enforces one total redirect delivery deadline before opening a socket", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(
        deliverWebhook({
          endpointUrl: "https://hooks.example.com/events",
          eventId: "018f0000-0000-7000-8000-000000000001",
          deliveryId: "018f0000-0000-7000-8000-000000000002",
          attempt: 1,
          schemaVersion: 1,
          keyId: "key-v1",
          secret: "secret-value",
          payload: { type: "request.submitted.v1" },
          resolver: async () => [{ address: "93.184.216.34", family: 4 }],
          now: () => 1_800_000_000,
          onResolved: async () => {
            now += 10_001;
          },
        }),
      ).rejects.toThrow("delivery_timeout");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("webhook signatures and filters", () => {
  test("binds the key id and timestamp to exact raw body bytes", () => {
    const rawBody = new TextEncoder().encode('{"ok":true}');
    const headers = createWebhookHeaders({
      eventId: "event-1",
      deliveryId: "delivery-1",
      timestamp: 1_800_000_000,
      attempt: 2,
      schemaVersion: 1,
      keyId: "rotation.2026-08",
      secret: "webhook-secret",
      rawBody,
    });
    expect(headers["requestport-signature"]).toMatch(
      /^v1=rotation\.2026-08:[0-9a-f]{64}$/u,
    );
    expect(
      verifyWebhookSignature({
        timestamp: 1_800_000_000,
        rawBody,
        signature: headers["requestport-signature"],
        secrets: new Map([["rotation.2026-08", "webhook-secret"]]),
        now: 1_800_000_100,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        timestamp: 1_800_000_000,
        rawBody: new TextEncoder().encode('{"ok":false}'),
        signature: headers["requestport-signature"],
        secrets: new Map([["rotation.2026-08", "webhook-secret"]]),
        now: 1_800_000_100,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        timestamp: 1_800_000_000,
        rawBody,
        signature: headers["requestport-signature"],
        secrets: new Map([["other-key", "webhook-secret"]]),
        now: 1_800_000_100,
      }),
    ).toBe(false);
  });

  test("requires every configured event dimension to match", () => {
    const filter = {
      eventTypes: ["request.submitted.v1"],
      projectIds: ["project-1"],
      laneIds: ["lane-1"],
      requestTypes: ["feature"],
    };
    expect(
      matchesWebhookFilter(filter, {
        type: "request.submitted.v1",
        projectId: "project-1",
        data: { laneId: "lane-1", requestType: "feature" },
      }),
    ).toBe(true);
    for (const event of [
      {
        type: "request.updated.v1",
        projectId: "project-1",
        data: { laneId: "lane-1", requestType: "feature" },
      },
      {
        type: "request.submitted.v1",
        projectId: "project-2",
        data: { laneId: "lane-1", requestType: "feature" },
      },
      {
        type: "request.submitted.v1",
        projectId: "project-1",
        data: { laneId: "lane-2", requestType: "feature" },
      },
      {
        type: "request.submitted.v1",
        projectId: "project-1",
        data: { laneId: "lane-1", requestType: "bug" },
      },
    ]) {
      expect(matchesWebhookFilter(filter, event)).toBe(false);
    }
  });
});
