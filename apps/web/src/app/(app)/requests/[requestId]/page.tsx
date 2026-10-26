import { randomUUID } from "node:crypto";

import {
  createFoundationQueryRepository,
  createRequestQueryRepository,
} from "@requestport/db";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import {
  type RequestDetailTab,
  RequestDetailView,
  requestDetailTabs,
} from "../../../../components/request-workflow.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";

export default async function RequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<{ tab?: string; timelineCursor?: string }>;
}) {
  const context = await getApplicationContext();
  if (!context.currentOrganization) redirect("/");
  const parsedId = z.uuid().safeParse((await params).requestId);
  if (!parsedId.success) notFound();
  const resolvedSearch = await searchParams;
  // The record draws its description, questions and activity always; `tab`
  // picks which of the linked-work sections shows beneath them. An address
  // from before that split (`?tab=activity`) or any other value lands on the
  // first section rather than failing.
  const activeTab: RequestDetailTab =
    requestDetailTabs.find((tab) => tab.value === resolvedSearch.tab)?.value ??
    "relations";
  const storage = webStorage();
  const requestQueries = createRequestQueryRepository(storage.db);
  const [request, timeline, members] = await Promise.all([
    requestQueries.getRequest({
      userId: context.session.user.id,
      organizationId: context.currentOrganization.id,
      requestId: parsedId.data,
    }),
    requestQueries.listTimeline({
      userId: context.session.user.id,
      organizationId: context.currentOrganization.id,
      requestId: parsedId.data,
      cursor: resolvedSearch.timelineCursor,
    }),
    createFoundationQueryRepository(storage.db).listOrganizationMembers(
      context.session.user.id,
      context.currentOrganization.id,
    ),
  ]);
  if (!request) notFound();
  await requestQueries.markRequestRead({
    userId: context.session.user.id,
    organizationId: context.currentOrganization.id,
    requestId: request.id,
    lastSeenEventId: timeline.items[0]?.id ?? null,
  });
  return (
    <RequestDetailView
      activeTab={activeTab}
      keys={{
        artifact: `web:artifact:${randomUUID()}`,
        assign: `web:assign:${randomUUID()}`,
        edit: `web:request:update:${randomUUID()}`,
        answers: Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            `web:answer:${randomUUID()}`,
          ]),
        ),
        closes: Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            `web:question:close:${randomUUID()}`,
          ]),
        ),
        message: `web:message:${randomUUID()}`,
        question: `web:question:${randomUUID()}`,
        relationship: `web:relationship:${randomUUID()}`,
        transition: `web:transition:${randomUUID()}`,
        unlinks: Object.fromEntries(
          request.relationships.map((relationship) => [
            relationship.id,
            `web:relationship:unlink:${randomUUID()}`,
          ]),
        ),
      }}
      members={members}
      request={request}
      timeline={timeline}
    />
  );
}
