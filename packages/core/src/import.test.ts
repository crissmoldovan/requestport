import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { HOSTED_DRIVER_PACKAGES } from "@requestport/db/testing";
import { describe, expect, test } from "vitest";

/*
 * Done when 1, core's part (manifest-g.md §7): imported in a process started
 * with an empty environment, as `env -i` starts one, `@requestport/core`
 * constructs nothing and opens nothing, no module of this repository's reads
 * a variable or installs a global, and its resolved module graph holds no
 * `@requestport/auth`, `better-auth` or `@trigger.dev/sdk` module (§2.5.1's
 * invariant, §2.4).
 *
 * The child imports each subpath core's `package.json` exports, by the
 * package's own name, and then each module core imports only when a function
 * runs: the three a `postgres` background imports when it starts
 * (`startPostgresBackground`), core's `./worker-holder.js`, which takes the
 * worker settings' holder `@requestport/jobs/worker-storages` by name,
 * `@requestport/jobs/worker` and `/catalogue`, and the migrator `migrate()`
 * imports, `@requestport/db/migrate`. Core's `./migrate` subpath re-exports
 * that migrator's `migrate` (Done when 12; G.7), so the child has loaded it by
 * then; `.` does not load it, and only reaches it through that `import(…)`.
 * So the graph read below is core's static graph and every module its
 * `import(…)` calls name, which the second case holds to core's source. The
 * worker and the catalogue reach the six `packages/jobs` modules that read
 * their label as they loaded before G.6 (§2.3), with the bodies they belong
 * to. The holder imports no root: what fills it when nothing is installed is
 * registered by `@requestport/jobs`' own module (`index.ts`), which the walk
 * below holds out of the graph (ruling 139, option (b)).
 * `process.env` is a proxy that records every read and the frame that made
 * it, as packages/db's case does (`client.test.ts`). The job bodies reach
 * `@requestport/notifications`' e-mail templates, which are TSX, so Node's
 * own type stripping cannot load them; the child loads everything through
 * tsx (`register`, from `tsx/esm/api`, resolved from packages/jobs, whose
 * dependency it is), registered before anything is recorded. tsx reports
 * each module it loads (`onImport`), which is the graph read below.
 *
 * What it asserts:
 * - the child's environment is empty, but for the one name macOS adds;
 * - no module of this repository's reads a variable: by name, by `in`, by
 *   its descriptor, or the list of names. That covers the six modules,
 *   `@requestport/config`'s logger as core reaches it (§3.1), and core's
 *   `agent-services` subpath;
 * - no symbol or name joins `globalThis` but the dependencies' pinned below,
 *   so no storage was built (`createStorage` installs its tenant-binding
 *   record, under a registered symbol, on its first call) and no root holds
 *   one; and no resource is left active: no socket, no timer, no lookup;
 * - core's own subpaths load neither the job worker nor the bodies, nor the
 *   worker settings' holder, nor the worker's root, so no
 *   `@requestport/config` module but the logger and not db's wiring module
 *   (§3.1 under S1; Done when 9);
 * - the whole graph holds the six modules, of `@requestport/config` only the
 *   logger, neither the worker's root (`worker-root.ts`), nor `jobs`' own
 *   module that registers it, nor db's wiring module, and no module of
 *   `@requestport/auth`, Better Auth or the Trigger.dev SDK.
 *
 * What the dependencies do as they load is pinned, by the import that loaded
 * them, so that a change is read. Core's subpaths: the hosted driver's package
 * (`HOSTED_DRIVER_PACKAGES`; none in the public tree) reads `USER` and
 * `NODE_PG_FORCE_NATIVE` (packages/db's case pins the same two), zod
 * installs two globals, and importing `node:http` as a module, as
 * `@requestport/webhooks` does, installs Node's own symbol for its bundled
 * HTTP client's global dispatcher. The worker, whose runner loads the
 * catalogue and so every body: React reads `NODE_ENV`, and prismjs installs a
 * global, both through the e-mail templates. A read made by Node's own code,
 * its loader's or its source-map cache's, is Node's.
 */
/**
 * The modules core imports only when one of its functions runs, by the
 * specifier each `import(…)` in its source names: `migrate()`'s migrator, and
 * the worker settings' holder (through core's own `./worker-holder.js`), the
 * job worker and the catalogue a `postgres` background starts. The child
 * imports each, after core's own subpaths, by the specifier it resolves from
 * the package's root (`imported`).
 */
const calledImports = [
  { named: "./worker-holder.js", imported: "./src/worker-holder.ts" },
  { named: "@requestport/jobs/worker", imported: "@requestport/jobs/worker" },
  {
    named: "@requestport/jobs/catalogue",
    imported: "@requestport/jobs/catalogue",
  },
  { named: "@requestport/db/migrate", imported: "@requestport/db/migrate" },
];

describe("importing @requestport/core", () => {
  test("in a process started with an empty environment, as env -i starts one, reads no variable in this repository's code, installs no global of its own, opens nothing, and loads no Better Auth or Trigger.dev module (Done when 1)", {
    timeout: 120_000,
  }, () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { name: string; exports: Record<string, string> };
    const subpaths = [
      ...Object.keys(manifest.exports).map((subpath) =>
        subpath === "."
          ? manifest.name
          : `${manifest.name}/${subpath.slice(2)}`,
      ),
      ...calledImports.map(({ imported }) => imported),
    ];
    const child = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "--eval",
        importProbe(
          join(repositoryRoot, "packages/jobs/package.json"),
          subpaths,
        ),
      ],
      {
        cwd: packageRoot,
        env: {},
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100_000,
      },
    );

    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const report = JSON.parse(child.stdout) as {
      environment: string[];
      reads: Array<{ variable: string; reader: string; importing: string }>;
      globals: Record<string, string[]>;
      symbols: Record<string, string[]>;
      resources: string[];
      loaded: Record<string, string[]>;
    };
    const repositoryReads: string[] = [];
    const dependencyReads = new Set<string>();
    const unattributed: string[] = [];
    for (const { variable, reader, importing } of report.reads) {
      const location = reader
        .replace(/^at (?:.*? \()?/u, "")
        .replace(/\)$/u, "");
      if (location.startsWith("node:")) continue;
      const file = location.replace(/:\d+:\d+$/u, "");
      const path = file.startsWith("file:")
        ? fileURLToPath(file)
        : file.startsWith("/")
          ? file
          : undefined;
      const line = location.match(/:(\d+):\d+$/u)?.[1];
      if (path === undefined) {
        unattributed.push(`${reader} reads ${variable}`);
      } else if (path.includes("/node_modules/")) {
        const [scope, name] = (path.split("/node_modules/").at(-1) ?? "").split(
          "/",
        );
        dependencyReads.add(
          `${scope?.startsWith("@") ? `${scope}/${name}` : scope} reads ${variable}, importing ${importing}`,
        );
      } else {
        repositoryReads.push(
          `${relative(repositoryRoot, path)}:${line} reads ${variable}, importing ${importing}`,
        );
      }
    }
    /** The files `subpath`'s import loaded, by their path. */
    const loadedBy = (subpath: string) => [
      ...new Set(
        (report.loaded[subpath] ?? [])
          .filter((url) => url.startsWith("file:"))
          .map((url) => fileURLToPath(url)),
      ),
    ];
    const loaded = subpaths.flatMap(loadedBy);
    const ours = (paths: readonly string[]) =>
      paths
        .filter((path) => !path.includes("/node_modules/"))
        .map((path) => relative(repositoryRoot, path));
    const coreOwn = ours(
      [
        "@requestport/core",
        "@requestport/core/adapters",
        "@requestport/core/agent-services",
        "@requestport/core/migrate",
        "@requestport/core/person-context",
      ].flatMap(loadedBy),
    );
    const forbidden = loaded.filter(
      (path) =>
        /\/node_modules\/(?:better-auth|@better-auth\/[^/]+|@trigger\.dev\/[^/]+)\//u.test(
          path,
        ) || relative(repositoryRoot, path).startsWith("packages/auth/"),
    );

    expect(subpaths).toEqual([
      "@requestport/core",
      "@requestport/core/adapters",
      "@requestport/core/agent-services",
      "@requestport/core/migrate",
      "@requestport/core/person-context",
      "./src/worker-holder.ts",
      "@requestport/jobs/worker",
      "@requestport/jobs/catalogue",
      "@requestport/db/migrate",
    ]);
    expect({
      environment: report.environment.filter(
        (name) => name !== "__CF_USER_TEXT_ENCODING",
      ),
      repositoryReads,
      dependencyReads: [...dependencyReads].sort(),
      unattributed,
      globals: report.globals,
      symbols: report.symbols,
      resources: report.resources,
      forbidden,
    }).toEqual({
      environment: [],
      repositoryReads: [],
      dependencyReads: [
        ...HOSTED_DRIVER_PACKAGES.flatMap((name) => [
          `${name} reads NODE_PG_FORCE_NATIVE, importing @requestport/core`,
          `${name} reads USER, importing @requestport/core`,
        ]),
        "react reads NODE_ENV, importing @requestport/jobs/worker",
      ],
      unattributed: [],
      globals: {
        "@requestport/core": ["__zod_globalConfig", "__zod_globalRegistry"],
        "@requestport/core/adapters": [],
        "@requestport/core/agent-services": [],
        "@requestport/core/migrate": [],
        "@requestport/core/person-context": [],
        "./src/worker-holder.ts": [],
        "@requestport/jobs/worker": ["Prism"],
        "@requestport/jobs/catalogue": [],
        "@requestport/db/migrate": [],
      },
      symbols: {
        "@requestport/core": ["Symbol(undici.globalDispatcher.1)"],
        "@requestport/core/adapters": [],
        "@requestport/core/agent-services": [],
        "@requestport/core/migrate": [],
        "@requestport/core/person-context": [],
        "./src/worker-holder.ts": [],
        "@requestport/jobs/worker": [],
        "@requestport/jobs/catalogue": [],
        "@requestport/db/migrate": [],
      },
      resources: [],
      forbidden: [],
    });
    const sixAndTheirSink = [
      "packages/jobs/src/jobs/import-analyze.ts",
      "packages/jobs/src/jobs/import-apply.ts",
      "packages/jobs/src/jobs/webhook-delivery.ts",
      "packages/jobs/src/jobs/retention-cleanup.ts",
      "packages/jobs/src/jobs/outbox-delivery.ts",
      "packages/jobs/src/observability.ts",
    ];
    expect(coreOwn).toContain("packages/core/src/agent-services/index.ts");
    // `migrate` is on `./migrate`, not on `.`: re-exported on `.`, the
    // migrator, and the hosted driver's with it, would load in every process
    // that imports core (G.7, ruling 150). `.` re-exports only its
    // `MigrationReport` type.
    expect(coreOwn).toContain("packages/db/src/migrate.ts");
    expect(ours(loadedBy("@requestport/core"))).not.toContain(
      "packages/db/src/migrate.ts",
    );
    // Statically, core reaches no module that parses the environment, nor
    // the wiring module the roots build their storages with: the holder loads
    // when a postgres background starts, and reaches neither (below).
    expect(
      coreOwn.filter(
        (path) =>
          (path.startsWith("packages/config/") &&
            path !== "packages/config/src/logger.ts") ||
          path === "packages/db/src/wiring.ts" ||
          path === "packages/jobs/src/worker-root.ts" ||
          path === "packages/jobs/src/worker-storages.ts" ||
          path === "packages/core/src/worker-holder.ts",
      ),
    ).toEqual([]);
    expect(
      coreOwn.filter(
        (path) =>
          path === "packages/jobs/src/worker.ts" ||
          sixAndTheirSink.includes(path),
      ),
    ).toEqual([]);
    expect(ours(loaded)).toEqual(expect.arrayContaining(sixAndTheirSink));
    // The whole walk, the holder and the worker included, reaches no root:
    // of `@requestport/config` only the logger, and neither the worker's
    // root, `worker-root.ts`, nor db's wiring module, nor `jobs`' own
    // module, which registers that root (ruling 139, option (b)).
    expect(
      ours(loaded)
        .filter((path) => path.startsWith("packages/config/"))
        .sort(),
    ).toEqual(["packages/config/src/logger.ts"]);
    expect(
      ours(loaded).filter(
        (path) =>
          path === "packages/jobs/src/worker-root.ts" ||
          path === "packages/jobs/src/index.ts" ||
          path === "packages/db/src/wiring.ts",
      ),
    ).toEqual([]);
  });

  test("the walk above reaches every module core imports when a function runs: each import(…) in core's source names a module the child imports, by a string literal, and core requires nothing", () => {
    const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(sourceRoot, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((path) => /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path))
      .sort();
    const named: string[] = [];
    const unnamed: string[] = [];
    const required: string[] = [];
    for (const path of sources) {
      const source = readFileSync(join(sourceRoot, path), "utf8");
      for (const call of source.matchAll(/\bimport\(\s*([^)]*?)\s*\)/gu)) {
        const literal = /^"([^"]+)"$/u.exec(call[1] ?? "");
        if (literal?.[1]) named.push(literal[1]);
        else unnamed.push(`${path}: import(${call[1]})`);
      }
      if (/\b(?:require|createRequire)\(/u.test(source)) required.push(path);
    }

    expect(sources).toContain("request-port.ts");
    expect(unnamed).toEqual([]);
    expect(required).toEqual([]);
    expect([...new Set(named)].sort()).toEqual(
      calledImports.map(({ named }) => named).sort(),
    );
  });
});

/**
 * The program the child runs (above): it registers tsx, resolved from
 * `jobsManifest`'s package, then imports each of `subpaths` in turn with
 * `process.env` replaced by a proxy that records each read with the first
 * frame below the program's own, and writes one line of JSON: the
 * environment's names when it started, the reads, and, by the import that
 * added them, the globals, the symbols and the modules tsx loaded, with the
 * resources left active at the end.
 */
function importProbe(jobsManifest: string, subpaths: readonly string[]) {
  return [
    'import { createRequire } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `const jobsRequire = createRequire(${JSON.stringify(jobsManifest)});`,
    'const { register } = await import(pathToFileURL(jobsRequire.resolve("tsx/esm/api")).href);',
    "let reported = [];",
    "register({ onImport: (url) => reported.push(url) });",
    "const environment = Object.keys(process.env);",
    "void process.stdout;",
    "void process.stderr;",
    "const before = process.getActiveResourcesInfo();",
    "const reads = [];",
    "let importing;",
    "const record = (variable) => {",
    '  const frames = new Error().stack.split("\\n").slice(1);',
    '  const reader = frames.find((frame) => !frame.includes("[eval"));',
    '  reads.push({ variable, reader: reader === undefined ? "" : reader.trim(), importing });',
    "};",
    // tsx reports each load over a message port: wait until no report has
    // arrived for three turns of the timer before anything is counted.
    "const settled = async () => {",
    "  for (let quiet = 0, seen = -1; quiet < 3; ) {",
    "    await new Promise((resolve) => setTimeout(resolve, 50));",
    "    quiet = reported.length === seen ? quiet + 1 : 0;",
    "    seen = reported.length;",
    "  }",
    "};",
    "const globals = {};",
    "const symbols = {};",
    "const loaded = {};",
    "const original = process.env;",
    "const recording = new Proxy(original, {",
    '  get(target, key, receiver) { if (typeof key === "string") record(key); return Reflect.get(target, key, receiver); },',
    '  has(target, key) { if (typeof key === "string") record(key); return Reflect.has(target, key); },',
    '  ownKeys(target) { record("(its names)"); return Reflect.ownKeys(target); },',
    '  getOwnPropertyDescriptor(target, key) { if (typeof key === "string") record(key); return Reflect.getOwnPropertyDescriptor(target, key); },',
    "});",
    `for (const subpath of ${JSON.stringify(subpaths)}) {`,
    "  const names = new Set(Object.getOwnPropertyNames(globalThis));",
    "  const own = new Set(Object.getOwnPropertySymbols(globalThis));",
    "  importing = subpath;",
    "  process.env = recording;",
    "  await import(subpath);",
    "  process.env = original;",
    "  await settled();",
    "  loaded[subpath] = reported;",
    "  reported = [];",
    "  globals[subpath] = Object.getOwnPropertyNames(globalThis).filter((name) => !names.has(name)).sort();",
    "  symbols[subpath] = Object.getOwnPropertySymbols(globalThis).filter((symbol) => !own.has(symbol)).map(String);",
    "}",
    "const resources = process.getActiveResourcesInfo();",
    "for (const resource of before) {",
    "  const at = resources.indexOf(resource);",
    "  if (at !== -1) resources.splice(at, 1);",
    "}",
    "process.stdout.write(JSON.stringify({ environment, reads, globals, symbols, resources, loaded }));",
  ].join("\n");
}
