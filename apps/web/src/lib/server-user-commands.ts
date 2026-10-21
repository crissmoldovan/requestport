import { randomUUID } from "node:crypto";

import {
  createAppearanceRepository,
  createCommandAuthorizationRepository,
  createCommandTransactionManager,
} from "@requestport/db";
import {
  AtomicCommandBus,
  type AuthenticatedUserCommandContext,
  createAuthenticatedUserCommandRegistry,
} from "@requestport/domain";

import type { HumanSession } from "./application-context.js";
import { webMetrics } from "./observability.js";
import { commandFingerprintSecret } from "./server-core-commands.js";
import { webDatabase } from "./server-request-port.js";

/**
 * The session-only human command bus. It runs the same `AtomicCommandBus`
 * implementation as the tenant bus — same parse, secret rejection, actor and
 * key fingerprints, receipt lock, normalized-input replay, time-to-live, save,
 * and metrics — but it is built from the authenticated-user registry, so the
 * only commands reachable through it are the ones that are explicitly global
 * and organization-free.
 *
 * There is deliberately no `authorizeContext` hook here. The personal command
 * owns its own session recheck through the `commandAuthorization` port, which
 * keeps the contract intact even if this bus is ever rebuilt elsewhere, and
 * avoids taking the same session lock twice per command.
 */
const transactions = createCommandTransactionManager(
  webDatabase,
  (name, database) => {
    if (name === "appearance") return createAppearanceRepository(database);
    if (name === "commandAuthorization") {
      return createCommandAuthorizationRepository(database);
    }
    return undefined;
  },
);

export const userCommandBus =
  new AtomicCommandBus<AuthenticatedUserCommandContext>({
    registry: createAuthenticatedUserCommandRegistry(),
    transactions,
    fingerprintSecret: commandFingerprintSecret,
    metrics: webMetrics,
  });

/**
 * Derives the personal command context from the authenticated session alone.
 * No organization is included: personal preferences follow the user across
 * organizations, and implying a tenant here would bind a global write to one.
 */
export function authenticatedUserCommandContext(
  session: HumanSession,
): AuthenticatedUserCommandContext {
  return {
    actor: { type: "user", id: session.user.id },
    credentialId: session.session.id,
    correlationId: randomUUID(),
  };
}
