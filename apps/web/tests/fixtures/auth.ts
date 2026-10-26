import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { E2E_TOKEN_HEADER } from "@requestport/auth/e2e";
import { createStorage, type Storage } from "@requestport/db";
import { testPool } from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";

import {
  fixedE2EFailureMessages,
  withFixedE2EFailure,
} from "./fixed-failure.js";
import { runOwnerBootstrap } from "./owner-bootstrap.js";
import { acquireMagicLink, askThroughRestarts } from "./scenario-navigation.js";
import { onScreen } from "./shell.js";

let fixtureStorageHeld: Storage | undefined;

/**
 * The storage this Playwright process reads and tidies the database through:
 * built on first use from this process's environment
 * (`storageOptionsFromEnv`), with no role guard, and kept for the process.
 * It connects through `DATABASE_URL`, the owner, whatever the application
 * variable names (`storageOptionsFromEnv` reads the owner's URL; Plan 13,
 * I.2 step 5, slice 1). The acceptance login is the server's alone
 * (`scripts/start-e2e-server.mjs` hands it to `next start`). Nothing closes
 * it: the process's end does.
 *
 * It applies no local proxy. Importing `@requestport/db` applies none since
 * Plan 13's G.5, and no subpath this process imports exports
 * `applyLocalProxy` (`packages/db/src/hosted-driver.ts`), so on the hosted
 * driver it dials the host its URL names even where the driver's proxy
 * variable names a proxy. The gate runs these lanes on pg
 * (`scripts/verify-locally.mjs`).
 */
export function fixtureStorage(): Storage {
  fixtureStorageHeld ??= createStorage(storageOptionsFromEnv(process.env));
  return fixtureStorageHeld;
}

export type FoundationScenario = Readonly<{
  bootstrapOrganizationName: string;
  bootstrapOrganizationSlug: string;
  bootstrapOrganizationTheme: string;
  invalidProjectKey: string;
  memberEmail: string;
  ownerEmail: string;
  projectKey: string;
  projectName: string;
  projectSlug: string;
  repositorySlug: string;
  repositoryUrl: string;
  uiOrganizationName: string;
  uiOrganizationSlug: string;
}>;

/**
 * The two tenants' appearance defaults, and why they differ.
 *
 * A tenant switch must be resolved by the *server*, on a new document, before
 * anything paints — and the only way a journey can tell that apart from a
 * client transition is to watch the outgoing document for a restamp. Two
 * organizations seeded with the same triple make that unobservable: a client
 * transition would adopt values identical to the ones already on `<html>`, and
 * a guard watching for a change would report none whether the contract held or
 * not. So the bootstrap tenant is given a default of its own, the seeded
 * `cue` (the owner-activation trigger's seed since `0026`) is left on the
 * tenant the journey creates through the UI, and the switch has a visible
 * consequence in whichever document performs it.
 */
const seededOrganizationTheme = "cue";
const bootstrapOrganizationTheme = "terminal";

function e2eToken() {
  const token = process.env.REQUESTPORT_E2E_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("Foundation E2E token is unavailable");
  }
  return token;
}

export function createFoundationScenario(label: string): FoundationScenario {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const prefix = id.slice(0, 6).toUpperCase();
  const projectSlug = `${label}-project-${id}`;
  const repositorySlug = `example-org/${projectSlug}`;

  return {
    bootstrapOrganizationName: `${label} Bootstrap ${id}`,
    bootstrapOrganizationSlug: `${label}-bootstrap-${id}`,
    bootstrapOrganizationTheme,
    invalidProjectKey: `X${prefix}`,
    memberEmail: `${label}-member-${id}@example.invalid`,
    ownerEmail: `${label}-owner-${id}@example.invalid`,
    projectKey: `R${prefix}`,
    projectName: `${label} Project ${id}`,
    projectSlug,
    repositorySlug,
    repositoryUrl: `https://github.com/${repositorySlug}`,
    uiOrganizationName: `${label} Workspace ${id}`,
    uiOrganizationSlug: `${label}-workspace-${id}`,
  };
}

/**
 * The appearance theme the server will resolve for a tenant, or `null` before
 * `0014`'s trigger has seeded one.
 *
 * Read from the same row the application reads, so the journey asserts what the
 * database can serve rather than what the fixture hoped to write.
 */
async function readOrganizationTheme(slug: string): Promise<string | null> {
  const found = await testPool(fixtureStorage()).query<{ theme: string }>(
    `SELECT "defaults"."theme"
       FROM "organization_appearance_defaults" AS "defaults"
       JOIN "organizations" AS "organization"
         ON "organization"."id" = "defaults"."organization_id"
      WHERE lower("organization"."slug") = lower($1)`,
    [slug],
  );

  return found.rows[0]?.theme ?? null;
}

export async function organizationTheme(slug: string): Promise<string> {
  const theme = await readOrganizationTheme(slug);
  if (theme === null) {
    throw new Error("Foundation E2E appearance default is missing");
  }

  return theme;
}

/**
 * Move one tenant off the seeded appearance default.
 *
 * `0014` seeds every owner-bearing organization with the same triple through a
 * trigger, so this is the only thing that makes two tenants distinguishable by
 * appearance at all. It is written straight to the row rather than through the
 * settings surface because the journey is not always signed in when it runs,
 * and it insists on having changed exactly one row: a silently missed update
 * would restore the un-failable comparison it exists to end.
 */
async function applyOrganizationTheme(slug: string, theme: string) {
  const updated = await testPool(fixtureStorage()).query(
    `UPDATE "organization_appearance_defaults" AS "defaults"
        SET "theme" = $2,
            "version" = "defaults"."version" + 1,
            "updated_at" = clock_timestamp()
       FROM "organizations" AS "organization"
      WHERE "organization"."id" = "defaults"."organization_id"
        AND lower("organization"."slug") = lower($1)`,
    [slug, theme],
  );

  if (updated.rowCount !== 1) {
    throw new Error("Foundation E2E appearance default was not applied");
  }
}

/**
 * The two tenants resolve different appearance triples, and the journey may
 * rely on that.
 *
 * This is the assertion that keeps the switch contract falsifiable. Everything
 * downstream — the theme on `<html>` after a switch, the outgoing document
 * carrying no restamp — compares two values, and if the fixture's write never
 * landed those two values are the same fixed fallback and the comparison holds
 * whatever the application does. That is precisely how a green run was once
 * reported off a database with no appearance tables at all, so the distinctness
 * is now asserted rather than assumed, against the rows themselves.
 */
export async function expectDistinctTenantAppearance(
  scenario: FoundationScenario,
) {
  const [bootstrap, ui] = await Promise.all([
    readOrganizationTheme(scenario.bootstrapOrganizationSlug),
    readOrganizationTheme(scenario.uiOrganizationSlug),
  ]);

  expect({ bootstrap, ui }).toEqual({
    bootstrap: scenario.bootstrapOrganizationTheme,
    ui: seededOrganizationTheme,
  });
  expect(bootstrap).not.toBe(ui);
}

export async function bootstrapOwner(scenario: FoundationScenario) {
  // In this process, through the domain call the operator CLI makes, rather
  // than through the CLI (ruling 184): the public seed leaves the CLI's
  // workspace out, so a `pnpm --filter` call to it matches nothing there.
  // Without `--fail-if-no-match` that call exited 0 and every journey waited
  // out the magic-link budget (J.6, 2026-10-08); with it (ruling 173), the
  // bootstrap could only fail there. A failure here throws "Foundation E2E
  // owner bootstrap failed: <step>" (`owner-bootstrap.ts`).
  await runOwnerBootstrap({
    email: scenario.ownerEmail,
    organizationSlug: scenario.bootstrapOrganizationSlug,
    organizationName: scenario.bootstrapOrganizationName,
  });

  // The bootstrap is two-stage by design, and only the second stage leaves
  // a row to move. The first call creates the organization and the allowlist
  // entry and returns `awaiting_authentication`: no `organization_members` row
  // exists yet, so `0014`'s trigger — which keys on an *active owner*
  // membership — has not fired and the tenant has no appearance defaults at
  // all. The second call, after the owner has signed in through the magic link,
  // activates that membership and the row is seeded with it.
  //
  // So the stage is read rather than guessed, and the update keeps its
  // exactly-one-row guard wherever it runs. Skipping stage one is not a silent
  // fallback: `expectDistinctTenantAppearance` asserts the write landed before
  // any journey leans on the two tenants differing.
  if (
    (await readOrganizationTheme(scenario.bootstrapOrganizationSlug)) !== null
  ) {
    await applyOrganizationTheme(
      scenario.bootstrapOrganizationSlug,
      scenario.bootstrapOrganizationTheme,
    );
  }
}

function outboxHeaders() {
  return { [E2E_TOKEN_HEADER]: e2eToken() };
}

export async function clearMagicLinkOutbox(request: APIRequestContext) {
  return withFixedE2EFailure(fixedE2EFailureMessages.outboxReset, async () => {
    const response = await askThroughRestarts(
      async () =>
        await request.delete("/api/test/email-outbox", {
          headers: outboxHeaders(),
        }),
    );
    if (response.status() !== 204) {
      throw new Error("Unexpected outbox reset response");
    }
  });
}

export async function findMagicLink(request: APIRequestContext, email: string) {
  return withFixedE2EFailure(fixedE2EFailureMessages.outboxLookup, async () => {
    const response = await askThroughRestarts(
      async () =>
        await request.post("/api/test/email-outbox", {
          data: { email },
          headers: outboxHeaders(),
        }),
    );
    if (response.status() === 404) return null;
    if (!response.ok()) throw new Error("Unexpected outbox lookup response");
    const body = (await response.json()) as { url?: unknown };
    if (typeof body.url !== "string") {
      throw new Error("Invalid outbox response");
    }
    return body.url;
  });
}

export async function submitMagicLinkRequest(
  page: Page,
  email: string,
  // Where the sign-in page is reached from. An agent's authorization arrives
  // at `/authorize`, which redirects here carrying the request; starting at
  // `/sign-in` instead would drop it before the form could hand it back.
  startAt = "/sign-in",
) {
  await page.goto(startAt);
  await onScreen(page.getByLabel("Work email")).fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If that address can sign in, a link is on its way.",
  );
}

/**
 * Sign in through the magic link, across a server that restarts itself.
 *
 * The submission and the poll are outside the block that hides the credential
 * on purpose. Neither of them can carry the link into a failure — the lookup
 * has a block of its own and the acquisition reports only sentences this suite
 * wrote — so leaving them outside keeps a failed submission legible as the
 * locator and the page it actually failed on.
 *
 * What the block covers is the one step that holds the link: the navigation to
 * it, and the address the page ends on, either of which would name the whole
 * URL in the error it reports.
 */
export async function signInWithMagicLink(
  page: Page,
  request: APIRequestContext,
  email: string,
  options: { landsOn?: RegExp | string; startAt?: string } = {},
) {
  const magicLink = await acquireMagicLink({
    lookup: async () => await findMagicLink(request, email),
    now: () => Date.now(),
    sleep: async (ms) => {
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, ms);
      });
    },
    submit: async () => {
      await submitMagicLinkRequest(page, email, options.startAt);
    },
  });

  await withFixedE2EFailure(
    fixedE2EFailureMessages.magicLinkVerification,
    async () => {
      await page.goto(magicLink);
      await expect(page).toHaveURL(options.landsOn ?? "/");
    },
  );
}

export async function expectNoIdentity(email: string) {
  await withFixedE2EFailure(
    fixedE2EFailureMessages.identityInspection,
    async () => {
      const users = await testPool(fixtureStorage()).query<{ id: string }>(
        'SELECT "id" FROM "user" WHERE lower("email") = lower($1)',
        [email],
      );
      if (users.rows.length !== 0) {
        throw new Error("Unexpected identity");
      }
    },
  );
}

export async function cleanupDeniedIdentity(email: string) {
  await withFixedE2EFailure(
    fixedE2EFailureMessages.identityCleanup,
    async () => {
      const client = await testPool(fixtureStorage()).connect();
      try {
        await client.query("BEGIN");
        await client.query(
          'DELETE FROM "verification" WHERE lower("identifier") = lower($1)',
          [email],
        );
        await client.query(
          'DELETE FROM "user" WHERE lower("email") = lower($1)',
          [email],
        );
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error("Scoped identity cleanup failed");
      } finally {
        client.release();
      }
    },
  );
}

/**
 * What the database said, reduced to what is safe to repeat.
 *
 * The step label says where this stopped and nothing said why, so a deadlock,
 * a cancelled statement and a constraint that would not yield are one message —
 * and this teardown's failure is reported against whatever case ran last, where
 * it reads as that case flaking. Naming the step was half the answer; the other
 * half is five characters.
 *
 * The `SQLSTATE` code and a constraint name are schema, not rows. `message` and
 * `detail` are neither — Postgres quotes the offending values into both — so
 * they are not carried here, and a scenario's own addresses are not printed
 * back into a log by a cleanup that failed to remove them.
 */
function databaseReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";

  const { code, constraint } = error as Readonly<{
    code?: unknown;
    constraint?: unknown;
  }>;
  const parts = [
    typeof code === "string" ? code : undefined,
    typeof constraint === "string" ? constraint : undefined,
  ].filter((part) => part !== undefined);

  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

export async function cleanupFoundationScenario(scenario: FoundationScenario) {
  const client = await testPool(fixtureStorage()).connect();
  const emails = [scenario.ownerEmail, scenario.memberEmail];
  const slugs = [
    scenario.bootstrapOrganizationSlug,
    scenario.uiOrganizationSlug,
  ];
  // Which step, and nothing the database said. This teardown runs after the
  // last case of a lane and its failure is reported against that case, so an
  // intermittent one reads as a flake in whatever ran last — it has been
  // reported against `/webhooks` and against the not-found boundary on
  // different runs, and neither case had anything to do with it. The labels are
  // written here rather than taken from anything a run created.
  let step = "begin";

  try {
    await client.query("BEGIN");
    step = "organizations";
    const organizations = await client.query<{ id: string }>(
      `SELECT "id" FROM "organizations"
       WHERE lower("slug") = ANY($1::text[])`,
      [slugs],
    );
    const organizationIds = organizations.rows.map((row) => row.id);

    step = "verification";
    await client.query(
      'DELETE FROM "verification" WHERE lower("identifier") = ANY($1::text[])',
      [emails],
    );
    if (organizationIds.length > 0) {
      step = "projects";
      await client.query(
        `UPDATE "projects"
         SET "status" = 'archived', "updated_at" = clock_timestamp()
         WHERE "organization_id" = ANY($1::uuid[])`,
        [organizationIds],
      );
      step = "invitations";
      await client.query(
        'DELETE FROM "invitations" WHERE "organization_id" = ANY($1::uuid[])',
        [organizationIds],
      );
      // After `0014` an owner-bearing organization also owns an appearance
      // default that records one of these memberships as its last updater.
      // That reference must degrade rather than block, so the updater key is
      // declared `ON DELETE SET NULL ("last_updated_by_user_id")` and this
      // straight delete keeps working — on a pre-`0014` database too, which is
      // why no appearance table is named here. The organization itself is
      // archived, never deleted: its seeded initialization event is protected
      // by the append-only guard on "domain_events".
      step = "organization_members";
      await client.query(
        'DELETE FROM "organization_members" WHERE "organization_id" = ANY($1::uuid[])',
        [organizationIds],
      );
      step = "organizations_archive";
      await client.query(
        `UPDATE "organizations"
         SET "status" = 'archived', "updated_at" = clock_timestamp()
         WHERE "id" = ANY($1::uuid[])`,
        [organizationIds],
      );
    }
    // A retention hold outlives the person who placed it, by design: it is a
    // compliance record, and `retention_holds` declares both of its user keys
    // without `ON DELETE CASCADE` so that deleting an operator cannot quietly
    // remove the evidence that something was held. Production never deletes a
    // user, so nothing there notices. This fixture does, for every email it
    // signed in as — and the `/settings/operations` cases place holds through
    // the browser as exactly those users, so the delete below is refused with
    // `23503 retention_holds_created_by_user_id_user_id_fk` and the lane dies
    // in teardown. It passed on retry, so it was read as flakiness; staging
    // acceptance 34842342037 is where it is written down.
    //
    // Removing the holds first is the narrow answer. It is scoped to the users
    // this fixture is about to delete, so no hold belonging to anyone else is
    // reachable from here, and the production semantics the keys encode are
    // left exactly as they are.
    step = "retention_holds";
    await client.query(
      `DELETE FROM "retention_holds"
       WHERE "created_by_user_id" IN (
               SELECT "id" FROM "user" WHERE lower("email") = ANY($1::text[])
             )
          OR "released_by_user_id" IN (
               SELECT "id" FROM "user" WHERE lower("email") = ANY($1::text[])
             )`,
      [emails],
    );
    step = "user";
    await client.query(
      'DELETE FROM "user" WHERE lower("email") = ANY($1::text[])',
      [emails],
    );
    step = "signup_allowlist";
    await client.query(
      'DELETE FROM "signup_allowlist" WHERE lower("normalized_email") = ANY($1::text[])',
      [emails],
    );
    step = "commit";
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      `Foundation E2E scoped cleanup failed: ${step}${databaseReason(error)}`,
    );
  } finally {
    client.release();
  }
}
