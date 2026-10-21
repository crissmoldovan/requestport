import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildLaneCommand,
  FOUNDATION_E2E_LANES,
  repeatFrom,
} from "./run-foundation-e2e.mjs";

const [lane] = FOUNDATION_E2E_LANES;

describe("repeatFrom", () => {
  test("nothing asked for means nothing is passed on", () => {
    assert.equal(repeatFrom([]), undefined);
    assert.equal(repeatFrom(["route-state-webkit"]), undefined);
  });

  test("reads the count a hunt asked for", () => {
    assert.equal(repeatFrom(["--repeat-each=12"]), 12);
    assert.equal(repeatFrom(["route-state-webkit", "--repeat-each=1"]), 1);
  });

  /*
   * A malformed count has to be refused rather than dropped. `lanesFrom`
   * ignores every flag, so a typo that silently ran one pass would report a
   * green loop for a repeat nobody performed — the same class of answer a
   * mistyped lane name is already refused for.
   */
  test("refuses a count that is not a positive whole number", () => {
    for (const value of ["0", "-3", "2.5", "many", ""]) {
      assert.throws(
        () => repeatFrom([`--repeat-each=${value}`]),
        /repeat/iu,
        `--repeat-each=${value} must be refused`,
      );
    }
  });
});

describe("buildLaneCommand", () => {
  test("says nothing about repeats when none was asked for", () => {
    const { args } = buildLaneCommand(lane);

    assert.equal(
      args.some((argument) => argument.startsWith("--repeat-each")),
      false,
    );
  });

  test("carries the repeat through to playwright", () => {
    const { args } = buildLaneCommand(lane, 7);

    assert.ok(args.includes("--repeat-each=7"), args.join(" "));
    // After the lane, because everything from `run test:e2e` onwards is
    // forwarded to playwright in the order pnpm was given it.
    assert.ok(args.indexOf("--repeat-each=7") > args.indexOf(lane));
  });

  test("still refuses a lane that does not exist, repeat or not", () => {
    assert.throws(() => buildLaneCommand("no-such-lane", 3));
  });
});
