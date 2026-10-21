import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import originRule from "./origin-rule.cases.json" with { type: "json" };
import {
  assertBoundProject,
  findProjectFile,
  isBindableServer,
  ProjectBindingError,
  readProjectBinding,
} from "./project.js";

const directories: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-client-"));
  directories.push(root);
  return root;
}

function writeBinding(root: string, value: unknown): void {
  mkdirSync(join(root, ".requestport"), { recursive: true });
  writeFileSync(
    join(root, ".requestport", "project.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

const validBinding = {
  organizationId: "c533d303-b467-421d-bb76-bef05608d496",
  projectId: "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  projectSlug: "orchard",
  server: "https://requestport.com",
};

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { force: true, recursive: true });
  }
});

/**
 * Which project a checkout belongs to, answered by the checkout.
 *
 * The file is found by walking upward the way `git` finds its own directory,
 * because an agent is as likely to start in `apps/web` as at the root and a
 * developer should not have to think about which.
 */
describe("finding the binding", () => {
  test("reads it from the directory it starts in", () => {
    const root = workspace();
    writeBinding(root, validBinding);

    expect(readProjectBinding(root)).toEqual(validBinding);
  });

  test("walks up from a nested directory", () => {
    const root = workspace();
    writeBinding(root, validBinding);
    const nested = join(root, "apps", "web", "src");
    mkdirSync(nested, { recursive: true });

    expect(readProjectBinding(nested)).toEqual(validBinding);
    expect(findProjectFile(nested)).toBe(
      join(root, ".requestport", "project.json"),
    );
  });

  test("stops at the filesystem root rather than searching forever", () => {
    const root = workspace();

    expect(findProjectFile(root)).toBeUndefined();
    expect(() => readProjectBinding(root)).toThrow(ProjectBindingError);
    expect(() => readProjectBinding(root)).toThrow(/no \.requestport/iu);
  });

  test("names the nearest binding when checkouts are nested", () => {
    const outer = workspace();
    writeBinding(outer, validBinding);
    const inner = join(outer, "vendor", "other");
    mkdirSync(inner, { recursive: true });
    writeBinding(inner, { ...validBinding, projectSlug: "other" });

    expect(readProjectBinding(inner).projectSlug).toBe("other");
  });
});

/**
 * A binding file carries identity and never a secret.
 *
 * This is the rule most likely to erode under a "just put the token here"
 * patch, so it is enforced rather than documented: an unknown key is refused
 * outright, which means a token cannot be added without also changing this
 * schema and failing this test.
 */
describe("what a binding may contain", () => {
  test.each([
    ["a token", { ...validBinding, token: "secret" }],
    ["an api key", { ...validBinding, apiKey: "secret" }],
    ["anything unrecognised", { ...validBinding, extra: 1 }],
  ])("refuses %s", (_label, value) => {
    const root = workspace();
    writeBinding(root, value);

    expect(() => readProjectBinding(root)).toThrow(/unexpected/iu);
  });

  test.each([
    ["a missing projectId", { ...validBinding, projectId: undefined }],
    ["a projectId that is not a uuid", { ...validBinding, projectId: "nope" }],
    [
      "a server that is neither https nor loopback http",
      { ...validBinding, server: "http://x.com" },
    ],
    ["a server with a path", { ...validBinding, server: "https://x.com/mcp" }],
  ])("refuses %s", (_label, value) => {
    const root = workspace();
    writeBinding(root, value);

    expect(() => readProjectBinding(root)).toThrow(ProjectBindingError);
  });

  test("refuses a file that is not JSON, without echoing its contents", () => {
    const root = workspace();
    writeBinding(root, "this is not json, and may hold anything at all");

    expect(() => readProjectBinding(root)).toThrow(ProjectBindingError);
    expect(() => readProjectBinding(root)).not.toThrow(/anything at all/u);
  });
});

/**
 * Which server a checkout may be bound to: an origin, https on any host,
 * or http on a host the issuer's loopback rule names.
 *
 * A self-hosted RequestPort serves on `http://127.0.0.1:<port>` or another
 * loopback name, and a checkout has to be able to name it. The rule is
 * manifest-h.md §2.8.1's, for the binding and for `packages/auth`'s issuer
 * check, restated here because neither package may import the other. This
 * suite holds the binding to `origin-rule.cases.json`, row by row, and
 * `packages/auth/src/server-options.origin-rule.test.ts` holds the issuer
 * check to the same table.
 */
describe("the server a binding may name", () => {
  const rows = originRule.cases.map(
    (row) => [row.url, row.accepted, row.why] as const,
  );

  test.each(rows)("answers %j with %s: %s", (url, accepted) => {
    expect(isBindableServer(url)).toBe(accepted);
  });

  test.each(rows)(
    "reads a binding naming %j only when the rule accepts it (%s)",
    (url, accepted) => {
      const root = workspace();
      writeBinding(root, { ...validBinding, server: url });

      if (accepted) {
        expect(readProjectBinding(root).server).toBe(url);
      } else {
        expect(() => readProjectBinding(root)).toThrow(ProjectBindingError);
      }
    },
  );

  /**
   * The shared table is only as good as its rows, and a row deleted from it
   * is one case fewer that the binding and the issuer check are held to,
   * silently. These are the cases manifest-h.md §2.8.1 lists, each
   * over https and over loopback http, and the loopback hosts the issuer's
   * rule names.
   */
  test("holds every refusal the origin rule lists, over https and loopback http", () => {
    for (const kind of [
      "userinfo",
      "password-only",
      "query",
      "empty-query",
      "fragment",
      "empty-fragment",
    ]) {
      const refused = originRule.cases.filter(
        (row) => row.kind === kind && !row.accepted,
      );

      const over = refused.map((row) => {
        const url = new URL(row.url);
        return `${url.protocol}//${url.hostname}`;
      });

      expect(over, kind).toContain("https://requestport.com");
      expect(over, kind).toContain("http://127.0.0.1");
    }

    const loopback = originRule.cases
      .filter((row) => row.kind === "loopback" && row.accepted)
      .map((row) => new URL(row.url).hostname);

    expect(loopback).toEqual(
      expect.arrayContaining([
        "127.0.0.2",
        "localhost",
        "rp.localhost",
        "[::1]",
      ]),
    );
    expect(
      originRule.cases.find((row) => row.url === "https://requestport.com")
        ?.accepted,
    ).toBe(true);
  });

  test.each([
    "https://requestport.com/mcp",
    "http://127.0.0.1:3000/api/v1",
    "http://rp.localhost:3000/mcp",
    "https://requestport.com//",
  ])(
    "refuses %j, because a binding names an origin and never a path",
    (url) => {
      expect(isBindableServer(url)).toBe(false);
    },
  );

  /**
   * `blob:https://host/…` has the origin `https://host`, so a rule that read
   * only the origin would bind a checkout to the https server through a URL
   * that is not one. The scheme is what refuses it.
   */
  test("refuses a blob: URL, whatever origin it wraps", () => {
    expect(isBindableServer("blob:https://requestport.com/0b5c")).toBe(false);
  });

  /**
   * The file is committed. A password in the server URL is a secret in the
   * repository, and the refusal is the moment someone pastes the error
   * somewhere to ask why: it must say what is wrong without repeating it.
   */
  test("refuses a password in the server without repeating it", () => {
    const root = workspace();
    writeBinding(root, {
      ...validBinding,
      server: "https://alice:hunter2-not-for-the-log@requestport.com",
    });

    expect(() => readProjectBinding(root)).toThrow(/user name or password/u);
    expect(() => readProjectBinding(root)).not.toThrow(/hunter2/u);
  });
});

/**
 * The assertion that makes the two halves check each other.
 *
 * A credential names one project and so does the file. When they disagree the
 * honest answers are both bad — file work against the wrong project, or refuse
 * — and refusing is the one that can be corrected.
 */
describe("agreement between the file and the credential", () => {
  test("accepts a whoami that names the bound project", () => {
    expect(() =>
      assertBoundProject(validBinding, { projectId: validBinding.projectId }),
    ).not.toThrow();
  });

  test("refuses a whoami for another project, naming both", () => {
    const other = "11111111-2222-3333-4444-555555555555";

    expect(() =>
      assertBoundProject(validBinding, { projectId: other }),
    ).toThrow(new RegExp(validBinding.projectId, "u"));
    expect(() =>
      assertBoundProject(validBinding, { projectId: other }),
    ).toThrow(new RegExp(other, "u"));
  });
});
