import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseAst } from "vitest/node";

import { humanScopes } from "./command-bus.js";

/*
 * Core's published types (Plan 13, G.7a; rulings 142 and 144). A consumer of
 * the published package sees core's declarations, not its source, so a
 * declaration `.` publishes may name only types the consumer can name too.
 *
 * The repository's own `tsc` emits core's declarations, as its build would,
 * into a temporary directory: core's `tsconfig.json` with
 * `emitDeclarationOnly`, over `src/**` without the tests. Vitest's
 * `parseAst` reads each emitted file, and the walk below starts from names an
 * entry exports. From each declaration it reaches it follows every name the
 * declaration gives in a type position, in `typeof`, in an `extends` or
 * `implements` clause, or through `import("…").X`: through the file's own
 * declarations, its imports and re-exports, and `export *`. A name another
 * package declares is recorded, not followed. A name the file neither
 * declares nor imports is a global, TypeScript's or Node's, and is neither;
 * so is a name the declaration itself binds as a type parameter or a mapped
 * type's key (anywhere in that declaration).
 *
 * What it holds:
 * - every declaration the walk from each published entry's names reaches
 *   that its module exports is exported by a published entry (`published`,
 *   below): `.`, `./adapters` (ruling 193 item 1, which publishes it because
 *   `@requestport/server` imports it; ruling 144 had left it out),
 *   `./agent-services` (ruling 144) or `./migrate` (G.7). The walk starts
 *   from every published entry's names, `./agent-services`' among them
 *   (ruling 146);
 * - a declaration its module does not export is walked through, and need not
 *   be exported, when it is a type alias (ruling 144);
 * - the names each entry's walk reaches in other packages are pinned, by
 *   entry. A name an entry re-exports from another package is one of them;
 * - `.` exports §2.1's API as ruling 140 amends it, the names its
 *   declarations reach that no other published entry exports, the names it
 *   re-exports from `@requestport/db` (`reexported`, below), and nothing else
 *   (rulings 142, 146, 150 and 151). The other names the repository's web
 *   imports are on `./adapters`; the web's typecheck holds that, not this
 *   file;
 * - rulings 139, 150 and 151, from Done when 12's reading under S1
 *   (manifest-g.md §7; under S8, where `@requestport/db` is built as its own
 *   package, `db`'s `index.test.ts` pins Done when 12 of `db`'s entries):
 *   the published entries re-export `createStorage`, `Storage`,
 *   `StorageOptions` and `DatabaseDriver` from `@requestport/db`, and
 *   `migrate` and `MigrationReport` from `@requestport/db/migrate`; `migrate`
 *   is on `./migrate` alone, which exports those two and nothing else; `.`
 *   re-exports the role guard's `createDatabaseRoleGuard`,
 *   `DatabaseSurfaceError`, `DatabaseRoleGuard` and `RoleGuardOptions` from
 *   `@requestport/db`, and `createWorkerStorages` and `WorkerStorages`, which
 *   `RequestPortBackground`'s `postgres` kind takes (ruling 151); and no
 *   published entry exports `storageOptionsFromEnv`;
 * - ruling 230 item 3: no published entry exports `personCommandContext`,
 *   the builder of a person's command context. The manifest's one
 *   unpublished entry, `./person-context`, exports it and nothing else, for
 *   the repository's web;
 * - ruling 230 item 3 again, over core's README (`packages/core/README.md`,
 *   which says how a consumer builds that context by hand): each name its
 *   TypeScript blocks import from core, each of core's specifiers it names,
 *   and the human scopes it writes out. The README's code is not compiled
 *   here.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The entries whose names are published (ruling 144; `./migrate`, G.7;
 * `./adapters`, ruling 193 item 1).
 */
const published = [".", "./adapters", "./agent-services", "./migrate"];
/**
 * In the source manifest and not published: `./person-context`, which holds
 * `personCommandContext` for the repository's web (ruling 230 item 3).
 * `./adapters` was the one before it, until ruling 193 item 1 published it.
 */
const unpublished = ["./person-context"];

/**
 * §2.1's API as ruling 140 amends it (ruling 142): `createRequestPort`, the
 * `RequestPort` it returns, with its thirteen members (`start`, ruling 158
 * item 5, the thirteenth), `CapabilityCall`, and the option types
 * (`options.ts`), `RequestPortOptions` with `backgroundPort` among them.
 */
const api = [
  "CapabilityCall",
  "CreateAgentApiKey",
  "createRequestPort",
  "LocalCredentialSignIn",
  "PersonSession",
  "RequestPort",
  "RequestPortBackground",
  "RequestPortBetterAuth",
  "RequestPortKey",
  "RequestPortKeyRing",
  "RequestPortLogger",
  "RequestPortOptions",
  "RequestPortSecrets",
];

/**
 * What core's published entries re-export from `@requestport/db`, by entry,
 * with the specifier each name is re-exported from:
 * - rulings 139 and 150, from Done when 12's reading under S1
 *   (manifest-g.md §7), which core's re-exports keep under S8:
 *   `createStorage`, `Storage`, `StorageOptions` and `DatabaseDriver` on `.`;
 *   `migrate` on `./migrate` only, so that importing `.` does not load the
 *   migrator (`import.test.ts`); and `MigrationReport` on both, because
 *   `RequestPort.migrate` returns it;
 * - the role guard (ruling 150): `createDatabaseRoleGuard`,
 *   `DatabaseSurfaceError`, `DatabaseRoleGuard` and `RoleGuardOptions` on
 *   `.`, because `RequestPortOptions.ownerStorage` (`options.ts`) tells a
 *   caller to build that storage's guard with `createDatabaseRoleGuard`;
 * - the worker storages (ruling 151): `createWorkerStorages` and
 *   `WorkerStorages` on `.`, because `RequestPortBackground`'s `postgres`
 *   kind (`options.ts`) takes the worker storages a caller builds with
 *   `createWorkerStorages`.
 */
const reexported: Record<string, Record<string, string>> = {
  ".": {
    createDatabaseRoleGuard: "@requestport/db",
    createStorage: "@requestport/db",
    createWorkerStorages: "@requestport/db",
    DatabaseDriver: "@requestport/db",
    DatabaseRoleGuard: "@requestport/db",
    DatabaseSurfaceError: "@requestport/db",
    MigrationReport: "@requestport/db/migrate",
    RoleGuardOptions: "@requestport/db",
    Storage: "@requestport/db",
    StorageOptions: "@requestport/db",
    WorkerStorages: "@requestport/db",
  },
  "./migrate": {
    MigrationReport: "@requestport/db/migrate",
    migrate: "@requestport/db/migrate",
  },
};

describe("core's published declarations", () => {
  let root = "";
  let emitted: { readonly status: number | null; readonly output: string };
  let modules: Modules;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "requestport-core-declarations-"));
    const config = join(root, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        extends: join(packageRoot, "tsconfig.json"),
        compilerOptions: {
          declaration: true,
          emitDeclarationOnly: true,
          outDir: join(root, "out"),
          rootDir: join(packageRoot, "src"),
          typeRoots: [join(repositoryRoot, "node_modules", "@types")],
        },
        include: [join(packageRoot, "src", "**", "*.ts")],
        exclude: [join(packageRoot, "src", "**", "*.test.ts")],
      }),
    );
    const tsc = join(
      dirname(
        createRequire(import.meta.url).resolve("typescript/package.json"),
      ),
      "bin",
      "tsc",
    );
    const run = spawnSync(process.execPath, [tsc, "-p", config], {
      encoding: "utf8",
    });
    emitted = { status: run.status, output: `${run.stdout}${run.stderr}` };
    modules = readModules(join(root, "out"));
  }, 60_000);

  afterAll(() => {
    if (root !== "") rmSync(root, { force: true, recursive: true });
  });

  test("every declaration the walk from each published entry's names reaches is exported by a published entry, or is a type alias local to its module, and the names each entry's walk reaches in other packages are pinned, by entry (rulings 142, 144, 146; ruling 193 item 1)", () => {
    expect(emitted).toEqual({ status: 0, output: "" });
    const publishedBy = publishedSites(modules);
    const walks = published.map((entry) => {
      const module = entryModule(entry);
      return {
        entry,
        walked: walk(modules, module, [...exportNames(modules, module)]),
      };
    });

    expect
      .soft(
        walks
          .flatMap(({ entry, walked }) =>
            walked.reached
              .filter(
                (site) => site.exported && !publishedBy.has(siteKey(site)),
              )
              .map(
                (site) =>
                  `${site.name} (${site.module}.ts), named by ${site.via}, from ${entry}`,
              ),
          )
          .sort(),
      )
      .toEqual([]);
    // Every entry the manifest exports is one of the two kinds above.
    expect
      .soft(Object.keys(manifest().exports).sort())
      .toEqual([...published, ...unpublished].sort());
    expect
      .soft(
        walks.flatMap(({ entry, walked }) =>
          walked.reached
            .filter(
              (site) =>
                !site.exported &&
                !moduleOf(modules, site.module)
                  .declarations.get(site.name)
                  ?.every((node) => node.type === "TSTypeAliasDeclaration"),
            )
            .map((site) => `${site.name} (${site.module}.ts), from ${entry}`),
        ),
      )
      .toEqual([]);
    expect
      .soft(
        Object.fromEntries(
          walks.map(({ entry, walked }) => [entry, walked.foreign]),
        ),
      )
      .toEqual({
        ".": {
          "@requestport/db": [
            "AgentCredentialSummary",
            "AgentQueryContext",
            "Database",
            "DatabaseDriver",
            "DatabaseRoleGuard",
            "DatabaseSurfaceError",
            "RoleGuardOptions",
            "Storage",
            "StorageOptions",
            "WorkerStorages",
            "createAgentAuthRepository",
            "createAgentQueryRepository",
            "createAgentRepository",
            "createCommandAuthorizationRepository",
            "createDatabaseRoleGuard",
            "createImportRepository",
            "createImportReviewCommandRepository",
            "createSlackRepository",
            "createStorage",
            "createWorkerStorages",
          ],
          "@requestport/db/migrate": ["MigrationReport"],
          "@requestport/domain": [
            "AgentAdministrationHandlerName",
            "AtomicCommandBus",
            "AuthorizedCommandContext",
            "BootstrapOwnerInput",
            "BootstrapOwnerResult",
            "Capability",
            "CommandMeta",
            "CredentialKind",
            "DomainEvent",
            "EnvelopeEncryption",
            "MetricSink",
            "ProjectRecord",
            "ProjectRepositoryRecord",
            "ProjectService",
            "TransactionManager",
          ],
          "@requestport/jobs/dispatch": [
            "JobDispatchDependencies",
            "StartTriggerTask",
          ],
          "@requestport/webhooks": ["createWebhookManagementService"],
        },
        "./adapters": {
          "@requestport/db": [
            "AgentQueryContext",
            "CommandPortFactory",
            "Database",
            "createAgentQueryRepository",
            "createProjectRegistrationRepository",
          ],
          "@requestport/domain": [
            "AdministrationReadName",
            "AgentAdministrationHandlerName",
            "AuthorizedCommandContext",
            "CommandMeta",
            "CredentialKind",
            "EnvelopeEncryption",
            "QueryCapability",
          ],
        },
        "./agent-services": {
          "@requestport/db": [
            "AgentCredentialSummary",
            "createAgentAuthRepository",
            "createAgentRepository",
            "createCommandAuthorizationRepository",
          ],
          "@requestport/domain": [
            "AgentRepository",
            "AuthorizedCommandContext",
          ],
        },
        "./migrate": {
          "@requestport/db/migrate": ["MigrationReport", "migrate"],
        },
      });
  });

  test("`.` exports §2.1's API as ruling 140 amends it, the names its declarations reach that no other published entry exports, and the names it re-exports from @requestport/db, Done when 12's, the role guard's and the worker storages', and nothing else (rulings 142, 146, 150, 151)", () => {
    expect(emitted).toEqual({ status: 0, output: "" });
    const publishedBy = publishedSites(modules);
    const walked = walk(modules, "index", api);
    const expected = new Set([...api, ...Object.keys(reexported["."] ?? {})]);
    for (const site of walked.reached) {
      const entries = publishedBy.get(siteKey(site)) ?? [];
      if (site.exported && !entries.some((entry) => entry !== "."))
        expected.add(site.name);
    }

    expect([...exportNames(modules, "index")].sort()).toEqual(
      [...expected].sort(),
    );
  });

  test("Done when 12, the role guard and the worker storages: the published entries re-export createStorage, Storage, StorageOptions and DatabaseDriver from @requestport/db, and migrate and MigrationReport from @requestport/db/migrate, migrate on ./migrate alone, which exports those two and nothing else, and . re-exports createDatabaseRoleGuard, DatabaseSurfaceError, DatabaseRoleGuard and RoleGuardOptions, and createWorkerStorages and WorkerStorages, from @requestport/db (rulings 139, 150, 151)", () => {
    expect(emitted).toEqual({ status: 0, output: "" });
    /** Where `entry` takes `name` from: the package, when it re-exports it. */
    const sourceOf = (entry: string, name: string) => {
      if (!entryNames(modules, entry).has(name))
        return `not exported by ${entry}`;
      const site = exported(modules, entryModule(entry), name);
      if (site.kind === "foreign" && site.name === name) return site.source;
      return `${site.kind === "core" ? `${site.module}.ts` : site.kind}#${site.name}`;
    };

    expect(
      Object.fromEntries(
        Object.entries(reexported).map(([entry, names]) => [
          entry,
          Object.fromEntries(
            Object.keys(names).map((name) => [name, sourceOf(entry, name)]),
          ),
        ]),
      ),
    ).toEqual(reexported);
    // Done when 12's six names, as it lists them, each on a published entry.
    expect(
      [
        "createStorage",
        "Storage",
        "StorageOptions",
        "DatabaseDriver",
        "migrate",
        "MigrationReport",
      ].filter(
        (name) =>
          !published.some((entry) => entryNames(modules, entry).has(name)),
      ),
    ).toEqual([]);
    expect(
      published.filter((entry) => entryNames(modules, entry).has("migrate")),
    ).toEqual(["./migrate"]);
    expect([...entryNames(modules, "./migrate")].sort()).toEqual(
      Object.keys(reexported["./migrate"] ?? {}).sort(),
    );
  });

  test("no published entry exports storageOptionsFromEnv (Done when 12)", () => {
    expect(emitted).toEqual({ status: 0, output: "" });

    expect(
      published.filter((entry) =>
        entryNames(modules, entry).has("storageOptionsFromEnv"),
      ),
    ).toEqual([]);
  });

  test("no published entry exports personCommandContext, and ./person-context, which is not published, exports it and nothing else: the builder execute runs (ruling 230 item 3)", () => {
    expect(emitted).toEqual({ status: 0, output: "" });

    expect(
      published.filter((entry) =>
        entryNames(modules, entry).has("personCommandContext"),
      ),
    ).toEqual([]);
    expect([...entryNames(modules, "./person-context")]).toEqual([
      "personCommandContext",
    ]);
    expect(
      exported(
        modules,
        entryModule("./person-context"),
        "personCommandContext",
      ),
    ).toEqual({
      kind: "core",
      module: "command-bus",
      name: "personCommandContext",
    });
  });

  test("core's README imports from core only names a published entry exports, names no specifier of core but a published entry's, and writes out the human scopes execute gives a person, humanScopes, in its order (ruling 230 item 3)", () => {
    expect(emitted).toEqual({ status: 0, output: "" });
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const code = [...readme.matchAll(/```ts\n([\s\S]*?)```/gu)].map(
      ([, block]) => block ?? "",
    );
    const entryOf = (specifier: string) =>
      specifier === "@requestport/core"
        ? "."
        : `./${specifier.slice("@requestport/core/".length)}`;
    const imports = code.flatMap((block) =>
      [
        ...block.matchAll(
          /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@requestport\/core(?:\/[\w-]+)?)"/gu,
        ),
      ].map(([, names = "", specifier = ""]) => ({
        entry: entryOf(specifier),
        names: names
          .split(",")
          .map((name) => name.trim().replace(/^type\s+/u, ""))
          .filter((name) => name !== ""),
      })),
    );

    // Not vacuous: the README imports from core.
    expect(imports.length).toBeGreaterThan(0);
    expect(
      imports.flatMap(({ entry, names }) =>
        published.includes(entry)
          ? names
              .filter((name) => !entryNames(modules, entry).has(name))
              .map((name) => `${name} from ${entry}`)
          : [`${entry}, which is not published`],
      ),
    ).toEqual([]);
    expect(
      [
        ...new Set(
          [...readme.matchAll(/@requestport\/core(?:\/[\w-]+)?/gu)].map(
            ([specifier]) => entryOf(specifier),
          ),
        ),
      ].filter((entry) => !published.includes(entry)),
    ).toEqual([]);
    const scopes = code
      .map((block) => block.match(/const HUMAN_SCOPES\b[^=]*=\s*\[([^\]]*)\]/u))
      .filter((match) => match !== null)
      .map(([, list = ""]) =>
        [...list.matchAll(/"([^"]+)"/gu)].map(([, scope]) => scope),
      );
    expect(scopes).toEqual([[...humanScopes]]);
  });
});

function manifest(): { exports: Record<string, string> } {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

/** The module an entry of the manifest's `exports` names, as `readModules` keys it. */
function entryModule(entry: string) {
  const target = manifest().exports[entry];
  if (target === undefined) throw new Error(`no entry ${entry}`);
  return target.replace(/^\.\/src\//u, "").replace(/\.ts$/u, "");
}

/** Every name an entry of the manifest's `exports` exports; none if it has no such entry. */
function entryNames(modules: Modules, entry: string): Set<string> {
  return manifest().exports[entry] === undefined
    ? new Set()
    : exportNames(modules, entryModule(entry));
}

/* A loose view of the ESTree that `parseAst` returns. */
type AstNode = { type: string; start: number; end: number } & Record<
  string,
  unknown
>;

type Module = {
  /** By local name: the specifier and the name it imports (`*` for a namespace). */
  imports: Map<string, { source: string; name: string }>;
  /** By name: every declaration the module makes of it. */
  declarations: Map<string, AstNode[]>;
  /** The names the module declares with `export`. */
  exportedDeclarations: Set<string>;
  /** By exported name: the specifier, if any, and the name it stands for. */
  exportSpecifiers: Map<string, { source?: string; name: string }>;
  /** The specifiers of its `export *`. */
  stars: string[];
};
type Modules = Map<string, Module>;

type Site =
  | { kind: "core"; module: string; name: string }
  | { kind: "foreign"; source: string; name: string }
  | { kind: "global"; name: string };

type Reached = {
  module: string;
  name: string;
  /** Whether its module exports it. */
  exported: boolean;
  via: string;
};

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function children(node: AstNode): AstNode[] {
  return Object.values(node).flatMap((value) =>
    (Array.isArray(value) ? value : [value]).filter(isNode),
  );
}

function nameOf(node: unknown): string {
  if (!isNode(node)) throw new Error("not a node");
  if (typeof node.name === "string") return node.name;
  if (typeof node.value === "string") return node.value;
  throw new Error(`no name on ${node.type}`);
}

/** Every `.d.ts` under `directory`, by its path from there without `.d.ts`. */
function readModules(directory: string): Modules {
  const modules: Modules = new Map();
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".d.ts"))
    .sort();
  for (const file of files) {
    const program = parseAst(readFileSync(join(directory, file), "utf8"), {
      lang: "dts",
    }) as unknown as AstNode;
    const module: Module = {
      imports: new Map(),
      declarations: new Map(),
      exportedDeclarations: new Set(),
      exportSpecifiers: new Map(),
      stars: [],
    };
    const declare = (node: AstNode, exported: boolean) => {
      const names =
        node.type === "VariableDeclaration"
          ? (node.declarations as AstNode[]).map((declarator) =>
              nameOf(declarator.id),
            )
          : [nameOf(node.id)];
      for (const name of names) {
        module.declarations.set(name, [
          ...(module.declarations.get(name) ?? []),
          node,
        ]);
        if (exported) module.exportedDeclarations.add(name);
      }
    };
    for (const node of program.body as AstNode[]) {
      const source = isNode(node.source) ? nameOf(node.source) : undefined;
      if (node.type === "ImportDeclaration" && source !== undefined) {
        for (const specifier of node.specifiers as AstNode[])
          module.imports.set(nameOf(specifier.local), {
            source,
            name:
              specifier.type === "ImportSpecifier"
                ? nameOf(specifier.imported)
                : specifier.type === "ImportNamespaceSpecifier"
                  ? "*"
                  : "default",
          });
      } else if (node.type === "ExportNamedDeclaration") {
        if (isNode(node.declaration)) declare(node.declaration, true);
        for (const specifier of node.specifiers as AstNode[])
          module.exportSpecifiers.set(nameOf(specifier.exported), {
            source,
            name: nameOf(specifier.local),
          });
      } else if (node.type === "ExportAllDeclaration" && source !== undefined) {
        if (isNode(node.exported))
          module.exportSpecifiers.set(nameOf(node.exported), {
            source,
            name: "*",
          });
        else module.stars.push(source);
      } else if (
        [
          "VariableDeclaration",
          "TSDeclareFunction",
          "FunctionDeclaration",
          "ClassDeclaration",
          "TSInterfaceDeclaration",
          "TSTypeAliasDeclaration",
          "TSEnumDeclaration",
        ].includes(node.type)
      ) {
        declare(node, false);
      } else {
        throw new Error(`${file}: a ${node.type} is not read here`);
      }
    }
    modules.set(file.slice(0, -".d.ts".length).split(sep).join("/"), module);
  }
  return modules;
}

function moduleOf(modules: Modules, key: string): Module {
  const module = modules.get(key);
  if (module === undefined) throw new Error(`no declarations for ${key}`);
  return module;
}

function target(from: string, specifier: string) {
  return posix.normalize(
    posix.join(posix.dirname(from), specifier.replace(/\.js$/u, "")),
  );
}

/** What `name` stands for where `module` writes it. */
function local(modules: Modules, module: string, name: string): Site {
  const own = moduleOf(modules, module);
  if (own.declarations.has(name)) return { kind: "core", module, name };
  const imported = own.imports.get(name);
  if (imported === undefined) return { kind: "global", name };
  if (imported.name === "*")
    throw new Error(`${module}: the namespace ${name} is not walked`);
  return exportedFrom(modules, module, imported.source, imported.name);
}

/** What the module `specifier` names from `from` exports as `name`. */
function exportedFrom(
  modules: Modules,
  from: string,
  specifier: string,
  name: string,
): Site {
  if (!specifier.startsWith("."))
    return { kind: "foreign", source: specifier, name };
  return exported(modules, target(from, specifier), name);
}

/** What `module` exports as `name`. */
function exported(modules: Modules, module: string, name: string): Site {
  const own = moduleOf(modules, module);
  const specified = own.exportSpecifiers.get(name);
  if (specified !== undefined) {
    if (specified.name === "*")
      throw new Error(`${module}: the namespace ${name} is not walked`);
    return specified.source === undefined
      ? local(modules, module, specified.name)
      : exportedFrom(modules, module, specified.source, specified.name);
  }
  if (own.exportedDeclarations.has(name)) return { kind: "core", module, name };
  for (const star of own.stars) {
    if (!star.startsWith("."))
      throw new Error(`${module}: export * from ${star} is not walked`);
    if (exportNames(modules, target(module, star)).has(name))
      return exported(modules, target(module, star), name);
  }
  throw new Error(`${module} does not export ${name}`);
}

/** Every name `module` exports. */
function exportNames(modules: Modules, module: string): Set<string> {
  const own = moduleOf(modules, module);
  return new Set([
    ...own.exportedDeclarations,
    ...own.exportSpecifiers.keys(),
    ...own.stars.flatMap((star) => [
      ...exportNames(modules, target(module, star)),
    ]),
  ]);
}

/** Whether `module` exports its own declaration of `name`, by any name. */
function exportsOwn(modules: Modules, module: string, name: string) {
  const own = moduleOf(modules, module);
  return (
    own.exportedDeclarations.has(name) ||
    [...own.exportSpecifiers.values()].some(
      (specified) => specified.source === undefined && specified.name === name,
    )
  );
}

function siteKey(site: { module: string; name: string }) {
  return `${site.module}#${site.name}`;
}

/** Each of core's declarations a published entry exports, with the entries. */
function publishedSites(modules: Modules) {
  const sites = new Map<string, string[]>();
  for (const entry of published) {
    const module = entryModule(entry);
    for (const name of exportNames(modules, module)) {
      const site = exported(modules, module, name);
      if (site.kind !== "core") continue;
      sites.set(siteKey(site), [...(sites.get(siteKey(site)) ?? []), entry]);
    }
  }
  return sites;
}

/**
 * The names a declaration gives (above), with the specifier of an
 * `import("…")`. A name the declaration binds as a type parameter, or as a
 * mapped type's key, is left out.
 */
function references(declaration: AstNode) {
  const bound = new Set<string>();
  const found: Array<{ name: string; source?: string }> = [];
  const leftmost = (node: unknown): string => {
    if (!isNode(node)) throw new Error("not a node");
    if (node.type === "Identifier") return nameOf(node);
    if (node.type === "TSQualifiedName") return leftmost(node.left);
    if (node.type === "MemberExpression") return leftmost(node.object);
    throw new Error(`a ${node.type} is not walked`);
  };
  const visit = (node: AstNode) => {
    if (node.type === "TSTypeParameter") bound.add(nameOf(node.name));
    if (node.type === "TSMappedType" && isNode(node.key))
      bound.add(nameOf(node.key));
    if (node.type === "TSTypeReference")
      found.push({ name: leftmost(node.typeName) });
    if (
      node.type === "TSTypeQuery" &&
      isNode(node.exprName) &&
      node.exprName.type !== "TSImportType"
    )
      found.push({ name: leftmost(node.exprName) });
    if (
      node.type === "TSInterfaceHeritage" ||
      node.type === "TSClassImplements"
    )
      found.push({ name: leftmost(node.expression) });
    if (node.type === "ClassDeclaration" && isNode(node.superClass))
      found.push({ name: leftmost(node.superClass) });
    if (node.type === "TSImportType") {
      const argument = node.source ?? node.argument;
      const specifier = isNode(argument)
        ? isNode(argument.literal)
          ? nameOf(argument.literal)
          : nameOf(argument)
        : undefined;
      if (specifier === undefined || !isNode(node.qualifier))
        throw new Error("an import type without a specifier or a name");
      found.push({ name: leftmost(node.qualifier), source: specifier });
    }
    for (const child of children(node)) visit(child);
  };
  visit(declaration);
  return found.filter(
    (reference) => reference.source !== undefined || !bound.has(reference.name),
  );
}

/**
 * The walk from `roots`, which `module` exports: each of core's declarations
 * it reaches, with the first declaration that named it, and the names it
 * reaches in other packages, by package.
 */
function walk(modules: Modules, module: string, roots: readonly string[]) {
  const reached = new Map<string, Reached>();
  const foreign = new Map<string, Set<string>>();
  const queue: Reached[] = [];
  const reach = (site: Site, via: string) => {
    if (site.kind === "global") return;
    if (site.kind === "foreign") {
      foreign.set(
        site.source,
        new Set([...(foreign.get(site.source) ?? []), site.name]),
      );
      return;
    }
    if (reached.has(siteKey(site))) return;
    const entry = {
      module: site.module,
      name: site.name,
      exported: exportsOwn(modules, site.module, site.name),
      via,
    };
    reached.set(siteKey(site), entry);
    queue.push(entry);
  };
  for (const root of roots) reach(exported(modules, module, root), "(root)");
  for (let next = queue.shift(); next; next = queue.shift()) {
    const declarations =
      moduleOf(modules, next.module).declarations.get(next.name) ?? [];
    for (const declaration of declarations)
      for (const reference of references(declaration))
        reach(
          reference.source === undefined
            ? local(modules, next.module, reference.name)
            : exportedFrom(
                modules,
                next.module,
                reference.source,
                reference.name,
              ),
          `${next.name} (${next.module}.ts)`,
        );
  }
  return {
    reached: [...reached.values()],
    foreign: Object.fromEntries(
      [...foreign]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([source, names]) => [source, [...names].sort()]),
    ),
  };
}
