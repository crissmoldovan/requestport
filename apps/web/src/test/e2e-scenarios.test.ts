import { describe, expect, test } from "vitest";

import {
  type E2EScenarioTable,
  e2eScenarioTables,
} from "../lib/e2e-scenario.js";
import {
  e2eScenarioAspects,
  e2eScenarioCleanupOwners,
  e2eScenarioFaults,
  e2eScenarioIds,
  e2eScenarioLanes,
  e2eScenarios,
  resolveE2EScenario,
} from "./e2e-scenarios.js";
import { boundaryKinds, routeStates } from "./route-state-inventory.js";

/** The exact shape of a catalogue entry. Nothing else may be carried. */
const definitionKeys = [
  "aspect",
  "cleanupOwner",
  "fault",
  "id",
  "lane",
  "states",
  "tables",
] as const;

describe("closed E2E scenario catalogue", () => {
  test("enumerates its cases under stable, unique, sorted identifiers", () => {
    expect(e2eScenarioIds.length).toBeGreaterThan(0);
    expect([...e2eScenarioIds]).toEqual([...e2eScenarioIds].sort());
    expect(new Set(e2eScenarioIds).size).toBe(e2eScenarioIds.length);
    expect(Object.keys(e2eScenarios).sort()).toEqual([...e2eScenarioIds]);

    for (const id of e2eScenarioIds) {
      expect({
        id,
        wellFormed: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id),
      }).toEqual({
        id,
        wellFormed: true,
      });
      expect(e2eScenarios[id].id).toBe(id);
    }
  });

  test("resolves a catalogued identifier and nothing else", () => {
    for (const id of e2eScenarioIds) {
      expect(resolveE2EScenario(id)).toBe(e2eScenarios[id]);
    }

    for (const rejected of [
      "",
      " loading-boundary",
      "LOADING-BOUNDARY",
      "drop-everything",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "SELECT 1",
      null,
      undefined,
      42,
      {},
      ["loading-boundary"],
      Symbol.iterator,
    ]) {
      expect({
        rejected: String(typeof rejected === "symbol" ? "symbol" : rejected),
        resolved: resolveE2EScenario(rejected),
      }).toEqual({
        rejected: String(typeof rejected === "symbol" ? "symbol" : rejected),
        resolved: null,
      });
    }
  });

  test("carries nothing but closed vocabulary on every case", () => {
    for (const id of e2eScenarioIds) {
      const definition = e2eScenarios[id];

      expect({ id, keys: Object.keys(definition).sort() }).toEqual({
        id,
        keys: [...definitionKeys],
      });
      expect({ id, lane: definition.lane }).toEqual({
        id,
        lane: expect.stringMatching(
          new RegExp(`^(?:${e2eScenarioLanes.join("|")})$`, "u"),
        ),
      });
      expect(e2eScenarioAspects).toContain(definition.aspect);
      expect(e2eScenarioFaults).toContain(definition.fault);
      expect(e2eScenarioCleanupOwners).toContain(definition.cleanupOwner);

      for (const state of definition.states) {
        expect({ id, state, known: routeStates.includes(state) }).toEqual({
          id,
          state,
          known: true,
        });
      }
      for (const table of definition.tables) {
        expect({
          id,
          table,
          known: (e2eScenarioTables as readonly string[]).includes(table),
        }).toEqual({ id, table, known: true });
      }
    }
  });

  test("claims every state the acceptance contract names", () => {
    const claimed = new Set(
      e2eScenarioIds.map((id) => e2eScenarios[id].aspect),
    );

    expect([...claimed].sort()).toEqual([...e2eScenarioAspects]);
  });

  test("names only faults the route/state inventory can reach", () => {
    const reachable = new Set<string>([
      "none",
      ...routeStates,
      ...boundaryKinds.map((kind) => kind.replaceAll("-", "_")),
    ]);

    for (const fault of e2eScenarioFaults) {
      expect({ fault, reachable: reachable.has(fault) }).toEqual({
        fault,
        reachable: true,
      });
    }
  });

  test("gives every row-creating case an owner that removes the rows", () => {
    for (const id of e2eScenarioIds) {
      const definition = e2eScenarios[id];
      const creates = definition.tables.length > 0;

      expect({ creates, id, owner: definition.cleanupOwner }).toEqual({
        creates,
        id,
        owner: creates ? "scenario-run" : "browser-context",
      });
    }
  });

  test("lists each case's tables in the one order cleanup can reverse", () => {
    const position = new Map(
      e2eScenarioTables.map((table, index) => [table, index] as const),
    );

    for (const id of e2eScenarioIds) {
      const { tables } = e2eScenarios[id];
      const ordered = [...tables].sort(
        (left: E2EScenarioTable, right: E2EScenarioTable) =>
          (position.get(left) ?? 0) - (position.get(right) ?? 0),
      );

      expect({ id, tables: [...tables] }).toEqual({ id, tables: ordered });
      expect({ id, unique: new Set(tables).size }).toEqual({
        id,
        unique: tables.length,
      });
    }
  });
});
