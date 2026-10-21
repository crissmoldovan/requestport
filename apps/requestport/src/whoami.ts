import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  type CredentialStore,
  resourceFor,
} from "@requestport/client/credentials";
import { createRequestPortHttpClient } from "@requestport/client/http";
import type { FetchLike } from "@requestport/client/oauth";
import type { TokenSource } from "@requestport/client/token-source";
import { z } from "zod";

import { packageVersion } from "./cli.js";

/** What a credential's `whoami` says it is for. */
export interface AgentIdentity {
  readonly organizationId: string;
  /** Null for a grant that names no project (an organization-wide one). */
  readonly projectId: string | null;
}

/**
 * `whoami`, or `list_projects` asked after it in the same MCP session, could
 * not be asked, or answered something it does not document.
 */
export class WhoamiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhoamiError";
  }
}

/** The fields of `whoami` this reads, over MCP (`packages/mcp`'s tool) or REST. */
const IdentitySchema = z.object({
  organizationId: z.uuid(),
  projectId: z.uuid().nullable(),
});

/**
 * What a failure of the MCP client may add to a message: that the server
 * refused the token, or an HTTP status it carried as a number. Its own
 * message is not repeated: it may quote what the server answered. The stdio
 * bridge (`mcp-bridge.ts`) reports through this too.
 */
export function failureOf(error: unknown): string {
  if (error instanceof UnauthorizedError) {
    return "the server refused the access token (HTTP 401)";
  }
  for (const key of ["status", "code"] as const) {
    const value =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)[key]
        : undefined;
    if (typeof value === "number" && value >= 100 && value <= 599) {
      return `the server answered HTTP ${value}`;
    }
  }
  return "the request did not complete";
}

/** The scope `list_projects` needs (`packages/domain`'s transport metadata). */
export const PROJECT_READ_SCOPE = "project:read";

/** One MCP session's questions: `tools/call <name>` with no arguments. */
interface McpSession {
  /** The tool's structured content; an error result is a `WhoamiError`. */
  call(name: string): Promise<unknown>;
  /** `<server>/mcp`'s origin, for messages. */
  readonly origin: string;
}

/**
 * One session on `<server>/mcp`, through `@modelcontextprotocol/client`'s
 * HTTP transport, with a bearer from `tokens` on every request: a credential
 * for the `mcp` audience is accepted only there (manifest-h.md §1.6, §2.8.2).
 * `use` asks its questions, `whoami` first. A token source's own refusal
 * (authorization required, a refresh that did not complete) is thrown as it
 * is; a `WhoamiError` thrown by `use` too; anything else becomes a
 * `WhoamiError` naming the tool being asked.
 */
async function overMcp<T>(
  options: {
    readonly fetch?: FetchLike;
    readonly server: string;
    readonly tokens: TokenSource;
  },
  use: (session: McpSession) => Promise<T>,
): Promise<T> {
  const endpoint = new URL(resourceFor(options.server, "mcp"));
  const origin = endpoint.origin;
  let asking = "whoami";
  let tokenFailure: unknown;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: {
      async token() {
        try {
          return await options.tokens.accessToken();
        } catch (error) {
          tokenFailure ??= error;
          throw error;
        }
      },
    },
    ...(options.fetch === undefined
      ? {}
      : { fetch: options.fetch as typeof fetch }),
  });
  const client = new Client({
    name: "requestport",
    version: packageVersion(),
  });

  try {
    await client.connect(transport);
    return await use({
      async call(name) {
        asking = name;
        const result = await client.callTool({ arguments: {}, name });
        if (result.isError === true) {
          throw new WhoamiError(
            `${name} over MCP on ${origin} answered with an error.`,
          );
        }
        return result.structuredContent;
      },
      origin,
    });
  } catch (error) {
    if (tokenFailure !== undefined) throw tokenFailure;
    if (error instanceof WhoamiError) throw error;
    throw new WhoamiError(
      `${asking} over MCP on ${origin} failed: ${failureOf(error)}.`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * `tools/call whoami` on `<server>/mcp`, in a session of its own
 * (`overMcp`).
 */
export async function whoamiOverMcp(options: {
  readonly fetch?: FetchLike;
  readonly server: string;
  readonly tokens: TokenSource;
}): Promise<AgentIdentity> {
  return overMcp(options, async (session) => {
    const identity = IdentitySchema.safeParse(await session.call("whoami"));
    if (!identity.success) {
      throw new WhoamiError(
        `whoami over MCP on ${session.origin} did not answer an organization id and a project id.`,
      );
    }
    return identity.data;
  });
}

/** What `projectOverMcp` learns: `whoami`'s ids and scopes, and the slug. */
export interface McpProject extends AgentIdentity {
  /**
   * `list_projects`' slug for `projectId`; undefined when `list_projects`
   * was not asked, because the grant names no project or does not carry
   * `PROJECT_READ_SCOPE`.
   */
  readonly projectSlug: string | undefined;
  readonly scopes: readonly string[];
}

const ScopedIdentitySchema = IdentitySchema.extend({
  scopes: z.array(z.string()),
});

const ProjectsSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), slug: z.string() })),
});

/**
 * `whoami`, then, when the grant names a project and carries
 * `PROJECT_READ_SCOPE`, `list_projects` in the same session for that
 * project's slug, which a binding requires and `whoami` does not answer
 * (`@requestport/client/project`'s schema; track-h.md, H.6's survey,
 * question 3). The server registers `list_projects` only for a grant that
 * carries the scope (`packages/mcp`'s `registerRegistryTool`), so it is not
 * asked otherwise. The slug is answered as `list_projects` gave it; the
 * binding's own schema judges it.
 */
export async function projectOverMcp(options: {
  readonly fetch?: FetchLike;
  readonly server: string;
  readonly tokens: TokenSource;
}): Promise<McpProject> {
  return overMcp(options, async (session) => {
    const identity = ScopedIdentitySchema.safeParse(
      await session.call("whoami"),
    );
    if (!identity.success) {
      throw new WhoamiError(
        `whoami over MCP on ${session.origin} did not answer an organization id, a project id and the scopes.`,
      );
    }
    const { organizationId, projectId, scopes } = identity.data;
    if (projectId === null || !scopes.includes(PROJECT_READ_SCOPE)) {
      return { organizationId, projectId, projectSlug: undefined, scopes };
    }

    const listed = ProjectsSchema.safeParse(
      await session.call("list_projects"),
    );
    if (!listed.success) {
      throw new WhoamiError(
        `list_projects over MCP on ${session.origin} did not answer a list of projects with their ids and slugs.`,
      );
    }
    const matching = listed.data.items.filter(
      (item) => item.id.toLowerCase() === projectId.toLowerCase(),
    );
    if (matching.length !== 1) {
      throw new WhoamiError(
        `list_projects over MCP on ${session.origin} did not list project ${projectId} once.`,
      );
    }
    return {
      organizationId,
      projectId,
      projectSlug: (matching[0] as { slug: string }).slug,
      scopes,
    };
  });
}

/**
 * `GET /api/v1/whoami` through `@requestport/client`'s HTTP client, which
 * takes `api` tokens from a token source over `store` (manifest-h.md §2.8.4).
 */
export async function whoamiOverRest(options: {
  readonly fetch?: FetchLike;
  readonly lockDirectory: string;
  readonly projectId: string;
  readonly server: string;
  readonly store: CredentialStore;
}): Promise<AgentIdentity> {
  const answer = await createRequestPortHttpClient({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    lockDirectory: options.lockDirectory,
    projectId: options.projectId,
    server: options.server,
    store: options.store,
  }).whoami();
  const identity = IdentitySchema.safeParse(answer);
  if (!identity.success) {
    throw new WhoamiError(
      `whoami over REST on ${new URL(options.server).origin} did not answer an organization id and a project id.`,
    );
  }
  return identity.data;
}
