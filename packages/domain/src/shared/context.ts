import { validateOpaqueId, validationError } from "./validation.js";

export type CommandActor =
  | { type: "unauthenticated" }
  | { type: "user"; userId: string }
  | { type: "system"; system: "bootstrap-owner-cli" };

export type CommandContext = {
  actor: CommandActor;
  correlationId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCommandContext(
  context: unknown,
): asserts context is CommandContext {
  if (
    !isRecord(context) ||
    !("actor" in context) ||
    !("correlationId" in context)
  ) {
    throw validationError("context", "Command context is invalid");
  }
  validateOpaqueId(context.correlationId, "correlationId", 128);
  if (!isRecord(context.actor) || typeof context.actor.type !== "string") {
    throw validationError("actor", "Command actor is invalid");
  }
  if (context.actor.type === "user") {
    validateOpaqueId(context.actor.userId, "userId");
  } else if (context.actor.type === "system") {
    if (context.actor.system !== "bootstrap-owner-cli") {
      throw validationError("actor", "System actor is invalid");
    }
  } else if (context.actor.type !== "unauthenticated") {
    throw validationError("actor", "System actor is invalid");
  }
}
