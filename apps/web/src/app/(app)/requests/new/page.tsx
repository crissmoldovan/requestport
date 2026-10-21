import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { createFoundationQueryRepository } from "@requestport/db";
import { FolderPlus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Page, PageSection } from "../../../../components/page-layout.js";
import { RequestCreateForm } from "../../../../components/request-forms.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";

export default async function NewRequestPage() {
  const context = await getApplicationContext();
  if (!context.currentOrganization) redirect("/");
  const storage = webStorage();
  const projects = await createFoundationQueryRepository(
    storage.db,
  ).listOrganizationProjects(
    context.session.user.id,
    context.currentOrganization.id,
  );
  const activeProjects = projects.filter(
    (project) => project.status === "active",
  );
  return (
    <Page
      action={
        <Button
          render={<Link href="/requests" />}
          size="sm"
          variant="secondary"
        >
          Cancel
        </Button>
      }
      description="Open a direct request or represent one of your projects. Save it as a draft or route it immediately."
      eyebrow="Workflow"
      title="New request"
      width="form"
    >
      <PageSection>
        {activeProjects.length > 0 ? (
          <RequestCreateForm
            canManageRouting={
              context.currentOrganization.role === "owner" ||
              context.currentOrganization.role === "admin"
            }
            idempotencyKey={`web:create:${randomUUID()}`}
            projects={activeProjects}
          />
        ) : (
          <EmptyState
            action={
              <Button
                render={<Link href="/settings/projects/new" />}
                size="sm"
                variant="primary"
              >
                Create project
              </Button>
            }
            hint="Every request needs a canonical target project."
            icon={FolderPlus}
            title="Register a project first"
          />
        )}
      </PageSection>
    </Page>
  );
}
