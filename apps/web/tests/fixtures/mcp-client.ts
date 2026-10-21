import { expect } from "@playwright/test";

/**
 * A minimal MCP client, spoken over the product's own HTTP endpoint.
 *
 * Deliberately not the SDK client. What a journey needs to prove here is that
 * a credential authenticates and a tool answers over the wire the product
 * actually serves — and an SDK that negotiates, retries or reconnects on the
 * journey's behalf is a layer between the assertion and the thing asserted.
 * This sends one request and reads one answer.
 *
 * The endpoint is stateless. This client speaks the 2025 wire (it initializes
 * at 2025-06-18 and sends no 2026-07-28 `_meta` envelope), and for that wire
 * `handleMcpRequest` builds a transport with `sessionIdGenerator: undefined`
 * and `enableJsonResponse: true` whether or not `REQUESTPORT_MCP_MODERN`
 * turns on the 2026-07-28 leg, so every POST stands alone and there is no
 * session to carry between calls.
 */

type JsonRpcAnswer = {
  error?: { code?: number; message?: string };
  result?: {
    content?: readonly { text?: string; type?: string }[];
    isError?: boolean;
    structuredContent?: unknown;
  };
};

let nextId = 1;

async function post(
  resource: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown>,
) {
  const response = await fetch(resource, {
    body: JSON.stringify({ id: nextId++, jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const text = await response.text();
  return { response, text };
}

/**
 * The answer body, whichever framing it arrived in.
 *
 * The transport is configured for JSON, but the same endpoint may frame an
 * answer as one `text/event-stream` message, and a journey that understood
 * only one of the two would report a working call as a parse failure.
 */
function parseAnswer(text: string): JsonRpcAnswer {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcAnswer;

  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload) return JSON.parse(payload) as JsonRpcAnswer;
  }

  throw new Error(
    `MCP answer was neither JSON nor an event: ${text.slice(0, 200)}`,
  );
}

/** Open a session the way a client does, and require the credential to pass. */
export async function initializeMcp(
  resource: string,
  accessToken: string,
  clientName: string,
) {
  const { response, text } = await post(resource, accessToken, "initialize", {
    capabilities: {},
    clientInfo: { name: clientName, version: "1" },
    protocolVersion: "2025-06-18",
  });
  expect(
    response.status,
    `the credential authenticated nothing: ${response.status} ${text.slice(0, 200)}`,
  ).toBe(200);
  expect(text, "the resource refused the credential").not.toContain(
    "unauthenticated",
  );
  return parseAnswer(text);
}

/**
 * Call one tool and hand back its structured answer.
 *
 * A tool that refuses answers 200 with `isError`, so the HTTP status alone
 * cannot tell a journey whether its call worked. Both are checked, and the
 * refusal is raised carrying the tool's own error text — truncated, because a
 * validation refusal echoes the input that failed.
 */
export async function callTool(
  resource: string,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { response, text } = await post(resource, accessToken, "tools/call", {
    arguments: args,
    name,
  });
  expect(
    response.status,
    `${name} was refused at the transport: ${response.status} ${text.slice(0, 200)}`,
  ).toBe(200);

  const answer = parseAnswer(text);
  if (answer.error) {
    throw new Error(
      `${name} failed: ${answer.error.code ?? "?"} ${String(answer.error.message ?? "").slice(0, 200)}`,
    );
  }
  const result = answer.result;
  if (result?.isError) {
    throw new Error(
      `${name} refused: ${String(result.content?.[0]?.text ?? "").slice(0, 200)}`,
    );
  }
  if (
    result?.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent as Record<string, unknown>;
  }
  const first = result?.content?.[0]?.text;
  return first ? (JSON.parse(first) as Record<string, unknown>) : {};
}

/**
 * Spend a credential and say only whether it was accepted.
 *
 * Separate from `initializeMcp` because a journey sometimes needs to assert a
 * refusal rather than require an acceptance.
 */
export async function credentialIsAccepted(
  resource: string,
  accessToken: string,
) {
  const { response, text } = await post(resource, accessToken, "initialize", {
    capabilities: {},
    clientInfo: { name: "credential-probe", version: "1" },
    protocolVersion: "2025-06-18",
  });
  return response.status !== 401 && !text.includes("unauthenticated");
}
