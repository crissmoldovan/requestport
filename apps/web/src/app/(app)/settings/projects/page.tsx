import { createFoundationQueryRepository } from "@requestport/db";

import {
  NoOrganizationSetup,
  ProjectsView,
} from "../../../../components/administration-views.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";

export default async function ProjectsSettingsPage() {
  const context = await getApplicationContext();
  if (!context.currentOrganization) {
    return <NoOrganizationSetup />;
  }
  const storage = webStorage();
  const projects = await createFoundationQueryRepository(
    storage.db,
  ).listOrganizationProjects(
    context.session.user.id,
    context.currentOrganization.id,
  );
  return (
    <ProjectsView
      organization={context.currentOrganization}
      projects={projects}
    />
  );
}
