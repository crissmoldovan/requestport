import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  boundaryKinds,
  type RouteStateEntry,
  routeAreas,
  routeStateInventory,
  routeStates,
  surfaceForSource,
} from "./route-state-inventory.js";

/** `apps/web/src/app`, the one directory the App Router turns into surfaces. */
const appRoot = fileURLToPath(new URL("../app/", import.meta.url));

/**
 * The five file names the App Router turns into a rendered surface. A
 * `layout.tsx` is deliberately absent: it wraps surfaces rather than being one,
 * and `route.ts` is a transport endpoint with no visual state at all.
 */
const surfaceFileNames = [
  "page.tsx",
  "loading.tsx",
  "error.tsx",
  "not-found.tsx",
  "global-error.tsx",
] as const;

async function discoveredSurfaces() {
  const entries = await readdir(appRoot, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (surfaceFileNames as readonly string[]).includes(entry.name),
    )
    .map((entry) =>
      relative(appRoot, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
}

async function exists(source: string) {
  try {
    await stat(join(appRoot, source));
    return true;
  } catch {
    return false;
  }
}

/**
 * The route pattern a surface file location implies: route groups disappear,
 * the surface file name disappears, and what remains is the URL the router
 * serves. Deriving it here rather than trusting the inventory is the point —
 * a row that claims a pattern its own file cannot produce is a lie the test
 * catches.
 */
function patternFromSource(source: string) {
  const segments = source.split("/").slice(0, -1);
  const routed = segments.filter(
    (segment) => !(segment.startsWith("(") && segment.endsWith(")")),
  );

  return `/${routed.join("/")}`.replace(/\/$/u, "") || "/";
}

const inventoryBySource = new Map<string, RouteStateEntry>(
  routeStateInventory.map((entry) => [entry.source, entry]),
);

describe("route and state vocabulary", () => {
  test("closes the state vocabulary at the twelve reviewed values", () => {
    expect([...routeStates]).toEqual([
      "conflict",
      "default",
      "destructive",
      "disabled",
      "empty",
      "error",
      "loading",
      "member_denied",
      "not_found",
      "pending",
      "provider_unavailable",
      "success",
    ]);
  });

  test("uses every state the vocabulary declares", () => {
    const used = new Set(
      routeStateInventory.flatMap((entry) => [...entry.states]),
    );

    expect([...used].sort()).toEqual([...routeStates]);
  });

  test("gives every row a sorted, unique, non-empty state set", () => {
    for (const entry of routeStateInventory) {
      expect({ id: entry.id, states: [...entry.states] }).toEqual({
        id: entry.id,
        states: [...new Set(entry.states)].sort(),
      });
      expect(entry.states.length).toBeGreaterThan(0);
      for (const state of entry.states) {
        expect(routeStates).toContain(state);
      }
    }
  });

  test("draws every area from the reviewed surface map", () => {
    for (const entry of routeStateInventory) {
      expect(routeAreas).toContain(entry.area);
    }
    expect(new Set(routeStateInventory.map((entry) => entry.area)).size).toBe(
      routeAreas.length,
    );
  });
});

describe("inventory identity", () => {
  test("names every row and every surface exactly once", () => {
    const ids = routeStateInventory.map((entry) => entry.id);
    const sources = routeStateInventory.map((entry) => entry.source);

    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(sources).size).toBe(sources.length);
  });

  test("lists every route pattern exactly once", () => {
    const patterns = routeStateInventory
      .filter((entry) => entry.kind === "route")
      .map((entry) => entry.pattern);

    expect(new Set(patterns).size).toBe(patterns.length);
  });

  test("derives every declared pattern from the surface's own location", () => {
    for (const entry of routeStateInventory) {
      expect({ id: entry.id, pattern: entry.pattern }).toEqual({
        id: entry.id,
        pattern: patternFromSource(entry.source),
      });
    }
  });

  test("matches each row's kind to its surface file name", () => {
    for (const entry of routeStateInventory) {
      const fileName = entry.source.split("/").at(-1);

      expect({ id: entry.id, fileName }).toEqual({
        id: entry.id,
        fileName:
          entry.kind === "route" ? "page.tsx" : `${entry.kind}.tsx`.toString(),
      });
    }
  });

  test("resolves a surface file back to its one inventory row", () => {
    expect(surfaceForSource("(app)/requests/[requestId]/page.tsx")?.id).toBe(
      "route:/requests/[requestId]",
    );
    expect(surfaceForSource("global-error.tsx")?.kind).toBe("global-error");
    expect(surfaceForSource("(app)/nothing/page.tsx")).toBeUndefined();
  });
});

describe("exhaustive coverage of the App Router surface tree", () => {
  test("inventories every surface file that exists today", async () => {
    const uninventoried = (await discoveredSurfaces()).filter(
      (source) => !inventoryBySource.has(source),
    );

    expect(uninventoried).toEqual([]);
  });

  test("carries every route pattern the migration must convert", () => {
    const patterns = routeStateInventory
      .filter((entry) => entry.kind === "route")
      .map((entry) => entry.pattern)
      .sort();

    expect(patterns).toEqual([
      "/",
      "/activity",
      "/agents",
      "/agents/[agentId]",
      "/auth-error",
      "/docs/api",
      "/docs/mcp",
      "/imports",
      "/imports/[runId]",
      "/oauth/agent-consent",
      "/questions",
      "/questions/[questionId]/deliveries",
      "/requests",
      "/requests/[requestId]",
      "/requests/new",
      "/search",
      "/settings/appearance",
      "/settings/members",
      "/settings/operations",
      "/settings/operators",
      "/settings/organization",
      "/settings/projects",
      "/settings/projects/[projectId]",
      "/settings/projects/new",
      "/settings/routing",
      "/sign-in",
      "/slack",
      "/webhooks",
      "/webhooks/[subscriptionId]",
    ]);
  });

  test("requires the root, authentication, and application framework boundaries", () => {
    const boundaries = routeStateInventory
      .filter((entry) => entry.kind !== "route")
      .map((entry) => entry.source)
      .sort();

    expect(boundaries).toEqual([
      "(app)/error.tsx",
      "(app)/loading.tsx",
      "(app)/not-found.tsx",
      "(app)/settings/appearance/error.tsx",
      "(app)/settings/appearance/loading.tsx",
      "(app)/settings/error.tsx",
      "(app)/settings/not-found.tsx",
      "(auth)/error.tsx",
      "(auth)/loading.tsx",
      "(auth)/not-found.tsx",
      "error.tsx",
      "global-error.tsx",
      "not-found.tsx",
      "oauth/loading.tsx",
    ]);
    for (const kind of boundaryKinds) {
      expect(routeStateInventory.some((entry) => entry.kind === kind)).toBe(
        true,
      );
    }
  });

  /**
   * Every route that answers an ordinary member with a denial surface writes
   * the same sentence into it — "… is/are owner and admin only". A row that
   * omits `member_denied` while its page draws that surface hides the state
   * from the acceptance matrix, which builds its cases from these rows, so the
   * one screen a member actually sees would never be opened as a member.
   */
  test("declares member_denied wherever a route draws the denial surface", async () => {
    const undeclared: string[] = [];

    for (const entry of routeStateInventory) {
      if (entry.kind !== "route") continue;
      const source = await readFile(join(appRoot, entry.source), "utf8");
      if (!source.includes("owner and admin only")) continue;
      if (!entry.states.includes("member_denied")) undeclared.push(entry.id);
    }

    expect(undeclared).toEqual([]);
  });

  test("never claims a route surface that is not on disk", async () => {
    const missing: string[] = [];

    for (const entry of routeStateInventory) {
      if (!(await exists(entry.source))) missing.push(entry.source);
    }

    // A boundary the plan still owes may be listed before it is written — that
    // is what makes the inventory a contract rather than a mirror. A *route*
    // may not: every URL this application serves already has a file.
    expect(
      missing.filter(
        (source) => inventoryBySource.get(source)?.kind === "route",
      ),
    ).toEqual([]);
  });
});
