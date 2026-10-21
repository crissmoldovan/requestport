import { createOrganizationCreateRoute } from "../../../../lib/organization-create.js";
import { administrationActions } from "../../../../lib/server-administration-actions.js";

/**
 * Creating an organization makes it the current tenant, so it is a cookie write
 * and is served here rather than as a Server Action: a Route Handler's
 * `Set-Cookie` never reaches the action revalidation header, so the creation
 * cannot make the router commit a new route tree — carrying the new tenant's
 * appearance triple — into the document the client is about to replace.
 */
export const dynamic = "force-dynamic";

export const { POST } = createOrganizationCreateRoute({
  createOrganization: (formData) =>
    administrationActions.createOrganization(formData),
});
