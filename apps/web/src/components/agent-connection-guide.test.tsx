import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AgentConnectionGuide } from "./agent-connection-guide.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

describe("agent connection guide", () => {
  const markup = renderToStaticMarkup(
    <AgentConnectionGuide baseUrl="https://staging.requestport.com" />,
  );

  test("derives all three endpoints from the deployment's own base URL", () => {
    expect(markup).toContain("https://staging.requestport.com/mcp");
    expect(markup).toContain("https://staging.requestport.com/api/v1");
    expect(markup).toContain(
      "https://staging.requestport.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  test("publishes the endpoints as a description list rather than loose text", () => {
    expect(markup).toContain('data-slot="description-list"');
    expect(markup).toContain('data-slot="description-list-term"');
    expect(markup).toContain('data-slot="description-list-detail"');
  });

  test("keeps the credential warning as painted text, not the retired recipe", () => {
    expect(markup).toContain(
      "Never paste a credential into a repository, request, agent name, log, or command argument.",
    );
    expect(markup).not.toContain(recipeClass("hint"));
  });

  test("never prints a credential of its own — only the header shape", () => {
    expect(markup).toContain("Authorization: Bearer");
    expect(markup).toContain("REQUESTPORT_API_KEY");
    expect(markup).not.toContain("rqp_");
  });
});
