import type { OperatorCredentialSwitch } from "@requestport/domain";

/**
 * Whether this Better Auth composition closes `/change-password`: its
 * resolved options list it in `disabledPaths`. That is the list, and the
 * exact-path comparison, the router applies to every request before any
 * handler runs (`better-auth@1.7.6` `dist/api/index.mjs:166-168`). The router
 * is built over a copy of the context `betterAuth(...).$context` resolves to,
 * which shares its `options`, or, with no `baseURL`, spreads them into a new
 * object — `disabledPaths` either way (`dist/auth/base.mjs:35-45`, `:50`,
 * `:58`). So this answers exactly whether the deployment would answer a
 * password change with 404.
 */
export function changePasswordClosed(authContext: {
  options: { disabledPaths?: readonly string[] | undefined };
}) {
  return (authContext.options.disabledPaths ?? []).includes("/change-password");
}

/**
 * F3-14's switch, as `@requestport/auth` computes it (Plan 13, F.3; rulings
 * 46 and 53). Operator credentials are on only when the deployment's
 * `REQUESTPORT_OPERATOR_CREDENTIALS` is `enabled` **and** its Better Auth
 * composition closes `/change-password`. While that endpoint is mounted a
 * password change is a rotation that revokes nothing (F3-13 covers only
 * `bootstrapOwner`), so setting the switch there changes nothing: the answer
 * is off, with the reason the page shows. The table's presence is added by
 * `@requestport/db`'s `availability`.
 */
export function operatorCredentialSwitch(input: {
  variable: "enabled" | "disabled" | undefined;
  authContext: { options: { disabledPaths?: readonly string[] | undefined } };
}): OperatorCredentialSwitch {
  if (input.variable !== "enabled") {
    return { enabled: false, reason: "switched-off" };
  }
  if (!changePasswordClosed(input.authContext)) {
    return { enabled: false, reason: "change-password-mounted" };
  }
  return { enabled: true };
}
