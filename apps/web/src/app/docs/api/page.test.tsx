import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_URL: "https://requestport.example.invalid/" },
}));

import {
  commandReference,
  readDescriptions,
  readReference,
  scopesOf,
} from "./api-reference.js";
import document from "./generated/openapi.json";
import ApiReferencePage from "./page.js";

type Operation = {
  operationId: string;
  /** One requirement per scheme that may call it (Plan 13, F.3). */
  security: Record<string, string[]>[];
};

/** Every scope any requirement of an operation lists, under any scheme. */
function everyScope(operation: Operation | undefined) {
  return (operation?.security ?? []).flatMap((requirement) =>
    Object.values(requirement).flat(),
  );
}

const paths = document.paths as unknown as Record<
  string,
  { get?: Operation; post?: Operation }
>;

/** A retired local page class, assembled so the audit reads bookkeeping. */
function pageClass(...parts: readonly string[]): string {
  return parts.join("-");
}

function markup() {
  return renderToStaticMarkup(ApiReferencePage());
}

describe("the REST API reference", () => {
  test("wears the console's own page header rather than a local one", () => {
    const html = markup();

    expect(html).toContain('data-slot="page-shell-header"');
    expect(html).toContain('data-slot="eyebrow"');
    expect(html).toContain("REST API");
    expect(html).not.toContain(pageClass("reference", "page"));
    expect(html).not.toContain(pageClass("page", "eyebrow"));
  });

  test("shows the base URL on a token-backed terminal surface", () => {
    const html = markup();

    expect(html).toContain('data-slot="terminal-frame"');
    expect(html).toContain("https://requestport.example.invalid/api/v1");
  });

  test("offers the command example to the clipboard exactly as written", () => {
    const html = markup();

    expect(html).toContain('data-slot="terminal-frame-copy"');
    expect(html).toContain("POST https://requestport.example.invalid/api/v1");
    expect(html).toContain("idempotencyKey");
  });

  test("names the header shape without printing a credential", () => {
    const html = markup();

    expect(html).toContain("Authorization: Bearer $REQUESTPORT_API_KEY");
    expect(html).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/u);
  });

  test("reaches the MCP reference and the sign-in route", () => {
    const html = markup();

    expect(html).toContain('href="/docs/mcp"');
    expect(html).toContain('href="/sign-in"');
  });

  test("lists every read path the OpenAPI document records, with its scope", () => {
    const html = markup();
    const reads = Object.entries(paths).filter(([, item]) => item.get);

    expect(reads.length).toBeGreaterThan(0);
    for (const [path, item] of reads) {
      expect(html).toContain(`>${path.replace(/^\/api\/v1/u, "")}<`);
      for (const scope of everyScope(item.get)) {
        expect(html).toContain(scope);
      }
    }
  });

  test("lists every command the OpenAPI document records, with its scopes", () => {
    const html = markup();
    const commands = Object.values(paths).flatMap((item) =>
      item.post ? [item.post] : [],
    );

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(html).toContain(`>${command.operationId}<`);
      for (const scope of everyScope(command)) {
        expect(html).toContain(scope);
      }
    }
  });

  test("reads the scopes of every scheme an operation names (Plan 13, F.3)", () => {
    // An operator-only command lists its scope under `operatorBearer` alone,
    // and a read any credential may call lists no scope under either scheme.
    expect(
      commandReference.find(
        (command) => command.name === "revoke_operator_credential",
      )?.scopes,
    ).toEqual(["operator:revoke"]);
    expect(
      readReference.find((read) => read.path === "/whoami")?.scopes,
    ).toEqual([]);

    const html = markup();
    expect(html).toMatch(
      />revoke_operator_credential<\/code>(?:(?!<dt)[\s\S])*>operator:revoke<\/code>/u,
    );
    expect(html).toMatch(/>\/whoami<\/code>(?:(?!<dt)[\s\S])*No scope\./u);
  });

  test("lists a scope once when two schemes both require it", () => {
    expect(
      scopesOf({
        operationId: "a_command_both_kinds_call",
        security: [
          { agentBearer: ["request:read"] },
          { operatorBearer: ["request:read"] },
        ],
      }),
    ).toEqual(["request:read"]);
    expect(
      scopesOf({
        operationId: "a_read_needing_no_scope",
        security: [{ agentBearer: [] }, { operatorBearer: [] }],
      }),
    ).toEqual([]);
  });

  test("names every error code the OpenAPI document gives, by status", () => {
    const html = markup();
    const responses = document.components.responses as Record<
      string,
      {
        content: {
          "application/json": {
            schema: { properties: { error: { enum: string[] } } };
          };
        };
      }
    >;

    expect(Object.keys(responses).length).toBeGreaterThan(0);
    for (const [name, response] of Object.entries(responses)) {
      expect(html).toContain(`>${name.replace(/^Status/u, "")}<`);
      for (const code of response.content["application/json"].schema.properties
        .error.enum) {
        expect(html).toContain(code);
      }
    }
  });

  test("links the OpenAPI document itself", () => {
    expect(markup()).toContain('href="/docs/api/openapi.json"');
  });

  test("describes every read path the document records, and no other", () => {
    const reads = Object.entries(paths)
      .filter(([, item]) => item.get)
      .map(([path]) => path.replace(/^\/api\/v1/u, ""));

    expect(Object.keys(readDescriptions).toSorted()).toEqual(reads.toSorted());
  });
});
