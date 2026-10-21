import { EmptyState, Panel, PanelHeader } from "@cueplusplus/ui/chrome";
import { Field, FieldLabel, Input } from "@cueplusplus/ui/forms";
import { Table, TableScrollRegion } from "@cueplusplus/ui/instruments";
import { Link as CueLink, Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { createSearchRepository } from "@requestport/db";
import { SearchX } from "lucide-react";
import Link from "next/link";

import { Page, PageSection } from "../../../components/page-layout.js";
import { sectionHeadingClasses } from "../../../components/section-heading.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { webStorage } from "../../../lib/server-request-port.js";

/**
 * The type CUE++ gives a `PanelHeader`'s own title, spelled in its tokens.
 *
 * The heading goes in the header's leading cluster rather than its `title`
 * slot: that slot is a `<span>`, and a section of a document needs a real
 * `<h2>` a screen-reader user can jump between.
 */

function readQuery(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const [params, application] = await Promise.all([
    searchParams,
    getApplicationContext(),
  ]);
  const organization = application.currentOrganization;
  const q = readQuery(params.q);
  const storage = webStorage();
  const results = organization
    ? await createSearchRepository(storage.db).search(
        application.session.user.id,
        organization.id,
        q,
      )
    : { query: q, projects: [], requests: [] };
  const hasQuery = results.query.length >= 2;
  const total = results.projects.length + results.requests.length;
  return (
    <Page
      description="Search request titles, descriptions, keys, and project identities in the active organization."
      eyebrow="Workspace"
      title="Search"
      width="wide"
    >
      <PageSection labelledBy="search-heading">
        <Stack direction="column" gap={4}>
          <search>
            <form action="/search" method="get">
              <Stack align="end" direction="row" gap={2} wrap>
                <Field name="q">
                  <FieldLabel>Search this organization</FieldLabel>
                  <Input
                    defaultValue={q}
                    maxLength={200}
                    name="q"
                    placeholder="Request key, title, text, or project…"
                    required
                    size="sm"
                  />
                </Field>
                <Button size="sm" type="submit" variant="primary">
                  Search
                </Button>
              </Stack>
            </form>
          </search>
          <Panel>
            <PanelHeader>
              <h2 className={sectionHeadingClasses} id="search-heading">
                Results
              </h2>
              <span className="text-fg-subtle">
                {hasQuery
                  ? `${total} result${total === 1 ? "" : "s"} for “${results.query}”`
                  : "Enter at least two characters."}
              </span>
            </PanelHeader>
            {!hasQuery ? null : total === 0 ? (
              <EmptyState
                hint="Try a request key, project alias, or a less specific phrase."
                icon={SearchX}
                title="No matching records"
              />
            ) : (
              <Stack direction="column" gap={4}>
                {results.requests.length ? (
                  <TableScrollRegion aria-label="Matching requests">
                    <Table.Root>
                      <Table.Caption>Matching requests</Table.Caption>
                      <Table.Header>
                        <Table.Row>
                          <Table.Head>Request</Table.Head>
                          <Table.Head>Project</Table.Head>
                          <Table.Head>State</Table.Head>
                          <Table.Head>Priority</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {results.requests.map((request) => (
                          <Table.Row key={request.id}>
                            <Table.Cell>
                              <CueLink
                                render={
                                  <Link href={`/requests/${request.id}`} />
                                }
                                variant="underline"
                              >
                                <span className="font-mono">
                                  {request.displayKey ?? "Draft"}
                                </span>{" "}
                                · {request.title}
                              </CueLink>
                            </Table.Cell>
                            <Table.Cell>{request.targetProjectName}</Table.Cell>
                            <Table.Cell>
                              <Chip tone="neutral">{request.state}</Chip>
                            </Table.Cell>
                            <Table.Cell>{request.priority}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  </TableScrollRegion>
                ) : null}
                {results.projects.length ? (
                  <TableScrollRegion aria-label="Matching projects">
                    <Table.Root>
                      <Table.Caption>Matching projects</Table.Caption>
                      <Table.Header>
                        <Table.Row>
                          <Table.Head>Project</Table.Head>
                          <Table.Head>Key</Table.Head>
                          <Table.Head>Status</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {results.projects.map((project) => (
                          <Table.Row key={project.id}>
                            <Table.Cell>
                              <CueLink
                                render={
                                  <Link
                                    href={`/settings/projects/${project.id}`}
                                  />
                                }
                                variant="underline"
                              >
                                {project.name}
                              </CueLink>{" "}
                              <span className="text-fg-subtle">
                                {project.slug}
                              </span>
                            </Table.Cell>
                            <Table.Cell>
                              <span className="font-mono">
                                {project.keyPrefix}
                              </span>
                            </Table.Cell>
                            <Table.Cell>
                              <Chip
                                tone={
                                  project.status === "active" ? "ok" : "neutral"
                                }
                              >
                                {project.status}
                              </Chip>
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  </TableScrollRegion>
                ) : null}
              </Stack>
            )}
          </Panel>
        </Stack>
      </PageSection>
    </Page>
  );
}
