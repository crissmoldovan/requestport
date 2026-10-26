import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const review = vi.hoisted(() => ({
  detail: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  projects: vi.fn(),
  requireManagerAccess: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createImportRepository: () => ({
    detail: review.detail,
    requireManagerAccess: review.requireManagerAccess,
  }),
  createFoundationQueryRepository: () => ({
    listOrganizationProjects: review.projects,
  }),
}));

/*
 * The page opens its transaction on the web root's storage (Plan 13, G.2),
 * and builds its project read's repository over that storage's `db` (G.3).
 * So the root hands back a fake handle as that storage's `db`, whose
 * `transaction` runs the work on a fake transaction, and that `transaction`
 * as the storage's own.
 */
vi.mock("../../../../lib/server-request-port.js", () => {
  const db = {
    transaction: async (run: (transaction: unknown) => Promise<unknown>) =>
      run({}),
  };
  return { webStorage: () => ({ db, transaction: db.transaction }) };
});

vi.mock("next/navigation", () => ({ notFound: review.notFound }));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: review.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("../actions.js", () => {
  const inert = async () => ({ message: "", status: "idle" });
  return {
    applyImportAction: inert,
    correctImportAction: inert,
    freezeImportAction: inert,
    reviewImportEntryAction: inert,
    splitImportEntryAction: inert,
  };
});

import ImportDetailPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const runId = "00000000-0000-4000-8000-000000000101";
const manifestSha256 =
  "9f2c0b7a4d1e5c6b8a0f3d2e7c1b4a6d8e0f2c4b6a8d0e2f4c6b8a0d2e4f6c8b";

/**
 * A preserved record carrying a control character.
 *
 * Written through `fromCodePoint` rather than as itself, because a suite about
 * showing an invisible byte cannot be a file that contains one.
 */
const preservedBytes = new TextEncoder().encode(
  `# Legacy request${String.fromCodePoint(7)}\nSecond line\n`,
);

function entryFixture(overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      byteSize: preservedBytes.byteLength,
      exactBytes: preservedBytes,
      id: "00000000-0000-4000-8000-000000000201",
      relativePath: "legacy/requests/one.md",
      secretScanStatus: "clean",
      sha256: manifestSha256,
    },
    entry: {
      confidenceJson: { kind: 0.9 },
      decision: "pending",
      id: "00000000-0000-4000-8000-000000000301",
      parsedJson: { bodyMarkdown: "# Legacy request" },
      proposedCanonicalId: null,
      proposedKind: "request",
      recordIndex: 0,
      version: 3,
      ...overrides,
    },
  };
}

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    conflicts: [],
    entries: [entryFixture()],
    report: null,
    run: {
      id: runId,
      manifestSha256: null,
      parserVersion: "legacy-fr@1",
      state: "reviewing",
      version: 3,
    },
    snapshot: {
      manifestSha256:
        "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    },
    ...overrides,
  };
}

async function markup() {
  return renderToStaticMarkup(
    (await ImportDetailPage({
      params: Promise.resolve({ runId }),
    })) as ReactElement,
  );
}

beforeEach(() => {
  review.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  review.detail.mockReset();
  review.notFound.mockClear();
  review.projects.mockReset();
  review.requireManagerAccess.mockReset();
  review.detail.mockResolvedValue(detailFixture());
  review.projects.mockResolvedValue([]);
  review.requireManagerAccess.mockResolvedValue(undefined);
});

describe("one legacy import review", () => {
  test("reads the run's identity as a description list", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="description-list"');
    expect(html).toContain("legacy-fr@1");
    expect(html).toContain("Not approved");
  });

  test("shows the preserved bytes without interpreting a control character", async () => {
    const html = await markup();

    expect(html).toContain("\\u{0007}");
    expect(html).toContain('aria-label="Preserved source"');
    expect(html).toContain("font-mono");
  });

  test("labels a blocking finding in words rather than by colour", async () => {
    review.detail.mockResolvedValue(
      detailFixture({
        conflicts: [
          {
            details: { reason: "duplicate legacy key" },
            entryId: "00000000-0000-4000-8000-000000000301",
            id: "00000000-0000-4000-8000-000000000401",
            kind: "duplicate_key",
            resolvedAt: null,
            severity: "blocking",
          },
        ],
      }),
    );
    const html = await markup();

    // `Chip` carries no data-slot of its own, so its chassis class is what says
    // a chip is what drew the label: its height, read through the style set's
    // name since `@cueplusplus/ui` 0.17.0 (`h-chip` before).
    expect(html).toContain(
      "h-[var(--cue-style-chip-height,var(--cue-chip-h))]",
    );
    expect(html).toContain("1 findings");
    expect(html).toContain("Conflict evidence");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("keeps two divergent copies of one filename side by side", async () => {
    const other = entryFixture();
    review.detail.mockResolvedValue(
      detailFixture({
        entries: [
          entryFixture(),
          {
            ...other,
            artifact: {
              ...other.artifact,
              id: "00000000-0000-4000-8000-000000000202",
              relativePath: "legacy/archive/one.md",
              sha256:
                "0000000000000000000000000000000000000000000000000000000000000001",
            },
          },
        ],
      }),
    );
    const html = await markup();

    expect(html).toContain("Divergent copies");
    expect(html).toContain('aria-label="Preserved copy legacy/archive/one.md"');
  });

  test("offers the review controls only while the run is open", async () => {
    expect(await markup()).toContain("Save decision");

    review.detail.mockResolvedValue(
      detailFixture({
        run: {
          id: runId,
          manifestSha256,
          parserVersion: "legacy-fr@1",
          state: "approved",
          version: 4,
        },
      }),
    );
    const approved = await markup();

    expect(approved).not.toContain("Save decision");
    expect(approved).toContain("Apply approved import");
  });

  test("reports an applied run's outcome and offers a compensating review", async () => {
    review.detail.mockResolvedValue(
      detailFixture({
        report: {
          counts: { created: 2 },
          createdAt: new Date("2026-08-21T10:00:00.000Z"),
          manifestSha256,
          warnings: [],
        },
        run: {
          id: runId,
          manifestSha256,
          parserVersion: "legacy-fr@1",
          state: "applied",
          version: 5,
        },
      }),
    );
    const html = await markup();

    expect(html).toContain("Apply report");
    expect(html).toContain("Start correction review");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("reports an unknown run as absent", async () => {
    review.detail.mockResolvedValue(null);

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(review.notFound).toHaveBeenCalled();
  });
});
