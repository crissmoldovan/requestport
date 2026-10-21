import { serverEnv } from "@requestport/config/server";
import {
  appearanceOrganizationCommandName,
  appearancePersonalCommandName,
  withOrganizationAppearanceInput,
} from "@requestport/domain";
import { revalidatePath } from "next/cache";

import { createAppearanceActions } from "./appearance-actions.js";
import {
  createOrganizationAppearanceFormContext,
  createPersonalAppearanceFormContext,
  verifyAppearanceFormContext,
} from "./appearance-form-context.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "./security/rate-limit.js";
import { getApplicationContext } from "./server-application-context.js";
import { coreCommandBus, humanCommandContext } from "./server-core-commands.js";
import {
  authenticatedUserCommandContext,
  userCommandBus,
} from "./server-user-commands.js";

/**
 * The wiring for the two appearance writes.
 *
 * Personal preferences go through the session-only authenticated-user bus,
 * which has no organization at all; organization defaults go through the tenant
 * bus with a server-injected organization identifier. Both reach the same
 * atomic receipt engine, so expected-version compare-and-swap, idempotency
 * replay, and the audit/event contract are the domain's, not this module's.
 *
 * Sealing the render-context token lives here too, beside the verification it
 * is checked against, and away from the read boundary in `server-appearance.ts`
 * that must keep failing open without any secret of its own. There is one mint
 * per scope and no free-claim mint at all, so no composition root can bind a
 * personal form to a tenant — or a tenant form to none — by mis-spelling a
 * claim the compiler would happily accept.
 */
export function createPersonalAppearanceRenderContext(actorId: string) {
  return createPersonalAppearanceFormContext({
    actorId,
    secret: serverEnv.BETTER_AUTH_SECRET,
  });
}

export function createOrganizationAppearanceRenderContext(input: {
  actorId: string;
  organizationId: string;
}) {
  return createOrganizationAppearanceFormContext({
    actorId: input.actorId,
    organizationId: input.organizationId,
    secret: serverEnv.BETTER_AUTH_SECRET,
  });
}

export const appearanceActions = createAppearanceActions({
  async enforceRateLimit({ scope, userId }) {
    await enforceRateLimit({
      endpointClass: "mutation",
      fingerprint: rateLimitFingerprint(`appearance-${scope}`, userId),
    });
  },

  async loadActor() {
    const application = await getApplicationContext();
    return {
      organizationId: application.currentOrganization?.id ?? null,
      userId: application.session.user.id,
    };
  },

  // The appearance boundary lives in the root layout, so every authenticated
  // document depends on it. Revalidation runs only after the write commits.
  revalidate: () => revalidatePath("/", "layout"),

  async updateOrganizationDefaults({ defaults, meta, organizationId }) {
    const application = await getApplicationContext();
    await coreCommandBus.execute({
      context: humanCommandContext(application.session, organizationId),
      input: withOrganizationAppearanceInput(organizationId, defaults),
      meta,
      name: appearanceOrganizationCommandName,
    });
  },

  async updatePersonalPreferences({ meta, overrides }) {
    const application = await getApplicationContext();
    await userCommandBus.execute({
      context: authenticatedUserCommandContext(application.session),
      input: overrides,
      meta,
      name: appearancePersonalCommandName,
    });
  },

  verifyFormContext: ({ expected, token }) =>
    verifyAppearanceFormContext({
      expected,
      secret: serverEnv.BETTER_AUTH_SECRET,
      token,
    }),
});
