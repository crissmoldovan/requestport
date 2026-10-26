import { randomUUID } from "node:crypto";

import {
  OrganizationAppearanceForm,
  PersonalAppearanceForm,
} from "../../../../components/appearance-controls.js";
import { Page, PageSection } from "../../../../components/page-layout.js";
import { canEditOrganizationAppearance } from "../../../../lib/organization-appearance-authority.js";
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

/**
 * Settings › Appearance (ruling 255): six axes in two sections. The
 * organization's default, which only an owner or an admin may change, comes
 * first and is drawn only for them; *Just for you* follows for everyone, each
 * row offering the organization's value first.
 */
export default async function AppearanceSettingsPage() {
  const [context, appearance] = await Promise.all([
    getApplicationContext(),
    getAppearance(),
  ]);
  const organization = context.currentOrganization;
  const snapshot = appearance.snapshot;
  // The same authority the account menu asks: an owner or an admin, of an
  // organization with a defaults row. One that predates its row — a
  // stage-one bootstrap, or an environment before migration `0014` — has
  // nothing to update yet, so not even they are offered the defaults until
  // initialization lands.
  const editable = canEditOrganizationAppearance({
    role: organization?.role,
    version: snapshot.organization.version,
  });

  return (
    <Page
      description={
        !organization
          ? "Choose the theme, mode, density, typeface, Look and surface this account uses everywhere."
          : editable
            ? `As ${organization.role === "admin" ? "an admin" : "an owner"} you set the default for everyone in ${organization.name}. Anyone can still choose differently for themselves.`
            : `The owners and admins of ${organization.name} set its defaults. Choose differently here, just for you.`
      }
      eyebrow="Settings"
      title="Appearance"
      width="form"
    >
      {organization && editable ? (
        <PageSection labelledBy="organization-appearance">
          <h2 id="organization-appearance">Organization default</h2>
          <OrganizationAppearanceForm
            action={updateOrganizationAppearanceAction}
            contextToken={createOrganizationAppearanceRenderContext({
              actorId: context.session.user.id,
              organizationId: organization.id,
            })}
            defaults={{
              density: snapshot.organization.density,
              font: snapshot.organization.font,
              look: snapshot.organization.look,
              mode: snapshot.organization.mode,
              paint: snapshot.organization.paint,
              theme: snapshot.organization.theme,
            }}
            idempotencyNonce={randomUUID()}
            organizationName={organization.name}
            overrides={snapshot.user}
            version={snapshot.organization.version}
          />
        </PageSection>
      ) : null}
      <PageSection labelledBy="personal-appearance">
        <h2 id="personal-appearance">Just for you</h2>
        <p>
          These choices follow your account across every organization. A setting
          left on the organization default keeps following it.
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
    </Page>
  );
}
