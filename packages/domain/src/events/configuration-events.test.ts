import { describe, expect, test } from "vitest";

import { createCoreEventSchemaRegistry } from "../core/core-commands.js";

const appearanceInitialized = "appearance.organization_defaults_initialized.v1";
const appearanceUpdated = "appearance.organization_defaults_updated.v1";

const themes = [
  "requestport",
  "cue",
  "terminal",
  "signal",
  "venu",
  "hivehub",
  "dusk",
  "luma",
  "snuffle",
];
const densities = ["ultra-compact", "compact", "normal", "large"];
const modes = ["system", "dark", "light"];

describe("configuration event registry", () => {
  test("accepts the exact envelope migration 0014 writes", () => {
    const registry = createCoreEventSchemaRegistry();
    // The literal migration `0014` builds with jsonb_build_object for both its
    // trigger path and its backfill path. An unregistered type makes
    // `parse` throw `Missing event schema registration`, which
    // trigger/src/outbox-delivery.ts turns into a terminal dead letter — so
    // every seeded organization's initialization row would be permanently
    // undeliverable the first time 0014 met a running outbox worker, and 0014
    // is immutable.
    const data = {
      organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1",
      theme: "requestport",
      density: "ultra-compact",
      mode: "system",
    };

    expect(registry.parse(appearanceInitialized, data)).toEqual(data);
  });

  test("accepts every locked appearance value on the initialization event", () => {
    const registry = createCoreEventSchemaRegistry();
    const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";

    for (const theme of themes) {
      expect(
        registry.parse(appearanceInitialized, {
          organizationId,
          theme,
          density: "normal",
          mode: "dark",
        }),
        theme,
      ).toMatchObject({ theme });
    }
    for (const density of densities) {
      expect(
        registry.parse(appearanceInitialized, {
          organizationId,
          theme: "cue",
          density,
          mode: "light",
        }),
        density,
      ).toMatchObject({ density });
    }
    for (const mode of modes) {
      expect(
        registry.parse(appearanceInitialized, {
          organizationId,
          theme: "venu",
          density: "large",
          mode,
        }),
        mode,
      ).toMatchObject({ mode });
    }
  });

  test("rejects an initialization payload outside the locked vocabulary", () => {
    const registry = createCoreEventSchemaRegistry();
    const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";

    for (const invalid of [
      { organizationId, theme: "midnight", density: "normal", mode: "dark" },
      { organizationId, theme: "cue", density: "cosy", mode: "dark" },
      { organizationId, theme: "cue", density: "normal", mode: "auto" },
      {
        organizationId: "not-a-uuid",
        theme: "cue",
        density: "normal",
        mode: "dark",
      },
      { organizationId, theme: "cue", density: "normal" },
    ]) {
      expect(
        () => registry.parse(appearanceInitialized, invalid),
        JSON.stringify(invalid),
      ).toThrow();
    }
  });

  test("accepts the safe before/after triple on the update event", () => {
    const registry = createCoreEventSchemaRegistry();
    const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
    const data = {
      organizationId,
      changedFields: ["theme", "density"],
      before: {
        theme: "requestport",
        density: "ultra-compact",
        mode: "system",
      },
      after: { theme: "cue", density: "large", mode: "system" },
    };

    expect(registry.parse(appearanceUpdated, data)).toEqual(data);
    expect(
      registry.parse(appearanceUpdated, { ...data, changedFields: [] }),
    ).toMatchObject({ changedFields: [] });
  });

  test("rejects an update payload outside the locked vocabulary", () => {
    const registry = createCoreEventSchemaRegistry();
    const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
    const triple = {
      theme: "cue",
      density: "normal",
      mode: "dark",
    };

    for (const invalid of [
      { organizationId, changedFields: ["theme"], after: triple },
      { organizationId, changedFields: ["theme"], before: triple },
      {
        organizationId,
        changedFields: ["palette"],
        before: triple,
        after: triple,
      },
      {
        organizationId,
        changedFields: ["theme"],
        before: { ...triple, theme: "midnight" },
        after: triple,
      },
      {
        organizationId,
        changedFields: ["theme"],
        before: triple,
        after: { ...triple, mode: null },
      },
      {
        organizationId: "not-a-uuid",
        changedFields: [],
        before: triple,
        after: triple,
      },
    ]) {
      expect(
        () => registry.parse(appearanceUpdated, invalid),
        JSON.stringify(invalid),
      ).toThrow();
    }
  });

  test("keeps every previously registered configuration event registered", () => {
    const registry = createCoreEventSchemaRegistry();

    expect(() =>
      registry.parse("organization.created.v1", {
        organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1",
        name: "RequestPort",
        slug: "requestport",
        status: "active",
      }),
    ).not.toThrow();
    expect(() =>
      registry.parse("organization.member_changed.v1", {
        membershipId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a2",
        role: "owner",
        status: "active",
      }),
    ).not.toThrow();
    expect(() =>
      registry.parse("retention.hold_changed.v1", {
        category: "all",
        status: "active",
      }),
    ).not.toThrow();
  });
});
