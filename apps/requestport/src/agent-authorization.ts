import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorize,
  type CallbackReceiver,
} from "@requestport/client/authorize";
import { startCallbackServer } from "@requestport/client/callback-server";
import type {
  Audience,
  CredentialStore,
} from "@requestport/client/credentials";
import { AGENT_SCOPES, type FetchLike } from "@requestport/client/oauth";
import { createTokenSource } from "@requestport/client/token-source";

import {
  createHoldingStore,
  HOLDING_PROJECT_ID,
  type HoldingStore,
  rekey,
} from "./holding-store.js";
import {
  type AgentIdentity,
  WhoamiError,
  whoamiOverMcp,
  whoamiOverRest,
} from "./whoami.js";

/**
 * The project a grant must be for, and what named it, for the refusal's
 * message: `--project`, the checkout's binding, or the grant made first by
 * `login --for both`.
 */
export interface ExpectedProject {
  readonly projectId: string;
  readonly namedBy: string;
}

/** The consent granted another project than the one expected. */
export class ProjectMismatchError extends Error {
  readonly expected: string;
  readonly granted: string | null;

  constructor(
    audience: Audience,
    expected: ExpectedProject,
    granted: string | null,
  ) {
    super(
      granted === null
        ? `The ${audience} grant names no project, but ${expected.namedBy} names project ${expected.projectId}. Nothing was stored.`
        : `The ${audience} grant is for project ${granted}, but ${expected.namedBy} names project ${expected.projectId}. Nothing was stored.`,
    );
    this.name = "ProjectMismatchError";
    this.expected = expected.projectId;
    this.granted = granted;
  }
}

/** How a held credential's `whoami` is asked: on its audience's own endpoint. */
export type AskWhoami = (input: {
  readonly audience: Audience;
  readonly fetch?: FetchLike;
  readonly holding: HoldingStore;
  readonly lockDirectory: string;
  readonly server: string;
}) => Promise<AgentIdentity>;

export interface AgentAuthorizationOptions {
  readonly audience: Audience;
  readonly expected?: ExpectedProject;
  readonly fetch?: FetchLike;
  /** Given the authorization URL first, before any browser is tried. */
  readonly onAuthorizationUrl: (url: string) => void | Promise<void>;
  readonly openBrowser?: (url: string) => void | Promise<void>;
  readonly server: string;
  /** The loopback receiver; `startCallbackServer`'s unless given. */
  readonly startCallbackReceiver?: () =>
    | CallbackReceiver
    | Promise<CallbackReceiver>;
  /** Where the private lock directory is made; the system's unless given. */
  readonly temporaryDirectory?: string;
  /** For tests: how `whoami` is asked; `askWhoami` unless given. */
  readonly whoami?: AskWhoami;
}

/** A credential authorized and checked, held in memory, not yet stored. */
export interface HeldAuthorization {
  readonly audience: Audience;
  readonly holding: HoldingStore;
  readonly identity: AgentIdentity & { readonly projectId: string };
  readonly server: string;
}

/**
 * `whoami` on the audience's own endpoint (manifest-h.md §2.8.2): MCP's tool
 * for `mcp`, REST's for `api`, each with a token from a token source over the
 * holding store, so the token is refreshed from the record `authorize` held.
 */
export const askWhoami: AskWhoami = async (input) => {
  if (input.audience === "mcp") {
    return whoamiOverMcp({
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      server: input.server,
      tokens: createTokenSource({
        audience: "mcp",
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        lockDirectory: input.lockDirectory,
        projectId: HOLDING_PROJECT_ID,
        server: input.server,
        store: input.holding,
      }),
    });
  }
  return whoamiOverRest({
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    lockDirectory: input.lockDirectory,
    projectId: HOLDING_PROJECT_ID,
    server: input.server,
    store: input.holding,
  });
};

/** `startCallbackServer`, as `authorize` takes a receiver. */
async function loopbackReceiver(): Promise<CallbackReceiver> {
  const server = await startCallbackServer();
  return {
    callback: server.received,
    close: () => server.close(),
    redirectUri: server.redirectUri,
  };
}

/**
 * The placeholder project id appears in `@requestport/client`'s messages,
 * which name the project a credential is for; the person never typed it and
 * cannot act on it, so it is replaced by what it stands for.
 */
function withoutPlaceholder(error: unknown): unknown {
  if (error instanceof Error && error.message.includes(HOLDING_PROJECT_ID)) {
    error.message = error.message
      .replaceAll(`project ${HOLDING_PROJECT_ID}`, "the project being granted")
      .replaceAll(HOLDING_PROJECT_ID, "the project being granted");
  }
  return error;
}

/**
 * The holding-store flow (manifest-h.md §2.8.2 and §2.8.4) for one audience,
 * up to the point of storing: `authorize` into a holding store under a
 * placeholder project id; `whoami` on the audience's endpoint, through a
 * token source over that store, which refreshes once; and, when a project
 * was expected, the refusal of a grant for any other. Nothing is written to
 * the real store here (`storeAuthorization` does that).
 *
 * The token source's lock goes in a directory of its own, made for this call
 * and removed before it returns, so no lock keyed by the placeholder is ever
 * left in `~/.requestport/locks`. The credential exists only in this
 * process, so no other process could be refreshing it.
 */
export async function obtainAuthorization(
  options: AgentAuthorizationOptions,
): Promise<HeldAuthorization> {
  const { audience, server } = options;
  const holding = createHoldingStore(server, audience);
  const lockDirectory = mkdtempSync(
    join(options.temporaryDirectory ?? tmpdir(), "requestport-login-"),
  );

  try {
    await authorize({
      audience,
      deps: {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        onAuthorizationUrl: options.onAuthorizationUrl,
        ...(options.openBrowser === undefined
          ? {}
          : { openBrowser: options.openBrowser }),
        startCallbackReceiver:
          options.startCallbackReceiver ?? loopbackReceiver,
      },
      projectId: HOLDING_PROJECT_ID,
      scopes: AGENT_SCOPES,
      server,
      store: holding,
    });

    const identity = await (options.whoami ?? askWhoami)({
      audience,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      holding,
      lockDirectory,
      server,
    });

    const { expected } = options;
    if (expected !== undefined && identity.projectId !== expected.projectId) {
      holding.clear(server, HOLDING_PROJECT_ID, audience);
      throw new ProjectMismatchError(audience, expected, identity.projectId);
    }
    if (identity.projectId === null) {
      holding.clear(server, HOLDING_PROJECT_ID, audience);
      throw new WhoamiError(
        `The ${audience} grant names no project, and an agent credential is stored for a project. Nothing was stored.`,
      );
    }

    return {
      audience,
      holding,
      identity: {
        organizationId: identity.organizationId,
        projectId: identity.projectId,
      },
      server,
    };
  } catch (error) {
    throw withoutPlaceholder(error);
  } finally {
    rmSync(lockDirectory, { force: true, recursive: true });
  }
}

/**
 * Writes a held credential to the real store under the project `whoami`
 * named, with the record current after the login's refresh.
 */
export function storeAuthorization(
  held: HeldAuthorization,
  store: CredentialStore,
): void {
  rekey(held.holding, store, held.server, held.identity.projectId);
}
