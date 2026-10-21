import { serverEnv } from "@requestport/config/server";
import { protectedResourceMetadata } from "@requestport/server/discovery";

export const dynamic = "force-dynamic";

/*
  MCP's protected-resource document (RFC 9728), with its seventeen scopes,
  built by `@requestport/server`'s discovery from `BETTER_AUTH_URL`, read on
  each request (Plan 13, H.1). The host serves the same document.
*/
export async function GET() {
  return protectedResourceMetadata(serverEnv.BETTER_AUTH_URL, "mcp");
}
