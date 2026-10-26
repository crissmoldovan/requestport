import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { withoutComments } from "../test/source-text.js";

import {
  isSetupCardHidden,
  SETUP_CARD_HIDDEN_COOKIE,
  setupCardHiddenEntriesKept,
  withSetupCardHidden,
  writeSetupCardCookie,
} from "./setup-card-cookie.js";

/*
  Who hid the overview's setup card, and where (ruling 261): one HttpOnly
  cookie the server reads before it renders `/`, holding an entry per person
  and organisation.
*/

const organization = "00000000-0000-4000-8000-0000000000d1";
const otherOrganization = "00000000-0000-4000-8000-0000000000d2";

describe("the setup card's hidden cookie", () => {
  test("hides the card for the person and the organisation it names, and for no one else", () => {
    const value = withSetupCardHidden(
      undefined,
      "user_ana",
      organization,
      true,
    );

    expect(isSetupCardHidden(value, "user_ana", organization)).toBe(true);
    // Another person on the same browser, and the same person elsewhere.
    expect(isSetupCardHidden(value, "user_bo", organization)).toBe(false);
    expect(isSetupCardHidden(value, "user_ana", otherOrganization)).toBe(false);
    expect(isSetupCardHidden(undefined, "user_ana", organization)).toBe(false);
  });

  test("shows the card again, keeping everyone else's choice", () => {
    let value = withSetupCardHidden(undefined, "user_ana", organization, true);
    value = withSetupCardHidden(value, "user_bo", organization, true);
    value = withSetupCardHidden(value, "user_ana", otherOrganization, true);

    value = withSetupCardHidden(value, "user_ana", organization, false);

    expect(isSetupCardHidden(value, "user_ana", organization)).toBe(false);
    expect(isSetupCardHidden(value, "user_bo", organization)).toBe(true);
    expect(isSetupCardHidden(value, "user_ana", otherOrganization)).toBe(true);
  });

  test("hiding twice keeps one entry, and showing the last one empties the value", () => {
    let value = withSetupCardHidden(undefined, "user_ana", organization, true);
    value = withSetupCardHidden(value, "user_ana", organization, true);

    expect(value).toBe(`${organization}:user_ana`);
    expect(withSetupCardHidden(value, "user_ana", organization, false)).toBe(
      "",
    );
  });

  test("keeps the newest entries when there are more than it holds", () => {
    let value = "";
    const organizations = Array.from(
      { length: setupCardHiddenEntriesKept + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    for (const each of organizations) {
      value = withSetupCardHidden(value, "user_ana", each, true);
    }

    expect(value.split("|")).toHaveLength(setupCardHiddenEntriesKept);
    expect(isSetupCardHidden(value, "user_ana", organizations[0] ?? "")).toBe(
      false,
    );
    expect(
      isSetupCardHidden(value, "user_ana", organizations.at(-1) ?? ""),
    ).toBe(true);
  });

  test("reads nothing from a value it did not write", () => {
    expect(
      isSetupCardHidden(
        `not-an-organization:user_ana`,
        "user_ana",
        organization,
      ),
    ).toBe(false);
    expect(isSetupCardHidden(`${organization}:`, "", organization)).toBe(false);
    expect(
      withSetupCardHidden(
        `garbage|${organization}:user_bo`,
        "user_ana",
        organization,
        true,
      ),
    ).toBe(`${organization}:user_bo|${organization}:user_ana`);
  });

  test.each([
    ["production", true],
    ["development", false],
    ["test", false],
  ] as const)(
    "is HttpOnly, lax, for every path and a year, Secure only in production: %s",
    (nodeEnv, secure) => {
      const set = vi.fn();

      writeSetupCardCookie({ set }, `${organization}:user_ana`, {
        NODE_ENV: nodeEnv,
      });

      expect(SETUP_CARD_HIDDEN_COOKIE).toBe("requestport.setup_card_hidden");
      expect(set).toHaveBeenCalledWith(
        SETUP_CARD_HIDDEN_COOKIE,
        `${organization}:user_ana`,
        {
          httpOnly: true,
          maxAge: 365 * 24 * 60 * 60,
          path: "/",
          sameSite: "lax",
          secure,
        },
      );
    },
  );

  test("expires the cookie once no entry is left", () => {
    const set = vi.fn();

    writeSetupCardCookie({ set }, "", { NODE_ENV: "production" });

    expect(set).toHaveBeenCalledWith(SETUP_CARD_HIDDEN_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  });

  test("reads the environment off an object, as the organization cookie does", () => {
    // A build folds `process.env.NODE_ENV` to a constant where it is written
    // out directly (organization-cookie.ts says what that cost on WebKit).
    const source = readFileSync(
      new URL("./setup-card-cookie.ts", import.meta.url),
      "utf8",
    );

    expect(withoutComments(source)).not.toMatch(
      /process\.env\.NODE_ENV\s*===/u,
    );
  });
});
