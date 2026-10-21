export type WebhookFilter = {
  eventTypes: string[];
  projectIds: string[];
  laneIds: string[];
  requestTypes: string[];
};

export function matchesWebhookFilter(
  filter: WebhookFilter,
  event: {
    type: string;
    projectId?: string | null;
    data: Record<string, unknown>;
  },
) {
  if (filter.eventTypes.length && !filter.eventTypes.includes(event.type))
    return false;
  if (
    filter.projectIds.length &&
    (!event.projectId || !filter.projectIds.includes(event.projectId))
  )
    return false;
  const laneId =
    typeof event.data.laneId === "string" ? event.data.laneId : null;
  if (filter.laneIds.length && (!laneId || !filter.laneIds.includes(laneId)))
    return false;
  const requestType =
    typeof event.data.requestType === "string" ? event.data.requestType : null;
  return !(
    filter.requestTypes.length &&
    (!requestType || !filter.requestTypes.includes(requestType))
  );
}
