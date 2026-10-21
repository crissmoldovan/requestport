/**
 * F.2.6 — import review. Freezing is human-only (ruling 3, rows/human-only.ts).
 * The review form dispatches `review_legacy_import_entry` on the tenant bus,
 * and the split form calls `splitImportEntry` (`lib/server-import-actions.ts`,
 * which runs core's handler), which stays off the bus. `/api/v1`
 * reaches the same command and the same handler for an operator credential
 * holding `import:write`, through their registry entries
 * (`credentialKinds: ["operator"]`, ruling 25): `import:write` is also an
 * agent scope, and an entry without that field would admit agents only.
 */
const module = "app/(app)/imports/actions.ts";

export const rows = [
  {
    module,
    action: "reviewImportEntryAction",
    status: "ported",
    surfaces: [{ registry: "review_legacy_import_entry" }],
  },
  {
    module,
    action: "splitImportEntryAction",
    status: "ported",
    surfaces: [{ registry: "split_legacy_import_entry" }],
  },
];
