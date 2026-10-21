import { Link as CueLink, Stack } from "@cueplusplus/ui/layout";
import { serverEnv } from "@requestport/config/server";
import Link from "next/link";

import { AgentConnectionGuide } from "../../../components/agent-connection-guide.js";
import { Page, PageSection } from "../../../components/page-layout.js";
import { SettingsSection } from "../../../components/settings-section.js";

export const dynamic = "force-dynamic";

const sequence = [
  "Register an agent principal in RequestPort.",
  "Bind it to the narrowest project and issue only required scopes.",
  "Configure the MCP endpoint and authenticate with OAuth or the one-time key.",
  "Call whoami, then agent_hello before performing work.",
  "Register the installation and workspace before claiming a request.",
];

/**
 * The MCP reference, on the console's own composition.
 *
 * The endpoints come from the shared connection guide rather than being
 * restated here, so the page and the agent settings screen can never disagree
 * about what an installation has to be pointed at.
 */
export default function McpReferencePage() {
  return (
    <main>
      <Page
        description="Connect an agent using OAuth 2.1 discovery or a scoped API key."
        eyebrow="RequestPort reference"
        title="MCP agent connection"
        width="form"
      >
        <SettingsSection
          headingId="mcp-endpoints-heading"
          note="Prefer OAuth discovery where the client supports it."
          title="Endpoints"
        >
          <AgentConnectionGuide baseUrl={serverEnv.BETTER_AUTH_URL} compact />
        </SettingsSection>
        <SettingsSection
          headingId="mcp-sequence-heading"
          title="Connection sequence"
        >
          <ol>
            {sequence.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </SettingsSection>
        <SettingsSection headingId="mcp-safety-heading" title="Safety boundary">
          <span>
            Machine hostname, username, working directory, repository path, and
            environment details are private telemetry. They are encrypted and
            are not returned by ordinary MCP reads, events, notifications, or
            webhooks.
          </span>
        </SettingsSection>
        <PageSection>
          <Stack align="center" direction="row" gap={3} wrap>
            <CueLink render={<Link href="/docs/api" />} variant="underline">
              REST API reference
            </CueLink>
            <CueLink render={<Link href="/sign-in" />} variant="underline">
              Sign in
            </CueLink>
          </Stack>
        </PageSection>
      </Page>
    </main>
  );
}
