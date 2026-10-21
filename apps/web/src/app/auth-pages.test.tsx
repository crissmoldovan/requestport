import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import AuthErrorPage from "./(auth)/auth-error/page.js";
import SignInPage from "./(auth)/sign-in/page.js";
import {
  AUTH_SUCCESS_PATH,
  getMagicLinkStatusMessage,
} from "./(auth)/sign-in/sign-in-form.js";

const previewProviderKeys = [
  "REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID",
  "REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET",
  "REQUESTPORT_PREVIEW_RESEND_API_KEY",
  "REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL",
] as const;

/** The retired authentication recipes the native controls replace. */
const retiredAuthClasses = [
  "auth-button",
  "auth-controls",
  "auth-divider",
  "auth-form",
  "auth-header",
  "auth-kicker",
  "auth-panel",
  "auth-shell",
  "auth-status",
];

/**
 * The browser helpers that stand between every authenticated journey and its
 * assertions. `submitMagicLinkRequest` lives in a fixture rather than in a
 * spec, so a selector retired here does not fail one suite — it fails sign-in
 * for every suite that signs in, and reads as an undelivered magic link.
 */
const sharedSignInHelpers = [
  "../../tests/fixtures/auth.ts",
  "../../tests/e2e/auth.spec.ts",
];

/** Every Playwright fixture and spec, not only the two that sign in. */
const browserTestRoot = resolve(import.meta.dirname, "../../tests");

function browserTestFiles() {
  return readdirSync(browserTestRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) =>
      relative(browserTestRoot, resolve(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
}

describe("authentication pages", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "test");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "test");
    for (const key of previewProviderKeys) vi.stubEnv(key, "test-provider");
    // The page offers what the canonical values enable outside a Preview, so
    // they are stated here rather than inherited from whichever .env.local
    // the run happened to load.
    vi.stubEnv("GITHUB_CLIENT_ID", "test-provider");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-provider");
    vi.stubEnv("RESEND_API_KEY", "test-provider");
    vi.stubEnv("RESEND_FROM_EMAIL", "test@example.com");
    vi.stubEnv("REQUESTPORT_LOCAL_CREDENTIAL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns successful GitHub and magic-link authentication to the real application route", async () => {
    expect(AUTH_SUCCESS_PATH).toBe("/");
  });

  test("renders GitHub and email magic-link controls without signup or password UI", async () => {
    const markup = renderToStaticMarkup(await SignInPage({}));

    expect(markup).toContain("Continue with GitHub");
    expect(markup).toContain('type="email"');
    expect(markup).toContain("Email me a sign-in link");
    expect(markup).not.toContain(
      "If that address can sign in, a link is on its way.",
    );
    expect(markup).not.toContain('type="password"');
    expect(markup.toLowerCase()).not.toContain("sign up");
  });

  test("labels the email control through one native field", async () => {
    const markup = renderToStaticMarkup(await SignInPage({}));

    expect(markup).toContain('data-slot="field"');
    expect(markup.match(/data-slot="field"/gu)).toHaveLength(1);
    expect(markup).toContain("Work email");
    expect(markup).toContain('data-slot="page-shell-title"');
    expect(markup).toContain("<main");
    expect(markup).not.toContain("htmlFor");
    for (const retired of retiredAuthClasses) {
      expect({ markup: markup.includes(retired), retired }).toEqual({
        markup: false,
        retired,
      });
    }
  });

  test("waits for the neutral result through the role the native form exposes", async () => {
    const markup = renderToStaticMarkup(await SignInPage({}));

    expect(markup).toContain('role="status"');

    for (const helper of sharedSignInHelpers) {
      const source = readFileSync(resolve(import.meta.dirname, helper), "utf8");

      expect({
        helper,
        waitsOnRole: source.includes('getByRole("status")'),
      }).toEqual({ helper, waitsOnRole: true });
    }
  });

  test("leaves no retired authentication recipe in any fixture or spec", async () => {
    const files = browserTestFiles();

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(resolve(browserTestRoot, file), "utf8");
      for (const retired of retiredAuthClasses) {
        expect({ file, retired, source: source.includes(retired) }).toEqual({
          file,
          retired,
          source: false,
        });
      }
    }
  });

  test("offers no local credential, and no staging notice, on a providerless feature Preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "codex/implementation");
    for (const key of previewProviderKeys) vi.stubEnv(key, undefined);

    const markup = renderToStaticMarkup(await SignInPage({}));

    // The local credential is off on every Vercel deployment: a bootstrap
    // credential on a public preview URL is what that rule closes.
    expect(markup.toLowerCase()).not.toContain("staging");
    expect(markup).not.toContain("Continue with GitHub");
    expect(markup).not.toContain("Email me a sign-in link");
    expect(markup).not.toContain('type="password"');
    expect(markup).toContain(
      "No sign-in method is configured for this deployment.",
    );
  });

  test("shows the existence-neutral message only after requesting a link", async () => {
    expect(getMagicLinkStatusMessage("idle")).toBeNull();
    expect(getMagicLinkStatusMessage("sending")).toBeNull();
    expect(getMagicLinkStatusMessage("sent")).toBe(
      "If that address can sign in, a link is on its way.",
    );
  });

  test("maps signup_disabled to the invite-only message", async () => {
    const page = await AuthErrorPage({
      searchParams: Promise.resolve({ error: "signup_disabled" }),
    });

    expect(renderToStaticMarkup(page)).toContain(
      "This RequestPort is invite-only",
    );
  });

  test("uses a generic retry message for every other error", async () => {
    const page = await AuthErrorPage({
      searchParams: Promise.resolve({ error: "provider_internal_detail" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("We couldn’t sign you in. Please try again.");
    expect(markup).not.toContain("provider_internal_detail");
  });

  test("returns to sign in through a native control on the error page", async () => {
    const page = await AuthErrorPage({
      searchParams: Promise.resolve({ error: "signup_disabled" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain("Return to sign in");
    expect(markup).toContain("<main");
    for (const retired of retiredAuthClasses) {
      expect({ markup: markup.includes(retired), retired }).toEqual({
        markup: false,
        retired,
      });
    }
  });
});
