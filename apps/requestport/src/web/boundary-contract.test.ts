import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HOSTED_DRIVER_PACKAGES } from "@requestport/db/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { parseAst } from "vitest/node";

import {
  FALLBACK_UNDER_FAMILY,
  isUnderFamily,
  ROUTE_TABLE,
} from "../../../../packages/server/src/route-table.js";

/*
 * The boundary between the host's copy and Next's (Plan 13, H.5; manifest-h.md
 * §2.7.1, "The boundary between the two copies"; K10; rulings 143 and 145).
 *
 * A process that serves Next beside the host holds two copies of the code:
 * the host's, and the one Next's build carries. The host shares its instances
 * with Next through the handoff, but not its classes or its module state. So
 * in the code Next serves, an `instanceof` of a class whose instances the host
 * may build, or a module-level map keyed by objects, would compare against
 * Next's copy and miss. This reads the literal source, as `k10-inventory.mjs` did
 * (H.0b), and holds the contract over it.
 *
 * Next's closure is esbuild's, through the `tsx` this package depends on:
 * every App Router file under `apps/web/src/app` (pages, layouts and the other
 * conventions, and every `route.ts` but those the host serves), with
 * `instrumentation.ts` and `proxy.ts`, bundled with workspace packages followed
 * and every other bare specifier left external. A route the host serves is one
 * whose path lies under a family it mounts and is not left to Next
 * (`packages/server/src/route-table.ts`). Each file is parsed with Vitest's
 * `parseAst`.
 *
 * What it holds over that closure:
 * - every `instanceof`, of any class (ruling 143), is of a global, of a
 *   first-party class with a `static [Symbol.hasInstance]` (a brand:
 *   `DomainError`, `RequestTooLargeError`), of a third-party class shown below
 *   to hold across copies, or on `SITE_ALLOW_LIST` with the reason the check
 *   answers rightly whichever copy is involved (for most, the value it meets
 *   is always built in the check's own copy);
 * - every module-level `Map`, `WeakMap`, `Set` or `WeakSet` is shown to be keyed
 *   by strings, or is on `MAP_ALLOW_LIST` with its reason. Module level means
 *   evaluated as the module loads: a top-level statement at any depth (nested in
 *   an object, wrapped in a call), a class's static member, the body of a
 *   function called where it is written; and also a module-level binding a
 *   function assigns one to later, or declares with such a type. A map made
 *   inside a function that module code calls is not seen;
 * - every list entry names something the scan still finds.
 * It fails first on the real closure with a brand removed, and on a planted
 * unbranded class and planted maps (the cases at the end).
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const appDirectory = join(root, "apps/web/src/app");
const here = createRequire(import.meta.url);

type BuildResult = { metafile: { inputs: Record<string, unknown> } };
const esbuild = createRequire(here.resolve("tsx/package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<BuildResult>;
};

/** A first-party class whose `instanceof` the host and Next both run, each with why its value is one copy's. */
type SiteEntry = { file: string; className: string; reason: string };
/** A module-level map, by the name the scan reports for it. */
type MapEntry = { file: string; name: string; reason: string };

/*
 * Third-party classes whose `instanceof` already holds across copies. Each is
 * proved by "every copy of zod … recognises every other copy's ZodError",
 * below, over every copy the closure loads.
 */
const CROSS_COPY_THIRD_PARTY = [
  {
    specifier: "zod",
    className: "ZodError",
    reason:
      "zod 4 builds its classes with `$constructor`, whose `Symbol.hasInstance` also answers true for a value whose `_zod.traits` names the class, and the errors any copy of zod 4 throws carry it.",
  },
] as const;

const SITE_ALLOW_LIST: readonly SiteEntry[] = [
  {
    file: "packages/auth/src/server-options.ts",
    className: "SignupPolicyDeniedError",
    reason:
      "Caught from the `assertSignupAllowed` that `createAuthOptions` is handed. Its one caller outside tests, `createAuth`, hands it `createDatabaseSignupPolicy`'s, which throws the error of this package's `signup-policy.ts`, the module this check imports the class from, so the throw and the check are one copy's. While the host's handoff is set, only the host's copy builds Better Auth: `createAuth` refuses in Next's (H.5 slice b).",
  },
  {
    file: "packages/db/src/client.ts",
    className: "SingleSessionPglite",
    reason:
      "`driverPoolOf` reads the client from this module's own `clients` map, which only this module writes, as it builds a storage, so a client it finds was built here, by this copy's class.",
  },
  {
    file: "packages/db/src/migrate.ts",
    className: "SingleSessionPglite",
    reason:
      "The client comes from `storageClientOf`, which answers only from the `clients` map of the `client.ts` this module imports the class from, and refuses any storage that copy did not build.",
  },
  {
    file: "packages/db/src/client.ts",
    className: "DatabaseRoleGuardError",
    reason:
      "In `installRoleCheck`, on a client this module built, with the guard its caller handed `createStorage`; the error is thrown by that guard's `checkRole`. Every guard outside tests is built by `createDatabaseRoleGuard` in packages/db beside the `createStorage` it is handed to (`wiring.ts`, `operator-session.ts`, `tenant-context.ts`), so in the same copy. Were one from another copy, its refusal would only clear `checked`, so the next query would be checked again, not let through: no query runs before a check passes.",
  },
  {
    file: "packages/db/src/operator-session.ts",
    className: "DatabaseRoleGuardError",
    reason:
      "In `ownerRefusedByRoleGuard`, on what the session's first `connect` threw: the guard is the one `openOperatorSession` builds with `createDatabaseRoleGuard`, imported from the `role-guard.ts` this check imports the class from, beside its `createStorage`, so the throw and the check are one copy's. Were the error another copy's, the check would answer false and that error would be thrown unchanged: the owner is still refused, only without `preflight`'s remedy.",
  },
  {
    file: "packages/db/src/tenant-context.ts",
    className: "IsolatedReadEnd",
    reason:
      "Declared in this module, and thrown and caught inside its own `isolatedRead`, so the class and the value are this copy's whichever storage's transaction carried it between the two.",
  },
  // Where the tree has a hosted driver (J.2b moved the check into its private
  // module; the public variant has neither the driver nor the check).
  ...(HOSTED_DRIVER_PACKAGES.length === 0
    ? []
    : [
        {
          file: "packages/db/src/hosted-driver.ts",
          className: "DatabaseError",
          reason:
            "The hosted driver's `DatabaseError` (`isHostedServerError`), which only that driver raises. The self-host's storage is pg or PGlite (`storage` in apps/requestport/src/configuration.ts), so under the self-host no value this check meets is one, in either copy.",
        },
      ]),
  {
    file: "packages/jobs/src/slack-rate-limit.ts",
    className: "WebAPIRateLimitedError",
    reason:
      "Its second test reads the error's `code`, `ErrorCode.RateLimitedError`, which `@slack/web-api`'s `WebAPIRateLimitedError` sets on every instance, so another copy's rate-limit error is recognised all the same.",
  },
];

const MAP_ALLOW_LIST: readonly MapEntry[] = [
  {
    file: "packages/core/src/request-port.ts",
    name: "compositions",
    reason:
      "A WeakMap keyed by RequestPort, set by `createRequestPort` and read only by `requestPortComposition`, which core's `index.ts` does not export. A RequestPort's members close over their composition and never read the map. Ruling 141 names this entry.",
  },
  {
    file: "packages/db/src/client.ts",
    name: "clients",
    reason:
      "A WeakMap keyed by Storage, written only as this module builds a storage, and read by `storageClientOf` and `driverPoolOf`. Their callers outside tests: `operator-session.ts`, on the owner storage it builds for itself, which it also hands `migrate.ts`; `migrate.ts`, also from core's `RequestPort.migrate()` with the `ownerStorage` its composer passes, which no composer outside tests passes; and `e2e-owner-storage.ts`, on the e2e scenario route's own storage, which apps/web refuses where VERCEL_ENV is set and outside E2E mode. `testing.ts` is test support. None is handed the handoff's storage.",
  },
];

const VERIFIED_STRING_KEYED: readonly MapEntry[] = [
  {
    file: "apps/web/src/app/oauth/agent-consent/actions.ts",
    name: "resources",
    reason: "Keyed by `new URL(…, BETTER_AUTH_URL).toString()`, a string.",
  },
  {
    file: "packages/core/src/person.ts",
    name: "admitted",
    reason:
      "`new Set(inProcessPersonCommands)`, a `readonly string[]` declared in the same module.",
  },
  {
    file: "packages/domain/src/transport-metadata.ts",
    name: "restCommandTransportsByName",
    reason: "Keyed by each REST command transport's `name`, a string.",
  },
  {
    file: "packages/domain/src/transport-metadata.ts",
    name: "queryCapabilitiesByName",
    reason: "Keyed by each query capability's `name`, a string.",
  },
  {
    file: "packages/domain/src/transport-metadata.ts",
    name: "mcpToolTransportsByName",
    reason: "Keyed by each MCP tool transport's `name`, a string.",
  },
  {
    file: "packages/domain/src/work/work-state-machine.ts",
    name: "transitions.abandoned",
    reason:
      "An empty `ReadonlySet<WorkSessionState>` (the `transitions` record's declared type), and `WorkSessionState` is a union of strings.",
  },
  {
    file: "packages/domain/src/work/work-state-machine.ts",
    name: "transitions.ended",
    reason: "As `transitions.abandoned`.",
  },
];

/** Files under `apps/web/src/app` that neither closure reaches, each with why. */
const UNREACHED_APP_FILES: readonly { file: string; reason: string }[] = [
  {
    file: "apps/web/src/app/mcp/unauthorized.ts",
    reason:
      "Only its own test imports it: the MCP route composes `@requestport/server`'s handler, which calls `./unauthorized` itself (H.1).",
  },
];

const GLOBALS = new Set([
  "AbortSignal",
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "Blob",
  "Buffer",
  "DOMException",
  "Date",
  "Error",
  "File",
  "FormData",
  "Function",
  "Headers",
  "Map",
  "Object",
  "Promise",
  "RangeError",
  "ReadableStream",
  "RegExp",
  "Request",
  "Response",
  "Set",
  "SyntaxError",
  "TypeError",
  "URL",
  "Uint8Array",
  "WeakMap",
  "WeakSet",
]);

const ENTRY_FILE =
  /^(?:page|layout|template|default|loading|error|global-error|not-found|route)\.tsx?$/u;
const isTest = (file: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);

// --- the AST, as Vitest's parseAst (oxc, ESTree with TypeScript) gives it ---

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";
const child = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};
const children = (node: AstNode, key: string): AstNode[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};
const nameOf = (node: AstNode | undefined): string | undefined => {
  if (node?.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
};
const isSymbolHasInstance = (node: AstNode | undefined) =>
  node?.type === "MemberExpression" &&
  nameOf(child(node, "object")) === "Symbol" &&
  nameOf(child(node, "property")) === "hasInstance";
/** Parentheses and TypeScript's expression wrappers, removed. */
function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (
    current !== undefined &&
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
    ].includes(current.type)
  ) {
    current = child(current, "expression");
  }
  return current;
}

function parse(file: string, source: string): AstNode {
  const lang = file.endsWith(".tsx")
    ? "tsx"
    : /\.m?js$/u.test(file)
      ? "js"
      : "ts";
  return parseAst(source, { lang }) as unknown as AstNode;
}

function* walk(
  node: AstNode,
  ancestors: AstNode[] = [],
): Generator<{ node: AstNode; ancestors: AstNode[] }> {
  yield { node, ancestors };
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const next = [...ancestors, node];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) yield* walk(item, next);
    } else if (isNode(value)) {
      yield* walk(value, next);
    }
  }
}

// --- what one file holds ---

type Site = {
  file: string;
  line: number;
  /** As written: `DomainError`, `z.ZodError`. */
  written: string;
  /** The class the site names, through its import. */
  className: string;
  origin: "global" | "first-party" | "third-party" | "unresolved";
  /** The specifier the class was imported by, when it was. */
  source?: string;
};
type ModuleMap = {
  file: string;
  line: number;
  name: string;
  kind: string;
  keyedBy: "strings" | "objects" | "not shown";
};
type FileFacts = {
  sites: Site[];
  classes: { name: string; branded: boolean }[];
  maps: ModuleMap[];
  imports: Map<string, { source: string; imported: string }>;
};

const MAP_KINDS = new Set(["Map", "WeakMap", "Set", "WeakSet"]);
const MAP_TYPES = new Set([...MAP_KINDS, "ReadonlyMap", "ReadonlySet"]);
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const isPrimitiveType = (type: AstNode | undefined): boolean => {
  if (type === undefined) return false;
  if (type.type === "TSUnionType") {
    return children(type, "types").every(isPrimitiveType);
  }
  if (type.type === "TSTypeOperator") return type.operator === "keyof";
  return [
    "TSStringKeyword",
    "TSNumberKeyword",
    "TSBigIntKeyword",
    "TSSymbolKeyword",
    "TSBooleanKeyword",
    "TSLiteralType",
    "TSTemplateLiteralType",
  ].includes(type.type);
};
const isLiteralKey = (node: AstNode | undefined): boolean => {
  const value = unwrap(node);
  if (value?.type === "Literal") {
    return typeof value.value === "string" || typeof value.value === "number";
  }
  return (
    value?.type === "TemplateLiteral" &&
    children(value, "expressions").length === 0
  );
};
/**
 * The map type a binding's declared type is, itself or as a member of a
 * union (`WeakMap<K, V> | undefined`); not one nested in another type, such
 * as a record of maps, whose maps are found where they are built.
 */
function heldMapType(type: AstNode | undefined): AstNode | undefined {
  const isMap = (node: AstNode) =>
    node.type === "TSTypeReference" &&
    MAP_TYPES.has(nameOf(child(node, "typeName")) ?? "");
  if (type === undefined) return undefined;
  if (isMap(type)) return type;
  return type.type === "TSUnionType"
    ? children(type, "types").find(isMap)
    : undefined;
}
/** The key type a binding's declared map type states. */
function mapKeyType(type: AstNode | undefined): AstNode | undefined {
  const map = heldMapType(type);
  const parameters =
    map && (child(map, "typeArguments") ?? child(map, "typeParameters"));
  return parameters ? children(parameters, "params")[0] : undefined;
}
/** The type a binding is declared with: `x: T`'s `T`. */
const declaredTypeOf = (id: AstNode | undefined): AstNode | undefined => {
  const annotation = id && child(id, "typeAnnotation");
  return annotation && child(annotation, "typeAnnotation");
};

function keyingOf(
  kind: string,
  newExpression: AstNode | undefined,
  declaredType: AstNode | undefined,
): ModuleMap["keyedBy"] {
  if (kind.startsWith("Weak")) return "objects";
  const typeArguments = newExpression && child(newExpression, "typeArguments");
  const stated =
    (typeArguments && children(typeArguments, "params")[0]) ??
    mapKeyType(declaredType);
  if (stated !== undefined && isPrimitiveType(stated)) return "strings";
  const initial = unwrap(
    newExpression ? children(newExpression, "arguments")[0] : undefined,
  );
  if (initial?.type === "ArrayExpression") {
    const elements = children(initial, "elements");
    const literal =
      elements.length > 0 &&
      elements.every((element) =>
        kind === "Set"
          ? isLiteralKey(element)
          : unwrap(element)?.type === "ArrayExpression" &&
            isLiteralKey(children(unwrap(element) as AstNode, "elements")[0]),
      );
    if (literal) return "strings";
  }
  return "not shown";
}

/** The name a module map is reported by: its binding, through the objects it is nested in. */
function mapName(ancestors: AstNode[], source: string): string {
  const parts: string[] = [];
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index] as AstNode;
    const key = child(ancestor, "key");
    if (ancestor.type === "Property" && key) {
      parts.unshift(nameOf(key) ?? source.slice(key.start, key.end));
    } else if (ancestor.type === "VariableDeclarator") {
      parts.unshift(nameOf(child(ancestor, "id")) ?? "(pattern)");
      break;
    } else if (
      (ancestor.type === "PropertyDefinition" ||
        ancestor.type === "AccessorProperty") &&
      key
    ) {
      parts.unshift(nameOf(key) ?? source.slice(key.start, key.end));
      const owner = ancestors
        .slice(0, index)
        .reverse()
        .find(
          (a) => a.type === "ClassDeclaration" || a.type === "ClassExpression",
        );
      const className = nameOf(owner && child(owner, "id"));
      if (className) parts.unshift(className);
      break;
    } else if (ancestor.type === "AssignmentExpression") {
      const left = child(ancestor, "left") as AstNode;
      parts.unshift(source.slice(left.start, left.end));
      break;
    }
  }
  return parts.join(".") || "(anonymous)";
}

/** Whether a function is called where it is written: `(() => …)()`. */
function calledInPlace(fn: AstNode, ancestors: AstNode[]): boolean {
  let current = fn;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index] as AstNode;
    if (ancestor.type === "ParenthesizedExpression") {
      current = ancestor;
      continue;
    }
    return (
      ancestor.type === "CallExpression" &&
      child(ancestor, "callee") === current
    );
  }
  return false;
}

/**
 * Whether `node` runs as its module loads: no function body between it and
 * the module, except one called in place, and no class member but a static
 * one.
 */
function atModuleLevel(node: AstNode, ancestors: AstNode[]): boolean {
  const path = [...ancestors, node];
  for (let index = 1; index < path.length; index += 1) {
    const ancestor = path[index - 1] as AstNode;
    const current = path[index] as AstNode;
    if (
      FUNCTIONS.has(current.type) &&
      !calledInPlace(current, path.slice(0, index))
    ) {
      return false;
    }
    if (
      (ancestor.type === "PropertyDefinition" ||
        ancestor.type === "AccessorProperty") &&
      child(ancestor, "value") === current &&
      ancestor.static !== true
    ) {
      return false;
    }
  }
  return true;
}

/** Facts by file and source: a judgement over a changed source reparses that file alone. */
const factsCache = new Map<string, FileFacts>();

function factsOf(file: string, source: string): FileFacts {
  const key = `${file}\u0000${source}`;
  const cached = factsCache.get(key);
  if (cached) return cached;
  const facts = readFacts(file, source);
  factsCache.set(key, facts);
  return facts;
}

function readFacts(file: string, source: string): FileFacts {
  const program = parse(file, source);
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  const imports = new Map<string, { source: string; imported: string }>();
  const moduleBindings = new Set<string>();
  /** The map each module binding holds, by the binding's name. */
  const bindingMaps = new Map<string, ModuleMap>();
  const facts: FileFacts = { sites: [], classes: [], maps: [], imports };

  for (const statement of children(program, "body")) {
    if (
      statement.type === "ImportDeclaration" &&
      statement.importKind !== "type"
    ) {
      const specifier = String(child(statement, "source")?.value);
      for (const part of children(statement, "specifiers")) {
        if (part.importKind === "type") continue;
        const local = nameOf(child(part, "local"));
        const imported =
          part.type === "ImportSpecifier"
            ? nameOf(child(part, "imported"))
            : part.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        if (local && imported)
          imports.set(local, { source: specifier, imported });
      }
    }
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? child(statement, "declaration")
        : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of children(declaration, "declarations")) {
        const id = child(declarator, "id");
        const name = nameOf(id);
        if (!name || !id) continue;
        moduleBindings.add(name);
        // Declared with a map's type and built later (or never here).
        const declaredType = declaredTypeOf(id);
        const init = unwrap(child(declarator, "init"));
        const builtHere =
          init?.type === "NewExpression" &&
          MAP_KINDS.has(nameOf(child(init, "callee")) ?? "");
        const held = heldMapType(declaredType);
        if (!builtHere && held) {
          const kind = (nameOf(child(held, "typeName")) ?? "Map").replace(
            "Readonly",
            "",
          );
          const map: ModuleMap = {
            file,
            line: lineOf(declarator.start),
            name,
            kind,
            keyedBy: keyingOf(kind, undefined, declaredType),
          };
          facts.maps.push(map);
          bindingMaps.set(name, map);
        }
      }
    }
  }

  for (const { node, ancestors } of walk(program)) {
    if (node.type === "BinaryExpression" && node.operator === "instanceof") {
      const right = child(node, "right") as AstNode;
      const head =
        right.type === "MemberExpression"
          ? nameOf(child(right, "object"))
          : nameOf(right);
      const member =
        right.type === "MemberExpression"
          ? nameOf(child(right, "property"))
          : undefined;
      const written = source.slice(right.start, right.end);
      const imported = head ? imports.get(head) : undefined;
      let site: Site;
      if (imported) {
        const className =
          member ??
          (imported.imported === "default"
            ? (head as string)
            : imported.imported);
        const firstParty =
          imported.source.startsWith(".") ||
          imported.source.startsWith("@requestport/");
        site = {
          file,
          line: lineOf(node.start),
          written,
          className,
          origin: firstParty ? "first-party" : "third-party",
          source: imported.source,
        };
      } else {
        const className = written;
        const declaredHere = [...walk(program)].some(
          ({ node: n }) =>
            (n.type === "ClassDeclaration" || n.type === "ClassExpression") &&
            nameOf(child(n, "id")) === className,
        );
        site = {
          file,
          line: lineOf(node.start),
          written,
          className,
          origin: declaredHere
            ? "first-party"
            : GLOBALS.has(className)
              ? "global"
              : "unresolved",
        };
      }
      facts.sites.push(site);
    }

    if (
      (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
      child(node, "id")
    ) {
      const members = children(child(node, "body") as AstNode, "body");
      facts.classes.push({
        name: nameOf(child(node, "id")) as string,
        branded: members.some(
          (member) =>
            member.type === "MethodDefinition" &&
            member.static === true &&
            member.computed === true &&
            isSymbolHasInstance(child(member, "key")),
        ),
      });
    }

    if (
      node.type === "NewExpression" &&
      MAP_KINDS.has(nameOf(child(node, "callee")) ?? "")
    ) {
      const parent = ancestors.at(-1);
      const assignedToModuleBinding =
        parent?.type === "AssignmentExpression" &&
        child(parent, "right") === node &&
        moduleBindings.has(nameOf(child(parent, "left")) ?? "");
      if (atModuleLevel(node, ancestors) || assignedToModuleBinding) {
        const name = mapName(ancestors, source);
        const declarator =
          parent?.type === "VariableDeclarator" ? parent : undefined;
        const declaredType = declaredTypeOf(
          declarator && child(declarator, "id"),
        );
        const kind = nameOf(child(node, "callee")) as string;
        const keyedBy = keyingOf(kind, node, declaredType);
        // A module binding is one map however often it is assigned: what its
        // declared type shows stands, unless a WeakMap or WeakSet is put in it.
        const binding = bindingMaps.get(name);
        if (binding) {
          if (keyedBy === "objects") binding.keyedBy = "objects";
        } else {
          const map = { file, line: lineOf(node.start), name, kind, keyedBy };
          facts.maps.push(map);
          if (moduleBindings.has(name)) bindingMaps.set(name, map);
        }
      }
    }
  }
  return facts;
}

// --- the judgement over a closure ---

type Verdict = {
  sites: (Site & { judged: string })[];
  unjudgedSites: Site[];
  maps: (ModuleMap & { listed?: string })[];
  unlistedMaps: ModuleMap[];
  staleEntries: string[];
};

function judge(
  files: readonly string[],
  sources: ReadonlyMap<string, string>,
): Verdict {
  const facts = new Map(
    files.map(
      (file) => [file, factsOf(file, sources.get(file) as string)] as const,
    ),
  );
  const classes = new Map<string, boolean[]>();
  for (const fileFacts of facts.values()) {
    for (const { name, branded } of fileFacts.classes) {
      classes.set(name, [...(classes.get(name) ?? []), branded]);
    }
  }
  const sites = [...facts.values()].flatMap((f) => f.sites);
  const judgedSites = sites.map((site) => {
    let judged = "";
    if (site.origin === "global") judged = "a global";
    else if (site.origin === "first-party") {
      const declarations = classes.get(site.className) ?? [];
      if (declarations.length > 0 && declarations.every(Boolean))
        judged = "branded";
    } else if (
      site.origin === "third-party" &&
      CROSS_COPY_THIRD_PARTY.some(
        (entry) =>
          entry.specifier === site.source && entry.className === site.className,
      )
    ) {
      judged = "holds across copies";
    }
    if (!judged) {
      const entry = SITE_ALLOW_LIST.find(
        (e) => e.file === site.file && e.className === site.className,
      );
      if (entry) judged = `allowed: ${entry.reason}`;
    }
    return { ...site, judged };
  });
  const maps = [...facts.values()]
    .flatMap((f) => f.maps)
    .map((map) => {
      const allowed = MAP_ALLOW_LIST.find(
        (e) => e.file === map.file && e.name === map.name,
      );
      const verified =
        map.keyedBy === "not shown"
          ? VERIFIED_STRING_KEYED.find(
              (e) => e.file === map.file && e.name === map.name,
            )
          : undefined;
      return { ...map, listed: allowed?.reason ?? verified?.reason };
    });
  const staleEntries = [
    ...SITE_ALLOW_LIST.filter(
      (e) =>
        !judgedSites.some(
          (s) =>
            s.file === e.file &&
            s.className === e.className &&
            s.judged.startsWith("allowed"),
        ),
    ).map((e) => `site ${e.file} ${e.className}`),
    ...[...MAP_ALLOW_LIST, ...VERIFIED_STRING_KEYED]
      .filter(
        (e) =>
          !maps.some(
            (m) =>
              m.file === e.file && m.name === e.name && m.listed === e.reason,
          ),
      )
      .map((e) => `map ${e.file} ${e.name}`),
  ];
  return {
    sites: judgedSites,
    unjudgedSites: judgedSites
      .filter((s) => !s.judged)
      .map(({ judged: _, ...site }) => site),
    maps,
    unlistedMaps: maps
      .filter((m) => m.keyedBy !== "strings" && !m.listed)
      .map(({ listed: _, ...map }) => map),
    staleEntries,
  };
}

// --- Next's closure, and the host's ---

/** The URL pattern Next derives from a file's folder, or null when it is not routable. */
function patternOf(file: string): string | null {
  const segments: string[] = [];
  for (const segment of relative(appDirectory, file).split("/").slice(0, -1)) {
    if (/^\(.*\)$/u.test(segment) || segment.startsWith("@")) continue;
    if (segment.startsWith("_")) return null;
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function servedByTheHost(file: string): boolean {
  if (!file.endsWith("/route.ts")) return false;
  const pattern = patternOf(file);
  return (
    pattern !== null &&
    isUnderFamily(pattern) &&
    !FALLBACK_UNDER_FAMILY.some((entry) => entry.pattern === pattern)
  );
}

async function closureOf(entries: readonly string[]): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints: entries,
    // The metafile names its inputs relative to this directory.
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    outdir: join(root, ".boundary-contract-unwritten"),
    jsx: "automatic",
    logLevel: "silent",
    tsconfig: join(root, "apps/web/tsconfig.json"),
    loader: {
      ".css": "empty",
      ".svg": "empty",
      ".png": "empty",
      ".woff2": "empty",
      ".json": "json",
    },
    plugins: [
      {
        name: "external-third-party",
        setup(build: {
          onResolve(
            options: { filter: RegExp },
            callback: (args: {
              path: string;
            }) => { path: string; external: boolean } | undefined,
          ): void;
        }) {
          // esbuild's filter is a Go regular expression, which takes no `u` flag.
          build.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith("@requestport/")
              ? undefined
              : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  return Object.keys(result.metafile.inputs)
    .map((input) => relative(root, resolve(root, input)))
    .filter(
      (file) =>
        !file.includes("node_modules/") && /\.(?:tsx?|mts|m?js)$/u.test(file),
    )
    .sort();
}

const appFiles = readdirSync(appDirectory, {
  recursive: true,
  withFileTypes: true,
})
  .filter(
    (entry) =>
      entry.isFile() && /\.tsx?$/u.test(entry.name) && !isTest(entry.name),
  )
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
const appEntries = appFiles.filter((file) =>
  ENTRY_FILE.test(file.split("/").at(-1) ?? ""),
);
const nextEntries = [
  ...appEntries.filter((file) => !servedByTheHost(file)),
  join(root, "apps/web/src/instrumentation.ts"),
  join(root, "apps/web/src/proxy.ts"),
];
const hostEntries = appEntries.filter(servedByTheHost);

let nextClosure: string[] = [];
let hostClosure: string[] = [];
const sources = new Map<string, string>();
let verdict: Verdict;

beforeAll(async () => {
  [nextClosure, hostClosure] = await Promise.all([
    closureOf(nextEntries),
    closureOf(hostEntries),
  ]);
  for (const file of nextClosure)
    sources.set(file, readFileSync(join(root, file), "utf8"));
  verdict = judge(nextClosure, sources);
});

const show = (value: unknown) => JSON.stringify(value, null, 1);
/** What `after` holds that `before` does not, compared by value. */
const added = <T>(after: readonly T[], before: readonly T[]): T[] => {
  const seen = new Set(before.map((item) => JSON.stringify(item)));
  return after.filter((item) => !seen.has(JSON.stringify(item)));
};

describe("the closure Next serves under the self-host", () => {
  test("is every App Router entry but the host's routes, with instrumentation and the proxy, and reaches the two branded classes", () => {
    expect(hostEntries).toHaveLength(ROUTE_TABLE.length);
    expect(nextEntries).toHaveLength(
      appEntries.length - ROUTE_TABLE.length + 2,
    );
    expect(nextClosure).toEqual(
      expect.arrayContaining([
        "packages/domain/src/shared/errors.ts",
        "packages/server/src/input-limits.ts",
        "apps/web/src/lib/application-context.ts",
        "apps/web/src/lib/server-administration-actions.ts",
      ]),
    );
    expect(nextClosure).not.toContain("packages/server/src/host.ts");
  });

  test("covers every source file under apps/web/src/app, or lists it with why it is in neither closure", () => {
    const reached = new Set([...nextClosure, ...hostClosure]);
    const unreached = appFiles
      .map((file) => relative(root, file))
      .filter((file) => !reached.has(file));

    expect(unreached).toEqual(UNREACHED_APP_FILES.map((entry) => entry.file));
  });
});

describe("the boundary contract, on the literal source", () => {
  test("every instanceof is of a global, a branded class, a third-party class that holds across copies, or allowed with its reason", () => {
    expect(verdict.sites.length).toBeGreaterThan(0);
    expect(verdict.unjudgedSites, show(verdict.unjudgedSites)).toEqual([]);
  });

  test("every module-level map is shown keyed by strings, or allowed with its reason", () => {
    expect(verdict.maps.length).toBeGreaterThan(0);
    expect(verdict.unlistedMaps, show(verdict.unlistedMaps)).toEqual([]);
  });

  test("every list entry still names a site or a map the scan finds", () => {
    expect(verdict.staleEntries).toEqual([]);
  });

  test("counts every instanceof, zod's included (ruling 143), and Better Auth's APIError is read by name, never by class", () => {
    const named = (className: string) =>
      verdict.sites.filter((site) => site.className === className);

    expect(named("DomainError").every((s) => s.judged === "branded")).toBe(
      true,
    );
    expect(named("DomainError").length).toBeGreaterThan(0);
    expect(
      named("RequestTooLargeError").every((s) => s.judged === "branded"),
    ).toBe(true);
    expect(named("RequestTooLargeError").length).toBeGreaterThan(0);
    expect(
      named("ZodError").every((s) => s.judged === "holds across copies"),
    ).toBe(true);
    expect(named("ZodError").length).toBeGreaterThan(0);
    expect(
      verdict.sites.filter((site) => site.source === "better-auth"),
    ).toEqual([]);
  });

  test("every copy of zod the closure loads recognises every other copy's ZodError, and no Error that is only named so", async () => {
    const packageDirectories = new Set<string>();
    for (const file of nextClosure) {
      if (!/from\s+["']zod["']/u.test(sources.get(file) as string)) continue;
      let directory = dirname(createRequire(join(root, file)).resolve("zod"));
      while (!readdirSync(directory).includes("package.json"))
        directory = dirname(directory);
      packageDirectories.add(directory);
    }
    expect(packageDirectories.size).toBeGreaterThan(0);

    type Zod = {
      z: { string(): { parse(value: unknown): unknown } };
      ZodError: unknown;
    };
    const copies: { label: string; zod: Zod }[] = [];
    for (const directory of packageDirectories) {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as {
        version: string;
        exports: { ".": { import: string; require: string } };
      };
      const entry = manifest.exports["."];
      copies.push({
        label: `${manifest.version} (CommonJS)`,
        zod: createRequire(join(directory, "package.json"))(
          join(directory, entry.require),
        ) as Zod,
      });
      copies.push({
        label: `${manifest.version} (ES module)`,
        zod: (await import(
          pathToFileURL(join(directory, entry.import)).href
        )) as Zod,
      });
    }

    for (const thrower of copies) {
      let thrown: unknown;
      try {
        thrower.zod.z.string().parse(0);
      } catch (error) {
        thrown = error;
      }
      for (const checker of copies) {
        const ZodError = checker.zod.ZodError as new () => unknown;
        expect(
          thrown instanceof ZodError,
          `${thrower.label} → ${checker.label}`,
        ).toBe(true);
        expect(
          Object.assign(new Error("x"), {
            name: "ZodError",
            issues: [],
          }) instanceof ZodError,
        ).toBe(false);
      }
    }
    expect(new Set(copies.map((c) => c.zod.ZodError)).size).toBe(copies.length);
  });
});

describe("the contract fires on the real closure (each detector, once)", () => {
  function withoutStaticHasInstance(source: string, className: string): string {
    for (const { node } of walk(parse("errors.ts", source))) {
      if (
        (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
        nameOf(child(node, "id")) === className
      ) {
        const method = children(child(node, "body") as AstNode, "body").find(
          (member) =>
            member.static === true && isSymbolHasInstance(child(member, "key")),
        );
        if (method)
          return source.slice(0, method.start) + source.slice(method.end);
      }
    }
    return source;
  }

  test.each([
    ["DomainError", "packages/domain/src/shared/errors.ts"],
    ["RequestTooLargeError", "packages/server/src/input-limits.ts"],
  ])(
    "with %s's brand removed, every site of it is unjudged",
    (className, file) => {
      const original = sources.get(file) as string;
      const debranded = withoutStaticHasInstance(original, className);
      expect(debranded).not.toBe(original);

      const fired = judge(nextClosure, new Map(sources).set(file, debranded));
      const sitesOfIt = verdict.sites.filter(
        (site) => site.className === className,
      );

      expect(sitesOfIt.length).toBeGreaterThan(0);
      expect(added(fired.unjudgedSites, verdict.unjudgedSites)).toEqual(
        sitesOfIt.map(({ judged: _, ...site }) => site),
      );
    },
  );

  test("a planted unbranded class, and a planted third-party one, are unjudged", () => {
    const file = "apps/web/src/lib/application-context.ts";
    const planted = `${sources.get(file)}
import { PlantedThirdPartyError } from "planted-third-party";
class PlantedBoundaryError extends Error {}
export const isPlanted = (error: unknown) =>
  error instanceof PlantedBoundaryError || error instanceof PlantedThirdPartyError;
`;
    const fired = judge(nextClosure, new Map(sources).set(file, planted));

    expect(
      added(fired.unjudgedSites, verdict.unjudgedSites).map((s) => [
        s.file,
        s.className,
        s.origin,
      ]),
    ).toEqual([
      [file, "PlantedBoundaryError", "first-party"],
      [file, "PlantedThirdPartyError", "third-party"],
    ]);
  });

  test("planted object-keyed maps are unlisted: nested in an object, wrapped in a call, built later into a module binding, and a class's static field", () => {
    const file = "apps/web/src/lib/application-context.ts";
    const planted = `${sources.get(file)}
const plantedNested = { byStorage: new WeakMap<object, string>() };
const plantedWrapped = Object.freeze(new Map<object, string>());
let plantedLater: WeakMap<object, string> | undefined;
let plantedUntyped;
class PlantedHolder {
  static readonly held = new Set();
  readonly perInstance = new Map<object, string>();
}
export function plantedRead(key: object) {
  plantedLater ??= new WeakMap();
  plantedUntyped = new Map();
  const local = new WeakMap<object, string>();
  return [plantedNested, plantedWrapped, plantedLater.get(key), plantedUntyped, local, PlantedHolder];
}
`;
    const fired = judge(nextClosure, new Map(sources).set(file, planted));

    expect(
      added(fired.unlistedMaps, verdict.unlistedMaps).map((m) => [
        m.name,
        m.kind,
        m.keyedBy,
      ]),
    ).toEqual([
      ["plantedLater", "WeakMap", "objects"],
      ["plantedNested.byStorage", "WeakMap", "objects"],
      ["plantedWrapped", "Map", "not shown"],
      ["PlantedHolder.held", "Set", "not shown"],
      ["plantedUntyped", "Map", "not shown"],
    ]);
  });

  test("an entry that names nothing any more is reported", () => {
    const file = "packages/db/src/tenant-context.ts";
    const renamed = (sources.get(file) as string).replaceAll(
      "IsolatedReadEnd",
      "IsolatedReadFinished",
    );
    const fired = judge(nextClosure, new Map(sources).set(file, renamed));

    expect(added(fired.staleEntries, verdict.staleEntries)).toEqual([
      `site ${file} IsolatedReadEnd`,
    ]);
    expect(
      added(fired.unjudgedSites, verdict.unjudgedSites).map((s) => s.className),
    ).toEqual(["IsolatedReadFinished"]);
  });
});
