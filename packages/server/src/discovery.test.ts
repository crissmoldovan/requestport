import { agentScopes } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  discovery,
  protectedResourceDocument,
  protectedResourceMetadata,
} from "./discovery.js";

/** The seventeen scopes the MCP document advertises, verbatim. */
const mcpScopes = [
  "openid",
  "offline_access",
  "project:provision",
  "org:read",
  "project:read",
  "request:create",
  "request:read",
  "request:write",
  "request:triage",
  "request:complete",
  "request:verify",
  "question:answer",
  "work:claim",
  "work:update",
  "agent:register",
  "webhook:manage",
  "import:write",
];

describe("the two protected-resource documents, from the public URL", () => {
  test("the REST API's: the resource, its one authorization server, the header method, the agent scopes and the API's documentation", () => {
    expect(
      protectedResourceDocument("https://requestport.test", "api"),
    ).toStrictEqual({
      resource: "https://requestport.test/api/v1",
      authorization_servers: ["https://requestport.test"],
      bearer_methods_supported: ["header"],
      scopes_supported: agentScopes,
      resource_documentation: "https://requestport.test/docs/api",
    });
  });

  test("MCP's: its seventeen scopes verbatim, and MCP's documentation", () => {
    expect(
      protectedResourceDocument("http://127.0.0.1:4321", "mcp"),
    ).toStrictEqual({
      resource: "http://127.0.0.1:4321/mcp",
      authorization_servers: ["http://127.0.0.1:4321"],
      bearer_methods_supported: ["header"],
      scopes_supported: mcpScopes,
      resource_documentation: "http://127.0.0.1:4321/docs/mcp",
    });
  });

  test("a public URL with a trailing slash names the same documents", () => {
    expect(
      protectedResourceDocument("https://requestport.test/", "api"),
    ).toStrictEqual(
      protectedResourceDocument("https://requestport.test", "api"),
    );
    expect(
      protectedResourceDocument("https://requestport.test/", "mcp"),
    ).toStrictEqual(
      protectedResourceDocument("https://requestport.test", "mcp"),
    );
  });

  test.each(["api", "mcp"] as const)(
    "the %s document is answered as JSON, cacheable for five minutes, and as its exact text",
    async (resource) => {
      const response = protectedResourceMetadata(
        "https://requestport.test",
        resource,
      );

      expect(response.status).toBe(200);
      expect([...response.headers]).toEqual([
        ["cache-control", "public, max-age=300"],
        ["content-type", "application/json"],
      ]);
      expect(await response.text()).toBe(
        JSON.stringify(
          protectedResourceDocument("https://requestport.test", resource),
        ),
      );
    },
  );
});

describe("discovery: the four documents, from one function of the public URL", () => {
  test("hands Better Auth's two handlers through untouched, and builds the other two from the public URL", async () => {
    const authorizationServer = vi.fn(async () => new Response("as"));
    const openIdConfiguration = vi.fn(async () => new Response("oidc"));
    const documents = discovery({
      publicUrl: "http://127.0.0.1:4321",
      oauthAuthorizationServerMetadata: authorizationServer,
      oauthOpenIdConfiguration: openIdConfiguration,
    });
    const request = new Request(
      "http://127.0.0.1:4321/.well-known/oauth-authorization-server",
    );

    expect(documents["authorization-server-metadata"]).toBe(
      authorizationServer,
    );
    expect(documents["openid-configuration"]).toBe(openIdConfiguration);
    expect(
      await (await documents["protected-resource-api"](request)).json(),
    ).toStrictEqual(protectedResourceDocument("http://127.0.0.1:4321", "api"));
    expect(
      await (await documents["protected-resource-mcp"](request)).json(),
    ).toStrictEqual(protectedResourceDocument("http://127.0.0.1:4321", "mcp"));
    expect(authorizationServer).not.toHaveBeenCalled();
    expect(openIdConfiguration).not.toHaveBeenCalled();
  });
});
