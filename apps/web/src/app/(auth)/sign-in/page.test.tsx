/**
 * The sign-in page offers exactly the methods the deployment enables.
 *
 * Read from the environment the way `@requestport/config` reads it, so the
 * page and the server agree without the page parsing a configuration it has
 * no business failing on. The four combinations of the two external methods,
 * the local credential that is the floor when neither is configured, and the
 * one case with no way in at all.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import SignInPage from "./page.js";

const methodKeys = [
  "VERCEL_ENV",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "REQUESTPORT_LOCAL_CREDENTIAL",
  "REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID",
  "REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET",
  "REQUESTPORT_PREVIEW_RESEND_API_KEY",
  "REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL",
] as const;

const github = {
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};
const magicLink = {
  RESEND_API_KEY: "re_test",
  RESEND_FROM_EMAIL: "hello@example.com",
};

async function renderWith(
  env: Partial<Record<(typeof methodKeys)[number], string>>,
) {
  for (const key of methodKeys) vi.stubEnv(key, env[key]);
  return renderToStaticMarkup(await SignInPage({}));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the sign-in page", () => {
  test.each([
    {
      name: "neither external method",
      env: {},
      github: false,
      magicLink: false,
      password: true,
      subtitle: "Use the local credential your operator issued.",
    },
    {
      name: "GitHub only",
      env: github,
      github: true,
      magicLink: false,
      password: false,
      subtitle: "Use your GitHub account.",
    },
    {
      name: "magic link only",
      env: magicLink,
      github: false,
      magicLink: true,
      password: false,
      subtitle: "Use an approved email address.",
    },
    {
      name: "both",
      env: { ...github, ...magicLink },
      github: true,
      magicLink: true,
      password: false,
      subtitle: "Use your GitHub account or an approved email address.",
    },
    {
      name: "both, with the local credential switched on",
      env: { ...github, ...magicLink, REQUESTPORT_LOCAL_CREDENTIAL: "enabled" },
      github: true,
      magicLink: true,
      password: true,
      subtitle:
        "Use your GitHub account, an approved email address or the local credential your operator issued.",
    },
  ])("with $name, offers only what is enabled", async (combination) => {
    const markup = await renderWith(combination.env);

    expect(markup.includes("Continue with GitHub")).toBe(combination.github);
    expect(markup.includes("Email me a sign-in link")).toBe(
      combination.magicLink,
    );
    expect(markup.includes('type="password"')).toBe(combination.password);
    expect(markup).toContain(combination.subtitle);
    expect(markup.toLowerCase()).not.toContain("sign up");
  });

  test("reads the Preview's own values inside a Vercel Preview", async () => {
    const markup = await renderWith({
      ...github,
      ...magicLink,
      VERCEL_ENV: "preview",
      REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID: "preview-github",
      REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET: "preview-secret",
    });

    expect(markup).toContain("Continue with GitHub");
    expect(markup).not.toContain("Email me a sign-in link");
  });

  test("says so plainly when there is no way in, and draws no inert controls", async () => {
    const markup = await renderWith({
      REQUESTPORT_LOCAL_CREDENTIAL: "disabled",
    });

    expect(markup).toContain(
      "No sign-in method is configured for this deployment.",
    );
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("Continue with GitHub");
  });

  test.each([
    {
      name: "production, switched on",
      env: {
        ...github,
        ...magicLink,
        VERCEL_ENV: "production",
        REQUESTPORT_LOCAL_CREDENTIAL: "enabled",
      },
      subtitle: "Use your GitHub account or an approved email address.",
    },
    {
      name: "a Preview with no external method and no switch",
      env: { VERCEL_ENV: "preview" },
      subtitle: "No sign-in method is configured for this deployment.",
    },
    {
      name: "a Preview switched on",
      env: { VERCEL_ENV: "preview", REQUESTPORT_LOCAL_CREDENTIAL: "enabled" },
      subtitle: "No sign-in method is configured for this deployment.",
    },
  ])(
    "never offers the local credential on Vercel: $name",
    async ({ env, subtitle }) => {
      const markup = await renderWith(env);

      expect(markup).not.toContain('type="password"');
      expect(markup).not.toContain("the local credential");
      expect(markup).toContain(subtitle);
    },
  );

  test("no longer mentions staging, which was retired", async () => {
    for (const env of [
      {},
      github,
      { REQUESTPORT_LOCAL_CREDENTIAL: "disabled" },
    ]) {
      expect((await renderWith(env)).toLowerCase()).not.toContain("staging");
    }
  });
});
