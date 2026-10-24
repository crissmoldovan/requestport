import { readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { listen, type RunningHost } from "./node.js";
import {
  FALLBACK_UNDER_FAMILY,
  isUnderFamily,
  matchRoute,
  ROUTE_TABLE,
  type RouteEntry,
  type RouteName,
} from "./route-table.js";

/*
  Done when 2 (manifest-h.md §2.2; H.0b's rule, `spikes/h0-probe/route-table.mjs`;
  ruling 143), over every `route.ts` under `apps/web/src/app`, its URL
  pattern derived as Next derives it: route groups `(x)` and parallel slots
  `@x` are dropped, a `_private` folder is not routable, and `[x]`, `[...x]`
  and `[[...x]]` match one segment, one or more, and none or more.

  1. Completeness: a route whose pattern falls under a family is served by
     exactly one table entry, or named in `FALLBACK_UNDER_FAMILY`. A catch-all
     entry serves only its own file, so a route nested under it is not
     covered by it.
  2. Precedence: a sample path of each route (each dynamic segment filled; an
     optional catch-all tried empty and filled) reaches, through the table's
     first match, the entry serving that same file, and a route the fallback
     serves reaches no entry. A path ending in `/` never reaches the table:
     the Node adapter answers the trailing-slash form of every exact entry
     with a 308 to the entry (ruling 143).

  Which file each entry serves is written here, not in the table module,
  which names no file of the web's.
*/

const app = fileURLToPath(
  new URL("../../../apps/web/src/app/", import.meta.url),
);

const servedBy: Record<RouteName, string> = {
  auth: "api/auth/[...all]/route.ts",
  "authorization-server-metadata":
    ".well-known/oauth-authorization-server/route.ts",
  "openid-configuration": ".well-known/openid-configuration/route.ts",
  "protected-resource-api":
    ".well-known/oauth-protected-resource/api/v1/route.ts",
  "protected-resource-mcp": ".well-known/oauth-protected-resource/mcp/route.ts",
  "artifact-import": "api/v1/imports/artifacts/route.ts",
  rest: "api/v1/[[...path]]/route.ts",
  mcp: "mcp/route.ts",
  liveness: "api/health/live/route.ts",
  readiness: "api/health/ready/route.ts",
};

const isTest = (file: string) => /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file);

/** Every file under `apps/web/src/app`, relative to it, tests excluded. */
function appFiles() {
  return readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      `${entry.parentPath}/${entry.name}`.slice(app.length).replace(/^\//u, ""),
    )
    .filter((file) => !isTest(file))
    .sort();
}

/** The URL pattern Next derives from a file's folder, or null when it is not routable. */
function patternOf(file: string) {
  const segments: string[] = [];
  for (const segment of file.split("/").slice(0, -1)) {
    if (/^\(.*\)$/u.test(segment) || segment.startsWith("@")) continue;
    if (segment.startsWith("_")) return null;
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** Concrete paths a pattern matches: every dynamic segment filled, an optional catch-all also empty. */
function samplesOf(pattern: string) {
  const filled = pattern
    .split("/")
    .map((segment) =>
      /^\[\[\.\.\..+\]\]$/u.test(segment) || /^\[\.\.\..+\]$/u.test(segment)
        ? "a/b"
        : /^\[.+\]$/u.test(segment)
          ? "x1"
          : segment,
    )
    .join("/");
  const samples = [filled];
  if (/\/\[\[\.\.\..+\]\]$/u.test(pattern)) {
    samples.push(pattern.replace(/\/\[\[\.\.\..+\]\]$/u, "") || "/");
  }
  return samples;
}

/** The part of a pattern before its first dynamic segment. */
const staticPart = (pattern: string) => pattern.replace(/\/\[.*$/u, "") || "/";

type Failure = { file: string; rule: string; problem: string };

/**
 * The rule over a set of files (relative to `apps/web/src/app`), against a
 * table and the map of what each entry serves.
 */
function judge(
  files: readonly string[],
  table: readonly RouteEntry[] = ROUTE_TABLE,
) {
  const failures: Failure[] = [];
  const routes = files.filter((file) =>
    /(^|\/)route\.(ts|tsx|js)$/u.test(file),
  );
  const served = { host: [] as string[], fallback: [] as string[] };
  for (const file of routes) {
    const pattern = patternOf(file);
    if (pattern === null) continue;
    const underFamily =
      isUnderFamily(staticPart(pattern)) || isUnderFamily(pattern);
    const entries = table.filter((entry) => servedBy[entry.name] === file);
    const named = FALLBACK_UNDER_FAMILY.some(
      (note) => note.pattern === pattern,
    );
    if (entries.length > 1) {
      failures.push({
        file,
        rule: "completeness",
        problem: "served by more than one entry",
      });
    }
    let wanted: string | null;
    if (entries.length === 1) {
      wanted = file;
      served.host.push(file);
    } else if (named || !underFamily) {
      wanted = null;
      served.fallback.push(file);
    } else {
      failures.push({
        file,
        rule: "completeness",
        problem: `${pattern} is under a family, and neither an entry serves it nor FALLBACK_UNDER_FAMILY names it`,
      });
      wanted = null;
    }
    for (const sample of samplesOf(pattern)) {
      const entry = matchRoute(sample, table);
      const reached = entry ? servedBy[entry.name] : null;
      if (reached !== wanted) {
        failures.push({
          file,
          rule: "precedence",
          problem: `${sample} reaches ${reached ?? "the fallback"}, not ${wanted ?? "the fallback"}`,
        });
      }
    }
  }
  for (const entry of table) {
    if (!routes.includes(servedBy[entry.name])) {
      failures.push({
        file: servedBy[entry.name],
        rule: "table",
        problem: `${entry.name} serves a route file that does not exist`,
      });
    }
  }
  return { failures, served };
}

describe("the route table against apps/web/src/app", () => {
  const files = appFiles();

  test("holds H.0b's ten entries, in order", () => {
    expect(
      ROUTE_TABLE.map((entry) => [
        ...entry.exact,
        ...(entry.prefix ? [`${entry.prefix}*`] : []),
      ]),
    ).toEqual([
      ["/api/auth/*"],
      ["/.well-known/oauth-authorization-server"],
      ["/.well-known/openid-configuration"],
      ["/.well-known/oauth-protected-resource/api/v1"],
      ["/.well-known/oauth-protected-resource/mcp"],
      ["/api/v1/imports/artifacts"],
      ["/api/v1", "/api/v1/*"],
      ["/mcp"],
      ["/api/health/live"],
      ["/api/health/ready"],
    ]);
    expect(FALLBACK_UNDER_FAMILY.map((note) => note.pattern)).toEqual([
      "/.well-known/security.txt",
    ]);
  });

  test("every route.ts is complete and reached first by its own entry", () => {
    const { failures, served } = judge(files);
    expect(failures).toEqual([]);
    expect(served.host).toHaveLength(10);
    // Next serves 21 routes: the ten above, and eleven that are the
    // fallback's: ten outside every family (at 29a3aac6), and J.4's
    // security.txt, which FALLBACK_UNDER_FAMILY names.
    expect(served.fallback).toContain(".well-known/security.txt/route.ts");
    expect(served.host.length + served.fallback.length).toBe(21);
  });

  test("no page or metadata file lies under a family, where the host would shadow it", () => {
    const shadowed = files.filter((file) => {
      if (
        !/(^|\/)(page\.(ts|tsx|js|jsx|mdx)|(sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.[a-z]+)$/u.test(
          file,
        )
      ) {
        return false;
      }
      const pattern = patternOf(file);
      return pattern !== null && isUnderFamily(pattern);
    });
    expect(shadowed).toEqual([]);
  });

  test("/api/v1/imports/artifacts reaches the artifact import, not REST", () => {
    expect(matchRoute("/api/v1/imports/artifacts")?.name).toBe(
      "artifact-import",
    );
    expect(matchRoute("/api/v1/imports/other")?.name).toBe("rest");
    expect(matchRoute("/api/v1")?.name).toBe("rest");
    expect(matchRoute("/api/auth")).toBeUndefined();
    expect(matchRoute("/mcp/x")).toBeUndefined();
  });
});

describe("the rule refuses what it should (H.0b's self-test)", () => {
  const files = appFiles();

  test.each([
    ["api/v1/new-thing/route.ts", "a route under REST's catch-all"],
    ["api/auth/nested/deeper/route.ts", "a route under Better Auth's"],
    [
      ".well-known/change-password/route.ts",
      "a discovery document nobody mapped",
    ],
    ["mcp/[session]/route.ts", "a dynamic route under /mcp"],
    ["api/health/(group)/deep/route.ts", "a route in a group under health"],
  ])("refuses %s (%s)", (added) => {
    const own = judge([...files, added]).failures.filter(
      (failure) => failure.file === added,
    );
    expect(own.length).toBeGreaterThan(0);
  });

  test("accepts a route outside every family", () => {
    const added = "api/other-thing/route.ts";
    expect(
      judge([...files, added]).failures.filter(
        (failure) => failure.file === added,
      ),
    ).toEqual([]);
  });

  test("refuses the table without the artifact import's entry", () => {
    const table = ROUTE_TABLE.filter(
      (entry) => entry.name !== "artifact-import",
    );
    expect(judge(files, table).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "api/v1/imports/artifacts/route.ts",
          rule: "completeness",
        }),
        expect.objectContaining({
          file: "api/v1/imports/artifacts/route.ts",
          rule: "precedence",
          problem:
            "/api/v1/imports/artifacts reaches api/v1/[[...path]]/route.ts, not the fallback",
        }),
      ]),
    );
  });
});

/** A GET through the adapter, as a client naming the public URL's host sends it. */
function get(host: RunningHost, path: string) {
  const { port } = new URL(host.url);
  return new Promise<{ status: number; location: string | undefined }>(
    (resolve, reject) => {
      httpRequest(
        {
          host: "127.0.0.1",
          port: Number(port),
          path,
          headers: { host: "requestport.test" },
          agent: false,
        },
        (response) => {
          response.resume();
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              location: response.headers.location,
            }),
          );
        },
      )
        .on("error", reject)
        .end();
    },
  );
}

describe("a trailing slash never reaches the table (ruling 143)", () => {
  test("the adapter answers the trailing-slash form of every exact entry with a 308 to the entry, its query kept", async () => {
    const exactPaths = ROUTE_TABLE.flatMap((entry) => entry.exact);
    // What a path would have reached, had the adapter handed it on.
    const reached: Array<{ path: string; entry: string }> = [];
    const host = await listen(
      async (request) => {
        const { pathname } = new URL(request.url);
        reached.push({
          path: pathname,
          entry: matchRoute(pathname)?.name ?? "the fallback",
        });
        return new Response(null, { status: 204 });
      },
      { host: "127.0.0.1", port: 0, publicUrl: "http://requestport.test" },
    );
    try {
      const answers = [];
      for (const path of exactPaths) {
        answers.push({ path, ...(await get(host, `${path}/?sample=1`)) });
      }
      expect(reached).toEqual([]);
      expect(answers).toEqual(
        exactPaths.map((path) => ({
          path,
          status: 308,
          location: `http://requestport.test${path}?sample=1`,
        })),
      );
    } finally {
      await host.close();
    }
  });
});
