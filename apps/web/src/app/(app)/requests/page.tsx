import { randomUUID } from "node:crypto";

import {
  createFoundationQueryRepository,
  createRequestQueryRepository,
} from "@requestport/db";
import {
  type RequestFilters,
  requestPriorities,
  requestStates,
  requestTypes,
} from "@requestport/domain";
import { redirect } from "next/navigation";
import { z } from "zod";

import { RequestListView } from "../../../components/request-workflow.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function member<T extends readonly string[]>(
  values: T,
  value: string | undefined,
) {
  return value && values.includes(value) ? (value as T[number]) : undefined;
}

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getApplicationContext();
  if (!context.currentOrganization) redirect("/");
  const query = await searchParams;
  const view = one(query.view);
  const mode = view === "inbox" || view === "my_work" ? view : "all";
  const state = member(requestStates, one(query.state));
  const type = member(requestTypes, one(query.type));
  const priority = member(requestPriorities, one(query.priority));
  const sourceProjectId = z.uuid().safeParse(one(query.sourceProjectId));
  const targetProjectId = z.uuid().safeParse(one(query.targetProjectId));
  const laneId = z.uuid().safeParse(one(query.laneId));
  const label = one(query.label)?.trim().slice(0, 64);
  const reporterId = one(query.reporterId)?.trim().slice(0, 255);
  const assigneeId = one(query.assigneeId)?.trim().slice(0, 255);
  const updatedAfterRaw = one(query.updatedAfter);
  const updatedAfter =
    updatedAfterRaw && !Number.isNaN(Date.parse(updatedAfterRaw))
      ? new Date(updatedAfterRaw)
      : undefined;
  // The date as written, only when it was read: one the page cannot parse
  // filters nothing, so it is neither drawn as a chip nor kept in a link.
  const updatedAfterKept = updatedAfter ? updatedAfterRaw : undefined;
  const unanswered = one(query.unanswered) === "true";
  const cursor = one(query.cursor);
  const selectedRequestId = z.uuid().safeParse(one(query.requestId));
  const filters: RequestFilters = { mode };
  if (state) filters.state = [state];
  if (type) filters.type = [type];
  if (priority) filters.priority = [priority];
  if (sourceProjectId.success) filters.sourceProjectId = sourceProjectId.data;
  if (targetProjectId.success) filters.targetProjectId = targetProjectId.data;
  if (laneId.success) filters.laneId = laneId.data;
  if (label) filters.label = label;
  if (reporterId) filters.reporterId = reporterId;
  if (assigneeId) filters.assigneeId = assigneeId;
  if (updatedAfter) filters.updatedAfter = updatedAfter;
  if (unanswered) filters.unanswered = true;
  // Each view tab's count, read under the filters its own address keeps:
  // every view drops `unanswered`, which "Waiting on an answer" alone sets
  // (`requestViews` in request-workflow.tsx).
  const { mode: _mode, unanswered: _unanswered, ...viewFilters } = filters;
  const views = {
    all: { ...viewFilters, mode: "all" },
    inbox: { ...viewFilters, mode: "inbox" },
    my_work: { ...viewFilters, mode: "my_work" },
    waiting: { ...viewFilters, mode: "all", unanswered: true },
  } satisfies Record<string, RequestFilters>;
  const storage = webStorage();
  const requestQueries = createRequestQueryRepository(storage.db);
  const foundationQueries = createFoundationQueryRepository(storage.db);
  const [
    page,
    counts,
    projects,
    lanes,
    selectedRequest,
    selectedTimeline,
    members,
  ] = await Promise.all([
    requestQueries.listRequests({
      userId: context.session.user.id,
      organizationId: context.currentOrganization.id,
      filters,
      cursor,
    }),
    requestQueries.countRequests({
      userId: context.session.user.id,
      organizationId: context.currentOrganization.id,
      views,
    }),
    foundationQueries.listOrganizationProjects(
      context.session.user.id,
      context.currentOrganization.id,
    ),
    foundationQueries.listOrganizationLanes(
      context.session.user.id,
      context.currentOrganization.id,
    ),
    selectedRequestId.success
      ? requestQueries.getRequest({
          userId: context.session.user.id,
          organizationId: context.currentOrganization.id,
          requestId: selectedRequestId.data,
        })
      : null,
    selectedRequestId.success
      ? requestQueries.listTimeline({
          userId: context.session.user.id,
          organizationId: context.currentOrganization.id,
          requestId: selectedRequestId.data,
          limit: 20,
        })
      : null,
    // Whom the filter sheet offers as reporter and assignee (ruling 264),
    // and whom the selected request can be assigned to.
    foundationQueries.listOrganizationMembers(
      context.session.user.id,
      context.currentOrganization.id,
    ),
  ]);
  if (selectedRequest && selectedTimeline) {
    await requestQueries.markRequestRead({
      userId: context.session.user.id,
      organizationId: context.currentOrganization.id,
      requestId: selectedRequest.id,
      lastSeenEventId: selectedTimeline.items[0]?.id ?? null,
    });
  }
  const retained = new URLSearchParams();
  if (mode !== "all") retained.set("view", mode);
  for (const [key, value] of Object.entries({
    state,
    type,
    priority,
    sourceProjectId: sourceProjectId.success ? sourceProjectId.data : undefined,
    targetProjectId: targetProjectId.success ? targetProjectId.data : undefined,
    laneId: laneId.success ? laneId.data : undefined,
    label,
    reporterId,
    assigneeId,
    updatedAfter: updatedAfterKept,
  }))
    if (value) retained.set(key, value);
  if (unanswered) retained.set("unanswered", "true");
  return (
    <RequestListView
      counts={counts}
      cursor={cursor}
      mode={mode}
      now={new Date()}
      page={page}
      projects={projects}
      lanes={lanes}
      members={members}
      query={{
        assigneeId,
        label,
        laneId: laneId.success ? laneId.data : undefined,
        priority,
        reporterId,
        sourceProjectId: sourceProjectId.success
          ? sourceProjectId.data
          : undefined,
        state,
        targetProjectId: targetProjectId.success
          ? targetProjectId.data
          : undefined,
        type,
        unanswered,
        updatedAfter: updatedAfterKept,
      }}
      queryString={retained.toString()}
      selected={
        selectedRequest && selectedTimeline
          ? {
              keys: {
                answers: Object.fromEntries(
                  selectedRequest.questions.map((question) => [
                    question.id,
                    `web:answer:${randomUUID()}`,
                  ]),
                ),
                assign: `web:assign:${randomUUID()}`,
                transition: `web:transition:${randomUUID()}`,
              },
              request: selectedRequest,
              timeline: selectedTimeline,
            }
          : null
      }
    />
  );
}
