import { describe, expect, test, vi } from "vitest";

/**
 * The appearance composition root, exercised rather than read.
 *
 * `appearance-render-context.test.ts` closes the mint/verify round trip on a
 * hand-built `createAppearanceActions({...})` and inspects this module as text.
 * Neither binds the secret a token is sealed with to the secret it is verified
 * with, and neither proves the real verifier is wired at all — replacing
 * `verifyFormContext` here with `() => true` left the whole suite green while
 * enabling a real cross-tenant write: an owner with the appearance settings
 * open for one organization, a second tab that switches the current
 * organization to another at the same version, then Apply in the stale tab
 * resolving to the second tenant and passing compare-and-swap.
 *
 * So these tests mint through this module's own render-context helpers and
 * submit to this module's own exported actions. Only the effects outside the
 * appearance boundary are replaced: the request context, the two command
 * buses, the rate limiter, and revalidation.
 */

const wiring = vi.hoisted(() => ({
  coreExecute: vi.fn(),
  currentOrganizationId: null as string | null,
  revalidate: vi.fn(),
  // Long enough for the same minimum the command fingerprint enforces.
  secret: "requestport-composition-root-fixture-secret",
  userExecute: vi.fn(),
  userId: "00000000-0000-4000-8000-0000000000aa",
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_SECRET: wiring.secret },
}));

vi.mock("next/cache", () => ({ revalidatePath: wiring.revalidate }));

vi.mock("./security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("./server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization:
      wiring.currentOrganizationId === null
        ? null
        : { id: wiring.currentOrganizationId },
    session: { user: { id: wiring.userId } },
  }),
}));

vi.mock("./server-core-commands.js", () => ({
  coreCommandBus: { execute: wiring.coreExecute },
  humanCommandContext: (
    session: { user: { id: string } },
    organizationId: string,
  ) => ({ organizationId, session }),
}));

vi.mock("./server-user-commands.js", () => ({
  authenticatedUserCommandContext: (session: { user: { id: string } }) => ({
    session,
  }),
  userCommandBus: { execute: wiring.userExecute },
}));

import {
  appearanceOrganizationCommandName,
  appearancePersonalCommandName,
} from "@requestport/domain";

import { createOrganizationAppearanceFormContext } from "./appearance-form-context.js";
import {
  appearanceActions,
  createOrganizationAppearanceRenderContext,
  createPersonalAppearanceRenderContext,
} from "./server-appearance-actions.js";

const homeOrganizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const idempotencyKey = "appearance-composition-root-0001";

function reset(currentOrganizationId: string | null = homeOrganizationId) {
  wiring.currentOrganizationId = currentOrganizationId;
  wiring.coreExecute.mockReset();
  wiring.coreExecute.mockResolvedValue(undefined);
  wiring.userExecute.mockReset();
  wiring.userExecute.mockResolvedValue(undefined);
  wiring.revalidate.mockReset();
}

function organizationForm(renderContext: string) {
  const data = new FormData();
  data.set("density", "normal");
  data.set("expectedVersion", "3");
  data.set("idempotencyKey", idempotencyKey);
  data.set("mode", "dark");
  data.set("renderContext", renderContext);
  data.set("theme", "cue");
  return data;
}

function personalForm(renderContext: string) {
  const data = new FormData();
  data.set("density", "large");
  data.set("expectedVersion", "0");
  data.set("idempotencyKey", idempotencyKey);
  data.set("mode", "inherit");
  data.set("renderContext", renderContext);
  data.set("theme", "terminal");
  return data;
}

describe("the appearance composition root", () => {
  test("accepts a token it minted for the tenant that is still current", async () => {
    reset();
    const state = await appearanceActions.updateOrganizationDefaults(
      organizationForm(
        createOrganizationAppearanceRenderContext({
          actorId: wiring.userId,
          organizationId: homeOrganizationId,
        }),
      ),
    );

    expect(state.status).toBe("success");
    expect(wiring.coreExecute).toHaveBeenCalledTimes(1);
    expect(wiring.coreExecute.mock.calls[0][0]).toMatchObject({
      context: { organizationId: homeOrganizationId },
      meta: { expectedVersion: 3, idempotencyKey },
      name: appearanceOrganizationCommandName,
    });
    expect(wiring.revalidate).toHaveBeenCalledTimes(1);
  });

  /**
   * The stale-tab cross-tenant write, end to end through this module.
   *
   * Nothing in the submitted form names an organization; the action resolves
   * the current one from the request. With the real verifier wired, the token
   * minted for the tenant the form was rendered for no longer matches, and the
   * write is refused before it reaches the bus — which is the only thing
   * standing between the stale tab and a compare-and-swap that would succeed,
   * both tenants being at the same version.
   */
  test("refuses a token minted for the tenant the form has since left", async () => {
    reset(otherOrganizationId);
    const state = await appearanceActions.updateOrganizationDefaults(
      organizationForm(
        createOrganizationAppearanceRenderContext({
          actorId: wiring.userId,
          organizationId: homeOrganizationId,
        }),
      ),
    );

    expect(state.status).toBe("context_conflict");
    expect(wiring.coreExecute).not.toHaveBeenCalled();
    expect(wiring.revalidate).not.toHaveBeenCalled();
  });

  test("refuses a token minted for a different actor", async () => {
    reset();
    const state = await appearanceActions.updateOrganizationDefaults(
      organizationForm(
        createOrganizationAppearanceRenderContext({
          actorId: "00000000-0000-4000-8000-0000000000bb",
          organizationId: homeOrganizationId,
        }),
      ),
    );

    expect(state.status).toBe("context_conflict");
    expect(wiring.coreExecute).not.toHaveBeenCalled();
  });

  /**
   * The seal, not merely the claims. A token carrying the right claims but
   * sealed with another secret proves this module verifies with the same
   * secret it mints with, rather than trusting whatever the form carried.
   */
  test("refuses a correctly claimed token sealed with another secret", async () => {
    reset();
    const state = await appearanceActions.updateOrganizationDefaults(
      organizationForm(
        createOrganizationAppearanceFormContext({
          actorId: wiring.userId,
          organizationId: homeOrganizationId,
          secret: `${wiring.secret}-a-different-signing-key`,
        }),
      ),
    );

    expect(state.status).toBe("context_conflict");
    expect(wiring.coreExecute).not.toHaveBeenCalled();
  });

  test("refuses a token whose sealed claims were edited", async () => {
    reset();
    const token = createOrganizationAppearanceRenderContext({
      actorId: wiring.userId,
      organizationId: homeOrganizationId,
    });
    const [version, encoded, signature] = token.split(".");
    const claims = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    claims.o = otherOrganizationId;
    const forged = `${version}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`;

    reset(otherOrganizationId);
    const state = await appearanceActions.updateOrganizationDefaults(
      organizationForm(forged),
    );

    expect(state.status).toBe("context_conflict");
    expect(wiring.coreExecute).not.toHaveBeenCalled();
  });

  test("refuses a form carrying no token at all", async () => {
    reset();
    const data = organizationForm("");
    data.delete("renderContext");

    expect(
      (await appearanceActions.updateOrganizationDefaults(data)).status,
    ).toBe("global_error");
    expect(wiring.coreExecute).not.toHaveBeenCalled();
  });

  test("accepts a personal token it minted and keeps it valid across tenants", async () => {
    reset();
    const token = createPersonalAppearanceRenderContext(wiring.userId);

    expect(
      (await appearanceActions.updatePersonalPreferences(personalForm(token)))
        .status,
    ).toBe("success");

    reset(otherOrganizationId);
    const state = await appearanceActions.updatePersonalPreferences(
      personalForm(token),
    );

    expect(state.status).toBe("success");
    expect(wiring.userExecute).toHaveBeenCalledTimes(1);
    expect(wiring.userExecute.mock.calls[0][0]).toMatchObject({
      input: { density: "large", mode: null, theme: "terminal" },
      meta: { expectedVersion: 0, idempotencyKey },
      name: appearancePersonalCommandName,
    });
  });

  // The two scopes are not interchangeable: a personal token carries no
  // tenant, so it can never stand in for the one an organization write needs.
  test("refuses each scope's token on the other scope's action", async () => {
    reset();
    expect(
      (
        await appearanceActions.updatePersonalPreferences(
          personalForm(
            createOrganizationAppearanceRenderContext({
              actorId: wiring.userId,
              organizationId: homeOrganizationId,
            }),
          ),
        )
      ).status,
    ).toBe("context_conflict");

    reset();
    expect(
      (
        await appearanceActions.updateOrganizationDefaults(
          organizationForm(
            createPersonalAppearanceRenderContext(wiring.userId),
          ),
        )
      ).status,
    ).toBe("context_conflict");

    expect(wiring.coreExecute).not.toHaveBeenCalled();
    expect(wiring.userExecute).not.toHaveBeenCalled();
  });
});
