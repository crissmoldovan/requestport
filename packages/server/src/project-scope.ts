import { DomainError } from "@requestport/domain";

/**
 * The same agent context, proven to name a project.
 *
 * Most agent surfaces are project-scoped, and their repositories say so by
 * requiring a project rather than accepting a null one. An exclusively-
 * provisioning grant has no project on purpose — its capability is
 * organization-wide — so it must be turned away at the edge rather than
 * allowed to flow a null into a query that would silently match nothing.
 *
 * Shared rather than repeated because the refusal has to be identical
 * everywhere: a credential that is refused on one route and quietly tolerated
 * on another is worse than one refused nowhere, since only the second kind of
 * gap gets found by accident.
 *
 * Moved here from `apps/web/src/lib/agent-project-scope.ts` (Plan 13, H.1),
 * which re-exports it under the same name for the web's routes.
 */
export function withProject<T extends { projectId?: string | null }>(
  context: T,
): T & { projectId: string } {
  if (!context.projectId) {
    throw new DomainError(
      "forbidden",
      "This credential is not bound to a project, so it cannot reach project data",
    );
  }

  return { ...context, projectId: context.projectId };
}
