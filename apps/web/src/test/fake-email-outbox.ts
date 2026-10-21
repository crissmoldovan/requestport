import { createHash, timingSafeEqual } from "node:crypto";
import {
  clearE2EMagicLinks,
  E2E_TOKEN_HEADER,
  type E2EEnvironment,
  isE2EEmailMode,
  readE2EMagicLink,
} from "@requestport/auth/e2e";

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
} as const;

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: noStoreHeaders,
  });
}

function authorized(request: Request, env: E2EEnvironment) {
  if (!isE2EEmailMode(env)) return false;
  const expected = env.REQUESTPORT_E2E_TOKEN;
  const provided = request.headers.get(E2E_TOKEN_HEADER);
  if (!expected || !provided) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

export function createFakeEmailOutboxHandlers(
  env: E2EEnvironment = process.env,
) {
  return {
    async POST(request: Request) {
      if (!authorized(request, env)) return notFound();
      const body = (await request.json().catch((): null => null)) as {
        email?: unknown;
      } | null;
      if (!body || typeof body.email !== "string") {
        return new Response("Invalid request", {
          status: 400,
          headers: noStoreHeaders,
        });
      }
      const entry = readE2EMagicLink(body.email, env);
      if (!entry) return notFound();
      return Response.json({ url: entry.url }, { headers: noStoreHeaders });
    },
    async DELETE(request: Request) {
      if (!authorized(request, env)) return notFound();
      clearE2EMagicLinks(env);
      return new Response(null, { status: 204, headers: noStoreHeaders });
    },
  };
}
