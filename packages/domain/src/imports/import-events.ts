import { z } from "zod";

import type { EventSchemaRegistry } from "../events/event-factory.js";

const importAppliedSchema = z.object({
  importRunId: z.uuid(),
  reportId: z.uuid(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

export function registerImportEventSchemas(registry: EventSchemaRegistry) {
  return registry.register("import.applied.v1", importAppliedSchema);
}
