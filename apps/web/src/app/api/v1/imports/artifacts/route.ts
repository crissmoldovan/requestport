import { authenticateAgentBearer } from "@requestport/auth/server";
import { serverEnv } from "@requestport/config/server";
import { createImportRepository } from "@requestport/db";
import { handleArtifactImport } from "@requestport/server/artifact-import";

import { withProject } from "../../../../../lib/agent-project-scope.js";
import { bearerChallenge } from "../../../../../lib/security/bearer-challenge.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../../../lib/security/rate-limit.js";
import { webStorage } from "../../../../../lib/server-request-port.js";

/*
  The artifact import (Plan 13, H.1): `@requestport/server`'s handler, which
  holds the schemas, the 9 MiB bound and the error mapping, over the web's
  own collaborators, each passed from the module the route imported it from
  before. The handler opens one import transaction, once the request is
  admitted: only then is the web root asked for its storage, and the import
  repository is built here, on that transaction's handle, so the handle
  stays in this module. The receipts' secret, `BETTER_AUTH_SECRET`, is read
  as each receipt is keyed.
*/
export async function POST(request: Request) {
  return handleArtifactImport(request, {
    authenticateAgentBearer,
    withProject,
    rateLimiter: {
      fingerprint: rateLimitFingerprint,
      enforce: enforceRateLimit,
    },
    challenge: bearerChallenge,
    importTransaction: (work) => {
      const storage = webStorage();
      return storage.transaction((tx) => work(createImportRepository(tx)));
    },
    fingerprintSecret: () => serverEnv.BETTER_AUTH_SECRET,
  });
}
