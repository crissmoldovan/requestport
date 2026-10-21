import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";
import { testPool } from "@requestport/db/testing";
import {
  authorizeUrl,
  CONSENT_ORIGIN,
  consentGateState,
  mcpResource,
  redeemAccessToken,
  registerClient,
} from "../fixtures/agent-consent.js";
import {
  bootstrapOwner,
  cleanupFoundationScenario,
  clearMagicLinkOutbox,
  createFoundationScenario,
  fixtureStorage,
  signInWithMagicLink,
} from "../fixtures/auth.js";
import { test } from "../fixtures/engine.ts";
import { callTool, initializeMcp } from "../fixtures/mcp-client.js";
import { serverAnswerTimeoutMs } from "../fixtures/server-answer-budget.ts";
import { chooseOption, onScreen } from "../fixtures/shell.js";

/**
 * The composition, which is the only thing here that is not already covered.
 *
 * Consent is covered by `agent-consent.spec.ts`; provisioning-tool gating by
 * `packages/mcp/src/server.test.ts`; bearer authentication by
 * `packages/auth/src/agent/authenticate-bearer.test.ts`. What no test performs
 * is the chain those pieces exist to make possible:
 *
 *   consent -> create_project -> provision_agent -> spend THAT minted key
 *           -> file a request -> a human answers it -> the agent reads the answer
 *
 * Two joints in that chain would fail silently in production, and both are
 * asserted below rather than assumed:
 *
 *  - `provision_agent` returns a credential. Returning one and issuing one that
 *    authenticates are different claims, and only the second matters. The
 *    journey reconnects with the minted key and spends it.
 *  - a human's transition and comment must reach the agent's timeline. A test
 *    that checks only the state would pass with message propagation entirely
 *    broken, so the comment carries a marker that the timeline must contain.
 *
 * `project:provision` is organization-wide and exclusive — a grant carrying it
 * may carry no other scope — and `provision_agent` refuses to mint it. So one
 * credential cannot do this journey, and the handoff between two is the point.
 */
const ORIGIN = CONSENT_ORIGIN;
const CLIENT_NAME = "Agent journey";

/**
 * The scopes the provisioned credential carries, and no more.
 *
 * `create_request_draft` and `submit_request` require `request:create`;
 * `get_request` and `get_request_timeline` require `request:read`. Nothing
 * here needs anything else, and `request:triage` is withheld deliberately:
 * the human performs the transition, which is what makes this a crossing
 * between two principals rather than an agent talking to itself.
 */
const WORKING_SCOPES = ["request:create", "request:read"] as const;

/**
 * Removes what this journey creates and the shared teardown does not know
 * about, in reference order.
 *
 * The shared fixture predates agents: it cannot delete a user who created a
 * principal, and it has never seen a dynamically registered OAuth client.
 * Requests, messages and transitions are deliberately *not* deleted — their
 * rows are append-only or polymorphically owned, and isolation here is logical:
 * every run has its own organization, every product query is organization
 * scoped, and the organization is archived below.
 */
async function removeAgentArtifacts(ownerEmail: string) {
  const ownerSelect = `SELECT "id" FROM "user" WHERE lower("email") = lower($1)`;
  for (const statement of [
    `DELETE FROM "agent_credentials"
       WHERE "agent_principal_id" IN (
         SELECT "id" FROM "agent_principals"
          WHERE "created_by_user_id" IN (${ownerSelect}))`,
    `DELETE FROM "agent_oauth_grants" WHERE "user_id" IN (${ownerSelect})`,
    `DELETE FROM "agent_principals" WHERE "created_by_user_id" IN (${ownerSelect})`,
  ]) {
    await testPool(fixtureStorage())
      .query(statement, [ownerEmail])
      .catch(() => undefined);
  }
  await testPool(fixtureStorage())
    .query('DELETE FROM "oauth_client" WHERE "name" = $1', [CLIENT_NAME])
    .catch(() => undefined);
}

test.describe("agent journey", () => {
  test("carries a request from an agent to a human and back", async ({
    page,
    request,
  }) => {
    /*
      This case's own budget, because the suite's is 120s and this is the
      longest journey in it: a consent round trip, a magic-link poll, six MCP
      calls and four page loads, each of which round-trips to the database.
      Measured at 45.4s on the machine this was written on, against a suite
      default of 120s. The ceiling below is deliberately well above the
      measurement rather than tuned to it: this journey round-trips to a
      database on every step, and a slower machine should report what actually
      failed rather than a timeout.
    */
    test.setTimeout(240_000);

    const scenario = createFoundationScenario("journey");
    const marker = `journey-marker-${randomUUID().slice(0, 8)}`;
    const requestTitle = `${scenario.projectName} needs a dark mode`;
    const requestBody =
      "Filed over MCP by an agent, to be answered by a human in the web UI.";

    // Stand in for the agent's loopback receiver, so the redirect's address
    // survives arrival instead of being replaced by Chrome's error page.
    await page.route("http://127.0.0.1:41999/**", async (route) => {
      await route.fulfill({
        body: "callback received",
        contentType: "text/plain",
        status: 200,
      });
    });

    await clearMagicLinkOutbox(request);

    // Stage one only. What this call is needed for here is the signup
    // allowlist entry — without it the owner cannot sign in at all. The
    // membership that consent requires comes from creating an organization as
    // a signed-in user, below, which is what `agent-consent.spec.ts` relies on.
    await bootstrapOwner(scenario);

    let accessToken = "";
    let projectId = "";
    let requestId = "";
    let workingKey = "";

    try {
      await test.step("the owner signs in", async () => {
        await signInWithMagicLink(page, request, scenario.ownerEmail);
      });

      await test.step("the owner creates the organization", async () => {
        await expect(
          page.getByRole("heading", { name: "Create your first organization" }),
        ).toBeVisible();
        await onScreen(page.getByLabel("Organization name")).fill(
          scenario.uiOrganizationName,
        );
        await onScreen(page.getByLabel("Organization slug")).fill(
          scenario.uiOrganizationSlug,
        );
        await page.getByRole("button", { name: "Create organization" }).click();
        await expect(
          page.getByRole("heading", { name: "Overview" }),
        ).toBeVisible();
      });

      const clientId =
        await test.step("the agent registers and is granted consent", async () => {
          const registered = await registerClient(ORIGIN, CLIENT_NAME);
          await page.goto(authorizeUrl(ORIGIN, registered));

          const allow = page.getByRole("button", { name: "Allow connection" });
          await expect(
            allow,
            `consent screen did not render.\n` +
              `landed on: ${new URL(page.url()).pathname}\n` +
              `${await consentGateState(registered, scenario.ownerEmail)}`,
          ).toBeVisible();

          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/oauth/agent-consent",
              { timeout: serverAnswerTimeoutMs },
            ),
            allow.click(),
          ]);
          await page
            .waitForURL(/127\.0\.0\.1:41999/u, {
              timeout: serverAnswerTimeoutMs,
            })
            .catch(() => undefined);

          const landed = new URL(page.url());
          expect(
            landed.searchParams.get("code"),
            "an approved consent must issue an authorization code",
          ).toBeTruthy();
          accessToken = await redeemAccessToken(
            ORIGIN,
            registered,
            landed.searchParams.get("code") ?? "",
          );
          return registered;
        });
      expect(clientId, "a client must have been registered").toBeTruthy();

      const resource = mcpResource(ORIGIN);

      await test.step("the provisioning credential opens an MCP session", async () => {
        await initializeMcp(resource, accessToken, "agent-journey");
      });

      await test.step("the agent creates a project", async () => {
        const created = await callTool(
          resource,
          accessToken,
          "create_project",
          {
            correlationId: randomUUID(),
            keyPrefix: scenario.projectKey,
            name: scenario.projectName,
            slug: scenario.projectSlug,
          },
        );
        projectId = String(
          (created.project as { id?: unknown } | undefined)?.id ?? "",
        );
        expect(
          projectId,
          `create_project returned no project id: ${JSON.stringify(created).slice(0, 200)}`,
        ).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        );
      });

      await test.step("the agent provisions a working credential", async () => {
        const provisioned = await callTool(
          resource,
          accessToken,
          "provision_agent",
          {
            displayName: `${scenario.projectName} worker`,
            idempotencyKey: randomUUID(),
            projectId,
            scopes: [...WORKING_SCOPES],
            slug: `${scenario.projectSlug}-worker`,
          },
        );
        workingKey = String(provisioned.plaintextKey ?? "");
        expect(
          workingKey.length,
          "provision_agent must reveal a plaintext credential exactly once",
        ).toBeGreaterThan(16);
      });

      /*
        The joint that nothing else in this repository tests.

        A credential that is returned and a credential that authenticates are
        different claims. Everything below runs on the minted key rather than
        the provisioning token, so the rest of the journey is itself the proof
        that the handoff works — and the assertion here is that the key opens a
        session at all, which is the narrowest way to fail fast when it does not.
      */
      await test.step("the minted credential is spent, not merely received", async () => {
        expect(
          workingKey,
          "the working key must differ from the provisioning token",
        ).not.toBe(accessToken);
        await initializeMcp(resource, workingKey, "agent-journey-worker");
      });

      await test.step("the agent files a feature request", async () => {
        const draft = await callTool(
          resource,
          workingKey,
          "create_request_draft",
          {
            descriptionMd: requestBody,
            expectedVersion: 0,
            idempotencyKey: randomUUID(),
            targetProjectId: projectId,
            title: requestTitle,
            type: "feature",
          },
        );
        const drafted = draft.result as
          | { id?: unknown; version?: unknown }
          | undefined;
        requestId = String(drafted?.id ?? "");
        expect(
          requestId,
          `create_request_draft returned no id: ${JSON.stringify(draft).slice(0, 200)}`,
        ).toBeTruthy();

        await callTool(resource, workingKey, "submit_request", {
          expectedVersion: Number(drafted?.version ?? 0),
          idempotencyKey: randomUUID(),
          requestId,
        });
      });

      await test.step("the human sees the request in the web UI", async () => {
        await page.goto("/requests");
        await expect(
          onScreen(page.getByText(requestTitle, { exact: false })),
          "a request filed over MCP must be visible to its organization",
        ).toBeVisible();
      });

      await test.step("the human triages it and answers", async () => {
        await page.goto(`/requests/${requestId}`);
        await chooseOption(page, "Transition", "Begin triage");
        await page.getByRole("button", { name: "Apply" }).click();

        // The comment carries a marker the timeline assertion looks for. A
        // transition-only assertion would pass with message propagation
        // entirely broken, which is half of what this journey exists to catch.
        // By role and exactly, because the composer sits beside a "Comment
        // visibility" select and `getByLabel` matches on substring: asking for
        // "Comment" resolves to the textarea and to that combobox.
        await page
          .getByRole("textbox", { exact: true, name: "Comment" })
          .fill(marker);
        await page.getByRole("button", { name: "Post comment" }).click();
        await expect(page.getByText(marker, { exact: false })).toBeVisible();
      });

      await test.step("the agent reads the human's answer", async () => {
        const read = await callTool(resource, workingKey, "get_request", {
          requestId,
        });
        expect(
          read.title,
          "the agent must read back the request it filed",
        ).toBe(requestTitle);
        expect(
          read.state,
          `the human's transition did not reach the agent: ${JSON.stringify(read).slice(0, 200)}`,
        ).toBe("triage");

        /*
          The reply itself, read back by the agent.

          Two surfaces carry it, and they carry different things.
          `get_request_timeline` reads `domain_events`, and
          `message.posted.v1` records a message id and its visibility but
          deliberately not the body — an event stream is not where data
          belongs. `get_request` is the one that returns the conversation, so
          that is where the text is asserted.

          This assertion was briefly weakened to the event type alone, on the
          claim that the product had no way for an agent to read a message at
          all. That was wrong: `getRequest` selects `bodyMd` and always has.
          The claim was written into the plan and into a merged pull request
          before anyone checked the query.
        */
        const timeline = await callTool(
          resource,
          workingKey,
          "get_request_timeline",
          { requestId },
        );
        expect(
          JSON.stringify(timeline),
          "the human's comment did not reach the agent's timeline",
        ).toContain("message.posted.v1");

        expect(
          JSON.stringify(read.messages ?? []),
          "the human's comment body did not reach the agent",
        ).toContain(marker);
      });
    } finally {
      // Cleanup must never replace the verdict.
      await removeAgentArtifacts(scenario.ownerEmail);
      await cleanupFoundationScenario(scenario).catch((error: unknown) => {
        console.error(`cleanup did not complete: ${String(error)}`);
      });
    }
  });
});
