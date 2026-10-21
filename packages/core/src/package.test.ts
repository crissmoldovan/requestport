import { readdir, readFile } from "node:fs/promises";
import { expect, test } from "vitest";

async function manifest() {
  return JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
}

test("exports its entry, the agent services' subpath, the migrator's subpath, the adapters' subpath and the person context's subpath, and nothing else", async () => {
  // `./adapters` holds the names the repository's web imports that `.` does
  // not keep (Plan 13, G.7a; rulings 142 and 144), but `personCommandContext`.
  // Ruling 193 item 1 publishes it, because `@requestport/server` imports
  // it, and `published-types.test.ts` walks it as a published entry.
  // `./migrate` re-exports `@requestport/db/migrate`'s `migrate` and
  // `MigrationReport` (Done when 12 under S1; G.7, ruling 139), so that a
  // process importing `.` does not load the migrator.
  // `./person-context` holds `personCommandContext`, for the repository's
  // web, and is not published (ruling 230 item 3): `published-types.test.ts`
  // holds it out of every published entry, and `bundle.test.ts` out of
  // core's bundle.
  expect((await manifest()).exports).toEqual({
    ".": "./src/index.ts",
    "./adapters": "./src/adapters.ts",
    "./agent-services": "./src/agent-services/index.ts",
    "./migrate": "./src/migrate.ts",
    "./person-context": "./src/person-context.ts",
  });
});

// manifest-g.md §2.5.1: packages/auth depends on core, so a core → auth edge
// would close a cycle, and what core needs from Better Auth comes in as
// functions. This reads core's own declarations only, not their closure.
test("declares no dependency on @requestport/auth, Better Auth or @trigger.dev/sdk", async () => {
  const declared = await manifest();
  const names = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ].flatMap((field) => Object.keys(declared[field] ?? {}));

  expect(
    names.filter(
      (name) =>
        name === "@requestport/auth" ||
        name === "better-auth" ||
        name.startsWith("@better-auth/") ||
        name === "@trigger.dev/sdk",
    ),
  ).toEqual([]);
});

// manifest-g.md §3.3 and §3.4. Under S8 (ruling 175) core and the seven
// packages it reaches through `workspace:` dependencies are each built as
// their own package (`bundle.mjs`'s `bundles`), and a consumer installs the
// eight together, so each third-party name is declared here at one version
// across them. `scripts/pack-packages.mjs` writes each package's packed
// manifest with the versions its own source manifest declares, so this case
// is what keeps the eight tarballs naming one version of each (G.0b's
// question 4: `uuid`, which `webhooks` declared at 13.0.0 and `db` and
// `domain` at 14.0.1 until G.7a aligned it; rulings 139, 144 and 146). The
// packages are found by walking `workspace:` dependencies from core's own
// manifest, and pinned, so the check cannot pass over an empty walk.
test("the packages it reaches through workspace dependencies, itself included, declare each third-party dependency at one version", async () => {
  const packagesDirectory = new URL("../../", import.meta.url);
  const manifests = new Map<
    string,
    { directory: string; dependencies: Record<string, string> }
  >();
  for (const entry of await readdir(packagesDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const parsed = JSON.parse(
      await readFile(
        new URL(`${entry.name}/package.json`, packagesDirectory),
        "utf8",
      ).catch(() => "null"),
    );
    if (parsed === null) continue;
    manifests.set(parsed.name, {
      directory: entry.name,
      dependencies: parsed.dependencies ?? {},
    });
  }

  const carried = new Set<string>();
  const versions = new Map<string, Set<string>>();
  const queue = ["@requestport/core"];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const found = manifests.get(name);
    expect(found, name).toBeDefined();
    if (!found || carried.has(found.directory)) continue;
    carried.add(found.directory);
    for (const [dependency, version] of Object.entries(found.dependencies)) {
      if (version.startsWith("workspace:")) {
        queue.push(dependency);
        continue;
      }
      versions.set(
        dependency,
        (versions.get(dependency) ?? new Set()).add(version),
      );
    }
  }

  expect([...carried].sort()).toEqual([
    "config",
    "core",
    "db",
    "domain",
    "importer",
    "jobs",
    "notifications",
    "webhooks",
  ]);
  expect(
    Object.fromEntries(
      [...versions]
        .filter(([, declared]) => declared.size > 1)
        .map(([dependency, declared]) => [dependency, [...declared].sort()]),
    ),
  ).toEqual({});
});
