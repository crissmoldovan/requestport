import { describe, expect, test } from "vitest";

import {
  localCredentialEnabled,
  readSignInMethods,
  signInMethodsFor,
} from "./sign-in-methods.js";

const github = {
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
} as const;
const magicLink = {
  RESEND_API_KEY: "re_test_api_key",
  RESEND_FROM_EMAIL: "hello@example.com",
} as const;

/**
 * The four combinations of the two external methods, and what each one leaves
 * a person able to do. The local credential is the floor: with nothing
 * external configured it is on by default, because otherwise the deployment
 * boots with no way in at all.
 */
describe("which sign-in methods a configuration enables", () => {
  test.each([
    {
      name: "neither external method",
      env: {},
      expected: { github: false, magicLink: false, localCredential: true },
    },
    {
      name: "GitHub only",
      env: { ...github },
      expected: { github: true, magicLink: false, localCredential: false },
    },
    {
      name: "magic link only",
      env: { ...magicLink },
      expected: { github: false, magicLink: true, localCredential: false },
    },
    {
      name: "both external methods",
      env: { ...github, ...magicLink },
      expected: { github: true, magicLink: true, localCredential: false },
    },
  ])("$name", ({ env, expected }) => {
    expect(signInMethodsFor(env)).toEqual(expected);
  });

  test("an explicit switch turns the local credential on beside external methods", () => {
    expect(
      signInMethodsFor({
        ...github,
        ...magicLink,
        REQUESTPORT_LOCAL_CREDENTIAL: "enabled",
      }),
    ).toEqual({ github: true, magicLink: true, localCredential: true });
  });

  test("an explicit switch turns the local credential off even when it is the only method", () => {
    expect(
      signInMethodsFor({ REQUESTPORT_LOCAL_CREDENTIAL: "disabled" }),
    ).toEqual({ github: false, magicLink: false, localCredential: false });
  });

  test("half a pair enables nothing", () => {
    // The schema refuses to boot on half a pair; this answers the same
    // question for a reader that never parsed it, and must not say "on".
    expect(
      signInMethodsFor({
        GITHUB_CLIENT_ID: "github-client-id",
        RESEND_API_KEY: "re_test_api_key",
      }),
    ).toEqual({ github: false, magicLink: false, localCredential: true });
  });
});

describe("reading the methods from an unparsed environment", () => {
  test("reads the canonical names outside a Vercel Preview", () => {
    expect(
      readSignInMethods({
        ...github,
        REQUESTPORT_PREVIEW_RESEND_API_KEY: "re_preview",
        REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL: "preview@example.com",
        VERCEL_ENV: "production",
      }),
    ).toEqual({ github: true, magicLink: false, localCredential: false });
  });

  test("reads only the Preview names inside a Vercel Preview", () => {
    expect(
      readSignInMethods({
        ...github,
        ...magicLink,
        REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID: "preview-github-client-id",
        REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET: "preview-github-secret",
        VERCEL_ENV: "preview",
      }),
    ).toEqual({ github: true, magicLink: false, localCredential: false });
  });

  test("treats an empty value as absent", () => {
    expect(
      readSignInMethods({ GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }),
    ).toEqual({ github: false, magicLink: false, localCredential: true });
  });
});

/**
 * The local credential exists for local and self-hosted use. On any Vercel
 * deployment — any `VERCEL_ENV`, `development` included — it is off, and no
 * value of `REQUESTPORT_LOCAL_CREDENTIAL` turns it on: a bootstrap credential
 * on a public URL is the exposure this rule closes. Off Vercel, nothing about
 * it changes.
 */
describe("the local credential on a Vercel deployment", () => {
  test.each([
    {
      name: "production, switched on beside both methods",
      env: {
        ...github,
        ...magicLink,
        VERCEL_ENV: "production",
        REQUESTPORT_LOCAL_CREDENTIAL: "enabled" as const,
      },
      expected: { github: true, magicLink: true, localCredential: false },
    },
    {
      name: "a Preview with no external method and no switch",
      env: { VERCEL_ENV: "preview" },
      expected: { github: false, magicLink: false, localCredential: false },
    },
    {
      name: "a Preview switched on",
      env: {
        VERCEL_ENV: "preview",
        REQUESTPORT_LOCAL_CREDENTIAL: "enabled" as const,
      },
      expected: { github: false, magicLink: false, localCredential: false },
    },
    {
      name: "development switched on",
      env: {
        VERCEL_ENV: "development",
        REQUESTPORT_LOCAL_CREDENTIAL: "enabled" as const,
      },
      expected: { github: false, magicLink: false, localCredential: false },
    },
  ])("is off in $name", ({ env, expected }) => {
    expect(signInMethodsFor(env)).toEqual(expected);
    expect(readSignInMethods(env)).toEqual(expected);
  });

  test("is on off Vercel with no external method, as before", () => {
    expect(signInMethodsFor({})).toEqual({
      github: false,
      magicLink: false,
      localCredential: true,
    });
    expect(readSignInMethods({})).toEqual({
      github: false,
      magicLink: false,
      localCredential: true,
    });
  });

  test("is off off Vercel when switched off", () => {
    const env = { REQUESTPORT_LOCAL_CREDENTIAL: "disabled" as const };

    expect(signInMethodsFor(env).localCredential).toBe(false);
    expect(readSignInMethods(env).localCredential).toBe(false);
  });

  test("the rule itself refuses on Vercel whatever the switch says", () => {
    for (const vercelEnv of ["production", "preview", "development"]) {
      for (const localCredentialSwitch of [
        "enabled",
        "disabled",
        undefined,
      ] as const) {
        expect(
          localCredentialEnabled({
            github: false,
            magicLink: false,
            localCredentialSwitch,
            vercelEnv,
          }),
        ).toBe(false);
      }
    }
  });
});
