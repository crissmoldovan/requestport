import {
  createCoreEventSchemaRegistry,
  type JsonValue,
  sanitizeEventActor,
  sanitizeEventLinks,
} from "@requestport/domain";

const eventSchemas = createCoreEventSchemaRegistry();

export function publicEventProjection(input: {
  actor: unknown;
  data: unknown;
  links: Record<string, string>;
  type: string;
}) {
  return {
    actor: sanitizeEventActor(input.actor) as unknown as Record<
      string,
      JsonValue
    >,
    data: eventSchemas.parse(input.type, input.data),
    links: sanitizeEventLinks(input.links),
  };
}
