import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { AGENT_SCOPES } from "./oauth.js";

/**
 * The client can ask for every scope the server can grant.
 *
 * These two lists live in different packages and drift silently: the client's
 * held twelve of the server's fourteen, missing `import:write` and
 * `webhook:manage`, so an agent needing either could not request it at consent
 * and would instead fail at its first call with a scope error — far from the
 * screen where the reason is visible.
 *
 * The domain list is read as text rather than imported, because
 * `@requestport/client` is meant to be installable beside an agent that has no
 * business depending on the server's domain package.
 */
const DOMAIN_SCOPES = resolve(
  import.meta.dirname,
  "../../domain/src/agents/agent-types.ts",
);

function serverScopes(): string[] {
  const source = readFileSync(DOMAIN_SCOPES, "utf8");
  const list = /export const agentScopes = \[(?<body>[\s\S]*?)\]/u.exec(source);

  expect(list?.groups?.body).toBeDefined();

  return [...(list?.groups?.body ?? "").matchAll(/"(?<scope>[a-z:]+)"/gu)]
    .map((match) => match.groups?.scope ?? "")
    .toSorted();
}

/**
 * Organization-wide and exclusive, so it is not offered beside working scopes.
 *
 * A grant carrying it may carry nothing else — the database refuses the
 * combination — so a consent screen that listed it alongside `work:claim`
 * would be offering a choice that cannot be granted.
 */
const PROVISIONING_SCOPE = "project:provision";

describe("the scopes a developer can be asked to grant", () => {
  test("are exactly the server's working scopes", () => {
    expect([...AGENT_SCOPES].toSorted()).toEqual(
      serverScopes().filter((scope) => scope !== PROVISIONING_SCOPE),
    );
  });

  test("exclude the provisioning scope, which is granted on its own", () => {
    expect(serverScopes()).toContain(PROVISIONING_SCOPE);
    expect(AGENT_SCOPES).not.toContain(PROVISIONING_SCOPE);
  });

  test("include the two that were missing", () => {
    expect(AGENT_SCOPES).toContain("import:write");
    expect(AGENT_SCOPES).toContain("webhook:manage");
  });
});
