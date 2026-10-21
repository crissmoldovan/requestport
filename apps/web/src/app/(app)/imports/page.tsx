import { randomUUID } from "node:crypto";
import { EmptyState } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import { createImportRepository } from "@requestport/db";
import { DomainError } from "@requestport/domain";
import { Archive, FileWarning, ShieldOff } from "lucide-react";
import type { ReactNode } from "react";

import {
  AnalyzeImportButton,
  ImportRunLink,
} from "../../../components/import-management.js";
import { Page } from "../../../components/page-layout.js";
import { SettingsSection } from "../../../components/settings-section.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";
import { analyzeImportAction } from "./actions.js";

export default async function ImportsPage() {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) return null;
  const storage = webStorage();
  const { canManage, captures, runs } = await storage.transaction(
    async (transaction) => {
      const repository = createImportRepository(transaction);
      try {
        await repository.requireManagerAccess(
          organization.id,
          context.session.user.id,
        );
      } catch (error) {
        if (error instanceof DomainError && error.code === "forbidden") {
          return { canManage: false, captures: [], runs: [] };
        }
        throw error;
      }
      // One after the other: both read on this one transaction, which runs
      // one query at a time (X24).
      const captures = await repository.listCaptures(organization.id);
      const runs = await repository.list(organization.id);
      return { canManage: true, captures, runs };
    },
  );
  // One padded measure column per page, so the two branches share the column
  // rather than each opening one of their own.
  const page = (children: ReactNode) => (
    <Page
      description="Preserve legacy FR exchanges byte-for-byte, analyze them deterministically, review every mapping, and apply only a frozen manifest."
      eyebrow="Migration"
      title="Legacy imports"
      width="wide"
    >
      {children}
    </Page>
  );
  if (!canManage) {
    return page(
      <SettingsSection headingId="import-runs-heading" title="Import runs">
        <EmptyState
          hint="Ask an organization owner or admin to analyze or apply a preserved snapshot."
          icon={ShieldOff}
          title="Legacy imports are owner and admin only"
        />
      </SettingsSection>,
    );
  }
  return page(
    <>
      <SettingsSection
        bleed={runs.length > 0}
        headingId="import-runs-heading"
        note={`${runs.length} analysis runs`}
        title="Import runs"
      >
        {runs.length ? (
          <TableScrollRegion aria-label="Legacy import runs">
            <Table.Root>
              <Table.Caption>Legacy import runs</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Started</Table.Head>
                  <Table.Head>Project</Table.Head>
                  <Table.Head>State</Table.Head>
                  <Table.Head>Parser</Table.Head>
                  <Table.Head>Manifest</Table.Head>
                  <Table.Head>Review</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {runs.map(({ run, source }) => (
                  <Table.Row key={run.id}>
                    <Table.Cell>
                      <span className="text-fg-subtle">
                        {run.startedAt.toISOString()}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <code className="font-mono">{source.projectId}</code>
                    </Table.Cell>
                    <Table.Cell>
                      <Chip tone="neutral">{run.state}</Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <code className="font-mono">{run.parserVersion}</code>
                    </Table.Cell>
                    <Table.Cell>
                      <code className="font-mono">
                        {run.manifestSha256?.slice(0, 12) ?? "—"}
                      </code>
                    </Table.Cell>
                    <Table.Cell>
                      <ImportRunLink id={run.id} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Capture legacy files with the RequestPort CLI, then analyze a preserved snapshot below."
            icon={Archive}
            title="No analysis runs"
          />
        )}
      </SettingsSection>
      <SettingsSection
        bleed={captures.length > 0}
        headingId="captured-snapshots-heading"
        note={`${captures.length} immutable source captures`}
        title="Captured snapshots"
      >
        {captures.length ? (
          <TableScrollRegion aria-label="Captured source snapshots">
            <Table.Root>
              <Table.Caption>Captured source snapshots</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Source</Table.Head>
                  <Table.Head>Captured</Table.Head>
                  <Table.Head>Manifest</Table.Head>
                  <Table.Head>Analysis</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {captures.map(({ source, snapshot }) => (
                  <Table.Row key={snapshot.id}>
                    <Table.Cell>
                      <span>{source.repositoryUrl ?? source.projectId}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <Stack direction="column" gap={1}>
                        <span className="text-fg-subtle">
                          {snapshot.capturedAt.toISOString()}
                        </span>
                        <span className="text-fg-subtle">
                          {snapshot.status} ·{" "}
                          {snapshot.dirty ? "dirty worktree" : "clean commit"}
                        </span>
                      </Stack>
                    </Table.Cell>
                    <Table.Cell>
                      <code className="font-mono">
                        {snapshot.manifestSha256}
                      </code>
                    </Table.Cell>
                    <Table.Cell>
                      {snapshot.status === "captured" ||
                      snapshot.status === "analyzed" ? (
                        <AnalyzeImportButton
                          action={analyzeImportAction}
                          idempotencyKey={`web:import:analyze:${randomUUID()}`}
                          snapshotId={snapshot.id}
                          sourceId={source.id}
                        />
                      ) : (
                        <Chip tone="danger">Security review required</Chip>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : (
          <EmptyState
            hint="Run the RequestPort import-capture command from a registered project repository."
            icon={FileWarning}
            title="No captured snapshots"
          />
        )}
      </SettingsSection>
    </>,
  );
}
