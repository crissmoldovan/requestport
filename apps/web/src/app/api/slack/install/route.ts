import { serverEnv } from "@requestport/config/server";
import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { humanCommandContext } from "../../../../lib/server-core-commands.js";
import { startSlackInstallation } from "../../../../lib/server-slack.js";

export async function GET() {
  const application = await getApplicationContext();
  if (!application.currentOrganization)
    return NextResponse.redirect(new URL("/", serverEnv.BETTER_AUTH_URL));
  try {
    await enforceRateLimit({
      endpointClass: "slack_user",
      fingerprint: rateLimitFingerprint(
        application.currentOrganization.id,
        application.session.user.id,
      ),
    });
    const location = await startSlackInstallation(
      humanCommandContext(
        application.session,
        application.currentOrganization.id,
      ),
    );
    return NextResponse.redirect(location);
  } catch {
    return NextResponse.redirect(
      new URL("/slack?error=install", serverEnv.BETTER_AUTH_URL),
    );
  }
}
