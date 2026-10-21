/**
 * The named list of volatile fields (manifest-h.md §2.2, Done when 1): each
 * field a golden replaces with a fixed token, and nothing else.
 *
 * The list holds exactly the fields that differed between two recordings of
 * the same family on the same tree. Recording (`REQUESTPORT_RECORD_ROUTE_GOLDENS=1`)
 * observes every case twice and refuses to write a golden when the two still
 * differ once the list is applied, or when an entry names a field that never
 * differed.
 *
 * Measured on these cases, one field differs, in every family: the nonce the
 * web's proxy mints for each response (`apps/web/src/proxy.ts`), which its
 * `content-security-policy` carries twice. Only the nonce is replaced; the
 * rest of the policy stays in the golden. The volatile values the plan also
 * expected (Better Auth's generated client id and its issue time, a cookie's
 * value, a `date` header) do not occur here: Better Auth's handler is a
 * stand-in that answers fixed values, and no route handler sets `date`.
 */
export type NormalisationEntry = {
  /** What the field is, as a reader of the golden would name it. */
  name: string;
  /** The golden file's family: `auth`, `discovery`, `health`, … */
  family: string;
  /**
   * A header's whole value, or, with `pattern`, each match of that regular
   * expression inside it; or a top-level field of a JSON body.
   */
  where: { header: string; pattern?: string } | { jsonField: string };
  /** What the golden holds in its place. */
  token: string;
};

const families = [
  "auth",
  "discovery",
  "rest",
  "artifact-import",
  "mcp",
  "health",
] as const;

export const normalisation: readonly NormalisationEntry[] = families.map(
  (family) => ({
    name: "the proxy's CSP nonce",
    family,
    where: {
      header: "content-security-policy",
      pattern: "'nonce-[0-9a-f]{32}'",
    },
    token: "'nonce-<nonce>'",
  }),
);

export function normalisationFor(family: string) {
  return normalisation.filter((entry) => entry.family === family);
}
