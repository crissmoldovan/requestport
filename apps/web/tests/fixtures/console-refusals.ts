const contentSecurityRefusal = /Content Security Policy/u;

/**
 * Whether a console line is the policy refusing something, rather than the
 * application failing.
 *
 * `acceptance-run.ts` has always kept these apart from errors, because the
 * development server injects styles the nonce policy will not take and a lane
 * that counted those as failures would be failing on the tool again. The lane's
 * diagnostics have to keep them apart too — one local run emitted 5,607 of
 * them, and a diagnostic that repeated each would bury the loads it exists to
 * show.
 *
 * It lives in a module of its own so both readers can have it by the same
 * spelling without the second one taking on the first one's dependencies:
 * `acceptance-run.ts` reaches the database client through its imports, and the
 * diagnostics are attached to every page in every lane and must stay free of
 * anything that heavy.
 */
export function isContentSecurityRefusal(text: string): boolean {
  return contentSecurityRefusal.test(text);
}
