import { WebClient } from "@slack/web-api";
import { z } from "zod";

export const requiredSlackBotScopes = ["chat:write", "im:write"] as const;

export function buildSlackAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", requiredSlackBotScopes.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

const oauthResultSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  scope: z.string().min(1),
  bot_user_id: z.string().min(1),
  team: z.object({ id: z.string().min(1), name: z.string().min(1) }),
});

export async function exchangeSlackOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  client?: WebClient;
}) {
  const result = await (input.client ?? new WebClient()).oauth.v2.access({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const parsed = oauthResultSchema.parse(result);
  const scopes = parsed.scope
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  for (const required of requiredSlackBotScopes) {
    if (!scopes.includes(required))
      throw new Error("Slack did not grant the required bot scopes");
  }
  return {
    accessToken: parsed.access_token,
    botUserId: parsed.bot_user_id,
    scopes,
    workspaceId: parsed.team.id,
    workspaceName: parsed.team.name,
  };
}
