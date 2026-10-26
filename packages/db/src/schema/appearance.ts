import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./identity.js";
import { organizations } from "./organizations.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/**
 * The supported appearance vocabulary. These arrays are the single database
 * source of truth for the check constraints; the domain package re-declares the
 * same literals for its public types, and `appearance.test.ts` asserts the two
 * are equal.
 */
export const appearanceThemeValues = [
  "requestport",
  "cue",
  "terminal",
  "signal",
  "venu",
  "hivehub",
  "dusk",
  "luma",
  "snuffle",
  "command",
  "graphite",
  "kiln",
  "ledger",
  "monolith",
  "porcelain",
  "prism",
  "quotamate",
  "tender",
  "zine",
] as const;
export const appearanceDensityValues = [
  "ultra-compact",
  "compact",
  "normal",
  "large",
] as const;
export const appearanceModeValues = ["system", "dark", "light"] as const;
/**
 * Migration `0026`'s three axes (ruling 255). Each accepts `match`, which
 * follows the theme's own Look; the rest are cue-ui's names.
 */
export const appearanceFontValues = [
  "match",
  "geist",
  "geist-mono",
  "inter",
  "inter-source",
  "plex",
  "dm",
  "calsans",
  "fraunces-mono",
  "system",
] as const;
export const appearanceLookValues = [
  "match",
  "console",
  "editorial",
  "marketing",
  "graphite",
  "tender",
  "zine",
  "kiln",
  "porcelain",
  "ledger",
  "command",
  "monolith",
  "prism",
] as const;
export const appearancePaintValues = [
  "match",
  "none",
  "halo",
  "hatch",
  "lift",
  "frost",
  "bevel",
  "grain",
  "plume",
  "matte",
  "glaze",
] as const;

/**
 * What migration `0026`'s trigger body seeds a newly owned organization with,
 * and what its backfill moves an untouched `0014` seed to.
 */
export const appearanceFallback = {
  theme: "cue",
  density: "normal",
  mode: "system",
  font: "match",
  look: "match",
  paint: "match",
} as const;

/**
 * Migration `0014`'s backfill and its compatibility trigger (whose body `0026`
 * replaced) write the initialization event under one fixed service identity,
 * and `0026`'s backfill writes its update event under the same one. The trigger cannot
 * know which human caused the membership write without reading untrusted
 * transaction-local state, so initiating-user attribution stays in
 * `last_updated_by_user_id` and in the existing organization audit trail.
 */
export const appearanceDefaultInitializerActor = {
  type: "service",
  id: "requestport-appearance-default-initializer",
} as const;

export const appearanceInitializedEventType =
  "appearance.organization_defaults_initialized.v1";

export const appearanceAggregateType = "organization_appearance";

// Check constraints must carry the vocabulary as SQL literals, not as bound
// parameters: the value is stored in the catalog and rendered into migrations.
function vocabulary(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

export const userAppearancePreferences = pgTable(
  "user_appearance_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    aggregateId: uuid("aggregate_id").defaultRandom().notNull(),
    theme: text("theme"),
    density: text("density"),
    mode: text("mode"),
    version: integer("version").default(1).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
    font: text("font"),
    look: text("look"),
    paint: text("paint"),
  },
  (table) => [
    // Null is "inherit". An all-null row is the retained reset tombstone, so
    // every axis stays nullable and the row is never deleted.
    check(
      "user_appearance_preferences_theme_check",
      sql`${table.theme} is null or ${table.theme} in (${vocabulary(appearanceThemeValues)})`,
    ),
    check(
      "user_appearance_preferences_density_check",
      sql`${table.density} is null or ${table.density} in (${vocabulary(appearanceDensityValues)})`,
    ),
    check(
      "user_appearance_preferences_mode_check",
      sql`${table.mode} is null or ${table.mode} in (${vocabulary(appearanceModeValues)})`,
    ),
    check(
      "user_appearance_preferences_version_check",
      sql`${table.version} > 0`,
    ),
    check(
      "user_appearance_preferences_font_check",
      sql`${table.font} is null or ${table.font} in (${vocabulary(appearanceFontValues)})`,
    ),
    check(
      "user_appearance_preferences_look_check",
      sql`${table.look} is null or ${table.look} in (${vocabulary(appearanceLookValues)})`,
    ),
    check(
      "user_appearance_preferences_paint_check",
      sql`${table.paint} is null or ${table.paint} in (${vocabulary(appearancePaintValues)})`,
    ),
    uniqueIndex("user_appearance_preferences_aggregate_id_unique").on(
      table.aggregateId,
    ),
  ],
);

export const organizationAppearanceDefaults = pgTable(
  "organization_appearance_defaults",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aggregateId: uuid("aggregate_id").defaultRandom().notNull(),
    theme: text("theme").notNull(),
    density: text("density").notNull(),
    mode: text("mode").notNull(),
    // Nullable is the FK's doing, not a weakened contract: the migration-owned
    // updater constraint below nulls exactly this column when the recorded
    // membership is deleted, so "unknown updater" is representable and the
    // membership stays deletable. Every command write sets it; 0026's backfill
    // sets it to NULL, because no member made that change.
    lastUpdatedByUserId: text("last_updated_by_user_id"),
    version: integer("version").default(1).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
    // `0026` adds these with a default, so every existing row reads `match`.
    font: text("font").default("match").notNull(),
    look: text("look").default("match").notNull(),
    paint: text("paint").default("match").notNull(),
  },
  (table) => [
    check(
      "organization_appearance_defaults_theme_check",
      sql`${table.theme} in (${vocabulary(appearanceThemeValues)})`,
    ),
    check(
      "organization_appearance_defaults_density_check",
      sql`${table.density} in (${vocabulary(appearanceDensityValues)})`,
    ),
    check(
      "organization_appearance_defaults_mode_check",
      sql`${table.mode} in (${vocabulary(appearanceModeValues)})`,
    ),
    check(
      "organization_appearance_defaults_version_check",
      sql`${table.version} > 0`,
    ),
    check(
      "organization_appearance_defaults_font_check",
      sql`${table.font} in (${vocabulary(appearanceFontValues)})`,
    ),
    check(
      "organization_appearance_defaults_look_check",
      sql`${table.look} in (${vocabulary(appearanceLookValues)})`,
    ),
    check(
      "organization_appearance_defaults_paint_check",
      sql`${table.paint} in (${vocabulary(appearancePaintValues)})`,
    ),
    uniqueIndex("organization_appearance_defaults_aggregate_id_unique").on(
      table.aggregateId,
    ),
    // `organization_appearance_defaults_updater_fk` — the composite constraint
    // that binds the last updater to a membership of this very tenant — is
    // deliberately absent here and owned by migration `0014` instead, next to
    // the compatibility trigger and the append-only guards that are also
    // migration-owned. It needs `ON DELETE SET NULL ("last_updated_by_user_id")`
    // so a deleted membership degrades the reference to "unknown" instead of
    // becoming undeletable, and Drizzle can only express a whole-constraint
    // `ON DELETE SET NULL`, which would also try to null this table's NOT NULL
    // primary key. Declaring it here with the wrong action would put a lie in
    // the snapshot; declaring it here at all would make a future generate emit
    // a duplicate. Re-adding it to this schema fails loudly rather than
    // silently rewriting the constraint.
    index("organization_appearance_defaults_updater_idx").on(
      table.lastUpdatedByUserId,
    ),
  ],
);
