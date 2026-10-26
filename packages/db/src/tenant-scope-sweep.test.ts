/*
  Tenant-scope sweep: a static check that every query this package runs against
  a tenant-owned table carries that table's organisation predicate.

  What it checks, and what it does not:

  - "Tenant-owned" is read from the Drizzle schema at run time, not from a list.
    `organizations` is the root, keyed by `id`. A table with an
    `organizationId` column is direct, keyed by `organization_id`. A table with
    no such column but a single-column foreign key into a tenant table's
    primary key is indirect: it belongs to whatever that key points at.
    Everything else is global and not checked.
  - A query is every Drizzle builder chain (`select`/`selectDistinct`/
    `selectDistinctOn` with a `from`, `update`, `delete`) and every raw `sql`
    query scope, subqueries included, in the non-test source of
    packages/db/src outside schema/, test-support/ included. Inserts are not
    checked, upserts included: an insert has no predicate to look for, and
    where a tenant row references another, a composite `(organization_id, …)`
    foreign key refuses one in another organisation. The rows an insert reads
    are: the `select` of a raw `insert … select` (up to `on conflict` or
    `returning`) is a query scope, and a builder passed to `.select()` is a
    chain of its own.
  - A tenant source is anchored by a top-level conjunct of its WHERE, or of an
    inner join's ON, comparing its key with a value. It is linked to another
    source by a comparison the schema makes tenant-preserving: key with key; a
    composite `(organization_id, x)` foreign-key column with the primary key it
    references; two such columns referencing the same primary key; or an
    indirect table's key with its owner's. A source is scoped when it is
    anchored or linked to a scoped source. A left join's ON scopes only the
    table it joins.
  - Only a conjunct the sweep can see is unconditional counts: one inside
    `or(...)`, a conditional expression, a `let`, or an element `push`ed onto an
    array does not, and nor does any conjunct of a raw clause or parenthesised
    group that contains `or`, or a negated comparison. A predicate that is
    present but optional reads as missing.
  - A condition or table passed into a helper is followed to each call of that
    helper in the same file, and the helper's query is checked once per call;
    an exported helper is also checked as it stands, with nothing bound.
  - These shapes are reported as violations, never passed, because the sweep
    cannot read them: a builder source it cannot resolve (a parameter no call
    binds, or any call other than an inline `.as()` subquery); a right, full,
    cross or lateral builder join, and `$dynamic()`; a raw `right`, `full` or
    `cross join`; a raw table name the schema does not declare; the relational
    API (`….query.<table>.findFirst` or `findMany`); `sql.raw(…)`; any
    `$client`; and SQL text — a string, a template literal or a `+`
    concatenation, written in place or held in a `const` — passed to a method
    named `execute` or `query`.
  - Anything else is not reported, and not checked: SQL text that reaches a
    driver some other way, such as a string returned by a function and handed
    to `.execute`. A `sql` template, by contrast, is read where it is written,
    whatever it is later handed to.
  - The sweep checks that the predicate is there, not what its value is:
    `eq(requests.organizationId, input.organizationId)` passes whatever `input`
    holds. Whether the value is the caller's organisation is authorisation, and
    is tested where it is enforced. Nor does it follow control flow: an id
    checked by an earlier statement is still reported, and the ledger says so.
  - A column of a table that is neither a source of the query nor of a query
    enclosing it in the source text (a correlated fragment built by a helper)
    is assumed scoped when its table is tenant-owned, because the query that
    uses the fragment is swept in its own right. Each such assumption is
    listed at the end of this file, so a new one is a reviewed change.

  Every query that does not carry its predicate is listed, with the reason it
  may not, in tenant-scope-sweep.exceptions.ts, and the list is exact: an
  unlisted violation fails, and so does an entry that no longer occurs. The
  boundary tests at the end read the non-test source of apps/, packages/ and
  trigger/, outside this package and the Playwright suite in apps/web/tests.
  There they report each of the ways listed above `boundaryOffences` that a
  file could reach the database other than through a function this package
  exports, or through the functions outside it that the sweep models and
  follows. What they do not follow is listed above `databaseHandles`, and a
  query reached only through one of those forms is not reported. In the real
  tree they find only the E2E scenario hook, whose guard is pinned where its
  owner storage is opened (apps/web/src/lib/e2e-owner-storage.test.ts).
*/

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableColumns, is } from "drizzle-orm";
import {
  foreignKey,
  getTableConfig,
  PgTable,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { parseAst } from "vitest/node";

import { HOSTED_DRIVER_PACKAGES } from "./hosted-driver.js";
import * as schema from "./schema/index.js";
import {
  type TenantScopeException,
  tenantScopeExceptions,
} from "./tenant-scope-sweep.exceptions.js";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(sourceRoot, "..", "..", "..");

// ---------------------------------------------------------------------------
// The tenant model, read from the schema.

type TableKind = "root" | "direct" | "indirect" | "global";

interface ModelLink {
  column: string;
  target: string;
  targetColumn: string;
}

interface ModelTable {
  name: string;
  sqlName: string;
  kind: TableKind;
  key: string | null;
  columnsByKey: Map<string, string>;
  sqlColumns: Set<string>;
  links: ModelLink[];
}

interface TenantModel {
  byName: Map<string, ModelTable>;
  bySqlName: Map<string, ModelTable>;
}

function buildTenantModel(
  exports: Record<string, unknown> = schema,
): TenantModel {
  const tables = new Map<PgTable, string>();
  for (const [name, value] of Object.entries(exports)) {
    if (is(value, PgTable)) tables.set(value, name);
  }
  const byName = new Map<string, ModelTable>();
  const bySqlName = new Map<string, ModelTable>();
  for (const [table, name] of tables) {
    const config = getTableConfig(table);
    const columnsByKey = new Map<string, string>();
    for (const [key, column] of Object.entries(getTableColumns(table))) {
      columnsByKey.set(key, column.name);
    }
    const kind: TableKind =
      config.name === "organizations"
        ? "root"
        : columnsByKey.has("organizationId")
          ? "direct"
          : "global";
    const entry: ModelTable = {
      name,
      sqlName: config.name,
      kind,
      key:
        kind === "root" ? "id" : kind === "direct" ? "organization_id" : null,
      columnsByKey,
      sqlColumns: new Set(columnsByKey.values()),
      links: [],
    };
    byName.set(name, entry);
    bySqlName.set(config.name, entry);
  }
  const isPrimary = (table: PgTable, column: string) =>
    getTableConfig(table).columns.some(
      (candidate) => candidate.name === column && candidate.primary,
    );
  for (const [table, name] of tables) {
    const entry = byName.get(name) as ModelTable;
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const reference = foreignKey.reference();
      const targetName = tables.get(reference.foreignTable);
      const target = targetName ? byName.get(targetName) : undefined;
      if (!target || target.kind === "global") continue;
      const columns = reference.columns.map((column) => column.name);
      const foreign = reference.foreignColumns.map((column) => column.name);
      let column: string | undefined;
      let targetColumn: string | undefined;
      if (entry.kind === "direct" && columns.length === 2) {
        const organization = columns.indexOf("organization_id");
        if (organization >= 0 && foreign[organization] === "organization_id") {
          column = columns[1 - organization];
          targetColumn = foreign[1 - organization];
        }
      } else if (entry.kind === "global" && columns.length === 1) {
        column = columns[0];
        targetColumn = foreign[0];
      }
      if (
        column &&
        targetColumn &&
        isPrimary(reference.foreignTable, targetColumn)
      ) {
        entry.links.push({ column, target: target.name, targetColumn });
      }
    }
  }
  for (const entry of byName.values()) {
    if (entry.kind === "global" && entry.links.length > 0) {
      entry.kind = "indirect";
    }
  }
  return { byName, bySqlName };
}

// ---------------------------------------------------------------------------
// The query IR.

type Operand =
  | { kind: "column"; names: string[]; table: string; column: string }
  | { kind: "value" }
  | { kind: "unknown" };

interface Span {
  start: number;
  end: number;
}

interface Removal extends Span {
  text: string;
}

interface Source {
  /** What a violation calls this source. */
  ref: string;
  /** Every name a column reference may use for it. */
  names: string[];
  table: string;
  join?: "inner" | "left";
}

interface Comparison {
  left: Operand;
  right: Operand;
  /** A left join's ON clause scopes only the source it joins. */
  only?: Source | "none";
  span: Span;
  /**
    The text that deletes this conjunct, a separator included, and what
    replaces it: `undefined` where an expression must remain.
  */
  removal: Removal;
}

interface Query {
  file: string;
  fn: string;
  line: number;
  start: number;
  end: number;
  /** `unmodelled` stands for a shape the sweep reports without reading. */
  kind: "builder" | "raw" | "unmodelled";
  sources: Source[];
  comparisons: Comparison[];
  parent?: Query;
  problems: string[];
}

interface Violation {
  file: string;
  fn: string;
  table: string;
  line: number;
  reason: string;
}

interface Analysis {
  queries: Query[];
  violations: Violation[];
  /** `file › fn › table` for each outer table assumed scoped. */
  assumptions: string[];
}

// ---------------------------------------------------------------------------
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

function field(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return isNode(value) ? value : undefined;
}

function list(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function nameOf(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

function unwrap(node: AstNode): AstNode {
  let current = node;
  for (;;) {
    const inner =
      current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "ParenthesizedExpression"
        ? field(current, "expression")
        : current.type === "AwaitExpression"
          ? field(current, "argument")
          : undefined;
    if (!inner) return current;
    current = inner;
  }
}

function isSqlTemplate(node: AstNode): boolean {
  return (
    node.type === "TaggedTemplateExpression" &&
    nameOf(field(node, "tag")) === "sql"
  );
}

function isFunction(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function paramName(param: AstNode): string | undefined {
  if (param.type === "AssignmentPattern") return nameOf(field(param, "left"));
  return nameOf(param);
}

// ---------------------------------------------------------------------------
// Raw SQL tokens.

type Token =
  | { t: "word"; v: string; start: number; end: number }
  | { t: "ident"; v: string; start: number; end: number }
  | { t: "punct"; v: string; start: number; end: number }
  | { t: "literal"; start: number; end: number }
  | {
      t: "table";
      ref: string;
      names: string[];
      table: string;
      start: number;
      end: number;
    }
  | {
      t: "column";
      names: string[];
      table: string;
      column: string;
      start: number;
      end: number;
    }
  | { t: "value"; start: number; end: number }
  | { t: "unknown"; start: number; end: number };

interface Group {
  t: "group";
  items: Item[];
  start: number;
  end: number;
}

type Item = Token | Group;

const lexeme =
  /\s+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?)|(::|<>|!=|<=|>=|\|\||[=<>(),.;+\-*/%[\]])/gu;

function isWord(item: Item | undefined, ...words: string[]): boolean {
  return item !== undefined && item.t === "word" && words.includes(item.v);
}

function isPunct(item: Item | undefined, value: string): boolean {
  return item !== undefined && item.t === "punct" && item.v === value;
}

function isName(
  item: Item | undefined,
): item is Extract<Token, { t: "word" | "ident" }> {
  return item !== undefined && (item.t === "word" || item.t === "ident");
}

function isQueryGroup(items: Item[]): boolean {
  return isWord(items[0], "select", "with", "update", "delete", "insert");
}

const joinWords = new Set(["join", "inner", "left", "right", "full", "cross"]);
const clauseWords = new Set([
  ...joinWords,
  "select",
  "from",
  "where",
  "on",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "for",
  "returning",
  "set",
  "update",
  "delete",
  "insert",
  "values",
  "window",
  "using",
]);
const notAlias = new Set([...clauseWords, "as", "lateral", "natural"]);

function groupTokens(tokens: Token[], start: number, end: number): Group {
  const root: Group = { t: "group", items: [], start, end };
  const stack: Group[] = [root];
  for (const token of tokens) {
    const top = stack[stack.length - 1] as Group;
    if (isPunct(token, "(")) {
      const next: Group = {
        t: "group",
        items: [],
        start: token.start,
        end: token.end,
      };
      top.items.push(next);
      stack.push(next);
    } else if (isPunct(token, ")") && stack.length > 1) {
      top.end = token.end;
      stack.pop();
    } else {
      top.items.push(token);
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Analysing one file.

const joinMethods = new Map<string, "inner" | "left">([
  ["innerJoin", "inner"],
  ["leftJoin", "left"],
]);
const unsupportedMethods = new Set([
  "rightJoin",
  "fullJoin",
  "crossJoin",
  "innerJoinLateral",
  "leftJoinLateral",
  "crossJoinLateral",
  "$dynamic",
]);
const rootMethods = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "update",
  "delete",
]);

interface Binding {
  node: AstNode;
  context: Context;
}

interface Context {
  bindings: Map<string, Binding>;
  depth: number;
}

const rootContext: Context = { bindings: new Map(), depth: 0 };

function analyseSource(
  file: string,
  text: string,
  model: TenantModel,
): Analysis {
  const program = parseAst(text, { lang: "ts" }) as unknown as AstNode;
  const parents = new Map<AstNode, AstNode>();
  const all: AstNode[] = [];
  const visit = (node: AstNode) => {
    all.push(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) {
          parents.set(child, node);
          visit(child);
        }
      }
    }
  };
  visit(program);
  const lineStarts = [0];
  for (
    let index = text.indexOf("\n");
    index >= 0;
    index = text.indexOf("\n", index + 1)
  ) {
    lineStarts.push(index + 1);
  }
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] as number) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  // Local names for tables: schema imports, then `alias(table, "name")`,
  // whose columns render as `"name"."column"`.
  const tables = new Map<string, string>();
  const sqlNames = new Map<string, string>();
  const subqueries = new Set<string>();
  for (const node of list(program, "body")) {
    if (node.type !== "ImportDeclaration") continue;
    const from = field(node, "source")?.value;
    if (
      typeof from !== "string" ||
      !/(^|\/)schema(\/[\w-]+)?(\.js)?$/u.test(from)
    ) {
      continue;
    }
    for (const specifier of list(node, "specifiers")) {
      const imported = nameOf(field(specifier, "imported"));
      const local = nameOf(field(specifier, "local"));
      const table = imported ? model.byName.get(imported) : undefined;
      if (specifier.type === "ImportSpecifier" && table && local) {
        tables.set(local, table.name);
        sqlNames.set(local, table.sqlName);
      }
    }
  }
  for (const node of all) {
    if (node.type !== "VariableDeclarator") continue;
    const id = nameOf(field(node, "id"));
    const init = field(node, "init");
    if (!id || !init) continue;
    const value = unwrap(init);
    if (value.type !== "CallExpression") continue;
    const callee = field(value, "callee") as AstNode;
    const args = list(value, "arguments");
    if (nameOf(callee) === "alias") {
      const table = tables.get(nameOf(args[0]) ?? "");
      const aliasName = nameOf(args[1]);
      if (table && aliasName) {
        tables.set(id, table);
        sqlNames.set(id, aliasName);
      }
    } else if (
      callee.type === "MemberExpression" &&
      nameOf(field(callee, "property")) === "as"
    ) {
      subqueries.add(id);
    }
  }

  function functionPath(node: AstNode): string {
    const names: string[] = [];
    for (
      let current: AstNode | undefined = node;
      current;
      current = parents.get(current)
    ) {
      const parent = parents.get(current);
      let name: string | undefined;
      if (current.type === "FunctionDeclaration") {
        name = nameOf(field(current, "id"));
      } else if (isFunction(current) && parent) {
        if (parent.type === "Property" || parent.type === "MethodDefinition") {
          name = nameOf(field(parent, "key"));
        } else if (parent.type === "VariableDeclarator") {
          name = nameOf(field(parent, "id"));
        }
      }
      if (name) names.push(name);
    }
    return names.length ? names.reverse().join(".") : "<module>";
  }

  function lookupIdentifier(
    name: string,
    from: AstNode,
    context: Context,
  ): Binding | undefined {
    const bound = context.bindings.get(name);
    if (bound) return bound;
    for (
      let current: AstNode | undefined = from;
      current;
      current = parents.get(current)
    ) {
      if (current.type !== "BlockStatement" && current.type !== "Program") {
        continue;
      }
      for (const statement of list(current, "body")) {
        const declaration =
          statement.type === "ExportNamedDeclaration"
            ? field(statement, "declaration")
            : statement;
        if (
          declaration?.type !== "VariableDeclaration" ||
          declaration.kind !== "const"
        ) {
          continue;
        }
        for (const declarator of list(declaration, "declarations")) {
          const init = field(declarator, "init");
          if (nameOf(field(declarator, "id")) === name && init) {
            return { node: init, context };
          }
        }
      }
    }
    return undefined;
  }

  /** Follows identifiers to what they are bound to. */
  function resolve(node: AstNode, context: Context): Binding {
    let current: Binding = { node: unwrap(node), context };
    for (let step = 0; step < 8 && current.node.type === "Identifier"; step++) {
      const next = lookupIdentifier(
        current.node.name as string,
        current.node,
        current.context,
      );
      if (!next) break;
      current = { node: unwrap(next.node), context: next.context };
    }
    return current;
  }

  function isUnboundParameter(node: AstNode, context: Context): boolean {
    const value = unwrap(node);
    if (value.type !== "Identifier") return false;
    const name = value.name as string;
    if (context.bindings.has(name) || lookupIdentifier(name, value, context)) {
      return false;
    }
    for (
      let current = parents.get(value);
      current;
      current = parents.get(current)
    ) {
      if (
        isFunction(current) &&
        list(current, "params").some((param) => paramName(param) === name)
      ) {
        return true;
      }
    }
    return false;
  }

  const functions = new Map<string, AstNode>();
  const callsByName = new Map<string, AstNode[]>();
  for (const node of all) {
    const id = nameOf(field(node, "id"));
    const init = field(node, "init");
    if (node.type === "FunctionDeclaration" && id && !functions.has(id)) {
      functions.set(id, node);
    } else if (
      node.type === "VariableDeclarator" &&
      id &&
      init &&
      isFunction(init) &&
      !functions.has(id)
    ) {
      functions.set(id, init);
    } else if (
      node.type === "CallExpression" &&
      field(node, "callee")?.type === "Identifier"
    ) {
      const callee = nameOf(field(node, "callee")) as string;
      callsByName.set(callee, [...(callsByName.get(callee) ?? []), node]);
    }
  }
  const localFunction = (name: string) => functions.get(name);

  function returnedExpression(fn: AstNode): AstNode | undefined {
    const body = field(fn, "body");
    if (!body) return undefined;
    if (body.type !== "BlockStatement") return body;
    const returns: AstNode[] = [];
    const walk = (node: AstNode) => {
      if (node !== fn && isFunction(node)) return;
      if (node.type === "ReturnStatement") returns.push(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        for (const child of Array.isArray(value) ? value : [value]) {
          if (isNode(child)) walk(child);
        }
      }
    };
    walk(body);
    return returns.length === 1
      ? field(returns[0] as AstNode, "argument")
      : undefined;
  }

  function tableOf(
    node: AstNode,
    context: Context,
  ): { ref: string; names: string[]; table: string } | undefined {
    const value = unwrap(node);
    if (value.type !== "Identifier") return undefined;
    const name = value.name as string;
    const bound = context.bindings.get(name);
    if (bound) return tableOf(bound.node, bound.context);
    const table = tables.get(name);
    if (!table) return undefined;
    return {
      ref: name,
      names: [name, sqlNames.get(name) as string],
      table,
    };
  }

  function operandOf(node: AstNode, context: Context): Operand {
    const value = unwrap(node);
    if (value.type === "MemberExpression" && !value.computed) {
      const object = field(value, "object") as AstNode;
      const property = nameOf(field(value, "property"));
      const owner = tableOf(object, context);
      if (owner && property) {
        const column = model.byName
          .get(owner.table)
          ?.columnsByKey.get(property);
        return column
          ? { kind: "column", names: owner.names, table: owner.table, column }
          : { kind: "unknown" };
      }
      const objectName = nameOf(unwrap(object));
      if (objectName && subqueries.has(objectName)) return { kind: "unknown" };
      return { kind: "value" };
    }
    if (value.type === "Identifier") {
      const binding = lookupIdentifier(value.name as string, value, context);
      if (binding && binding.context.depth < 8) {
        return operandOf(binding.node, {
          ...binding.context,
          depth: binding.context.depth + 1,
        });
      }
      return { kind: "value" };
    }
    if (isSqlTemplate(value)) return { kind: "unknown" };
    return { kind: "value" };
  }

  const queries: Query[] = [];
  const consumed = new Set<AstNode>();
  /** CTE names visible to the raw scope being read. */
  const cteStack: Set<string>[] = [];

  // --- builder chains ------------------------------------------------------

  interface Link {
    name: string;
    args: AstNode[];
    call: AstNode;
  }

  function chainFrom(rootCall: AstNode): Link[] {
    const links: Link[] = [];
    let call = rootCall;
    for (;;) {
      const callee = field(call, "callee") as AstNode;
      links.push({
        name: nameOf(field(callee, "property")) as string,
        args: list(call, "arguments"),
        call,
      });
      const member = parents.get(call);
      const next = member ? parents.get(member) : undefined;
      if (
        member?.type !== "MemberExpression" ||
        member.object !== call ||
        next?.type !== "CallExpression" ||
        next.callee !== member
      ) {
        return links;
      }
      call = next;
    }
  }

  function removalInList(items: AstNode[], index: number): Removal {
    const item = items[index] as AstNode;
    const next = items[index + 1];
    if (next) return { start: item.start, end: next.start, text: "" };
    const previous = items[index - 1];
    if (previous) return { start: previous.end, end: item.end, text: "" };
    return { start: item.start, end: item.end, text: "undefined" };
  }

  interface Walk {
    query: Query;
    unbound: boolean;
  }

  function addConjuncts(
    expression: AstNode,
    context: Context,
    walk: Walk,
    only: Comparison["only"],
    removal: Removal,
  ) {
    if (context.depth > 8) return;
    const value = unwrap(expression);
    const { query } = walk;
    if (value.type === "CallExpression") {
      const callee = field(value, "callee") as AstNode;
      const name = callee.type === "Identifier" ? nameOf(callee) : undefined;
      const args = list(value, "arguments");
      if (name === "and") {
        args.forEach((argument, index) => {
          if (argument.type !== "SpreadElement") {
            addConjuncts(
              argument,
              context,
              walk,
              only,
              removalInList(args, index),
            );
            return;
          }
          const spread = field(argument, "argument") as AstNode;
          const array = resolve(spread, context);
          if (array.node.type === "ArrayExpression") {
            const elements = list(array.node, "elements");
            elements.forEach((element, elementIndex) => {
              addConjuncts(
                element,
                array.context,
                walk,
                only,
                removalInList(elements, elementIndex),
              );
            });
          } else if (isUnboundParameter(array.node, array.context)) {
            walk.unbound = true;
          }
        });
        return;
      }
      if ((name === "eq" || name === "inArray") && args.length === 2) {
        query.comparisons.push({
          left: operandOf(args[0] as AstNode, context),
          right:
            name === "eq"
              ? operandOf(args[1] as AstNode, context)
              : { kind: "value" },
          only,
          span: { start: value.start, end: value.end },
          removal,
        });
        return;
      }
      const fn = name ? localFunction(name) : undefined;
      const returned = fn ? returnedExpression(fn) : undefined;
      if (fn && returned) {
        const bindings = new Map<string, Binding>();
        list(fn, "params").forEach((param, index) => {
          const parameter = paramName(param);
          const argument = args[index];
          if (parameter && argument) {
            bindings.set(parameter, { node: argument, context });
          }
        });
        addConjuncts(
          returned,
          { bindings, depth: context.depth + 1 },
          walk,
          only,
          removal,
        );
      }
      return;
    }
    if (value.type === "Identifier") {
      const binding = lookupIdentifier(value.name as string, value, context);
      if (binding) {
        addConjuncts(
          binding.node,
          { ...binding.context, depth: binding.context.depth + 1 },
          walk,
          only,
          removal,
        );
      } else if (isUnboundParameter(value, context)) {
        walk.unbound = true;
      }
      return;
    }
    if (isSqlTemplate(value)) {
      consumed.add(value);
      const root = groupTokens(
        tokenize(value, context),
        value.start,
        value.end,
      );
      if (isQueryGroup(root.items)) {
        readScope(root.items, query, value);
      } else {
        clauseConjuncts(root.items, query, only, value);
      }
    }
  }

  function addSource(
    node: AstNode | undefined,
    context: Context,
    walk: Walk,
    join?: "inner" | "left",
  ): Source | undefined {
    if (!node) {
      walk.query.problems.push("a query source is missing");
      return undefined;
    }
    const table = tableOf(node, context);
    if (table) {
      const source: Source = { ...table, join };
      walk.query.sources.push(source);
      return source;
    }
    const value = unwrap(node);
    const name = nameOf(value);
    if (name && subqueries.has(name)) return undefined;
    // An inline `.as()` subquery is a builder chain of its own, swept as one.
    // Any other call is a source the sweep cannot see into.
    const callee = value.type === "CallExpression" && field(value, "callee");
    if (
      callee &&
      callee.type === "MemberExpression" &&
      nameOf(field(callee, "property")) === "as"
    ) {
      return undefined;
    }
    if (isUnboundParameter(value, context)) walk.unbound = true;
    walk.query.problems.push(
      `unresolved query source \`${text.slice(value.start, value.end)}\``,
    );
    return undefined;
  }

  const builderRanges: Array<{ query: Query; start: number; end: number }> = [];
  const enclosing = (start: number, end: number): Query | undefined => {
    let found: { query: Query; start: number; end: number } | undefined;
    for (const range of builderRanges) {
      if (range.start <= start && end <= range.end) {
        if (!found || range.start >= found.start) found = range;
      }
    }
    return found?.query;
  };

  function readChain(
    links: Link[],
    context: Context,
    attribution: { fn: string; line: number },
  ): Walk {
    const root = links[0] as Link;
    const last = links[links.length - 1] as Link;
    const query: Query = {
      file,
      fn: attribution.fn,
      line: attribution.line,
      start: root.call.start,
      end: last.call.end,
      kind: "builder",
      sources: [],
      comparisons: [],
      parent: enclosing(root.call.start, last.call.end),
      problems: [],
    };
    const walk: Walk = { query, unbound: false };
    if (root.name === "update" || root.name === "delete") {
      addSource(root.args[0], context, walk);
    }
    for (const link of links.slice(1)) {
      if (link.name === "from") {
        addSource(link.args[0], context, walk);
      } else if (joinMethods.has(link.name)) {
        const kind = joinMethods.get(link.name) as "inner" | "left";
        const source = addSource(link.args[0], context, walk, kind);
        const on = link.args[1];
        if (on) {
          addConjuncts(
            on,
            context,
            walk,
            kind === "left" ? (source ?? "none") : undefined,
            { start: on.start, end: on.end, text: "undefined" },
          );
        }
      } else if (unsupportedMethods.has(link.name)) {
        query.problems.push(`\`${link.name}\` is not modelled by the sweep`);
      } else if (link.name === "where" && link.args[0]) {
        const condition = link.args[0];
        addConjuncts(condition, context, walk, undefined, {
          start: condition.start,
          end: condition.end,
          text: "undefined",
        });
      }
    }
    return walk;
  }

  const chainRoots = all
    .filter((node) => {
      if (node.type !== "CallExpression") return false;
      const callee = field(node, "callee");
      if (callee?.type !== "MemberExpression" || callee.computed) return false;
      const method = nameOf(field(callee, "property")) ?? "";
      if (!rootMethods.has(method)) return false;
      const links = chainFrom(node);
      if (method === "update" || method === "delete") {
        // `hash.update(…)` and `map.delete(…)` are not queries: a query
        // names a table, or takes one from its caller and filters it.
        const target = list(node, "arguments")[0];
        if (!target) return false;
        if (tableOf(target, rootContext)) return true;
        return (
          isUnboundParameter(target, rootContext) &&
          links.some((link) => link.name === "set" || link.name === "where")
        );
      }
      return links.some((link) => link.name === "from");
    })
    .sort((left, right) => left.start - right.start);

  // Shapes that reach the database without a builder chain or a `sql`
  // template the sweep can read. Each is reported where it appears.
  const unmodelled = (node: AstNode, reason: string) => {
    queries.push({
      file,
      fn: functionPath(node),
      line: lineOf(node.start),
      start: node.start,
      end: node.end,
      kind: "unmodelled",
      sources: [],
      comparisons: [],
      problems: [`${reason} is not modelled by the sweep`],
    });
  };
  const isSqlText = (node: AstNode): boolean => {
    const value = resolve(node, rootContext).node;
    return (
      (value.type === "Literal" && typeof value.value === "string") ||
      value.type === "TemplateLiteral" ||
      (value.type === "BinaryExpression" && value.operator === "+")
    );
  };
  for (const node of all) {
    if (node.type === "MemberExpression" && !node.computed) {
      if (nameOf(field(node, "property")) === "$client") {
        unmodelled(node, "`$client`");
      }
      continue;
    }
    if (node.type !== "CallExpression") continue;
    const callee = field(node, "callee") as AstNode;
    if (callee.type !== "MemberExpression") continue;
    const method = callee.computed
      ? undefined
      : nameOf(field(callee, "property"));
    const object = field(callee, "object") as AstNode;
    const argument = list(node, "arguments")[0];
    if (method === "raw" && nameOf(object) === "sql") {
      unmodelled(node, "`sql.raw`");
    } else if (
      (method === "findFirst" || method === "findMany") &&
      object.type === "MemberExpression" &&
      field(object, "object")?.type === "MemberExpression" &&
      nameOf(field(field(object, "object") as AstNode, "property")) === "query"
    ) {
      unmodelled(
        node,
        `the relational query API (\`${text.slice(callee.start, callee.end)}\`)`,
      );
    } else if (
      (method === "execute" || method === "query") &&
      argument &&
      isSqlText(argument)
    ) {
      unmodelled(node, `SQL text passed to \`${method}\``);
    }
  }

  for (const rootCall of chainRoots) {
    const links = chainFrom(rootCall);
    const attribution = {
      fn: functionPath(rootCall),
      line: lineOf(rootCall.start),
    };
    const first = readChain(links, rootContext, attribution);
    // A helper handed its condition or its table: check it once per call.
    let helper: AstNode | undefined;
    for (
      let current = parents.get(rootCall);
      current && !helper;
      current = parents.get(current)
    ) {
      if (isFunction(current)) helper = current;
    }
    const helperName = helper
      ? helper.type === "FunctionDeclaration"
        ? nameOf(field(helper, "id"))
        : parents.get(helper)?.type === "VariableDeclarator"
          ? nameOf(field(parents.get(helper) as AstNode, "id"))
          : undefined
      : undefined;
    const declaration = helper
      ? helper.type === "FunctionDeclaration"
        ? parents.get(helper)
        : parents.get(parents.get(parents.get(helper) as AstNode) as AstNode)
      : undefined;
    // An exported helper can be called from elsewhere with anything, so its
    // own unbound reading stands as well.
    const exported = declaration?.type === "ExportNamedDeclaration";
    const calls =
      first.unbound && helper && helperName
        ? (callsByName.get(helperName) ?? [])
        : [];
    if (calls.length === 0 || exported) {
      queries.push(first.query);
      builderRanges.push({
        query: first.query,
        start: first.query.start,
        end: first.query.end,
      });
      if (calls.length === 0) continue;
    }
    for (const call of calls) {
      const bindings = new Map<string, Binding>();
      const args = list(call, "arguments");
      list(helper as AstNode, "params").forEach((param, index) => {
        const parameter = paramName(param);
        const argument = args[index];
        if (parameter && argument) {
          bindings.set(parameter, { node: argument, context: rootContext });
        }
      });
      const walk = readChain(
        links,
        { bindings, depth: 1 },
        {
          fn: `${functionPath(call)} → ${helperName}`,
          line: lineOf(call.start),
        },
      );
      queries.push(walk.query);
      builderRanges.push({
        query: walk.query,
        start: walk.query.start,
        end: walk.query.end,
      });
    }
    if (exported) continue;
    // The unbound read's raw scopes belong to no call: drop them.
    const within = (query: Query) => {
      for (let outer = query.parent; outer; outer = outer.parent) {
        if (outer === first.query) return true;
      }
      return false;
    };
    for (let index = queries.length - 1; index >= 0; index--) {
      if (within(queries[index] as Query)) queries.splice(index, 1);
    }
  }

  // --- raw SQL -------------------------------------------------------------

  function tokenize(template: AstNode, context: Context): Token[] {
    const tokens: Token[] = [];
    const quasi = field(template, "quasi") as AstNode;
    const quasis = list(quasi, "quasis");
    const expressions = list(quasi, "expressions");
    quasis.forEach((element, index) => {
      const raw = (element.value as { raw: string }).raw;
      const base = element.start + 1;
      for (const match of raw.matchAll(lexeme)) {
        const start = base + (match.index ?? 0);
        const end = start + match[0].length;
        const word = match[0];
        if (/^(\s|--|\/\*)/u.test(word)) continue;
        if (word.startsWith("'") || match[3] !== undefined) {
          tokens.push({ t: "literal", start, end });
        } else if (match[1] !== undefined) {
          tokens.push({ t: "ident", v: match[1], start, end });
        } else if (match[2] !== undefined) {
          tokens.push({ t: "word", v: match[2].toLowerCase(), start, end });
        } else {
          tokens.push({ t: "punct", v: word, start, end });
        }
      }
      const expression = expressions[index];
      if (!expression) return;
      const value = unwrap(expression);
      // The token covers its `${` and `}`, so deleting it leaves no stray brace.
      const start = text.lastIndexOf("${", expression.start);
      const end = text.indexOf("}", expression.end) + 1;
      if (isSqlTemplate(value)) {
        consumed.add(value);
        tokens.push(...tokenize(value, context));
        return;
      }
      const table = tableOf(value, context);
      if (table) {
        tokens.push({ t: "table", ...table, start, end });
        return;
      }
      const operand = operandOf(value, context);
      if (operand.kind === "column") {
        tokens.push({ t: "column", ...operand, start, end });
      } else {
        tokens.push({ t: operand.kind, start, end });
      }
    });
    return tokens;
  }

  function nestedScopes(
    items: Item[],
    parent: Query | undefined,
    template: AstNode,
  ) {
    for (const item of items) {
      if (item.t !== "group") continue;
      if (isQueryGroup(item.items)) readScope(item.items, parent, template);
      else nestedScopes(item.items, parent, template);
    }
  }

  function readScope(
    items: Item[],
    parent: Query | undefined,
    template: AstNode,
  ) {
    const parts: Item[][] = [[]];
    for (const item of items) {
      if (isWord(item, "union", "except", "intersect")) parts.push([]);
      else (parts[parts.length - 1] as Item[]).push(item);
    }
    for (const part of parts) {
      while (isWord(part[0], "all", "distinct")) part.shift();
      readSingleScope(part, parent, template);
    }
  }

  function readSingleScope(
    items: Item[],
    parent: Query | undefined,
    template: AstNode,
  ) {
    const first = items[0];
    const outside =
      parent && (template.start < parent.start || template.end > parent.end);
    const query: Query = {
      file,
      // A fragment built by a helper and read inside a builder query is
      // charged to that query, where the helper was called.
      fn: outside ? parent.fn : functionPath(template),
      line: outside ? parent.line : lineOf(first?.start ?? template.start),
      start: first?.start ?? template.start,
      end: items.at(-1)?.end ?? template.end,
      kind: "raw",
      sources: [],
      comparisons: [],
      parent,
      problems: [],
    };
    const ctes = new Set<string>();
    cteStack.push(ctes);
    try {
      let index = 0;
      if (isWord(items[0], "with")) {
        index = 1;
        if (isWord(items[index], "recursive")) index += 1;
        while (index < items.length) {
          const name = items[index];
          if (isName(name)) ctes.add(name.v);
          index += 1;
          if (isWord(items[index], "as")) index += 1;
          while (isWord(items[index], "not", "materialized")) index += 1;
          const body = items[index];
          if (body?.t === "group") {
            if (isQueryGroup(body.items))
              readScope(body.items, parent, template);
            index += 1;
          }
          if (!isPunct(items[index], ",")) break;
          index += 1;
        }
      }
      const rest = items.slice(index);
      if (isWord(rest[0], "insert")) {
        // `insert … select …` reads rows like any select: that select runs
        // up to `on conflict` or `returning`, and is a scope of its own.
        const select = rest.findIndex((item) => isWord(item, "select"));
        if (select < 0) {
          nestedScopes(rest, query, template);
          return;
        }
        let end = select + 1;
        while (
          end < rest.length &&
          !isWord(rest[end], "returning") &&
          !(isWord(rest[end], "on") && isWord(rest[end + 1], "conflict"))
        ) {
          end += 1;
        }
        nestedScopes(rest.slice(0, select), query, template);
        readScope(rest.slice(select, end), query, template);
        nestedScopes(rest.slice(end), query, template);
        return;
      }
      queries.push(query);
      readStatement(rest, query, template);
    } finally {
      cteStack.pop();
    }
  }

  function readStatement(rest: Item[], query: Query, template: AstNode) {
    const isCte = (name: string) => cteStack.some((set) => set.has(name));
    let clause = "select";
    let clauseItems: Item[] = [];
    let onlySource: Comparison["only"];
    const flush = () => {
      if (clause === "where" || clause === "on") {
        clauseConjuncts(
          clauseItems,
          query,
          clause === "on" ? onlySource : undefined,
          template,
        );
      }
      clauseItems = [];
    };
    // A scalar subquery in the select list can name a source read after it,
    // so subqueries are read once every source is known.
    const deferred: Array<() => void> = [];
    const readSource = (at: number, join?: "inner" | "left") => {
      let position = at;
      const item = rest[position];
      if (!item) return position;
      let source: Source | undefined;
      const called = rest[position + 1]?.t === "group";
      // A call to a definer function in `requestport_private` (Plan 13, I.2;
      // manifest-i2.md §2.5.0) is not a table: it reads under its own rules,
      // which the row-security tests hold it to. An uncalled name there is
      // still an unknown raw source.
      const definerCall =
        isName(item) &&
        item.v === "requestport_private" &&
        rest[position + 1]?.t === "punct" &&
        (rest[position + 1] as { v: string }).v === "." &&
        isName(rest[position + 2]) &&
        rest[position + 3]?.t === "group";
      if (definerCall) {
        position += 4;
        if (isWord(rest[position], "as")) position += 1;
        const alias = rest[position];
        if (
          alias &&
          (alias.t === "ident" ||
            (alias.t === "word" && !notAlias.has(alias.v)))
        ) {
          position += 1;
        }
        return position;
      }
      if (item.t === "table") {
        source = { ref: item.ref, names: item.names, table: item.table, join };
      } else if (isName(item) && !called && !isCte(item.v)) {
        const table = model.bySqlName.get(item.v);
        if (table) {
          source = {
            ref: item.v,
            names: [item.v],
            table: table.name,
            join,
          };
        } else {
          query.problems.push(`unknown raw source \`${item.v}\``);
        }
      } else if (item.t === "group" && isQueryGroup(item.items)) {
        deferred.push(() => readScope(item.items, query, template));
      }
      position += called ? 2 : 1;
      if (isWord(rest[position], "as")) position += 1;
      const alias = rest[position];
      if (
        alias &&
        (alias.t === "ident" || (alias.t === "word" && !notAlias.has(alias.v)))
      ) {
        if (source) {
          source.ref = alias.v;
          source.names = [alias.v];
        }
        position += 1;
      }
      if (source) {
        query.sources.push(source);
        onlySource = join === "left" ? source : undefined;
      }
      return position;
    };

    let position = 0;
    while (position < rest.length) {
      const item = rest[position] as Item;
      const distinctFrom =
        isWord(item, "from") && isWord(rest[position - 1], "distinct");
      if (item.t === "word" && clauseWords.has(item.v) && !distinctFrom) {
        flush();
        if (item.v === "for") {
          // `for update` / `for share` [of …] [nowait | skip locked] ends it.
          break;
        }
        if (item.v === "from") {
          clause = "from";
          position = readSource(position + 1);
          while (isPunct(rest[position], ",")) {
            position = readSource(position + 1);
          }
          continue;
        }
        if (joinWords.has(item.v)) {
          if (item.v === "right" || item.v === "full" || item.v === "cross") {
            query.problems.push(
              `\`${item.v} join\` is not modelled by the sweep`,
            );
          }
          let next = position;
          while (next < rest.length && !isWord(rest[next], "join")) next += 1;
          next += 1;
          if (isWord(rest[next], "lateral")) {
            const body = rest[next + 1];
            if (body?.t === "group" && isQueryGroup(body.items)) {
              deferred.push(() => readScope(body.items, query, template));
            }
            next += 2;
            if (isWord(rest[next], "as")) next += 1;
            const alias = rest[next];
            if (isName(alias) && !notAlias.has(alias.v)) next += 1;
            clause = "lateral";
            onlySource = "none";
            position = next;
            continue;
          }
          position = readSource(next, item.v === "left" ? "left" : "inner");
          clause = "join";
          continue;
        }
        if (item.v === "update") {
          position = readSource(position + 1);
          clause = "update";
          continue;
        }
        if (item.v === "delete") {
          const next = isWord(rest[position + 1], "from")
            ? position + 2
            : position + 1;
          position = readSource(next);
          clause = "delete";
          continue;
        }
        clause = item.v;
        position += item.v === "group" || item.v === "order" ? 2 : 1;
        continue;
      }
      if (
        item.t === "group" &&
        clause !== "where" &&
        clause !== "on" &&
        clause !== "from"
      ) {
        deferred.push(() =>
          isQueryGroup(item.items)
            ? readScope(item.items, query, template)
            : nestedScopes(item.items, query, template),
        );
      }
      clauseItems.push(item);
      position += 1;
    }
    flush();
    for (const run of deferred) run();
  }

  function clauseConjuncts(
    items: Item[],
    query: Query,
    only: Comparison["only"],
    template: AstNode,
  ) {
    nestedScopes(items, query, template);
    if (items.some((item) => isWord(item, "or"))) return;
    const segments: Item[][] = [[]];
    for (const item of items) {
      if (isWord(item, "and")) segments.push([]);
      else (segments[segments.length - 1] as Item[]).push(item);
    }
    segments.forEach((segment, index) => {
      const first = segment[0];
      const last = segment[segment.length - 1];
      if (!first || !last || isWord(first, "not", "exists")) return;
      if (
        segment.length === 1 &&
        first.t === "group" &&
        !isQueryGroup(first.items)
      ) {
        conjunctsIn(first.items, query, only);
        return;
      }
      const operator = segment.findIndex(
        (item) => isPunct(item, "=") || isWord(item, "in"),
      );
      if (operator <= 0) return;
      const left = rawOperand(segment.slice(0, operator), query);
      const right = isWord(segment[operator], "in")
        ? ({ kind: "value" } as const)
        : rawOperand(segment.slice(operator + 1), query);
      const next = segments[index + 1]?.[0];
      const previous = segments[index - 1]?.at(-1);
      const span = { start: first.start, end: last.end };
      query.comparisons.push({
        left,
        right,
        only,
        span,
        removal: next
          ? { start: first.start, end: next.start, text: "" }
          : previous
            ? { start: previous.end, end: last.end, text: "" }
            : { ...span, text: "" },
      });
    });
  }

  /** A parenthesised conjunction inside a clause: its subqueries are read. */
  function conjunctsIn(items: Item[], query: Query, only: Comparison["only"]) {
    if (items.some((item) => isWord(item, "or"))) return;
    const inner: Item[][] = [[]];
    for (const item of items) {
      if (isWord(item, "and")) inner.push([]);
      else (inner[inner.length - 1] as Item[]).push(item);
    }
    for (const segment of inner) {
      const operator = segment.findIndex((item) => isPunct(item, "="));
      const first = segment[0];
      const last = segment.at(-1);
      if (operator <= 0 || !first || !last) continue;
      const span = { start: first.start, end: last.end };
      query.comparisons.push({
        left: rawOperand(segment.slice(0, operator), query),
        right: rawOperand(segment.slice(operator + 1), query),
        only,
        span,
        removal: { ...span, text: "" },
      });
    }
  }

  function rawOperand(items: Item[], query: Query): Operand {
    const cast = items.findIndex((item) => isPunct(item, "::"));
    const operand = cast >= 0 ? items.slice(0, cast) : items;
    const [first, second, third] = operand;
    if (operand.length === 1 && first) {
      if (first.t === "column") {
        return {
          kind: "column",
          names: first.names,
          table: first.table,
          column: first.column,
        };
      }
      if (first.t === "value" || first.t === "literal")
        return { kind: "value" };
      if (first.t === "group") {
        return isQueryGroup(first.items)
          ? { kind: "value" }
          : { kind: "unknown" };
      }
      if (isName(first)) {
        const owners = query.sources.filter((source) =>
          model.byName.get(source.table)?.sqlColumns.has(first.v),
        );
        if (owners.length === 1) {
          const owner = owners[0] as Source;
          return {
            kind: "column",
            names: owner.names,
            table: owner.table,
            column: first.v,
          };
        }
      }
      return { kind: "unknown" };
    }
    if (
      operand.length === 3 &&
      isName(first) &&
      isPunct(second, ".") &&
      isName(third)
    ) {
      for (let scope: Query | undefined = query; scope; scope = scope.parent) {
        const owner = scope.sources.find((source) =>
          source.names.includes(first.v),
        );
        if (owner) {
          return {
            kind: "column",
            names: owner.names,
            table: owner.table,
            column: third.v,
          };
        }
      }
      return { kind: "unknown" };
    }
    if (isWord(first, "any") && second?.t === "group") return { kind: "value" };
    return { kind: "unknown" };
  }

  // Templates no builder query consumed: whole raw queries, and fragments in
  // a select list or held for later.
  const templates = all
    .filter(isSqlTemplate)
    .sort((left, right) => left.start - right.start);
  for (const template of templates) {
    if (consumed.has(template)) continue;
    consumed.add(template);
    const root = groupTokens(
      tokenize(template, rootContext),
      template.start,
      template.end,
    );
    const parent = enclosing(template.start, template.end);
    if (isQueryGroup(root.items)) readScope(root.items, parent, template);
    else nestedScopes(root.items, parent, template);
  }

  return { queries, ...evaluate(queries, model) };
}

// ---------------------------------------------------------------------------
// Deciding what is scoped.

function isKey(operand: Operand, model: TenantModel): boolean {
  return (
    operand.kind === "column" &&
    model.byName.get(operand.table)?.key === operand.column
  );
}

function linked(left: Operand, right: Operand, model: TenantModel): boolean {
  if (left.kind !== "column" || right.kind !== "column") return false;
  if (isKey(left, model) && isKey(right, model)) return true;
  const linksOf = (operand: typeof left) =>
    (model.byName.get(operand.table)?.links ?? []).filter(
      (link) => link.column === operand.column,
    );
  const points = (link: ModelLink, operand: typeof left) =>
    link.target === operand.table && link.targetColumn === operand.column;
  const leftLinks = linksOf(left);
  const rightLinks = linksOf(right);
  return (
    leftLinks.some((link) => points(link, right)) ||
    rightLinks.some((link) => points(link, left)) ||
    leftLinks.some((link) =>
      rightLinks.some(
        (other) =>
          other.target === link.target &&
          other.targetColumn === link.targetColumn,
      ),
    )
  );
}

function isTenant(table: string, model: TenantModel): boolean {
  const kind = model.byName.get(table)?.kind;
  return kind === "root" || kind === "direct" || kind === "indirect";
}

function sameSpan(left: Span, right: Span) {
  return left.start === right.start && left.end === right.end;
}

function evaluate(
  queries: Query[],
  model: TenantModel,
  omit?: Span,
): Omit<Analysis, "queries"> {
  const scopedBy = new Map<Query, Set<Source>>();
  const violations: Violation[] = [];
  const assumptions: string[] = [];
  const depth = (query: Query) => {
    let count = 0;
    for (let outer = query.parent; outer; outer = outer.parent) count += 1;
    return count;
  };
  const matches = (source: Source, operand: Operand) =>
    operand.kind === "column" &&
    source.table === operand.table &&
    operand.names.some((name) => source.names.includes(name));
  for (const query of [...queries].sort(
    (left, right) => depth(left) - depth(right),
  )) {
    const scoped = new Set<Source>();
    const assumed = new Set<string>();
    const node = (operand: Operand): Source | "scoped" | undefined => {
      if (operand.kind !== "column") return undefined;
      const local = query.sources.find((source) => matches(source, operand));
      if (local) return local;
      for (let outer = query.parent; outer; outer = outer.parent) {
        const found = outer.sources.find((source) => matches(source, operand));
        if (found) {
          return scopedBy.get(outer)?.has(found) ? "scoped" : undefined;
        }
      }
      if (!isTenant(operand.table, model)) return undefined;
      assumed.add(keyOf({ ...query, table: operand.table }));
      return "scoped";
    };
    const edges: Array<{
      from: Source | "scoped";
      to: Source | "scoped";
      both: boolean;
    }> = [];
    for (const comparison of query.comparisons) {
      if (omit && sameSpan(comparison.span, omit)) continue;
      for (const [side, other] of [
        [comparison.left, comparison.right],
        [comparison.right, comparison.left],
      ] as const) {
        if (!isKey(side, model) || other.kind !== "value") continue;
        const source = query.sources.find((candidate) =>
          matches(candidate, side),
        );
        if (
          source &&
          (comparison.only === undefined || comparison.only === source)
        ) {
          scoped.add(source);
        }
      }
      if (!linked(comparison.left, comparison.right, model)) continue;
      const left = node(comparison.left);
      const right = node(comparison.right);
      if (!left || !right) continue;
      if (comparison.only === undefined) {
        edges.push({ from: left, to: right, both: true });
      } else if (left === comparison.only) {
        edges.push({ from: right, to: left, both: false });
      } else if (right === comparison.only) {
        edges.push({ from: left, to: right, both: false });
      }
    }
    const isScoped = (value: Source | "scoped") =>
      value === "scoped" || scoped.has(value);
    for (let changed = true; changed; ) {
      changed = false;
      for (const { from, to, both } of edges) {
        for (const [a, b] of both
          ? [
              [from, to],
              [to, from],
            ]
          : [[from, to]]) {
          if (a && b && isScoped(a) && b !== "scoped" && !scoped.has(b)) {
            scoped.add(b);
            changed = true;
          }
        }
      }
    }
    scopedBy.set(query, scoped);
    assumptions.push(...assumed);
    // One violation per unscoped group of linked sources, charged to the
    // first of them: a join riding on an unscoped lookup is not a second
    // finding.
    const unscoped = query.sources.filter(
      (source) => isTenant(source.table, model) && !scoped.has(source),
    );
    const reported = new Set<Source>();
    for (const source of unscoped) {
      if (reported.has(source)) continue;
      const group = new Set<Source>([source]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const { from, to } of edges) {
          if (from === "scoped" || to === "scoped") continue;
          if (group.has(from) && !group.has(to) && unscoped.includes(to)) {
            group.add(to);
            grew = true;
          }
          if (group.has(to) && !group.has(from) && unscoped.includes(from)) {
            group.add(from);
            grew = true;
          }
        }
      }
      for (const member of group) reported.add(member);
      const riders = [...group].slice(1).map((member) => member.ref);
      violations.push({
        file: query.file,
        fn: query.fn,
        table: source.table,
        line: query.line,
        reason: `\`${source.ref}\` carries no organisation predicate${
          riders.length ? `; linked to it: ${riders.join(", ")}` : ""
        }`,
      });
    }
    for (const problem of query.problems) {
      violations.push({
        file: query.file,
        fn: query.fn,
        table: "?",
        line: query.line,
        reason: problem,
      });
    }
  }
  return { violations, assumptions };
}

// ---------------------------------------------------------------------------
// The files swept, and the ledger.

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // The schema declares tables; it runs no query.
        if (path !== join(sourceRoot, "schema")) walk(path);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.startsWith("tenant-scope-sweep.")
      ) {
        found.push(path);
      }
    }
  };
  walk(sourceRoot);
  return found.sort();
}

function keyOf(entry: { file: string; fn: string; table: string }) {
  return `${entry.file} › ${entry.fn} › ${entry.table}`;
}

function ledgerDifferences(
  violations: Violation[],
  ledger: readonly TenantScopeException[],
): string[] {
  const found = new Map<string, Violation[]>();
  for (const violation of violations) {
    const key = keyOf(violation);
    found.set(key, [...(found.get(key) ?? []), violation]);
  }
  const listed = new Map<string, TenantScopeException>();
  const problems: string[] = [];
  for (const entry of ledger) {
    const key = keyOf(entry);
    if (listed.has(key)) problems.push(`listed twice: ${key}`);
    listed.set(key, entry);
  }
  for (const [key, occurrences] of found) {
    const entry = listed.get(key);
    const detail = occurrences
      .map((violation) => `  line ${violation.line}: ${violation.reason}`)
      .join("\n");
    if (!entry) {
      problems.push(`not listed: ${key} (${occurrences.length})\n${detail}`);
    } else if (entry.count !== occurrences.length) {
      problems.push(
        `listed ${entry.count}, found ${occurrences.length}: ${key}\n${detail}`,
      );
    }
  }
  for (const key of listed.keys()) {
    if (!found.has(key)) problems.push(`listed but no longer found: ${key}`);
  }
  return problems;
}

const model = buildTenantModel();

// ---------------------------------------------------------------------------
// The analyser, on fixtures small enough to read.

const header = `import { and, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { domainEvents, lanes, organizationMembers, organizations, outbox, projects, requestLabels, requests, user } from "../schema/index.js";
`;

function fixture(body: string): Analysis {
  return analyseSource("fixture.ts", header + body, model);
}

function tablesIn(result: Analysis) {
  return result.violations.map((violation) => violation.table).sort();
}

describe("the tenant model", () => {
  it("reads root, direct, indirect and global tables from the schema", () => {
    expect(model.byName.get("organizations")?.kind).toBe("root");
    expect(model.byName.get("requests")?.kind).toBe("direct");
    expect(model.byName.get("outbox")?.kind).toBe("indirect");
    expect(model.byName.get("requestLabels")?.kind).toBe("indirect");
    expect(model.byName.get("user")?.kind).toBe("global");
    const kinds = [...model.byName.values()].map((table) => table.kind);
    expect(kinds.filter((kind) => kind === "root")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "direct").length).toBeGreaterThan(
      40,
    );
  });

  it("links a composite organisation key only to a primary key", () => {
    expect(model.byName.get("requests")?.links).toContainEqual({
      column: "target_project_id",
      target: "projects",
      targetColumn: "id",
    });
    for (const table of model.byName.values()) {
      for (const link of table.links) {
        expect(model.byName.get(link.target)?.kind).not.toBe("global");
      }
    }
  });

  it("links a foreign key to a non-primary column to nothing", () => {
    const parents = pgTable("parents", {
      id: uuid("id").primaryKey(),
      organizationId: uuid("organization_id").notNull(),
      code: text("code").notNull(),
    });
    const children = pgTable(
      "children",
      {
        id: uuid("id").primaryKey(),
        organizationId: uuid("organization_id").notNull(),
        parentId: uuid("parent_id").notNull(),
        parentCode: text("parent_code").notNull(),
      },
      (table) => [
        foreignKey({
          columns: [table.organizationId, table.parentId],
          foreignColumns: [parents.organizationId, parents.id],
        }),
        foreignKey({
          columns: [table.organizationId, table.parentCode],
          foreignColumns: [parents.organizationId, parents.code],
        }),
      ],
    );
    const byId = pgTable("by_id", {
      parentId: uuid("parent_id").references(() => parents.id),
    });
    const byCode = pgTable("by_code", {
      parentCode: text("parent_code").references(() => parents.code),
    });
    const synthetic = buildTenantModel({ parents, children, byId, byCode });
    expect(synthetic.byName.get("children")?.links).toEqual([
      { column: "parent_id", target: "parents", targetColumn: "id" },
    ]);
    expect(synthetic.byName.get("byId")?.kind).toBe("indirect");
    expect(synthetic.byName.get("byCode")?.kind).toBe("global");
  });

  it("gives Better Auth's adapter no tenant table", () => {
    const identity = new Set<unknown>(Object.values(schema.identitySchema));
    const exported = schema as Record<string, unknown>;
    const tenant = [...model.byName.values()].filter(
      (table) => table.kind !== "global" && identity.has(exported[table.name]),
    );
    expect(identity.size).toBeGreaterThan(0);
    expect(tenant).toEqual([]);
  });
});

describe("the analyser", () => {
  it("passes a select that carries its predicate", () => {
    const result = fixture(`
      export function f(db, organizationId, id) {
        return db.select().from(requests).where(and(eq(requests.id, id), eq(requests.organizationId, organizationId)));
      }`);
    expect(result.violations).toEqual([]);
    expect(result.queries).toHaveLength(1);
  });

  it("fails a select, an update and a delete that do not", () => {
    const result = fixture(`
      export async function f(db, id) {
        await db.select().from(requests).where(eq(requests.id, id));
        await db.update(lanes).set({ status: "archived" }).where(eq(lanes.id, id));
        await db.delete(projects).where(eq(projects.id, id));
      }`);
    expect(tablesIn(result)).toEqual(["lanes", "projects", "requests"]);
    expect(result.violations[0]).toMatchObject({ file: "fixture.ts", fn: "f" });
  });

  it("does not count a predicate in or(), a conditional or a pushed element", () => {
    const result = fixture(`
      export async function f(db, organizationId, id, flag) {
        await db.select().from(requests).where(or(eq(requests.organizationId, organizationId), eq(requests.id, id)));
        await db.select().from(lanes).where(and(eq(lanes.id, id), flag ? eq(lanes.organizationId, organizationId) : undefined));
        const conditions = [eq(projects.id, id)];
        if (flag) conditions.push(eq(projects.organizationId, organizationId));
        await db.select().from(projects).where(and(...conditions));
      }`);
    expect(tablesIn(result)).toEqual(["lanes", "projects", "requests"]);
  });

  it("follows a const, a spread array and a local helper", () => {
    const result = fixture(`
      function scope(table, organizationId) { return eq(table.organizationId, organizationId); }
      export async function f(db, organizationId, id) {
        const where = and(eq(requests.id, id), eq(requests.organizationId, organizationId));
        await db.select().from(requests).where(where);
        const conditions = [eq(lanes.organizationId, organizationId)];
        await db.select().from(lanes).where(and(...conditions, eq(lanes.id, id)));
        await db.select().from(projects).where(scope(projects, organizationId));
      }`);
    expect(result.violations).toEqual([]);
  });

  it("checks a helper's query once per call, with that call's conditions", () => {
    const result = fixture(`
      function rows(db, conditions) {
        return db.select().from(requests).where(and(...conditions));
      }
      export function scoped(db, organizationId) {
        const conditions = [eq(requests.organizationId, organizationId)];
        return rows(db, conditions);
      }
      export function unscoped(db, id) {
        return rows(db, [eq(requests.id, id)]);
      }`);
    expect(result.violations).toMatchObject([
      { fn: "unscoped → rows", table: "requests" },
    ]);
    expect(result.queries).toHaveLength(2);
  });

  it("scopes a join through a composite key or a shared reference, not an unrelated column", () => {
    const passing = fixture(`
      export function f(db, organizationId) {
        return db.select().from(requests)
          .innerJoin(projects, eq(projects.id, requests.targetProjectId))
          .innerJoin(organizations, eq(organizations.id, requests.organizationId))
          .innerJoin(lanes, eq(lanes.projectId, requests.targetProjectId))
          .where(eq(requests.organizationId, organizationId));
      }`);
    expect(passing.violations).toEqual([]);
    const unrelated = fixture(`
      export function f(db, organizationId) {
        return db.select().from(requests)
          .innerJoin(lanes, eq(lanes.id, requests.displayKey))
          .where(eq(requests.organizationId, organizationId));
      }`);
    expect(tablesIn(unrelated)).toEqual(["lanes"]);
  });

  it("does not let a left join's ON scope the table it joins onto", () => {
    const result = fixture(`
      export function f(db, organizationId, id) {
        return db.select().from(requests)
          .leftJoin(projects, and(eq(projects.id, requests.targetProjectId), eq(requests.organizationId, organizationId)))
          .where(eq(requests.id, id));
      }`);
    expect(result.violations).toMatchObject([
      { table: "requests", reason: expect.stringContaining("projects") },
    ]);
  });

  it("scopes an indirect table through its owner", () => {
    const passing = fixture(`
      export function f(db, organizationId) {
        return db.select().from(outbox)
          .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
          .where(eq(domainEvents.organizationId, organizationId));
      }`);
    expect(passing.violations).toEqual([]);
    const failing = fixture(`
      export function f(db) {
        return db.select().from(outbox).where(eq(outbox.state, "pending"));
      }`);
    expect(tablesIn(failing)).toEqual(["outbox"]);
  });

  it("resolves aliases, by their variable and by their SQL name, and ignores global tables", () => {
    const result = fixture(`
      const target = alias(projects, "target_project");
      export function f(db, organizationId, id) {
        return db.select().from(user)
          .innerJoin(target, eq(target.organizationId, organizationId))
          .where(eq(user.id, id));
      }
      export function g(db, organizationId) {
        return db.execute(sql\`select 1 from \${projects} target_project where \${target.organizationId} = \${organizationId}\`);
      }`);
    expect(result.violations).toEqual([]);
  });

  it("reads raw SQL: sources, aliases, CTEs, subqueries and correlation", () => {
    const passing = fixture(`
      export function f(db, organizationId) {
        return db.execute(sql\`
          with recent as materialized (select id from \${requests} where organization_id = \${organizationId})
          select r.id, (select count(*) from request_labels l where l.request_id = r.id) as labels
          from \${requests} r
          join recent on recent.id = r.id
          join projects p on p.id = r.target_project_id
          where r.organization_id = \${organizationId} and r.state in ('open')
            and r.title is distinct from 'x'
          for update of r skip locked
        \`);
      }`);
    expect(passing.violations).toEqual([]);
    expect(passing.queries.map((query) => query.kind)).toEqual([
      "raw",
      "raw",
      "raw",
    ]);
    const failing = fixture(`
      export function f(db, organizationId) {
        return db.execute(sql\`
          select count(*) from outbox o join domain_events e on e.id = o.event_id
          where e.organization_id = \${organizationId} or o.state = 'pending'
        \`);
      }`);
    expect(failing.violations).toMatchObject([
      { table: "outbox", reason: expect.stringContaining("linked to it: e") },
    ]);
  });

  it("reads a raw fragment in a builder where against the builder's sources", () => {
    const result = fixture(`
      export function f(db, organizationId, label) {
        return db.select().from(requests).where(and(
          sql\`\${requests.organizationId} = \${organizationId}\`,
          sql\`exists (select 1 from \${requestLabels} rl where rl.request_id = \${requests.id} and rl.label = \${label})\`,
        ));
      }`);
    expect(result.violations).toEqual([]);
    expect(result.assumptions).toEqual([]);
  });

  it("assumes a helper fragment's outer table is swept where it is used", () => {
    const result = fixture(`
      function visible(userId) {
        return sql\`exists (select 1 from \${organizationMembers} m where m.organization_id = \${requests.organizationId} and m.user_id = \${userId})\`;
      }`);
    expect(result.violations).toEqual([]);
    expect(result.assumptions).toEqual(["fixture.ts › visible › requests"]);
  });

  it("reports what it cannot model instead of passing it", () => {
    const result = fixture(`
      export function f(db, table, id) {
        return db.select().from(table).where(eq(table.id, id));
      }
      export function g(db, organizationId) {
        return db.select().from(requests).rightJoin(projects, eq(projects.id, requests.targetProjectId)).where(eq(requests.organizationId, organizationId));
      }
      export function h(db) {
        return db.execute(sql\`select 1 from mystery_table\`);
      }
      export function i(db, organizationId) {
        return db.execute(sql\`select 1 from \${requests} r right join \${projects} p on p.id = r.target_project_id where r.organization_id = \${organizationId}\`);
      }
      export function j(db) {
        return db.execute(sql\`select * from requestport_private.unlisted_relation\`);
      }`);
    expect(result.violations.map((violation) => violation.reason)).toEqual([
      "unresolved query source `table`",
      "`rightJoin` is not modelled by the sweep",
      "unknown raw source `mystery_table`",
      "`right join` is not modelled by the sweep",
      "unknown raw source `requestport_private`",
    ]);
  });

  it("reads a definer function call as no table (manifest-i2.md §2.5.0)", () => {
    const result = fixture(`
      export function f(db, userId, clientId) {
        return db.execute(sql\`select * from requestport_private.resolve_oauth_grant(\${userId}, \${clientId}, 'mcp') g\`);
      }
      export function g(db, email) {
        return db.execute(sql\`select status from requestport_private.signup_allowlist_eligibility(\${email}) as a\`);
      }`);
    expect(result.violations).toEqual([]);
  });

  it("reports the query shapes it does not model", () => {
    const result = fixture(`
      export async function relational(db, id) {
        return db.query.requests.findFirst({ where: (r, { eq }) => eq(r.id, id) });
      }
      export async function rawText(db) {
        return db.execute(sql.raw("select * from requests"));
      }
      export async function pool(db) {
        return db.$client.query("select * from requests");
      }
      export async function text(db) {
        await db.execute("select * from requests");
        const statement = \`select * from lanes\`;
        return db.execute(statement);
      }
      export async function called(db, id, tables) {
        await db.select().from(tables.pick()).where(eq(lanes.id, id));
        return db.select().from(pick()).where(eq(lanes.id, id));
      }`);
    expect(
      result.violations.map((violation) => [violation.fn, violation.reason]),
    ).toEqual([
      [
        "relational",
        "the relational query API (`db.query.requests.findFirst`) is not modelled by the sweep",
      ],
      ["rawText", "`sql.raw` is not modelled by the sweep"],
      ["pool", "SQL text passed to `query` is not modelled by the sweep"],
      ["pool", "`$client` is not modelled by the sweep"],
      ["text", "SQL text passed to `execute` is not modelled by the sweep"],
      ["text", "SQL text passed to `execute` is not modelled by the sweep"],
      ["called", "unresolved query source `tables.pick()`"],
      ["called", "unresolved query source `pick()`"],
    ]);
    const subquery = fixture(`
      export function f(db, organizationId) {
        return db.select().from(db.select().from(requests).where(eq(requests.organizationId, organizationId)).as("sq"));
      }`);
    expect(subquery.violations).toEqual([]);
  });

  it("reads the select of a raw insert", () => {
    const result = fixture(`
      export function scoped(db, organizationId) {
        return db.execute(sql\`insert into \${lanes} (id, organization_id)
          select id, organization_id from \${projects} where organization_id = \${organizationId}
          on conflict (id) do update set organization_id = excluded.organization_id returning id\`);
      }
      export function unscoped(db) {
        return db.execute(sql\`insert into \${lanes} (id) select id from \${projects}\`);
      }`);
    expect(
      result.violations.map((violation) => [violation.fn, violation.table]),
    ).toEqual([["unscoped", "projects"]]);
  });

  it("does not count a raw predicate an `or` can bypass, or a negated one", () => {
    const result = fixture(`
      export function f(db, organizationId, id) {
        return db.execute(sql\`select 1 from \${requests} r where r.id = \${id} or true and r.organization_id = \${organizationId}\`);
      }
      export function g(db, organizationId, id) {
        return db.execute(sql\`select 1 from \${lanes} l where (l.id = \${id} or true and l.organization_id = \${organizationId})\`);
      }
      export function h(db, organizationId) {
        return db.execute(sql\`select 1 from \${projects} p where not p.organization_id = \${organizationId}\`);
      }
      export function passing(db, organizationId, id) {
        return db.execute(sql\`select 1 from \${lanes} l where (l.id = \${id} and l.organization_id = \${organizationId})\`);
      }`);
    expect(tablesIn(result)).toEqual(["lanes", "projects", "requests"]);
  });

  it("does not follow a `let`", () => {
    const result = fixture(`
      export function f(db, organizationId) {
        let where = eq(requests.organizationId, organizationId);
        return db.select().from(requests).where(where);
      }`);
    expect(tablesIn(result)).toEqual(["requests"]);
  });

  it("checks an exported helper as it stands, as well as per call", () => {
    const result = fixture(`
      export function rows(db, conditions) {
        return db.select().from(requests).where(and(...conditions));
      }
      export function scoped(db, organizationId) {
        return rows(db, [eq(requests.organizationId, organizationId)]);
      }`);
    expect(result.violations).toMatchObject([
      { fn: "rows", table: "requests" },
    ]);
    expect(result.queries).toHaveLength(2);
  });

  it("does not take a `sql` template for a value", () => {
    const result = fixture(`
      export function f(db) {
        return db.select().from(requests).where(eq(requests.organizationId, sql\`\${requests.organizationId}\`));
      }`);
    expect(tablesIn(result)).toEqual(["requests"]);
  });
});

describe("the ledger comparison", () => {
  const violation = (fn: string, line: number): Violation => ({
    file: "a.ts",
    fn,
    table: "requests",
    line,
    reason: "`requests` carries no organisation predicate",
  });
  const entry = (fn: string, count: number): TenantScopeException => ({
    file: "a.ts",
    fn,
    table: "requests",
    count,
    kind: "worker",
    why: "synthetic",
  });

  it("is exact in both directions", () => {
    expect(
      ledgerDifferences(
        [violation("same", 1), violation("same", 2)],
        [entry("same", 2)],
      ),
    ).toEqual([]);
    expect(
      ledgerDifferences(
        [
          violation("unlisted", 1),
          violation("miscounted", 2),
          violation("miscounted", 3),
          violation("twice", 4),
        ],
        [
          entry("miscounted", 1),
          entry("stale", 1),
          entry("twice", 1),
          entry("twice", 1),
        ],
      ),
    ).toEqual([
      "listed twice: a.ts › twice › requests",
      "not listed: a.ts › unlisted › requests (1)\n  line 1: `requests` carries no organisation predicate",
      "listed 1, found 2: a.ts › miscounted › requests\n  line 2: `requests` carries no organisation predicate\n  line 3: `requests` carries no organisation predicate",
      "listed but no longer found: a.ts › stale › requests",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The tree.

describe("the tenant-scope sweep of packages/db", () => {
  const results = sourceFiles().map((path) => {
    const file = relative(sourceRoot, path);
    const text = readFileSync(path, "utf8");
    return { file, text, ...analyseSource(file, text, model) };
  });
  const violations = results.flatMap((result) => result.violations);

  it("finds the queries it is meant to", () => {
    const queries = results.flatMap((result) => result.queries);
    // Floors, so a parser regression that stops finding queries fails
    // instead of passing an empty sweep.
    expect(
      queries.filter((query) => query.kind === "builder").length,
    ).toBeGreaterThan(400);
    expect(
      queries.filter((query) => query.kind === "raw").length,
    ).toBeGreaterThan(90);
  });

  it("finds every tenant-owned query scoped, or listed with its reason", () => {
    expect(ledgerDifferences(violations, tenantScopeExceptions)).toEqual([]);
  });

  it("gives every listed exception a reason", () => {
    for (const entry of tenantScopeExceptions) {
      expect(entry.why.trim().length, keyOf(entry)).toBeGreaterThan(40);
    }
  });

  it("assumes the correlation of a known number of helper fragments", () => {
    expect(results.flatMap((result) => result.assumptions).sort()).toEqual(
      expectedAssumptions,
    );
  });

  /*
   * Its own budget, because it is slow without touching a database: it
   * re-reads a source file once for every organisation predicate it removes,
   * more than 320 parses, and runs no query. In the forced gates of
   * 2026-09-27 to 2026-09-29 it took 1.9–23.0s where it passed, and overran
   * this file's 30 seconds three times, at 31.7s, 35.6s and 37.6s. 120
   * seconds is four times the budget it overran.
   */
  it("fails when any one organisation predicate is removed from the source", () => {
    const outcomes = { removed: 0, failed: 0 };
    const redundant: string[] = [];
    for (const result of results) {
      const seen = new Set<string>();
      for (const query of result.queries) {
        for (const comparison of query.comparisons) {
          const anchor =
            (isKey(comparison.left, model) &&
              comparison.right.kind === "value") ||
            (isKey(comparison.right, model) &&
              comparison.left.kind === "value");
          const id = `${comparison.span.start}:${comparison.span.end}`;
          if (!anchor || seen.has(id)) continue;
          seen.add(id);
          const mutated = analyseSource(
            result.file,
            result.text.slice(0, comparison.removal.start) +
              comparison.removal.text +
              result.text.slice(comparison.removal.end),
            model,
          );
          const predicted = evaluate(result.queries, model, comparison.span);
          const where = `${result.file}:${result.text.slice(0, comparison.span.start).split("\n").length}`;
          // The source, re-read without the predicate, agrees with the model
          // of the query without it: the removal is what the sweep sees.
          expect(mutated.violations.length, where).toBe(
            predicted.violations.length,
          );
          outcomes.removed += 1;
          if (mutated.violations.length > result.violations.length) {
            outcomes.failed += 1;
          } else {
            redundant.push(
              `${where} ${result.text
                .slice(comparison.span.start, comparison.span.end)
                .replace(/\s+/gu, " ")
                .replace(/\$\{([^}]*)\}/gu, "«$1»")}`,
            );
          }
        }
      }
    }
    expect(outcomes.removed).toBeGreaterThan(320);
    expect(outcomes.failed).toBe(outcomes.removed - redundant.length);
    expect(redundant).toEqual(expectedRedundantPredicates);
  }, 120_000);
});

describe("the sweep's boundary", () => {
  it("finds no query outside packages/db but the E2E hook", () => {
    // What boundaryOffences reports is listed above it. Outside packages/db
    // and apps/web/tests (the Playwright suite, which seeds and inspects its
    // own database), it finds one place: the E2E scenario hook. Since
    // I.2.2's D20 the hook seeds and deletes, across organisations, through
    // the owner storage's `query`, which runs SQL the hook's seeder writes.
    // It opens that storage through openE2EOwnerStorage
    // (apps/web/src/lib/e2e-owner-storage.ts), which the sweep follows into
    // the route, and keeps it on globalThis under a Symbol key, so that a
    // module reload cannot orphan its pool: a holder the sweep cannot
    // follow, so it reports it there. openE2EOwnerStorage refuses wherever
    // VERCEL_ENV is set and outside E2E mode before it builds, and
    // createE2EOwnerStorage refuses the first again and the part of the
    // second it can read (NODE_ENV and REQUESTPORT_E2E_MODE);
    // apps/web/src/lib/e2e-owner-storage.test.ts pins the opener's two
    // refusals, and that the route builds the storage only inside
    // ownerStorage().
    expect(boundaryOffences(repositoryRoot)).toEqual([
      "apps/web/src/app/api/test/scenarios/route.ts:33 `openE2EOwnerStorage(…)` held in a variable",
    ]);
  });

  it("knows every database handle the package exports", () => {
    const index = parseAst(readFileSync(join(sourceRoot, "index.ts"), "utf8"), {
      lang: "ts",
    }) as unknown as AstNode;
    const fromClient = list(index, "body")
      .filter(
        (node) =>
          node.type === "ExportNamedDeclaration" &&
          field(node, "source")?.value === "./client.js",
      )
      .flatMap((node) =>
        list(node, "specifiers").map((specifier) =>
          nameOf(field(specifier, "exported")),
        ),
      )
      .sort();
    // `Database`, `DatabaseDriver`, `Storage`, `StorageOptions` and
    // `TenantBinding` are types, and `createStorage` builds a storage around
    // a handle (manifest-g.md §2.2). G.5 retired the default storage's
    // handle `db`, its readiness probe `checkDatabaseReadiness` and its
    // shutdown hook `closeDatabase` (N1 point 3, ruling 116: G first).
    // Anything else client.ts hands out must join `databaseHandles`.
    expect(fromClient).toEqual([
      "Database",
      "DatabaseDriver",
      "Storage",
      "StorageOptions",
      "TenantBinding",
      "createStorage",
    ]);
    expect([...databaseHandles]).toEqual(["createStorage"]);
  });

  it("knows where every function outside packages/db that it models is defined", () => {
    // The boundary follows these by name where they are imported
    // (`webRootBuilders`, `storageWrappers`, `handleUnits`, `storageSinks`,
    // `handleProviders`). One renamed or moved would leave its importers
    // unread, so each must be exported by its name from a module its
    // matcher names, once; and what a wrapper is declared to return is the
    // storage its shape models.
    expect(modeledDefinitions(repositoryRoot)).toEqual([
      "createAuth, a handle provider: packages/auth/src/create-auth.ts",
      "createDatabaseSignupPolicy, a handle provider: packages/auth/src/database-signup-policy.ts",
      "inUnit, a unit: packages/jobs/src/worker-storages.ts",
      "openE2EOwnerStorage, a wrapper returning E2EOwnerStorage: apps/web/src/lib/e2e-owner-storage.ts",
      "useWorkerStorages, a sink: packages/jobs/src/worker-storages.ts",
      "webStorage, a wrapper returning Storage: apps/web/src/lib/server-request-port.ts",
      "workerStorages, a wrapper returning WorkerStorages: packages/jobs/src/worker-storages.ts",
      "workerStoragesFromRoot, a wrapper returning WorkerStorages: packages/jobs/src/worker-root.ts",
    ]);
  });
});

describe("the sweep's boundary, on a planted tree", () => {
  // Until G.5 the handle here was the package's own `db`, imported from its
  // barrel. The barrel exports no handle now (Plan 13, G.5), so the planted
  // modules take a root's, and `createStorage`, the one name the barrel
  // exports that yields a handle, is reported where it is used.
  it("fires on a query through a root's handle, a transaction or a driver, and on createStorage taken from the package", () => {
    const root = mkdtempSync(join(tmpdir(), "tenant-scope-boundary-"));
    const plant = (path: string, body: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    try {
      plant(
        "apps/web/src/lib/leak.ts",
        `import { requests } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
const { db: handle } = rootStorageFromEnv("application");
export async function leak() {
  await handle.delete(requests);
  return handle.select().from(requests);
}
export function inTransaction() {
  return handle.transaction(async (tx) => tx.execute("select 1"));
}
export function relational() {
  return handle.query.requests.findMany();
}
function helper(value: unknown) {
  return value;
}
export const escaped = helper(handle);
const alias = handle;
export { alias };
export async function dynamic() {
  const { createStorage: build } = await import("@requestport/db");
  const module = await import("@requestport/db");
  await module.createStorage({ driver: "pg" }).db.select();
  return build({ driver: "pg" }).db.delete(module.requests);
}
`,
      );
      plant(
        "apps/web/src/lib/allowed.ts",
        `import { createImportRepository } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
const { db: handle } = rootStorageFromEnv("application");
export function run() {
  return handle.transaction(async (transaction) =>
    createImportRepository(transaction).listRuns(),
  );
}
export async function preview() {
  const [{ retentionRepository }, other] = await Promise.all([
    import("@requestport/db"),
    import("node:os"),
  ]);
  const module = await import("@requestport/db");
  return module.createImportRepository(handle).preview(retentionRepository, other);
}
`,
      );
      plant(
        "trigger/src/driver.ts",
        `import { Pool } from "pg";
export const pool = new Pool();
`,
      );
      plant(
        "packages/db/src/inside.ts",
        `import { sql } from "drizzle-orm";
export const inside = sql\`select 1\`;
`,
      );
      expect(boundaryOffences(root)).toEqual([
        "apps/web/src/lib/leak.ts:5 `handle.delete`",
        "apps/web/src/lib/leak.ts:6 `handle.select`",
        "apps/web/src/lib/leak.ts:9 `tx.execute`",
        "apps/web/src/lib/leak.ts:12 `handle.query`",
        "apps/web/src/lib/leak.ts:17 `handle` passed to `helper`",
        "apps/web/src/lib/leak.ts:18 `handle` held in a variable",
        "apps/web/src/lib/leak.ts:23 `module.createStorage`",
        "apps/web/src/lib/leak.ts:24 `build` used as CallExpression",
        "trigger/src/driver.ts imports a database driver or reaches `$client`",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** What `boundaryOffences` reports of a tree holding only `files`. */
function plantedOffences(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "tenant-scope-boundary-"));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return boundaryOffences(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/*
  Ruling 119 (r9-rulings.md): a name bound to what one of the package's
  storage builders returns is followed as a storage, so a query through it
  outside packages/db is reported (manifest-g.md §7, Done when 12).
*/
describe("the sweep's boundary, through a storage a builder returns", () => {
  it("follows what createWorkerStorages returns", () => {
    expect(
      plantedOffences({
        "packages/jobs/src/storages-leak.ts": `import { createWorkerStorages, requests } from "@requestport/db";
const storages = createWorkerStorages(process.env);
export function leak() {
  return storages.dispatcher.select().from(requests);
}
export function unit(organizationId: string) {
  return storages.withTenant(organizationId, async (database) =>
    database.delete(requests),
  );
}
export const maintain = () => storages.maintenance.execute("select 1");
export async function allowed() {
  await storages.roleReports();
  return storages.close();
}
`,
      }),
    ).toEqual([
      "packages/jobs/src/storages-leak.ts:4 `storages.dispatcher.select`",
      "packages/jobs/src/storages-leak.ts:8 `database.delete`",
      "packages/jobs/src/storages-leak.ts:11 `storages.maintenance.execute`",
    ]);
  });

  it("follows what createE2EOwnerStorage returns", () => {
    expect(
      plantedOffences({
        "apps/web/src/lib/owner-leak.ts": `import { createE2EOwnerStorage } from "@requestport/db/e2e";
export async function seed(env: NodeJS.ProcessEnv) {
  const owner = createE2EOwnerStorage(env);
  try {
    return await owner.query("delete from requests", []);
  } finally {
    await owner.close();
  }
}
`,
      }),
    ).toEqual(["apps/web/src/lib/owner-leak.ts:5 `owner.query`"]);
  });

  it("follows what createTestStorage returns", () => {
    expect(
      plantedOffences({
        "packages/jobs/src/test-support/storage-leak.ts": `import { requests } from "@requestport/db";
import { createTestStorage } from "@requestport/db/testing";
const storage = createTestStorage({ driver: "pg" });
export function rows() {
  return storage.db.select().from(requests);
}
export function inTransaction() {
  return storage.transaction(async (tx) => tx.delete(requests));
}
export function close() {
  return storage.close();
}
`,
      }),
    ).toEqual([
      "packages/jobs/src/test-support/storage-leak.ts:5 `storage.db.select`",
      "packages/jobs/src/test-support/storage-leak.ts:8 `tx.delete`",
    ]);
  });

  it("follows what rootStorageFromEnv returns: bound, destructured, through a namespace, or passed on", () => {
    expect(
      plantedOffences({
        "apps/web/src/lib/root-leak.ts": `import { requests } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export function leak() {
  const storage = rootStorageFromEnv("worker");
  return storage.db.select().from(requests);
}
export function destructured() {
  const { db: handle } = rootStorageFromEnv("worker");
  return handle.delete(requests);
}
export async function throughNamespace() {
  const wiring = await import("@requestport/db/wiring");
  const storage = wiring.rootStorageFromEnv("operator");
  return storage.db.execute("select 1");
}
function helper(value: unknown) {
  return value;
}
export function escaped() {
  const storage = rootStorageFromEnv("worker");
  return helper(storage);
}
`,
      }),
    ).toEqual([
      "apps/web/src/lib/root-leak.ts:5 `storage.db.select`",
      "apps/web/src/lib/root-leak.ts:9 `handle.delete`",
      "apps/web/src/lib/root-leak.ts:14 `storage.db.execute`",
      "apps/web/src/lib/root-leak.ts:21 `storage` passed to `helper`",
    ]);
  });

  it("follows what applicationStorageFromEnv returns, assigned to a name declared before", () => {
    expect(
      plantedOffences({
        "apps/web/src/lib/storage-leak.ts": `import { requests } from "@requestport/db";
import { applicationStorageFromEnv } from "@requestport/db/wiring";
let storage: ReturnType<typeof applicationStorageFromEnv>;
export async function leak() {
  storage = applicationStorageFromEnv();
  await storage.db.delete(requests);
  return storage.db.transaction(async (tx) => tx.execute("select 1"));
}
`,
      }),
    ).toEqual([
      "apps/web/src/lib/storage-leak.ts:6 `storage.db.delete`",
      "apps/web/src/lib/storage-leak.ts:7 `tx.execute`",
    ]);
  });

  it("lets a root hand its storage's handle to a function taken from the package, as an argument or in an options object, and nowhere else", () => {
    // The two positions the repository's roots use: apps/cli/src/index.ts
    // hands `storage.db` to createFoundationRepository as an argument, and
    // apps/requestport/src/serve/serve.ts hands its storage to
    // createWorkerStorages as the `storage` property of its options. The
    // planted worker root below shows the second with a handle under the
    // retired name `database`, which the sweep judges by position, not by
    // name; the real worker root hands nothing (I.2b's b5). It is planted
    // where it is, because only the modelled wrapper's own module may return
    // the storages createWorkerStorages builds (Plan 13, G.3).
    expect(
      plantedOffences({
        "apps/cli/src/root.ts": `import { createFoundationRepository } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export function operator() {
  const storage = rootStorageFromEnv("operator");
  return createFoundationRepository(storage.db);
}
export async function probe() {
  const storage = rootStorageFromEnv("application");
  await storage.ready();
  return storage.close();
}
function configure(options: object) {
  return options;
}
export function escaped() {
  const storage = rootStorageFromEnv("worker");
  return configure({ database: storage.db });
}
`,
        "packages/jobs/src/worker-root.ts": `import { createWorkerStorages } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export function workerStoragesFromRoot(env: NodeJS.ProcessEnv, options: object) {
  const storage = rootStorageFromEnv("worker");
  return createWorkerStorages(env, { ...options, database: storage.db });
}
`,
      }),
    ).toEqual(["apps/cli/src/root.ts:17 `storage.db` used as Property"]);
  });

  it("pins the branches ruling 119 follows: a storage bound after `await` or a type assertion, a destructured unit, a unit held as a value, a computed member, a callback not written in place and a destructured handle", () => {
    expect(
      plantedOffences({
        "packages/jobs/src/branches.ts": `import { requests, type Storage } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export async function afterAwait() {
  const storage = await rootStorageFromEnv("worker");
  return storage.db.delete(requests);
}
export function afterAssertion() {
  const storage = rootStorageFromEnv("worker") as Storage;
  const checked = rootStorageFromEnv("worker")!;
  const satisfied = rootStorageFromEnv("worker") satisfies Storage;
  return [storage.db.delete(requests), checked.db.delete(requests), satisfied.db.delete(requests)];
}
export function destructuredUnit() {
  const { transaction } = rootStorageFromEnv("worker");
  return transaction;
}
export function heldUnit() {
  const storage = rootStorageFromEnv("worker");
  const run = storage.transaction;
  return run;
}
export function computedMember() {
  const storage = rootStorageFromEnv("worker");
  return storage["db"];
}
export function notInPlace(work: (tx: unknown) => Promise<void>) {
  const storage = rootStorageFromEnv("worker");
  return storage.transaction(work);
}
export function destructuredHandle() {
  const storage = rootStorageFromEnv("worker");
  return storage.transaction(async ({ execute }) => execute("select 1"));
}
`,
      }),
    ).toEqual([
      "packages/jobs/src/branches.ts:5 `storage.db.delete`",
      "packages/jobs/src/branches.ts:11 `storage.db.delete`",
      "packages/jobs/src/branches.ts:11 `checked.db.delete`",
      "packages/jobs/src/branches.ts:11 `satisfied.db.delete`",
      "packages/jobs/src/branches.ts:14 `rootStorageFromEnv(…)` destructured into a binding it cannot follow",
      "packages/jobs/src/branches.ts:19 `storage.transaction` used as VariableDeclarator",
      "packages/jobs/src/branches.ts:24 `storage.[…]`",
      "packages/jobs/src/branches.ts:28 `storage.transaction` whose callback cannot be followed",
      "packages/jobs/src/branches.ts:32 `storage.transaction` whose handle is destructured",
    ]);
  });
});

/*
  Ruling 124's positions, as amended by ruling 125 (r9-rulings.md): the forms
  the sweep did not follow after G.1 and G.2 extended it, each now followed
  or reported, one case per position (Plan 13, G.3, ruling 130). Where the
  repository's own code uses a form, the case's comment names where, and the
  real-tree case above ("finds no query outside packages/db but the E2E
  hook") holds that code.
*/
describe("the sweep's boundary, at ruling 124's positions (Plan 13, G.3)", () => {
  it("follows a chain on a builder's call as that storage's member", () => {
    // packages/auth/src/server.ts hands createAuth
    // `applicationStorageFromEnv().db` this way (the providers' case below),
    // and the job bodies read `workerStorages().dispatcher` and
    // `.resolveJobOrganization(…)` this way.
    expect(
      plantedOffences({
        "packages/jobs/src/chains.ts": `import { createFoundationRepository, createWorkerStorages, requests } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export function leak() {
  return rootStorageFromEnv("worker").db.select().from(requests);
}
export async function awaited() {
  return (await rootStorageFromEnv("worker")).db.delete(requests);
}
export function unit() {
  return rootStorageFromEnv("worker").transaction(async (tx) => tx.delete(requests));
}
export function maintenance() {
  return createWorkerStorages(process.env).maintenance.execute("select 1");
}
export function computed() {
  return rootStorageFromEnv("worker")["db"];
}
export function unknown() {
  return rootStorageFromEnv("worker").pool;
}
export function held() {
  const run = rootStorageFromEnv("worker").transaction;
  return run;
}
export function allowed() {
  createFoundationRepository(rootStorageFromEnv("operator").db);
  rootStorageFromEnv("worker").transaction(async (tx) => createFoundationRepository(tx));
  return createWorkerStorages(process.env).resolveJobOrganization("outbox", "id");
}
`,
      }),
    ).toEqual([
      "packages/jobs/src/chains.ts:4 `rootStorageFromEnv(…).db.select`",
      "packages/jobs/src/chains.ts:7 `rootStorageFromEnv(…).db.delete`",
      "packages/jobs/src/chains.ts:10 `tx.delete`",
      "packages/jobs/src/chains.ts:13 `createWorkerStorages(…).maintenance.execute`",
      "packages/jobs/src/chains.ts:16 `rootStorageFromEnv(…).[…]`",
      "packages/jobs/src/chains.ts:19 `rootStorageFromEnv(…).pool`",
      "packages/jobs/src/chains.ts:22 `rootStorageFromEnv(…).transaction` used as VariableDeclarator",
    ]);
  });

  it("lets a storage be returned only from the body of the wrapper modelled with its shape, in that wrapper's module, and reports one returned or handed on anywhere else", () => {
    // packages/jobs/src/worker-root.ts returns `createWorkerStorages(…)`
    // from workerStoragesFromRoot, and worker-storages.ts returns the
    // storage it holds from workerStorages. A function named after a
    // modelled wrapper, in a module its matcher does not name, is no wrapper
    // (`stray.ts`, `stray-root.ts`).
    expect(
      plantedOffences({
        "apps/cli/src/storages.ts": `import { createWorkerStorages } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export const operator = () => rootStorageFromEnv("operator");
export function workers(env: NodeJS.ProcessEnv) {
  return keep(createWorkerStorages(env));
}
export async function awaited() {
  return await rootStorageFromEnv("worker");
}
function keep(value: unknown) {
  return value;
}
`,
        "apps/web/src/lib/e2e-owner-storage.ts": `import { rootStorageFromEnv } from "@requestport/db/wiring";
export function openE2EOwnerStorage() {
  return rootStorageFromEnv("operator");
}
`,
        "apps/web/src/lib/stray.ts": `import type { Storage } from "@requestport/db";
import { applicationStorageFromEnv } from "@requestport/db/wiring";
export function webStorage(): Storage {
  return applicationStorageFromEnv();
}
`,
        "packages/jobs/src/stray-root.ts": `import { createWorkerStorages, type WorkerStorages } from "@requestport/db";
export function workerStoragesFromRoot(env: NodeJS.ProcessEnv): WorkerStorages {
  return createWorkerStorages(env);
}
`,
        "packages/jobs/src/worker-root.ts": `import { createWorkerStorages, type WorkerStorages } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export function workerStoragesFromRoot(env: NodeJS.ProcessEnv): WorkerStorages {
  const storage = rootStorageFromEnv("worker");
  return createWorkerStorages(env, { database: storage.db });
}
export function operatorStorage() {
  return rootStorageFromEnv("operator");
}
`,
        "packages/jobs/src/worker-storages.ts": `import type { WorkerStorages } from "@requestport/db";
import { workerStoragesFromRoot } from "./worker-root.js";
let current: WorkerStorages | undefined;
export function workerStorages(): WorkerStorages {
  current ??= workerStoragesFromRoot(process.env);
  return current;
}
export function useWorkerStorages(storages: WorkerStorages | undefined): void {
  current = storages;
}
export function stray() {
  return current;
}
`,
      }),
    ).toEqual([
      "apps/cli/src/storages.ts:3 `rootStorageFromEnv(…)` used as ArrowFunctionExpression",
      "apps/cli/src/storages.ts:5 `createWorkerStorages(…)` passed to `keep`",
      "apps/cli/src/storages.ts:8 `rootStorageFromEnv(…)` used as ReturnStatement",
      "apps/web/src/lib/e2e-owner-storage.ts:3 `rootStorageFromEnv(…)` used as ReturnStatement",
      "apps/web/src/lib/stray.ts:4 `applicationStorageFromEnv(…)` used as ReturnStatement",
      "packages/jobs/src/stray-root.ts:3 `createWorkerStorages(…)` used as ReturnStatement",
      "packages/jobs/src/worker-root.ts:8 `rootStorageFromEnv(…)` used as ReturnStatement",
      "packages/jobs/src/worker-storages.ts:12 `current` used as ReturnStatement",
    ]);
  });

  it("follows a builder written in place as a parameter's default as that builder, within its function, and reports a builder used as any other value", () => {
    // apps/web/src/lib/e2e-owner-storage.ts defaults openE2EOwnerStorage's
    // `create` to createE2EOwnerStorage; the scenario route holds what it
    // returns on globalThis (the real-tree case above).
    expect(
      plantedOffences({
        "apps/web/src/app/api/test/seed/route.ts": `import { openE2EOwnerStorage } from "../../../../lib/e2e-owner-storage.js";
const ownerKey = Symbol.for("owner");
function ownerStorage() {
  const holder = globalThis as Record<symbol, unknown>;
  holder[ownerKey] ??= openE2EOwnerStorage();
  return holder[ownerKey];
}
export async function POST() {
  const owner = openE2EOwnerStorage();
  await owner.query("delete from requests", []);
  await owner.close();
  return ownerStorage();
}
`,
        "apps/web/src/lib/e2e-owner-storage.ts": `import { createE2EOwnerStorage, type E2EOwnerStorage } from "@requestport/db/e2e";
export function openE2EOwnerStorage(
  env: NodeJS.ProcessEnv = process.env,
  create: (env: NodeJS.ProcessEnv) => E2EOwnerStorage = createE2EOwnerStorage,
): E2EOwnerStorage {
  return create(env);
}
export function seedDirectly(env: NodeJS.ProcessEnv, create = createE2EOwnerStorage) {
  return create(env).query("delete from requests", []);
}
export const kept = createE2EOwnerStorage;
export function handed() {
  return keep(createE2EOwnerStorage);
}
function keep(value: unknown) {
  return value;
}
`,
      }),
    ).toEqual([
      "apps/web/src/app/api/test/seed/route.ts:5 `openE2EOwnerStorage(…)` held in a variable",
      "apps/web/src/app/api/test/seed/route.ts:10 `owner.query`",
      "apps/web/src/lib/e2e-owner-storage.ts:9 `create(…).query`",
      "apps/web/src/lib/e2e-owner-storage.ts:11 `createE2EOwnerStorage` held in a variable",
      "apps/web/src/lib/e2e-owner-storage.ts:13 `createE2EOwnerStorage` passed to `keep`",
    ]);
  });

  it("follows workerStorages() and workerStoragesFromRoot() as builders, inUnit as a unit and useWorkerStorages as the place a storage is kept, and reports their modules imported any other way, or one of them re-exported but by the package's barrel", () => {
    // The job bodies in packages/jobs/src/jobs, trigger/src's two repair
    // tasks and outbox dispatcher, and requestport-jobs' entry point
    // (packages/jobs/src/cli.ts) reach the worker's storages this way;
    // packages/jobs/src/index.ts re-exports the three for `@requestport/jobs`.
    expect(
      plantedOffences({
        "packages/jobs/src/cli.ts": `import { createOutboxRepository, type WorkerStorages } from "@requestport/db";
import { workerStoragesFromRoot } from "./worker-root.js";
import { useWorkerStorages } from "./worker-storages.js";
export async function main(env: NodeJS.ProcessEnv) {
  let storages: WorkerStorages;
  storages = workerStoragesFromRoot(env);
  useWorkerStorages(storages);
  keep(storages);
  createOutboxRepository(storages.dispatcher);
  await storages.close();
}
function keep(value: unknown) {
  return value;
}
`,
        "packages/jobs/src/elsewhere.ts": `export { workerStorages } from "./worker-storages.js";
import * as jobs from "@requestport/jobs";
export const loaded = () => import("@requestport/jobs");
export const required = () => require("./worker-root.js");
export { observeTaskResult } from "@requestport/jobs";
`,
        "packages/jobs/src/index.ts": `export { inUnit, useWorkerStorages, workerStorages } from "./worker-storages.js";
`,
        "packages/jobs/src/jobs/body.ts": `import { createOutboxRepository, requests } from "@requestport/db";
import { inUnit, workerStorages } from "../worker-storages.js";
export function leak() {
  return workerStorages().dispatcher.select().from(requests);
}
export async function allowed(organizationId: string) {
  const id = await workerStorages().resolveJobOrganization("outbox", "id");
  await inUnit(organizationId, (database) => createOutboxRepository(database).markCompleted(id));
  return createOutboxRepository(workerStorages().dispatcher).pendingBacklog();
}
export function unit(organizationId: string) {
  return inUnit(organizationId, (database) => database.delete(requests));
}
export function notInPlace(organizationId: string, work: (database: unknown) => Promise<void>) {
  return inUnit(organizationId, work);
}
export const run = inUnit;
`,
        "trigger/src/repair.ts": `import { createOutboxRepository } from "@requestport/db";
import { workerStorages } from "@requestport/jobs";
export function repair() {
  const storages = workerStorages();
  void storages.maintenance.execute("select 1");
  return createOutboxRepository(storages.maintenance).pendingBacklog();
}
`,
      }),
    ).toEqual([
      "packages/jobs/src/cli.ts:8 `storages` passed to `keep`",
      "packages/jobs/src/elsewhere.ts:1 re-exports `./worker-storages.js`, a module the sweep models",
      "packages/jobs/src/elsewhere.ts:2 imports `@requestport/jobs`, a module the sweep models, into a binding it cannot follow",
      "packages/jobs/src/elsewhere.ts:3 imports `@requestport/jobs`, a module the sweep models, into a binding it cannot follow",
      "packages/jobs/src/elsewhere.ts:4 imports `./worker-root.js`, a module the sweep models, into a binding it cannot follow",
      "packages/jobs/src/jobs/body.ts:4 `workerStorages(…).dispatcher.select`",
      "packages/jobs/src/jobs/body.ts:12 `database.delete`",
      "packages/jobs/src/jobs/body.ts:15 `inUnit` whose callback cannot be followed",
      "packages/jobs/src/jobs/body.ts:17 `inUnit` held in a variable",
      "trigger/src/repair.ts:5 `storages.maintenance.execute`",
    ]);
  });

  it("follows what createAuth's `database` option and createDatabaseSignupPolicy's parameter return as a handle, and a handle returned by a function written in place as either", () => {
    // packages/auth/src/server.ts installs createAuth with
    // `database: () => applicationStorageFromEnv().db`; create-auth.ts calls
    // `database()` for three repositories and drizzleAdapter, and hands
    // `database` to createDatabaseSignupPolicy.
    expect(
      plantedOffences({
        "packages/auth/src/create-auth.ts": `import { createAgentRepository, type Database, requests } from "@requestport/db";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDatabaseSignupPolicy } from "./database-signup-policy.js";
export function createAuth({ database }: { database: () => Database }) {
  const agents = createAgentRepository(database());
  const adapter = drizzleAdapter(database(), {});
  const policy = createDatabaseSignupPolicy(database);
  const leak = database().delete(requests);
  const held = database;
  return { agents, adapter, policy, leak, held };
}
`,
        "packages/auth/src/database-signup-policy.ts": `import { createSignupEligibilityRepository, type Database } from "@requestport/db";
export function createDatabaseSignupPolicy(database: () => Database) {
  return () => createSignupEligibilityRepository(database());
}
`,
        "packages/auth/src/server.ts": `import { requests } from "@requestport/db";
import { applicationStorageFromEnv } from "@requestport/db/wiring";
import { createAuth } from "./create-auth.js";
export const installed = createAuth({
  database: () => applicationStorageFromEnv().db,
});
export const queried = createAuth({
  database: () => {
    void applicationStorageFromEnv().db.delete(requests);
    return applicationStorageFromEnv().db;
  },
});
export const database = () => applicationStorageFromEnv().db;
`,
      }),
    ).toEqual([
      "packages/auth/src/create-auth.ts:8 `database().delete`",
      "packages/auth/src/create-auth.ts:9 `database` held in a variable",
      "packages/auth/src/server.ts:9 `applicationStorageFromEnv(…).db.delete`",
      "packages/auth/src/server.ts:13 `applicationStorageFromEnv(…).db` used as ArrowFunctionExpression",
    ]);
    // A definition the model cannot read is reported, not passed.
    expect(
      plantedOffences({
        "packages/auth/src/create-auth.ts": `import type { Database } from "@requestport/db";
export function createAuth(options: { database: () => Database }) {
  return options.database();
}
`,
      }),
    ).toEqual([
      "packages/auth/src/create-auth.ts:2 `createAuth`'s `database` option cannot be followed",
    ]);
  });

  it("reports ./testing's openSession, testPool, testPoolOfHandle and rawQuery taken in a module that is not a test file, and still follows createTestStorage", () => {
    // No module outside a test imports `@requestport/db/testing` today.
    expect(
      plantedOffences({
        "packages/jobs/src/test-support/raw.ts": `import type { Storage } from "@requestport/db";
import { createTestStorage, openSession, rawQuery, testPool, testPoolOfHandle } from "@requestport/db/testing";
import * as testing from "@requestport/db/testing";
export async function leak(storage: Storage) {
  await rawQuery(storage, "delete from requests");
  const session = await openSession(storage);
  const { testPool: pool } = await import("@requestport/db/testing");
  const own = createTestStorage({ driver: "pglite" });
  return [testPool(storage), testPoolOfHandle(storage.db), session, testing.openSession, pool, own.db.select()];
}
`,
      }),
    ).toEqual([
      "packages/jobs/src/test-support/raw.ts:2 imports `openSession`, which reaches the pool directly",
      "packages/jobs/src/test-support/raw.ts:2 imports `rawQuery`, which reaches the pool directly",
      "packages/jobs/src/test-support/raw.ts:2 imports `testPool`, which reaches the pool directly",
      "packages/jobs/src/test-support/raw.ts:2 imports `testPoolOfHandle`, which reaches the pool directly",
      "packages/jobs/src/test-support/raw.ts:7 imports `testPool`, which reaches the pool directly",
      "packages/jobs/src/test-support/raw.ts:9 `testing.openSession`",
      "packages/jobs/src/test-support/raw.ts:9 `own.db.select`",
    ]);
  });

  it("reports a storage or a handle bound by an exported declaration, or exported by name or as the default", () => {
    // The one exported handle outside packages/db is the web root's own
    // webDatabase, which the model names and follows at every importer.
    expect(
      plantedOffences({
        "packages/jobs/src/exported.ts": `import { createStorage, createWorkerStorages } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export const storage = rootStorageFromEnv("worker");
export const { db: handle } = rootStorageFromEnv("worker");
export let late: ReturnType<typeof rootStorageFromEnv> | undefined;
export function open() {
  late = rootStorageFromEnv("worker");
}
const storages = createWorkerStorages(process.env);
export { storages as workers, createStorage };
export default storages;
`,
      }),
    ).toEqual([
      "packages/jobs/src/exported.ts:3 `storage` exported",
      "packages/jobs/src/exported.ts:4 `handle` exported",
      "packages/jobs/src/exported.ts:5 `late` exported",
      "packages/jobs/src/exported.ts:10 `createStorage` exported",
      "packages/jobs/src/exported.ts:10 `storages` exported",
      "packages/jobs/src/exported.ts:11 `storages` exported",
    ]);
  });

  it("reports the web root and `@requestport/db` reached through `require(…)` or `import … = require(…)`", () => {
    // A namespace import, an `await import(…)` and a re-export of the root
    // are reported since ruling 125 (the web root's cases below).
    expect(
      plantedOffences({
        "apps/web/src/lib/required.ts": `import root = require("./server-request-port");
import database = require("@requestport/db");
export function leak() {
  const { webStorage } = require("./server-request-port.js");
  const { db } = require("@requestport/db");
  return [root, database, webStorage, db];
}
`,
      }),
    ).toEqual([
      "apps/web/src/lib/required.ts:1 imports the web root into a binding it cannot follow",
      "apps/web/src/lib/required.ts:2 imports `@requestport/db` into a binding it cannot follow",
      "apps/web/src/lib/required.ts:4 imports the web root into a binding it cannot follow",
      "apps/web/src/lib/required.ts:5 imports `@requestport/db` into a binding it cannot follow",
    ]);
  });

  it("follows the web root's own webStorage() body as the definition of webStorage, and reports the application storage returned unbound anywhere else in the root's module", () => {
    // apps/web/src/lib/server-request-port.ts: webStorage returns
    // `applicationStorageFromEnv()`, and webDatabase's traps call the
    // module's own webStorage(), which the sweep does not follow there.
    expect(
      plantedOffences({
        "apps/web/src/lib/reader.ts": `import { webStorage } from "./server-request-port.js";
export function leak() {
  return webStorage().db.execute("select 1");
}
export const kept = webStorage;
`,
        "apps/web/src/lib/server-request-port.ts": `import type { Database, Storage } from "@requestport/db";
import { applicationStorageFromEnv } from "@requestport/db/wiring";
export function webStorage(): Storage {
  return applicationStorageFromEnv();
}
export const webDatabase: Database = new Proxy({} as Database, {
  get(_target, property) {
    const { db } = webStorage();
    return Reflect.get(db, property, db);
  },
});
export function adminStorage(): Storage {
  return applicationStorageFromEnv();
}
`,
      }),
    ).toEqual([
      "apps/web/src/lib/reader.ts:3 `webStorage(…).db.execute`",
      "apps/web/src/lib/reader.ts:5 `webStorage` held in a variable",
      "apps/web/src/lib/server-request-port.ts:13 `applicationStorageFromEnv(…)` used as ReturnStatement",
    ]);
  });
});

/*
  The web root (apps/web/src/lib/server-request-port.ts; Plan 13, G.2): the
  web's modules open their transactions on a storage `webStorage()` returns,
  bound to a name, and the command transaction managers hold `webDatabase`.
  Both are followed as the package's own builders and handle are, imported
  by name with or without an extension, and a file that reaches the database
  through the root alone is read too. A namespace import of the root, an
  `await import(…)` of it and an `export … from` it are reported.
*/
describe("the sweep's boundary, through the web root", () => {
  it("follows what webStorage() returns, bound to a name, and webDatabase, imported by name from the web root", () => {
    expect(
      plantedOffences({
        "apps/web/src/lib/root-leak.ts": `import {
  createCommandTransactionManager,
  createImportRepository,
  createSlackRepository,
  requests,
} from "@requestport/db";
import { webDatabase, webStorage } from "./server-request-port.js";
export const transactions = createCommandTransactionManager(webDatabase);
export async function allowed() {
  const storage = webStorage();
  await createSlackRepository(storage.db).createOauthState({});
  return storage.transaction(async (tx) => createImportRepository(tx).listRuns());
}
export async function leak() {
  const storage = webStorage();
  await storage.db.delete(requests);
  return storage.transaction(async (tx) => tx.delete(requests));
}
export function direct() {
  return webDatabase.select().from(requests);
}
export function inTransaction() {
  return webDatabase.transaction(async (tx) => tx.execute("select 1"));
}
`,
        "apps/web/src/app/root-only.ts": `import { webStorage } from "../lib/server-request-port.js";
export function leak() {
  const storage = webStorage();
  return storage.db.execute("select 1");
}
`,
      }),
    ).toEqual([
      "apps/web/src/app/root-only.ts:4 `storage.db.execute`",
      "apps/web/src/lib/root-leak.ts:16 `storage.db.delete`",
      "apps/web/src/lib/root-leak.ts:17 `tx.delete`",
      "apps/web/src/lib/root-leak.ts:20 `webDatabase.select`",
      "apps/web/src/lib/root-leak.ts:23 `tx.execute`",
    ]);
  });

  it("follows a storage handed to createRequestPort, imported from @requestport/core, as its storage or ownerStorage option, and reports it handed as any other option, nested, or to any other function", () => {
    // Plan 13, G.6 (ruling 137): the web composes its RequestPort over the
    // root's storage. The storage goes to core's createRequestPort, which
    // hands its handle only to @requestport/db's functions; anywhere else it
    // is still reported.
    expect(
      plantedOffences({
        "apps/web/src/lib/composed.ts": `import {
  createBackgroundPort,
  createRequestPort,
  createRequestPort as compose,
} from "@requestport/core";
import { webStorage } from "./server-request-port.js";
export function port() {
  const storage = webStorage();
  return createRequestPort({ storage, secrets: {}, publicUrl: "" });
}
export function owner() {
  return compose({
    storage: webStorage(),
    ownerStorage: webStorage(),
    secrets: {},
    publicUrl: "",
  });
}
export function misused() {
  const storage = webStorage();
  createRequestPort({ background: storage, secrets: {}, publicUrl: "" });
  return createBackgroundPort({ storage: webStorage() });
}
export function nested() {
  return createRequestPort({ options: { storage: webStorage() } });
}
`,
      }),
    ).toEqual([
      "apps/web/src/lib/composed.ts:21 `storage` used as Property",
      "apps/web/src/lib/composed.ts:22 `webStorage(…)` used as Property",
      "apps/web/src/lib/composed.ts:25 `webStorage(…)` used as Property",
    ]);
  });

  it("follows a storage handed to createRequestPortHost, imported from @requestport/server, as its storage, and worker storages handed to createRequestPort as background.workerStorages, and reports either handed any other way (ruling 158, item 2)", () => {
    // Plan 13, H.4: `requestport start` serves over its application storage,
    // handed to the host and to core, and runs core's postgres background
    // over the worker storages it builds.
    expect(
      plantedOffences({
        "apps/requestport/src/serve/served.ts": `import { createRequestPort } from "@requestport/core";
import { createWorkerStorages } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
import * as server from "@requestport/server";
import {
  createRequestPortHost,
  createRequestPortHost as host,
} from "@requestport/server";
export function serve(env: NodeJS.ProcessEnv) {
  const storage = rootStorageFromEnv("application");
  const workerStorages = createWorkerStorages(env, { database: storage.db });
  const requestPort = createRequestPort({
    storage,
    secrets: {},
    publicUrl: "",
    background: { kind: "postgres", workerStorages },
  });
  return createRequestPortHost({ requestPort, storage, publicUrl: "" });
}
export function aliased() {
  return host({ storage: rootStorageFromEnv("application") });
}
export function misused(env: NodeJS.ProcessEnv) {
  const storage = rootStorageFromEnv("application");
  const workerStorages = createWorkerStorages(env, { database: storage.db });
  createRequestPort({ background: { workerStorages: storage } });
  createRequestPort({ workerStorages });
  createRequestPortHost({ storage: workerStorages });
  createRequestPortHost({ auth: { storage } });
  return server.createRequestPortHost({ storage });
}
`,
      }),
    ).toEqual([
      // A shorthand property is reported twice, as the survey's plant of
      // the serving composition measured it (track-h.md, H.4's survey).
      "apps/requestport/src/serve/served.ts:26 `storage` used as Property",
      "apps/requestport/src/serve/served.ts:27 `workerStorages` used as Property",
      "apps/requestport/src/serve/served.ts:27 `workerStorages` used as Property",
      "apps/requestport/src/serve/served.ts:28 `workerStorages` used as Property",
      "apps/requestport/src/serve/served.ts:29 `storage` used as Property",
      "apps/requestport/src/serve/served.ts:29 `storage` used as Property",
      "apps/requestport/src/serve/served.ts:30 `storage` used as Property",
      "apps/requestport/src/serve/served.ts:30 `storage` used as Property",
    ]);
  });

  it("follows the web root imported without an extension, and reports it imported or re-exported any other way, and a handle's unit read without a call", () => {
    expect(
      plantedOffences({
        "apps/web/src/app/extensionless.ts": `import { webStorage } from "../lib/server-request-port";
export function leak() {
  const storage = webStorage();
  return storage.db.execute("select 1");
}
`,
        "apps/web/src/lib/root-forms.ts": `import * as root from "./server-request-port.js";
export { webDatabase } from "./server-request-port.js";
export * from "./server-request-port";
export async function leak() {
  const { webStorage } = await import("./server-request-port.js");
  return webStorage().db.execute("select 1");
}
export function namespaced() {
  return root.webDatabase.execute("select 1");
}
`,
        "apps/web/src/lib/bare-read.ts": `import { requests } from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
import { webDatabase } from "./server-request-port.js";
const { db: handle } = rootStorageFromEnv("application");
const run = webDatabase.transaction;
const runDb = handle.transaction;
export function leak() {
  return run(async (tx) => tx.delete(requests));
}
export function rollback(failure) {
  return handle.transaction(async (tx) => failure.catch(tx.rollback));
}
`,
      }),
    ).toEqual([
      "apps/web/src/app/extensionless.ts:4 `storage.db.execute`",
      "apps/web/src/lib/bare-read.ts:5 `webDatabase.transaction` used as VariableDeclarator",
      "apps/web/src/lib/bare-read.ts:6 `handle.transaction` used as VariableDeclarator",
      "apps/web/src/lib/root-forms.ts:1 imports the web root into a binding it cannot follow",
      "apps/web/src/lib/root-forms.ts:2 re-exports the web root",
      "apps/web/src/lib/root-forms.ts:3 re-exports the web root",
      "apps/web/src/lib/root-forms.ts:5 imports the web root into a binding it cannot follow",
    ]);
  });

  it("knows every export of the web root", () => {
    const rootModule = parseAst(
      readFileSync(
        join(repositoryRoot, "apps/web/src/lib/server-request-port.ts"),
        "utf8",
      ),
      { lang: "ts" },
    ) as unknown as AstNode;
    const exported = list(rootModule, "body")
      .flatMap((node) => {
        if (node.type === "ExportDefaultDeclaration") return ["default"];
        if (node.type === "ExportAllDeclaration") return ["*"];
        if (node.type !== "ExportNamedDeclaration") return [];
        const declaration = field(node, "declaration");
        const declared = !declaration
          ? []
          : declaration.type === "VariableDeclaration"
            ? list(declaration, "declarations").map((declarator) =>
                nameOf(field(declarator, "id")),
              )
            : [nameOf(field(declaration, "id"))];
        return [
          ...declared,
          ...list(node, "specifiers").map((specifier) =>
            nameOf(field(specifier, "exported")),
          ),
        ];
      })
      .sort();
    // The sweep follows these two and reports any other way of reaching the
    // module, so anything else it exports must join `webRootBuilders` or
    // `webRootHandles`, or be shown to reach no database. The web's
    // RequestPort is not among them: `webRequestPort` has a module of its own
    // (`server-web-request-port.ts`; ruling 140), read as any other module.
    expect(exported).toEqual(["webDatabase", "webStorage"]);
    expect([...webRootBuilders.keys(), ...webRootHandles].sort()).toEqual(
      exported,
    );
  });
});

describe("the sweep's boundary, through core's re-exports (Plan 13, G.7; ruling 150)", () => {
  // Core's `.` re-exports `createStorage` from `@requestport/db`, and
  // `./migrate` re-exports `migrate` from `@requestport/db/migrate` (Done
  // when 12), so a module can take either from `@requestport/core` without
  // naming `@requestport/db`.
  it("follows createStorage and migrate imported by name from core's entries as it follows them from @requestport/db, so a storage built through core's createStorage is reported", () => {
    expect(
      plantedOffences({
        "packages/core/src/index.ts": `export {
  createDatabaseRoleGuard,
  createStorage,
  type DatabaseDriver,
  type DatabaseRoleGuard,
  DatabaseSurfaceError,
  type RoleGuardOptions,
  type Storage,
  type StorageOptions,
} from "@requestport/db";
export type { MigrationReport } from "@requestport/db/migrate";
export { createRequestPort } from "./request-port.js";
`,
        "packages/core/src/migrate.ts": `export { type MigrationReport, migrate } from "@requestport/db/migrate";
`,
        "apps/web/src/lib/through-core.ts": `import { createStorage } from "@requestport/core";
export function rows() {
  return createStorage({ driver: "pg" }).db.select();
}
`,
        "apps/cli/src/through-core.ts": `import { createDatabaseRoleGuard, createStorage as build } from "@requestport/core";
import { migrate } from "@requestport/core/migrate";
import { rootStorageFromEnv } from "@requestport/db/wiring";
export async function up() {
  const storage = rootStorageFromEnv("operator");
  return migrate(storage);
}
export function guarded() {
  return build({ driver: "pg", guard: createDatabaseRoleGuard() });
}
`,
      }),
    ).toEqual([
      "apps/cli/src/through-core.ts:9 `build` used as CallExpression",
      "apps/web/src/lib/through-core.ts:3 `createStorage` used as CallExpression",
    ]);
  });

  // Core's `.` re-exports `createWorkerStorages` and `WorkerStorages` too,
  // because `RequestPortBackground`'s `postgres` kind takes the worker
  // storages a caller builds with it (ruling 151).
  it("follows createWorkerStorages imported by name from core's . as it follows it from @requestport/db, so a storage built through it is reported", () => {
    expect(
      plantedOffences({
        "packages/core/src/index.ts": `export {
  createWorkerStorages,
  type WorkerStorages,
} from "@requestport/db";
`,
        "apps/cli/src/workers-through-core.ts": `import { createWorkerStorages } from "@requestport/core";
const storages = createWorkerStorages(process.env);
export const maintain = () => storages.maintenance.execute("select 1");
export function unit(organizationId: string) {
  return storages.withTenant(organizationId, async (database) =>
    database.execute("select 1"),
  );
}
export async function allowed() {
  await storages.roleReports();
  return storages.close();
}
`,
      }),
    ).toEqual([
      "apps/cli/src/workers-through-core.ts:3 `storages.maintenance.execute`",
      "apps/cli/src/workers-through-core.ts:6 `database.execute`",
    ]);
  });

  it("reports any other re-export of @requestport/db by core, a re-export of core's followed names by another module, and core's entries imported any other way than by name", () => {
    expect(
      plantedOffences({
        "packages/core/src/index.ts": `export { createStorage } from "@requestport/db";
export { createStorage as build } from "@requestport/db";
export { createE2EOwnerStorage, type Storage } from "@requestport/db";
export * from "@requestport/db/migrate";
export { migrate } from "@requestport/db/migrate";
`,
        "packages/core/src/adapters.ts": `export { createStorage } from "@requestport/db";
`,
        "packages/auth/src/index.ts": `export * from "@requestport/core/agent-services";
export { createRequestPort } from "@requestport/core";
export { createStorage } from "@requestport/core";
export * from "@requestport/core/migrate";
export { migrate as run } from "@requestport/core/migrate";
`,
        "apps/web/src/lib/core-forms.ts": `import * as core from "@requestport/core";
import migrator from "@requestport/core/migrate";
import { createAgentApiKeyService } from "@requestport/core/agent-services";
export const loaded = () => import("@requestport/core");
export const required = () => require("@requestport/core/migrate");
export const agents = () => import("@requestport/core/agent-services");
`,
      }),
    ).toEqual([
      "apps/web/src/lib/core-forms.ts:1 imports `@requestport/core` into a binding it cannot follow",
      "apps/web/src/lib/core-forms.ts:2 imports `@requestport/core/migrate` into a binding it cannot follow",
      "apps/web/src/lib/core-forms.ts:4 imports `@requestport/core` into a binding it cannot follow",
      "apps/web/src/lib/core-forms.ts:5 imports `@requestport/core/migrate` into a binding it cannot follow",
      "packages/auth/src/index.ts:3 re-exports `@requestport/core`, whose names from `@requestport/db` the sweep follows",
      "packages/auth/src/index.ts:4 re-exports `@requestport/core/migrate`, whose names from `@requestport/db` the sweep follows",
      "packages/auth/src/index.ts:5 re-exports `@requestport/core/migrate`, whose names from `@requestport/db` the sweep follows",
      "packages/core/src/adapters.ts:1 re-exports `@requestport/db`",
      "packages/core/src/index.ts:2 re-exports `@requestport/db`",
      "packages/core/src/index.ts:3 re-exports `@requestport/db`",
      "packages/core/src/index.ts:4 re-exports `@requestport/db`",
      "packages/core/src/index.ts:5 re-exports `@requestport/db`",
    ]);
  });

  it("knows what core's entries re-export from @requestport/db", () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "packages/core/package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    /** What `module` re-exports from the package, by specifier, sorted. */
    const reexports = (module: string) => {
      const program = parseAst(
        readFileSync(join(repositoryRoot, module), "utf8"),
        { lang: "ts" },
      ) as unknown as AstNode;
      const found: Record<string, string[]> = {};
      for (const node of list(program, "body")) {
        const source = field(node, "source")?.value;
        if (
          (node.type !== "ExportNamedDeclaration" &&
            node.type !== "ExportAllDeclaration") ||
          typeof source !== "string" ||
          !/^@requestport\/db(\/|$)/u.test(source)
        ) {
          continue;
        }
        found[source] = [
          ...(found[source] ?? []),
          ...(node.type === "ExportAllDeclaration"
            ? ["*"]
            : list(node, "specifiers").map(
                (specifier) => nameOf(field(specifier, "exported")) ?? "",
              )),
        ].sort();
      }
      return found;
    };
    const entries = Object.fromEntries(
      [".", "./migrate"].map((entry) => {
        const target = manifest.exports[entry];
        if (target === undefined) return [entry, "not exported"];
        const module = join("packages/core", target);
        return [entry, { module, names: reexports(module) }];
      }),
    );
    // The sweep follows the package's names through these two entries alone
    // (`coreReexports`), and the boundary reports a re-export of the package
    // by any other module outside packages/db, so the model must hold each
    // entry's module and exactly what it re-exports.
    expect(entries).toEqual({
      ".": {
        module: "packages/core/src/index.ts",
        names: {
          "@requestport/db": [
            "DatabaseDriver",
            "DatabaseRoleGuard",
            "DatabaseSurfaceError",
            "RoleGuardOptions",
            "Storage",
            "StorageOptions",
            "WorkerStorages",
            "createDatabaseRoleGuard",
            "createStorage",
            "createWorkerStorages",
          ],
          "@requestport/db/migrate": ["MigrationReport"],
        },
      },
      "./migrate": {
        module: "packages/core/src/migrate.ts",
        names: { "@requestport/db/migrate": ["MigrationReport", "migrate"] },
      },
    });
    expect(
      Object.fromEntries(
        [...coreReexports].map(([specifier, model]) => [
          specifier.replace(/^@requestport\/core/u, "."),
          model,
        ]),
      ),
    ).toEqual(entries);
  });
});

/**
  The names `@requestport/db`'s barrel exports from `./client.js` that yield a
  database handle: `createStorage`, which builds a storage around one
  (manifest-g.md §2.2). The default storage's own handle, `db`, was the other
  until G.5 retired it. A test above pins the barrel's exports from
  `./client.js`. `handleOffences` treats `createStorage` as it treats a
  handle, so it reports a call to it outside packages/db: a storage it built
  could otherwise be queried through its `db` without the sweep following
  it.

  The storages other functions return are followed: those of the package's
  builders (`storageBuilders`, below; ruling 119), of the web root's
  `webStorage` (`webRootBuilders`; ruling 125), and of the functions outside
  packages/db that return one (`storageWrappers`; Plan 13, G.3, ruling 130).
  Such a storage is followed where it is bound to a name; read by a member
  where it is built (`rootStorageFromEnv("worker").db`;
  `packages/auth/src/server.ts` hands createAuth
  `applicationStorageFromEnv().db` that way); returned from the body of the
  wrapper modelled with its shape, in that wrapper's own module (the web
  root's own `webStorage()` body; `worker-root.ts`'s
  `createWorkerStorages(…)`); handed straight to a function taken from the
  package, or to the one modelled to keep it (`storageSinks`); and built by a
  builder written in place as a parameter's default (`e2e-owner-storage.ts`'s
  `create = createE2EOwnerStorage`), which within that function is the
  builder. Followed as handles: what a storage's unit, or `inUnit`
  (`handleUnits`), hands its callback, and what `create-auth.ts`'s `database`
  option and `createDatabaseSignupPolicy`'s parameter return when called
  (`handleProviders`). Reported, as forms the sweep cannot follow: such a
  storage put to any other use (returned or handed on elsewhere, held,
  exported, or left anywhere else); a builder, or `inUnit`, named other than
  as a call's callee, but a builder written in place as a parameter's
  default; a storage or a handle bound by an exported declaration; and
  `./testing`'s `openSession`, `testPool`, `testPoolOfHandle` and `rawQuery`,
  which reach the pool itself, wherever they are imported
  (`rawTestingAccessors`).

  Not followed: a module through the functions it defines itself (the web
  root's `webDatabase` traps call its own `webStorage()`, and
  `server-request-port.handle.test.ts` pins what they answer; `inUnit` calls
  its module's own `workerStorages()`); a parameter that receives a storage or
  a handle, but a unit's callback's; and an import whose specifier is
  computed at run time. `handleOffences` reads a file whose text mentions
  `@requestport/db` or the name of a module the model follows
  (`followedModuleNames`), and no other.
*/
const databaseHandles = new Set(["createStorage"]);

/**
  What a storage builder returns, member by member:
  - `handles`: a handle (`db`; a worker storage's `dispatcher` and
    `maintenance`), followed as `db` is;
  - `units`: a unit of work, with the position of its callback, whose first
    parameter is a handle (`transaction`; a worker storage's `withTenant`);
  - `inert`: nothing the caller writes reaches the database through it: a
    value (`driver`, `bound`), the package's own probe (`ready`,
    `roleReports`) or function (`resolveJobOrganization`), or the end of a
    pool (`close`).
  Any other member is reported, the E2E owner storage's `query` among them:
  it runs SQL the caller writes.
*/
interface StorageShape {
  handles: readonly string[];
  units: Readonly<Record<string, number>>;
  inert: readonly string[];
}

/** `Storage` (`client.ts`). */
const storageShape: StorageShape = {
  handles: ["db"],
  units: { transaction: 0 },
  inert: ["driver", "ready", "close"],
};

/** `WorkerStorages` (`tenant-context.ts`). */
const workerStoragesShape: StorageShape = {
  handles: ["dispatcher", "maintenance"],
  units: { withTenant: 1 },
  inert: ["bound", "resolveJobOrganization", "roleReports", "close"],
};

/** `E2EOwnerStorage` (`e2e-owner-storage.ts`). */
const e2eOwnerStorageShape: StorageShape = {
  handles: [],
  units: {},
  inert: ["close"],
};

/** The type each shape models: what a wrapper of that shape is declared to return. */
const shapeTypes = new Map<StorageShape, string>([
  [storageShape, "Storage"],
  [workerStoragesShape, "WorkerStorages"],
  [e2eOwnerStorageShape, "E2EOwnerStorage"],
]);

/**
  The functions `@requestport/db` exports that return a storage, besides
  `createStorage` (ruling 119): `createWorkerStorages` (`WorkerStorages`,
  `tenant-context.ts`) from the barrel, `createE2EOwnerStorage`
  (`E2EOwnerStorage`, `e2e-owner-storage.ts`) from `./e2e`,
  `createTestStorage` from `./testing`, and `rootStorageFromEnv` and
  `applicationStorageFromEnv` from `./wiring`. Each is recognised by the name
  it is exported under, imported by name from `@requestport/db` or from any
  subpath of it. A name bound to what one returns — declared or assigned,
  after `await` or a type assertion — is followed as a storage of its shape,
  and a handle destructured from it as a handle; what one returns, read by a
  member where it is built, is followed as that storage's member (Plan 13,
  G.3).
*/
const storageBuilders = new Map<string, StorageShape>([
  ["createWorkerStorages", workerStoragesShape],
  ["createE2EOwnerStorage", e2eOwnerStorageShape],
  ["createTestStorage", storageShape],
  ["rootStorageFromEnv", storageShape],
  ["applicationStorageFromEnv", storageShape],
]);

/**
  The web root's module (`apps/web/src/lib/server-request-port.ts`; Plan 13,
  G.2), by any specifier that ends in its name, with or without an extension
  (`apps/web` resolves `./server-request-port` as `./server-request-port.js`),
  and what it exports: `webStorage`, which returns the application storage
  (`Storage`'s shape), and `webDatabase`, a handle that answers that
  storage's `db`'s members. Each is followed when imported by name from the
  module, as the package's own builders and `createStorage` are when imported
  from `@requestport/db`. The module exports nothing else ("knows every export
  of the web root", above, pins that), so a namespace import of it, an
  `await import(…)` of it by a string and an `export … from` it are
  reported as bindings the sweep cannot follow; a type-only one is reported
  too, which errs towards firing. A binding imported from it by name and
  exported again is reported as exported (Plan 13, G.3), and so is a
  `require(…)` of it. Not reported: an `import()` of a template literal,
  which the sweep reads for `@requestport/db` no better. The root's own
  module, which defines them, is not followed through them.
*/
const webRootModule = /(^|\/)server-request-port(\.[cm]?[jt]sx?)?$/u;
const webRootBuilders = new Map<string, StorageShape>([
  ["webStorage", storageShape],
]);
const webRootHandles = new Set(["webDatabase"]);
/**
  The functions a storage of a modelled shape may be handed to as an option
  of the object written in place as their first argument, each option by its
  path through objects written in place there, with the shape it takes
  (Plan 13, G.6; ruling 137; H.4, ruling 158 item 2):
  - `createRequestPort`, imported by name from `@requestport/core`: a
    `Storage` as its `storage` and `ownerStorage`, and the `WorkerStorages` a
    `postgres` background runs over as `background.workerStorages`;
  - `createRequestPortHost`, imported by name from `@requestport/server`: a
    `Storage` as its `storage`, which the host's readiness, artifact import
    and rate limiter run on (`packages/server/src/host.ts`).
  Handed as any other option, at any other depth, or as an option of the
  wrong shape, it is reported, as it is handed to any other function.

  The web's RequestPort module (`apps/web/src/lib/server-web-request-port.ts`;
  ruling 140) imports `webStorage` by name from the web root and hands
  `createRequestPort` `webStorage()` as its `storage`, which is followed this
  way; `requestport start`'s serving composition
  (`apps/requestport/src/serve/serve.ts`) hands both functions its
  application storage and core its worker storages. A RequestPort and a host
  have no storage or handle member: their capabilities reach the database
  through core and packages/server, which hand the storage, and its handle,
  only to their own functions and to `@requestport/db`'s. The sweep reads
  packages/core and packages/server as it reads any package outside
  packages/db, and does not follow a storage either receives as a parameter;
  `webRequestPort`, imported by name from that module, yields nothing the
  model follows.
*/
const requestPortModule = /^@requestport\/core$/u;
const hostModule = /^@requestport\/server$/u;
interface StorageOption {
  /** The keys from the first argument's object to the storage's property. */
  path: readonly string[];
  shape: StorageShape;
}
const storageOptionTakers = new Map<
  string,
  { module: RegExp; options: readonly StorageOption[] }
>([
  [
    "createRequestPort",
    {
      module: requestPortModule,
      options: [
        { path: ["storage"], shape: storageShape },
        { path: ["ownerStorage"], shape: storageShape },
        { path: ["background", "workerStorages"], shape: workerStoragesShape },
      ],
    },
  ],
  [
    "createRequestPortHost",
    {
      module: hostModule,
      options: [{ path: ["storage"], shape: storageShape }],
    },
  ],
]);

/**
  The other functions outside packages/db that the sweep follows (Plan 13,
  G.3; rulings 124, 125 and 130), each by the module that defines it: any
  specifier that ends in that module's name, with or without an extension, or
  the package that re-exports it (`@requestport/jobs`). Each is followed where
  it is imported by name from such a specifier; "knows where every function
  outside packages/db that it models is defined" (above) pins where each is.
  - `storageWrappers`: a function that returns a storage, followed as a
    builder of its shape, as the web root's `webStorage` is. Its own body, in
    its own module, is the one place a storage of that shape may be returned
    (`worker-root.ts` returns `createWorkerStorages(…)`, `workerStorages` the
    storage it holds, `openE2EOwnerStorage` what its `create` builds).
  - `handleUnits`: a function that hands the callback in the given position
    a handle, as a storage's unit does (`inUnit`: one processing unit on the
    worker's tenant storage).
  - `storageSinks`: a function that keeps a storage of its shape for a wrapper
    to return (`useWorkerStorages`, for `workerStorages`).
  - `handleProviders`: a function that takes, as the parameter in the given
    position or as that parameter's option, a function returning a handle.
    In the provider-taker's own module a call of that function is followed as
    a handle, and the function may be handed on only to a provider-taker; at
    a call of one, a handle returned by a function written in place as that
    argument is handed to it.
  Any other import of a module these name — a namespace, a default import,
  `import(…)`, `require(…)` — is reported as a binding the sweep cannot
  follow, and so is a re-export of one of these functions, or an `export *`
  of such a module, but by the module that re-exports them for its package
  (`modeledBarrels`). Re-exporting the module's other names is not.
*/
const workerRootModule = /(^|\/)worker-root(\.[cm]?[jt]sx?)?$/u;
const workerStoragesModule =
  /(^|\/)worker-storages(\.[cm]?[jt]sx?)?$|^@requestport\/jobs$/u;
const e2eOwnerStorageModule = /(^|\/)e2e-owner-storage(\.[cm]?[jt]sx?)?$/u;
const createAuthModule = /(^|\/)create-auth(\.[cm]?[jt]sx?)?$/u;
const signupPolicyModule = /(^|\/)database-signup-policy(\.[cm]?[jt]sx?)?$/u;
const modeledModules = [
  workerRootModule,
  workerStoragesModule,
  e2eOwnerStorageModule,
  createAuthModule,
  signupPolicyModule,
];
/**
  What `boundaryOffences` looks for in a file's text before it reads the
  file: the name of the web root's module and of each module above, and
  `@requestport/core`, whose entries re-export `@requestport/db`'s names
  (`coreReexports`, below; Plan 13, G.7). A name that appears anywhere, a
  comment included, is enough: reading a file the model has nothing to say
  of reports nothing.
*/
const followedModuleNames = [
  "server-request-port",
  "worker-root",
  "worker-storages",
  "@requestport/jobs",
  "e2e-owner-storage",
  "create-auth",
  "database-signup-policy",
  "@requestport/core",
];

interface ModeledStorage {
  module: RegExp;
  shape: StorageShape;
}

const storageWrappers = new Map<string, ModeledStorage>([
  [
    "workerStoragesFromRoot",
    { module: workerRootModule, shape: workerStoragesShape },
  ],
  [
    "workerStorages",
    { module: workerStoragesModule, shape: workerStoragesShape },
  ],
  [
    "openE2EOwnerStorage",
    { module: e2eOwnerStorageModule, shape: e2eOwnerStorageShape },
  ],
]);

const handleUnits = new Map<string, { module: RegExp; callback: number }>([
  ["inUnit", { module: workerStoragesModule, callback: 1 }],
]);

const storageSinks = new Map<string, ModeledStorage>([
  [
    "useWorkerStorages",
    { module: workerStoragesModule, shape: workerStoragesShape },
  ],
]);

interface HandleProvider {
  module: RegExp;
  parameter: number;
  option?: string;
}

const handleProviders = new Map<string, HandleProvider>([
  [
    "createAuth",
    { module: createAuthModule, parameter: 0, option: "database" },
  ],
  ["createDatabaseSignupPolicy", { module: signupPolicyModule, parameter: 0 }],
]);

/** A module that re-exports a modelled one for its package, by its path. */
const modeledBarrels = new Map<string, RegExp>([
  ["packages/jobs/src/index.ts", workerStoragesModule],
]);

/**
  Core's entries that re-export `@requestport/db`'s names (Plan 13, G.7;
  rulings 150 and 151), by the specifier a module imports the entry by,
  with the module that is the entry and what it re-exports, by the
  package's specifier: `.` re-exports `createStorage`, the role guard
  (`createDatabaseRoleGuard`, `DatabaseSurfaceError`), `createWorkerStorages`,
  their types and `MigrationReport`, and `./migrate` re-exports `migrate`
  and `MigrationReport`. "Knows what core's entries re-export from
  @requestport/db" pins both against core's manifest and modules.
  - Each of those two modules may re-export these names from the package,
    and no other, each under its own name; any other re-export of the
    package outside packages/db is reported, as before.
  - A name imported by name from the entry, when the entry re-exports it,
    is followed as the same name imported from `@requestport/db`:
    `createStorage` as a handle, reported wherever it is used;
    `createWorkerStorages` as a storage builder (`storageBuilders`), whose
    storages are followed; and `migrate` as a function taken from the
    package, which a storage may be handed to.
  - Any other import of the entry (a namespace, a default import,
    `import(…)`, `require(…)`) is reported as a binding the sweep cannot
    follow, and so is a re-export from the entry of a name it re-exports
    from the package, or an `export *` of the entry.
*/
const coreReexports = new Map<
  string,
  { module: string; names: Readonly<Record<string, readonly string[]>> }
>([
  [
    "@requestport/core",
    {
      module: "packages/core/src/index.ts",
      names: {
        "@requestport/db": [
          "DatabaseDriver",
          "DatabaseRoleGuard",
          "DatabaseSurfaceError",
          "RoleGuardOptions",
          "Storage",
          "StorageOptions",
          "WorkerStorages",
          "createDatabaseRoleGuard",
          "createStorage",
          "createWorkerStorages",
        ],
        "@requestport/db/migrate": ["MigrationReport"],
      },
    },
  ],
  [
    "@requestport/core/migrate",
    {
      module: "packages/core/src/migrate.ts",
      names: { "@requestport/db/migrate": ["MigrationReport", "migrate"] },
    },
  ],
]);

/** Whether core's entry `entry` re-exports `name` from `@requestport/db` (`coreReexports`). */
function reexportedByCore(entry: string, name: string): boolean {
  return Object.values(coreReexports.get(entry)?.names ?? {}).some((names) =>
    names.includes(name),
  );
}

/** The wrapper modelled under `name`: the web root's `webStorage`, or one of `storageWrappers`. */
function wrapperModel(name: string): ModeledStorage | undefined {
  const shape = webRootBuilders.get(name);
  return shape ? { module: webRootModule, shape } : storageWrappers.get(name);
}

/** Whether `name`, taken from the module `from` names, is a function the model above follows. */
function isModeledName(name: string, from: string): boolean {
  return [storageWrappers, handleUnits, storageSinks, handleProviders].some(
    (models) => models.get(name)?.module.test(from) ?? false,
  );
}

/**
  `./testing`'s functions that reach the pool itself, outside any handle the
  sweep follows: `testPool` returns it, `testPoolOfHandle` returns a handle's,
  `rawQuery` runs SQL text on it, and `openSession` checks a connection out
  of it. Never followed: each is reported wherever it is imported or read.
*/
const rawTestingAccessors = new Set([
  "openSession",
  "rawQuery",
  "testPool",
  "testPoolOfHandle",
]);

/**
  What, outside packages/db, could run a query the sweep never reads. In the
  non-test source of apps/, packages/ and trigger/ (outside packages/db and
  the Playwright suite in apps/web/tests):

  - a file that imports drizzle-orm, `pg` or the hosted driver's package
    (`HOSTED_DRIVER_PACKAGES`, `hosted-driver.ts`), or mentions `$client`;
  - any use of `createStorage` taken from `@requestport/db`, the one name
    its barrel exports that yields a handle (a call of it is a use; G.5
    retired the other, the default storage's `db`) — imported by name, or
    destructured from `await import(…)`, directly or through
    `Promise.all([…])`, or imported by name from `@requestport/core`, which
    re-exports it (`coreReexports`; Plan 13, G.7) — or of the web root's
    `webDatabase`, imported by
    name, or of the handle a `.transaction` callback receives,
    other than calling `.transaction` or reading `.rollback` on it (a
    `.transaction` read without a call is reported, because the callback a
    later call hands it would go unread; `.rollback` takes no callback) or
    passing it
    straight to a function taken from `@requestport/db` by name or through a
    namespace binding (a repository factory, swept here), or by name from a
    core entry that re-exports it (`migrate`, from `@requestport/core/migrate`),
    or to Better Auth's
    `drizzleAdapter` (identity tables only; see the test of `identitySchema`).
    Passing it as the value of a property of an object written in place as
    such a function's argument (`createWorkerStorages(env, { storage })`)
    counts as passing it straight, and so does returning it from a function
    written in place as a handle provider's argument
    (`createAuth({ database: () => … })`, `handleProviders`);
  - the same of a storage one of `storageBuilders` (`createWorkerStorages`
    among them, also when imported by name from `@requestport/core`, which
    re-exports it; ruling 151), the web root's `webStorage` or one of
    `storageWrappers` returns — bound to a name, or
    read by a member where it is built — and of each handle it holds
    (`storage.db`) or hands to the callback of one of its units
    (`storage.transaction`, `withTenant`), of the handle `inUnit` hands its
    callback, and of what a handle provider's function returns when called
    in the provider-taker's module; any member of the storage its shape
    names as neither a handle, a unit nor inert (the E2E owner storage's
    `query`, which runs SQL the caller writes, among them); and a binding
    destructured from it that is neither one of its handles nor inert;
  - on a namespace binding of `@requestport/db` (`import * as`, or
    `await import(…)` bound to a name), reading `.db` or a computed member,
    or using the namespace as anything but the object of a member access;
  - a storage itself put to any use but those followed (the comment above
    `databaseHandles`): returned or handed on outside the wrapper and the
    sink the model names for its shape, held, exported, or used as a value;
    a storage or a handle bound by an exported declaration; and a builder,
    or `inUnit`, used as a value, but a builder written in place as a
    parameter's default;
  - `./testing`'s `openSession`, `testPool`, `testPoolOfHandle` and
    `rawQuery`, imported, or read from a namespace of the package
    (`rawTestingAccessors`), and a builder read from such a namespace
    without being called;
  - a `require(…)`, or `import … = require(…)`, of `@requestport/db`, of the
    web root or of a module the model names; any other import of such a
    module than by name; and a re-export of a function the model follows, or
    an `export *` of its module, but by the module that re-exports it for its
    package (`modeledBarrels`);
  - a default import of `@requestport/db`, a re-export of it, but by the
    core entry that re-exports those names (`coreReexports`), a dynamic
    import bound any other way, and a `.transaction` (or a storage's unit)
    whose callback is not written in place or whose handle is destructured;
  - a namespace import of the web root, an `await import(…)` of it by a
    string, and an `export … from` it;
  - an import of a core entry that re-exports the package's names
    (`coreReexports`) other than by name, its `require(…)` included, a
    re-export from it of a name it re-exports from the package, and an
    `export *` of it.

  A handle, storage or namespace is matched by name within its scope (the
  file, for an import, a namespace or an assigned storage; the callback that
  receives a handle; the function around the declaration of a storage, or of
  a handle destructured from one, or the file at its top level), so an
  unrelated variable that shadows it is reported too: the check errs towards
  firing. A name in a type position (`typeof db`) carries no value and is not
  reported. The same holds of a builder written in place as a parameter's
  default, within the function whose parameter it is, and of the function a
  provider-taker takes, within the provider-taker.
*/
/**
 * An import of a database driver: drizzle-orm, `pg` or the hosted driver's
 * package, each name escaped for the pattern.
 */
const databaseDriverImport = new RegExp(
  `from ["'](${["drizzle-orm", "pg", ...HOSTED_DRIVER_PACKAGES]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|")})["'/]`,
  "u",
);

function boundaryOffences(root: string): string[] {
  const offences: string[] = [];
  for (const path of boundaryFiles(root)) {
    const file = relative(root, path);
    const text = readFileSync(path, "utf8");
    if (databaseDriverImport.test(text) || /\$client\b/u.test(text)) {
      offences.push(`${file} imports a database driver or reaches \`$client\``);
    }
    if (
      text.includes("@requestport/db") ||
      followedModuleNames.some((name) => text.includes(name))
    ) {
      offences.push(...handleOffences(file, text));
    }
  }
  return offences;
}

/**
  The files `boundaryOffences` reads, sorted:
  the source under `root`'s apps/, packages/ and trigger/, outside
  packages/db, the Playwright suite in apps/web/tests and the generated
  directories, in `.ts`, `.tsx`, `.mts`, `.js` and `.mjs` files that are
  neither a test (`*.test.*`, `*.spec.*`) nor a declaration file (`.d.ts`).
*/
function boundaryFiles(root: string): string[] {
  const files: string[] = [];
  const skipped = new Set(
    ["packages/db", "apps/web/tests"].map((path) => join(root, path)),
  );
  const generated = new Set([
    "node_modules",
    ".next",
    ".next-self-host",
    ".turbo",
    "dist",
    "coverage",
  ]);
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!generated.has(entry.name) && !skipped.has(path)) walk(path);
      } else if (
        /\.(ts|tsx|mts|js|mjs)$/u.test(entry.name) &&
        !/\.(test|spec)\.[a-z]+$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(path);
      }
    }
  };
  for (const name of ["apps", "packages", "trigger"]) {
    const directory = join(root, name);
    if (existsSync(directory)) walk(directory);
  }
  return files.sort();
}

/**
  Where each function outside packages/db that the model follows is defined
  under `root`: every function a file the boundary reads exports by a name
  the model holds, where the file's path is one its module's matcher names,
  with what the model takes it to be. A wrapper's line also says what it is
  declared to return, and whether that is the type its shape models.
*/
function modeledDefinitions(root: string): string[] {
  const models = new Map<
    string,
    { module: RegExp; kind: string; shape?: StorageShape }
  >();
  for (const [name, shape] of webRootBuilders) {
    models.set(name, { module: webRootModule, kind: "a wrapper", shape });
  }
  for (const [name, { module, shape }] of storageWrappers) {
    models.set(name, { module, kind: "a wrapper", shape });
  }
  for (const [name, { module }] of handleUnits) {
    models.set(name, { module, kind: "a unit" });
  }
  for (const [name, { module }] of storageSinks) {
    models.set(name, { module, kind: "a sink" });
  }
  for (const [name, { module }] of handleProviders) {
    models.set(name, { module, kind: "a handle provider" });
  }
  const found: string[] = [];
  for (const path of boundaryFiles(root)) {
    const file = relative(root, path);
    if (![...models.values()].some(({ module }) => module.test(file))) {
      continue;
    }
    const program = parseAst(readFileSync(path, "utf8"), {
      lang: /\.tsx$/u.test(file) ? "tsx" : /\.m?js$/u.test(file) ? "js" : "ts",
    }) as unknown as AstNode;
    for (const node of list(program, "body")) {
      const declaration =
        node.type === "ExportNamedDeclaration"
          ? field(node, "declaration")
          : undefined;
      const name =
        declaration?.type === "FunctionDeclaration"
          ? nameOf(field(declaration, "id"))
          : undefined;
      const model = name === undefined ? undefined : models.get(name);
      if (!declaration || !model?.module.test(file)) continue;
      if (model.shape === undefined) {
        found.push(`${name}, ${model.kind}: ${file}`);
        continue;
      }
      const returnType = field(declaration, "returnType");
      const annotation = returnType && field(returnType, "typeAnnotation");
      const declared = nameOf(annotation && field(annotation, "typeName"));
      const modeled = shapeTypes.get(model.shape);
      found.push(
        declared === modeled
          ? `${name}, a wrapper returning ${declared}: ${file}`
          : `${name}, a wrapper declared to return ${declared ?? "no named type"}, where its shape models ${modeled}: ${file}`,
      );
    }
  }
  return found.sort();
}

function handleOffences(file: string, text: string): string[] {
  const program = parseAst(text, {
    lang: /\.tsx$/u.test(file) ? "tsx" : /\.m?js$/u.test(file) ? "js" : "ts",
  }) as unknown as AstNode;
  const parents = new Map<AstNode, AstNode>();
  const all: AstNode[] = [];
  const visit = (node: AstNode) => {
    all.push(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) {
          parents.set(child, node);
          visit(child);
        }
      }
    }
  };
  visit(program);
  const line = (node: AstNode) => text.slice(0, node.start).split("\n").length;
  const offences: Array<{ line: number; what: string }> = [];
  const report = (node: AstNode, what: string) =>
    offences.push({ line: line(node), what });
  const isPackage = (node: AstNode | undefined) =>
    node?.type === "Literal" &&
    typeof node.value === "string" &&
    /^@requestport\/db(\/|$)/u.test(node.value);
  const isWebRoot = (node: AstNode | undefined) =>
    node?.type === "Literal" &&
    typeof node.value === "string" &&
    webRootModule.test(node.value);
  const isModeled = (node: AstNode | undefined) =>
    node?.type === "Literal" &&
    typeof node.value === "string" &&
    modeledModules.some((module) => module.test(node.value as string));
  /** Whether `node` names one of core's entries that re-export the package (`coreReexports`). */
  const isCoreEntry = (node: AstNode | undefined) =>
    node?.type === "Literal" &&
    typeof node.value === "string" &&
    coreReexports.has(node.value);
  /**
    Whether `node`, an `export … from` the package, is one of core's entries'
    own re-exports (`coreReexports`): in that entry's module, by name, each
    name one the model holds for that specifier, under its own name.
  */
  const isCoreReexport = (node: AstNode) => {
    const names = [...coreReexports.values()].find(
      ({ module }) => module === file,
    )?.names[field(node, "source")?.value as string];
    return (
      node.type === "ExportNamedDeclaration" &&
      names !== undefined &&
      list(node, "specifiers").every((specifier) => {
        const local = nameOf(field(specifier, "local"));
        return (
          local !== undefined &&
          local === nameOf(field(specifier, "exported")) &&
          names.includes(local)
        );
      })
    );
  };
  /** What an import or a `require(…)` of `node`'s module cannot be followed as. */
  const unfollowable = (node: AstNode | undefined) =>
    isPackage(node)
      ? "imports `@requestport/db` into a binding it cannot follow"
      : isWebRoot(node)
        ? "imports the web root into a binding it cannot follow"
        : isModeled(node)
          ? `imports \`${node?.value}\`, a module the sweep models, into a binding it cannot follow`
          : isCoreEntry(node)
            ? `imports \`${node?.value}\` into a binding it cannot follow`
            : undefined;

  const handles: Array<{ name: string; scope: AstNode; declared: AstNode }> =
    [];
  const namespaces: Array<{ name: string; declared: AstNode }> = [];
  const allowedCallees = new Set<string>();
  /** A storage builder's local name, and the shape of what it returns. */
  const builders = new Map<string, StorageShape>();
  /** The modelled units, sinks and provider-takers imported, by local name. */
  const units = new Map<string, number>();
  const sinks = new Map<string, StorageShape>();
  const providers = new Map<string, HandleProvider>();
  /** The option-takers imported (`storageOptionTakers`), by local name. */
  const optionTakers = new Map<string, readonly StorageOption[]>();
  /** A name imported from a module the model names (`storageWrappers` and the rest). */
  const bindModeled = (local: AstNode, imported: string, from: string) => {
    const name = local.name as string;
    const wrapper = storageWrappers.get(imported);
    if (wrapper?.module.test(from)) builders.set(name, wrapper.shape);
    const unit = handleUnits.get(imported);
    if (unit?.module.test(from)) units.set(name, unit.callback);
    const sink = storageSinks.get(imported);
    if (sink?.module.test(from)) sinks.set(name, sink.shape);
    const provider = handleProviders.get(imported);
    if (provider?.module.test(from)) providers.set(name, provider);
  };
  const bindNamed = (local: AstNode, imported: string) => {
    allowedCallees.add(local.name as string);
    if (rawTestingAccessors.has(imported)) {
      report(local, `imports \`${imported}\`, which reaches the pool directly`);
    }
    if (databaseHandles.has(imported)) {
      handles.push({
        name: local.name as string,
        scope: program,
        declared: local,
      });
    }
    const shape = storageBuilders.get(imported);
    if (shape) builders.set(local.name as string, shape);
  };
  /** `{ a, b: c }` destructured from the module, statically or not. */
  const bindPattern = (pattern: AstNode | undefined, at: AstNode) => {
    if (pattern?.type === "Identifier") {
      namespaces.push({ name: pattern.name as string, declared: pattern });
      return;
    }
    if (pattern?.type !== "ObjectPattern") {
      report(at, "imports `@requestport/db` into a binding it cannot follow");
      return;
    }
    for (const property of list(pattern, "properties")) {
      const key =
        property.type === "Property" && !property.computed
          ? nameOf(field(property, "key"))
          : undefined;
      let value = field(property, "value");
      if (value?.type === "AssignmentPattern") value = field(value, "left");
      if (key && value?.type === "Identifier") bindNamed(value, key);
      else
        report(at, "imports `@requestport/db` into a binding it cannot follow");
    }
  };
  for (const node of list(program, "body")) {
    if (node.type === "ImportDeclaration") {
      const from = field(node, "source")?.value;
      for (const specifier of list(node, "specifiers")) {
        const local = field(specifier, "local") as AstNode;
        if (isPackage(field(node, "source"))) {
          if (specifier.type === "ImportSpecifier") {
            bindNamed(local, nameOf(field(specifier, "imported")) ?? "");
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.push({ name: local.name as string, declared: local });
          } else {
            report(
              node,
              "imports `@requestport/db` into a binding it cannot follow",
            );
          }
        } else if (
          from === "better-auth/adapters/drizzle" &&
          nameOf(field(specifier, "imported")) === "drizzleAdapter"
        ) {
          allowedCallees.add(local.name as string);
        } else if (
          isWebRoot(field(node, "source")) &&
          specifier.type !== "ImportSpecifier"
        ) {
          report(node, "imports the web root into a binding it cannot follow");
        } else if (isWebRoot(field(node, "source"))) {
          const imported = nameOf(field(specifier, "imported")) ?? "";
          const shape = webRootBuilders.get(imported);
          if (shape) builders.set(local.name as string, shape);
          if (webRootHandles.has(imported)) {
            handles.push({
              name: local.name as string,
              scope: program,
              declared: local,
            });
          }
        } else if (isModeled(field(node, "source"))) {
          if (specifier.type === "ImportSpecifier") {
            const imported = nameOf(field(specifier, "imported")) ?? "";
            bindModeled(local, imported, from as string);
          } else {
            report(node, unfollowable(field(node, "source")) as string);
          }
        } else if (isCoreEntry(field(node, "source"))) {
          // Core's entries (`coreReexports`). `createRequestPort`, an
          // option-taker (`storageOptionTakers`), is taken from
          // `@requestport/core`, one of them, so it is bound here too.
          if (specifier.type !== "ImportSpecifier") {
            report(node, unfollowable(field(node, "source")) as string);
            continue;
          }
          const imported = nameOf(field(specifier, "imported")) ?? "";
          if (reexportedByCore(from as string, imported)) {
            bindNamed(local, imported);
          }
          const taker = storageOptionTakers.get(imported);
          if (taker?.module.test(from as string)) {
            optionTakers.set(local.name as string, taker.options);
          }
        } else if (
          typeof from === "string" &&
          hostModule.test(from) &&
          specifier.type === "ImportSpecifier"
        ) {
          // `createRequestPortHost`, the host's option-taker, by name from
          // `@requestport/server`. Any other import of that package binds
          // nothing the model follows, so a storage handed through it is
          // reported where it is handed.
          const imported = nameOf(field(specifier, "imported")) ?? "";
          const taker = storageOptionTakers.get(imported);
          if (taker?.module.test(from)) {
            optionTakers.set(local.name as string, taker.options);
          }
        }
      }
    } else if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isPackage(field(node, "source"))
    ) {
      if (!isCoreReexport(node)) report(node, "re-exports `@requestport/db`");
    } else if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isCoreEntry(field(node, "source")) &&
      (node.type === "ExportAllDeclaration" ||
        list(node, "specifiers").some((specifier) =>
          reexportedByCore(
            field(node, "source")?.value as string,
            nameOf(field(specifier, "local")) ?? "",
          ),
        ))
    ) {
      report(
        node,
        `re-exports \`${field(node, "source")?.value}\`, whose names from \`@requestport/db\` the sweep follows`,
      );
    } else if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isWebRoot(field(node, "source"))
    ) {
      report(node, "re-exports the web root");
    } else if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isModeled(field(node, "source")) &&
      !modeledBarrels.get(file)?.test(field(node, "source")?.value as string) &&
      (node.type === "ExportAllDeclaration" ||
        list(node, "specifiers").some((specifier) =>
          isModeledName(
            nameOf(field(specifier, "local")) ?? "",
            field(node, "source")?.value as string,
          ),
        ))
    ) {
      report(
        node,
        `re-exports \`${field(node, "source")?.value}\`, a module the sweep models`,
      );
    }
  }
  // `const x = await import(…)`, and `const [x, …] = await Promise.all([
  // import(…), …])`.
  const awaited = (node: AstNode) => {
    const parent = parents.get(node);
    return parent?.type === "AwaitExpression" ? parent : node;
  };
  for (const node of all) {
    if (node.type === "ImportExpression" && isWebRoot(field(node, "source"))) {
      report(node, "imports the web root into a binding it cannot follow");
      continue;
    }
    if (
      node.type === "ImportExpression" &&
      (isModeled(field(node, "source")) || isCoreEntry(field(node, "source")))
    ) {
      report(node, unfollowable(field(node, "source")) as string);
      continue;
    }
    // `require(…)` and `import … = require(…)`: never followed.
    const required =
      node.type === "CallExpression" &&
      nameOf(field(node, "callee")) === "require"
        ? list(node, "arguments")[0]
        : node.type === "TSImportEqualsDeclaration"
          ? field(field(node, "moduleReference") ?? node, "expression")
          : undefined;
    if (required && unfollowable(required)) {
      report(node, unfollowable(required) as string);
      continue;
    }
    if (node.type !== "ImportExpression" || !isPackage(field(node, "source"))) {
      continue;
    }
    const outer = awaited(node);
    const parent = parents.get(outer);
    if (parent?.type === "VariableDeclarator" && parent.init === outer) {
      bindPattern(field(parent, "id"), node);
      continue;
    }
    const call =
      parent?.type === "ArrayExpression" ? parents.get(parent) : undefined;
    const callee = call && field(call, "callee");
    const declarator = call ? parents.get(awaited(call)) : undefined;
    const pattern = declarator && field(declarator, "id");
    if (
      parent &&
      callee &&
      text.slice(callee.start, callee.end) === "Promise.all" &&
      declarator?.type === "VariableDeclarator" &&
      pattern?.type === "ArrayPattern"
    ) {
      const index = (parent.elements as unknown[]).indexOf(node);
      const element = (pattern.elements as unknown[])[index];
      bindPattern(isNode(element) ? element : undefined, node);
      continue;
    }
    report(node, "imports `@requestport/db` into a binding it cannot follow");
  }
  const namespaceAt = (node: AstNode) =>
    node.type === "Identifier" &&
    namespaces.find((namespace) => namespace.name === node.name);
  const handleAt = (node: AstNode) =>
    node.type === "Identifier" &&
    handles.find(
      (handle) =>
        handle.name === node.name &&
        handle.scope.start <= node.start &&
        node.end <= handle.scope.end,
    );
  /** A function's name: its own, or that of the variable it initialises. */
  const functionName = (fn: AstNode) => {
    const id = field(fn, "id");
    if (id?.type === "Identifier") return id.name as string;
    const holder = parents.get(fn);
    return holder?.type === "VariableDeclarator" && holder.init === fn
      ? nameOf(field(holder, "id"))
      : undefined;
  };
  /** The function around `node`, if there is one. */
  const enclosingFunction = (node: AstNode) => {
    let current = parents.get(node);
    while (current && !isFunction(current)) current = parents.get(current);
    return current;
  };
  /**
    A builder written in place as a parameter's default
    (`create = createE2EOwnerStorage`): within its function, the parameter is
    that builder.
  */
  const aliases: Array<{
    name: string;
    scope: AstNode;
    shape: StorageShape;
    builder: AstNode;
  }> = [];
  for (const node of all) {
    const shape =
      node.type === "Identifier"
        ? builders.get(node.name as string)
        : undefined;
    const pattern = shape && parents.get(node);
    const left = pattern && field(pattern, "left");
    const fn = pattern && parents.get(pattern);
    if (
      shape &&
      pattern?.type === "AssignmentPattern" &&
      pattern.right === node &&
      left?.type === "Identifier" &&
      fn &&
      isFunction(fn) &&
      list(fn, "params").includes(pattern)
    ) {
      aliases.push({
        name: left.name as string,
        scope: fn,
        shape,
        builder: node,
      });
    }
  }
  const aliasAt = (node: AstNode) =>
    node.type === "Identifier"
      ? aliases.find(
          (alias) =>
            alias.name === node.name &&
            alias.scope.start <= node.start &&
            node.end <= alias.scope.end,
        )
      : undefined;
  /** The functions written in place as a provider-taker's provider. */
  const inPlaceProviders = new Set<AstNode>();
  for (const node of all) {
    const callee =
      node.type === "CallExpression" ? field(node, "callee") : undefined;
    const model =
      callee?.type === "Identifier"
        ? providers.get(callee.name as string)
        : undefined;
    if (!model) continue;
    let argument: AstNode | undefined = list(node, "arguments")[
      model.parameter
    ];
    if (model.option !== undefined) {
      const property =
        argument?.type === "ObjectExpression"
          ? list(argument, "properties").find(
              (candidate) =>
                candidate.type === "Property" &&
                !candidate.computed &&
                nameOf(field(candidate, "key")) === model.option,
            )
          : undefined;
      argument = property && field(property, "value");
    }
    if (argument && isFunction(argument)) inPlaceProviders.add(argument);
  }
  /**
    In a provider-taker's own module, the binding of the function it takes:
    its parameter, or that parameter's option destructured in place.
  */
  const providerBindings: Array<{
    name: string;
    scope: AstNode;
    declared: AstNode[];
  }> = [];
  for (const node of all) {
    if (!isFunction(node)) continue;
    const name = functionName(node);
    const model = name === undefined ? undefined : handleProviders.get(name);
    if (!model?.module.test(file)) continue;
    let param: AstNode | undefined = list(node, "params")[model.parameter];
    if (param?.type === "AssignmentPattern") param = field(param, "left");
    let binding: AstNode | undefined;
    const declared: AstNode[] = [];
    if (model.option === undefined) {
      binding = param?.type === "Identifier" ? param : undefined;
    } else if (param?.type === "ObjectPattern") {
      const property = list(param, "properties").find(
        (candidate) =>
          candidate.type === "Property" &&
          !candidate.computed &&
          nameOf(field(candidate, "key")) === model.option,
      );
      let value = property && field(property, "value");
      if (value?.type === "AssignmentPattern") value = field(value, "left");
      if (property && value?.type === "Identifier") {
        binding = value;
        declared.push(field(property, "key") as AstNode);
      }
    }
    if (binding) {
      providerBindings.push({
        name: binding.name as string,
        scope: node,
        declared: [...declared, binding],
      });
    } else {
      report(
        node,
        `\`${name}\`'s ${
          model.option === undefined
            ? `parameter ${model.parameter + 1}`
            : `\`${model.option}\` option`
        } cannot be followed`,
      );
    }
  }
  const providerAt = (node: AstNode) =>
    node.type === "Identifier"
      ? providerBindings.find(
          (binding) =>
            binding.name === node.name &&
            binding.scope.start <= node.start &&
            node.end <= binding.scope.end,
        )
      : undefined;
  // Storages a builder returned, bound to a name (ruling 119).
  const storages: Array<{
    name: string;
    scope: AstNode;
    declared: AstNode;
    shape: StorageShape;
  }> = [];
  /** The nearest function around `node`, or the file. */
  const scopeOf = (node: AstNode) => {
    let current = parents.get(node);
    while (current && !isFunction(current)) current = parents.get(current);
    return current ?? program;
  };
  /** `node`, or what holds it through `await`, `as`, `!`, `satisfies` or `(…)`. */
  const outerOf = (node: AstNode) => {
    let current = node;
    for (;;) {
      const parent = parents.get(current);
      if (
        parent &&
        ((parent.type === "AwaitExpression" && parent.argument === current) ||
          ((parent.type === "TSAsExpression" ||
            parent.type === "TSNonNullExpression" ||
            parent.type === "TSSatisfiesExpression" ||
            parent.type === "ParenthesizedExpression") &&
            parent.expression === current))
      ) {
        current = parent;
      } else {
        return current;
      }
    }
  };
  /** The shape of what `call` returns, when it calls a storage builder. */
  const builtBy = (call: AstNode) => {
    const callee = field(call, "callee") as AstNode;
    if (callee.type === "Identifier")
      return aliasAt(callee)?.shape ?? builders.get(callee.name as string);
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      namespaceAt(field(callee, "object") as AstNode)
    ) {
      return storageBuilders.get(nameOf(field(callee, "property")) ?? "");
    }
    return undefined;
  };
  /** The callee of `call` as written, with `(…)`: how a storage built in place is named. */
  const builtName = (call: AstNode) => {
    const callee = field(call, "callee") as AstNode;
    return `${text.slice(callee.start, callee.end)}(…)`;
  };
  /** Whether `declarator` is in a declaration that `export` writes. */
  const exportedDeclarator = (declarator: AstNode) =>
    parents.get(parents.get(declarator) ?? declarator)?.type ===
    "ExportNamedDeclaration";
  // A builder's call whose storage is bound to no name: read, returned or
  // handed on where it is built (Plan 13, G.3), and judged below.
  const unbound: Array<{
    call: AstNode;
    outer: AstNode;
    shape: StorageShape;
  }> = [];
  for (const node of all) {
    if (node.type !== "CallExpression") continue;
    const shape = builtBy(node);
    if (!shape) continue;
    const outer = outerOf(node);
    const parent = parents.get(outer);
    const target = parent && field(parent, "id");
    const left = parent && field(parent, "left");
    const built = `\`${text.slice(
      (field(node, "callee") as AstNode).start,
      (field(node, "callee") as AstNode).end,
    )}(…)\``;
    if (parent?.type === "VariableDeclarator" && parent.init === outer) {
      if (target?.type === "Identifier") {
        storages.push({
          name: target.name as string,
          scope: scopeOf(parent),
          declared: target,
          shape,
        });
        if (exportedDeclarator(parent)) {
          report(target, `\`${target.name}\` exported`);
        }
      } else if (target?.type === "ObjectPattern") {
        for (const property of list(target, "properties")) {
          const key =
            property.type === "Property" && !property.computed
              ? nameOf(field(property, "key"))
              : undefined;
          let value = field(property, "value");
          if (value?.type === "AssignmentPattern") value = field(value, "left");
          if (
            key &&
            value?.type === "Identifier" &&
            shape.handles.includes(key)
          ) {
            handles.push({
              name: value.name as string,
              scope: scopeOf(parent),
              declared: value,
            });
            if (exportedDeclarator(parent)) {
              report(value, `\`${value.name}\` exported`);
            }
          } else if (!key || !shape.inert.includes(key)) {
            report(
              property,
              `${built} destructured into a binding it cannot follow`,
            );
          }
        }
      } else {
        report(node, `${built} bound to a name it cannot follow`);
      }
    } else if (
      parent?.type === "AssignmentExpression" &&
      parent.right === outer &&
      left?.type === "Identifier"
    ) {
      storages.push({
        name: left.name as string,
        scope: program,
        declared: left,
        shape,
      });
    } else {
      unbound.push({ call: node, outer, shape });
    }
  }
  /** The storage `node` names: the innermost binding whose scope holds it. */
  const storageAt = (node: AstNode) =>
    node.type === "Identifier"
      ? storages
          .filter(
            (storage) =>
              storage.name === node.name &&
              storage.scope.start <= node.start &&
              node.end <= storage.scope.end,
          )
          .sort(
            (left, right) =>
              left.scope.end -
              left.scope.start -
              (right.scope.end - right.scope.start),
          )[0]
      : undefined;
  /**
    The storage `node` holds: a bound one it names, or one a builder's call
    it makes returns, through `await` or a type assertion (Plan 13, G.3).
  */
  const storageValueAt = (
    node: AstNode,
  ): { name: string; shape: StorageShape } | undefined => {
    const bound = storageAt(node);
    if (bound) return bound;
    const inner = unwrap(node);
    const shape = inner.type === "CallExpression" ? builtBy(inner) : undefined;
    return shape ? { name: builtName(inner), shape } : undefined;
  };
  /** `storage.db`, `storages.dispatcher`: a handle a storage holds. */
  const heldHandleAt = (node: AstNode) => {
    if (node.type !== "MemberExpression" || node.computed) return undefined;
    const storage = storageValueAt(field(node, "object") as AstNode);
    const member = nameOf(field(node, "property")) ?? "";
    return storage?.shape.handles.includes(member) ? storage : undefined;
  };
  /** `database()`: a call of the function a provider-taker takes, in its module. */
  const providedHandleAt = (node: AstNode) =>
    node.type === "CallExpression" &&
    Boolean(providerAt(field(node, "callee") as AstNode));
  const followCallback = (call: AstNode, index: number, unit: string) => {
    const callback = list(call, "arguments")[index];
    const param =
      callback && isFunction(callback)
        ? list(callback, "params")[0]
        : undefined;
    if (!callback || !isFunction(callback)) {
      report(call, `${unit} whose callback cannot be followed`);
    } else if (param?.type === "Identifier") {
      handles.push({
        name: param.name as string,
        scope: callback,
        declared: param,
      });
    } else if (param) {
      report(call, `${unit} whose handle is destructured`);
    }
  };
  /** Where a unit's callback is, when `member` is one of `shape`'s units. */
  const unitOf = (shape: StorageShape, member: string) =>
    Object.hasOwn(shape.units, member) ? shape.units[member] : undefined;
  // In source order, so a transaction's handle is known before its body.
  for (const node of all) {
    if (node.type !== "CallExpression") continue;
    const callee = field(node, "callee") as AstNode;
    if (callee.type === "Identifier" && units.has(callee.name as string)) {
      followCallback(
        node,
        units.get(callee.name as string) as number,
        `\`${callee.name}\``,
      );
      continue;
    }
    if (callee.type !== "MemberExpression") continue;
    const object = field(callee, "object") as AstNode;
    const member = nameOf(field(callee, "property")) ?? "";
    if (
      (handleAt(object) || heldHandleAt(object) || providedHandleAt(object)) &&
      member === "transaction"
    ) {
      followCallback(node, 0, "a transaction");
      continue;
    }
    const storage = callee.computed ? undefined : storageValueAt(object);
    const index = storage && unitOf(storage.shape, member);
    if (storage && index !== undefined) {
      followCallback(node, index, `\`${storage.name}.${member}\``);
    }
  }
  const isNonValue = (node: AstNode, parent: AstNode) =>
    (parent.type === "MemberExpression" &&
      parent.property === node &&
      !parent.computed) ||
    (parent.type === "Property" && parent.key === node && !parent.shorthand) ||
    parent.type === "ImportSpecifier" ||
    parent.type === "ImportNamespaceSpecifier" ||
    // The name an export gives a binding outside the module.
    (parent.type === "ExportSpecifier" &&
      parent.exported === node &&
      parent.local !== node) ||
    (parent.type.startsWith("TS") &&
      parent.type !== "TSAsExpression" &&
      parent.type !== "TSNonNullExpression" &&
      parent.type !== "TSSatisfiesExpression");
  const allowedCallee = (callee: AstNode) =>
    allowedCallees.has(nameOf(callee) ?? "") ||
    (callee.type === "MemberExpression" &&
      !callee.computed &&
      Boolean(namespaceAt(field(callee, "object") as AstNode)));
  for (const node of all) {
    const namespace = namespaceAt(node);
    if (!namespace || namespace.declared === node) continue;
    const parent = parents.get(node) as AstNode;
    if (isNonValue(node, parent)) continue;
    const property =
      parent.type === "MemberExpression" && parent.object === node
        ? parent.computed
          ? "[…]"
          : nameOf(field(parent, "property"))
        : undefined;
    if (property === undefined) {
      report(node, `\`${node.name}\` used as ${parent.type}`);
    } else if (
      property === "[…]" ||
      databaseHandles.has(property ?? "") ||
      rawTestingAccessors.has(property ?? "")
    ) {
      report(node, `\`${node.name}.${property}\``);
    } else if (storageBuilders.has(property ?? "")) {
      // A builder read from the namespace is followed only where it is called.
      const call = parents.get(parent);
      if (call?.type !== "CallExpression" || call.callee !== parent) {
        report(node, `\`${node.name}.${property}\` used as ${call?.type}`);
      }
    }
  }
  /**
    The value of a property of an object written in place as the argument of
    a function taken from `@requestport/db` (`createWorkerStorages(env, {
    unbound: "embedded", storage })`): passed to that function, as an
    argument is.
  */
  const inOptionsOfAllowedCallee = (node: AstNode, parent: AstNode) => {
    if (
      parent.type !== "Property" ||
      (parent.value !== node && !(parent.shorthand && parent.key === node))
    ) {
      return false;
    }
    const object = parents.get(parent);
    const call = object && parents.get(object);
    return (
      object?.type === "ObjectExpression" &&
      call?.type === "CallExpression" &&
      call.callee !== object &&
      allowedCallee(field(call, "callee") as AstNode)
    );
  };
  /**
    A storage of `shape` written as the value of one of an option-taker's
    options (`storageOptionTakers`): a property of objects written in place,
    whose keys from the first argument's object to it are that option's path
    (`createRequestPort({ storage })`, `createRequestPort({ background: {
    workerStorages } })`), of that option's shape.
  */
  const inStorageOption = (
    node: AstNode,
    parent: AstNode,
    shape: StorageShape,
  ) => {
    const path: string[] = [];
    let property: AstNode | undefined = parent;
    let value: AstNode = node;
    for (;;) {
      if (
        property?.type !== "Property" ||
        property.computed ||
        (property.value !== value &&
          !(property.shorthand && property.key === value))
      ) {
        return false;
      }
      const key = nameOf(field(property, "key"));
      if (key === undefined) return false;
      path.unshift(key);
      const object = parents.get(property);
      if (object?.type !== "ObjectExpression") return false;
      const above = parents.get(object);
      if (above?.type === "CallExpression") {
        const callee = field(above, "callee");
        const options =
          callee?.type === "Identifier"
            ? optionTakers.get(callee.name as string)
            : undefined;
        return (
          options !== undefined &&
          list(above, "arguments")[0] === object &&
          options.some(
            (option) =>
              option.shape === shape &&
              option.path.length === path.length &&
              option.path.every((name, index) => name === path[index]),
          )
        );
      }
      value = object;
      property = above;
    }
  };
  /** The function `node` is returned from: as its `return`'s argument, or as an arrow's body. */
  const returnedFrom = (node: AstNode, parent: AstNode) =>
    parent.type === "ReturnStatement" && parent.argument === node
      ? enclosingFunction(parent)
      : isFunction(parent) && parent.body === node
        ? parent
        : undefined;
  /**
    A handle or a storage, `name`, used as a value rather than through a
    member; a storage with its `shape`. A builder or a unit used as a value
    comes here too, with no shape.
  */
  const reportValueUse = (
    node: AstNode,
    name: string,
    shape?: StorageShape,
  ) => {
    const parent = parents.get(node) as AstNode;
    const returner = returnedFrom(node, parent);
    const wrapper = returner && wrapperModel(functionName(returner) ?? "");
    if (parent.type === "CallExpression" && parent.callee !== node) {
      const target = field(parent, "callee") as AstNode;
      // A storage handed, first, to the one function modelled to keep it.
      const kept =
        shape !== undefined &&
        target.type === "Identifier" &&
        sinks.get(target.name as string) === shape &&
        list(parent, "arguments")[0] === node;
      if (!allowedCallee(target) && !kept) {
        report(
          node,
          `\`${name}\` passed to \`${text.slice(target.start, target.end)}\``,
        );
      }
    } else if (isNonValue(node, parent)) {
      // A key, an import or a type: no value flows.
    } else if (inOptionsOfAllowedCallee(node, parent)) {
      // Handed to a function this package's sweep reads.
    } else if (shape !== undefined && inStorageOption(node, parent, shape)) {
      // Handed to an option-taker as one of its options (`storageOptionTakers`).
    } else if (returner && inPlaceProviders.has(returner)) {
      // Returned to a provider-taker, whose module follows what it returns.
    } else if (
      wrapper &&
      shape !== undefined &&
      wrapper.shape === shape &&
      wrapper.module.test(file)
    ) {
      // Returned from the modelled wrapper's own body, in its own module:
      // every importer of the wrapper follows it.
    } else if (
      parent.type === "ExportSpecifier" ||
      parent.type === "ExportDefaultDeclaration"
    ) {
      report(node, `\`${name}\` exported`);
    } else if (
      parent.type === "VariableDeclarator" ||
      parent.type === "AssignmentExpression"
    ) {
      report(node, `\`${name}\` held in a variable`);
    } else {
      report(node, `\`${name}\` used as ${parent.type}`);
    }
  };
  /** A handle, `name`: an identifier, or a storage's member (`storage.db`). */
  const reportHandleUse = (node: AstNode, name: string) => {
    const parent = parents.get(node) as AstNode;
    if (parent.type === "MemberExpression" && parent.object === node) {
      const property = parent.computed
        ? "[…]"
        : nameOf(field(parent, "property"));
      const call = parents.get(parent);
      if (property !== "transaction" && property !== "rollback") {
        report(node, `\`${name}.${property}\``);
      } else if (
        property === "transaction" &&
        (call?.type !== "CallExpression" || call.callee !== parent)
      ) {
        report(node, `\`${name}.${property}\` used as ${call?.type}`);
      }
    } else {
      reportValueUse(node, name);
    }
  };
  for (const node of all) {
    const handle = handleAt(node);
    if (!handle || handle.declared === node) continue;
    const parent = parents.get(node) as AstNode;
    if (
      parent.type === "MemberExpression" &&
      parent.property === node &&
      !parent.computed
    ) {
      continue;
    }
    if (parent.type === "MemberExpression" && parent.property === node) {
      // `x[db]`: the handle as a computed key.
      report(node, `\`${node.name}.[…]\``);
      continue;
    }
    reportHandleUse(node, node.name as string);
  }
  for (const node of all) {
    const storage = storageAt(node);
    if (!storage || storage.declared === node) continue;
    const parent = parents.get(node) as AstNode;
    if (parent.type === "VariableDeclarator" && parent.id === node) {
      // Declared here and assigned elsewhere: no value flows, unless the
      // declaration is exported.
      if (exportedDeclarator(parent)) {
        report(node, `\`${storage.name}\` exported`);
      }
      continue;
    }
    if (parent.type === "AssignmentExpression" && parent.left === node) {
      // Assigned again: the name takes a value, and gives none.
      continue;
    }
    if (parent.type !== "MemberExpression" || parent.object !== node) {
      if (parent.type !== "MemberExpression")
        reportValueUse(node, storage.name, storage.shape);
      else if (parent.computed) report(node, `\`${storage.name}.[…]\``);
      continue;
    }
    const member = parent.computed
      ? "[…]"
      : (nameOf(field(parent, "property")) ?? "");
    const call = parents.get(parent);
    if (storage.shape.handles.includes(member) && !parent.computed) {
      reportHandleUse(parent, `${storage.name}.${member}`);
    } else if (
      unitOf(storage.shape, member) !== undefined &&
      !parent.computed
    ) {
      if (call?.type !== "CallExpression" || call.callee !== parent) {
        report(node, `\`${storage.name}.${member}\` used as ${call?.type}`);
      }
    } else if (!storage.shape.inert.includes(member) || parent.computed) {
      report(node, `\`${storage.name}.${member}\``);
    }
  }
  // A storage bound to no name (Plan 13, G.3): read by a member where it is
  // built, as a bound one is, or put to a use `reportValueUse` judges.
  for (const { call, outer, shape } of unbound) {
    const name = builtName(call);
    const parent = parents.get(outer) as AstNode;
    if (parent.type !== "MemberExpression" || parent.object !== outer) {
      reportValueUse(outer, name, shape);
      continue;
    }
    const member = parent.computed
      ? "[…]"
      : (nameOf(field(parent, "property")) ?? "");
    const used = parents.get(parent);
    if (parent.computed) {
      report(call, `\`${name}.[…]\``);
    } else if (shape.handles.includes(member)) {
      reportHandleUse(parent, `${name}.${member}`);
    } else if (unitOf(shape, member) !== undefined) {
      if (used?.type !== "CallExpression" || used.callee !== parent) {
        report(call, `\`${name}.${member}\` used as ${used?.type}`);
      }
    } else if (!shape.inert.includes(member)) {
      report(call, `\`${name}.${member}\``);
    }
  }
  // A builder or a modelled unit named as a value: followed only as a
  // parameter's default written in place (`aliases`).
  const defaults = new Set(aliases.map((alias) => alias.builder));
  for (const node of all) {
    if (node.type !== "Identifier" || defaults.has(node)) continue;
    const name = node.name as string;
    const alias = aliasAt(node);
    if (!alias && !builders.has(name) && !units.has(name)) continue;
    const parent = parents.get(node) as AstNode;
    if (
      (parent.type === "CallExpression" && parent.callee === node) ||
      (alias && parent.type === "AssignmentPattern" && parent.left === node) ||
      isNonValue(node, parent)
    ) {
      continue;
    }
    reportValueUse(node, name);
  }
  // In a provider-taker's module, the function it takes: called, it yields
  // a handle; it may be handed on only to a provider-taker.
  /** Whether `node` is handed straight to a provider-taker, as its argument or option. */
  const handsProvider = (node: AstNode, parent: AstNode) => {
    const asOption =
      parent.type === "Property" &&
      (parent.value === node || (parent.shorthand && parent.key === node));
    const object = asOption ? parents.get(parent) : undefined;
    const call = asOption ? object && parents.get(object) : parent;
    const callee =
      call?.type === "CallExpression" && call.callee !== node
        ? field(call, "callee")
        : undefined;
    const model =
      callee?.type === "Identifier"
        ? providers.get(callee.name as string)
        : undefined;
    if (!model || !call) return false;
    const argument = list(call, "arguments")[model.parameter];
    return asOption
      ? model.option !== undefined &&
          nameOf(field(parent, "key")) === model.option &&
          argument === object
      : model.option === undefined && argument === node;
  };
  for (const node of all) {
    const binding = providerAt(node);
    if (!binding || binding.declared.includes(node)) continue;
    const parent = parents.get(node) as AstNode;
    if (parent.type === "CallExpression" && parent.callee === node) {
      reportHandleUse(parent, `${node.name}()`);
    } else if (!isNonValue(node, parent) && !handsProvider(node, parent)) {
      reportValueUse(node, node.name as string);
    }
  }
  return offences
    .sort((left, right) => left.line - right.line)
    .map((offence) => `${file}:${offence.line} ${offence.what}`);
}

/*
  Outer tables assumed scoped, one per fragment and table. Each is a `sql`
  fragment correlated to `requests` or `domain_events` of a query it is later
  handed to, and each of those queries is swept and scoped:
  - listEventsAuthorized: the visibility fragment chosen by a conditional
    inside its conditions array, correlated to `domainEvents.requestId`.
  - `<module>`: the `unread` and `openQuestionCount` fragments of
    listProjection, selected by selectListRows over `requests`.
  - readRequestList: the label, unanswered, inbox and mention filters pushed
    onto its conditions, correlated to `requests.id` and read by
    selectListRows or, for a view's count, countListRows (ruling 262 moved
    them out of listRequests, which countRequests now shares).
*/
const expectedAssumptions: string[] = [
  "queries/agent-query-repository.ts › listEventsAuthorized › domainEvents",
  "queries/request-query-repository.ts › <module> › requests",
  "queries/request-query-repository.ts › <module> › requests",
  "queries/request-query-repository.ts › readRequestList › requests",
  "queries/request-query-repository.ts › readRequestList › requests",
  "queries/request-query-repository.ts › readRequestList › requests",
  "queries/request-query-repository.ts › readRequestList › requests",
  "queries/request-query-repository.ts › readRequestList › requests",
  "queries/request-query-repository.ts › readRequestList › requests",
];

/*
  Organisation predicates whose removal leaves the query scoped, because the
  same subquery is also tied to a scoped row of the query around it: `er` by
  `er.id = domain_events.request_id`, and `restricted_mention` by
  `restricted_mention.message_id = messages.id`.
*/
const expectedRedundantPredicates: string[] = [
  "queries/agent-query-repository.ts:222 er.organization_id = «context.organizationId»",
  "queries/request-query-repository.ts:956 restricted_mention.organization_id = «input.organizationId»",
];
