import { DescriptionList, Stack } from "@cueplusplus/ui/layout";

type AgentConnectionGuideProps = {
  baseUrl: string;
  compact?: boolean;
};

function endpoint(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

/**
 * How an installation reaches this deployment.
 *
 * The endpoints are one object's fields rather than rows to compare, which is
 * what `DescriptionList` is for. Nothing here prints a credential: the example
 * shows the header's *shape* with an environment reference in it, and the
 * warning under it is painted from tokens rather than the retired hint recipe.
 */
export function AgentConnectionGuide({
  baseUrl,
  compact = false,
}: AgentConnectionGuideProps) {
  const mcpUrl = endpoint(baseUrl, "/mcp");
  const apiUrl = endpoint(baseUrl, "/api/v1");
  const metadataUrl = endpoint(
    baseUrl,
    "/.well-known/oauth-protected-resource/mcp",
  );
  return (
    <Stack direction="column" gap={compact ? 3 : 4}>
      {compact ? null : (
        <Stack direction="column" gap={2}>
          <h3>Connect over MCP</h3>
          <p>
            Prefer OAuth discovery when your client supports it. Otherwise issue
            a project-scoped MCP key below and store it in the client&apos;s
            secure credential or environment facility.
          </p>
        </Stack>
      )}
      <DescriptionList.Root>
        <DescriptionList.Term>MCP endpoint</DescriptionList.Term>
        <DescriptionList.Detail>
          <code className="font-mono break-all">{mcpUrl}</code>
        </DescriptionList.Detail>
        <DescriptionList.Term>OAuth resource metadata</DescriptionList.Term>
        <DescriptionList.Detail>
          <code className="font-mono break-all">{metadataUrl}</code>
        </DescriptionList.Detail>
        <DescriptionList.Term>REST base URL</DescriptionList.Term>
        <DescriptionList.Detail>
          <code className="font-mono break-all">{apiUrl}</code>
        </DescriptionList.Detail>
      </DescriptionList.Root>
      <Stack direction="column" gap={2}>
        <strong>API-key header</strong>
        <pre className="overflow-x-auto font-mono">
          <code>{`Authorization: Bearer \${REQUESTPORT_API_KEY}`}</code>
        </pre>
      </Stack>
      <p className="text-fg-subtle">
        Never paste a credential into a repository, request, agent name, log, or
        command argument. A one-time key is shown only after issue or rotation.
      </p>
    </Stack>
  );
}
