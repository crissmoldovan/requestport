import { describe, expect, test } from "vitest";

import {
  CI_CREDENTIAL_VARIABLE,
  describeCiCredential,
  readCiCredential,
} from "./ci.js";

/**
 * The one place a shared, non-delegated credential belongs.
 *
 * Everywhere else a credential is bound to a person, because a person can
 * consent, be removed, and be named in an audit record. CI is none of those, so
 * it carries an agent credential issued from the UI and supplied as a secret.
 *
 * This module exists to keep that exception in one visible place. A resolver
 * that quietly fell back to an environment variable would let the exception
 * spread to developer machines, where it is exactly wrong.
 */
describe("the CI credential", () => {
  test("is absent when the variable is unset", () => {
    expect(readCiCredential({})).toBeUndefined();
  });

  test.each(["", "   ", "\n"])(
    "treats a blank value (%j) as absent rather than as a credential",
    (value) => {
      expect(
        readCiCredential({ [CI_CREDENTIAL_VARIABLE]: value }),
      ).toBeUndefined();
    },
  );

  test("is returned when set", () => {
    const credential = readCiCredential({
      [CI_CREDENTIAL_VARIABLE]: "  rp_agent_example  ",
    });

    expect(credential).toEqual({ accessToken: "rp_agent_example" });
  });

  test("never appears in a rendered description of itself", () => {
    const credential = readCiCredential({
      [CI_CREDENTIAL_VARIABLE]: "rp_agent_must_not_leak",
    });

    expect(describeCiCredential(credential)).not.toContain("must_not_leak");
    expect(describeCiCredential(credential)).toContain(CI_CREDENTIAL_VARIABLE);
  });

  test("describes absence without implying a value exists", () => {
    expect(describeCiCredential(undefined)).toMatch(/not set/iu);
  });
});
