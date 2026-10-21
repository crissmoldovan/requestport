export const CURRENT_ORGANIZATION_COOKIE = "requestport.organization_id";

type CookieStore = {
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      sameSite: "lax";
      path: string;
      secure: boolean;
    },
  ): void;
};

/**
 * Write the tenant a request should be answered in.
 *
 * The environment is read off an object rather than through
 * `process.env.NODE_ENV` directly, and that is the whole point of the shape.
 * The bundler folds the direct expression to a constant while building, so a
 * built server marked this cookie `Secure` however it was started — and a
 * `Secure` cookie is refused over plain loopback by WebKit, which does not
 * exempt loopback the way Chromium does. The cookie was dropped, the tenant
 * fell back to another of the account's organizations, and the project a lane
 * created went into it: in CI run 33512899408 the WebKit lane could not build
 * the tenant its cases run against, reading back a project that had been
 * created somewhere else, while Chromium passed the same flow twice over. A
 * property read off an object survives the build, so the value here is the one
 * the server is actually running under.
 */
export function writeCurrentOrganizationCookie(
  cookieStore: CookieStore,
  organizationId: string,
  env: { NODE_ENV?: string } = process.env,
) {
  cookieStore.set(CURRENT_ORGANIZATION_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.NODE_ENV === "production",
  });
}
