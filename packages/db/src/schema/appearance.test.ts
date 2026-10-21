import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import * as databasePackage from "../index.js";
import {
  appearanceDefaultInitializerActor,
  appearanceDensityValues,
  appearanceInitializedEventType,
  appearanceModeValues,
  appearanceThemeValues,
  organizationAppearanceDefaults,
  userAppearancePreferences,
} from "./appearance.js";
import * as schemaModule from "./index.js";

const dialect = new PgDialect();

function checkSql(table: Parameters<typeof getTableConfig>[0], name: string) {
  const found = getTableConfig(table).checks.find(
    (entry) => entry.name === name,
  );

  expect(found, `missing check constraint ${name}`).toBeDefined();

  const query = dialect.sqlToQuery(found?.value ?? (undefined as never));

  // A constraint compiled to bound parameters would store `$1` in the catalog
  // instead of the vocabulary, so the rendered SQL must carry no parameters.
  expect(query.params, name).toEqual([]);

  return query.sql;
}

describe("appearance preference schema", () => {
  test("locks the supported appearance vocabulary to the specified arrays", () => {
    expect(appearanceThemeValues).toEqual([
      "requestport",
      "cue",
      "terminal",
      "signal",
      "venu",
      "hivehub",
      "dusk",
      "luma",
      "snuffle",
    ]);
    expect(appearanceDensityValues).toEqual([
      "ultra-compact",
      "normal",
      "large",
    ]);
    expect(appearanceModeValues).toEqual(["system", "dark", "light"]);
  });

  test("names the fixed initializer service actor and initialization event", () => {
    expect(appearanceDefaultInitializerActor).toEqual({
      type: "service",
      id: "requestport-appearance-default-initializer",
    });
    expect(appearanceInitializedEventType).toBe(
      "appearance.organization_defaults_initialized.v1",
    );
  });

  test("keys personal preferences by the identity user with nullable inherit axes", () => {
    const config = getTableConfig(userAppearancePreferences);
    const columns = new Map(
      config.columns.map((column) => [column.name, column]),
    );

    expect(config.name).toBe("user_appearance_preferences");
    expect([...columns.keys()]).toEqual([
      "user_id",
      "aggregate_id",
      "theme",
      "density",
      "mode",
      "version",
      "created_at",
      "updated_at",
    ]);
    expect(columns.get("user_id")?.primary).toBe(true);
    expect(columns.get("user_id")?.getSQLType()).toBe("text");

    // Null is "inherit". Every axis stays independently nullable so an all-null
    // row can be retained as the reset tombstone rather than deleted.
    for (const axis of ["theme", "density", "mode"]) {
      expect(columns.get(axis)?.notNull, axis).toBe(false);
    }

    expect(columns.get("version")?.notNull).toBe(true);
    expect(columns.get("version")?.default).toBe(1);
    expect(columns.get("created_at")?.getSQLType()).toBe(
      "timestamp with time zone",
    );
    expect(columns.get("updated_at")?.getSQLType()).toBe(
      "timestamp with time zone",
    );
  });

  test("gives personal preferences a stable unique random aggregate identity", () => {
    const config = getTableConfig(userAppearancePreferences);
    const aggregate = config.columns.find(
      (column) => column.name === "aggregate_id",
    );

    expect(aggregate?.getSQLType()).toBe("uuid");
    expect(aggregate?.notNull).toBe(true);
    expect(aggregate?.defaultFn ?? aggregate?.default).toBeDefined();
    expect(
      config.indexes.some(
        (entry) =>
          entry.config.name ===
            "user_appearance_preferences_aggregate_id_unique" &&
          entry.config.unique === true,
      ),
    ).toBe(true);
  });

  test("cascades personal preferences from the owning identity row", () => {
    const [reference] = getTableConfig(userAppearancePreferences).foreignKeys;
    const { columns, foreignColumns } = reference.reference();

    expect(columns.map((column) => column.name)).toEqual(["user_id"]);
    expect(foreignColumns.map((column) => column.name)).toEqual(["id"]);
    expect(reference.onDelete).toBe("cascade");
  });

  test("restricts every personal axis to the locked vocabulary or inherit", () => {
    for (const axis of ["theme", "density", "mode"] as const) {
      const sql = checkSql(
        userAppearancePreferences,
        `user_appearance_preferences_${axis}_check`,
      );

      expect(sql, axis).toMatch(/is null or/u);
      for (const value of {
        theme: appearanceThemeValues,
        density: appearanceDensityValues,
        mode: appearanceModeValues,
      }[axis]) {
        expect(sql, `${axis}:${value}`).toContain(`'${value}'`);
      }
    }

    expect(
      checkSql(
        userAppearancePreferences,
        "user_appearance_preferences_version_check",
      ),
    ).toContain("> 0");
  });

  test("keys organization defaults by tenant with a required triple", () => {
    const config = getTableConfig(organizationAppearanceDefaults);
    const columns = new Map(
      config.columns.map((column) => [column.name, column]),
    );

    expect(config.name).toBe("organization_appearance_defaults");
    expect([...columns.keys()]).toEqual([
      "organization_id",
      "aggregate_id",
      "theme",
      "density",
      "mode",
      "last_updated_by_user_id",
      "version",
      "created_at",
      "updated_at",
    ]);
    expect(columns.get("organization_id")?.primary).toBe(true);
    expect(columns.get("organization_id")?.getSQLType()).toBe("uuid");

    for (const required of ["theme", "density", "mode", "version"]) {
      expect(columns.get(required)?.notNull, required).toBe(true);
    }

    // The updater is nullable only so the migration-owned updater foreign key
    // can null it when the recorded membership is deleted; every write path
    // sets it. See the updater-foreign-key test below.
    expect(columns.get("last_updated_by_user_id")?.notNull).toBe(false);

    expect(columns.get("version")?.default).toBe(1);
    expect(
      config.indexes.some(
        (entry) =>
          entry.config.name ===
            "organization_appearance_defaults_aggregate_id_unique" &&
          entry.config.unique === true,
      ),
    ).toBe(true);
  });

  test("binds the organization default to its tenant and leaves the updater key to the migration", () => {
    const references = getTableConfig(
      organizationAppearanceDefaults,
    ).foreignKeys.map((entry) => ({
      constraintName: entry.getName(),
      onDelete: entry.onDelete,
      columns: entry.reference().columns.map((column) => column.name),
      foreignTable: getTableConfig(entry.reference().foreignTable).name,
      foreignColumns: entry
        .reference()
        .foreignColumns.map((column) => column.name),
    }));

    // Deleting a tenant removes its appearance default with it.
    expect(references).toEqual([
      {
        constraintName:
          "organization_appearance_defaults_organization_id_organizations_id_fk",
        onDelete: "cascade",
        columns: ["organization_id"],
        foreignTable: "organizations",
        foreignColumns: ["id"],
      },
    ]);

    // The composite updater key that binds the last updater to a membership of
    // this very tenant is migration-owned: it needs
    // `ON DELETE SET NULL ("last_updated_by_user_id")`, which Drizzle cannot
    // express — a whole-constraint SET NULL would also null the NOT NULL
    // primary key. Declaring it here would either put a wrong action in the
    // snapshot or make a later generate emit a duplicate constraint.
    // `appearance-migration.integration.test.ts` owns its text and behaviour.
    expect(
      references.some(
        (entry) =>
          entry.constraintName ===
          "organization_appearance_defaults_updater_fk",
      ),
    ).toBe(false);
    expect(
      getTableConfig(organizationAppearanceDefaults).indexes.some(
        (entry) =>
          entry.config.name === "organization_appearance_defaults_updater_idx",
      ),
    ).toBe(true);
  });

  test("requires organization axes to be exactly the locked vocabulary", () => {
    for (const axis of ["theme", "density", "mode"] as const) {
      const sql = checkSql(
        organizationAppearanceDefaults,
        `organization_appearance_defaults_${axis}_check`,
      );

      expect(sql, axis).not.toMatch(/is null/u);
      for (const value of {
        theme: appearanceThemeValues,
        density: appearanceDensityValues,
        mode: appearanceModeValues,
      }[axis]) {
        expect(sql, `${axis}:${value}`).toContain(`'${value}'`);
      }
    }

    expect(
      checkSql(
        organizationAppearanceDefaults,
        "organization_appearance_defaults_version_check",
      ),
    ).toContain("> 0");
  });

  test("re-exports both appearance tables from the package surface", () => {
    expect(schemaModule.userAppearancePreferences).toBe(
      userAppearancePreferences,
    );
    expect(schemaModule.organizationAppearanceDefaults).toBe(
      organizationAppearanceDefaults,
    );
    expect(databasePackage.userAppearancePreferences).toBe(
      userAppearancePreferences,
    );
    expect(databasePackage.organizationAppearanceDefaults).toBe(
      organizationAppearanceDefaults,
    );
  });
});
