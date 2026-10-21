import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_URL: "https://requestport.example.invalid/" },
}));

import McpReferencePage from "./page.js";

/** A retired local page class, assembled so the audit reads bookkeeping. */
function pageClass(...parts: readonly string[]): string {
  return parts.join("-");
}

function markup() {
  return renderToStaticMarkup(McpReferencePage());
}

describe("the MCP reference", () => {
  test("wears the console's own page header rather than a local one", () => {
    const html = markup();

    expect(html).toContain('data-slot="page-shell-header"');
    expect(html).toContain("MCP agent connection");
    expect(html).not.toContain(pageClass("reference", "page"));
    expect(html).not.toContain(pageClass("page", "eyebrow"));
  });

  test("keeps the connection guide's endpoints on the page", () => {
    const html = markup();

    expect(html).toContain('data-slot="description-list"');
    expect(html).toContain("https://requestport.example.invalid/mcp");
  });

  test("shows the connection sequence and the telemetry boundary", () => {
    const html = markup();

    expect(html).toContain("Connection sequence");
    expect(html).toContain("Safety boundary");
    expect(html).toContain("agent_hello");
  });

  test("reaches the REST reference and the sign-in route", () => {
    const html = markup();

    expect(html).toContain('href="/docs/api"');
    expect(html).toContain('href="/sign-in"');
  });
});
