import { randomUUID } from "node:crypto";

import type { ReactNode } from "react";

import { AppShell } from "../../components/app-shell.js";
import { canEditOrganizationAppearance } from "../../lib/organization-appearance-authority.js";
import { getAppearance } from "../../lib/server-appearance.js";
import {
  createOrganizationAppearanceRenderContext,
  createPersonalAppearanceRenderContext,
} from "../../lib/server-appearance-actions.js";
import { getApplicationLayoutContext } from "../../lib/server-application-context.js";
import {
  updateOrganizationAppearanceAction,
  updatePersonalAppearanceAction,
} from "./settings/appearance/actions.js";

export default async function ApplicationLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [context, appearance] = await Promise.all([
    // The shell reads the context through the boundary-free entry point: a
    // page-level loading, error, or not-found case has to leave the chrome
    // standing, and a layout that suspended or threw with the page would take
    // the very thing those boundaries promise to keep.
    getApplicationLayoutContext(),
    getAppearance(),
  ]);
  const canEditOrganizationDefaults = canEditOrganizationAppearance({
    role: context.currentOrganization?.role,
    version: appearance.snapshot.organization.version,
  });

  return (
    <AppShell
      appearance={{
        action: updatePersonalAppearanceAction,
        // Personal preferences are global, so the render context binds the
        // actor alone and survives an organization switch in another tab.
        contextToken: createPersonalAppearanceRenderContext(
          context.session.user.id,
        ),
        canEditOrganizationDefaults,
        idempotencyNonce: randomUUID(),
        // Offered to an owner only, and with the organization's own render
        // context rather than the personal one: the panel edits two layers and
        // each must carry the authority of the layer it writes.
        organizationDefault:
          canEditOrganizationDefaults && context.currentOrganization
            ? {
                action: updateOrganizationAppearanceAction,
                contextToken: createOrganizationAppearanceRenderContext({
                  actorId: context.session.user.id,
                  organizationId: context.currentOrganization.id,
                }),
                idempotencyNonce: randomUUID(),
              }
            : undefined,
        organizationName: context.currentOrganization?.name ?? null,
        snapshot: appearance.snapshot,
      }}
      currentOrganization={context.currentOrganization}
      organizations={context.organizations}
      user={context.session.user}
    >
      {children}
    </AppShell>
  );
}
