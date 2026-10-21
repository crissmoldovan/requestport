import { createFoundationQueryRepository } from "@requestport/db";

import {
  NoOrganizationSetup,
  OverviewView,
} from "../../components/administration-views.js";
import { getApplicationContext } from "../../lib/server-application-context.js";
import { webStorage } from "../../lib/server-request-port.js";

export default async function OverviewPage() {
  const context = await getApplicationContext();
  if (!context.currentOrganization) {
    return <NoOrganizationSetup />;
  }
  const storage = webStorage();
  const foundationQueries = createFoundationQueryRepository(storage.db);
  const [projects, members] = await Promise.all([
    foundationQueries.listOrganizationProjects(
      context.session.user.id,
      context.currentOrganization.id,
    ),
    foundationQueries.listOrganizationMembers(
      context.session.user.id,
      context.currentOrganization.id,
    ),
  ]);
  return (
    <OverviewView
      members={members}
      organization={context.currentOrganization}
      projects={projects}
    />
  );
}
