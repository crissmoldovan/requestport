import { z } from "zod";

import {
  appearanceAxes,
  appearanceDensities,
  appearanceFonts,
  appearanceLooks,
  appearanceModes,
  appearancePaints,
  appearanceThemes,
} from "./appearance-types.js";

/**
 * The data of the two organization appearance events, built from the
 * appearance vocabulary so the events and the check constraints cannot drift.
 * `events/configuration-events.ts` registers them.
 *
 * Migration `0014` writes the initialization envelope itself — from its
 * backfill and from the compatibility trigger it installs on
 * `organization_members` — and `0026` writes both: the trigger's new body the
 * initialization, its backfill an update. `outbox-delivery` dead-letters,
 * terminally, anything `parse` rejects, and an applied migration cannot be
 * edited, so each schema accepts every envelope those migrations wrote:
 * `font`, `look` and `paint` (ruling 255) are optional, because 0014's
 * envelopes and every update written before 0026 carry three axes.
 * `packages/db/src/appearance-migration.integration.test.ts` parses the exact
 * rows both migrations produce through the registry.
 */
const appearanceAxesSchema = z.object({
  theme: z.enum(appearanceThemes),
  density: z.enum(appearanceDensities),
  mode: z.enum(appearanceModes),
  font: z.enum(appearanceFonts).optional(),
  look: z.enum(appearanceLooks).optional(),
  paint: z.enum(appearancePaints).optional(),
});

export const appearanceOrganizationDefaultsInitializedSchema =
  appearanceAxesSchema.safeExtend({
    organizationId: z.uuid(),
  });

/**
 * The update envelope carries the safe before/after values downstream
 * consumers need. Security audit rows deliberately carry only the changed field
 * names, so this event is the only place the values appear.
 */
export const appearanceOrganizationDefaultsUpdatedSchema = z.object({
  organizationId: z.uuid(),
  changedFields: z.array(z.enum(appearanceAxes)).max(appearanceAxes.length),
  before: appearanceAxesSchema,
  after: appearanceAxesSchema,
});
