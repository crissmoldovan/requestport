import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { E2E_TOKEN_HEADER } from "@requestport/auth/e2e";
import { describe, expect, test } from "vitest";

import {
  e2eScenarioFailures,
  e2eScenarioTables,
  isE2EScenarioRequestAllowed,
  isLoopbackHost,
  openE2EScenarioRun,
  uncleanedReferences,
  withE2EScenarioRun,
} from "./e2e-scenario.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const migrationRoot = resolve(repositoryRoot, "packages/db/migrations");

/**
 * Every foreign key the checked-in migrations declare, as `child -> parent`.
 *
 * The cleanup order is only trustworthy if it is checked against the schema
 * that actually exists rather than against a remembered picture of it, so the
 * edges are read out of the migration SQL that creates them.
 */
function foreignKeyEdges(): ReadonlySet<string> {
  const edges = new Set<string>();
  const pattern =
    /ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \("[^)]*"\) REFERENCES "public"\."([a-z_]+)"/gu;

  for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const sql = readFileSync(resolve(migrationRoot, entry.name), "utf8");
    for (const match of sql.matchAll(pattern)) {
      edges.add(`${match[1]}->${match[2]}`);
    }
  }

  return edges;
}

/**
 * Every foreign key that can refuse a cleanup, as `constraint -> child -> parent`.
 *
 * A cascading key cannot: deleting the parent takes the child with it. A
 * non-cascading one from a table cleanup never touches into a table it deletes
 * is the shape that raises `23503` and fails a lane — which is what happened to
 * `retention_holds_created_by_user_id_user_id_fk` on staging acceptance run
 * 34842342037, read as flakiness because the lane passed on retry.
 */
function blockingReferences(): ReadonlyMap<string, string> {
  const blocking = new Map<string, string>();
  const listed = new Set<string>(e2eScenarioTables);
  const added =
    /ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \("[^)]*"\) REFERENCES "public"\."([a-z_]+)"[^;]*;/gu;
  const dropped = /ALTER TABLE "[a-z_]+" DROP CONSTRAINT "([^"]+)"/gu;

  // In file order, and honouring drops, because several of these keys were
  // replaced by a later migration under a new name. Reading every ADD across
  // the whole history without the DROPs beside them pins four constraints the
  // schema does not have, which is a register of things that cannot happen.
  const files = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  for (const name of files) {
    const sql = readFileSync(resolve(migrationRoot, name), "utf8");
    for (const match of sql.matchAll(dropped)) blocking.delete(match[1] ?? "");
    for (const match of sql.matchAll(added)) {
      const [statement, child = "", constraint = "", parent = ""] = match;
      if (
        !listed.has(parent) ||
        listed.has(child) ||
        /on delete cascade/iu.test(statement)
      ) {
        blocking.delete(constraint);
        continue;
      }
      blocking.set(constraint, `${child} -> ${parent}`);
    }
  }

  return blocking;
}

type Batch = { table: string; ids: readonly string[] };

function recordingDeleter(log: Batch[]) {
  return async (batch: { table: string; ids: readonly string[] }) => {
    log.push({ table: batch.table, ids: [...batch.ids] });
  };
}

const fixedFailures = new Set<string>(Object.values(e2eScenarioFailures));

const guardToken = "guard-token-that-is-at-least-thirty-two-characters";
const guardEnvironment = {
  NODE_ENV: "development",
  REQUESTPORT_E2E_MODE: "1",
  REQUESTPORT_E2E_TOKEN: guardToken,
} as const;

/**
 * Exactly the headers the checked-in `pnpm dev:e2e` server puts on a
 * route-handler request.
 *
 * They were read off the running server rather than imagined: `Host` arrives
 * verbatim, and Next injects the whole `x-forwarded-*` family from the socket
 * it accepted. A hand-built request that omits them is not the request this
 * guard has to answer — which is how a guard that rejected every one of them
 * stayed green through its own implementation.
 */
const runtimeHeaders = {
  host: "127.0.0.1:3100",
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-host": "127.0.0.1:3100",
  "x-forwarded-port": "3100",
  "x-forwarded-proto": "http",
} as const;

/**
 * One request as the runtime would hand it over, with named headers changed or
 * removed.
 *
 * The URL is the one Next actually builds: it normalises the host to
 * `localhost` whatever `--hostname` the server was started with, so the URL and
 * the `Host` header disagree on every real request.
 */
function runtimeRequest(
  overrides: Readonly<Record<string, string | null>> = {},
): Request {
  const headers = new Headers({
    ...runtimeHeaders,
    [E2E_TOKEN_HEADER]: guardToken,
  });

  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }

  return new Request("http://localhost:3100/api/test/scenarios", {
    body: "{}",
    headers,
    method: "POST",
  });
}

describe("E2E scenario primitive", () => {
  test("orders its tables so no row is deleted after the row it references", () => {
    const position = new Map(
      e2eScenarioTables.map((table, index) => [table, index] as const),
    );
    const inverted: string[] = [];

    for (const edge of foreignKeyEdges()) {
      const [child = "", parent = ""] = edge.split("->");
      const childIndex = position.get(child as never);
      const parentIndex = position.get(parent as never);
      if (childIndex === undefined || parentIndex === undefined) continue;
      if (parentIndex >= childIndex) inverted.push(edge);
    }

    expect(inverted.sort()).toEqual([]);
    expect(new Set(e2eScenarioTables).size).toBe(e2eScenarioTables.length);
  });

  /**
   * The half of the cleanup contract the ordering test above cannot see.
   *
   * That test skips any edge whose child is not in `e2eScenarioTables`
   * (`if (childIndex === undefined … ) continue`), so it checks the *order* of
   * the tables that are listed and is structurally unable to notice one that
   * should be listed and is not. `retention_holds` was invisible to it, and a
   * lane died on `23503 retention_holds_created_by_user_id_user_id_fk` while
   * every test stayed green.
   *
   * So the schema is asked a different question here: which foreign keys could
   * refuse a delete this cleanup issues? Each one has to be accounted for by
   * name in `uncleanedReferences`, with the reason it is not a problem. A new
   * one fails this test; so does an entry recorded for a key the schema no
   * longer has, because a stale reason reads exactly like a considered one.
   */
  test("accounts for every reference that could refuse a cleanup", () => {
    const blocking = blockingReferences();
    const recorded = new Set(Object.keys(uncleanedReferences));

    expect([...blocking.keys()].sort()).toEqual([...recorded].sort());
    // And the reasons describe the edge the schema actually declares, so a
    // renamed table cannot leave a reason pointing at the old shape.
    for (const [constraint, edge] of blocking) {
      expect({
        constraint,
        edge: uncleanedReferences[constraint]?.edge,
      }).toEqual({ constraint, edge });
    }
  });

  test("namespaces a run with a generated UUID and hands it to the seed", async () => {
    const seen: string[] = [];
    const namespaces = new Set<string>();

    for (let run = 0; run < 2; run += 1) {
      await withE2EScenarioRun(
        {
          deleteRows: recordingDeleter([]),
          seed: async (scenario) => {
            seen.push(scenario.namespace);
          },
        },
        async (scenario) => {
          namespaces.add(scenario.namespace);
        },
      );
    }

    expect(namespaces.size).toBe(2);
    for (const namespace of [...namespaces, ...seen]) {
      expect(namespace).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });

  test("deletes exactly the recorded rows, in reverse foreign-key order", async () => {
    const log: Batch[] = [];

    await withE2EScenarioRun(
      {
        deleteRows: recordingDeleter(log),
        seed: async (scenario) => {
          scenario.record("organizations", "organization-1");
          scenario.record("projects", "project-1");
          scenario.record("organization_members", "member-1");
          scenario.record("projects", "project-2");
        },
      },
      async () => undefined,
    );

    expect(log).toEqual([
      { table: "projects", ids: ["project-1", "project-2"] },
      { table: "organization_members", ids: ["member-1"] },
      { table: "organizations", ids: ["organization-1"] },
    ]);
  });

  test("cleans up in a finally block when the body throws", async () => {
    const log: Batch[] = [];

    await expect(
      withE2EScenarioRun(
        {
          deleteRows: recordingDeleter(log),
          seed: async (scenario) => {
            scenario.record("user", "user-1");
          },
        },
        async () => {
          throw new Error("body-specific text that must not escape");
        },
      ),
    ).rejects.toThrowError(e2eScenarioFailures.body);

    expect(log).toEqual([{ table: "user", ids: ["user-1"] }]);
  });

  test("cleans up the rows a failing seed had already created", async () => {
    const log: Batch[] = [];

    await expect(
      openE2EScenarioRun({
        deleteRows: recordingDeleter(log),
        seed: async (scenario) => {
          scenario.record("organizations", "organization-1");
          throw new Error("seed-specific text that must not escape");
        },
      }),
    ).rejects.toThrowError(e2eScenarioFailures.seed);

    expect(log).toEqual([{ table: "organizations", ids: ["organization-1"] }]);
  });

  test("reports a failing deletion as the fixed cleanup failure", async () => {
    await expect(
      withE2EScenarioRun(
        {
          deleteRows: async () => {
            throw new Error("database-specific text that must not escape");
          },
          seed: async (scenario) => {
            scenario.record("user", "user-1");
          },
        },
        async () => undefined,
      ),
    ).rejects.toThrowError(e2eScenarioFailures.cleanup);
  });

  test("names the table a deletion failed on, and nothing the database said", async () => {
    // A failed cleanup used to say only that one had happened. When a change
    // began seeding two new tables and every release in a lane started failing,
    // there was no way to tell from CI whether the trouble was those rows or
    // rows that had always been there — the answer needed a run of its own.
    // The table is one of a closed, checked-in list and names nothing a run
    // created, so it is safe to say; the database's own message still is not.
    const attempt = withE2EScenarioRun(
      {
        deleteRows: async ({ table }) => {
          if (table === "projects") {
            throw new Error("database-specific text that must not escape");
          }
        },
        seed: async (scenario) => {
          scenario.record("projects", "project-1");
          scenario.record("requests", "request-1");
        },
      },
      async () => undefined,
    );

    await expect(attempt).rejects.toThrowError(e2eScenarioFailures.cleanup);
    await expect(attempt).rejects.toThrowError(/: projects$/u);
    // Planted: the row the deletion actually failed on is not the last one the
    // seed wrote, so a message that named whatever was deleted first — or last
    // — would pass the check above and mislead the next reader.
    await expect(attempt).rejects.not.toThrowError(/requests/u);
    await expect(attempt).rejects.not.toThrowError(/database-specific/u);
  });

  test("refuses to record a table outside the closed cleanup vocabulary", async () => {
    await expect(
      openE2EScenarioRun({
        deleteRows: recordingDeleter([]),
        seed: async (scenario) => {
          (scenario.record as (table: string, id: string) => void)(
            "domain_events",
            "event-1",
          );
        },
      }),
    ).rejects.toThrowError(e2eScenarioFailures.seed);
  });

  test("names the cleanup order when a case records a table outside it", async () => {
    let raised = "";

    await openE2EScenarioRun({
      deleteRows: recordingDeleter([]),
      seed: async (scenario) => {
        try {
          (scenario.record as (table: string, id: string) => void)(
            "domain_events",
            "event-1",
          );
        } catch (error: unknown) {
          raised = error instanceof Error ? error.message : String(error);
        }
      },
    });

    expect(raised).toBe(e2eScenarioFailures.table);
  });

  test("emits only fixed failure text", async () => {
    const raised: string[] = [];

    for (const attempt of [
      () =>
        openE2EScenarioRun({
          deleteRows: recordingDeleter([]),
          seed: async () => {
            throw new Error("free-form");
          },
        }),
      () =>
        withE2EScenarioRun(
          {
            deleteRows: recordingDeleter([]),
            seed: async () => undefined,
          },
          async () => {
            throw new Error("free-form");
          },
        ),
    ]) {
      await attempt().catch((error: unknown) => {
        raised.push(error instanceof Error ? error.message : String(error));
      });
    }

    expect(raised).toHaveLength(2);
    for (const message of raised) {
      expect(fixedFailures.has(message)).toBe(true);
    }
  });

  test("accepts only a literal loopback address as the request host", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.1:3100",
      "127.1.2.3",
      "[::1]",
      "[::1]:3100",
    ]) {
      expect({ host, loopback: isLoopbackHost(host) }).toEqual({
        host,
        loopback: true,
      });
    }

    for (const host of [
      "",
      "localhost",
      "localhost:3100",
      "staging.requestport.com",
      "127.0.0.1.example.invalid",
      "0.0.0.0",
      "10.0.0.4:3100",
      "[::ffff:127.0.0.1]",
    ]) {
      expect({ host, loopback: isLoopbackHost(host) }).toEqual({
        host,
        loopback: false,
      });
    }
  });
  test.each([
    ["the headers the Next runtime injects", {}],
    [
      "a loopback forwarded chain",
      { "x-forwarded-for": "127.0.0.1, 127.1.2.3" },
    ],
    [
      "an RFC 7239 header that names only loopback",
      { forwarded: 'for="[::1]";host="127.0.0.1:3100";proto=http' },
    ],
  ])("allows %s", (_name, overrides) => {
    expect(
      isE2EScenarioRequestAllowed({
        env: guardEnvironment,
        request: runtimeRequest(overrides),
      }),
    ).toBe(true);
  });

  test.each([
    ["a request that names no authority", { host: null }],
    ["a named loopback authority", { host: "localhost:3100" }],
    ["a public authority", { host: "staging.requestport.com" }],
    ["a private network authority", { host: "10.0.0.4:3100" }],
    ["a forwarded public client", { "x-forwarded-for": "203.0.113.7" }],
    [
      "a forwarded chain that begins outside loopback",
      { "x-forwarded-for": "203.0.113.7, 127.0.0.1" },
    ],
    ["an empty forwarded client", { "x-forwarded-for": "" }],
    [
      "a rewritten forwarded host",
      { "x-forwarded-host": "staging.requestport.com" },
    ],
    ["a terminated TLS hop", { "x-forwarded-proto": "https" }],
    ["a rewritten forwarded port", { "x-forwarded-port": "443" }],
    [
      "an RFC 7239 proxy",
      { forwarded: "for=203.0.113.7;host=staging.requestport.com;proto=https" },
    ],
    ["an RFC 7239 header that names no origin", { forwarded: "proto=https" }],
    ["a missing token", { [E2E_TOKEN_HEADER]: null }],
    ["a wrong token", { [E2E_TOKEN_HEADER]: `${guardToken}-wrong` }],
  ])("refuses %s", (_name, overrides) => {
    expect(
      isE2EScenarioRequestAllowed({
        env: guardEnvironment,
        request: runtimeRequest(overrides),
      }),
    ).toBe(false);
  });

  test("reads the bound authority from the header, never from the URL", () => {
    // Next rebuilds `request.url` from a normalised `localhost`, so a guard
    // that read a host out of it would refuse the runtime's own requests and
    // would accept a proxied one whose URL had been rebuilt the same way.
    expect(new URL(runtimeRequest().url).host).toBe("localhost:3100");
    expect(
      isE2EScenarioRequestAllowed({
        env: guardEnvironment,
        request: runtimeRequest(),
      }),
    ).toBe(true);

    const proxied = new Request("http://127.0.0.1:3100/api/test/scenarios", {
      body: "{}",
      headers: {
        host: "staging.requestport.com",
        [E2E_TOKEN_HEADER]: guardToken,
      },
      method: "POST",
    });

    expect(
      isE2EScenarioRequestAllowed({ env: guardEnvironment, request: proxied }),
    ).toBe(false);
  });
});
