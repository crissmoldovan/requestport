import { v7 as uuidv7 } from "uuid";
import type { ZodType } from "zod";
import { redactSensitiveText } from "../security/sensitive-content.js";
import type {
  ActorRef,
  AuthorizedCommandContext,
} from "../shared/authorization.js";
import type { DomainEvent } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";

const prohibitedKeys = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "cookie",
  "environment",
  "fqdn",
  "hostname",
  "osuser",
  "password",
  "privatekey",
  "refreshtoken",
  "repositoryroot",
  "secret",
  "sshkey",
  "token",
  "workingdirectory",
]);

function normalizedFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function rejectPrivateFields(value: unknown, path = "data") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectPrivateFields(entry, `${path}.${index}`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (prohibitedKeys.has(normalizedFieldName(key))) {
      throw new DomainError(
        "validation_failed",
        "Event payload contains a prohibited field",
        { field: path },
      );
    }
    rejectPrivateFields(entry, `${path}.${key}`);
  }
}

function redactPrivateContent(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactPrivateContent);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactPrivateContent(entry),
    ]),
  );
}

export function sanitizeEventLinks(links: Record<string, string>) {
  rejectPrivateFields(links, "links");
  return Object.fromEntries(
    Object.entries(links).map(([key, value]) => [
      key,
      redactSensitiveText(value),
    ]),
  );
}

export function sanitizeEventActor(value: unknown, depth = 0): ActorRef {
  if (
    depth > 4 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError("validation_failed", "Event actor is invalid");
  }
  const actor = value as Record<string, unknown>;
  if (
    (actor.type !== "user" &&
      actor.type !== "agent" &&
      actor.type !== "service") ||
    typeof actor.id !== "string" ||
    actor.id.length === 0 ||
    actor.id.length > 255 ||
    redactSensitiveText(actor.id) !== actor.id
  ) {
    throw new DomainError("validation_failed", "Event actor is invalid");
  }
  if (actor.type === "user") {
    if (Object.keys(actor).some((key) => key !== "type" && key !== "id")) {
      throw new DomainError("validation_failed", "Event actor is invalid");
    }
    return { type: "user", id: actor.id };
  }
  if (actor.type === "agent") {
    if (
      Object.keys(actor).some(
        (key) => key !== "type" && key !== "id" && key !== "delegatedBy",
      )
    ) {
      throw new DomainError("validation_failed", "Event actor is invalid");
    }
    if (actor.delegatedBy === undefined) {
      return { type: "agent", id: actor.id };
    }
    const delegatedBy = sanitizeEventActor(actor.delegatedBy, depth + 1);
    if (delegatedBy.type !== "user") {
      throw new DomainError("validation_failed", "Event actor is invalid");
    }
    return { type: "agent", id: actor.id, delegatedBy };
  }
  if (
    Object.keys(actor).some(
      (key) => key !== "type" && key !== "id" && key !== "originatingActor",
    )
  ) {
    throw new DomainError("validation_failed", "Event actor is invalid");
  }
  return {
    type: "service",
    id: actor.id,
    ...(actor.originatingActor === undefined
      ? {}
      : {
          originatingActor: sanitizeEventActor(
            actor.originatingActor,
            depth + 1,
          ),
        }),
  };
}

export class EventSchemaRegistry {
  private readonly schemas = new Map<string, ZodType>();

  register(type: string, schema: ZodType) {
    if (this.schemas.has(type)) {
      throw new Error(`Duplicate event schema registration: ${type}`);
    }
    this.schemas.set(type, schema);
    return this;
  }

  parse(type: string, value: unknown) {
    const schema = this.schemas.get(type);
    if (!schema) {
      throw new Error(`Missing event schema registration: ${type}`);
    }
    // Inspect the caller-provided value before Zod parses it. Plain Zod object
    // schemas strip unknown properties by default; inspecting only parsed.data
    // would therefore silently discard a field named `token` or `hostname`
    // instead of enforcing the event boundary's fail-closed contract.
    rejectPrivateFields(value);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new DomainError("validation_failed", "Event payload is invalid");
    }
    if (
      typeof parsed.data !== "object" ||
      parsed.data === null ||
      Array.isArray(parsed.data)
    ) {
      throw new DomainError(
        "validation_failed",
        "Event payload must be an object",
      );
    }
    return redactPrivateContent(parsed.data) as JsonObject;
  }
}

export type EventDraft = {
  type: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  projectId?: string;
  requestId?: string;
  causationId: string;
  data: unknown;
  links?: Record<string, string>;
};

export class EventFactory {
  constructor(
    private readonly schemas: EventSchemaRegistry,
    private readonly createId: () => string = uuidv7,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(context: AuthorizedCommandContext, draft: EventDraft): DomainEvent {
    const data = this.schemas.parse(draft.type, draft.data);
    return {
      id: this.createId(),
      type: draft.type,
      schemaVersion: draft.schemaVersion,
      occurredAt: this.now().toISOString(),
      organizationId: context.organizationId,
      projectId: draft.projectId,
      requestId: draft.requestId,
      aggregateType: draft.aggregateType,
      aggregateId: draft.aggregateId,
      aggregateVersion: draft.aggregateVersion,
      actor: sanitizeEventActor(context.actor),
      correlationId: context.correlationId,
      causationId: draft.causationId,
      data,
      links: sanitizeEventLinks(draft.links ?? {}),
    };
  }
}
