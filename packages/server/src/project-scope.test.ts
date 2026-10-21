import { DomainError } from "@requestport/domain";
import { expect, test } from "vitest";

import { withProject } from "./project-scope.js";

test("hands back a context that names a project, unchanged but for its type", () => {
  const context = { projectId: "project-1", scopes: new Set(["request:read"]) };

  const scoped = withProject(context);

  expect(scoped).toEqual(context);
  expect(scoped).not.toBe(context);
  expect(scoped.projectId).toBe("project-1");
});

test.each([
  ["null", null],
  ["undefined", undefined],
  ["empty", ""],
])(
  "refuses a context whose project is %s, as forbidden",
  (_name, projectId) => {
    const refusal = (() => {
      try {
        withProject({ projectId });
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({
      code: "forbidden",
      message:
        "This credential is not bound to a project, so it cannot reach project data",
    });
  },
);
