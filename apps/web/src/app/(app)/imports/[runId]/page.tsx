import { randomUUID } from "node:crypto";
import path from "node:path";

import { Row } from "@cueplusplus/ui/chrome";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { DescriptionList, Grid, Stack } from "@cueplusplus/ui/layout";
import { Chip } from "@cueplusplus/ui/primitives";
import {
  createFoundationQueryRepository,
  createImportRepository,
} from "@requestport/db";
import { notFound } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { z } from "zod";

import {
  ApplyImportForm,
  CorrectImportButton,
  FreezeImportButton,
  ImportEntryReviewForm,
  SplitImportBundleForm,
} from "../../../../components/import-management.js";
import { Page } from "../../../../components/page-layout.js";
import { SettingsSection } from "../../../../components/settings-section.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import {
  applyImportAction,
  correctImportAction,
  freezeImportAction,
  reviewImportEntryAction,
  splitImportEntryAction,
} from "../actions.js";

function displayPreservedText(value: string) {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (character === "\n" || character === "\t") return character;
      if (
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      ) {
        return `\\u{${code.toString(16).padStart(4, "0")}}`;
      }
      return character;
    })
    .join("");
}

/**
 * One preserved or proposed document, shown verbatim.
 *
 * The bytes go into a `pre` because that is the only element that keeps them:
 * every line break, run of spaces and escaped control character is part of what
 * the reviewer is being asked to judge. Only the ink and the overflow are
 * token-backed; nothing here reformats a record.
 */
function PreservedText({ children }: { children: string }) {
  return <pre className="overflow-x-auto font-mono">{children}</pre>;
}

/** One side of the comparison: a heading and the documents under it. */
function ComparePane({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <section aria-label={label}>
      <Stack direction="column" gap={2}>
        <h3 className="font-mono text-fg-subtle">{label}</h3>
        {children}
      </Stack>
    </section>
  );
}

export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = z.object({ runId: z.uuid() }).parse(await params);
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) notFound();
  const storage = webStorage();
  const authorizedDetail = await storage.transaction(async (transaction) => {
    const repository = createImportRepository(transaction);
    await repository.requireManagerAccess(
      organization.id,
      context.session.user.id,
    );
    return repository.detail(organization.id, runId);
  });
  const [detail, projects] = await Promise.all([
    Promise.resolve(authorizedDetail),
    createFoundationQueryRepository(storage.db).listOrganizationProjects(
      context.session.user.id,
      organization.id,
    ),
  ]);
  if (!detail) notFound();
  const correction = detail.run.parserVersion.endsWith(":correction");
  const dryRun = detail.entries.reduce(
    (counts, { entry }) => {
      if (entry.decision === "create") counts.create += 1;
      else if (entry.decision === "message") counts.message += 1;
      else if (entry.decision === "map_existing") counts.update += 1;
      else if (entry.decision === "skip") counts.skip += 1;
      else counts.unresolved += 1;
      if (
        !correction &&
        (entry.decision === "create" || entry.decision === "map_existing") &&
        typeof entry.parsedJson.legacyKey === "object" &&
        entry.parsedJson.legacyKey
      )
        counts.alias += 1;
      if (
        (entry.decision === "create" || entry.decision === "map_existing") &&
        Array.isArray(entry.parsedJson.reviewedRelationships)
      )
        counts.relation += entry.parsedJson.reviewedRelationships.length;
      return counts;
    },
    {
      create: 0,
      update: 0,
      message: 0,
      relation: 0,
      alias: 0,
      skip: 0,
      unresolved: 0,
    },
  );
  const uniqueArtifacts = [
    ...new Map(
      detail.entries.map(({ artifact }) => [artifact.id, artifact]),
    ).values(),
  ];
  const artifactsByBasename = new Map<string, typeof uniqueArtifacts>();
  for (const artifact of uniqueArtifacts) {
    const basename = path.posix
      .basename(artifact.relativePath)
      .toLocaleLowerCase("en-US");
    artifactsByBasename.set(basename, [
      ...(artifactsByBasename.get(basename) ?? []),
      artifact,
    ]);
  }
  const divergentGroups = [...artifactsByBasename].filter(
    ([, artifacts]) =>
      artifacts.length > 1 &&
      new Set(artifacts.map((artifact) => artifact.sha256)).size > 1,
  );
  const identity = [
    ["State", detail.run.state],
    ["Parser", detail.run.parserVersion],
    ["Source manifest", detail.snapshot.manifestSha256],
    ["Approved manifest", detail.run.manifestSha256 ?? "Not approved"],
  ] as const;
  const mapped = detail.entries.filter(
    ({ entry }) =>
      entry.proposedCanonicalId ||
      typeof entry.parsedJson.targetProjectId === "string",
  );
  const summary = [
    ...Object.entries(dryRun),
    ["artifact", uniqueArtifacts.length],
    ["conflicts", detail.conflicts.length],
    [
      "open blockers",
      detail.conflicts.filter(
        (item) => item.severity === "blocking" && !item.resolvedAt,
      ).length,
    ],
  ] as const;
  return (
    <Page
      description="Compare the preserved source with the proposed canonical record. Nothing is applied until every decision is reviewed and the immutable manifest hash is confirmed."
      eyebrow="Legacy import"
      title={`Review ${detail.run.id.slice(0, 8)}`}
      width="wide"
    >
      <SettingsSection
        bleed
        headingId="import-summary-heading"
        note={`${detail.entries.length} proposed records · ${detail.conflicts.length} findings`}
        title="Snapshot and state"
      >
        <Row>
          <DescriptionList.Root>
            {identity.map(([label, value]) => (
              <Fragment key={label}>
                <DescriptionList.Term>{label}</DescriptionList.Term>
                <DescriptionList.Detail>
                  <code className="font-mono break-all">{value}</code>
                </DescriptionList.Detail>
              </Fragment>
            ))}
          </DescriptionList.Root>
        </Row>
        {mapped.length ? (
          <TableScrollRegion aria-label="Proposed record mappings">
            <Table.Root>
              <Table.Caption>Proposed record mappings</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Record</Table.Head>
                  <Table.Head>Decision</Table.Head>
                  <Table.Head>Identifier</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {mapped.map(({ entry, artifact }) => (
                  <Table.Row key={entry.id}>
                    <Table.Cell>
                      <span>
                        {artifact.relativePath} · record {entry.recordIndex}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      {entry.decision.replaceAll("_", " ")}
                    </Table.Cell>
                    <Table.Cell>
                      <code className="font-mono">
                        {entry.proposedCanonicalId ??
                          String(entry.parsedJson.targetProjectId)}
                      </code>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableScrollRegion>
        ) : null}
      </SettingsSection>
      <SettingsSection
        headingId="import-dry-run-heading"
        note="Exact projected mutations from the current review decisions. Source artifacts are already preserved and remain immutable."
        title="Dry-run summary"
      >
        <DescriptionList.Root>
          {summary.map(([label, count]) => (
            <Fragment key={label}>
              <DescriptionList.Term>{label}</DescriptionList.Term>
              <DescriptionList.Detail>{count}</DescriptionList.Detail>
            </Fragment>
          ))}
        </DescriptionList.Root>
      </SettingsSection>
      {divergentGroups.length > 0 ? (
        <SettingsSection
          bleed
          headingId="import-divergent-heading"
          note="Same-basename files are intentionally kept separate. Compare their exact preserved text before choosing create, map, or skip."
          title="Divergent copies"
        >
          {divergentGroups.map(([basename, artifacts]) => (
            <Row key={basename}>
              <Stack direction="column" gap={3}>
                <Stack align="center" direction="row" gap={3} wrap>
                  <span className="break-all">{basename}</span>
                  <Chip tone="danger">Review required</Chip>
                </Stack>
                {/* The package's own auto-filling measure: two copies sit side
                    by side where there is room and stack where there is not. */}
                <Grid gap={4} minItemWidth="22rem">
                  {artifacts.map((artifact) => (
                    <ComparePane
                      key={artifact.id}
                      label={`Preserved copy ${artifact.relativePath}`}
                    >
                      <span className="text-fg-subtle break-all">
                        SHA-256 {artifact.sha256}
                      </span>
                      <PreservedText>
                        {displayPreservedText(
                          new TextDecoder().decode(artifact.exactBytes),
                        )}
                      </PreservedText>
                    </ComparePane>
                  ))}
                </Grid>
              </Stack>
            </Row>
          ))}
        </SettingsSection>
      ) : null}
      <SettingsSection
        bleed
        headingId="import-entries-heading"
        note="Exact source bytes are shown without interpretation beside the parser proposal."
        title="Manifest entries"
      >
        {detail.entries.map(({ entry, artifact }) => {
          const source = new TextDecoder().decode(artifact.exactBytes);
          const relatedConflicts = detail.conflicts.filter(
            (conflict) => conflict.entryId === entry.id,
          );
          const blocking = relatedConflicts.some(
            (conflict) =>
              conflict.severity === "blocking" && !conflict.resolvedAt,
          );
          return (
            <Row key={entry.id}>
              <Stack direction="column" gap={3}>
                <Stack align="baseline" direction="row" gap={3} wrap>
                  <span className="break-all">{artifact.relativePath}</span>
                  {relatedConflicts.length ? (
                    <Chip tone={blocking ? "danger" : "neutral"}>
                      {relatedConflicts.length} findings
                    </Chip>
                  ) : null}
                </Stack>
                <span className="text-fg-subtle break-all">
                  Record {entry.recordIndex} · proposed {entry.proposedKind} ·
                  decision {entry.decision}
                </span>
                <span className="text-fg-subtle break-all">
                  SHA-256 {artifact.sha256} · {artifact.byteSize} bytes · scan{" "}
                  {artifact.secretScanStatus}
                </span>
                <Grid gap={4} minItemWidth="22rem">
                  <ComparePane label="Preserved source">
                    <PreservedText>
                      {displayPreservedText(source)}
                    </PreservedText>
                  </ComparePane>
                  <ComparePane label="Parser proposal">
                    <PreservedText>
                      {displayPreservedText(
                        JSON.stringify(entry.parsedJson, null, 2),
                      )}
                    </PreservedText>
                    <h3 className="font-mono text-fg-subtle">
                      Confidence evidence
                    </h3>
                    <PreservedText>
                      {displayPreservedText(
                        JSON.stringify(entry.confidenceJson, null, 2),
                      )}
                    </PreservedText>
                    {relatedConflicts.length ? (
                      <>
                        <h3 className="font-mono text-fg-subtle">
                          Conflict evidence
                        </h3>
                        <PreservedText>
                          {displayPreservedText(
                            JSON.stringify(
                              relatedConflicts.map((conflict) => ({
                                kind: conflict.kind,
                                severity: conflict.severity,
                                details: conflict.details,
                                resolvedAt: conflict.resolvedAt,
                              })),
                              null,
                              2,
                            ),
                          )}
                        </PreservedText>
                      </>
                    ) : null}
                  </ComparePane>
                </Grid>
                {detail.run.state === "reviewing" ? (
                  <>
                    <ImportEntryReviewForm
                      action={reviewImportEntryAction}
                      correction={correction}
                      entry={entry}
                      idempotencyKey={`web:import:review:${randomUUID()}`}
                      projects={projects}
                      runId={runId}
                    />
                    {(entry.decision === "pending" ||
                      entry.decision === "blocked") &&
                    source.includes("\n") ? (
                      <SplitImportBundleForm
                        action={splitImportEntryAction}
                        entryId={entry.id}
                        expectedVersion={entry.version}
                        idempotencyKey={`web:import:split:${randomUUID()}`}
                        runId={runId}
                      />
                    ) : null}
                  </>
                ) : null}
              </Stack>
            </Row>
          );
        })}
      </SettingsSection>
      {detail.run.state === "reviewing" ? (
        <SettingsSection
          headingId="approve-import-heading"
          note="Every entry needs a non-blocking decision and every blocking conflict must be resolved."
          title="Approve reviewed manifest"
        >
          <FreezeImportButton
            action={freezeImportAction}
            expectedVersion={detail.run.version}
            idempotencyKey={`web:import:freeze:${randomUUID()}`}
            runId={runId}
          />
        </SettingsSection>
      ) : null}
      {detail.run.state === "approved" && detail.run.manifestSha256 ? (
        <SettingsSection
          headingId="apply-import-heading"
          note={
            <code className="font-mono break-all">
              {detail.run.manifestSha256}
            </code>
          }
          title="Apply immutable manifest"
        >
          <ApplyImportForm
            action={applyImportAction}
            expectedVersion={detail.run.version}
            idempotencyKey={`web:import:apply:${randomUUID()}`}
            manifestSha256={detail.run.manifestSha256}
            runId={runId}
          />
        </SettingsSection>
      ) : null}
      {detail.report ? (
        <SettingsSection
          headingId="import-report-heading"
          note={`Completed ${detail.report.createdAt.toISOString()}`}
          title="Apply report"
        >
          <PreservedText>
            {JSON.stringify(
              {
                counts: detail.report.counts,
                warnings: detail.report.warnings,
                manifestSha256: detail.report.manifestSha256,
              },
              null,
              2,
            )}
          </PreservedText>
        </SettingsSection>
      ) : null}
      {detail.run.state === "applied" ? (
        <SettingsSection
          headingId="import-correction-heading"
          note="Preserve this applied run and begin a new review against the same immutable source snapshot."
          title="Compensating correction"
        >
          <CorrectImportButton
            action={correctImportAction}
            expectedVersion={detail.run.version}
            idempotencyKey={`web:import:correct:${randomUUID()}`}
            runId={runId}
          />
        </SettingsSection>
      ) : null}
    </Page>
  );
}
