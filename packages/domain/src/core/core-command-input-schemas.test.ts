import { describe, expect, test } from "vitest";
import { ZodError, type ZodType, z } from "zod";

import {
  authenticatedUserCommandInputSchemas,
  type CommandRegistry,
  coreCommandInputSchemas,
  createAuthenticatedUserCommandRegistry,
  createCoreCommandRegistry,
} from "../index.js";

/**
 * What a parse did, reduced to something two parsers can be compared on: the
 * issue codes and paths when it refused, or `ok` when it accepted. The message
 * and the values are left out on purpose — they are not what makes two
 * schemas the same schema.
 */
function outcome(parse: () => unknown): string[] {
  try {
    parse();
    return ["ok"];
  } catch (error) {
    if (error instanceof ZodError) {
      return error.issues
        .map((issue) => `${issue.code}:${issue.path.map(String).join(".")}`)
        .sort();
    }
    return [`threw:${error instanceof Error ? error.name : typeof error}`];
  }
}

function shapeKeys(schema: ZodType) {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/**
 * Every field name any exported schema declares. The probes set all of them,
 * not only the fields of the schema under test, so a definition whose schema
 * is wider than the exported one (an optional field the export dropped) is
 * refused on that field by the definition and ignored by the export.
 */
const everyExportedField = [
  ...new Set(
    [
      ...Object.values(coreCommandInputSchemas),
      ...Object.values(authenticatedUserCommandInputSchemas),
    ].flatMap((schema) => shapeKeys(schema as ZodType)),
  ),
].sort();

/**
 * Inputs that make two different schemas disagree. `{}` exposes the required
 * fields; setting every field name to an object exposes the optional ones in
 * either direction (an object is the wrong type for almost every field here);
 * the unknown key exposes a strict schema posing as a loose one, or the
 * reverse.
 */
function probes(fieldNames: readonly string[]): unknown[] {
  const wrongTyped = Object.fromEntries(
    fieldNames.map((key) => [key, { probe: true }]),
  );
  return [
    undefined,
    null,
    [],
    "input",
    {},
    { f0UnknownKey: true },
    wrongTyped,
    { ...wrongTyped, f0UnknownKey: true },
  ];
}

function expectSameParser(
  registry: CommandRegistry<never>,
  schemas: Record<string, ZodType>,
) {
  for (const [name, schema] of Object.entries(schemas)) {
    const definition = registry.resolve(name);
    expect(definition, name).toBeDefined();
    for (const probe of probes(everyExportedField)) {
      expect(
        outcome(() => definition?.parse(probe)),
        `${name} ${JSON.stringify(probe)}`,
      ).toEqual(outcome(() => schema.parse(probe)));
    }
  }
}

describe("core command input schemas", () => {
  test("export exactly one schema per command the tenant registry holds", () => {
    expect(Object.keys(coreCommandInputSchemas).sort()).toEqual(
      createCoreCommandRegistry().names(),
    );
  });

  test("export exactly one schema per command the authenticated-user registry holds", () => {
    expect(Object.keys(authenticatedUserCommandInputSchemas).sort()).toEqual(
      createAuthenticatedUserCommandRegistry().names(),
    );
  });

  test("are the schemas each registered command parses with", () => {
    expectSameParser(
      createCoreCommandRegistry() as unknown as CommandRegistry<never>,
      coreCommandInputSchemas,
    );
    expectSameParser(
      createAuthenticatedUserCommandRegistry() as unknown as CommandRegistry<never>,
      authenticatedUserCommandInputSchemas,
    );
  });

  test("the comparison tells two schemas apart when only an optional field differs", () => {
    // The detector above is only worth something if it can fire, in both
    // directions: an export wider than its definition (heartbeat mapped to
    // `stateInput`) and an export narrower than it (start mapped to
    // `baseSessionInput`, which would drop `reason`).
    const narrow = z.object({ id: z.uuid() });
    const wide = narrow.extend({ reason: z.string().optional() });
    const fieldNames = [...new Set([...shapeKeys(narrow), ...shapeKeys(wide)])];
    const disagreements = probes(fieldNames).filter(
      (probe) =>
        JSON.stringify(outcome(() => narrow.parse(probe))) !==
        JSON.stringify(outcome(() => wide.parse(probe))),
    );
    expect(disagreements.length).toBeGreaterThan(0);
    // The probes the test above uses do carry the optional field that makes
    // the narrower mapping visible.
    expect(everyExportedField).toContain("reason");
  });

  test("each converts to JSON Schema on its input side", () => {
    const all = Object.entries({
      ...coreCommandInputSchemas,
      ...authenticatedUserCommandInputSchemas,
    });
    expect(all.length).toBe(
      createCoreCommandRegistry().names().length +
        createAuthenticatedUserCommandRegistry().names().length,
    );
    for (const [name, schema] of all) {
      const json = z.toJSONSchema(schema as ZodType, { io: "input" });
      expect(json.type, name).toBe("object");
    }
  });
});
