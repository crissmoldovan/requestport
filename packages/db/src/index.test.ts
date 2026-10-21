import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, test } from "vitest";
import { parseAst } from "vitest/node";

import { HOSTED_DRIVER_PACKAGES } from "./hosted-driver.js";
import type {
  Database,
  DatabaseDriver,
  DatabaseRoleGuard,
  RoleGuardOptions,
  Storage,
  StorageOptions,
} from "./index.js";
import * as publicApi from "./index.js";
import type { MigrationReport } from "./migrate.js";

test("exposes the complete v1 repository and schema surface without client internals", () => {
  const keys = Object.keys(publicApi).sort();
  expect(keys).toEqual(
    expect.arrayContaining([
      "runIntegrityCheck",
      "createFoundationRepository",
      "createRequestRepository",
      "createRequestQueryRepository",
      "createRoutingRepository",
      "createAgentAuthRepository",
      "createAgentRepository",
      "createWorkRepository",
      "createWorkspaceRepository",
      "createCollaborationRepository",
      "createOutboxRepository",
      "createNotificationRepository",
      "createWebhookRepository",
      "createSlackRepository",
      "createImportRepository",
      "createImportTaskDispatchRepository",
      "createRetentionRepository",
      "createRetentionHoldRepository",
      "createOperationsRepository",
      "createOperatorCredentialRepository",
      "lockActiveOperatorAuthorization",
      "revokeOperatorCredentialsIssuedBy",
      "organizations",
      "projects",
      "routingRules",
      "requests",
      "questions",
      "answers",
      "messages",
      "artifacts",
      "completionReports",
      "agentPrincipals",
      "agentCredentials",
      "agentOauthGrants",
      "agentInstallations",
      "operatorCredentials",
      "machineWorkspaces",
      "workSessions",
      "workUpdates",
      "domainEvents",
      "outbox",
      "webhookSubscriptions",
      "webhookDeliveries",
      "webhookAttempts",
      "notificationIntents",
      "emailDeliveries",
      "slackInstallations",
      "slackRoutes",
      "slackUserMappings",
      "slackActionTokens",
      "slackDeliveries",
      "slackDeliveryOperations",
      "importSources",
      "sourceSnapshots",
      "sourceArtifacts",
      "importRuns",
      "importManifestEntries",
      "importConflicts",
      "legacyAliases",
      "legacyMappings",
      "importApplyReports",
      "importTaskDispatches",
      "retentionHolds",
      "retentionTombstones",
    ]),
  );
  expect(keys).not.toEqual(
    expect.arrayContaining(["pool", "client", "connectionString"]),
  );
});

/*
 * G.5 retired the process's default storage (manifest-g.md §2.8, §7 Done when
 * 2 and 12): a caller builds the storage it uses with `createStorage`, and asks
 * that storage's `transaction`, `ready()` and `close()`. So nothing the barrel
 * exports is a storage built for the caller, or a handle, a transaction, a
 * probe or a hook over one.
 */
test("exports no default storage, nor its handle, its transaction, its readiness probe or its shutdown hook (Plan 13, G.5)", () => {
  const keys = Object.keys(publicApi);

  for (const name of [
    "db",
    "defaultStorage",
    "checkDatabaseReadiness",
    "closeDatabase",
    "withTransaction",
  ]) {
    expect(keys, name).not.toContain(name);
  }
});

/*
 * E's storage contract made public (manifest-g.md §2.2, Done when 12; the
 * names are track-g.md's G.0a). Types carry no runtime key, so the type
 * names are held by the compiler, through the type-only imports above.
 */
test("exports E's storage contract and the role guard's constructor, and none of the roots' wiring", () => {
  const keys = Object.keys(publicApi);

  for (const name of [
    "createStorage",
    "createDatabaseRoleGuard",
    "DatabaseSurfaceError",
    "declareDatabaseSurface",
    "declaredDatabaseSurface",
  ]) {
    expect(keys, name).toContain(name);
  }
  for (const name of [
    "storageOptionsFromEnv",
    "applicationStorageOptionsFromEnv",
    "assertDeclaredDatabaseSurface",
    "rootStorageFromEnv",
    "applicationStorageFromEnv",
    "defaultStorage",
    "driverPoolOf",
    "storageClientOf",
    "selectDriver",
    "loadPgDriver",
    "loadPgliteDriver",
    "resetDatabaseSurfaceDeclaration",
  ]) {
    expect(keys, name).not.toContain(name);
  }

  expectTypeOf(publicApi.createStorage)
    .parameter(0)
    .toEqualTypeOf<StorageOptions>();
  expectTypeOf(publicApi.createStorage).returns.toEqualTypeOf<Storage>();
  expectTypeOf<StorageOptions["driver"]>().toEqualTypeOf<DatabaseDriver>();
  expectTypeOf<StorageOptions["guard"]>().toEqualTypeOf<
    DatabaseRoleGuard | undefined
  >();
  expectTypeOf(publicApi.createDatabaseRoleGuard)
    .parameter(0)
    .toEqualTypeOf<RoleGuardOptions | undefined>();
});

test("carries storageOptionsFromEnv and applicationStorageOptionsFromEnv only on ./wiring, the roots' subpath, and migrate on ./migrate", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, string> };

  expect(manifest.exports).toEqual({
    ".": "./src/index.ts",
    "./e2e": "./src/e2e-owner-storage.ts",
    "./migrate": "./src/migrate.ts",
    "./testing": "./src/testing.ts",
    "./wiring": "./src/wiring.ts",
  });

  const migrateApi = await import("./migrate.js");

  expect(Object.keys(migrateApi)).toContain("migrate");
  expectTypeOf(
    migrateApi.migrate,
  ).returns.resolves.toEqualTypeOf<MigrationReport>();
  for (const [subpath, api] of [
    [".", publicApi],
    ["./e2e", await import("./e2e-owner-storage.js")],
    ["./migrate", migrateApi],
    ["./testing", await import("./testing.js")],
  ] as const) {
    expect(Object.keys(api), subpath).not.toContain("storageOptionsFromEnv");
    expect(Object.keys(api), subpath).not.toContain(
      "applicationStorageOptionsFromEnv",
    );
  }
  expect(Object.keys(await import("./wiring.js")).sort()).toEqual([
    "INSTANCE_LOGIN_GROUPS",
    "INSTANCE_LOGIN_KINDS",
    "OperatorRefusalError",
    "applicationStorageFromEnv",
    "applicationStorageOptionsFromEnv",
    "assertDeclaredDatabaseSurface",
    "hostConstructionToken",
    "hostHandoffMember",
    "installHostHandoff",
    "instanceLoginNames",
    "instanceLoginUrls",
    "openOperatorSession",
    "packagedMigrationsFolder",
    "refuseUnapprovedSharedPgDatabase",
    "rootStorageFromEnv",
    "storageOptionsFromEnv",
    "withHostConstructionToken",
  ]);
});

/*
 * The E2E owner storage is test-only: the scenario hook seeds through it
 * (`e2e-owner-storage.ts`; Plan 13, I.2, D20). Its seven names, the
 * function, its type, its three refusals, and, since I.2 step 7, the variable
 * it reads the owner's URL from and the refusal without it, are on `./e2e`,
 * whose module the manifest pin above names, and the barrel imports and
 * re-exports nothing of that module (Plan 13, G, the S8 package set, slice
 * 0). The type has no run-time key, so the barrel's own source is read for
 * it.
 */
test("carries the E2E owner storage on ./e2e, and nothing of it on the barrel", async () => {
  const names = [
    "E2E_OWNER_DATABASE_URL_VARIABLE",
    "E2E_OWNER_STORAGE_REFUSED_ON_PGLITE",
    "E2E_OWNER_STORAGE_REFUSED_ON_VERCEL",
    "E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E",
    "E2E_OWNER_STORAGE_URL_UNSET",
    "createE2EOwnerStorage",
  ];

  expect(Object.keys(await import("./e2e-owner-storage.js")).sort()).toEqual(
    names,
  );
  for (const name of names) {
    expect(Object.keys(publicApi), name).not.toContain(name);
  }
  const barrel = parseAst(readFileSync(join(sourceRoot, "index.ts"), "utf8"), {
    lang: "ts",
  }) as unknown as AstNode;
  expect(
    list(barrel, "body")
      .map((node) => String(field(node, "source")?.value ?? ""))
      .filter((source) => source.includes("e2e-owner-storage")),
  ).toEqual([]);
});

test("exports createSignupEligibilityRepository, which Better Auth's factory builds over its database (manifest-g.md §2.12)", () => {
  expect(Object.keys(publicApi)).toContain("createSignupEligibilityRepository");
});

/*
 * Done when 2 (manifest-g.md §7; Plan 13, G.5): the defaults G.5 retired stay
 * retired. The barrel's half is the case above that lists `db`,
 * `defaultStorage`, `checkDatabaseReadiness`, `closeDatabase` and
 * `withTransaction`, and the case below that lists the thirty singletons. The
 * source half is the describe after it, which replaced G.3's singleton pin
 * (`tenant-scope-sweep.test.ts`, ruling 130) and took over G.4's `$client`
 * pin (`test-pool-boundary.test.ts`, rulings 131 and 133), moved to the end of
 * this file.
 */

/**
 * The thirty repository singletons the barrel exported until G.5 retired them
 * (Plan 13, G.5, S3): each built when its module loaded, by its factory called
 * with no argument, over the default storage's `db`. The names are G.3's
 * singleton pin's, which listed them.
 */
const retiredSingletons = [
  "agentAuthRepository",
  "agentManagementRepository",
  "agentQueryRepository",
  "agentRepository",
  "appearanceRepository",
  "collaborationRepository",
  "foundationQueryRepository",
  "foundationRepository",
  "importRepository",
  "importTaskDispatchRepository",
  "notificationRepository",
  "operationalMetricsRepository",
  "operationsQueryRepository",
  "outboxRepository",
  "projectRegistrationRepository",
  "projectSettingsRepository",
  "rateLimitRepository",
  "requestQueryRepository",
  "requestRepository",
  "retentionHoldRepository",
  "retentionRepository",
  "routingRepository",
  "searchRepository",
  "signupEligibilityRepository",
  "slackRepository",
  "webhookRepository",
  "workRepository",
  "workSweepRepository",
  "workspaceKeyRepository",
  "workspaceRepository",
];

test("exports none of the thirty repository singletons G.5 retired (Plan 13, G.5; Done when 2)", () => {
  const keys = Object.keys(publicApi);

  expect(retiredSingletons.filter((name) => keys.includes(name))).toEqual([]);
});

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(sourceRoot, "..", "..", "..");

// A loose view of the ESTree that `parseAst` returns.
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function field(node: AstNode | undefined, key: string): AstNode | undefined {
  const value = node?.[key];
  return isNode(value) ? value : undefined;
}

function list(node: AstNode | undefined, key: string): AstNode[] {
  const value = node?.[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** An identifier's name, or a string literal's value (an import's or export's name). */
function nameOf(node: AstNode | undefined): string | undefined {
  if (node?.type === "Identifier") return node.name as string;
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

/** A string literal's value, or an expression-free template's; else undefined. */
function writtenString(node: AstNode): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral") {
    const expressions = node.expressions as unknown[];
    const [quasi, ...others] = node.quasis as AstNode[];
    if (
      expressions.length === 0 &&
      quasi !== undefined &&
      others.length === 0
    ) {
      return (quasi.value as { cooked?: string | null }).cooked ?? undefined;
    }
  }
  return undefined;
}

/** The directories .gitignore names as generated or local, at any depth. */
const generatedDirectories = new Set([
  ".next",
  ".next-self-host",
  ".playwright-mcp",
  ".superpowers",
  ".trigger",
  ".turbo",
  ".vercel",
  ".worktrees",
  "acceptance-evidence",
  "acceptance-report",
  "coverage",
  "dist",
  "e2e-results",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const codeFile = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

function languageOf(file: string) {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  return /\.[cm]?ts$/u.test(file) ? "ts" : "js";
}

function lineOf(text: string, node: AstNode): number {
  return text.slice(0, node.start).split("\n").length;
}

/**
 * The files Done when 2's source checks read under `root`, relative to it and
 * sorted: every code file under apps/, packages/ and trigger/, packages/db's
 * own among them, that is not a test (`*.test.*`, `*.spec.*`), a declaration
 * file, the Playwright suite (apps/web/tests) or under a generated directory.
 * Test-support modules and Vitest configurations are read too: they are not
 * tests.
 */
function productModules(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const file = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        if (
          !generatedDirectories.has(entry.name) &&
          file !== "apps/web/tests"
        ) {
          walk(path);
        }
      } else if (
        entry.isFile() &&
        codeFile.test(entry.name) &&
        !/\.(?:test|spec)\.[^.]+$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        found.push(file);
      }
    }
  };
  for (const name of ["apps", "packages", "trigger"]) {
    if (existsSync(join(root, name))) walk(join(root, name));
  }
  return found.sort();
}

/**
 * What a module may not call while it loads (a call outside every function
 * body and every class's instance field): a repository factory, whose result
 * held at module scope is a singleton, and what builds a storage, a storage's
 * handle or a driver's pool, whose result held there is a default storage.
 */
const repositoryFactory = /^create[A-Z]\w*Repository$/u;
const loadTimeBuilders = new Set([
  "applicationStorageFromEnv",
  "createE2EOwnerStorage",
  "createStorage",
  "createTestStorage",
  "createWorkerStorages",
  "drizzle",
  "openE2EOwnerStorage",
  "openSession",
  "rootStorageFromEnv",
  "webStorage",
  "workerStorages",
  "workerStoragesFromRoot",
]);
/** The drivers whose classes, constructed as a module loads, would be a pool held there. */
const driverModules = new Set([
  "@electric-sql/pglite",
  ...HOSTED_DRIVER_PACKAGES,
  "pg",
]);
/** client.ts's own stand-in for PGlite's pool, which no import names. */
const driverClasses = new Set(["SingleSessionPglite"]);
/**
 * The values G.5 retired, which a default or a fallback reached: each a
 * module-scope binding, imported from client.ts or declared there.
 */
const retiredValues = new Set(["db", "defaultStorage"]);
/** What a function is given, and so may not default, nor fall back from. */
const givenNames = new Set(["database", "db", "storage"]);
/** The names packages/db no longer declares, nor exports. */
const retiredNames = new Set([
  "checkDatabaseReadiness",
  "closeDatabase",
  "db",
  "defaultStorage",
  "withTransaction",
]);

const functionNodes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const typeKeys = new Set([
  "returnType",
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
]);
const transparent = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

/** `node` without its type assertions and parentheses, and a sequence's last value. */
function bare(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (current && transparent.has(current.type)) {
    current = field(current, "expression");
  }
  if (current?.type === "SequenceExpression") {
    return bare(list(current, "expressions").at(-1));
  }
  return current;
}

/**
 * The retired value an expression reads, anywhere inside it: an identifier
 * among `names` used as a value, so not a member's name, a key, or a type.
 */
function retiredValueIn(
  node: AstNode | undefined,
  names: ReadonlySet<string>,
): string | undefined {
  let found: string | undefined;
  const visit = (current: AstNode, parent?: AstNode, key?: string) => {
    if (found !== undefined) return;
    if (
      current.type === "Identifier" &&
      names.has(current.name as string) &&
      !(
        parent?.type === "MemberExpression" &&
        key === "property" &&
        parent.computed !== true
      ) &&
      !(
        parent?.type === "Property" &&
        key === "key" &&
        parent.computed !== true &&
        parent.shorthand !== true
      )
    ) {
      found = current.name as string;
      return;
    }
    for (const childKey of Object.keys(current)) {
      if (typeKeys.has(childKey)) continue;
      const value = current[childKey];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) visit(child, current, childKey);
      }
    }
  };
  if (node) visit(node);
  return found;
}

type DefaultKind = "load" | "default" | "fallback";

interface Offence {
  kind: DefaultKind;
  line: number;
  at: string;
}

/**
 * Each retired default `text` reintroduces, by kind (Done when 2):
 * - `load`: a call to a repository factory or to one of `loadTimeBuilders`,
 *   or `new` of a driver's class, evaluated as the module loads, outside every
 *   function body and every class's instance field;
 * - `default`: a default given to a binding named `database`, `db` or
 *   `storage`, and any default whose value reads a retired value;
 * - `fallback`: `??`, `||`, `??=` or `||=` whose right reads a retired value,
 *   or whose left reads a `database`, `db` or `storage`; and a conditional
 *   with a branch that reads a retired value.
 *
 * A retired value is `db` or `defaultStorage` where the module binds that name
 * at module scope, by an import or a declaration, as each of the 33 modules
 * that reached `db` through a default, a fallback or `withTransaction`
 * imported it; a local of either name, such as a builder's own `db` in
 * client.ts, is not one. A callee is named by its
 * identifier, by its member's name, or by the name an import binds it from
 * (`import { createStorage as build }`); a driver's class by an import from
 * the driver's module, or a member of one. Not followed: a function held in a
 * variable, or wrapped by one the module defines; a call inside a function,
 * even one called as the module loads; a key computed at run time; and a
 * retired value under another name. A file that cannot be parsed is reported
 * under each kind.
 */
function retiredDefaultsIn(file: string, text: string): Offence[] {
  let program: AstNode;
  try {
    program = parseAst(text, { lang: languageOf(file) }) as unknown as AstNode;
  } catch {
    return (["load", "default", "fallback"] as const).map((kind) => ({
      kind,
      line: 0,
      at: `${file} cannot be parsed`,
    }));
  }
  const imports = new Map<string, { imported?: string; source: string }>();
  for (const statement of list(program, "body")) {
    const source = nameOf(field(statement, "source"));
    if (statement.type !== "ImportDeclaration" || source === undefined) {
      continue;
    }
    for (const specifier of list(statement, "specifiers")) {
      const local = nameOf(field(specifier, "local"));
      if (local === undefined) continue;
      imports.set(local, {
        ...(specifier.type === "ImportSpecifier"
          ? { imported: nameOf(field(specifier, "imported")) }
          : {}),
        source,
      });
    }
  }
  const retired = new Set(
    list(program, "body")
      .flatMap((statement) => {
        const declaration =
          statement.type === "ExportNamedDeclaration"
            ? field(statement, "declaration")
            : statement;
        if (declaration?.type === "VariableDeclaration") {
          return list(declaration, "declarations").flatMap((declarator) =>
            boundNames(field(declarator, "id")),
          );
        }
        return [nameOf(field(declaration, "id"))];
      })
      .concat([...imports.keys()])
      .filter(
        (name): name is string => name !== undefined && retiredValues.has(name),
      ),
  );
  const calleeName = (callee: AstNode | undefined) => {
    const node = bare(callee);
    if (node?.type === "Identifier") {
      const name = node.name as string;
      return imports.get(name)?.imported ?? name;
    }
    if (node?.type === "MemberExpression") {
      const property = field(node, "property");
      return node.computed === true
        ? property && writtenString(property)
        : nameOf(property);
    }
    return undefined;
  };
  const isDriverClass = (callee: AstNode | undefined) => {
    let node = bare(callee);
    if (node?.type === "Identifier" && driverClasses.has(node.name as string)) {
      return true;
    }
    while (node?.type === "MemberExpression")
      node = bare(field(node, "object"));
    const imported =
      node?.type === "Identifier"
        ? imports.get(node.name as string)
        : undefined;
    return imported !== undefined && driverModules.has(imported.source);
  };

  const offences: Offence[] = [];
  const report = (kind: DefaultKind, node: AstNode, what: string) => {
    const line = lineOf(text, node);
    offences.push({ kind, line, at: `${file}:${line} ${what}` });
  };
  const visit = (node: AstNode, deferred: boolean) => {
    if (!deferred && node.type === "CallExpression") {
      const name = calleeName(field(node, "callee"));
      if (
        name !== undefined &&
        (repositoryFactory.test(name) || loadTimeBuilders.has(name))
      ) {
        report("load", node, `calls \`${name}\` as it loads`);
      }
    }
    if (
      !deferred &&
      node.type === "NewExpression" &&
      isDriverClass(field(node, "callee"))
    ) {
      const callee = field(node, "callee") as AstNode;
      report(
        "load",
        node,
        `constructs \`${text.slice(callee.start, callee.end)}\` as it loads`,
      );
    }
    if (node.type === "AssignmentPattern") {
      const left = field(node, "left");
      const name =
        left?.type === "Identifier" ? (left.name as string) : undefined;
      const value = retiredValueIn(field(node, "right"), retired);
      if (value !== undefined) {
        report(
          "default",
          node,
          `defaults \`${name ?? "a pattern"}\` to a value that reads \`${value}\``,
        );
      } else if (name !== undefined && givenNames.has(name)) {
        report("default", node, `gives \`${name}\` a default`);
      }
    }
    const operator = node.operator;
    if (
      (node.type === "LogicalExpression" &&
        (operator === "??" || operator === "||")) ||
      (node.type === "AssignmentExpression" &&
        (operator === "??=" || operator === "||="))
    ) {
      const value = retiredValueIn(field(node, "right"), retired);
      const left = bare(field(node, "left"));
      const leftName =
        left?.type === "MemberExpression" && left.computed !== true
          ? nameOf(field(left, "property"))
          : nameOf(left);
      if (value !== undefined) {
        report(
          "fallback",
          node,
          `falls back to a value that reads \`${value}\``,
        );
      } else if (leftName !== undefined && givenNames.has(leftName)) {
        report("fallback", node, `falls back when \`${leftName}\` is absent`);
      }
    }
    if (node.type === "ConditionalExpression") {
      for (const branch of ["consequent", "alternate"]) {
        const value = retiredValueIn(field(node, branch), retired);
        if (value !== undefined) {
          report("fallback", node, `answers a value that reads \`${value}\``);
          break;
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (typeKeys.has(key)) continue;
      const childDeferred =
        deferred ||
        functionNodes.has(node.type) ||
        ((node.type === "PropertyDefinition" ||
          node.type === "AccessorProperty") &&
          node.static !== true &&
          key === "value");
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) visit(child, childDeferred);
      }
    }
  };
  visit(program, false);
  return offences.sort((left, right) => left.line - right.line);
}

/** The names a binding pattern binds. */
function boundNames(pattern: AstNode | undefined): string[] {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern.name as string];
    case "ObjectPattern":
      return list(pattern, "properties").flatMap((property) =>
        boundNames(
          property.type === "RestElement"
            ? field(property, "argument")
            : field(property, "value"),
        ),
      );
    case "ArrayPattern":
      return list(pattern, "elements").flatMap(boundNames);
    case "AssignmentPattern":
      return boundNames(field(pattern, "left"));
    case "RestElement":
      return boundNames(field(pattern, "argument"));
    default:
      return [];
  }
}

/**
 * Each retired name a module of packages/db declares at module scope (a
 * variable, a function or a class) or exports (`export { x as db }`, or a
 * re-export by that name).
 */
function retiredNamesIn(file: string, text: string): string[] {
  const program = parseAst(text, {
    lang: languageOf(file),
  }) as unknown as AstNode;
  const found: string[] = [];
  for (const statement of list(program, "body")) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? field(statement, "declaration")
        : statement;
    const names =
      declaration?.type === "VariableDeclaration"
        ? list(declaration, "declarations").flatMap((declarator) =>
            boundNames(field(declarator, "id")),
          )
        : declaration?.type === "FunctionDeclaration" ||
            declaration?.type === "ClassDeclaration"
          ? [nameOf(field(declaration, "id"))].filter(
              (name): name is string => name !== undefined,
            )
          : [];
    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of list(statement, "specifiers")) {
        const exported = nameOf(field(specifier, "exported"));
        if (exported !== undefined) names.push(exported);
      }
    }
    for (const name of names) {
      if (retiredNames.has(name)) {
        found.push(`${file}:${lineOf(text, statement)} declares \`${name}\``);
      }
    }
  }
  return found;
}

const testPoolType = "DatabaseWithTestPool";
const clientModule = "packages/db/src/client.ts";
/** The two modules that hold the handle's `$client` type and read it. */
const testPoolTypeOwners = new Set([
  clientModule,
  "packages/db/src/testing.ts",
]);
/** The subpaths a consumer of the package is given (manifest-g.md §7, Done when 12). */
const publicEntries = [
  "packages/db/src/index.ts",
  "packages/db/src/migrate.ts",
];

/**
 * Each name a public subpath exports from client.ts whose declared type names
 * `DatabaseWithTestPool` or writes `$client`: for a type or an interface, its
 * whole declaration; for a function, its parameters' and return type; for a
 * variable, its annotation and the types its value is asserted as. The
 * `Database` alias is one of them. `read` answers a file's text by its path
 * from the repository's root.
 */
function publicClientTypes(read: (file: string) => string): string[] {
  const client = read(clientModule);
  const declared = new Map<string, AstNode[]>();
  for (const statement of list(
    parseAst(client, { lang: "ts" }) as unknown as AstNode,
    "body",
  )) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? field(statement, "declaration")
        : statement;
    const name = nameOf(field(declaration, "id"));
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of list(declaration, "declarations")) {
        const id = field(declarator, "id");
        const types = [field(id, "typeAnnotation")];
        let value = field(declarator, "init");
        while (
          value?.type === "TSAsExpression" ||
          value?.type === "TSSatisfiesExpression"
        ) {
          types.push(field(value, "typeAnnotation"));
          value = field(value, "expression");
        }
        const variable = nameOf(id);
        if (variable !== undefined) {
          declared.set(
            variable,
            types.filter((type): type is AstNode => type !== undefined),
          );
        }
      }
    } else if (
      name !== undefined &&
      (declaration?.type === "FunctionDeclaration" ||
        declaration?.type === "TSDeclareFunction")
    ) {
      declared.set(name, [
        ...list(declaration, "params"),
        ...[field(declaration, "returnType")].filter(
          (type): type is AstNode => type !== undefined,
        ),
      ]);
    } else if (name !== undefined && declaration !== undefined) {
      declared.set(name, [declaration]);
    }
  }
  const found: string[] = [];
  for (const entry of publicEntries) {
    for (const statement of list(
      parseAst(read(entry), { lang: "ts" }) as unknown as AstNode,
      "body",
    )) {
      if (nameOf(field(statement, "source")) !== "./client.js") continue;
      if (statement.type === "ExportAllDeclaration") {
        found.push(
          `${entry} \`export *\` from \`./client.js\`, which the pin cannot follow`,
        );
        continue;
      }
      for (const specifier of list(statement, "specifiers")) {
        const local = nameOf(field(specifier, "local"));
        const exported = nameOf(field(specifier, "exported"));
        if ((declared.get(local ?? "") ?? []).some(carriesClient)) {
          found.push(
            `${entry} exports \`${exported}\`, whose declared type carries \`$client\``,
          );
        }
      }
    }
  }
  return found;
}

/**
 * Whether a declaration's type nodes name `DatabaseWithTestPool`, or write
 * `$client` as a name or a string key. Comments are not nodes, so one that
 * mentions either is not read.
 */
function carriesClient(node: AstNode): boolean {
  if (
    (node.type === "Identifier" &&
      (node.name === testPoolType || node.name === "$client")) ||
    (node.type === "Literal" && node.value === "$client")
  ) {
    return true;
  }
  return Object.keys(node).some((key) => {
    const value = node[key];
    return (Array.isArray(value) ? value : [value]).some(
      (child) => isNode(child) && carriesClient(child),
    );
  });
}

/** Each place a module names `DatabaseWithTestPool`, once per position. */
function testPoolTypeNamedIn(file: string, text: string): string[] {
  const found: string[] = [];
  const seen = new Set<number>();
  const visit = (node: AstNode) => {
    if (
      node.type === "Identifier" &&
      node.name === testPoolType &&
      !seen.has(node.start)
    ) {
      seen.add(node.start);
      found.push(`${file}:${lineOf(text, node)} names \`${testPoolType}\``);
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) visit(child);
      }
    }
  };
  visit(parseAst(text, { lang: languageOf(file) }) as unknown as AstNode);
  return found;
}

let scanned: Offence[] | undefined;

/** `retiredDefaultsIn` over the repository's `productModules`, read once per run. */
function retiredDefaults(kind: DefaultKind): string[] {
  scanned ??= productModules(repositoryRoot).flatMap((file) =>
    retiredDefaultsIn(file, readFileSync(join(repositoryRoot, file), "utf8")),
  );
  return scanned
    .filter((offence) => offence.kind === kind)
    .map((offence) => offence.at);
}

function packageModules(): string[] {
  return productModules(repositoryRoot).filter((file) =>
    file.startsWith("packages/db/src/"),
  );
}

/*
 * The source half of Done when 2. The first five cases read the tree as it
 * is; the last two plant each form in memory, to show that each check fires.
 * The first three share one parse of every module `productModules` reads, 506
 * at G.5's base and at this step, made by whichever runs first, so each
 * carries the budget G.4's pin carries (below).
 */
describe("the defaults G.5 retired stay retired (Plan 13, G.5; Done when 2)", () => {
  test("no module builds a repository, a storage, a handle or a pool as it loads: no singleton, and no default storage", {
    timeout: 120_000,
  }, () => {
    expect(retiredDefaults("load")).toEqual([]);
  });

  test("no function gives its database or storage a default, and no default reads db or defaultStorage", {
    timeout: 120_000,
  }, () => {
    expect(retiredDefaults("default")).toEqual([]);
  });

  test("nothing falls back to db or defaultStorage, nor when a database or storage was not given", {
    timeout: 120_000,
  }, () => {
    expect(retiredDefaults("fallback")).toEqual([]);
  });

  test("packages/db declares and exports no db, defaultStorage, withTransaction, checkDatabaseReadiness or closeDatabase", () => {
    expect(
      packageModules().flatMap((file) =>
        retiredNamesIn(file, readFileSync(join(repositoryRoot, file), "utf8")),
      ),
    ).toEqual([]);
  });

  test("the public Database type carries no $client, nor does anything else the barrel or ./migrate exports from client.ts", () => {
    expect(
      publicClientTypes((file) =>
        readFileSync(join(repositoryRoot, file), "utf8"),
      ),
    ).toEqual([]);
    expect(
      packageModules()
        .filter((file) => !testPoolTypeOwners.has(file))
        .flatMap((file) =>
          testPoolTypeNamedIn(
            file,
            readFileSync(join(repositoryRoot, file), "utf8"),
          ),
        ),
    ).toEqual([]);

    // The same, of the types: checked by the package's typecheck, not when
    // this case runs. The key is held as a value, so that this file writes
    // no `$client` of its own (the pin at the end of this file).
    const clientKey = "$client" as const;
    type ValuesCarryingClient = {
      [Name in keyof typeof publicApi]: (typeof publicApi)[Name] extends Record<
        typeof clientKey,
        unknown
      >
        ? Name
        : never;
    }[keyof typeof publicApi];
    expectTypeOf<ValuesCarryingClient>().toEqualTypeOf<never>();
    expectTypeOf<Database>().not.toHaveProperty(clientKey);
    expectTypeOf<Storage["db"]>().not.toHaveProperty(clientKey);
  });

  test("reports each retired default in the forms it reads, and not what is none", () => {
    const planted = [
      'import { createStorage as build, createOutboxRepository } from "@requestport/db";',
      'import pg from "pg";',
      'import { PGlite } from "@electric-sql/pglite";',
      'import { db, defaultStorage } from "./client.js";',
      "export const outboxRepository = createOutboxRepository();",
      "export const bound = createOutboxRepository(handle);",
      "const storage = build(options);",
      "const viaNamespace = databaseModule.createStorage(options);",
      "const embedded = new PGlite();",
      "const pgPool = new pg.Pool();",
      'export default rootStorageFromEnv("application");',
      "class Held { static storage = webStorage(); static { createWorkerStorages(env, options); } }",
      "const handle = drizzle(pool);",
      "export function later(database: Database) { return createOutboxRepository(database); }",
      "const lazily = () => createStorage(options);",
      "class Built { repository = createOutboxRepository(this.database); read() { return webStorage(); } }",
      'import { Client } from "@slack/web-api";',
      "const slack = new Client();",
      "const require = createRequire(import.meta.url);",
      "export function a(database: Database = db) {}",
      "export function b({ database = handle }: Options) {}",
      "export function c(storage = defaultStorage) {}",
      "export const d = (input = defaultStorage.db) => input;",
      "export function e(options = { database: db }) {}",
      "export function f(limit = 100, { readOnly = false } = {}, env = process.env) {}",
      "export const g = (options: Options) => options.database ?? db;",
      "export const h = (database?: Database) => database || defaultStorage.db;",
      "export const i = (input: Input) => input.storage ?? fallbackStorage;",
      "export function j(options: Options) { options.database ??= db; }",
      "export const k = (handle?: Database) => (handle === undefined ? db : handle);",
      "export const l = (options: Options) => options.limit ?? 100;",
      'export const m = (env: Env) => env.DATABASE_URL ?? "";',
      "export const n = (holder: { db: Database }) => holder.db ?? holder;",
    ].join("\n");

    expect(
      retiredDefaultsIn("planted.ts", planted).map((offence) => [
        offence.kind,
        offence.at,
      ]),
    ).toEqual([
      ["load", "planted.ts:5 calls `createOutboxRepository` as it loads"],
      ["load", "planted.ts:6 calls `createOutboxRepository` as it loads"],
      ["load", "planted.ts:7 calls `createStorage` as it loads"],
      ["load", "planted.ts:8 calls `createStorage` as it loads"],
      ["load", "planted.ts:9 constructs `PGlite` as it loads"],
      ["load", "planted.ts:10 constructs `pg.Pool` as it loads"],
      ["load", "planted.ts:11 calls `rootStorageFromEnv` as it loads"],
      ["load", "planted.ts:12 calls `webStorage` as it loads"],
      ["load", "planted.ts:12 calls `createWorkerStorages` as it loads"],
      ["load", "planted.ts:13 calls `drizzle` as it loads"],
      [
        "default",
        "planted.ts:20 defaults `database` to a value that reads `db`",
      ],
      ["default", "planted.ts:21 gives `database` a default"],
      [
        "default",
        "planted.ts:22 defaults `storage` to a value that reads `defaultStorage`",
      ],
      [
        "default",
        "planted.ts:23 defaults `input` to a value that reads `defaultStorage`",
      ],
      [
        "default",
        "planted.ts:24 defaults `options` to a value that reads `db`",
      ],
      ["fallback", "planted.ts:26 falls back to a value that reads `db`"],
      [
        "fallback",
        "planted.ts:27 falls back to a value that reads `defaultStorage`",
      ],
      ["fallback", "planted.ts:28 falls back when `storage` is absent"],
      ["fallback", "planted.ts:29 falls back to a value that reads `db`"],
      ["fallback", "planted.ts:30 answers a value that reads `db`"],
      ["fallback", "planted.ts:33 falls back when `db` is absent"],
    ]);
    // A local named `db`, as a builder's own handle or the web root's, is no
    // retired value.
    expect(
      retiredDefaultsIn(
        "local.ts",
        [
          'export const bound = (value: unknown, db: Database) => (typeof value === "function" ? value.bind(db) : value);',
          "export const handed = (db: Database, chosen = db) => chosen ?? db;",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(retiredDefaultsIn("broken.ts", "export const = ;")).toEqual([
      { kind: "load", line: 0, at: "broken.ts cannot be parsed" },
      { kind: "default", line: 0, at: "broken.ts cannot be parsed" },
      { kind: "fallback", line: 0, at: "broken.ts cannot be parsed" },
    ]);
  });

  test("reports each retired name packages/db declares or exports, and $client reaching a public subpath, and not what is neither", () => {
    expect(
      retiredNamesIn(
        "packages/db/src/planted.ts",
        [
          "export const db = storage.db;",
          "export function withTransaction() {}",
          "const checkDatabaseReadiness = () => storage.ready();",
          "export { storage as defaultStorage };",
          'export { closeDatabase } from "./elsewhere.js";',
          "export function build() { const db = handle; return db; }",
          "export function take(db: Database) { return db; }",
          "export const { db: renamed } = holder;",
        ].join("\n"),
      ),
    ).toEqual([
      "packages/db/src/planted.ts:1 declares `db`",
      "packages/db/src/planted.ts:2 declares `withTransaction`",
      "packages/db/src/planted.ts:3 declares `checkDatabaseReadiness`",
      "packages/db/src/planted.ts:4 declares `defaultStorage`",
      "packages/db/src/planted.ts:5 declares `closeDatabase`",
    ]);

    const files: Record<string, string> = {
      [clientModule]: [
        "export type Database = Base & { $client: Pool };",
        "export type Fine = Base;",
        "type DatabaseWithTestPool = Fine & { $client: TestPool };",
        "export const db = storage.db as DatabaseWithTestPool;",
        "export const handle: DatabaseWithTestPool = storage.db;",
        "export function createStorage(options: StorageOptions): Storage { const db: DatabaseWithTestPool = build(options); return wrap(db); }",
        "export function leak(): DatabaseWithTestPool { return build(); }",
        "export interface Leaky { db: DatabaseWithTestPool }",
      ].join("\n"),
      "packages/db/src/index.ts": [
        'export type { Database, Fine, Leaky } from "./client.js";',
        'export { createStorage, db, leak as exposed } from "./client.js";',
      ].join("\n"),
      "packages/db/src/migrate.ts": [
        'export { handle } from "./client.js";',
        'export * from "./client.js";',
      ].join("\n"),
    };
    expect(publicClientTypes((file) => files[file] ?? "")).toEqual([
      "packages/db/src/index.ts exports `Database`, whose declared type carries `$client`",
      "packages/db/src/index.ts exports `Leaky`, whose declared type carries `$client`",
      "packages/db/src/index.ts exports `db`, whose declared type carries `$client`",
      "packages/db/src/index.ts exports `exposed`, whose declared type carries `$client`",
      "packages/db/src/migrate.ts exports `handle`, whose declared type carries `$client`",
      "packages/db/src/migrate.ts `export *` from `./client.js`, which the pin cannot follow",
    ]);
    expect(
      testPoolTypeNamedIn(
        "packages/db/src/planted.ts",
        [
          'import type { DatabaseWithTestPool } from "./client.js";',
          "// DatabaseWithTestPool, in a comment, is not a use.",
          "export function leak(): DatabaseWithTestPool { return build(); }",
        ].join("\n"),
      ),
    ).toEqual([
      "packages/db/src/planted.ts:1 names `DatabaseWithTestPool`",
      "packages/db/src/planted.ts:3 names `DatabaseWithTestPool`",
    ]);
  });
});

/*
  Plan 13, G.4 (ruling 131), and since G.5 part of Done when 2's pin (rulings
  131 and 133), moved here from test-pool-boundary.test.ts with its cases
  unchanged: no code outside packages/db's client.ts and testing.ts names
  `$client`, the pool Drizzle holds behind a handle. A test reaches a
  storage's pool through `@requestport/db/testing` instead (`testPool`,
  `testPoolOfHandle`, `openSession`, `rawQuery`). G.5 took `$client` off the
  package's public surface (the case above that reads the public subpaths),
  so a typecheck refuses a use typed through it. This pin also refuses the
  forms a typecheck does not see: a string key, `in`, a call on `Reflect` or
  `Object`, and a use through a cast.

  A use is the name written in code:
  - an identifier named `$client`, wherever it stands: a member read
    (`db.$client`, `db?.$client`, an escaped `db.\u0024client`), a key written
    or destructured, a type's member, a binding, an import or an export;
  - a string written as a property key: `db["$client"]`, `{ "$client": … }`,
    `"$client" in db`, a literal type (`Database["$client"]`), or an argument
    of a call on `Reflect` or `Object`, or of `hasOwnProperty` or
    `propertyIsEnumerable`, called as a method or through `.call`
    (`Reflect.get(db, "$client")`,
    `Object.prototype.hasOwnProperty.call(db, "$client")`).

  A pattern is not a use, and is not reported: a comment, a regular
  expression, and every other string or template, whether it holds the name
  among other text or is the name exactly. That is how the tenant-scope
  sweep's `=== "$client"`, its reports and its planted sources, and the
  regular expression in apps/web/src/lib/e2e-owner-storage.test.ts, which
  read source text, pass. A key computed at run time (`db[name]`), handed
  through any other function, or passed in `.apply`'s array of arguments,
  is not followed.

  The files read are every code file in the code roots and at the
  repository's root, outside the directories .gitignore names as generated
  or local, and each is parsed: a file that cannot be parsed is reported, not
  skipped. Nothing filters the files by their text first: escapes can spell
  the name without writing one of its characters.

  It runs as part of `@requestport/db`'s tests, whose Turbo hash covers
  `packages/db` only. So a `$client` added anywhere else leaves that hash as
  it was, and a gate without `--force` replays the cached pass; the
  tenant-scope sweep's boundary case is read the same way. A forced gate
  runs it, and every merge's gate is forced (manifest-g.md §7, Done when
  10).
*/

const theName = "$client";

/** The repository's directories that hold code; the root's own files are read too. */
const codeRoots = new Set([
  "apps",
  "docs",
  "packages",
  "scripts",
  "spikes",
  "trigger",
]);

/** The two files that own `$client`, relative to the repository's root. */
const owners = new Set([
  "packages/db/src/client.ts",
  "packages/db/src/testing.ts",
]);

function codeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!generatedDirectories.has(entry.name)) walk(path);
      } else if (entry.isFile() && codeFile.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (codeRoots.has(entry.name)) walk(path);
    } else if (entry.isFile() && codeFile.test(entry.name)) {
      found.push(path);
    }
  }
  return found.map((path) => relative(root, path).split(sep).join("/")).sort();
}

// A loose view of the ESTree that `parseAst` returns.

const ownPropertyChecks = new Set(["hasOwnProperty", "propertyIsEnumerable"]);

function isPropertyCall(callee: unknown): boolean {
  if (!isNode(callee) || callee.type !== "MemberExpression") return false;
  const object = callee.object;
  const property = callee.property;
  const named = (node: unknown, names: Set<string>) =>
    isNode(node) &&
    node.type === "Identifier" &&
    names.has(node.name as string);
  return (
    named(object, new Set(["Reflect", "Object"])) ||
    named(property, ownPropertyChecks) ||
    // `Object.prototype.hasOwnProperty.call(db, "$client")`.
    (named(property, new Set(["call"])) &&
      isNode(object) &&
      object.type === "MemberExpression" &&
      named(object.property, ownPropertyChecks))
  );
}

/** Whether a string standing at `key` of `parent` is a property key. */
function isKeyPosition(parent: AstNode, key: string): boolean {
  switch (parent.type) {
    case "MemberExpression":
      return key === "property" && parent.computed === true;
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
    case "AccessorProperty":
    case "TSPropertySignature":
    case "TSMethodSignature":
      return key === "key";
    case "BinaryExpression":
      return key === "left" && parent.operator === "in";
    case "TSLiteralType":
      return true;
    case "CallExpression":
      return key === "arguments" && isPropertyCall(parent.callee);
    default:
      return false;
  }
}

function useOf(
  node: AstNode,
  parent: AstNode | undefined,
  key: string | undefined,
): string | undefined {
  if (
    (node.type === "Identifier" ||
      node.type === "PrivateIdentifier" ||
      node.type === "JSXIdentifier") &&
    node.name === theName
  ) {
    return parent?.type === "MemberExpression" &&
      key === "property" &&
      parent.computed !== true
      ? "reads `.$client`"
      : "names `$client`";
  }
  if (
    parent !== undefined &&
    key !== undefined &&
    writtenString(node) === theName &&
    isKeyPosition(parent, key)
  ) {
    return "names `$client` in a string key";
  }
  return undefined;
}

/** Each use in one file's source, as `file:line form`, once per position. */
function usesIn(file: string, text: string): string[] {
  let program: AstNode;
  try {
    program = parseAst(text, { lang: languageOf(file) }) as unknown as AstNode;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`${file} could not be parsed: ${reason.split("\n")[0]}`];
  }
  const found: string[] = [];
  const seen = new Set<number>();
  const visit = (node: AstNode, parent?: AstNode, key?: string) => {
    const use = useOf(node, parent, key);
    // A shorthand key and its value, or an import's two names, are one token.
    if (use !== undefined && !seen.has(node.start)) {
      seen.add(node.start);
      const line = text.slice(0, node.start).split("\n").length;
      found.push(`${file}:${line} ${use}`);
    }
    for (const childKey of Object.keys(node)) {
      const value = node[childKey];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) visit(child, node, childKey);
      }
    }
  };
  visit(program);
  return found;
}

function usesUnder(root: string): string[] {
  return codeFiles(root)
    .filter((file) => !owners.has(file))
    .flatMap((file) => usesIn(file, readFileSync(join(root, file), "utf8")));
}

describe("`$client` outside packages/db's client.ts and testing.ts (Plan 13, G.4; ruling 131)", () => {
  /*
   * Its own budget, because it parses every code file in the repository,
   * 952 at G.4's base. It took 3.5 s and 4.2 s in runs that started at load
   * averages of 37 and 26 (2026-10-02), on a host that has run this
   * package's source tests past their 30 seconds.
   */
  test("is named nowhere in the repository's code", {
    timeout: 120_000,
  }, () => {
    expect(usesUnder(repositoryRoot)).toEqual([]);
  });

  test("is reported in every form a use takes", () => {
    const planted = [
      "await db.$client.end();",
      "await db?.$client.query(text);",
      "const escaped = db.\\u0024client;",
      'const viaKey = db["$client"];',
      "const viaTemplate = db[`$client`];",
      "const { $client } = db;",
      'const { "$client": renamed } = db;',
      "type Held = { $client: unknown };",
      'type Indexed = Database["$client"];',
      'const probed = "$client" in db;',
      'const read = Reflect.get(db, "$client");',
      'const own = Object.hasOwn(db, "$client");',
      'const ownToo = db.hasOwnProperty("$client");',
      "const written = { $client: pool };",
      "import { $client as imported } from './elsewhere.js';",
      'const ownCall = Object.prototype.hasOwnProperty.call(db, "$client");',
    ].join("\n");

    expect(usesIn("planted.ts", planted)).toEqual([
      "planted.ts:1 reads `.$client`",
      "planted.ts:2 reads `.$client`",
      "planted.ts:3 reads `.$client`",
      "planted.ts:4 names `$client` in a string key",
      "planted.ts:5 names `$client` in a string key",
      "planted.ts:6 names `$client`",
      "planted.ts:7 names `$client` in a string key",
      "planted.ts:8 names `$client`",
      "planted.ts:9 names `$client` in a string key",
      "planted.ts:10 names `$client` in a string key",
      "planted.ts:11 names `$client` in a string key",
      "planted.ts:12 names `$client` in a string key",
      "planted.ts:13 names `$client` in a string key",
      "planted.ts:14 names `$client`",
      "planted.ts:15 names `$client`",
      "planted.ts:16 names `$client` in a string key",
    ]);
  });

  test("is not reported where it is a pattern: a comment, a regular expression, or a string or template that is text", () => {
    const patterns = [
      "// db.$client, in a comment",
      "/* and $client in a block */",
      'const sweep = name === "$client";',
      'const reported = "`$client` is not modelled by the sweep";',
      "const source = `return db.$client.query('select 1')`;",
      "const pattern = /\\bdb\\.\\$client\\b/u;",
      'expect(text).not.toContain("$client");',
      'const names = ["$client"];',
    ].join("\n");

    expect(usesIn("patterns.ts", patterns)).toEqual([]);
  });

  test("is reported, not skipped, in a file that cannot be parsed", () => {
    expect(usesIn("broken.ts", "const = db.;")).toEqual([
      expect.stringMatching(/^broken\.ts could not be parsed: /u),
    ]);
  });

  test("is looked for in every code root and at the root, past generated directories, and not in the two files that own it", () => {
    const root = mkdtempSync(join(tmpdir(), "requestport-test-pool-boundary-"));
    const plant = (file: string, text = "db.$client.end();\n") => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };

    try {
      for (const file of [
        "apps/web/src/lib/a.ts",
        "apps/web/src/app/.well-known/b.tsx",
        "apps/web/tests/fixtures/c.ts",
        "docs/d.mjs",
        "packages/auth/src/e.test.ts",
        "packages/db/src/f.ts",
        "packages/db/src/client.ts",
        "packages/db/src/testing.ts",
        "scripts/g.cjs",
        "spikes/h/src/i.js",
        "trigger/src/j.mts",
        "k.ts",
        // Generated or local, at any depth: not code anyone wrote here.
        "apps/web/.next/server/chunk.js",
        "packages/db/node_modules/drizzle-orm/driver.js",
        "packages/db/dist/client.js",
        "packages/db/coverage/l.js",
        "trigger/.trigger/m.mjs",
        // Not a code root, or not code.
        ".claude/n.mjs",
        "node_modules/o/index.js",
        "docs/p.md",
      ]) {
        plant(file);
      }

      expect(usesUnder(root)).toEqual([
        "apps/web/src/app/.well-known/b.tsx:1 reads `.$client`",
        "apps/web/src/lib/a.ts:1 reads `.$client`",
        "apps/web/tests/fixtures/c.ts:1 reads `.$client`",
        "docs/d.mjs:1 reads `.$client`",
        "k.ts:1 reads `.$client`",
        "packages/auth/src/e.test.ts:1 reads `.$client`",
        "packages/db/src/f.ts:1 reads `.$client`",
        "scripts/g.cjs:1 reads `.$client`",
        "spikes/h/src/i.js:1 reads `.$client`",
        "trigger/src/j.mts:1 reads `.$client`",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
