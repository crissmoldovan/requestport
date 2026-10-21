import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  canonicalizeGitHubRepository,
  normalizeName,
  projectRegistrationCommandName,
  projectRegistrationInputSchema,
} from "../index.js";

/**
 * The validation `projectRegistrationRepository.register` performs before it
 * opens a transaction (packages/db/src/repositories/
 * project-registration-repository.ts), restated with the same two domain
 * functions it calls. The domain package cannot import `@requestport/db`, so
 * this is a transcription, not a call; the schema is held to it below.
 */
function repositoryAccepts(input: Record<string, unknown>) {
  try {
    const alias = input.alias === undefined ? null : normalizeName(input.alias);
    const repository =
      input.repositoryUrl === undefined
        ? null
        : canonicalizeGitHubRepository(input.repositoryUrl);
    return Boolean(alias || repository);
  } catch {
    return false;
  }
}

const cases: Array<[string, Record<string, unknown>]> = [
  ["alias only", { alias: "api" }],
  ["alias with surrounding space", { alias: "  api  " }],
  ["repository only", { repositoryUrl: "https://github.com/acme/api" }],
  [
    "repository with .git",
    { repositoryUrl: "https://github.com/acme/api.git" },
  ],
  [
    "repository in upper case",
    { repositoryUrl: "HTTPS://GITHUB.COM/acme/api" },
  ],
  ["repository on :443", { repositoryUrl: "https://github.com:443/acme/api" }],
  ["both", { alias: "api", repositoryUrl: "https://github.com/acme/api" }],
  ["unknown key beside a valid alias", { alias: "api", note: "x" }],
  ["neither", {}],
  ["only unknown keys", { note: "x" }],
  ["alias null", { alias: null }],
  ["alias empty", { alias: "" }],
  ["alias whitespace", { alias: "   " }],
  ["alias too long", { alias: "a".repeat(121) }],
  ["alias control character", { alias: "a\u0007b" }],
  ["alias a number", { alias: 7 }],
  ["repository null", { repositoryUrl: null }],
  ["repository query", { repositoryUrl: "https://github.com/acme/api?x=1" }],
  ["repository not GitHub", { repositoryUrl: "https://gitlab.com/acme/api" }],
  ["repository deep path", { repositoryUrl: "https://github.com/acme/api/x" }],
  [
    "repository with credentials",
    { repositoryUrl: "https://u:p@github.com/acme/api" },
  ],
  ["repository percent", { repositoryUrl: "https://github.com/acme/a%20b" }],
  ["valid alias, invalid repository", { alias: "api", repositoryUrl: "x" }],
  [
    "invalid alias, valid repository",
    { alias: "", repositoryUrl: "https://github.com/acme/api" },
  ],
];

describe("register_project input schema", () => {
  test("names the REST and MCP command it describes", () => {
    expect(projectRegistrationCommandName).toBe("register_project");
  });

  test.each(cases)(
    "%s: accepts exactly what the repository accepts",
    (_, input) => {
      expect(projectRegistrationInputSchema.safeParse(input).success).toBe(
        repositoryAccepts(input),
      );
    },
  );

  test("the table exercises both answers", () => {
    const answers = new Set(cases.map(([, input]) => repositoryAccepts(input)));
    expect(answers).toEqual(new Set([true, false]));
  });

  test("validates without normalizing: the repository normalizes", () => {
    expect(projectRegistrationInputSchema.parse({ alias: "  api  " })).toEqual({
      alias: "  api  ",
    });
  });

  test("converts to JSON Schema naming both optional fields", () => {
    const json = z.toJSONSchema(projectRegistrationInputSchema, {
      io: "input",
    });
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "alias",
      "repositoryUrl",
    ]);
    expect(json.required ?? []).toEqual([]);
  });
});
