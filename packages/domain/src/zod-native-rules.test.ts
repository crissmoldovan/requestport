import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { nativeZodRules } from "./test-support/zod-native-rules.js";

/*
  Every module of the workspace that parses with zod keeps zod 4.4.3's
  string rules through `shared/zod-compat.ts` (or the copies `config` and
  `client` keep beside their uses), never a native rule zod 4.6.7 answers
  differently. The domain's own walkers (`zod-443-rules.test.ts`) probe the
  schemas they can reach; this reads the source of the rest, apps/web's
  server actions among them, which no test of this package can load.

  Left out: `packages/auth`, whose schemas 0.2.0 already ran on zod 4.5.4,
  whose length, datetime and URL rules 4.6.7 keeps (its one remaining string
  difference is an email pattern in the magic-link preflight's issues, which
  nothing reads); `spikes/`, which nothing publishes; and tests.
*/

const root = fileURLToPath(new URL("../../../", import.meta.url));

function modules(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        ["node_modules", "test-support", "tests", "dist", ".next"].includes(
          entry.name,
        )
      )
        continue;
      found.push(...modules(path));
    } else if (
      /\.(ts|tsx|mts)$/u.test(entry.name) &&
      !/\.test\.|\.d\.ts$/u.test(entry.name)
    ) {
      found.push(path);
    }
  }
  return found;
}

function workspaceSources() {
  const directories = [
    ...["apps", "packages"].flatMap((parent) =>
      existsSync(join(root, parent))
        ? readdirSync(join(root, parent))
            .filter((name) => !(parent === "packages" && name === "auth"))
            .map((name) => join(root, parent, name, "src"))
        : [],
    ),
    join(root, "trigger", "src"),
  ];
  return directories
    .flatMap(modules)
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => /from\s+["']zod(?:\/[\w/]+)?["']/u.test(source));
}

describe("no module of the workspace writes a zod string rule natively", () => {
  test("the reading finds each native rule, and none of zod-compat's", () => {
    const native = [
      'import { z } from "zod";',
      "const title = z.string().trim().max(240);",
      "const key = z.string().min(16);",
      "const name = z.uuid();",
      "const short = name.max(8);",
      "const deadline = z.iso.datetime();",
      "const link = z.url();",
      "const old = z.string().url();",
      "const address = z.string().email();",
      "const counted = z.string().check(z.maxLength(5));",
      "const notes = z.array(z.string()).max(8);",
      "const port = z.number().int().min(2).max(65_535);",
      "const one = z.string().min(1);",
      "const larger = Math.max(1, 2);",
    ].join("\n");
    expect(nativeZodRules(native)).toEqual([
      { line: 2, rule: ".max(240) on a string counts code points" },
      { line: 3, rule: ".min(16) on a string counts code points" },
      { line: 5, rule: ".max(8) on a string counts code points" },
      { line: 6, rule: "z.iso.datetime() requires seconds" },
      { line: 7, rule: "url() removes tabs and newlines" },
      { line: 8, rule: "url() removes tabs and newlines" },
      { line: 9, rule: "email() carries 4.6.7's pattern" },
      { line: 10, rule: "z.maxLength() counts code points" },
    ]);
    const kept = [
      'import { z } from "zod";',
      'import { emailPattern, isoDatetime, trimmedUrl, utf16Max, utf16Min } from "@requestport/domain";',
      "const title = z.string().trim().check(utf16Max(240));",
      "const key = z.string().check(utf16Min(16));",
      "const deadline = isoDatetime();",
      'const link = trimmedUrl().startsWith("https://");',
      "const address = z.string().email({ pattern: emailPattern });",
      "// z.url() and .max(3) in a comment are not code",
      'const text = "z.iso.datetime() in a string is not code";',
    ].join("\n");
    expect(nativeZodRules(kept)).toEqual([]);
  });

  test("none in apps/, packages/ (but auth) or trigger/", () => {
    const sources = workspaceSources();
    expect(sources.length).toBeGreaterThan(50);
    const found = sources.flatMap(({ path, source }) =>
      nativeZodRules(source).map(
        ({ line, rule }) => `${relative(root, path)}:${line} ${rule}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
