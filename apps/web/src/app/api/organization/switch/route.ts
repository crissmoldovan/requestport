import { createOrganizationSwitchRoute } from "../../../../lib/organization-switch.js";
import { administrationActions } from "../../../../lib/server-administration-actions.js";

/**
 * The tenant switch is a cookie write, so it is served here rather than as a
 * Server Action: a Route Handler's `Set-Cookie` never reaches the action
 * revalidation header, so the switch cannot make the router commit a new route
 * tree into the document the client is about to replace.
 */
export const dynamic = "force-dynamic";

export const { POST } = createOrganizationSwitchRoute({
  switchOrganization: (formData) =>
    administrationActions.switchOrganization(formData),
});
