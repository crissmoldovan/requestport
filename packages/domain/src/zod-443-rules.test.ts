import { describe, expect, test } from "vitest";
import type { z } from "zod";

import * as domain from "./index.js";
import { zod443Departures } from "./test-support/zod-departures.js";
import {
  capabilityRegistry,
  restCommandEnvelopeFields,
} from "./transport-metadata.js";

/*
  The domain's schemas answer as they did on zod 4.4.3, which RequestPort
  0.2.0 published, though the workspace runs zod 4.6.7: string lengths in
  UTF-16 code units, a datetime's seconds optional, a URL kept as sent, and
  4.4.3's email pattern (`shared/zod-compat.ts`).
*/

function isZod(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    "safeParse" in value
  );
}

/** Every zod schema the domain's entry exports, to two levels of objects. */
function exportedSchemas() {
  const found: [string, z.ZodType][] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (isZod(value)) {
      found.push([path, value]);
      return;
    }
    if (depth === 0 || typeof value !== "object" || value === null) return;
    if (Object.getPrototypeOf(value) !== Object.prototype) return;
    for (const [key, child] of Object.entries(value))
      walk(child, `${path}.${key}`, depth - 1);
  };
  for (const [name, value] of Object.entries(domain)) walk(value, name, 2);
  return found;
}

const emoji = "\u{1F600}";
const organizationId = "018f0000-0000-7000-8000-0000000a0001";
const requestId = "018f0000-0000-7000-8000-0000000a0002";

function inputSchemaOf(name: string) {
  const entry = capabilityRegistry.find(
    (capability) => capability.kind === "command" && capability.name === name,
  );
  if (entry?.kind !== "command") throw new Error(`no command ${name}`);
  return entry.inputSchema;
}

describe("the domain's schemas keep zod 4.4.3's string rules", () => {
  test("no command a transport dispatches departs from them", () => {
    const departures = capabilityRegistry.flatMap((capability) => [
      ...(capability.kind === "command"
        ? zod443Departures(capability.inputSchema, capability.name)
        : []),
      ...(capability.kind === "query"
        ? capability.rest.queryParameters.flatMap((parameter) =>
            zod443Departures(
              parameter.valueSchema,
              `${capability.name}?${parameter.name}`,
            ),
          )
        : []),
    ]);
    expect(departures).toEqual([]);
  });

  test("no schema the domain exports departs from them", () => {
    const schemas = exportedSchemas();
    expect(schemas.length).toBeGreaterThan(50);
    expect(
      schemas.flatMap(([name, schema]) => zod443Departures(schema, name)),
    ).toEqual([]);
  });

  test("ask_question accepts a deadline without seconds, as sent", () => {
    const input = {
      organizationId,
      requestId,
      audience: { type: "requester" },
      bodyMd: "Which one?",
      deadlineAt: "2026-10-05T12:30Z",
    };
    const parsed = inputSchemaOf("ask_question").safeParse(input);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ deadlineAt: "2026-10-05T12:30Z" });
  });

  test("a title is counted in UTF-16 code units", () => {
    const schema = inputSchemaOf("update_request");
    // 120 emoji: 120 code points, 240 units, the bound.
    expect(
      schema.safeParse({ organizationId, requestId, title: emoji.repeat(120) })
        .success,
    ).toBe(true);
    // 121 emoji: 121 code points, 242 units. 0.2.0 refused it.
    const refused = schema.safeParse({
      organizationId,
      requestId,
      title: emoji.repeat(121),
    });
    expect(refused.error?.issues).toEqual([
      expect.objectContaining({
        code: "too_big",
        maximum: 240,
        path: ["title"],
        message: "Too big: expected string to have <=240 characters",
      }),
    ]);
  });

  test("the REST envelope's idempotency key is counted in UTF-16 code units", () => {
    // Eight emoji: 8 code points, 16 units. 0.2.0 accepted it.
    expect(
      restCommandEnvelopeFields.idempotencyKey.safeParse(emoji.repeat(8))
        .success,
    ).toBe(true);
    // 101 emoji: 202 units, over the 200 bound. 0.2.0 refused it.
    expect(
      restCommandEnvelopeFields.idempotencyKey.safeParse(emoji.repeat(101))
        .success,
    ).toBe(false);
  });

  test("no event payload the domain registers departs from them", () => {
    const registered: [string, z.ZodType][] = [];
    const registry = {
      register(type: string, schema: z.ZodType) {
        registered.push([type, schema]);
        return registry;
      },
    } as unknown as domain.EventSchemaRegistry;
    domain.registerAgentEventSchemas(registry);
    domain.registerCollaborationEventSchemas(registry);
    domain.registerConfigurationEventSchemas(registry);
    domain.registerImportEventSchemas(registry);
    domain.registerRequestEventSchemas(registry);
    domain.registerRoutingEventSchemas(registry);
    domain.registerWorkEventSchemas(registry);
    expect(registered.length).toBeGreaterThan(30);
    expect(
      registered.flatMap(([type, schema]) => zod443Departures(schema, type)),
    ).toEqual([]);
  });
});
