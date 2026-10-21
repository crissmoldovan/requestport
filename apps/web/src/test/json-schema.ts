import { readFileSync } from "node:fs";

/**
 * A validator for the JSON Schema subset the checked-in acceptance documents
 * use, shared by the two suites that read them.
 *
 * It is deliberately not a JSON Schema library. A library would accept every
 * keyword and therefore hide the one failure mode that matters here: a
 * checked-in schema that uses a keyword the checker does not implement looks
 * exactly like a schema whose every constraint passed. Only the keywords the
 * repository's schemas actually use are implemented, and an unimplemented
 * keyword is *reported* rather than ignored.
 *
 * There is one copy because two copies drift, and a drifted validator is worse
 * than none: the case table and the run evidence would then be checked against
 * subtly different readings of the same subset.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Schema = { [key: string]: Json };

/** Read a checked-in JSON document as untyped JSON. */
export function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function findRef(root: Schema, ref: string): Schema | null {
  const segments = ref.replace(/^#\//u, "").split("/");
  let current: Json = root;
  for (const segment of segments) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as { [key: string]: Json })[segment] ?? null;
  }

  return current === null ||
    typeof current !== "object" ||
    Array.isArray(current)
    ? null
    : (current as Schema);
}

/**
 * Resolve a local `#/...` reference against the document that declared it.
 *
 * Throws when it cannot, because a caller reading a definition out of a schema
 * wants to know immediately that the definition moved. `validate` does not use
 * this: it reports an unresolvable reference as a problem, since a validator
 * that dies partway through has checked an unknown fraction of the document.
 */
export function resolveRef(root: Schema, ref: string): Schema {
  const resolved = findRef(root, ref);
  if (resolved === null) throw new Error(`unresolvable reference ${ref}`);

  return resolved;
}

/**
 * Report every way `value` fails `schema`, as a list of `path: reason` lines.
 *
 * Only the keywords the checked-in schema actually uses are implemented, and
 * an unimplemented keyword is reported rather than ignored — a validator that
 * silently skips what it does not understand is a validator that passes
 * everything.
 */
export function validate(
  schema: Schema,
  value: Json,
  root: Schema = schema,
  path = "$",
): string[] {
  const known = new Set([
    "$comment",
    "$id",
    "$schema",
    "additionalProperties",
    "const",
    "description",
    "enum",
    "items",
    "maximum",
    "minimum",
    "minItems",
    "pattern",
    "properties",
    "required",
    "title",
    "type",
    "uniqueItems",
    "$defs",
    "$ref",
  ]);
  const problems: string[] = [];

  if (typeof schema.$ref === "string") {
    const resolved = findRef(root, schema.$ref);

    // Reported rather than thrown. The commonest way to reach this is calling
    // `validate` with a sub-schema as both the schema and its own root, which
    // used to fail as a `TypeError` from inside the resolver — a stack trace
    // that names the validator instead of the reference that is missing.
    return resolved === null
      ? [`${path}: unresolvable ${schema.$ref}`]
      : validate(resolved, value, root, path);
  }

  for (const keyword of Object.keys(schema)) {
    if (!known.has(keyword)) problems.push(`${path}: unsupported ${keyword}`);
  }

  if (
    "const" in schema &&
    JSON.stringify(value) !== JSON.stringify(schema.const)
  ) {
    problems.push(`${path}: not the required constant`);
  }
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as Json[];
    if (
      !allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value))
    ) {
      problems.push(`${path}: not one of the enumerated values`);
    }
  }

  const type = schema.type;
  if (typeof type === "string") {
    const actual = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value;
    const matches =
      type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : type === actual;
    if (!matches) {
      problems.push(`${path}: expected ${type}`);
      return problems;
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push(`${path}: below the minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push(`${path}: above the maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((entry) => JSON.stringify(entry)));
      if (seen.size !== value.length) problems.push(`${path}: repeated item`);
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        problems.push(
          ...validate(schema.items as Schema, entry, root, `${path}[${index}]`),
        );
      });
    }
    return problems;
  }

  if (typeof value === "string" && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern, "u").test(value)) {
      problems.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = (schema.properties ?? {}) as { [key: string]: Schema };
    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in value)) problems.push(`${path}: missing ${required}`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const child = properties[key];
      if (child === undefined) {
        if (schema.additionalProperties === false) {
          problems.push(`${path}: unexpected ${key}`);
        }
        continue;
      }
      problems.push(...validate(child, entry, root, `${path}.${key}`));
    }
  }

  return problems;
}
