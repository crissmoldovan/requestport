import { readFileSync } from "node:fs";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AgentAuthContext } from "@requestport/auth";
import { agentScopes, type CommandBus } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  createRequestPortMcpServer,
  type McpServerDependencies,
} from "./server.js";

/*
  What `tools/list` answers, pinned as the server answered it before Plan 13
  F.1 touched `server.ts` (recorded at 694dca1). F.1 moves tool registration
  onto the capability registry; that is a refactor, so every tool must keep
  its name, title, description, input schema, annotations and position.

  The golden is compared twice: as values, and as serialised text, so a
  reordered key inside a schema fails as surely as a changed value. A
  deliberate change to a tool re-records the golden and says so in the commit.

  Four hosts cover every registration gate the server has: the scopes, a
  project on the credential, private telemetry, and the optional host
  dependencies (project registration, provisioning, webhooks, imports).
*/

function readGolden(file: string) {
  return JSON.parse(
    readFileSync(new URL(file, import.meta.url), { encoding: "utf8" }),
  ) as Record<string, unknown>;
}

const golden = readGolden("./server.tools-list.golden.json");

const unreachable = async (): Promise<never> => {
  throw new Error("tools/list reaches no dependency");
};

const commandBus: CommandBus = { execute: unreachable };

const queries = {
  getAgentPolicy: unreachable,
  listOrganizations: unreachable,
  listProjects: unreachable,
  getProject: unreachable,
  listRequests: unreachable,
  getRequest: unreachable,
  listTimeline: unreachable,
  listOpenQuestions: unreachable,
  listEvents: unreachable,
};

const everyHostDependency = {
  acceptsPrivateTelemetry: true,
  registerProject: unreachable,
  createProject: unreachable,
  provisionAgent: unreachable,
  webhooks: {
    list: unreachable,
    create: unreachable,
    verify: unreachable,
    rotate: unreachable,
    setStatus: unreachable,
    replay: unreachable,
  },
  imports: {
    list: unreachable,
    analyze: unreachable,
    detail: unreachable,
    apply: unreachable,
    correct: unreachable,
  },
};

function context(
  scopes: readonly string[],
  projectId: string | null,
): AgentAuthContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f1001" },
    organizationId: "018f0000-0000-7000-8000-0000000f1002",
    projectId,
    laneIds: new Set(),
    scopes: new Set(scopes),
    credentialId: "f1-golden-credential",
    authorizationId: "f1-golden-authorization",
    audience: "mcp",
    correlationId: "018f0000-0000-7000-8000-0000000f1003",
  };
}

const project = "018f0000-0000-7000-8000-0000000f1004";

/** Each host the golden records, by the key it is recorded under. */
export const hosts = {
  "every agent scope, a project, every host dependency": {
    context: context(agentScopes, project),
    ...everyHostDependency,
  },
  "every agent scope, a project, no host dependency": {
    context: context(agentScopes, project),
  },
  "a provisioning grant with no project": {
    context: context(["project:provision"], null),
    ...everyHostDependency,
  },
  "no scope, a project": {
    context: context([], project),
    ...everyHostDependency,
  },
} as const;

/** The tools a server built for `host` lists, exactly as a client sees them. */
export async function listedTools(host: keyof typeof hosts) {
  return toolsListedBy(hosts[host]);
}

/** The tools a server built with these dependencies lists. */
async function toolsListedBy(
  host: Omit<McpServerDependencies, "commandBus" | "queries">,
) {
  const server = createRequestPortMcpServer({ commandBus, queries, ...host });
  const client = new Client({ name: "F.1 golden", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tools/list, against the golden recorded before F.1", () => {
  test("the golden records every host, and each lists at least one tool", () => {
    expect(Object.keys(golden)).toEqual(Object.keys(hosts));
    for (const tools of Object.values(golden))
      expect((tools as unknown[]).length).toBeGreaterThan(0);
  });

  test.each(Object.keys(hosts) as Array<keyof typeof hosts>)(
    "%s",
    async (host) => {
      // As JSON, which is what a client receives: a key the SDK leaves
      // `undefined` is not sent, and is not recorded.
      const listed = JSON.stringify(await listedTools(host));
      expect(JSON.parse(listed)).toStrictEqual(golden[host]);
      expect(listed).toBe(JSON.stringify(golden[host]));
    },
  );
});

/*
  Which tools each scope reaches on its own, pinned from the same original
  server as the golden above (`server.ts` byte-identical to 694dca1 when it was
  recorded). The four hosts above hold every scope or none, so they would not
  notice a tool moved from one scope's gate to another's. Each host here holds
  exactly one agent scope, with a project and every host dependency; since every
  gate in the server is at most one scope plus host conditions, this fixes the
  scope of every scope-gated tool. Names only: the full host above pins what
  each tool says about itself.
*/
const scopeGates = readGolden("./server.scope-gates.golden.json");

/** The names a host holding only `scope` lists, in order. */
export async function namesListedWithOnly(scope: string) {
  return (
    await toolsListedBy({
      ...hosts["every agent scope, a project, every host dependency"],
      context: context([scope], project),
    })
  ).map((tool) => tool.name);
}

describe("tools/list for each scope alone, against the golden recorded before F.1", () => {
  test("the golden records every agent scope, in order", () => {
    expect(Object.keys(scopeGates)).toEqual([...agentScopes]);
  });

  test.each([...agentScopes])("%s", async (scope) => {
    expect(await namesListedWithOnly(scope)).toStrictEqual(scopeGates[scope]);
  });
});
