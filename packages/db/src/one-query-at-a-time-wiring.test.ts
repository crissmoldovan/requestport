import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * The guard that fails a case issuing a query on a `pg` client while another
 * is in flight on it (X24) runs only where a Vitest configuration loads it.
 * X24's own cases import from the guard's module, which loads it for them
 * whatever the configurations say, so they would stay green if a
 * configuration dropped it, and so would every suite of a configuration that
 * dropped it. This case reads each configuration that loads it, packages/db's
 * two and, since X25 (ruling 231; ruling 232 item 2), apps/web's node
 * project, packages/core's configuration, and packages/jobs' integration
 * project and worker-role lane, and, since X25's remainder (ruling 232 item
 * 7), packages/auth's one configuration, and fails when one stops listing
 * it. Each setup file a configuration lists is resolved from that
 * configuration's directory, as Vitest resolves it, and compared with the
 * guard's path.
 */
const db = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(db, "src/test-support/one-query-at-a-time.ts");

/**
 * The setup files a configuration's `text` lists, as paths resolved from
 * `directory`, in the project named `project` when it names one: the text
 * from that project's `name` to the next `name`, or from the start of the
 * file. Comments are dropped before the paths are read, so an entry that has
 * been commented out does not count as loaded.
 */
function setupFilesIn(
  text: string,
  directory: string,
  project?: string,
): string[] {
  let scope = text;
  if (project !== undefined) {
    const named = `name: ${JSON.stringify(project)}`;
    const at = text.indexOf(named);
    expect(at, `the configuration names a project ${project}`).toBeGreaterThan(
      -1,
    );
    const next = text.indexOf("name: ", at + named.length);
    scope = text.slice(at, next === -1 ? undefined : next);
  }
  const listed = /setupFiles:\s*\[([^\]]*)\]/u.exec(scope);
  expect(listed, "the configuration lists setup files").not.toBeNull();
  const entries = (listed?.[1] ?? "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  return [...entries.matchAll(/"([^"]+)"/gu)].map(([, path]) =>
    resolve(directory, path ?? ""),
  );
}

/** The setup files the configuration file at `config` lists. */
function setupFilesOf(config: string, project?: string): string[] {
  return setupFilesIn(readFileSync(config, "utf8"), dirname(config), project);
}

/** Each configuration that loads the guard, from the repository's root. */
const CONFIGURATIONS: readonly { config: string; project?: string }[] = [
  { config: "packages/db/vitest.config.ts" },
  { config: "packages/db/vitest.application-role.config.ts" },
  { config: "apps/web/vitest.config.ts", project: "node" },
  { config: "packages/core/vitest.config.ts" },
  { config: "packages/jobs/vitest.config.ts", project: "integration" },
  { config: "packages/jobs/vitest.worker-role.config.ts" },
  { config: "packages/auth/vitest.config.ts" },
];

describe("the one-query-at-a-time guard's wiring (X24; X25)", () => {
  it.each(
    CONFIGURATIONS.map(({ config, project }) => ({
      config,
      project,
      what: project === undefined ? config : `${config}'s ${project} project`,
    })),
  )("$what loads the guard as a setup file", ({ config, project }) => {
    const path = resolve(db, "../..", config);

    expect(setupFilesOf(path, project)).toContain(GUARD);
  });
});

describe("the wiring pin's reading of a configuration", () => {
  it("does not count a commented-out guard entry as loaded", () => {
    const directory = join(db, "src");
    const guard = '"./test-support/one-query-at-a-time.ts"';

    expect(setupFilesIn(`setupFiles: [\n  ${guard},\n]`, directory)).toContain(
      GUARD,
    );
    expect(
      setupFilesIn(`setupFiles: [\n  // ${guard},\n]`, directory),
    ).not.toContain(GUARD);
    expect(
      setupFilesIn(`setupFiles: [\n  /* ${guard}, */\n]`, directory),
    ).not.toContain(GUARD);
  });
});
