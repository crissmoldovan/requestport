import { readinessResponse } from "@requestport/server/health";

import { webStorage } from "../../../../lib/server-request-port.js";

export const dynamic = "force-dynamic";

/*
  Readiness (Plan 13, H.1): `@requestport/server`'s, over the web's own
  check. The check loads the server configuration inside the handler, not as
  the route loads, so the route loads where that configuration does not
  parse and answers 503 there (ruling 140); then it asks the web root for its
  storage, whose `ready()` is the probe raced against 2,000 ms.

  A 503's console line names what was caught by its `name` and `code`, never
  its message (Plan 13, H.5; ruling 145), so the missing issuer or secret
  carries its reason as its `code`.
*/
export async function GET() {
  return readinessResponse(async () => {
    const { serverEnv } = await import("@requestport/config/server");
    if (!serverEnv.BETTER_AUTH_SECRET || !serverEnv.BETTER_AUTH_URL) {
      throw Object.assign(new Error("readiness_configuration_invalid"), {
        code: "readiness_configuration_invalid",
      });
    }
    const storage = webStorage();
    return () => storage.ready();
  });
}
