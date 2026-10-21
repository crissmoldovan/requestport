import { serverEnv } from "@requestport/config/server";
import type { RequestPort } from "@requestport/core";
import {
  createCommandPorts,
  createWorkspaceEncryption,
  commandFingerprintSecret as deriveCommandFingerprintSecret,
  humanScopes,
} from "@requestport/core/adapters";
import { personCommandContext } from "@requestport/core/person-context";
import type { AuthorizedCommandContext } from "@requestport/domain";
import type { HumanSession } from "./application-context.js";
import { webRequestPort } from "./server-web-request-port.js";

/*
 * The web's adapter over core's command bus (Plan 13, G.6;
 * manifest-g.md §2.5's `command-bus` row; ruling 137). The bus is the one
 * the web's RequestPort composes (`webRequestPort()`,
 * `server-web-request-port.ts`), over the web root's storage, with core's
 * port table, `webMetrics` and the web's background port; the web composes
 * no bus, port table or transaction manager of its own for it. This module answers the web's modules from
 * that bus, and keeps what they read besides it: the workspace encryption
 * and the fingerprint key, from `serverEnv` as this module loads, and what a
 * signed-in person carries into a command.
 */

export const workspaceEncryption = createWorkspaceEncryption(
  serverEnv.REQUESTPORT_WORKSPACE_KEK
    ? {
        current: {
          version: serverEnv.REQUESTPORT_WORKSPACE_KEK_VERSION,
          key: serverEnv.REQUESTPORT_WORKSPACE_KEK,
        },
        previous:
          serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS &&
          serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION
            ? {
                version: serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION,
                key: serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS,
              }
            : undefined,
      }
    : undefined,
);

/**
 * Core's port table (`createCommandPorts`, an R4 append point, ruling 8),
 * with the switch the composed bus reads: `REQUESTPORT_OPERATOR_CREDENTIALS`,
 * from `serverEnv` as the command authorisation port opens. The composed bus
 * builds its own copy of the same table over the same switch, and never
 * reads this one; the web holds no port line of its own. It is exported for
 * its recorded suite, `server-core-commands.test.ts` (Done when 6's
 * `before-g3.json` lists its cases), which iterates its names; nothing else
 * imports it (ruling 140).
 */
export const commandPorts = createCommandPorts({
  get operatorCredentials() {
    return serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS;
  },
});

/**
 * Shared by the tenant bus and the authenticated-user bus. Receipt identity is
 * already separated by command name and actor fingerprint, and reusing one
 * derivation keeps the two buses on exactly the same idempotency algorithm:
 * core's, `commandFingerprintSecret` (`@requestport/core/adapters`), which
 * the composed bus derives from the same `BETTER_AUTH_SECRET`.
 */
export const commandFingerprintSecret = deriveCommandFingerprintSecret(
  serverEnv.BETTER_AUTH_SECRET,
);

type CoreCommandBus = RequestPort["commandBus"];

/** The web RequestPort's bus, composing the RequestPort if this is its first use. */
const bus = () => webRequestPort().commandBus;

/**
 * The tenant command bus: the web RequestPort's own (`commandBus`). Every
 * operation on it is the same operation on that bus, asked of
 * `webRequestPort()` when it happens: a member read answers the bus's
 * member, a method bound to the bus where the member is one, and a property
 * defined or deleted here is defined or deleted on the bus itself, so a spy
 * a suite installs here is the bus's. Loading this module composes nothing;
 * the first use composes the RequestPort.
 */
export const coreCommandBus: CoreCommandBus = new Proxy({} as CoreCommandBus, {
  get(_target, property) {
    const target = bus();
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has: (_target, property) => Reflect.has(bus(), property),
  set: (_target, property, value) => Reflect.set(bus(), property, value, bus()),
  defineProperty: (_target, property, descriptor) =>
    Reflect.defineProperty(bus(), property, descriptor),
  deleteProperty: (_target, property) =>
    Reflect.deleteProperty(bus(), property),
  getOwnPropertyDescriptor: (_target, property) =>
    Reflect.getOwnPropertyDescriptor(bus(), property),
  getPrototypeOf: () => Reflect.getPrototypeOf(bus()),
  ownKeys: () => Reflect.ownKeys(bus()),
});

/**
 * What a signed-in person carries into a command: core's `humanScopes`, an R4
 * append point (Plan 13, ruling 8) that `packages/core/src/command-bus.ts`
 * holds now. Exported here for the web's modules that read it.
 */
export { humanScopes };

/**
 * A signed-in person's command context: core's `personCommandContext`, over
 * the session's id and its user's.
 */
export function humanCommandContext(
  session: HumanSession,
  organizationId: string,
): AuthorizedCommandContext {
  return personCommandContext(
    { id: session.session.id, userId: session.user.id },
    organizationId,
  );
}
