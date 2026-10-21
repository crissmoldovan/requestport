/**
 * What the web loads of this package (Plan 13, H.1).
 *
 * The web's modules import this package by narrow subpaths, never by its
 * root: `proxy.ts` reaches `./security-headers` through `lib/security/headers.ts`
 * and `./e2e-csp-fence`, the CSP's E2E fence, directly (ruling 174), and 21
 * source modules, eleven server-action modules among them, reach
 * `./rate-limit` through `lib/security/rate-limit.ts`. The root re-exports
 * the host, which imports the route table, discovery, health, the artifact
 * import, REST, the auth family's handlers, the MCP handler and the CSP's
 * E2E fence (`e2e-csp-fence.ts`, which asks `@requestport/auth/e2e`'s
 * predicate). The package declares no `sideEffects`, so a
 * bundler may keep what a root import pulls in (**inferred**, not
 * measured).
 *
 * So two things are held here, by reading the source: every import of
 * `@requestport/server` under `apps/web/src` names a subpath the package
 * exports, and each module behind a subpath the web imports loads only the
 * modules listed for it below (type-only imports aside, which compile to
 * nothing).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const webSource = fileURLToPath(
  new URL("../../../apps/web/src/", import.meta.url),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : sourceFiles(`${path}/`);
    return /\.(?:ts|tsx|mts)$/u.test(entry.name) ? [path] : [];
  });
}

/** Each module specifier a source imports or re-exports, and whether it is type-only. */
function specifiers(source: string) {
  const found: Array<{ specifier: string; typeOnly: boolean }> = [];
  for (const match of source.matchAll(
    /^(?:import|export)\s+(type\s+)?(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/gmsu,
  )) {
    found.push({ specifier: match[2] ?? "", typeOnly: Boolean(match[1]) });
  }
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu)) {
    found.push({ specifier: match[1] ?? "", typeOnly: false });
  }
  return found;
}

const exportsMap = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, string> }
).exports;

const webImports = sourceFiles(webSource).flatMap((path) =>
  specifiers(readFileSync(path, "utf8"))
    .filter(({ specifier }) => /^@requestport\/server(?:\/|$)/u.test(specifier))
    .map(({ specifier }) => ({
      file: path.slice(webSource.length),
      specifier,
    })),
);

/** What each module behind a subpath the web imports may load. */
const allowedLoads: Readonly<Record<string, readonly string[]>> = {
  "./artifact-import": [
    "@requestport/domain",
    "@requestport/importer",
    "zod",
    "./bearer-challenge.js",
    "./input-limits.js",
  ],
  "./auth": [
    "@requestport/auth/auth-handler",
    "@requestport/domain",
    "./input-limits.js",
  ],
  "./bearer-challenge": [],
  "./better-auth-errors": [],
  "./discovery": ["@requestport/domain"],
  "./e2e-csp-fence": ["@requestport/auth/e2e"],
  "./health": [],
  "./input-limits": ["@requestport/domain"],
  "./mcp": [
    "@requestport/domain",
    "@requestport/mcp",
    "./input-limits.js",
    "./unauthorized.js",
  ],
  "./project-scope": ["@requestport/domain"],
  "./rate-limit": ["node:crypto", "@requestport/domain"],
  "./rest": [
    "@requestport/core/adapters",
    "@requestport/domain",
    "zod",
    "./bearer-challenge.js",
    "./input-limits.js",
  ],
  "./security-headers": [],
  "./unauthorized": [
    "@requestport/domain",
    "./bearer-challenge.js",
    "./input-limits.js",
  ],
};

test("every import of @requestport/server under apps/web/src names a subpath the package exports, never the package's root", () => {
  expect(webImports.length).toBeGreaterThan(0);
  for (const { file, specifier } of webImports) {
    expect(specifier, file).not.toBe("@requestport/server");
    expect(Object.keys(exportsMap), `${file}: ${specifier}`).toContain(
      `.${specifier.slice("@requestport/server".length)}`,
    );
  }
});

test("each module behind a subpath the web imports loads only what is listed for it", () => {
  const subpaths = [
    ...new Set(
      webImports.map(
        ({ specifier }) => `.${specifier.slice("@requestport/server".length)}`,
      ),
    ),
  ].sort();

  expect(subpaths).toEqual(Object.keys(allowedLoads).sort());
  for (const subpath of subpaths) {
    const target = exportsMap[subpath] ?? "";
    const loads = specifiers(
      readFileSync(new URL(`../${target}`, import.meta.url), "utf8"),
    )
      .filter(({ typeOnly }) => !typeOnly)
      .map(({ specifier }) => specifier);
    expect(loads, subpath).toEqual(allowedLoads[subpath]);
  }
});
