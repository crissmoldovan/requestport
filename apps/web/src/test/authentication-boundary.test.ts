import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, test } from "vitest";

import { withoutComments } from "./source-text.js";

/**
 * Where the authentication decision is made, relative to where the response is
 * committed.
 *
 * `redirect()` can only become a redirect *status* while nothing has been sent.
 * React finishes everything outside a Suspense boundary first and the server
 * flushes it, so a `loading.tsx` above the segment that decides authentication
 * commits a success status — document shell and all — before the decision
 * exists. What reaches the client after that is a `<meta http-equiv="refresh">`,
 * which a browser honours and nothing else does: the URL is protected, the
 * status says the request succeeded, and the body is the sign-in page.
 *
 * That is not a subtlety of this application. A loading boundary is a promise
 * to paint something *while the answer is still unknown*, and an authentication
 * boundary is a promise not to answer until it is known; no segment can make
 * both promises about the same request. So the rule is positional, and it is
 * read off the tree rather than remembered: find the segment that decides, and
 * refuse a loading boundary above it.
 *
 * Everything the decision does not touch is left alone. A loading boundary in
 * the deciding segment itself is nested *inside* that layout by the App Router
 * and runs after the decision, and a route no gate guards may have one
 * anywhere.
 *
 * The document root's own appearance resolution is untouched by this and has to
 * be: the triple is stamped on `<html>` and replayed through the two blocking
 * head scripts before anything paints, which is what the reskin's no-flash
 * guarantee is. Resolving it costs the request nothing it was not already
 * spending, because nothing may be sent until the decision below it is made.
 */

const webRoot = resolve(import.meta.dirname, "../..");
const appRoot = resolve(webRoot, "src/app");
const libRoot = resolve(webRoot, "src/lib");

/** Where an unauthenticated request is sent, and the call that sends it. */
const signInPath = "/sign-in";
const signInRedirect = new RegExp(`redirect\\(\\s*["']${signInPath}["']`, "u");

/** The App Router file names this rule is about. */
const layoutFile = "layout.tsx";
const pageFile = "page.tsx";
const loadingFile = "loading.tsx";

function posix(path: string): string {
  return path.split(sep).join("/");
}

function sourcesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.includes(".test."),
    )
    .map((entry) => posix(relative(root, join(entry.parentPath, entry.name))))
    .sort();
}

function read(root: string, file: string): string {
  return withoutComments(readFileSync(join(root, file), "utf8"));
}

function quoted(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fileName(file: string): string {
  return file.split("/").at(-1) ?? "";
}

function segmentOf(file: string): string {
  return file.split("/").slice(0, -1).join("/");
}

/** Whether one source calls a name, rather than merely mentioning it. */
export function callsByName(source: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${quoted(name)}\\s*\\(`, "u").test(source);
}

/** Whether one source imports a name, read from its import clauses alone. */
export function importsByName(source: string, name: string): boolean {
  const clause = new RegExp(`(?<![\\w$.])${quoted(name)}(?![\\w$])`, "u");

  return [...source.matchAll(/import\s+([\s\S]*?)\sfrom\s*["'][^"']*["']/gu)]
    .map((match) => match[1] ?? "")
    .some((imported) => clause.test(imported));
}

export type TopLevelDeclaration = Readonly<{
  exported: boolean;
  name: string;
  text: string;
}>;

/**
 * The top-level declarations of one module, each with its own body.
 *
 * Module granularity gets this backwards. The document root imports the
 * appearance boundary, which imports the module that holds the redirect — so a
 * rule that followed imports alone would call the root layout a decider and
 * license the very boundary this suite refuses. What decides is which
 * *declaration* calls which, so a module is cut into its declarations first. A
 * top-level declaration begins in the first column, which is what makes this a
 * reading rather than a guess.
 */
export function topLevelDeclarations(source: string): TopLevelDeclaration[] {
  const lines = source.split("\n");
  const starts: { exported: boolean; from: number; name: string }[] = [];

  lines.forEach((line, index) => {
    const match =
      /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/u.exec(
        line,
      );
    if (match) {
      starts.push({
        exported: match[1] !== undefined,
        from: index,
        name: match[2] ?? "",
      });
    }
  });

  return starts.map((start, position) => ({
    exported: start.exported,
    name: start.name,
    text: lines
      .slice(start.from, starts[position + 1]?.from ?? lines.length)
      .join("\n"),
  }));
}

/**
 * The declarations of one module that reach a named one, through each other.
 *
 * A fixed point rather than a single pass: the gate a surface calls is two
 * declarations away from the redirect — one wraps the load, the next wraps that
 * — and a rule that looked only one step would find neither.
 */
export function declarationsReaching(
  declarations: readonly TopLevelDeclaration[],
  seed: readonly string[],
): string[] {
  const reached = new Set(seed);

  for (let pass = 0; pass < declarations.length; pass += 1) {
    const before = reached.size;
    for (const declaration of declarations) {
      if (reached.has(declaration.name)) continue;
      if ([...reached].some((name) => callsByName(declaration.text, name))) {
        reached.add(declaration.name);
      }
    }
    if (reached.size === before) break;
  }

  return [...reached].filter((name) => !seed.includes(name)).sort();
}

/* ------------------------------------------------------------------ *
 * The tree, as the App Router nests it.
 * ------------------------------------------------------------------ */

export type RouteChain = Readonly<{
  /** Every segment from the document root to the page, outermost first. */
  chain: readonly string[];
  /** How deep the segment that decides authentication is, or `null`. */
  decidesAt: number | null;
  route: string;
}>;

/**
 * Every loading boundary that sits above an authentication decision.
 *
 * A pure function over a described tree, so the rule can be driven by a planted
 * one. A rule that only ever ran against this repository's own tree would
 * answer "nothing is above anything" for a tree with everything above
 * everything, and nobody could tell the two apart.
 */
export function loadingBoundariesAboveDecision(
  routes: readonly RouteChain[],
  loadingSegments: ReadonlySet<string>,
): string[] {
  const above: string[] = [];

  for (const { chain, decidesAt, route } of routes) {
    if (decidesAt === null) continue;
    for (const segment of chain.slice(0, decidesAt)) {
      if (loadingSegments.has(segment)) {
        above.push(`${segment || "."}/${loadingFile} above ${route}`);
      }
    }
  }

  return [...new Set(above)].sort();
}

/* ------------------------------------------------------------------ *
 * The gate, read out of the sources that hold it.
 * ------------------------------------------------------------------ */

const libSources = sourcesUnder(libRoot);
const appSources = sourcesUnder(appRoot);

/** The library module that answers an unauthenticated request. */
const redirectingModules = libSources.filter((file) =>
  signInRedirect.test(read(libRoot, file)),
);

const redirectingDeclarations = redirectingModules.flatMap((file) =>
  topLevelDeclarations(read(libRoot, file))
    .filter((declaration) => signInRedirect.test(declaration.text))
    .map((declaration) => declaration.name),
);

/** The module that carries that declaration to the App Router. */
const gateModules = libSources.filter(
  (file) =>
    !redirectingModules.includes(file) &&
    redirectingDeclarations.some((name) =>
      importsByName(read(libRoot, file), name),
    ),
);

/** The names a rendered surface calls to make the decision happen. */
const gateEntryPoints = gateModules
  .flatMap((file) => {
    const declarations = topLevelDeclarations(read(libRoot, file));
    const reaching = declarationsReaching(
      declarations,
      redirectingDeclarations,
    );

    return declarations
      .filter(
        (declaration) =>
          declaration.exported && reaching.includes(declaration.name),
      )
      .map((declaration) => declaration.name);
  })
  .sort();

/** The rendered surfaces that call one, and therefore are the decision. */
const decidingSurfaces = appSources.filter(
  (file) =>
    (fileName(file) === layoutFile || fileName(file) === pageFile) &&
    gateEntryPoints.some((entry) => callsByName(read(appRoot, file), entry)),
);

const decidingLayoutSegments = new Set(
  decidingSurfaces
    .filter((file) => fileName(file) === layoutFile)
    .map(segmentOf),
);

const loadingSegments = new Set(
  appSources.filter((file) => fileName(file) === loadingFile).map(segmentOf),
);

/**
 * Every route, with the depth at which its request meets the decision.
 *
 * A deciding *layout* answers for its whole segment and everything below it. A
 * deciding *page* answers for itself alone, which is why the two are read
 * separately rather than by the directory they share.
 */
const routeChains: RouteChain[] = appSources
  .filter((file) => fileName(file) === pageFile)
  .map((file) => {
    const segments = segmentOf(file).split("/").filter(Boolean);
    const chain = segments.map((_, depth) =>
      segments.slice(0, depth + 1).join("/"),
    );
    const nested = ["", ...chain];
    const layoutDepth = nested.findIndex((segment) =>
      decidingLayoutSegments.has(segment),
    );
    const decidesAt =
      layoutDepth >= 0
        ? layoutDepth
        : decidingSurfaces.includes(file)
          ? nested.length - 1
          : null;

    return { chain: nested, decidesAt, route: file };
  });

describe("the authentication boundary's position in the tree", () => {
  test("finds the gate by following the redirect to what a surface calls", () => {
    // Every step is checked, because a reading that quietly stopped resolving
    // would report no deciding surface at all — and a tree with no decision in
    // it satisfies the rule below trivially.
    expect(redirectingModules).toEqual(["application-context.ts"]);
    expect(redirectingDeclarations).toEqual(["loadApplicationContext"]);
    expect(gateModules).toEqual(["server-application-context.ts"]);
    expect(gateEntryPoints).toEqual([
      "getApplicationContext",
      "getApplicationLayoutContext",
    ]);
  });

  test("names the surfaces that decide whether a request may be answered", () => {
    // Two layouts decide, each for its own segment: the authenticated group's,
    // and the consent segment's — which exists for that decision alone, so the
    // loading boundary that segment needs can sit below it rather than above.
    expect(decidingSurfaces).toContain(`(app)/${layoutFile}`);
    expect(decidingSurfaces).toContain(`oauth/agent-consent/${pageFile}`);
    expect([...decidingLayoutSegments].toSorted()).toEqual(["(app)", "oauth"]);

    // The negative that proves the reading is by declaration rather than by
    // module: the document root imports the appearance boundary, which imports
    // the module that holds the redirect, and the root layout still does not
    // decide. A rule that followed imports alone would say it did, and would
    // then license a loading boundary in the one segment that must not have
    // one.
    expect(decidingSurfaces).not.toContain(layoutFile);
    expect(loadingSegments.size).toBeGreaterThan(0);
    expect(routeChains.some((route) => route.decidesAt !== null)).toBe(true);
  });

  test("reads a boundary as above a decision, and only when it is", () => {
    // Planted every way the rule can be wrong: a boundary above the decision, a
    // boundary in the deciding segment itself, and a route nothing guards.
    const guarded = {
      chain: ["", "(app)"],
      decidesAt: 1,
      route: `(app)/${pageFile}`,
    };

    expect(loadingBoundariesAboveDecision([guarded], new Set([""]))).toEqual([
      `./${loadingFile} above (app)/${pageFile}`,
    ]);
    expect(
      loadingBoundariesAboveDecision([guarded], new Set(["(app)"])),
    ).toEqual([]);
    expect(
      loadingBoundariesAboveDecision(
        [{ chain: ["", "docs"], decidesAt: null, route: `docs/${pageFile}` }],
        new Set([""]),
      ),
    ).toEqual([]);
  });

  test("keeps every loading boundary below the decision it would pre-empt", () => {
    expect(
      loadingBoundariesAboveDecision(routeChains, loadingSegments),
    ).toEqual([]);
  });
});
