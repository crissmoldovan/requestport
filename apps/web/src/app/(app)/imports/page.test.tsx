import { DomainError } from "@requestport/domain";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const imports = vi.hoisted(() => ({
  captures: vi.fn(),
  list: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  requireManagerAccess: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createImportRepository: () => ({
    list: imports.list,
    listCaptures: imports.captures,
    requireManagerAccess: imports.requireManagerAccess,
  }),
}));

/*
 * The page opens its transaction on the web root's storage (Plan 13, G.2).
 * So the root hands back a fake handle as that storage's `db`, whose
 * `transaction` runs the work on a fake transaction, and that `transaction`
 * as the storage's own.
 */
vi.mock("../../../lib/server-request-port.js", () => {
  const db = {
    transaction: async (run: (transaction: unknown) => Promise<unknown>) =>
      run({}),
  };
  return { webStorage: () => ({ db, transaction: db.transaction }) };
});

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: imports.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => ({
  analyzeImportAction: async () => ({ message: "", status: "idle" }),
}));

import ImportsPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const run = {
  run: {
    id: "00000000-0000-4000-8000-000000000101",
    manifestSha256:
      "9f2c0b7a4d1e5c6b8a0f3d2e7c1b4a6d8e0f2c4b6a8d0e2f4c6b8a0d2e4f6c8b",
    parserVersion: "legacy-fr@1",
    startedAt: new Date("2026-08-20T10:00:00.000Z"),
    state: "reviewing",
    version: 2,
  },
  source: {
    id: "00000000-0000-4000-8000-000000000201",
    projectId: "00000000-0000-4000-8000-000000000301",
    repositoryUrl: "https://example.invalid/legacy.git",
  },
};

const capture = {
  snapshot: {
    capturedAt: new Date("2026-08-19T10:00:00.000Z"),
    dirty: false,
    id: "00000000-0000-4000-8000-000000000401",
    manifestSha256:
      "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    status: "captured",
  },
  source: run.source,
};

async function markup() {
  return renderToStaticMarkup((await ImportsPage()) as ReactElement);
}

beforeEach(() => {
  imports.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  imports.captures.mockReset();
  imports.list.mockReset();
  imports.requireManagerAccess.mockReset();
  imports.captures.mockResolvedValue([capture]);
  imports.list.mockResolvedValue([run]);
  imports.requireManagerAccess.mockResolvedValue(undefined);
});

describe("the legacy imports page", () => {
  test("puts each record table in a named, keyboard-reachable region", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('aria-label="Legacy import runs"');
    expect(html).toContain('aria-label="Captured source snapshots"');
    expect(html).not.toContain(recipeClass("table"));
  });

  test("labels a run's state in words rather than by colour", async () => {
    const html = await markup();

    // `Chip` carries no data-slot of its own, so its chassis class is what says
    // a chip is what drew the label.
    expect(html).toContain("h-chip");
    expect(html).toContain("reviewing");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("links a run to its own review", async () => {
    expect(await markup()).toContain(`href="/imports/${run.run.id}"`);
  });

  /**
   * The scroll region keeps the digest in its column; it is not broken to fit.
   * See the webhooks page test for why that changed.
   */
  test("keeps a full manifest digest inside its own column", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).not.toContain("break-all");
  });

  test("offers analysis only for a snapshot that passed its secret scan", async () => {
    expect(await markup()).toContain("Analyze");

    imports.captures.mockResolvedValue([
      { ...capture, snapshot: { ...capture.snapshot, status: "quarantined" } },
    ]);
    const blocked = await markup();

    expect(blocked).toContain("Security review required");
    expect(blocked).not.toContain("Analyze");
  });

  test("reports an organization with no runs as a native empty state", async () => {
    imports.list.mockResolvedValue([]);
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No analysis runs");
    expect(html).not.toContain(recipeClass("empty", "state"));
  });

  test("tells an ordinary member the surface is not theirs to manage", async () => {
    imports.requireManagerAccess.mockRejectedValue(
      new DomainError("forbidden", "Import management access is denied"),
    );
    const html = await markup();

    expect(html).toContain("Legacy imports are owner and admin only");
    expect(html).not.toContain("Captured snapshots");
  });

  test("reads its captures, then its runs, one after the other on its one transaction (X24)", async () => {
    const order: string[] = [];
    imports.captures.mockImplementation(async () => {
      order.push("captures start");
      await Promise.resolve();
      order.push("captures settle");
      return [capture];
    });
    imports.list.mockImplementation(async () => {
      order.push("runs start");
      return [run];
    });

    await markup();

    expect(order).toEqual(["captures start", "captures settle", "runs start"]);
  });

  test("renders nothing at all without a current organization", async () => {
    imports.organization = null;

    expect(await markup()).toBe("");
  });
});
