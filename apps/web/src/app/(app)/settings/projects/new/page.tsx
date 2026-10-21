import {
  NoOrganizationSetup,
  ProjectCreationView,
} from "../../../../../components/administration-views.js";
import { getApplicationContext } from "../../../../../lib/server-application-context.js";
import { createProjectAction } from "../actions.js";

export default async function NewProjectPage() {
  const context = await getApplicationContext();
  return context.currentOrganization ? (
    <ProjectCreationView
      action={createProjectAction}
      organization={context.currentOrganization}
    />
  ) : (
    <NoOrganizationSetup />
  );
}
