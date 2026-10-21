/**
 * Better Auth's `APIError`, read by name (Plan 13, H.5; manifest-h.md §2.7.1).
 *
 * Where the host's handoff is set, `@requestport/auth/server` exports the
 * members of the Better Auth the handoff carries, so the session check that
 * Next's pages and actions run (`requireHumanSession`) is the host's, and so
 * is the `APIError` it refuses with: the class of the host's copy of
 * `better-auth`, not of the copy Next bundles. An `instanceof APIError` in
 * Next's code would miss it. Better Auth's `APIError` (`@better-auth/core`
 * 1.7.6) extends better-call's (1.4.0), whose constructor sets `name` to
 * `"APIError"` and `status` to the status it is built with, in every copy;
 * and better-call's own `isAPIError` also accepts an error by that name. So
 * the check is the name and the status.
 *
 * Loads nothing, so the web can import it without the host
 * (`subpaths.test.ts`).
 */
export function isUnauthorizedAPIError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "APIError" &&
    (error as { status?: unknown }).status === "UNAUTHORIZED"
  );
}
