/*
  The security headers `proxy.ts` sets (Plan 13, H.1). The body moved to
  `@requestport/server`'s `./security-headers`, which imports nothing, and the
  host sets the same headers on the answers it serves. This module keeps the
  name `proxy.ts` and its tests import, and hands `proxy.ts` the public URL's
  rule for `upgrade-insecure-requests` beside it (H.5), the rule the host
  follows too.
*/
export {
  requestSecurityHeaders,
  upgradeInsecureRequestsFor,
} from "@requestport/server/security-headers";
