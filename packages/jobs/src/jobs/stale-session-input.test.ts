import {
  createCoreCommandRegistry,
  normalizedInputHash,
} from "@requestport/domain";
import { describe, expect, test } from "vitest";

import { workSessionSweepInput } from "./stale-session-input.js";

const row = {
  id: "018f0000-0000-7000-8000-0000000000a1",
  organizationId: "018f0000-0000-7000-8000-0000000000a2",
};

describe("the work-session sweep's command input", () => {
  test.each(["mark_work_session_stale", "abandon_work_session"] as const)(
    "%s: the bus can parse it and take its receipt's hash",
    (command) => {
      const input = workSessionSweepInput(command, row);
      const definition = createCoreCommandRegistry().resolve(command);
      expect(definition).toBeDefined();
      const parsed = definition?.parse(input);
      // The bus's next step after parsing: the receipt's hash, which refuses
      // an undefined anywhere in the input (Plan 13, X21; X18's gotcha).
      expect(() => normalizedInputHash(parsed)).not.toThrow();
    },
  );

  test("marking stale carries no reason key at all", () => {
    expect(
      Object.hasOwn(
        workSessionSweepInput("mark_work_session_stale", row),
        "reason",
      ),
    ).toBe(false);
  });

  test("abandoning carries the grace period's reason", () => {
    expect(workSessionSweepInput("abandon_work_session", row)).toEqual({
      organizationId: row.organizationId,
      workSessionId: row.id,
      reason: "Work-session grace period expired",
    });
  });
});
