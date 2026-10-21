import { randomUUID } from "node:crypto";

import {
  OrganizationAppearanceForm,
  PersonalAppearanceForm,
} from "../../../../components/appearance-controls.js";
import { Page, PageSection } from "../../../../components/page-layout.js";
import { getAppearance } from "../../../../lib/server-appearance.js";
import {
  createOrganizationAppearanceRenderContext,
  createPersonalAppearanceRenderContext,
} from "../../../../lib/server-appearance-actions.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import {
  updateOrganizationAppearanceAction,
  updatePersonalAppearanceAction,
} from "./actions.js";

export default async function AppearanceSettingsPage() {
  const [context, appearance] = await Promise.all([
    getApplicationContext(),
    getAppearance(),
  ]);
  const organization = context.currentOrganization;
  const snapshot = appearance.snapshot;
  // An organization that predates its defaults row — a stage-one bootstrap, or
  // an environment before migration `0014` — has nothing to update yet, so even
  // an owner sees the effective values read-only until initialization lands.
  const editable =
    organization?.role === "owner" && snapshot.organization.version > 0;

  return (
    <Page
      description="Choose the theme, density, and mode this account uses everywhere, and the defaults everyone in the organization inherits."
      eyebrow="Settings"
      title="Appearance"
      width="form"
    >
      <PageSection labelledBy="personal-appearance">
        <h2 id="personal-appearance">Your appearance</h2>
        <p>
          These choices follow your account across every organization. Any axis
          left on the organization default keeps inheriting it.
        </p>
        <PersonalAppearanceForm
          action={updatePersonalAppearanceAction}
          contextToken={createPersonalAppearanceRenderContext(
            context.session.user.id,
          )}
          idempotencyNonce={randomUUID()}
          organizationName={organization?.name ?? null}
          snapshot={snapshot}
        />
      </PageSection>
      <PageSection labelledBy="organization-appearance">
        <h2 id="organization-appearance">Organization defaults</h2>
        {organization ? (
          <OrganizationAppearanceForm
            action={updateOrganizationAppearanceAction}
            canEdit={editable}
            contextToken={
              editable
                ? createOrganizationAppearanceRenderContext({
                    actorId: context.session.user.id,
                    organizationId: organization.id,
                  })
                : ""
            }
            defaults={{
              density: snapshot.organization.density,
              mode: snapshot.organization.mode,
              theme: snapshot.organization.theme,
            }}
            idempotencyNonce={randomUUID()}
            organizationName={organization.name}
            overrides={snapshot.user}
            version={snapshot.organization.version}
          />
        ) : (
          <p>
            Join or create an organization to inherit and manage shared
            appearance defaults.
          </p>
        )}
      </PageSection>
    </Page>
  );
}
