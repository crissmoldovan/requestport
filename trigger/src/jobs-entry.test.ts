import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * Every task module reaches `@requestport/jobs` through the package itself,
 * never through one of its subpaths (Plan 13, G.7a; ruling 146).
 *
 * The worker's storages and settings holder fills from a worker root that
 * `@requestport/jobs`' own module registers as it loads
 * (`packages/jobs/src/index.ts`, `worker-storages.ts`). A task module that
 * imported only a subpath, such as `@requestport/jobs/catalogue` or
 * `@requestport/jobs/worker-storages`, would pass every suite here, because
 * `task-surface.test.ts` loads every task in one process through
 * `src/index.ts`. Deployed, its chunk need not load the registration, and its
 * runs would refuse with "no worker storages installed".
 */

const SOURCE = resolve(import.meta.dirname);

/** The non-test TypeScript files under `src/`. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

/** Every module specifier naming `@requestport/jobs` or a subpath of it. */
function jobsSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](@requestport\/jobs(?:\/[^"']*)?)["']/gu,
    ),
  ].map((match) => match[1] as string);
}

describe("the task modules' entry into @requestport/jobs", () => {
  test("reads a subpath, a dynamic import and a bare side-effect import", () => {
    expect(
      jobsSpecifiers(
        [
          'import { a } from "@requestport/jobs";',
          'export { b } from "@requestport/jobs/catalogue";',
          'const c = await import("@requestport/jobs/worker-storages");',
          'import "@requestport/jobs/worker";',
          'import { d } from "@requestport/jobs-other";',
        ].join("\n"),
      ),
    ).toEqual([
      "@requestport/jobs",
      "@requestport/jobs/catalogue",
      "@requestport/jobs/worker-storages",
      "@requestport/jobs/worker",
    ]);
  });

  test("is the package itself in every task module, so each loads the worker root's registration", () => {
    const found = sourceFiles(SOURCE).flatMap((path) =>
      jobsSpecifiers(readFileSync(path, "utf8")).map((specifier) => ({
        file: relative(SOURCE, path),
        specifier,
      })),
    );

    // Not an empty walk: the task modules import the package.
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.filter(({ specifier }) => specifier !== "@requestport/jobs"),
    ).toEqual([]);
  });
});
