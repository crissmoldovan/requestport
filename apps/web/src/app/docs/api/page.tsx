import { TerminalFrame } from "@cueplusplus/ui/instruments";
import {
  Link as CueLink,
  DescriptionList,
  Stack,
} from "@cueplusplus/ui/layout";
import { serverEnv } from "@requestport/config/server";
import Link from "next/link";
import { Fragment } from "react";

import { Page, PageSection } from "../../../components/page-layout.js";
import { SettingsSection } from "../../../components/settings-section.js";
import {
  commandReference,
  errorReference,
  readDescriptions,
  readReference,
} from "./api-reference.js";

export const dynamic = "force-dynamic";

/**
 * The REST reference, on the console's own composition.
 *
 * The examples live in `TerminalFrame` rather than in a hand-styled `pre`: it
 * is the package's recessed code surface, it carries a copy affordance, and
 * the transcript is text, so it re-themes and scales with the type ramp
 * instead of freezing one appearance into the page. Nothing here prints a
 * credential — the header example shows the shape with an environment
 * reference in it.
 *
 * The paths, commands, scopes and error codes are read from the committed
 * OpenAPI document (see `api-reference.ts`), which is also served whole at
 * `/docs/api/openapi.json`. Only the one-line descriptions of the read paths
 * are written by hand, beside that reading.
 */
export default function ApiReferencePage() {
  const baseUrl = serverEnv.BETTER_AUTH_URL.replace(/\/$/u, "");
  const apiBase = `${baseUrl}/api/v1`;
  const commandRequest = [
    `POST ${apiBase}/commands/{command}`,
    "Content-Type: application/json",
    "",
    "{",
    '  "idempotencyKey": "stable-operation-key",',
    '  "expectedVersion": 0,',
    '  "input": {}',
    "}",
  ];
  return (
    <main>
      <Page
        description="Versioned agent API backed by the same command and authorization boundary as MCP."
        eyebrow="RequestPort reference"
        title="REST API"
        width="form"
      >
        <SettingsSection
          headingId="api-base-url-heading"
          note="Browser cookies are not accepted."
          title="Base URL"
        >
          <TerminalFrame
            copy
            copyValue={apiBase}
            lines={[apiBase]}
            title="Base"
          />
          <span>
            Send{" "}
            <code className="font-mono break-all">
              Authorization: Bearer $REQUESTPORT_API_KEY
            </code>{" "}
            on every request.
          </span>
        </SettingsSection>
        <SettingsSection
          headingId="api-commands-heading"
          note="Each command takes the same envelope. The scope listed is necessary, not sufficient."
          title="Commands"
        >
          <TerminalFrame
            copy
            copyValue={commandRequest.join("\n")}
            lines={commandRequest}
            title="Command request"
          />
          <DescriptionList.Root>
            {commandReference.map((command) => (
              <Fragment key={command.name}>
                <DescriptionList.Term>
                  <code className="font-mono break-all">{command.name}</code>
                </DescriptionList.Term>
                <DescriptionList.Detail>
                  {command.scopeByAction ? "By action: " : ""}
                  <code className="font-mono break-all">
                    {command.scopes.join(", ")}
                  </code>
                </DescriptionList.Detail>
              </Fragment>
            ))}
          </DescriptionList.Root>
        </SettingsSection>
        <SettingsSection
          headingId="api-resources-heading"
          note="List responses use opaque cursors."
          title="Read resources"
        >
          <DescriptionList.Root>
            {readReference.map((read) => (
              <Fragment key={read.path}>
                <DescriptionList.Term>
                  <code className="font-mono break-all">{read.path}</code>
                </DescriptionList.Term>
                <DescriptionList.Detail>
                  {readDescriptions[read.path] ?? ""}{" "}
                  {read.scopes.length > 0 ? (
                    <code className="font-mono break-all">
                      {read.scopes.join(", ")}
                    </code>
                  ) : (
                    "No scope."
                  )}
                  {read.queryParameters.length > 0 ? (
                    <>
                      {" Query: "}
                      <code className="font-mono break-all">
                        {read.queryParameters.join(", ")}
                      </code>
                    </>
                  ) : null}
                </DescriptionList.Detail>
              </Fragment>
            ))}
          </DescriptionList.Root>
        </SettingsSection>
        <SettingsSection
          headingId="api-errors-heading"
          note="Every error body is { error, message }, with details on most. Not every code is reachable from every operation."
          title="Errors"
        >
          <DescriptionList.Root>
            {errorReference.map((answer) => (
              <Fragment key={answer.status}>
                <DescriptionList.Term>
                  <code className="font-mono">{answer.status}</code>
                </DescriptionList.Term>
                <DescriptionList.Detail>
                  <code className="font-mono break-all">
                    {answer.codes.join(", ")}
                  </code>{" "}
                  {answer.description}
                </DescriptionList.Detail>
              </Fragment>
            ))}
          </DescriptionList.Root>
        </SettingsSection>
        <SettingsSection
          headingId="api-openapi-heading"
          note="Generated from the transport metadata in @requestport/domain. It gives no response schemas: none is recorded."
          title="OpenAPI"
        >
          <CueLink
            render={<a href="/docs/api/openapi.json" />}
            variant="underline"
          >
            OpenAPI 3.1 document
          </CueLink>
        </SettingsSection>
        <PageSection>
          <Stack align="center" direction="row" gap={3} wrap>
            <CueLink render={<Link href="/docs/mcp" />} variant="underline">
              MCP reference
            </CueLink>
            <CueLink render={<Link href="/sign-in" />} variant="underline">
              Sign in
            </CueLink>
          </Stack>
        </PageSection>
      </Page>
    </main>
  );
}
