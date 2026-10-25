import { randomUUID } from "node:crypto";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import {
  operatorCredentialAvailability,
  operatorCredentialService,
} from "@requestport/auth/server";
import { createFoundationQueryRepository } from "@requestport/db";
import { operatorScopes } from "@requestport/domain";
import { KeyRound, ShieldOff } from "lucide-react";

import { NoOrganizationSetup } from "../../../../components/administration-views.js";
import {
  IssueOperatorCredentialForm,
  OperatorCredentialActions,
} from "../../../../components/operator-credentials.js";
import { Page } from "../../../../components/page-layout.js";
import { SettingsSection } from "../../../../components/settings-section.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { humanCommandContext } from "../../../../lib/server-core-commands.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import { operatorUnavailableMessages } from "./action-state.js";
import {
  issueOperatorCredentialAction,
  revokeOperatorCredentialAction,
  rotateOperatorCredentialAction,
} from "./actions.js";

/*
  Operator credentials (Plan 13, F.3): secrets a script, a CI job or the
  self-host CLI holds to act on /api/v1 with the live authority of the person
  who issued them. Its navigation entry, "Operator keys", is F.3.1's (ruling
  13), drawn whatever the switch says. While F3-14's answer is off — the
  migration not applied, the owner's switch not set, or /change-password still
  mounted — it draws the unavailable state and reads nothing else, because
  before the migration there is no table to read.
*/

const description =
  "Keys for scripts and CI jobs acting on the REST API with your authority, narrowed to the scopes and project you choose. Each expires within 90 days.";

function instant(value: Date) {
  return value.toISOString();
}

function credentialStatus(credential: {
  revokedAt: Date | null;
  expiresAt: Date;
  overlapExpiresAt: Date | null;
}) {
  if (credential.revokedAt)
    return { label: "Revoked", tone: "neutral" } as const;
  if (credential.expiresAt.getTime() <= Date.now())
    return { label: "Expired", tone: "neutral" } as const;
  if (credential.overlapExpiresAt)
    return { label: "Rotating", tone: "warn" } as const;
  return { label: "Active", tone: "ok" } as const;
}

export default async function OperatorCredentialsPage() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) {
    return <NoOrganizationSetup />;
  }
  const availability = await operatorCredentialAvailability();
  if (!availability.available) {
    return (
      <Page
        description={description}
        eyebrow="Settings"
        title="Operator credentials"
      >
        <SettingsSection
          headingId="operator-credentials-unavailable-heading"
          title="Unavailable in this deployment"
        >
          <EmptyState
            hint={operatorUnavailableMessages[availability.reason]}
            icon={ShieldOff}
            title="Operator credentials are off"
          />
        </SettingsSection>
      </Page>
    );
  }

  const userId = context.session.user.id;
  const storage = webStorage();
  const [credentials, projects] = await Promise.all([
    operatorCredentialService.list(
      humanCommandContext(context.session, organization.id),
      organization.id,
    ),
    createFoundationQueryRepository(storage.db).listOrganizationProjects(
      userId,
      organization.id,
    ),
  ]);
  const manager =
    organization.role === "owner" || organization.role === "admin";
  const visible = manager
    ? credentials
    : credentials.filter((credential) => credential.memberUserId === userId);
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );

  return (
    <Page
      description={description}
      eyebrow="Settings"
      title="Operator credentials"
      width="wide"
    >
      <SettingsSection
        headingId="operator-credentials-issue-heading"
        note="The key is shown once. A rotation keeps its scopes, project and expiry."
        title="Issue a credential"
      >
        <IssueOperatorCredentialForm
          action={issueOperatorCredentialAction}
          idempotencyKey={`web:operators:issue:${randomUUID()}`}
          projects={projects.map((project) => ({
            id: project.id,
            name: project.name,
          }))}
          scopes={operatorScopes}
        />
      </SettingsSection>
      <SettingsSection
        bleed
        headingId="operator-credentials-list-heading"
        note={
          manager
            ? "Every operator credential in this organization."
            : "The operator credentials you issued."
        }
        title="Credentials"
      >
        {visible.length ? (
          <TableScrollRegion aria-label="Operator credentials">
            <Table.Root>
              <Table.Caption>Operator credentials</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Name / key</Table.Head>
                  <Table.Head>Reach</Table.Head>
                  <Table.Head>Scopes</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Expires / last used</Table.Head>
                  <Table.Head>Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {visible.map((credential) => {
                  const status = credentialStatus(credential);
                  const live =
                    status.label !== "Revoked" && status.label !== "Expired";
                  return (
                    <Table.Row key={credential.id}>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <span>{credential.name}</span>
                          <code className="font-mono">{credential.prefix}</code>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        {credential.projectId
                          ? (projectNames.get(credential.projectId) ??
                            credential.projectId)
                          : "Organization"}
                      </Table.Cell>
                      <Table.Cell>
                        {credential.scopes.length
                          ? credential.scopes.join(", ")
                          : "None"}
                      </Table.Cell>
                      <Table.Cell>
                        <Chip tone={status.tone}>{status.label}</Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <Stack direction="column" gap={1}>
                          <span>{instant(credential.expiresAt)}</span>
                          <span className="text-fg-subtle">
                            {credential.lastUsedAt
                              ? instant(credential.lastUsedAt)
                              : "never used"}
                          </span>
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
                        {live ? (
                          <OperatorCredentialActions
                            credentialId={credential.id}
                            expectedVersion={credential.version}
                            mayRotate={credential.memberUserId === userId}
                            revokeAction={revokeOperatorCredentialAction}
                            revokeIdempotencyKey={`web:operators:revoke:${randomUUID()}`}
                            rotateAction={rotateOperatorCredentialAction}
                            rotateIdempotencyKey={`web:operators:rotate:${randomUUID()}`}
                          />
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <Stack direction="column" gap={3}>
            <EmptyState
              hint="A credential appears here once it is issued."
              icon={KeyRound}
              title="No operator credentials"
            />
          </Stack>
        )}
      </SettingsSection>
    </Page>
  );
}
