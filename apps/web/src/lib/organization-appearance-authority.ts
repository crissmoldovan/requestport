/**
 * Who may change the organization's appearance defaults.
 *
 * Two facts decide it, and both are needed: the viewer owns the organization,
 * and the organization has a defaults row to change. An organization that
 * predates its own defaults — a stage-one bootstrap, or an environment before
 * migration `0014` — has nothing to update yet, so even an owner reads the
 * effective values rather than editing them.
 *
 * Shared rather than repeated. The settings page decides whether to render an
 * editable form, and the account menu decides whether to tell an owner the form
 * exists; those are two views of one authority, and a second spelling of it
 * would drift from the first without either being obviously wrong.
 */
export function canEditOrganizationAppearance(
  input: Readonly<{
    role: string | null | undefined;
    version: number | null | undefined;
  }>,
): boolean {
  return input.role === "owner" && (input.version ?? 0) > 0;
}
