import { beforeEach, describe, expect, test } from "vitest";

import {
  createAuthenticatedUserCommandRegistry,
  createCoreCommandRegistry,
  createCoreEventSchemaRegistry,
} from "../core/core-commands.js";
import type {
  AuthenticatedUserCommandContext,
  AuthorizedCommandContext,
} from "../shared/authorization.js";
import { AtomicCommandBus } from "../shared/command.js";
import { InMemoryAppearanceEnvironment } from "../test-support/appearance-environment.js";
import {
  appearanceOrganizationCommandName,
  appearanceOrganizationDefaultsInitializedEvent,
  appearanceOrganizationDefaultsUpdatedEvent,
  appearancePersonalCommandName,
} from "./appearance-commands.js";
import { resolveAppearanceSnapshot } from "./appearance-service.js";
import * as types from "./appearance-types.js";

/*
  Ruling 255: appearance is six axes — theme, mode, density, typeface (`font`),
  Look (`look`, cue-ui's style set) and surface (`paint`) — every stock cue-ui
  0.29.0 theme is offered, and an organization starts on cue, normal density,
  and the typeface, Look and surface of the theme's own Look (`match`).
*/

const fingerprintSecret = "requestport-appearance-fingerprint-secret";
const userId = "user_01JQ0000000000000000000001";
const sessionId = "session_01JQ0000000000000000000001";
const organizationId = "8f6b0f2a-0000-4000-8000-000000000001";

function userContext(): AuthenticatedUserCommandContext {
  return {
    actor: { type: "user", id: userId },
    credentialId: sessionId,
    correlationId: "5b1f0f2a-0000-4000-8000-0000000000aa",
  };
}

function tenantContext(): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["members:manage"]),
    credentialId: sessionId,
    correlationId: "5b1f0f2a-0000-4000-8000-0000000000bb",
  };
}

function personalBus(environment: InMemoryAppearanceEnvironment) {
  return new AtomicCommandBus<AuthenticatedUserCommandContext>({
    registry: createAuthenticatedUserCommandRegistry(),
    transactions: environment.transactions,
    fingerprintSecret,
  });
}

function tenantBus(environment: InMemoryAppearanceEnvironment) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: environment.transactions,
    fingerprintSecret,
  });
}

describe("the six-axis vocabulary (ruling 255)", () => {
  test("offers RequestPort's own theme and every stock theme cue-ui 0.29.0 ships", () => {
    expect(types.appearanceThemes).toEqual([
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
    ]);
  });

  test("names six axes, and font, look and paint each accept match first", () => {
    expect(types.appearanceAxes).toEqual([
      "theme",
      "density",
      "mode",
      "font",
      "look",
      "paint",
    ]);
    expect(types.appearanceFonts).toEqual([
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
    ]);
    expect(types.appearanceLooks).toEqual([
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
    ]);
    expect(types.appearancePaints).toEqual([
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
    ]);
  });

  test("falls back to cue, the system's mode, normal density and the theme's Look", () => {
    expect(types.appearanceFallback).toEqual({
      theme: "cue",
      density: "normal",
      mode: "system",
      font: "match",
      look: "match",
      paint: "match",
    });
  });

  test("parses every axis independently and degrades only the malformed one", () => {
    expect(
      types.parseAppearanceOverrides({
        theme: "graphite",
        density: null,
        mode: "dark",
        font: "plex",
        look: "midnight",
        paint: "match",
      }),
    ).toEqual({
      theme: "graphite",
      density: null,
      mode: "dark",
      font: "plex",
      look: null,
      paint: "match",
    });
    expect(
      types.parseAppearanceDefaults({
        theme: "zine",
        density: "large",
        mode: "light",
        font: "comic",
        look: "zine",
        paint: 3,
      }),
    ).toEqual({
      theme: "zine",
      density: "large",
      mode: "light",
      font: "match",
      look: "zine",
      paint: "match",
    });
    for (const invalid of ["roboto", "jetbrains-mono", "Match", "", null]) {
      expect(types.isAppearanceFont(invalid), String(invalid)).toBe(false);
    }
  });
});

describe("resolution over six axes", () => {
  test("a person's choice wins per axis, then the organization's, then the fallback", () => {
    const snapshot = resolveAppearanceSnapshot({
      user: {
        version: 2,
        theme: null,
        density: "large",
        mode: null,
        font: "inter",
        look: null,
        paint: "match",
      },
      organization: {
        version: 3,
        theme: "graphite",
        density: "normal",
        mode: "dark",
        font: "match",
        look: "match",
        paint: "frost",
      },
    });

    expect(snapshot.effective).toEqual({
      theme: "graphite",
      density: "large",
      mode: "dark",
      font: "inter",
      look: "match",
      paint: "match",
      source: {
        theme: "organization",
        density: "user",
        mode: "organization",
        font: "user",
        look: "organization",
        paint: "user",
      },
    });
    expect(
      resolveAppearanceSnapshot({ user: null, organization: null }).effective,
    ).toEqual({
      ...types.appearanceFallback,
      source: {
        theme: "fallback",
        density: "fallback",
        mode: "fallback",
        font: "fallback",
        look: "fallback",
        paint: "fallback",
      },
    });
  });
});

describe("personal writes over six axes", () => {
  let environment: InMemoryAppearanceEnvironment;

  beforeEach(() => {
    environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
    });
  });

  test("stores a typeface, a Look and a surface, and audits their names", async () => {
    const result = await personalBus(environment).execute({
      name: appearancePersonalCommandName,
      input: {
        theme: "zine",
        density: null,
        mode: null,
        font: "match",
        look: "editorial",
        paint: "grain",
      },
      context: userContext(),
      meta: {
        idempotencyKey: "appearance-six-axes-personal-1",
        expectedVersion: 0,
      },
    });

    expect(result).toMatchObject({
      version: 1,
      theme: "zine",
      font: "match",
      look: "editorial",
      paint: "grain",
      changedFields: ["font", "look", "paint", "theme"],
    });
    expect(environment.userRow(userId)).toMatchObject({
      theme: "zine",
      font: "match",
      look: "editorial",
      paint: "grain",
    });
    expect(environment.audits[0]?.fieldNames).toEqual([
      "font",
      "look",
      "paint",
      "theme",
    ]);
  });

  test("a writer that sends only the first three axes leaves the other three as stored", async () => {
    const bus = personalBus(environment);
    await bus.execute({
      name: appearancePersonalCommandName,
      input: {
        theme: null,
        density: null,
        mode: null,
        font: "plex",
        look: "ledger",
        paint: null,
      },
      context: userContext(),
      meta: {
        idempotencyKey: "appearance-six-axes-personal-2",
        expectedVersion: 0,
      },
    });
    const result = await bus.execute({
      name: appearancePersonalCommandName,
      input: { theme: "cue", density: null, mode: null },
      context: userContext(),
      meta: {
        idempotencyKey: "appearance-six-axes-personal-3",
        expectedVersion: 1,
      },
    });

    expect(result).toMatchObject({
      version: 2,
      theme: "cue",
      font: "plex",
      look: "ledger",
      paint: null,
      changedFields: ["theme"],
    });
  });

  test("refuses a typeface RequestPort does not bundle", async () => {
    await expect(
      personalBus(environment).execute({
        name: appearancePersonalCommandName,
        input: {
          theme: null,
          density: null,
          mode: null,
          font: "roboto",
        },
        context: userContext(),
        meta: {
          idempotencyKey: "appearance-six-axes-personal-4",
          expectedVersion: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("organization defaults over six axes", () => {
  let environment: InMemoryAppearanceEnvironment;

  beforeEach(() => {
    environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [
        {
          id: organizationId,
          theme: "cue",
          density: "normal",
          mode: "system",
        },
      ],
      memberships: [{ organizationId, userId }],
    });
  });

  test("moves an organization to a new theme and Look, with a six-axis event", async () => {
    const result = await tenantBus(environment).execute({
      name: appearanceOrganizationCommandName,
      input: {
        organizationId,
        theme: "graphite",
        density: "normal",
        mode: "system",
        font: "match",
        look: "match",
        paint: "frost",
      },
      context: tenantContext(),
      meta: { idempotencyKey: "appearance-six-axes-org-1", expectedVersion: 1 },
    });

    expect(result).toMatchObject({
      version: 2,
      theme: "graphite",
      font: "match",
      look: "match",
      paint: "frost",
      changedFields: ["paint", "theme"],
    });
    expect(environment.organizationRow(organizationId)).toMatchObject({
      theme: "graphite",
      paint: "frost",
      version: 2,
    });
    expect(environment.events).toHaveLength(1);
    expect(environment.events[0]).toMatchObject({
      type: appearanceOrganizationDefaultsUpdatedEvent,
      aggregateVersion: 2,
      data: {
        organizationId,
        changedFields: ["paint", "theme"],
        before: {
          theme: "cue",
          density: "normal",
          mode: "system",
          font: "match",
          look: "match",
          paint: "match",
        },
        after: {
          theme: "graphite",
          density: "normal",
          mode: "system",
          font: "match",
          look: "match",
          paint: "frost",
        },
      },
    });
  });

  test("an older writer's three axes leave the stored typeface, Look and surface alone", async () => {
    const bus = tenantBus(environment);
    await bus.execute({
      name: appearanceOrganizationCommandName,
      input: {
        organizationId,
        theme: "cue",
        density: "normal",
        mode: "system",
        font: "inter",
        look: "ledger",
        paint: "lift",
      },
      context: tenantContext(),
      meta: { idempotencyKey: "appearance-six-axes-org-2", expectedVersion: 1 },
    });
    const result = await bus.execute({
      name: appearanceOrganizationCommandName,
      input: {
        organizationId,
        theme: "terminal",
        density: "large",
        mode: "dark",
      },
      context: tenantContext(),
      meta: { idempotencyKey: "appearance-six-axes-org-3", expectedVersion: 2 },
    });

    expect(result).toMatchObject({
      version: 3,
      theme: "terminal",
      font: "inter",
      look: "ledger",
      paint: "lift",
      changedFields: ["density", "mode", "theme"],
    });
  });
});

describe("the appearance event registry over six axes", () => {
  test("accepts migration 0026's initialization envelope and its re-seed update", () => {
    const registry = createCoreEventSchemaRegistry();
    const seeded = {
      organizationId,
      theme: "cue",
      density: "normal",
      mode: "system",
      font: "match",
      look: "match",
      paint: "match",
    };
    expect(
      registry.parse(appearanceOrganizationDefaultsInitializedEvent, seeded),
    ).toEqual(seeded);

    const reseed = {
      organizationId,
      changedFields: ["density", "theme"],
      before: {
        theme: "requestport",
        density: "ultra-compact",
        mode: "system",
        font: "match",
        look: "match",
        paint: "match",
      },
      after: {
        theme: "cue",
        density: "normal",
        mode: "system",
        font: "match",
        look: "match",
        paint: "match",
      },
    };
    expect(
      registry.parse(appearanceOrganizationDefaultsUpdatedEvent, reseed),
    ).toEqual(reseed);
  });

  test("still accepts the three-axis envelopes migration 0014 and earlier updates wrote", () => {
    const registry = createCoreEventSchemaRegistry();
    const legacy = {
      organizationId,
      theme: "requestport",
      density: "ultra-compact",
      mode: "system",
    };
    expect(
      registry.parse(appearanceOrganizationDefaultsInitializedEvent, legacy),
    ).toEqual(legacy);
  });

  test("refuses a value outside the six vocabularies", () => {
    const registry = createCoreEventSchemaRegistry();
    expect(() =>
      registry.parse(appearanceOrganizationDefaultsInitializedEvent, {
        organizationId,
        theme: "cue",
        density: "normal",
        mode: "system",
        font: "roboto",
        look: "match",
        paint: "match",
      }),
    ).toThrow();
  });
});

/*
  Ruling 255, item 8: density gains `compact`, cue-ui 0.29.0's rung between
  ultra-compact and normal, for an organization and for a person alike.
  `ultra-large`, cue-ui's fifth rung, is not offered.
*/
describe("compact density (ruling 255)", () => {
  test("is the second of four rungs, and ultra-large is not one", () => {
    expect(types.appearanceDensities).toEqual([
      "ultra-compact",
      "compact",
      "normal",
      "large",
    ]);
    expect(types.isAppearanceDensity("compact")).toBe(true);
    expect(types.isAppearanceDensity("ultra-large")).toBe(false);
  });

  test("a person may choose compact for themselves", async () => {
    const environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
    });

    await expect(
      personalBus(environment).execute({
        name: appearancePersonalCommandName,
        input: { theme: null, density: "compact", mode: null },
        context: userContext(),
        meta: {
          idempotencyKey: "appearance-compact-personal",
          expectedVersion: 0,
        },
      }),
    ).resolves.toMatchObject({
      version: 1,
      density: "compact",
      changedFields: ["density"],
    });
    expect(environment.userRow(userId)).toMatchObject({ density: "compact" });
  });

  test("an organization may default to compact, and its event says so", async () => {
    const environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [
        { id: organizationId, theme: "cue", density: "normal", mode: "system" },
      ],
      memberships: [{ organizationId, userId }],
    });

    await expect(
      tenantBus(environment).execute({
        name: appearanceOrganizationCommandName,
        input: {
          organizationId,
          theme: "cue",
          density: "compact",
          mode: "system",
        },
        context: tenantContext(),
        meta: {
          idempotencyKey: "appearance-compact-organization",
          expectedVersion: 1,
        },
      }),
    ).resolves.toMatchObject({
      version: 2,
      density: "compact",
      changedFields: ["density"],
    });
    expect(environment.organizationRow(organizationId)).toMatchObject({
      density: "compact",
      version: 2,
    });
    expect(environment.events[0]).toMatchObject({
      type: appearanceOrganizationDefaultsUpdatedEvent,
      data: {
        changedFields: ["density"],
        before: { density: "normal" },
        after: { density: "compact" },
      },
    });
  });

  test("still refuses ultra-large, for a person and an organization", async () => {
    const environment = new InMemoryAppearanceEnvironment({
      activeSessions: [{ userId, credentialId: sessionId }],
      organizations: [{ id: organizationId }],
      memberships: [{ organizationId, userId }],
    });

    await expect(
      personalBus(environment).execute({
        name: appearancePersonalCommandName,
        input: { theme: null, density: "ultra-large", mode: null },
        context: userContext(),
        meta: {
          idempotencyKey: "appearance-ultra-large-personal",
          expectedVersion: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      tenantBus(environment).execute({
        name: appearanceOrganizationCommandName,
        input: {
          organizationId,
          theme: "cue",
          density: "ultra-large",
          mode: "system",
        },
        context: tenantContext(),
        meta: {
          idempotencyKey: "appearance-ultra-large-organization",
          expectedVersion: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(environment.events).toEqual([]);
  });
});
