import { serverEnv } from "@requestport/config/server";
import { utf16Max, utf16Min } from "@requestport/domain";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  enforceRateLimit,
  rateLimitFingerprint,
  requestIp,
} from "../../../../../lib/security/rate-limit.js";
import { completeSlackInstallation } from "../../../../../lib/server-slack.js";

const querySchema = z.object({
  code: z.string().min(1).check(utf16Max(2_048)),
  state: z.string().check(utf16Min(20)).check(utf16Max(512)),
});

export async function GET(request: Request) {
  const baseUrl = serverEnv.BETTER_AUTH_URL;
  try {
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));
    await enforceRateLimit({
      endpointClass: "token",
      fingerprint: rateLimitFingerprint(requestIp(request), query.state),
    });
    await completeSlackInstallation(query);
    return NextResponse.redirect(new URL("/slack?installed=1", baseUrl));
  } catch {
    return NextResponse.redirect(new URL("/slack?error=oauth", baseUrl));
  }
}
