import { appearanceFallback } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  appearanceResolutionFailedEvent,
  appearanceSchemaPendingEvent,
  appearanceWriteFailureCode,
  createAppearanceDiagnostics,
  fallbackAppearanceSnapshot,
  isPendingAppearanceSchemaError,
  loadAppearanceSnapshot,
  sanitizeAppearanceSnapshot,
} from "./appearance.js";

/**
 * The exact shape `pg` raises for `undefined_table`, wrapped the way Drizzle
 * wraps it: a generic `Failed query` error whose `cause` carries the SQLSTATE.
 * Matching only the top-level error is the mistake this fixture exists to make
 * visible.
 */
function undefinedTable(relation: string) {
  const driver = Object.assign(
    new Error(`relation "${relation}" does not exist`),
    { code: "42P01", routine: "parserOpenTable", severity: "ERROR" },
  );
  return new Error("Failed query: select * from …", { cause: driver });
}

function driverError(code: string, message: string) {
  return new Error("Failed query: select * from …", {
    cause: Object.assign(new Error(message), { code, severity: "ERROR" }),
  });
}

type LoggedRecord = {
  event: string;
  fields: { errorCode?: string; count?: number };
};

function recordingLogger() {
  const records: LoggedRecord[] = [];
  return {
    records,
    logger: {
      warn(event: string, fields: { errorCode?: string; count?: number }) {
        records.push({ event, fields });
      },
    },
  };
}

/** Stands in for any provider detail a thrown error might carry. */
const sentinel = "appearance-diagnostic-sentinel-must-never-be-logged";

type DependencyOverrides = Partial<
  Parameters<typeof loadAppearanceSnapshot>[0]
>;

function snapshotDependencies(overrides: DependencyOverrides = {}) {
  const { logger } = recordingLogger();
  return {
    diagnostics: createAppearanceDiagnostics({ logger }),
    readOptionalUserId: async () => "11111111-1111-4111-8111-111111111111",
    readCurrentOrganizationId: async () =>
      "22222222-2222-4222-8222-222222222222",
    readSnapshot: async () => fallbackAppearanceSnapshot(),
    ...overrides,
  };
}

const personalisedSnapshot = {
  user: { theme: "terminal", density: null, mode: null, version: 4 },
  organization: {
    theme: "venu",
    density: "large",
    mode: "light",
    version: 7,
  },
  effective: {
    // Deliberately disagrees with the two rows above: the resolver must
    // recompute the triple rather than trust a projection it was handed.
    theme: "snuffle",
    density: "ultra-compact",
    mode: "dark",
    source: { theme: "fallback", density: "fallback", mode: "fallback" },
  },
};

describe("pre-migration appearance schema detection", () => {
  test("recognises 42P01 for each new appearance relation through the cause chain", () => {
    expect(
      isPendingAppearanceSchemaError(
        undefinedTable("user_appearance_preferences"),
      ),
    ).toBe(true);
    expect(
      isPendingAppearanceSchemaError(
        undefinedTable("organization_appearance_defaults"),
      ),
    ).toBe(true);
    expect(
      isPendingAppearanceSchemaError(
        Object.assign(new Error('relation "user_appearance_preferences" x'), {
          code: "42P01",
        }),
      ),
    ).toBe(true);
  });

  test("rejects 42P01 raised for any other relation", () => {
    expect(
      isPendingAppearanceSchemaError(undefinedTable("organizations")),
    ).toBe(false);
    expect(
      isPendingAppearanceSchemaError(undefinedTable("command_receipts")),
    ).toBe(false);
  });

  test("rejects every other SQLSTATE even on an appearance relation", () => {
    expect(
      isPendingAppearanceSchemaError(
        driverError(
          "42501",
          'permission denied for table "user_appearance_preferences"',
        ),
      ),
    ).toBe(false);
    expect(
      isPendingAppearanceSchemaError(
        driverError(
          "23505",
          'duplicate key value violates "organization_appearance_defaults_pkey"',
        ),
      ),
    ).toBe(false);
    expect(isPendingAppearanceSchemaError(new Error("boom"))).toBe(false);
    expect(isPendingAppearanceSchemaError(null)).toBe(false);
    expect(isPendingAppearanceSchemaError("42P01")).toBe(false);
  });

  test("stops walking a cyclic or absurdly deep cause chain", () => {
    let deep: unknown = Object.assign(
      new Error('relation "user_appearance_preferences" does not exist'),
      { code: "42P01" },
    );
    for (let depth = 0; depth < 12; depth += 1) {
      deep = new Error("wrapped", { cause: deep });
    }

    expect(isPendingAppearanceSchemaError(deep)).toBe(false);
  });
});

describe("appearance write failure mapping", () => {
  test("maps only the exact missing-schema condition to temporarily_unavailable", () => {
    expect(
      appearanceWriteFailureCode(
        undefinedTable("organization_appearance_defaults"),
      ),
    ).toBe("temporarily_unavailable");
    expect(
      appearanceWriteFailureCode(undefinedTable("user_appearance_preferences")),
    ).toBe("temporarily_unavailable");
  });

  test("maps every other unknown write failure to unexpected_error", () => {
    expect(appearanceWriteFailureCode(undefinedTable("organizations"))).toBe(
      "unexpected_error",
    );
    expect(
      appearanceWriteFailureCode(
        driverError("40001", "could not serialize access"),
      ),
    ).toBe("unexpected_error");
    expect(appearanceWriteFailureCode(new Error(sentinel))).toBe(
      "unexpected_error",
    );
    expect(appearanceWriteFailureCode(undefined)).toBe("unexpected_error");
  });
});

describe("bounded rollout telemetry", () => {
  test("emits a distinct bounded event for the pre-migration condition", () => {
    const { logger, records } = recordingLogger();
    const diagnostics = createAppearanceDiagnostics({
      logger,
      schemaPendingLimit: 2,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      diagnostics.recordResolutionFailure(
        undefinedTable("user_appearance_preferences"),
      );
    }

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.event)).toEqual([
      appearanceSchemaPendingEvent,
      appearanceSchemaPendingEvent,
    ]);
    expect(records[0]?.fields).toEqual({ count: 1, errorCode: "42P01" });
    expect(records[1]?.fields).toEqual({ count: 2, errorCode: "42P01" });
  });

  test("keeps every other failure on its own unbounded event without detail", () => {
    const { logger, records } = recordingLogger();
    const diagnostics = createAppearanceDiagnostics({
      logger,
      schemaPendingLimit: 1,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      diagnostics.recordResolutionFailure(new Error(sentinel));
    }

    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.event).toBe(appearanceResolutionFailedEvent);
      expect(Object.keys(record.fields).sort()).toEqual(["errorCode"]);
      expect(JSON.stringify(record)).not.toContain(sentinel);
    }
  });

  test("counts the two conditions independently", () => {
    const { logger, records } = recordingLogger();
    const diagnostics = createAppearanceDiagnostics({
      logger,
      schemaPendingLimit: 1,
    });

    diagnostics.recordResolutionFailure(
      undefinedTable("user_appearance_preferences"),
    );
    diagnostics.recordResolutionFailure(new Error("unrelated"));
    diagnostics.recordResolutionFailure(
      undefinedTable("user_appearance_preferences"),
    );

    expect(records.map((record) => record.event)).toEqual([
      appearanceSchemaPendingEvent,
      appearanceResolutionFailedEvent,
    ]);
  });
});

describe("appearance snapshot validation", () => {
  test("emits the fixed RequestPort fallback with per-axis fallback sources", () => {
    expect(fallbackAppearanceSnapshot()).toEqual({
      user: { theme: null, density: null, mode: null, version: 0 },
      organization: { ...appearanceFallback, version: 0 },
      effective: {
        ...appearanceFallback,
        source: {
          theme: "fallback",
          density: "fallback",
          mode: "fallback",
        },
      },
    });
  });

  test("recomputes the effective triple instead of trusting the projection", () => {
    expect(sanitizeAppearanceSnapshot(personalisedSnapshot)).toEqual({
      user: { theme: "terminal", density: null, mode: null, version: 4 },
      organization: {
        theme: "venu",
        density: "large",
        mode: "light",
        version: 7,
      },
      effective: {
        theme: "terminal",
        density: "large",
        mode: "light",
        source: {
          theme: "user",
          density: "organization",
          mode: "organization",
        },
      },
    });
  });

  test("degrades one malformed stored axis without discarding the others", () => {
    expect(
      sanitizeAppearanceSnapshot({
        user: { theme: "midnight", density: "large", mode: null, version: 2 },
        organization: {
          theme: "cue",
          density: "gigantic",
          mode: "light",
          version: 3,
        },
      }),
    ).toEqual({
      user: { theme: null, density: "large", mode: null, version: 2 },
      organization: {
        theme: "cue",
        density: appearanceFallback.density,
        mode: "light",
        version: 3,
      },
      effective: {
        theme: "cue",
        density: "large",
        mode: "light",
        source: {
          theme: "organization",
          density: "user",
          mode: "organization",
        },
      },
    });
  });

  test("treats a non-positive or absent version as an absent row", () => {
    expect(
      sanitizeAppearanceSnapshot({
        user: { theme: "dusk", density: null, mode: null, version: 0 },
        organization: { theme: "dusk", density: "normal", mode: "dark" },
      }),
    ).toEqual(fallbackAppearanceSnapshot());
    expect(sanitizeAppearanceSnapshot(null)).toEqual(
      fallbackAppearanceSnapshot(),
    );
    expect(sanitizeAppearanceSnapshot("terminal")).toEqual(
      fallbackAppearanceSnapshot(),
    );
  });

  test("keeps an all-null personal tombstone inheriting while retaining its version", () => {
    expect(
      sanitizeAppearanceSnapshot({
        user: { theme: null, density: null, mode: null, version: 9 },
        organization: {
          theme: "signal",
          density: "normal",
          mode: "dark",
          version: 2,
        },
      }),
    ).toEqual({
      user: { theme: null, density: null, mode: null, version: 9 },
      organization: {
        theme: "signal",
        density: "normal",
        mode: "dark",
        version: 2,
      },
      effective: {
        theme: "signal",
        density: "normal",
        mode: "dark",
        source: {
          theme: "organization",
          density: "organization",
          mode: "organization",
        },
      },
    });
  });
});

describe("fail-open appearance resolution", () => {
  test("shows no tenant default once membership is revoked or cross-tenant", async () => {
    // The repository reads the organization default through the caller's own
    // active membership, so a revoked member — or a tenant the caller never
    // belonged to — comes back absent rather than leaking another tenant's
    // presentation. The axes fall through to the caller's own overrides.
    const resolution = await loadAppearanceSnapshot(
      snapshotDependencies({
        readCurrentOrganizationId: async () =>
          "55555555-5555-4555-8555-555555555555",
        readSnapshot: async () => ({
          user: { theme: "luma", density: null, mode: null, version: 2 },
          organization: { ...appearanceFallback, version: 0 },
          effective: {
            theme: "venu",
            density: "large",
            mode: "dark",
            source: {
              theme: "organization",
              density: "organization",
              mode: "organization",
            },
          },
        }),
      }),
    );

    expect(resolution.snapshot.organization.version).toBe(0);
    expect(resolution.snapshot.effective).toEqual({
      theme: "luma",
      density: appearanceFallback.density,
      mode: appearanceFallback.mode,
      source: { theme: "user", density: "fallback", mode: "fallback" },
    });
  });

  test("returns the anonymous fallback without reading preferences", async () => {
    let snapshotReads = 0;
    const { logger, records } = recordingLogger();

    const resolution = await loadAppearanceSnapshot(
      snapshotDependencies({
        diagnostics: createAppearanceDiagnostics({ logger }),
        readOptionalUserId: async () => null,
        readSnapshot: async () => {
          snapshotReads += 1;
          return fallbackAppearanceSnapshot();
        },
      }),
    );

    expect(resolution).toEqual({
      snapshot: fallbackAppearanceSnapshot(),
      status: "anonymous",
    });
    expect(snapshotReads).toBe(0);
    expect(records).toEqual([]);
  });

  test("resolves an authenticated snapshot for the actor's current organization", async () => {
    const calls: { userId: string; organizationId: string | null }[] = [];

    const resolution = await loadAppearanceSnapshot(
      snapshotDependencies({
        readSnapshot: async (input) => {
          calls.push(input);
          return personalisedSnapshot;
        },
      }),
    );

    expect(calls).toEqual([
      {
        userId: "11111111-1111-4111-8111-111111111111",
        organizationId: "22222222-2222-4222-8222-222222222222",
      },
    ]);
    expect(resolution.status).toBe("authenticated");
    expect(resolution.snapshot.effective).toEqual({
      theme: "terminal",
      density: "large",
      mode: "light",
      source: { theme: "user", density: "organization", mode: "organization" },
    });
  });

  test("resolves a user with no organization at all", async () => {
    const calls: { userId: string; organizationId: string | null }[] = [];

    const resolution = await loadAppearanceSnapshot(
      snapshotDependencies({
        readCurrentOrganizationId: async () => null,
        readSnapshot: async (input) => {
          calls.push(input);
          return {
            user: {
              theme: null,
              density: "normal",
              mode: null,
              version: 1,
            },
            organization: {
              ...appearanceFallback,
              version: 0,
            },
            effective: {
              ...appearanceFallback,
              source: {
                theme: "fallback",
                density: "fallback",
                mode: "fallback",
              },
            },
          };
        },
      }),
    );

    expect(calls[0]?.organizationId).toBeNull();
    expect(resolution.status).toBe("authenticated");
    expect(resolution.snapshot.effective).toEqual({
      theme: appearanceFallback.theme,
      density: "normal",
      mode: appearanceFallback.mode,
      source: { theme: "fallback", density: "user", mode: "fallback" },
    });
  });

  const failingBoundaries: [string, DependencyOverrides][] = [
    [
      "session",
      {
        readOptionalUserId: async () => {
          throw new Error(sentinel);
        },
      },
    ],
    [
      "cookie or organization",
      {
        readCurrentOrganizationId: async () => {
          throw new Error(sentinel);
        },
      },
    ],
    [
      "preference read",
      {
        readSnapshot: async () => {
          throw new Error(sentinel);
        },
      },
    ],
  ];

  test.each(failingBoundaries)(
    "falls open to the RequestPort triple when the %s boundary fails",
    async (_label, override) => {
      const { logger, records } = recordingLogger();

      const resolution = await loadAppearanceSnapshot(
        snapshotDependencies({
          diagnostics: createAppearanceDiagnostics({ logger }),
          ...override,
        }),
      );

      expect(resolution).toEqual({
        snapshot: fallbackAppearanceSnapshot(),
        status: "unavailable",
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.event).toBe(appearanceResolutionFailedEvent);
      expect(JSON.stringify(records)).not.toContain(sentinel);
      expect(JSON.stringify(resolution)).not.toContain(sentinel);
    },
  );

  test("uses the distinct rollout event while 0014 is still pending", async () => {
    const { logger, records } = recordingLogger();

    const resolution = await loadAppearanceSnapshot(
      snapshotDependencies({
        diagnostics: createAppearanceDiagnostics({ logger }),
        readSnapshot: async () => {
          throw undefinedTable("user_appearance_preferences");
        },
      }),
    );

    expect(resolution).toEqual({
      snapshot: fallbackAppearanceSnapshot(),
      status: "unavailable",
    });
    expect(records).toEqual([
      {
        event: appearanceSchemaPendingEvent,
        fields: { count: 1, errorCode: "42P01" },
      },
    ]);
  });

  test("never returns an actor, tenant, or copy in the resolved value", async () => {
    const resolution = await loadAppearanceSnapshot(
      snapshotDependencies({
        readSnapshot: async () => personalisedSnapshot,
      }),
    );
    const serialised = JSON.stringify(resolution);

    expect(serialised).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(serialised).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(serialised).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-/u);
  });

  test("never substitutes a session when the optional read fails", async () => {
    let snapshotReads = 0;

    const resolution = await loadAppearanceSnapshot(
      snapshotDependencies({
        readOptionalUserId: async () => {
          throw new Error("provider-unavailable");
        },
        readSnapshot: async () => {
          snapshotReads += 1;
          return personalisedSnapshot;
        },
      }),
    );

    expect(snapshotReads).toBe(0);
    expect(resolution.status).toBe("unavailable");
    expect(Object.keys(resolution).sort()).toEqual(["snapshot", "status"]);
  });
});

/**
 * The boundary is fail-open, and `redirect()`/`notFound()` are not failures —
 * they are the framework's control flow, implemented by throwing. A catch-all
 * that mapped one would replace the navigation with the fixed triple and a
 * diagnostic, and the reader would sit on a page the framework had already
 * decided to leave. The dependencies are injected here, so nothing about the
 * text of this module says whether one can throw a sentinel; only running it
 * can, which is what this does.
 */
describe("the framework's own control flow", () => {
  function frameworkError(digest: string) {
    return Object.assign(new Error(digest.split(";")[0] as string), { digest });
  }

  const controlFlow = [
    ["a redirect", "NEXT_REDIRECT;replace;/sign-in;307;"],
    ["a not-found", "NEXT_HTTP_ERROR_FALLBACK;404"],
  ] as const;

  for (const [name, digest] of controlFlow) {
    test(`lets ${name} thrown while reading the session escape`, async () => {
      const thrown = frameworkError(digest);

      await expect(
        loadAppearanceSnapshot(
          snapshotDependencies({
            readOptionalUserId: async () => {
              throw thrown;
            },
          }),
        ),
      ).rejects.toBe(thrown);
    });
  }
});
