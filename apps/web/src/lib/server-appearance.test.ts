import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  appearanceResolutionFailedEvent,
  appearanceSchemaPendingEvent,
  fallbackAppearanceSnapshot,
} from "./appearance.js";

const actorId = "33333333-3333-4333-8333-333333333333";
const tenantId = "44444444-4444-4444-8444-444444444444";
const sentinel = "appearance-diagnostic-sentinel-must-never-be-logged";

/**
 * The wiring module is a composition root: it reaches for the real database
 * client, the real Better Auth instance, and the Next request store the moment
 * it is imported. Mocking those three boundaries is what lets the wiring — not
 * a copy of it — be exercised.
 */
const boundaries = vi.hoisted(() => ({
  getSession: vi.fn(),
  readAppearanceSnapshot: vi.fn(),
  getCurrentOrganizationForUser: vi.fn(),
  logged: [] as { event: string; fields: Record<string, unknown> }[],
}));

vi.mock("@requestport/auth/server", () => ({
  auth: { api: { getSession: boundaries.getSession } },
}));

vi.mock("@requestport/db", () => ({
  createAppearanceRepository: () => ({
    readAppearanceSnapshot: boundaries.readAppearanceSnapshot,
  }),
}));

// The web root, whose storage the snapshot's repository is built over when it
// is read (Plan 13, G.3).
vi.mock("./server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "requestport_organization=x" }),
}));

vi.mock("./server-application-context.js", () => ({
  getCurrentOrganizationForUser: boundaries.getCurrentOrganizationForUser,
}));

vi.mock("./observability.js", () => ({
  webLogger: {
    warn(event: string, fields: Record<string, unknown>) {
      boundaries.logged.push({ event, fields });
    },
  },
  webMetrics: { count: () => {}, gauge: () => {}, observe: () => {} },
}));

async function loadModule() {
  return import("./server-appearance.js");
}

const storedSnapshot = {
  user: { theme: "dusk", density: null, mode: null, version: 3 },
  organization: {
    theme: "signal",
    density: "normal",
    mode: "light",
    version: 5,
  },
  effective: {
    theme: "requestport",
    density: "ultra-compact",
    mode: "system",
    source: { theme: "fallback", density: "fallback", mode: "fallback" },
  },
};

beforeEach(() => {
  vi.resetModules();
  boundaries.logged.length = 0;
  boundaries.getSession.mockReset();
  boundaries.readAppearanceSnapshot.mockReset();
  boundaries.getCurrentOrganizationForUser.mockReset();
  boundaries.getSession.mockResolvedValue({ user: { id: actorId } });
  boundaries.getCurrentOrganizationForUser.mockResolvedValue({ id: tenantId });
  boundaries.readAppearanceSnapshot.mockResolvedValue(storedSnapshot);
});

describe("server appearance composition root", () => {
  test("resolves the actor's snapshot through the tenant-safe repository", async () => {
    const { getAppearance } = await loadModule();

    const resolution = await getAppearance();

    expect(boundaries.readAppearanceSnapshot).toHaveBeenCalledWith({
      userId: actorId,
      organizationId: tenantId,
    });
    expect(resolution.status).toBe("authenticated");
    expect(resolution.snapshot.effective).toEqual({
      theme: "dusk",
      density: "normal",
      mode: "light",
      font: "match",
      look: "match",
      paint: "match",
      source: {
        theme: "user",
        density: "organization",
        mode: "organization",
        font: "organization",
        look: "organization",
        paint: "organization",
      },
    });
  });

  test("passes the request headers to the optional session read", async () => {
    const { getAppearance } = await loadModule();

    await getAppearance();

    const call = boundaries.getSession.mock.calls[0]?.[0] as {
      headers: Headers;
    };
    expect(call.headers).toBeInstanceOf(Headers);
    expect(call.headers.get("cookie")).toBe("requestport_organization=x");
  });

  test("serves an anonymous document the fixed fallback without any read", async () => {
    boundaries.getSession.mockResolvedValue(null);
    const { getAppearance } = await loadModule();

    const resolution = await getAppearance();

    expect(resolution).toEqual({
      snapshot: fallbackAppearanceSnapshot(),
      status: "anonymous",
    });
    expect(boundaries.readAppearanceSnapshot).not.toHaveBeenCalled();
    expect(boundaries.getCurrentOrganizationForUser).not.toHaveBeenCalled();
    expect(boundaries.logged).toEqual([]);
  });

  test("treats a session without a usable user identity as anonymous", async () => {
    boundaries.getSession.mockResolvedValue({ user: { id: 42 } });
    const { getAppearance } = await loadModule();

    expect((await getAppearance()).status).toBe("anonymous");
    expect(boundaries.readAppearanceSnapshot).not.toHaveBeenCalled();
  });

  test("resolves a user who currently has no organization", async () => {
    boundaries.getCurrentOrganizationForUser.mockResolvedValue(null);
    const { getAppearance } = await loadModule();

    await getAppearance();

    expect(boundaries.readAppearanceSnapshot).toHaveBeenCalledWith({
      userId: actorId,
      organizationId: null,
    });
  });

  test("falls open when the optional session read itself fails", async () => {
    boundaries.getSession.mockRejectedValue(new Error(sentinel));
    const { getAppearance } = await loadModule();

    const resolution = await getAppearance();

    expect(resolution).toEqual({
      snapshot: fallbackAppearanceSnapshot(),
      status: "unavailable",
    });
    expect(boundaries.readAppearanceSnapshot).not.toHaveBeenCalled();
    expect(boundaries.logged.map((record) => record.event)).toEqual([
      appearanceResolutionFailedEvent,
    ]);
    expect(JSON.stringify(boundaries.logged)).not.toContain(sentinel);
  });

  test("reports the pre-migration condition on its own bounded event", async () => {
    boundaries.readAppearanceSnapshot.mockRejectedValue(
      new Error("Failed query: select …", {
        cause: Object.assign(
          new Error('relation "user_appearance_preferences" does not exist'),
          { code: "42P01" },
        ),
      }),
    );
    const { getAppearance } = await loadModule();

    const resolution = await getAppearance();

    expect(resolution).toEqual({
      snapshot: fallbackAppearanceSnapshot(),
      status: "unavailable",
    });
    expect(boundaries.logged).toEqual([
      {
        event: appearanceSchemaPendingEvent,
        fields: { count: 1, errorCode: "42P01" },
      },
    ]);
  });

  test("bounds the pre-migration event across repeated requests", async () => {
    boundaries.readAppearanceSnapshot.mockRejectedValue(
      Object.assign(
        new Error('relation "organization_appearance_defaults" does not exist'),
        { code: "42P01" },
      ),
    );
    const { getAppearance } = await loadModule();

    for (let request = 0; request < 40; request += 1) await getAppearance();

    expect(boundaries.logged.length).toBeGreaterThan(0);
    expect(boundaries.logged.length).toBeLessThan(40);
    for (const record of boundaries.logged) {
      expect(record.event).toBe(appearanceSchemaPendingEvent);
    }
  });

  test("never leaks the actor, the tenant, or a provider detail", async () => {
    const { getAppearance } = await loadModule();

    const serialised = JSON.stringify(await getAppearance());

    expect(serialised).not.toContain(actorId);
    expect(serialised).not.toContain(tenantId);
    expect(serialised).not.toContain("@");
  });
});
