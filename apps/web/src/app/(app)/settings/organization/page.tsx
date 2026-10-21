import {
  NoOrganizationSetup,
  OrganizationView,
} from "../../../../components/administration-views.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";

export default async function OrganizationSettingsPage() {
  const context = await getApplicationContext();
  return context.currentOrganization ? (
    <OrganizationView organization={context.currentOrganization} />
  ) : (
    <NoOrganizationSetup />
  );
}
