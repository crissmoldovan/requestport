import { createRequestQueryRepository } from "@requestport/db";
import { redirect } from "next/navigation";

import { ActivityView } from "../../../components/request-workflow.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const context = await getApplicationContext();
  if (!context.currentOrganization) redirect("/");
  const storage = webStorage();
  const page = await createRequestQueryRepository(
    storage.db,
  ).listOrganizationActivity({
    userId: context.session.user.id,
    organizationId: context.currentOrganization.id,
    cursor: (await searchParams).cursor,
  });
  return <ActivityView page={page} />;
}
