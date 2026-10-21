import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";

import { withoutComments } from "./source-text.js";

/**
 * apps/web's Playwright tree reaches no workspace that apps/web does not
 * depend on (Plan 13, J.6b and J.6c; rulings 184 and 187).
 *
 * The public seed leaves the operator CLI's workspace out. J.6's rehearsal of
 * the seed's gate found the lanes bootstrapping their owner through it by
 * package name, `pnpm --filter <the CLI's package> bootstrap-owner`: in the
 * seed the filter matched nothing, pnpm exited 0, nobody was allowlisted, and
 * 35 cases failed only after waiting out the magic-link budget, on a link that
 * was never sent. A search for
 * the workspace's path could not see a caller that named its package, and
 * the export's own check (`scripts/export-public-tree.mjs`, `contentProblems`)
 * follows import specifiers, not a package name handed to a command as data.
 *
 * J.6b judged only what the gate's four lanes load. J.6c widened it to every
 * file under `tests/`, the sign-in combinations' spec included, which
 * `scripts/run-sign-in-combinations.mjs` runs and no lane loads: until J.6c
 * that spec issued its owner's credential through a `pnpm --filter` call to
 * the same command, which in the seed could only fail.
 *
 * So this reads every string literal in `playwright.config.ts`, in every file
 * under `tests/`, and in every module inside apps/web those files import,
 * wherever the literal sits, and judges two things in it: a `@requestport/…`
 * package name, and a path into a workspace directory, written from the
 * repository's root or relative to the file. Either must name apps/web itself
 * or a workspace apps/web's `package.json` depends on.
 *
 * The rule is "a workspace apps/web depends on" rather than a list of what the
 * seed leaves out, because this suite runs in the seed too, where neither the
 * list (`release/` is not in the seed) nor the workspaces it names exist. The
 * other half is the exporter's: it refuses to write a seed in which a kept
 * `package.json`, apps/web's among them, depends on a workspace the seed
 * leaves out.
 *
 * What it cannot see: a workspace path built from separate segments
 * (`resolve(root, "apps", "x")`), and a pnpm filter written as a pattern
 * rather than a package name or a path.
 */
const webRoot = resolve(import.meta.dirname, "..", "..");
const repositoryRoot = resolve(webRoot, "..", "..");

type PackageManifest = Readonly<{
  name?: unknown;
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
}>;

function readManifest(directory: string): PackageManifest | undefined {
  const path = resolve(directory, "package.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

const webManifest = readManifest(webRoot) ?? {};

/** apps/web's own name, and every package its manifest depends on. */
const reachable = new Set<string>([
  ...(typeof webManifest.name === "string" ? [webManifest.name] : []),
  ...Object.keys(webManifest.dependencies ?? {}),
  ...Object.keys(webManifest.devDependencies ?? {}),
]);

/**
 * Where the walk starts: the configuration, and every file under `tests/`,
 * whatever its name. That holds the four acceptance lanes' `testDir`
 * (`tests/e2e`), the global setup the configuration names
 * (`tests/warm-addresses.ts`), the fixtures, and the sign-in combinations'
 * `testDir` (`tests/sign-in-combinations`). A case below holds every
 * `testDir` and `globalSetup` the configuration names to `tests/`.
 */
const configurationFile = "playwright.config.ts";
const testsDirectory = "tests";
const signInSpecFile = "tests/sign-in-combinations/sign-in-methods.spec.ts";

function toWebPath(absolute: string) {
  return relative(webRoot, absolute).split(sep).join("/");
}

/** Every file under `tests/`, as a path under apps/web. */
function testsFiles(): string[] {
  return readdirSync(resolve(webRoot, testsDirectory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => toWebPath(resolve(entry.parentPath, entry.name)))
    .sort();
}

function walkEntries(): string[] {
  return [configurationFile, ...testsFiles()];
}

/** Every module specifier a source imports or re-exports. */
const moduleSpecifier =
  /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gmu;

function resolveRelativeModule(from: string, specifier: string) {
  const base = resolve(webRoot, dirname(from), specifier);
  const candidates = base.endsWith(".js")
    ? [base.replace(/\.js$/u, ".ts"), base.replace(/\.js$/u, ".tsx"), base]
    : /\.[cm]?[jt]sx?$/u.test(base)
      ? [base]
      : [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")];

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * The files judged: the entries, and every module inside apps/web they reach
 * through relative imports, followed until nothing new turns up. A relative
 * import that leaves apps/web is not followed; its specifier is a string, and
 * the path rule judges it.
 */
function judgedFiles(): string[] {
  const seen = new Set<string>();
  const pending = walkEntries();

  while (pending.length > 0) {
    const file = pending.pop() ?? "";
    if (seen.has(file)) continue;
    seen.add(file);

    const source = withoutComments(
      readFileSync(resolve(webRoot, file), "utf8"),
    );
    for (const match of source.matchAll(moduleSpecifier)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? "";
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelativeModule(file, specifier);
      if (target === undefined) continue;
      const webPath = toWebPath(target);
      if (webPath.startsWith("..")) continue;
      pending.push(webPath);
    }
  }

  return [...seen].sort();
}

/** Every string and template literal a source writes, comments aside. */
const stringLiteral =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

function literalsIn(source: string): string[] {
  return [...withoutComments(source).matchAll(stringLiteral)].map((match) =>
    match[0].slice(1, -1),
  );
}

/**
 * The workspace directory a repository-relative path lies in, or undefined.
 * The four roots are `pnpm-workspace.yaml`'s: `apps/*`, `packages/*`,
 * `spikes/*` and `trigger`.
 */
function workspaceDirectoryOf(path: string): string | undefined {
  const segments = path.split("/").filter((segment) => segment !== "");
  const [root, name] = segments;
  if (root === "trigger") return "trigger";
  if (
    (root === "apps" || root === "packages" || root === "spikes") &&
    name !== undefined &&
    name !== "*"
  ) {
    return `${root}/${name}`;
  }
  return undefined;
}

/**
 * What one literal, written in `file` (a path under apps/web), reaches that
 * apps/web does not depend on. The cases below call it on planted literals
 * first, so the rule is shown to fire before the tree is judged.
 *
 * A path is read from each run of characters between blanks and
 * punctuation, in two ways, and either can report it: one starting `./` or
 * `../` is resolved from the file's directory; and one that starts at a
 * workspace root (`apps/`, `packages/`, `spikes/`, `trigger`) once a leading
 * `./` or `/` is dropped is read from the repository's root: the directory
 * the lanes' old bootstrap ran pnpm in, where `--filter ./apps/…` would name
 * a workspace, and what follows a `${…}` that held it. A workspace directory
 * that is absent, as the seed's excluded ones are, is reported too.
 */
function unreachableIn(file: string, literal: string): string[] {
  const found: string[] = [];

  for (const match of literal.matchAll(/@requestport\/[a-z0-9][a-z0-9_-]*/gu)) {
    if (!reachable.has(match[0])) {
      found.push(
        `${file}: names ${match[0]}, which apps/web does not depend on`,
      );
    }
  }

  for (const token of literal.split(/[\s=,;:"'`{}()[\]]+/u)) {
    const readings: string[] = [];
    if (token.startsWith("./") || token.startsWith("../")) {
      const absolute = resolve(webRoot, dirname(file), token);
      const path = relative(repositoryRoot, absolute).split(sep).join("/");
      if (!path.startsWith("..")) readings.push(path);
    }
    const fromRoot = token.replace(/^\.?\//u, "");
    if (/^(?:apps|packages|spikes)\/|^trigger(?:\/|$)/u.test(fromRoot)) {
      readings.push(fromRoot);
    }

    const directory = readings.map(workspaceDirectoryOf).find((candidate) => {
      if (candidate === undefined || candidate === "apps/web") return false;
      const name = readManifest(resolve(repositoryRoot, candidate))?.name;
      return typeof name !== "string" || !reachable.has(name);
    });
    if (directory !== undefined) {
      found.push(
        `${file}: names the path ${token}, into ${directory}, which apps/web does not depend on`,
      );
    }
  }

  return found;
}

describe("the workspaces apps/web's Playwright tree reaches", () => {
  test("starts under tests/, where every testDir and globalSetup the configuration names lies", () => {
    const configuration = withoutComments(
      readFileSync(resolve(webRoot, configurationFile), "utf8"),
    );
    const named = [
      ...configuration.matchAll(/\b(?:testDir|globalSetup):\s*"([^"]*)"/gu),
    ].map((match) => match[1] ?? "");

    expect(named).toEqual(
      expect.arrayContaining([
        "./tests/e2e",
        "./tests/sign-in-combinations",
        "./tests/warm-addresses.ts",
      ]),
    );
    expect(
      named.filter((path) => !path.startsWith(`./${testsDirectory}/`)),
    ).toEqual([]);
  });

  test("judges every file under tests/, the sign-in combinations' spec and the owner bootstrap among them", () => {
    const files = judgedFiles();

    expect(files).toContain(configurationFile);
    expect(files).toContain("tests/warm-addresses.ts");
    expect(files).toContain("tests/fixtures/auth.ts");
    expect(files).toContain("tests/fixtures/owner-bootstrap.ts");
    expect(files).toContain("tests/fixtures/engine.ts");
    expect(files).toContain(signInSpecFile);
    expect(
      files.filter((file) => file.startsWith(`${testsDirectory}/e2e/`)).length,
    ).toBeGreaterThan(0);
    expect(
      files.filter((file) => file.startsWith(`${testsDirectory}/`)),
    ).toEqual(testsFiles());
  });

  test("reads a reach out of a literal, by package name and by path", () => {
    // Planted, so a rule that matched nothing could not pass the case below.
    const file = "tests/fixtures/example.ts";

    expect(unreachableIn(file, "@requestport/db/testing")).toEqual([]);
    expect(unreachableIn(file, "@requestport/domain")).toEqual([]);
    expect(
      unreachableIn(file, "../../../../docs/implementation/acceptance/x.json"),
    ).toEqual([]);
    expect(
      unreachableIn(file, "node ../../scripts/with-root-env.mjs node x.mjs"),
    ).toEqual([]);
    expect(unreachableIn(file, "../e2e")).toEqual([]);
    expect(unreachableIn(file, "packages/db/src/index.ts")).toEqual([]);

    expect(unreachableIn(file, "@requestport/cli")).toEqual([
      `${file}: names @requestport/cli, which apps/web does not depend on`,
    ]);
    expect(unreachableIn(file, "--filter=@requestport/cli...")).toHaveLength(1);
    expect(unreachableIn(file, "@requestport/evaluator-spike")).toHaveLength(1);
    expect(unreachableIn(file, "apps/cli/src/index.ts")).toEqual([
      `${file}: names the path apps/cli/src/index.ts, into apps/cli, which apps/web does not depend on`,
    ]);
    expect(unreachableIn(file, "../../../cli/src/index.ts")).toEqual([
      `${file}: names the path ../../../cli/src/index.ts, into apps/cli, which apps/web does not depend on`,
    ]);
    expect(unreachableIn(file, "--filter ./apps/cli")).toHaveLength(1);
    expect(unreachableIn(file, `\${root}/apps/cli/src/index.ts`)).toHaveLength(
      1,
    );
    expect(unreachableIn(file, "spikes/evaluator")).toHaveLength(1);
  });

  test("names no workspace apps/web does not depend on, in any file it judges", () => {
    const found = judgedFiles().flatMap((file) =>
      literalsIn(readFileSync(resolve(webRoot, file), "utf8")).flatMap(
        (literal) => unreachableIn(file, literal),
      ),
    );

    expect(found).toEqual([]);
  });
});
