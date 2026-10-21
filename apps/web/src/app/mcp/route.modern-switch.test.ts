import type { McpServerDependencies } from "@requestport/mcp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  apiOrigin,
  signInAs,
} from "../../test/api-v1/agent-client.js";
import {
  fakeServerEnv,
  resetApiV1Fakes,
} from "../../test/api-v1/fake-database.js";

/*
  The MCP route's judgment of `REQUESTPORT_MCP_MODERN` (Plan 13 K.1, item 3a;
  R6). The schema carries the variable as a plain optional string, so that a
  stray value cannot make the Trigger worker's parse throw; the one line in
  `route.ts` that turns it into `modernProtocol` is therefore the only thing
  that keeps the 2026-07-28 leg off in Production. `handleMcpRequest` is
  replaced here, so what is observed is exactly what the route hands it.
*/

const handed = vi.hoisted(() => [] as McpServerDependencies[]);

vi.mock("@requestport/mcp", () => ({
  handleMcpRequest: async (
    _request: Request,
    dependencies: McpServerDependencies,
  ) => {
    handed.push(dependencies);
    return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
  },
}));
vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../test/api-v1/fake-database.js")).fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../test/api-v1/fake-database.js")).fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../test/api-v1/fake-database.js")).fakeServerConfigModule,
);
vi.mock(
  "../../lib/observability.js",
  async () =>
    (await import("../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../lib/trigger-client.js",
  async () =>
    (await import("../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../test/api-v1/fake-database.js")).fakeWiringModule,
);

const route = await import("./route.js");
const env = fakeServerEnv as typeof fakeServerEnv & {
  REQUESTPORT_MCP_MODERN?: string;
};

function initialize() {
  return new Request(`${apiOrigin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: "Bearer k1-route-switch",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "k1 route switch", version: "1.0.0" },
      },
    }),
  });
}

beforeEach(() => {
  resetApiV1Fakes();
  signInAs(agentContext());
  handed.length = 0;
});

afterEach(() => {
  delete env.REQUESTPORT_MCP_MODERN;
});

describe("the MCP route's REQUESTPORT_MCP_MODERN switch", () => {
  test.each([
    ["unset", undefined, false],
    ["empty", "", false],
    ["disabled", "disabled", false],
    ["yes", "yes", false],
    ["true", "true", false],
    ["Enabled", "Enabled", false],
    ["enabled with a space", " enabled", false],
    ["enabled", "enabled", true],
  ] as const)("REQUESTPORT_MCP_MODERN %s", async (_name, value, on) => {
    if (value === undefined) delete env.REQUESTPORT_MCP_MODERN;
    else env.REQUESTPORT_MCP_MODERN = value;

    const response = await route.POST(initialize());

    expect(response.status).toBe(200);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.modernProtocol).toBe(on);
  });
});
