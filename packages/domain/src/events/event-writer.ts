import type { DomainEvent } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { DomainEventStore } from "../shared/unit-of-work.js";

export class EventWriter {
  constructor(private readonly store: DomainEventStore) {}

  async append(events: readonly DomainEvent[]) {
    const seen = new Set<string>();
    for (const event of events) {
      const key = `${event.organizationId}:${event.aggregateType}:${event.aggregateId}:${event.aggregateVersion}`;
      if (seen.has(key)) {
        throw new DomainError(
          "version_conflict",
          "Aggregate event version is duplicated",
        );
      }
      seen.add(key);
    }
    await this.store.append(events);
  }
}
