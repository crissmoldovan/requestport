import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { appearanceInheritValue } from "../app/(app)/settings/appearance/action-state.js";
import { createAppearanceActions } from "./appearance-actions.js";
import {
  createOrganizationAppearanceFormContext,
  createPersonalAppearanceFormContext,
  verifyAppearanceFormContext,
} from "./appearance-form-context.js";

/**
 * The round trip the two isolated suites never close.
 *
 * `appearance-actions.test.ts` stubs `verifyFormContext` to `true` and
 * `appearance-form-context.test.ts` seals hand-built claims, so the claim shape
 * each composition root actually mints has been asserted by neither. A personal
 * form minted with an organization in its claims — one plausible copy/paste in
 * `(app)/layout.tsx` — would then fail every account-menu Apply with a fixed
 * `context_conflict` while both suites stayed green. These tests mint through
 * the two scope-typed helpers the composition roots use and verify through the
 * real verifier wired into the real actions.
 */

/** Long enough to satisfy the same minimum the command fingerprint enforces. */
const secret = "requestport-test-secret-0123456789abcdef";
const actorId = "user_01HZY0000000000000000000";
const homeOrganizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const idempotencyKey = "appearance-render-context-round-trip-01";

function actions(actor: { organizationId: string | null; userId: string }) {
  const written: string[] = [];
  const instance = createAppearanceActions({
    enforceRateLimit: async () => {},
    loadActor: async () => actor,
    revalidate: () => {},
    updateOrganizationDefaults: async () => {
      written.push("organization");
    },
    updatePersonalPreferences: async () => {
      written.push("personal");
    },
    verifyFormContext: ({ expected, token }) =>
      verifyAppearanceFormContext({ expected, secret, token }),
  });
  return { ...instance, written };
}

function form(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

function personalForm(renderContext: string) {
  return form({
    density: appearanceInheritValue,
    expectedVersion: "0",
    idempotencyKey,
    mode: appearanceInheritValue,
    renderContext,
    theme: "cue",
  });
}

function organizationForm(renderContext: string) {
  return form({
    density: "normal",
    expectedVersion: "1",
    idempotencyKey,
    mode: "dark",
    renderContext,
    theme: "cue",
  });
}

const personalToken = () =>
  createPersonalAppearanceFormContext({ actorId, secret });
const organizationToken = (organizationId: string) =>
  createOrganizationAppearanceFormContext({ actorId, organizationId, secret });

describe("appearance render-context round trip", () => {
  test("accepts a personal token minted for a member of an organization", async () => {
    const surface = actions({
      organizationId: homeOrganizationId,
      userId: actorId,
    });

    const state = await surface.updatePersonalPreferences(
      personalForm(personalToken()),
    );

    expect(state.status).toBe("success");
    expect(surface.written).toEqual(["personal"]);
  });

  test("keeps a personal token valid after the actor switches organization", async () => {
    const token = personalToken();
    const surface = actions({
      organizationId: otherOrganizationId,
      userId: actorId,
    });

    const state = await surface.updatePersonalPreferences(personalForm(token));

    expect(state.status).toBe("success");
    expect(surface.written).toEqual(["personal"]);
  });

  test("refuses an organization token on the personal action", async () => {
    const surface = actions({
      organizationId: homeOrganizationId,
      userId: actorId,
    });

    const state = await surface.updatePersonalPreferences(
      personalForm(organizationToken(homeOrganizationId)),
    );

    expect(state.status).toBe("context_conflict");
    expect(surface.written).toEqual([]);
  });

  test("accepts an organization token minted for the current tenant", async () => {
    const surface = actions({
      organizationId: homeOrganizationId,
      userId: actorId,
    });

    const state = await surface.updateOrganizationDefaults(
      organizationForm(organizationToken(homeOrganizationId)),
    );

    expect(state.status).toBe("success");
    expect(surface.written).toEqual(["organization"]);
  });

  test("refuses a personal token on the organization action", async () => {
    const surface = actions({
      organizationId: homeOrganizationId,
      userId: actorId,
    });

    const state = await surface.updateOrganizationDefaults(
      organizationForm(personalToken()),
    );

    expect(state.status).toBe("context_conflict");
    expect(surface.written).toEqual([]);
  });

  test("refuses an organization token after the tenant changed under the form", async () => {
    const token = organizationToken(homeOrganizationId);
    const surface = actions({
      organizationId: otherOrganizationId,
      userId: actorId,
    });

    const state = await surface.updateOrganizationDefaults(
      organizationForm(token),
    );

    expect(state.status).toBe("context_conflict");
    expect(surface.written).toEqual([]);
  });
});

/**
 * The helpers only close the gap while every composition root uses them: a mint
 * that spells its own claims out can still bind the wrong tenant, and no type
 * would object. These pin the three roots that decide the claims.
 */
describe("appearance render-context composition roots", () => {
  async function source(relativePath: string) {
    return readFile(new URL(relativePath, import.meta.url), "utf8");
  }

  /**
   * The layout mints two contexts now, and which goes where is the whole point.
   *
   * This used to assert the layout never mentioned the organization helper,
   * which was a fair proxy while the account menu edited one layer. It edits
   * two: the personal form, and an owner's promotion of that choice to the
   * organization default. The property being protected has not changed and
   * matters more — a personal form carrying organization claims fails every
   * Apply with `context_conflict`, and a promotion carrying personal claims
   * would be a write to the organization with the wrong authority — but the
   * proxy stopped standing for it the moment both appear in one file.
   */
  test("gives each of the account menu's two forms its own context", async () => {
    const layout = await source("../app/(app)/layout.tsx");

    // The panel's own form is the personal one, minted for the actor alone.
    expect(layout).toMatch(
      /contextToken: createPersonalAppearanceRenderContext\(/u,
    );

    // The organization helper appears once, and only to build the promotion.
    const organizationMints = [
      ...layout.matchAll(/createOrganizationAppearanceRenderContext\(/gu),
    ];
    expect(organizationMints).toHaveLength(1);

    const promotion = layout.slice(layout.indexOf("organizationDefault:"));
    expect(promotion).toContain("createOrganizationAppearanceRenderContext(");
    expect(
      promotion.slice(0, promotion.indexOf("organizationName:")),
    ).not.toContain("createPersonalAppearanceRenderContext(");
  });

  test("mints both settings forms in their own scope", async () => {
    const page = await source("../app/(app)/settings/appearance/page.tsx");

    expect(page).toContain("createPersonalAppearanceRenderContext");
    expect(page).toContain("createOrganizationAppearanceRenderContext");
  });

  test("leaves no free-claim mint for a call site to spell wrong", async () => {
    const wiring = await source("./server-appearance-actions.ts");

    expect(wiring).toContain("createPersonalAppearanceRenderContext");
    expect(wiring).toContain("createOrganizationAppearanceRenderContext");
    expect(wiring).not.toContain(
      "export function createAppearanceRenderContext",
    );
  });
});
