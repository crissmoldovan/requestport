import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";

import { AgentEndpoints, agentEndpoints } from "./agent-connection-guide.js";

/*
  The agents page's endpoints panel, pressed the way a reader presses it: each
  copy control must copy its own row's address. The server-rendered markup
  does not carry the value a control copies, so only a press can tell.
*/

describe("the endpoints panel", () => {
  test("copies each row's own address", async () => {
    // userEvent.setup() stands a clipboard in for the browser's.
    const user = userEvent.setup();
    const endpoints = agentEndpoints("https://requestport.example");
    render(
      <ThemeProvider
        density="ultra-compact"
        mode="system"
        persistPreferences={false}
        theme="requestport"
      >
        <AgentEndpoints endpoints={endpoints} />
      </ThemeProvider>,
    );

    for (const [label, url] of [
      ["MCP endpoint", "https://requestport.example/mcp"],
      ["REST base URL", "https://requestport.example/api/v1"],
      [
        "OAuth resource metadata",
        "https://requestport.example/.well-known/oauth-protected-resource/mcp",
      ],
    ]) {
      await user.click(
        screen.getByRole("button", { name: `Copy the ${label}` }),
      );
      await waitFor(async () =>
        expect(await navigator.clipboard.readText()).toBe(url),
      );
    }
  });
});
