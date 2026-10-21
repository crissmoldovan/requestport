import { describe, expect, test } from "vitest";
import { e2eScenarios } from "../test/e2e-scenarios.js";
import {
  type E2EScenarioRow,
  type E2EScenarioTable,
  e2eScenarioFailures,
  e2eScenarioTables,
} from "./e2e-scenario.js";
import {
  createE2EScenarioRowDeleter,
  createE2EScenarioRowSeeder,
  type E2EScenarioStatement,
  e2eScenarioRowKeys,
} from "./e2e-scenario-seed.js";

/**
 * The run the lifecycle would hand a seeder, reduced to the two things a seeder
 * touches: the namespace every row is derived from, and the ledger.
 *
 * It is a stand-in rather than the real `openE2EScenarioRun`, because what is
 * under test here is the executor — which rows it creates, in which order it
 * records them, and what it does when the database refuses one. The lifecycle's
 * own guarantees are proven in `e2e-scenario.test.ts`.
 */
function recordingRun(namespace = "3f1d2c4b-5a6e-4f70-8912-abcdef012345") {
  const created: E2EScenarioRow[] = [];

  return {
    created,
    run: {
      created,
      namespace,
      record(table: E2EScenarioTable, id: string) {
        created.push({ id, table });
      },
    },
  };
}

const viewer = {
  organizationId: "8ac1f0e2-1111-4222-8333-444455556666",
  userId: "viewer-user-id",
};

function recordingExecutor(failAt = Number.POSITIVE_INFINITY) {
  const statements: E2EScenarioStatement[] = [];

  return {
    execute: async (statement: E2EScenarioStatement) => {
      statements.push(statement);
      if (statements.length > failAt) {
        throw new Error("connection to 10.0.0.1:5432 refused for user seeder");
      }
      return { rows: [] as Record<string, unknown>[] };
    },
    statements,
  };
}

function seederFor(
  failAt?: number,
  readViewer: () => Promise<typeof viewer | null> = async () => viewer,
) {
  const executor = recordingExecutor(failAt);
  const seed = createE2EScenarioRowSeeder({
    execute: executor.execute,
    readViewer,
  });

  return { executor, seed };
}

const request = new Request("http://127.0.0.1:3100/api/test/scenarios", {
  method: "POST",
});

describe("scenario row deleter", () => {
  test("names a key column for every table the cleanup order holds", () => {
    expect(Object.keys(e2eScenarioRowKeys).sort()).toEqual(
      [...e2eScenarioTables].sort(),
    );
  });

  test("deletes one batch by that table's own key, comparing as text", async () => {
    const executor = recordingExecutor();
    const deleteRows = createE2EScenarioRowDeleter(executor.execute);

    await deleteRows({ ids: ["a", "b"], table: "organization_members" });
    await deleteRows({
      ids: [viewer.organizationId],
      table: "organization_appearance_defaults",
    });

    expect(executor.statements).toEqual([
      {
        text: 'DELETE FROM "public"."organization_members" WHERE "id"::text = ANY($1::text[])',
        values: [["a", "b"]],
      },
      {
        text: 'DELETE FROM "public"."organization_appearance_defaults" WHERE "organization_id"::text = ANY($1::text[])',
        values: [[viewer.organizationId]],
      },
    ]);
  });

  test("refuses a table outside the cleanup order with the fixed failure", async () => {
    const executor = recordingExecutor();
    const deleteRows = createE2EScenarioRowDeleter(executor.execute);

    await expect(
      deleteRows({
        ids: ["1"],
        table: "domain_events" as unknown as E2EScenarioTable,
      }),
    ).rejects.toThrow(e2eScenarioFailures.table);
    expect(executor.statements).toEqual([]);
  });

  test("replaces a driver failure with the fixed cleanup vocabulary", async () => {
    const executor = recordingExecutor(0);
    const deleteRows = createE2EScenarioRowDeleter(executor.execute);

    await expect(deleteRows({ ids: ["1"], table: "projects" })).rejects.toThrow(
      e2eScenarioFailures.cleanup,
    );
  });
});

describe("scenario row seeder", () => {
  test("creates and records exactly the rows each case declares", async () => {
    // The exact sequence, not a set: the ledger is walked backwards by table on
    // the way out, and a row recorded before the row it depends on would be
    // deleted after its parent. Two membership rows are expected for the seeded
    // identity — the identity's own, and the viewer's, which is what lets a
    // browser case switch into a tenant with nothing in it.
    const expected = {
      "scenario-cleanup": ["organizations", "projects"],
      "seeded-owner-identity": [
        "signup_allowlist",
        "user",
        "organizations",
        "organization_members",
        "organization_members",
        "organization_appearance_defaults",
      ],
      "seeded-project-data": [
        "projects",
        "project_members",
        "project_repositories",
        "requests",
      ],
    } as const;

    for (const scenario of Object.keys(expected) as (keyof typeof expected)[]) {
      const definition = e2eScenarios[scenario];
      const { executor, seed } = seederFor();
      const { created, run } = recordingRun();

      await seed({ definition, request, run });

      expect({ scenario, tables: created.map((row) => row.table) }).toEqual({
        scenario,
        tables: [...expected[scenario]],
      });
      // Every table it recorded is one the closed catalogue declared for it,
      // and every table the catalogue declared was actually written.
      expect({
        scenario,
        declared: [...new Set(created.map((row) => row.table))].sort(),
      }).toEqual({ scenario, declared: [...definition.tables].sort() });
      // One statement per recorded row: a row in the ledger the database never
      // received is exactly the silent no-op the fixed failure exists to stop.
      expect({ scenario, statements: executor.statements.length }).toEqual({
        scenario,
        statements: created.length,
      });
      for (const row of created) {
        expect({ rowId: row.id, scenario, table: row.table }).toEqual({
          rowId: expect.stringMatching(/^[\w-]+$/u),
          scenario,
          table: row.table,
        });
      }
    }
  });

  test("records a row only after the statement that created it", async () => {
    const definition = e2eScenarios["seeded-owner-identity"];
    const { executor, seed } = seederFor(2);
    const { created, run } = recordingRun();

    await expect(seed({ definition, request, run })).rejects.toThrow(
      e2eScenarioFailures.seed,
    );

    // Two statements succeeded, so exactly two rows are in the ledger and the
    // lifecycle's `finally` can remove them. A seeder that recorded everything
    // up front would strand a delete for a row that was never written; one that
    // recorded at the end would strand the two rows that were.
    expect(created.length).toBe(2);
    expect(executor.statements.length).toBe(3);
  });

  test("lets no seeded value reach the statement text", async () => {
    for (const id of [
      "scenario-cleanup",
      "seeded-owner-identity",
      "seeded-project-data",
    ] as const) {
      const { executor, seed } = seederFor();
      const { run } = recordingRun();

      await seed({ definition: e2eScenarios[id], request, run });

      for (const statement of executor.statements) {
        expect({ id, text: statement.text }).toEqual({
          id,
          text: expect.not.stringContaining(run.namespace),
        });
        expect({ id, values: statement.values.length }).toEqual({
          id,
          values: expect.any(Number),
        });
        expect(statement.values.length).toBeGreaterThan(0);
      }
    }
  });

  test("scopes every seeded project row to the viewer's own tenant", async () => {
    const { executor, seed } = seederFor();
    const { run } = recordingRun();

    await seed({
      definition: e2eScenarios["seeded-project-data"],
      request,
      run,
    });

    for (const statement of executor.statements) {
      expect(statement.values).toContain(viewer.organizationId);
    }
  });

  test("refuses to seed a tenant-scoped case with no viewer", async () => {
    const { executor, seed } = seederFor(undefined, async () => null);
    const { run } = recordingRun();

    await expect(
      seed({
        definition: e2eScenarios["seeded-project-data"],
        request,
        run,
      }),
    ).rejects.toThrow(e2eScenarioFailures.seed);
    expect(executor.statements).toEqual([]);
  });

  test("writes nothing for a case that declares no table", async () => {
    const { executor, seed } = seederFor();
    const { created, run } = recordingRun();

    await seed({
      definition: e2eScenarios["loading-boundary"],
      request,
      run,
    });

    expect(created).toEqual([]);
    expect(executor.statements).toEqual([]);
  });

  test("keeps a driver's own words out of the failure it raises", async () => {
    const { seed } = seederFor(0);
    const { run } = recordingRun();

    await expect(
      seed({
        definition: e2eScenarios["scenario-cleanup"],
        request,
        run,
      }),
    ).rejects.toThrow(
      new RegExp(`^${e2eScenarioFailures.seed.replaceAll(" ", "\\s")}$`, "u"),
    );
  });
});
