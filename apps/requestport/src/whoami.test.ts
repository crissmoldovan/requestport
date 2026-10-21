import type { FetchLike } from "@requestport/client/oauth";
import {
  AuthorizationRequiredError,
  type TokenSource,
} from "@requestport/client/token-source";
import { describe, expect, test } from "vitest";

import {
  PROJECT_READ_SCOPE,
  projectOverMcp,
  WhoamiError,
  whoamiOverMcp,
} from "./whoami.js";

const server = "https://rp.example";
const organizationId = "018f0000-0000-7000-8000-00000000f001";
const projectId = "018f0000-0000-7000-8000-00000000a001";
const TOKEN = "access-token-sentinel";

type Seen = {
  method: string;
  url: string;
  authorization: string | null;
  rpc?: string;
  tool?: string;
};

/**
 * A stateless MCP endpoint answering JSON, as the host's `/mcp` does with the
 * modern leg off: `initialize`, the `initialized` notification, and
 * `tools/call` answered by `call`, given the tool's name. A GET (the
 * client's event stream) is refused with 405, as a stateless server does.
 */
function fakeMcp(options: {
  readonly status?: number;
  readonly call?: (tool: string) => Record<string, unknown>;
}) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const message =
      method === "POST"
        ? (JSON.parse(String(init?.body)) as {
            id?: number;
            method: string;
            params?: { name?: string; protocolVersion?: string };
          })
        : undefined;
    seen.push({
      authorization: headers.get("authorization"),
      method,
      rpc: message?.method,
      ...(message?.params?.name === undefined
        ? {}
        : { tool: message.params.name }),
      url: String(url),
    });
    if (options.status !== undefined) {
      return new Response(JSON.stringify({ error: "refused" }), {
        headers: { "content-type": "application/json" },
        status: options.status,
      });
    }
    if (message === undefined) return new Response(null, { status: 405 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            capabilities: { tools: {} },
            protocolVersion: message.params?.protocolVersion,
            serverInfo: { name: "fake", version: "1.0.0" },
          }
        : (options.call?.(message.params?.name ?? "") ?? {});
    return new Response(
      JSON.stringify({ id: message.id, jsonrpc: "2.0", result }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  };
  return { fetch, seen };
}

const tokens = (token = TOKEN): TokenSource => ({
  accessToken: async () => token,
});

const whoamiAnswer = (structuredContent: Record<string, unknown>) => () => ({
  content: [{ text: JSON.stringify(structuredContent), type: "text" }],
  structuredContent,
});

describe("whoami over MCP", () => {
  test("calls the tool at <server>/mcp, with a bearer from the token source on every request, and answers the ids", async () => {
    const mcp = fakeMcp({
      call: whoamiAnswer({ audience: "mcp", organizationId, projectId }),
    });

    const identity = await whoamiOverMcp({
      fetch: mcp.fetch,
      server,
      tokens: tokens(),
    });

    expect(identity).toEqual({ organizationId, projectId });
    const posts = mcp.seen.filter((request) => request.method === "POST");
    expect(posts.map((request) => request.rpc)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(
      mcp.seen.map((request) => [request.url, request.authorization]),
    ).toEqual(mcp.seen.map(() => [`${server}/mcp`, `Bearer ${TOKEN}`]));
  });

  test("a 401 is a WhoamiError naming the refusal, and no token", async () => {
    const mcp = fakeMcp({ status: 401 });

    const refusal = whoamiOverMcp({
      fetch: mcp.fetch,
      server,
      tokens: tokens(),
    });

    await expect(refusal).rejects.toBeInstanceOf(WhoamiError);
    await expect(refusal).rejects.toThrow(
      "whoami over MCP on https://rp.example failed: the server refused the access token (HTTP 401).",
    );
  });

  test("another HTTP refusal names its status only", async () => {
    const mcp = fakeMcp({ status: 503 });

    await expect(
      whoamiOverMcp({ fetch: mcp.fetch, server, tokens: tokens() }),
    ).rejects.toThrow(
      "whoami over MCP on https://rp.example failed: the server answered HTTP 503.",
    );
  });

  test("the token source's own refusal is thrown as it is", async () => {
    const required = new AuthorizationRequiredError(
      'Authorization required: run "requestport login --for mcp".',
      "mcp",
      "missing",
    );
    const mcp = fakeMcp({ call: whoamiAnswer({ organizationId, projectId }) });

    await expect(
      whoamiOverMcp({
        fetch: mcp.fetch,
        server,
        tokens: {
          accessToken: async () => {
            throw required;
          },
        },
      }),
    ).rejects.toBe(required);
  });

  test("an error result, or an answer without the ids, is a WhoamiError", async () => {
    const failing = fakeMcp({
      call: () => ({ content: [{ text: "no", type: "text" }], isError: true }),
    });
    await expect(
      whoamiOverMcp({ fetch: failing.fetch, server, tokens: tokens() }),
    ).rejects.toThrow(
      "whoami over MCP on https://rp.example answered with an error.",
    );

    const empty = fakeMcp({ call: whoamiAnswer({ organizationId }) });
    await expect(
      whoamiOverMcp({ fetch: empty.fetch, server, tokens: tokens() }),
    ).rejects.toThrow(
      "whoami over MCP on https://rp.example did not answer an organization id and a project id.",
    );
  });

  test("an organization-wide grant answers a null project", async () => {
    const mcp = fakeMcp({
      call: whoamiAnswer({ organizationId, projectId: null }),
    });

    await expect(
      whoamiOverMcp({ fetch: mcp.fetch, server, tokens: tokens() }),
    ).resolves.toEqual({ organizationId, projectId: null });
  });
});

describe("the project over MCP, for link", () => {
  const slug = "the-project";
  const answers =
    (whoami: Record<string, unknown>, projects?: Record<string, unknown>) =>
    (tool: string) => {
      const structuredContent =
        tool === "whoami" ? whoami : (projects ?? { items: [] });
      return {
        content: [{ text: JSON.stringify(structuredContent), type: "text" }],
        structuredContent,
      };
    };

  test("whoami, then list_projects in the same session, with a bearer on every request: the ids, the scopes and the slug", async () => {
    const mcp = fakeMcp({
      call: answers(
        {
          organizationId,
          projectId,
          scopes: ["org:read", PROJECT_READ_SCOPE],
        },
        {
          items: [
            { id: "018f0000-0000-7000-8000-00000000b001", slug: "another" },
            { id: projectId.toUpperCase(), slug },
          ],
        },
      ),
    });

    const project = await projectOverMcp({
      fetch: mcp.fetch,
      server,
      tokens: tokens(),
    });

    expect(project).toEqual({
      organizationId,
      projectId,
      projectSlug: slug,
      scopes: ["org:read", PROJECT_READ_SCOPE],
    });
    const posts = mcp.seen.filter((request) => request.method === "POST");
    expect(posts.map((request) => request.rpc)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    expect(posts.flatMap((request) => request.tool ?? [])).toEqual([
      "whoami",
      "list_projects",
    ]);
    expect(
      posts.filter((request) => request.rpc === "initialize"),
    ).toHaveLength(1);
    expect(
      mcp.seen.map((request) => [request.url, request.authorization]),
    ).toEqual(mcp.seen.map(() => [`${server}/mcp`, `Bearer ${TOKEN}`]));
  });

  test("without project:read, or for a grant naming no project, list_projects is not asked and there is no slug", async () => {
    const unscoped = fakeMcp({
      call: answers({ organizationId, projectId, scopes: ["org:read"] }),
    });
    await expect(
      projectOverMcp({ fetch: unscoped.fetch, server, tokens: tokens() }),
    ).resolves.toEqual({
      organizationId,
      projectId,
      projectSlug: undefined,
      scopes: ["org:read"],
    });
    expect(unscoped.seen.flatMap((request) => request.tool ?? [])).toEqual([
      "whoami",
    ]);

    const organizationWide = fakeMcp({
      call: answers({
        organizationId,
        projectId: null,
        scopes: [PROJECT_READ_SCOPE],
      }),
    });
    await expect(
      projectOverMcp({
        fetch: organizationWide.fetch,
        server,
        tokens: tokens(),
      }),
    ).resolves.toMatchObject({ projectId: null, projectSlug: undefined });
    expect(
      organizationWide.seen.flatMap((request) => request.tool ?? []),
    ).toEqual(["whoami"]);
  });

  test("an answer it does not document is a WhoamiError naming the tool", async () => {
    const noScopes = fakeMcp({ call: answers({ organizationId, projectId }) });
    await expect(
      projectOverMcp({ fetch: noScopes.fetch, server, tokens: tokens() }),
    ).rejects.toThrow(
      "whoami over MCP on https://rp.example did not answer an organization id, a project id and the scopes.",
    );

    const unlisted = fakeMcp({
      call: answers(
        { organizationId, projectId, scopes: [PROJECT_READ_SCOPE] },
        {
          items: [
            { id: "018f0000-0000-7000-8000-00000000b001", slug: "another" },
          ],
        },
      ),
    });
    await expect(
      projectOverMcp({ fetch: unlisted.fetch, server, tokens: tokens() }),
    ).rejects.toThrow(
      `list_projects over MCP on https://rp.example did not list project ${projectId} once.`,
    );

    const malformed = fakeMcp({
      call: answers(
        { organizationId, projectId, scopes: [PROJECT_READ_SCOPE] },
        { projects: [] },
      ),
    });
    await expect(
      projectOverMcp({ fetch: malformed.fetch, server, tokens: tokens() }),
    ).rejects.toThrow(
      "list_projects over MCP on https://rp.example did not answer a list of projects with their ids and slugs.",
    );
  });

  test("list_projects' error result names list_projects", async () => {
    const mcp = fakeMcp({
      call: (tool) =>
        tool === "whoami"
          ? {
              content: [],
              structuredContent: {
                organizationId,
                projectId,
                scopes: [PROJECT_READ_SCOPE],
              },
            }
          : { content: [{ text: "no", type: "text" }], isError: true },
    });

    const refusal = projectOverMcp({
      fetch: mcp.fetch,
      server,
      tokens: tokens(),
    });

    await expect(refusal).rejects.toBeInstanceOf(WhoamiError);
    await expect(refusal).rejects.toThrow(
      "list_projects over MCP on https://rp.example answered with an error.",
    );
  });
});
