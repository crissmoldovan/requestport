import { createAppearanceRenderContextRoute } from "../../../../lib/appearance-context-mint.js";
import { createPersonalAppearanceRenderContext } from "../../../../lib/server-appearance-actions.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";

/**
 * The account menu's render context, minted when the panel opens.
 *
 * The actor comes from the authenticated request and nothing else: the handler
 * takes no input, so it cannot be asked to seal a context for another user or
 * another tenant. A personal form is global to the actor, so the sealed claims
 * carry no organization at all and survive a tenant switch in another tab.
 */
export const dynamic = "force-dynamic";

export const { POST } = createAppearanceRenderContextRoute({
  mintPersonalContext: async () => {
    const application = await getApplicationContext();
    return createPersonalAppearanceRenderContext(application.session.user.id);
  },
});
