import { type APIRequestContext, expect, type Page } from "@playwright/test";

import {
  bootstrapOwner,
  cleanupFoundationScenario,
  clearMagicLinkOutbox,
  createFoundationScenario,
  type FoundationScenario,
  findMagicLink,
  signInWithMagicLink,
} from "../fixtures/auth.js";
import { test } from "../fixtures/engine.ts";
import { runOwnerBootstrap } from "../fixtures/owner-bootstrap.js";
import { askThroughRestarts } from "../fixtures/scenario-navigation.js";
import { onScreen } from "../fixtures/shell.js";

/*
 * D's deferred browser acceptance (Plan 13, H.9; manifest-h.md Done when 16):
 * for each sign-in provider combination, what the sign-in page offers, and
 * what the server answers for each of the three methods.
 *
 * Run by `scripts/run-sign-in-combinations.mjs` and by nothing else. It starts
 * one server per combination on port 3100, sets
 * `REQUESTPORT_SIGN_IN_COMBINATION` to the combination's name, and selects
 * that combination's cases by tag. `playwright.config.ts` declares this
 * directory's project only while that variable is set, so the `--e2e` lanes
 * never load this file.
 *
 * GitHub's own sign-in is not run: it needs GitHub. Where GitHub is
 * configured, the case below asks the server for the address it would send a
 * person to and checks it, and does not follow it; the client it names is the
 * runner's placeholder, which no GitHub application has.
 */

type Offers = Readonly<{
  github: boolean;
  localCredential: boolean;
  magicLink: boolean;
}>;

/**
 * What each combination must show. Written out rather than derived from
 * `readSignInMethods`, which is what the page itself asks: a spec that asked
 * the same function would agree with the page whatever the function said.
 *
 * Without GitHub or a magic link, the local credential is on by default; beside
 * either it is off, and the runner sets nothing that would turn it on.
 */
const combinations: ReadonlyArray<
  Readonly<{ name: string; offers: Offers; subtitle: string }>
> = [
  {
    name: "none",
    offers: { github: false, localCredential: true, magicLink: false },
    subtitle: "Use the local credential your operator issued.",
  },
  {
    name: "github",
    offers: { github: true, localCredential: false, magicLink: false },
    subtitle: "Use your GitHub account.",
  },
  {
    name: "magic-link",
    offers: { github: false, localCredential: false, magicLink: true },
    subtitle: "Use an approved email address.",
  },
  {
    name: "both",
    offers: { github: true, localCredential: false, magicLink: true },
    subtitle: "Use your GitHub account or an approved email address.",
  },
];

/** The combination the runner started this run's server with. */
function serverCombination() {
  return process.env.REQUESTPORT_SIGN_IN_COMBINATION;
}

/**
 * An owner with a local credential, issued in this process by the call the
 * operator CLI's `bootstrap-owner --local-credential` makes:
 * `@requestport/domain`'s `bootstrapOwner` with `localCredential: "issue"`,
 * through `runOwnerBootstrap` (J.6c, ruling 187), so no workspace the public
 * seed leaves out is needed. The domain answers the credential once and
 * stores only its hash. It belongs to a scenario this spec deletes when the
 * case ends, so it is never reusable.
 *
 * A failed call throws the helper's "Foundation E2E owner bootstrap failed:
 * <step>". An answer that carries no credential throws "issued no
 * credential": the domain issues one only to a person who holds none, so a
 * second call for the same address answers `unchanged` and nothing to sign
 * in with. Neither message repeats the credential or an address.
 */
async function issueLocalCredential(scenario: FoundationScenario) {
  const result = await runOwnerBootstrap({
    email: scenario.ownerEmail,
    organizationSlug: scenario.bootstrapOrganizationSlug,
    organizationName: scenario.bootstrapOrganizationName,
    localCredential: "issue",
  });
  if (
    result.status !== "owner_active" ||
    typeof result.credential !== "string"
  ) {
    throw new Error("bootstrap-owner --local-credential issued no credential");
  }
  return result.credential;
}

/*
 * Both requests below go through `askThroughRestarts`:
 * `apps/web/src/test/scenario-navigation.test.ts` refuses a request call
 * anywhere under `apps/web/tests` that is wrapped in neither it nor
 * `releaseScenarioRun`. It asks again after a restart's transport failure or
 * after an attempt whose bound elapsed unanswered, and such an attempt may
 * have been accepted. So a repeat can leave a second unfinished
 * authorization's `verification` row (the GitHub case), or spend a second of
 * the address's magic-link allowance (`packages/server/src/auth.ts`).
 */

/** The session the browser now holds belongs to this address. */
async function expectSignedInAs(page: Page, email: string) {
  const response = await askThroughRestarts(
    async () => await page.request.get("/api/auth/get-session"),
  );
  expect(response.ok()).toBe(true);
  const session = (await response.json()) as {
    user?: { email?: unknown };
  } | null;
  expect(session?.user?.email).toBe(email);
}

/** A sign-in request as the page's client makes it, from this origin. */
async function postToAuth(
  request: APIRequestContext,
  origin: string,
  path: string,
  data: Record<string, string>,
) {
  return await askThroughRestarts(
    async () =>
      await request.post(`/api/auth/${path}`, {
        data,
        headers: { origin },
      }),
  );
}

for (const { name, offers, subtitle } of combinations) {
  test.describe(name, { tag: `@sign-in-${name}` }, () => {
    test.beforeEach(() => {
      expect(
        serverCombination(),
        "these cases run against a server started for this combination, by scripts/run-sign-in-combinations.mjs",
      ).toBe(name);
    });

    test("the sign-in page offers exactly the enabled methods", async ({
      page,
    }) => {
      await page.goto("/sign-in");

      await expect(page.getByText(subtitle, { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue with GitHub" }),
      ).toHaveCount(offers.github ? 1 : 0);
      await expect(
        page.getByRole("button", { name: "Email me a sign-in link" }),
      ).toHaveCount(offers.magicLink ? 1 : 0);
      await expect(page.getByLabel("Work email", { exact: true })).toHaveCount(
        offers.magicLink ? 1 : 0,
      );
      await expect(
        page.getByRole("button", { name: "Sign in with credential" }),
      ).toHaveCount(offers.localCredential ? 1 : 0);
      await expect(page.getByLabel("Credential", { exact: true })).toHaveCount(
        offers.localCredential ? 1 : 0,
      );
    });

    test(
      offers.github
        ? "GitHub: the server answers with GitHub's authorization address, which is not followed"
        : "GitHub: the server refuses it",
      async ({ baseURL, request }) => {
        const response = await postToAuth(
          request,
          baseURL ?? "",
          "sign-in/social",
          { callbackURL: "/", provider: "github" },
        );

        if (offers.github) {
          expect(response.status()).toBe(200);
          const { url } = (await response.json()) as { url: string };
          const authorization = new URL(url);
          expect(`${authorization.origin}${authorization.pathname}`).toBe(
            "https://github.com/login/oauth/authorize",
          );
          expect(authorization.searchParams.get("client_id")).toBe(
            process.env.GITHUB_CLIENT_ID,
          );
        } else {
          expect(response.status()).toBe(404);
          expect(((await response.json()) as { code?: unknown }).code).toBe(
            "PROVIDER_NOT_FOUND",
          );
        }
      },
    );

    test(
      offers.magicLink
        ? "magic link: signs in through the e2e outbox"
        : "magic link: the server refuses it",
      async ({ baseURL, page, request }) => {
        const scenario = createFoundationScenario("signin");

        try {
          await clearMagicLinkOutbox(request);
          // The address is allowed to sign in either way, so a refusal is the
          // combination's and not the signup policy's.
          await bootstrapOwner(scenario);

          if (offers.magicLink) {
            await signInWithMagicLink(page, request, scenario.ownerEmail);
            await expectSignedInAs(page, scenario.ownerEmail);
          } else {
            const response = await postToAuth(
              request,
              baseURL ?? "",
              "sign-in/magic-link",
              { callbackURL: "/", email: scenario.ownerEmail },
            );
            expect(response.status()).toBe(404);
            await expect(
              findMagicLink(request, scenario.ownerEmail),
            ).resolves.toBeNull();
          }
        } finally {
          await clearMagicLinkOutbox(request).catch(() => undefined);
          await cleanupFoundationScenario(scenario);
        }
      },
    );

    test(
      offers.localCredential
        ? "local credential: signs in with the credential bootstrap-owner issued"
        : "local credential: the server refuses the credential bootstrap-owner issued",
      async ({ baseURL, page, request }) => {
        const scenario = createFoundationScenario("signin");

        try {
          const credential = await issueLocalCredential(scenario);

          if (offers.localCredential) {
            await page.goto("/sign-in");
            await onScreen(page.getByLabel("Email", { exact: true })).fill(
              scenario.ownerEmail,
            );
            await onScreen(page.getByLabel("Credential", { exact: true })).fill(
              credential,
            );
            await page
              .getByRole("button", { name: "Sign in with credential" })
              .click();
            await expect(page).toHaveURL("/");
            await expectSignedInAs(page, scenario.ownerEmail);
          } else {
            const response = await postToAuth(
              request,
              baseURL ?? "",
              "sign-in/email",
              { email: scenario.ownerEmail, password: credential },
            );
            expect(response.status()).toBe(400);
            expect(((await response.json()) as { code?: unknown }).code).toBe(
              "EMAIL_PASSWORD_DISABLED",
            );
          }
        } finally {
          await cleanupFoundationScenario(scenario);
        }
      },
    );
  });
}
