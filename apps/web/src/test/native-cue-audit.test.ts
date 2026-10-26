import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  auditStylesheet,
  auditWorkspace,
  type CueAuditViolation,
  classTokenForms,
  cueAuditRules,
  cueFocusRingComposition,
  documentedCueComponents,
  focusRingCompositionOf,
  formatViolation,
  governedScaleFamilies,
  inertClassTokenForms,
  isApplicationModule,
  outlineTransitionClasses,
  parseClassToken,
  productionAuditTargets,
  shadowedTokenProperties,
  smallestCueSubpath,
  utilityClassTokenForms,
} from "./native-cue-audit.js";
import {
  allowedMediaThresholds,
  forbiddenAllowlistProperties,
  isForbiddenAllowlistProperty,
  isReviewableScaleUtility,
  providerBoundaryModules,
  reviewableScaleFamilies,
  reviewedAuditLimits,
  reviewedInlineStyleProps,
  reviewedLocalSvgModules,
  reviewedScaleUtilities,
  type StyleAllowlistTuple,
  styleAllowlist,
  ungovernedScaleFamilies,
  unreadClassConditions,
} from "./ui-style-allowlist.js";

const webRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const repositoryRoot = resolve(webRoot, "../..");
const fixtureRoot = resolve(webRoot, "test-fixtures/native-cue-audit");

function fixtureAudit(
  providerBoundaries?: readonly string[],
  reviewedTuples?: readonly StyleAllowlistTuple[],
) {
  return auditWorkspace({
    providerBoundaryModules: providerBoundaries,
    repositoryRoot,
    styleAllowlist: reviewedTuples,
    targets: [
      {
        sourceRoot: fixtureRoot,
        tsconfig: resolve(fixtureRoot, "tsconfig.json"),
      },
    ],
  });
}

/**
 * A retired recipe class, assembled rather than spelled.
 *
 * This suite is scanned by the audit it defines, and the class rules read every
 * string literal in a module rather than only the ones under a `className`.
 * Writing a recipe class out here would make the suite fail the contract it
 * exists to lock — the same reason `ui-style-allowlist.ts` assembles the one
 * inline-style tuple it records.
 */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

/**
 * A Tailwind scale utility, and the radius family, assembled rather than
 * spelled.
 *
 * Same reason as {@link recipeClass}: this suite is scanned by the audit it
 * defines, and `p-4` and a bare `rounded` are governed tokens wherever they are
 * written. The expectation lines above carry a `|`, which no class name may, so
 * those are already bookkeeping rather than classes — these are the ones that
 * would otherwise be both.
 */
const radiusFamily = ["round", "ed"].join("");

function scaleUtility(family: string, rung: string): string {
  return `${family}-${rung}`;
}

/**
 * Every whitespace-separated token inside a quoted *run* of one source text.
 *
 * A run rather than a string literal, and the distance between those two words
 * is this function's whole honest content. The runs are matched rather than
 * parsed, and the match is line-scoped, because the two quote spellings admit
 * no bare newline and neither does a JavaScript string literal. So an
 * apostrophe standing outside a literal — in JSX text, in prose, in a name —
 * opens a run of its own and reads the real literal after it on that line as
 * that run's contents. The token the module wrote is then never assembled at
 * all, and no caller of this function can ask about a token it never saw.
 *
 * Reading literals rather than runs means lexing TypeScript and JSX, which is
 * exactly what {@link writtenClassTokens} declines to do and says why. The
 * consequence is pinned by this suite and recorded in `ui-style-allowlist.ts`,
 * because it bounds every claim the compiler oracle makes.
 */
function classTokensInSource(source: string): string[] {
  const tokens: string[] = [];

  for (const match of source.matchAll(
    /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gsu,
  )) {
    for (const token of (match[1] ?? match[2] ?? match[3] ?? "").split(
      /\s+/u,
    )) {
      if (token.length > 0) tokens.push(token);
    }
  }

  return tokens;
}

/**
 * Every whitespace-separated token this repository writes inside a string
 * literal, across all three roots the audit's class rules can reach.
 *
 * Read with a lexer rather than through the TypeScript program on purpose: the
 * point of the totality proof is that *nothing* escapes the parser, so the
 * corpus it runs over should be wider than the one the scan reads, not
 * narrower. `apps/web/tests` is outside the web project's `include`, and it is
 * exactly the sort of place a spelling nobody classified would be found.
 *
 * Wider in reach, and not wider in every direction: the lexer is
 * {@link classTokensInSource}, which is line-scoped, so a literal sharing a
 * line with an earlier bare apostrophe never reaches this corpus. That is a
 * real hole rather than a theoretical one, and it is the reason the oracle
 * below cannot be read as a tripwire for tokens nobody has written yet.
 */
function writtenClassTokens(): string[] {
  const tokens = new Set<string>();

  for (const root of ["src", "tests", "test-fixtures"]) {
    const directory = resolve(webRoot, root);
    for (const entry of readdirSync(directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) continue;
      for (const token of classTokensInSource(
        readFileSync(join(entry.parentPath, entry.name), "utf8"),
      )) {
        tokens.add(token);
      }
    }
  }

  return [...tokens];
}

/** The stylesheet the installed Tailwind emits for exactly these candidates. */
async function emittedStylesheet(
  candidates: readonly string[],
): Promise<string> {
  const { compile } = await import("tailwindcss");
  const require = createRequire(resolve(webRoot, "package.json"));
  const compiled = await compile(
    '@import "tailwindcss";\n@import "@cueplusplus/ui/styles.css";',
    {
      base: webRoot,
      loadModule: () => {
        throw new Error("cue-audit-oracle-loads-no-modules");
      },
      loadStylesheet: async (id: string, base: string) => {
        const path = id.startsWith(".")
          ? resolve(base, id)
          : require.resolve(id.endsWith(".css") ? id : `${id}/index.css`, {
              paths: [base],
            });

        return {
          base: dirname(path),
          content: readFileSync(path, "utf8"),
          path,
        };
      },
    },
  );

  return compiled.build([...candidates]);
}

/**
 * Which of these candidates the installed Tailwind compiles into CSS, named.
 *
 * The whole set is compiled first, because the answer is almost always "none"
 * and one compile answers that. Only when the set does emit something is each
 * candidate compiled on its own — so the ordinary run costs one build and the
 * failing run says *which token* reached the stylesheet rather than handing a
 * reviewer two 200KB stylesheets to diff.
 */
async function compilingTokens(
  candidates: readonly string[],
): Promise<string[]> {
  const baseline = await emittedStylesheet([]);
  if ((await emittedStylesheet(candidates)) === baseline) return [];

  const compiling: string[] = [];
  for (const candidate of candidates) {
    if ((await emittedStylesheet([candidate])) !== baseline) {
      compiling.push(candidate);
    }
  }

  return compiling.sort();
}

/** `rule|detail` for one fixture file, sorted — the file name is the key. */
function forFixture(violations: readonly CueAuditViolation[], name: string) {
  return violations
    .filter((violation) => violation.file.endsWith(`/${name}`))
    .map((violation) => `${violation.rule}|${violation.detail}`)
    .sort();
}

describe("audit vocabulary", () => {
  test("closes the rule vocabulary at the reviewed, sorted set", () => {
    expect([...cueAuditRules]).toEqual([
      "anchor-focus-contract",
      "appearance-type-cast",
      "application-style-prop",
      "arbitrary-class-value",
      "as-child",
      "cue-import-subpath",
      "legacy-class",
      "legacy-import",
      "local-svg",
      "local-theme-block",
      "raw-color-declaration",
      "raw-geometry-declaration",
      "raw-visible-control",
      "stylesheet-import-order",
      "token-shadow-declaration",
      "undocumented-cue-component",
      "untokenized-class-value",
      "unverified-variant",
    ]);
  });

  test("keeps the asChild rule on the modules the application ships", () => {
    // A DOM suite that mounts the verified provider to drive a real portal is
    // exercising that boundary, not opening a second one — the same exclusion
    // the document-wide contract in `src/app/framework-boundaries.test.tsx`
    // makes for test suites.
    expect(isApplicationModule("apps/web/src/app/appearance-root.tsx")).toBe(
      true,
    );
    expect(
      isApplicationModule(
        "apps/web/src/test/cue-interaction-contract.dom.test.tsx",
      ),
    ).toBe(false);
  });

  test("formats a violation as one sortable line", () => {
    expect(
      formatViolation({
        detail: recipeClass("button"),
        file: "apps/web/src/components/app-shell.tsx",
        rule: "legacy-class",
      }),
    ).toBe("legacy-class|apps/web/src/components/app-shell.tsx|ui-button");
  });
});

describe("installed package contracts the audit reads", () => {
  test("resolves the smallest exported subpath for a declaration", () => {
    expect(smallestCueSubpath("dist/primitives/button.d.ts")).toBe(
      "@cueplusplus/ui/primitives",
    );
    expect(smallestCueSubpath("dist/system/theme-provider.d.ts")).toBe(
      "@cueplusplus/ui/system",
    );
    expect(smallestCueSubpath("dist/layout/resizable.d.ts")).toBe(
      "@cueplusplus/ui/layout/resizable",
    );
    expect(smallestCueSubpath("dist/index.d.ts")).toBe("@cueplusplus/ui");
  });

  test("knows every documented component, subcomponent, and system API", () => {
    const documented = documentedCueComponents();

    expect(documented.has("Button")).toBe(true);
    expect(documented.has("Table.Root")).toBe(true);
    expect(documented.has("ThemeProvider")).toBe(true);
    expect(documented.has("RequestPortPanel")).toBe(false);
  });

  test("guards every custom property the installed stylesheet declares", () => {
    // The manifest's three lists are not the published surface. `colorTokens`,
    // `geometryTokens` and the `utilityMap` are the names the *bridge* maps —
    // the token layer declares more that no bridge key reaches, and a
    // guard built from the three lists alone let every one of them be
    // redeclared by an application rule. An unlayered `--cue-radius-full: 0`
    // flattens every pill in the document on all nine themes, breaks no colour
    // rule and no geometry rule, and the whole suite stayed green.
    //
    // The set is therefore read from the stylesheet the package actually ships
    // rather than from a document about it. Each is named so the
    // derivation stays falsifiable: a reader that quietly stopped following the
    // `@import` chain would report the manifest's names and look correct.
    const shadowable = shadowedTokenProperties();
    const unguarded = [
      "--cue-border-width",
      "--cue-border-width-hairline",
      "--cue-ease-out",
      "--cue-focus-ring",
      "--cue-focus-ring-offset",
      "--cue-font-display",
      "--cue-font-pairing-mono",
      "--cue-font-sans",
      "--cue-icon-stroke",
      "--cue-radius-full",
      "--cue-tracking-label",
      "--cue-transition-base",
      "--cue-transition-fast",
    ].filter((name) => !shadowable.has(name));

    expect(unguarded).toEqual([]);
    // The bridge names stay in the set as well: the stylesheet declares them in
    // its `@theme inline` block, and an application rule that redeclares
    // `--radius-control` outranks that block exactly as it outranks the theme.
    expect(shadowable.has("--radius-control")).toBe(true);
    expect(shadowable.has("--cue-radius-control")).toBe(true);
  });
});

/**
 * The published preamble every application stylesheet has to open with, so a
 * test about declarations is written over a stylesheet that already conforms
 * rather than over a fragment the import rule would rightly reject.
 */
const publishedPreamble = [
  '@import "tailwindcss";',
  '@import "@cueplusplus/ui/styles.css";',
  "",
].join("\n");

function auditFragment(css: string) {
  return auditStylesheet(`${publishedPreamble}${css}`, "x.css");
}

describe("stylesheet rules", () => {
  test("reads a raw colour and a raw length out of a declaration", () => {
    expect(
      auditFragment(".panel { background: #101315; padding: 12px; }"),
    ).toEqual([
      {
        detail: ".panel{background:#101315}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
      {
        detail: ".panel{padding:12px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("reads a negative length, and never an identifier that looks like one", () => {
    // A sign is part of the length, not a reason to stop looking: `margin: -1px`
    // writes raw geometry exactly as `margin: 1px` does. The boundary that must
    // hold either way is the identifier one — the `2rem` inside a custom
    // property name is a name, not a measurement.
    expect(
      auditFragment(
        ".inset { margin: -1px; margin-left: -18px; padding: var(--gap-2rem); }",
      ),
    ).toEqual([
      {
        detail: ".inset{margin:-1px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
      {
        detail: ".inset{margin-left:-18px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("reads a nesting rule's own declarations, not only its inner block", () => {
    // Native nesting is ordinary Tailwind v4 CSS. A reader that only ever sees
    // the innermost block exempts every rule that contains one, which is the
    // largest hole a stylesheet can hide a raw ground colour in.
    expect(
      auditFragment(".nested { color: #fff; &:hover { color: #000; } }"),
    ).toEqual([
      {
        detail: ".nested{color:#fff}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
      {
        detail: ".nested &:hover{color:#000}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
    ]);
  });

  test("reads a brace inside a quoted value as text rather than punctuation", () => {
    // A value is not punctuation. A `}` inside a string closed the rule early
    // and dropped every declaration written after it, and a `{` pushed a block
    // nobody wrote — so the rest of the rule was judged against a selector
    // nobody wrote either. Both are silent: the stylesheet still parses, and
    // the scan simply stops seeing what the rule actually declares.
    expect(auditFragment('.a { content: "}"; color: #ff0000; }')).toEqual([
      {
        detail: ".a{color:#ff0000}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
    ]);
    expect(auditFragment('.b { content: "{"; padding: 12px; }')).toEqual([
      {
        detail: ".b{padding:12px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("recovers from a quote nothing closes rather than going blind", () => {
    // An apostrophe in a font stack is ordinary CSS, and it opens a string
    // nothing closes. Without recovery the reader stayed inside that string to
    // the end of the file and reported nothing after it — one apostrophe
    // silently retiring the rest of the stylesheet from the scan.
    //
    // CSS's own rule is the fix: an unescaped newline in a string is a parse
    // error that ends it. So the cost of a stray quote is the line it is on,
    // and the declaration it merges with is still read — the `;` inside the
    // string is text, exactly as a browser reads it, so the raw colour is
    // reported against the merged declaration rather than lost.
    expect(
      auditFragment(
        ".y {\n  font-family: Rock'nRoll;\n  color: #ff0000;\n}\n\n.z {\n  padding: 6px;\n}",
      ),
    ).toEqual([
      {
        detail: ".y{font-family:Rock'nRoll; color: #ff0000}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
      {
        detail: ".z{padding:6px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("reads a comment delimiter inside a string as text", () => {
    // Valid CSS, and the trap is in the layer *before* the walker: a comment
    // stripper that does not know about strings deletes from this `/*` to the
    // next real `*/`, taking two whole rules with it and leaving an odd quote
    // behind for the walker to go blind on. Both layers have to know what a
    // string is, or neither does.
    expect(
      auditFragment(
        '.r { content: "/*"; color: #ff0000; }\n.s { color: #00ff00; }\n/* real */\n.t { padding: 9px; }',
      ),
    ).toEqual([
      {
        detail: ".r{color:#ff0000}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
      {
        detail: ".s{color:#00ff00}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
      {
        detail: ".t{padding:9px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("never opens a string inside a comment, or ends one at an escaped newline", () => {
    // The ordering dependency, pinned: prose is stripped before the walker
    // runs and the stripper skips it without reading it, so an apostrophe in
    // "Tailwind v4's own way" opens nothing in either layer.
    expect(
      auditFragment("/* Tailwind v4's own way */\n.c { color: #ff0000; }"),
    ).toEqual([
      {
        detail: ".c{color:#ff0000}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
    ]);
    // The other side of the recovery rule: a newline escaped with a backslash
    // legally continues a string, so the brace after it is still text and the
    // rule it is written in stays open.
    expect(auditFragment('.e { content: "a\\\n}"; padding: 12px; }')).toEqual([
      {
        detail: ".e{padding:12px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("keeps an at-rule out of the nested selector path it wraps", () => {
    expect(
      auditFragment("@media (min-width: 40rem) { .a { padding: 12px; } }"),
    ).toEqual([
      {
        detail: ".a{padding:12px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
    // `@starting-style` names when a declaration applies — the first style of a
    // transition — not a place in the document, and it wraps rules exactly as
    // the other five conditions do. Reading it as a place wrote its name into
    // the selector path of everything it holds, in both spellings: wrapped
    // around a rule, and nested inside the one it starts.
    expect(auditFragment("@starting-style { .a { padding: 12px; } }")).toEqual([
      {
        detail: ".a{padding:12px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
    expect(
      auditFragment(
        ".card { padding: 12px; @starting-style { padding: 4px; } }",
      ),
    ).toEqual([
      {
        detail: ".card{padding:12px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
      {
        detail: ".card{padding:4px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("judges a declaration written directly inside a declaration at-rule", () => {
    // Tailwind v4 declares design tokens in `@theme`, and `@property`,
    // `@font-face` and `@counter-style` carry declarations at at-rule level
    // too. Giving every at-rule an empty selector path discarded all of them,
    // which is precisely the blanket extension exemption §14.3 forbids:
    // `:root { --page-form: 42rem }` needs a reviewed tuple to survive the
    // scan, so the byte-identical `@theme { --page-form: 42rem }` cannot be
    // free.
    expect(
      auditFragment(
        "@theme { --color-ground: #101315; --spacing-tight: 3px; }",
      ),
    ).toEqual([
      {
        detail: "@theme{--color-ground:#101315}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
      {
        detail: "@theme{--spacing-tight:3px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
    expect(
      auditFragment(
        '@property --shade { syntax: "<color>"; inherits: false; initial-value: #ff0000; }',
      ),
    ).toEqual([
      {
        detail: "@property --shade{initial-value:#ff0000}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
    ]);
  });

  test("judges an at-rule nobody named rather than exempting it", () => {
    // Only the conditional group rules name a condition instead of a place, and
    // only they contribute nothing to the path. Everything else is judged, so a
    // Tailwind v4 `@utility` — or whatever a future CSS ships — cannot buy an
    // exemption by being unfamiliar.
    expect(
      auditFragment(
        "@supports (display: grid) { @layer base { .b { color: #111; } } }",
      ),
    ).toEqual([
      {
        detail: ".b{color:#111}",
        file: "x.css",
        rule: "raw-color-declaration",
      },
    ]);
    expect(auditFragment("@utility tight { padding: 3px; }")).toEqual([
      {
        detail: "@utility tight{padding:3px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("judges a declaration a condition is the only thing wrapping", () => {
    // A bare declaration at conditional-group-rule level applies nothing in a
    // browser, but "no browser reads it" is a rationalisation, not a rule. The
    // condition is then the nearest place the declaration is written in, and it
    // is reported against that — while the same condition wrapping a real rule
    // still stays out of that rule's path.
    expect(auditFragment("@media print { --page-form: 42rem; }")).toEqual([
      {
        detail: "@media print{--page-form:42rem}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("never mistakes an appearance mode keyword for a colour", () => {
    expect(
      auditFragment(
        ":root { color-scheme: light dark; background: var(--cue-bg); }",
      ),
    ).toEqual([]);
  });

  test("permits only the three reviewed responsive thresholds", () => {
    expect(allowedMediaThresholds).toEqual(["40rem", "56.25rem", "75rem"]);
    expect(
      auditFragment("@media (min-width: 40rem) { .a { gap: 0; } }"),
    ).toEqual([]);
    expect(
      auditFragment("@media (max-width: 899px) { .a { gap: 0; } }"),
    ).toEqual([
      {
        detail: "@media{max-width:899px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
    ]);
  });

  test("rejects a stylesheet that never imports the published styles", () => {
    // An absent import pair is the failure mode the rule exists to catch: a
    // stylesheet that forgets `@cueplusplus/ui/styles.css` ships an unstyled
    // surface, and it does so while spelling nothing wrong. Treating "no
    // imports" as conforming made the rule unable to say so.
    expect(auditStylesheet(".panel { display: grid; }", "x.css")).toEqual([
      {
        detail: "(no leading import)",
        file: "x.css",
        rule: "stylesheet-import-order",
      },
    ]);
    expect(
      auditStylesheet(
        '@import "tailwindcss";\n.panel { display: grid; }',
        "x.css",
      ),
    ).toEqual([
      {
        detail: '@import "tailwindcss";',
        file: "x.css",
        rule: "stylesheet-import-order",
      },
    ]);
  });

  test("requires the published pair at the top, not merely somewhere", () => {
    // The plan's global constraint is about what the stylesheet *begins* with.
    // A rule that collected the first two `@import` statements found anywhere
    // passed a file that opened with its own rules and only then wrote the
    // pair — and a browser applies an `@import` after a rule not at all, so
    // that file ships the console with no token layer while the gate is green.
    expect(
      auditStylesheet(
        '.panel { display: grid; }\n@import "tailwindcss";\n@import "@cueplusplus/ui/styles.css";',
        "x.css",
      ),
    ).toEqual([
      {
        detail: "(no leading import)",
        file: "x.css",
        rule: "stylesheet-import-order",
      },
    ]);
    // A comment and blank lines before the pair are not a rule, and CSS lets an
    // `@import` follow either.
    expect(
      auditStylesheet(
        `/* the published preamble */\n\n${publishedPreamble}.panel { display: grid; }`,
        "x.css",
      ),
    ).toEqual([]);
  });

  test("lets a partial carry no preamble, and forbids it a second one", () => {
    // A stylesheet another stylesheet imports is a fragment of the document
    // that already opened with the pair. Re-importing Tailwind and the CUE++
    // styles there duplicates the whole token layer; being made to do it is
    // what a mandatory preamble on every `.css` file would require.
    expect(
      auditStylesheet(".panel { display: grid; }", "x.css", { entry: false }),
    ).toEqual([]);
    expect(
      auditStylesheet(
        `${publishedPreamble}.panel { display: grid; }`,
        "x.css",
        {
          entry: false,
        },
      ),
    ).toEqual([
      {
        detail: 'imported partial re-imports @import "tailwindcss";',
        file: "x.css",
        rule: "stylesheet-import-order",
      },
    ]);
  });

  test("reports an app rule that redeclares a published token name", () => {
    // The exact defect this rule exists for. Tailwind emits the token bridge
    // inside `@layer theme`, and an unlayered `:root` beats every layer — so
    // `--radius-control: 3px` here silently overrode
    // `calc(var(--cue-radius-control) * var(--cue-radius-scale))` for the 48
    // installed CUE++ files that read it, flattening every control corner to
    // one value on every theme. Nothing else in the scan could see it: the
    // declaration breaks no colour rule, and the geometry rule it does break
    // would be satisfied by writing the same shadow token-valued.
    expect(auditFragment(":root { --radius-control: 3px; }")).toEqual([
      {
        detail: ":root{--radius-control:3px}",
        file: "x.css",
        rule: "raw-geometry-declaration",
      },
      {
        detail: ":root{--radius-control}",
        file: "x.css",
        rule: "token-shadow-declaration",
      },
    ]);
    // Token-valued is no defence: the shadow is the name, not the value.
    expect(auditFragment(":root { --cue-bg: var(--cue-surface-1); }")).toEqual([
      {
        detail: ":root{--cue-bg}",
        file: "x.css",
        rule: "token-shadow-declaration",
      },
    ]);
    // Reading a token is the whole point of the contract, and declaring a name
    // the package does not publish is ordinary app-owned CSS.
    expect(
      auditFragment(".panel { --panel-seam: var(--cue-border); }"),
    ).toEqual([]);
  });

  test("takes the shadowable names from the installed token manifest", () => {
    // Not from memory, and not from a list restated here: the names are the
    // ones `@cueplusplus/tokens` actually emits, read from the companion
    // document the package-contract suite verifies against the manifest hash.
    const shadowable = shadowedTokenProperties();

    expect(shadowable.has("--cue-bg")).toBe(true);
    expect(shadowable.has("--cue-radius-control")).toBe(true);
    expect(shadowable.has("--radius-control")).toBe(true);
    expect(shadowable.has("--color-fg-subtle")).toBe(true);
    expect(shadowable.has("--page-form")).toBe(false);
  });

  test("reports a second theme block, and no other attribute selector", () => {
    // The package owns the `requestport` preset. A local block keyed on the
    // same attribute is a second, hand-maintained copy that drifts from it, and
    // it can be written entirely in tokens — so no colour or geometry rule ever
    // sees it.
    expect(
      auditFragment(
        '[data-theme="requestport"] { --cue-bg: var(--cue-neutral-950); }\n' +
          "[data-density] .row { display: grid; }\n" +
          '.panel[data-state="open"] { display: block; }',
      ),
    ).toEqual([
      {
        detail: '[data-theme="requestport"]',
        file: "x.css",
        rule: "local-theme-block",
      },
      { detail: "[data-density]", file: "x.css", rule: "local-theme-block" },
      // The same block seen by the other rule it breaks: a hand-maintained
      // preset redeclares the very names the package publishes, which is what
      // makes it a copy rather than an extension.
      {
        detail: '[data-theme="requestport"]{--cue-bg}',
        file: "x.css",
        rule: "token-shadow-declaration",
      },
    ]);
  });

  test("reports a retired recipe selector even when its values are tokens", () => {
    // A token-valued `.ui-*` rule breaks none of the colour or geometry rules,
    // so without a selector rule the retired recipe system could survive the
    // scan intact — which is exactly the surface Task 11 has to remove.
    const callout = recipeClass("callout");
    const calloutTitle = recipeClass("callout", "title");

    expect(
      auditFragment(
        `.${callout} { background: var(--cue-bg-raised); }\n` +
          `.panel .${calloutTitle} { color: var(--cue-fg); }`,
      ),
    ).toEqual([
      { detail: callout, file: "x.css", rule: "legacy-class" },
      { detail: calloutTitle, file: "x.css", rule: "legacy-class" },
    ]);
  });
});

describe("the raw-length allowlist", () => {
  test("reviews no raw local layout length at all", () => {
    // Task 11 replaced the stylesheet that owned the two bounded page widths,
    // and the native `PageShell` owns the measure now — so the reviewed list is
    // empty, and staying empty is the contract, exactly as it is for the inline
    // `style` props below. An entry here is a second design system's first
    // line, and the guard rails around it stay in force whether or not one is
    // ever added back.
    //
    // Empty is not the same as untested. The mechanism this list is the default
    // for has its own positive case in "licenses exactly the reviewed tuple"
    // below, where the fixture run passes a tuple and the matcher is measured
    // in all three of its parts — because against no entries an exact matcher
    // and a broken one are the same function.
    expect([...styleAllowlist]).toEqual([]);
    for (const tuple of styleAllowlist) {
      expect(isForbiddenAllowlistProperty(tuple.property)).toBe(false);
    }
  });

  test("can never be widened to a colour, type, or spacing property", () => {
    expect([...forbiddenAllowlistProperties]).toEqual([
      "color",
      "control",
      "font",
      "gap",
      "icon",
      "margin",
      "padding",
      "radius",
    ]);
    for (const property of [
      "color",
      "background-color",
      "font-size",
      "border-radius",
      "padding",
      "padding-inline",
      "margin",
      "margin-block-start",
      "gap",
      "column-gap",
    ]) {
      expect({
        forbidden: isForbiddenAllowlistProperty(property),
        property,
      }).toEqual({ forbidden: true, property });
    }
    expect(isForbiddenAllowlistProperty("max-width")).toBe(false);
  });

  test("reviews the shell bar's two measures, exactly as written", () => {
    // A tenant name is arbitrary text and the shell bar is one row, so the
    // organization control needs a measure of its own — and CUE++ publishes no
    // measure token, only the density ladder's rungs. Section 5.2 calls a
    // bounded content width app-owned composition, so the two rungs are
    // recorded here rather than left invisible to the scan. An exception that
    // nobody can see is the thing this file exists to prevent; a reviewed one
    // is the thing it exists to hold.
    expect(reviewedScaleUtilities).toEqual({
      "apps/web/src/components/organization-switcher.tsx": [
        scaleUtility("max-w", "24"),
        `md:${scaleUtility("max-w", "40")}`,
      ],
    });
    for (const [file, tokens] of Object.entries(reviewedScaleUtilities)) {
      for (const token of tokens) {
        expect({
          file,
          reviewable: isReviewableScaleUtility(token),
          token,
        }).toEqual({ file, reviewable: true, token });
      }
    }
  });

  test("can never review a rung of the density ladder", () => {
    // The same shape as the property guard above, one channel over: a reviewed
    // class may license a *measure* and nothing else. A control height, a rung
    // of padding, a gap, a corner radius and a type step are exactly what CUE++
    // density owns, so no entry may ever name one.
    expect([...reviewableScaleFamilies]).toEqual(["max-w", "min-w", "w"]);
    for (const token of [
      scaleUtility("p", "4"),
      scaleUtility("px", "4"),
      scaleUtility("m", "2"),
      scaleUtility("gap", "2"),
      scaleUtility("space-y", "4"),
      scaleUtility("h", "8"),
      scaleUtility("min-h", "8"),
      scaleUtility("max-h", "8"),
      scaleUtility("size", "4"),
      scaleUtility(radiusFamily, "lg"),
      scaleUtility("text", "2xl"),
    ]) {
      expect({ reviewable: isReviewableScaleUtility(token), token }).toEqual({
        reviewable: false,
        token,
      });
    }
    expect(isReviewableScaleUtility(`md:${scaleUtility("max-w", "40")}`)).toBe(
      true,
    );
  });

  test("names the two provider boundaries that may clone a body", () => {
    expect([...providerBoundaryModules]).toEqual([
      "apps/web/src/app/appearance-root.tsx",
      "apps/web/src/app/global-error.tsx",
    ]);
  });

  test("reviews RequestPort's mark and the account menu's height cap: five inline style tuples and one local svg (rulings 192, 255)", () => {
    // Task 7 retired the workbench seam's custom property, which left the list
    // empty. Ruling 192 records the mark's: the app bar's wrapper and the
    // mark's own fill, stroke and flex, each a literal, and the mark's svg.
    // Ruling 255 adds the account menu's cap at Base UI's available height.
    // Anything more is a new review, and this pin makes it a visible one.
    expect(reviewedInlineStyleProps).toEqual({
      "apps/web/src/components/app-shell.tsx": [
        '{ alignItems: "center", display: "inline-flex", gap: "0.5rem", }',
      ],
      "apps/web/src/components/request-port-mark.tsx": [
        "{ fill: accent }",
        "{ flexShrink: 0 }",
        "{ stroke: accent }",
      ],
      "apps/web/src/components/user-control.tsx": [
        '{ maxHeight: "var(--available-height)" }',
      ],
    });
    expect([...reviewedLocalSvgModules]).toEqual([
      "apps/web/src/components/request-port-mark.tsx",
    ]);
  });
});

describe("the canonical class-token parser", () => {
  // Assembled for the same reason `recipeClass` and `scaleUtility` are: this
  // suite is scanned by the audit it defines, so a probe token written out as a
  // literal would be a violation of the very rule it probes.
  const bang = "!";
  const sign = "-";
  const bracket = (inside: string) => `[${inside}]`;
  const arbitraryValue = (name: string, value: string) =>
    `${name}-${bracket(value)}`;
  const declaration = (property: string, value: string) =>
    bracket(`${property}:${value}`);

  test("closes the form vocabulary at the judged four and the inert five", () => {
    // The vocabulary is the exclusion list. A form that is neither judged nor
    // written down here is the hole this round exists to close: every escape
    // the reviewers found was a legal spelling that no rule could see, and the
    // only structural defence is that the set of spellings is closed and every
    // member of it is either read or listed as unreadable with a reason.
    expect([...utilityClassTokenForms, ...inertClassTokenForms]).toEqual([
      ...classTokenForms,
    ]);
    expect(
      utilityClassTokenForms.filter((form) =>
        (inertClassTokenForms as readonly string[]).includes(form),
      ),
    ).toEqual([]);
  });

  test("takes the variants, the sign, the modifier and the flag off one token", () => {
    // Tailwind 4.3.3 compiles `!p-4` and `p-4!` to the same declaration, and
    // `!-mt-4` and `-mt-4!` to the same negative rung. Every class rule was
    // anchored on the raw token, so one `!` on either end made a token
    // unreadable to all of them at once — the palette rule, the arbitrary-value
    // rule, the arbitrary-property rule and the rung rule together.
    for (const written of [
      `${bang}${scaleUtility("p", "4")}`,
      `${scaleUtility("p", "4")}${bang}`,
    ]) {
      expect(parseClassToken(written)).toMatchObject({
        form: "named",
        important: true,
        negated: false,
        utility: scaleUtility("p", "4"),
        variants: [],
      });
    }

    expect(
      parseClassToken(`md:${bang}${sign}${scaleUtility("mt", "4")}`),
    ).toMatchObject({
      form: "named",
      important: true,
      negated: true,
      utility: scaleUtility("mt", "4"),
      variants: ["md"],
    });

    expect(
      parseClassToken(`${arbitraryValue("bg", "#ff0000")}/50`),
    ).toMatchObject({
      form: "arbitrary-value",
      modifier: "50",
      name: "bg",
      value: "#ff0000",
    });

    expect(
      parseClassToken(`hover:${declaration("--radius-control", "3px")}`),
    ).toMatchObject({
      declaration: { property: "--radius-control", value: "3px" },
      form: "arbitrary-property",
      variants: ["hover"],
    });
  });

  test("reads the parenthesised custom-property shorthand as one utility", () => {
    // This is the codebase's own conforming spelling, and the variant split
    // used to cut it in half: counting only brackets, the `:` in front of the
    // data-type hint read as a variant boundary and every downstream rule was
    // handed `--cue-text-label)` as the utility. The rules were reasoning about
    // garbage for exactly the tokens they exist to bless.
    expect(parseClassToken("text-(length:--cue-text-label)")).toMatchObject({
      form: "custom-property",
      hint: "length",
      name: "text",
      value: "--cue-text-label",
      variants: [],
    });
    expect(parseClassToken("gap-(--cue-space-1)")).toMatchObject({
      form: "custom-property",
      hint: undefined,
      name: "gap",
      value: "--cue-space-1",
    });
  });

  test("classifies every token this repository writes", () => {
    const forms = new Set(
      writtenClassTokens().map((token) => parseClassToken(token).form),
    );

    // Totality, stated as the spec states it: the scan "fails on an
    // unclassified literal". Nothing may land outside the closed vocabulary,
    // and every judged form has to be reached by real source — a form nothing
    // exercises is a rule nothing proves.
    expect(
      [...forms].filter((form) => !classTokenForms.includes(form)),
    ).toEqual([]);
    expect(utilityClassTokenForms.filter((form) => !forms.has(form))).toEqual(
      [],
    );
  });

  test("declines nothing the installed Tailwind compiles", async () => {
    // The inert forms are an exclusion list, and an exclusion list is only as
    // honest as its proof. A hand-written character alphabet was the wrong
    // proof — it refused `w-[calc(100%-{2px})]` and `bg-[#ff0000^]` before a
    // rule could run, and the installed Tailwind compiles both — so the
    // compiler is the oracle instead: every token the parser declines to judge
    // is handed to it, and the emitted stylesheet has to come back
    // byte-identical to the one no token produces.
    //
    // The claim this licenses is the narrow one and is stated as such: the
    // declined forms do not reach the stylesheet *under the installed Tailwind
    // version*. A version that changed its candidate grammar would fail here
    // and name the token, which is the whole point of running the oracle over
    // every decline rather than enumerating characters by hand.
    const declined = writtenClassTokens().filter((token) =>
      (inertClassTokenForms as readonly string[]).includes(
        parseClassToken(token).form,
      ),
    );

    expect(declined.length).toBeGreaterThan(0);
    expect(await compilingTokens(declined)).toEqual([]);
  });

  test("judges the token a character gate used to refuse outright", async () => {
    // Both halves, because either alone is satisfiable by a lie. The tokens
    // have to be ones the compiler really does emit — otherwise "the parser now
    // reads them" is a claim about nothing — and they have to land in a judged
    // form, which is what puts them in front of the rules.
    // Assembled rather than spelled, for the reason this whole suite assembles
    // a recipe class: the audit reads every string literal this module writes,
    // and these three are real findings wherever they are written out. Each
    // half on its own is not one — `1px|2px` carries the recorded-line
    // separator outside every group, and `calc(100%-{2px})` is a group where no
    // Tailwind value sits — and the oracle below proves both halves silent.
    const brace = (inside: string) => `{${inside}}`;
    const ungated = [
      arbitraryValue("p", ["1px", "2px"].join("|")),
      arbitraryValue("w", ["calc(100%-", brace("2px"), ")"].join("")),
      arbitraryValue("bg", ["#ff0000", "^"].join("")),
      arbitraryValue("content", '"a;b"'),
    ];

    expect(await compilingTokens(ungated)).toEqual([...ungated].sort());
    expect(
      ungated.filter(
        (token) =>
          !(utilityClassTokenForms as readonly string[]).includes(
            parseClassToken(token).form,
          ),
      ),
    ).toEqual([]);

    // And the separator this module writes its own findings with still reads as
    // bookkeeping — but only where a candidate could never carry one.
    expect(parseClassToken("untokenized-class-value|p-4").form).toBe(
      "recorded-line",
    );
    expect(await compilingTokens(["untokenized-class-value|p-4"])).toEqual([]);
  });

  test("hands a bracket inside a quoted string to the compiler, not to a rule", async () => {
    // The group tracker counts the four delimiters and does not read quotes, so
    // a bracket written inside a string counts as one. Tailwind reads the same
    // three tokens as closed groups and compiles all three, which makes this
    // the third appearance of the shape this suite exists to hold: a compiling
    // token that no class-channel rule sees.
    //
    // It is not a silent drop, and this pins the reason. Each of these lands in
    // a *declined* form, and the oracle above hands every declined token this
    // repository writes to the installed compiler — so writing one into an
    // application module fails that test by name rather than passing the scan.
    // Verified by probe on this tree before this pin was written.
    //
    // Assembled rather than spelled, like every other probe token here: written
    // out, these would be in the corpus the oracle runs over, and the oracle is
    // exactly what reports them.
    const quoted = (inside: string) => `'${inside}'`;
    const miscounted = [
      arbitraryValue("content", quoted("]")),
      arbitraryValue("content", quoted(")")),
      arbitraryValue("content", quoted("[")),
    ];

    expect(await compilingTokens(miscounted)).toEqual([...miscounted].sort());
    expect(miscounted.map((token) => parseClassToken(token).form)).toEqual([
      "unbalanced-group",
      "unbalanced-group",
      "unbalanced-group",
    ]);
  });

  test("reads its corpus line by line, so an apostrophe can hide a token", () => {
    // The oracle is exactly as wide as the corpus it runs over, and that corpus
    // is *matched* out of raw file text rather than parsed out of it: a quoted
    // run, line-scoped, because a string literal may carry no bare newline. An
    // apostrophe written earlier on the same line — in JSX text, in prose, in a
    // name — opens a run of its own, and the literal after it is read as that
    // run's contents rather than as a literal. The token the module really
    // wrote is never assembled, so the compiler is never asked about it.
    //
    // This is what stops the decline above being the tripwire it reads as. A
    // declined token is only handed to the compiler if the corpus recovers it,
    // and on the wrong line it does not.
    //
    // Both halves, because either alone is satisfiable by a lie: the identical
    // token on a line of its own has to come back, or the second half is
    // measuring the extraction rather than the apostrophe.
    const apostrophe = String.fromCharCode(39);
    const speech = String.fromCharCode(34);
    const token = arbitraryValue("content", `${apostrophe}]${apostrophe}`);
    const attribute = `<span className=${speech}${token}${speech} />`;

    expect(classTokensInSource(attribute)).toContain(token);
    expect(
      classTokensInSource(`<p>Don${apostrophe}t</p>${attribute}`),
    ).not.toContain(token);
  });
});

describe("the class-channel exception register", () => {
  test("records every family the class channel deliberately does not measure", () => {
    // Section 5.2 names this module as the place an exception is recorded and
    // reviewed. The class channel's narrowings were argued in the audit's own
    // source and nowhere else, which is the same defect the reviewed scale
    // utilities had before they were written down: a narrowing only its author
    // can find is indistinguishable from a rule that was never written.
    expect(ungovernedScaleFamilies.map((entry) => entry.prefix)).toEqual([
      "basis",
      "border",
      "font",
      "indent",
      "leading",
      "outline",
      "outline-offset",
      "ring",
      "ring-offset",
      "tracking",
      "translate",
    ]);
    expect(
      ungovernedScaleFamilies.filter((entry) => entry.reason.length === 0),
    ).toEqual([]);
    expect(unreadClassConditions.map((entry) => entry.subject)).toEqual([
      "a bare value modifier",
      "a colour inside a variant bracket",
      "a named breakpoint variant",
      "the recorded-line separator outside every group",
      "the underscore-for-space convention, read unconditionally",
    ]);
    expect(
      unreadClassConditions.filter((entry) => entry.reason.length === 0),
    ).toEqual([]);
  });

  test("records what the audit is known not to catch, with its consequence", () => {
    // The two registers above say where a rule was narrowed. This one says
    // where the audit as a whole stops, and it exists because three reviewers
    // each found a gap by execution that only the author could have known was
    // deliberate. An assumed limit and a forgotten defect are the same artefact
    // until one of them is written down.
    expect(reviewedAuditLimits.map((limit) => limit.subject)).toEqual([
      "a colour resolved through a custom property outside `text-`",
      "a threshold outside `@media` feature syntax",
      "the ungoverned-family register is proved sound, not complete",
      "the focus-ring suppression clause is unpinned",
      "the compiler oracle runs over what this repository writes",
      "a class assembled across a template substitution",
      "a quoted bracket read as a group delimiter",
    ]);

    // Both halves of every entry, because either alone is the defect this
    // register replaces. A reason with no consequence is an apology; a
    // consequence with no reason is a bug report nobody acted on.
    expect(
      reviewedAuditLimits.filter(
        (limit) => limit.reason.length === 0 || limit.consequence.length === 0,
      ),
    ).toEqual([]);
  });

  test("names families that are real, and that the audit really does not measure", async () => {
    // Both directions, because either alone is satisfiable by a lie. A register
    // of imaginary families would pass an ungoverned check trivially; a
    // register of governed ones would pass a compiles check. So each entry has
    // to name something the installed Tailwind actually emits *and* something
    // the audit's own family list does not carry — which means governing one
    // of these later breaks this test until the register is updated.
    const baseline = await emittedStylesheet([]);

    for (const entry of ungovernedScaleFamilies) {
      expect(entry.example.startsWith(`${entry.prefix}-`)).toBe(true);
      expect(await emittedStylesheet([entry.example])).not.toBe(baseline);
      expect(
        governedScaleFamilies.filter((prefix) =>
          entry.example.startsWith(`${prefix}-`),
        ),
      ).toEqual([]);
    }
  });
});

describe("scanner fixtures", () => {
  const violations = fixtureAudit();

  test("clears a natively composed surface", () => {
    expect(forFixture(violations, "good-native-surface.tsx")).toEqual([]);
  });

  test("clears a token-backed stylesheet in the published import order", () => {
    expect(forFixture(violations, "good-stylesheet.css")).toEqual([]);
  });

  test("clears a partial the entry stylesheet imports", () => {
    expect(forFixture(violations, "good-partial.css")).toEqual([]);
  });

  test("clears a local barrel that renames a CUE++ component", () => {
    expect(forFixture(violations, "good-local-barrel.ts")).toEqual([]);
  });

  test("reports every legacy signal in one unmigrated surface", () => {
    expect(forFixture(violations, "bad-legacy-surface.tsx")).toEqual([
      "anchor-focus-contract|NextLink",
      "anchor-focus-contract|a",
      "anchor-focus-contract|a:focus-visible:outline-0 focus-visible:outline-accent",
      "anchor-focus-contract|a:focus-visible:outline-accent",
      "anchor-focus-contract|a:focus-visible:outline-hidden",
      'appearance-type-cast|raw as "requestport"',
      "appearance-type-cast|raw as AppearanceTheme",
      'application-style-prop|style={{ color: "red" }}',
      "arbitrary-class-value|!bg-red-500",
      "arbitrary-class-value|[&:hover]:bg-[#ff0000]",
      "arbitrary-class-value|[&>svg]:h-[32px]",
      "arbitrary-class-value|[&_svg]:text-[#ff0000]",
      "arbitrary-class-value|[&_svg]:text-red-500",
      "arbitrary-class-value|[@media(min-width:_37rem)]:p-(--cue-space-2)",
      "arbitrary-class-value|aria-[expanded=true]:bg-[#ff0000]",
      "arbitrary-class-value|bg-[#00ff00]",
      "arbitrary-class-value|bg-[#ff0000]",
      "arbitrary-class-value|bg-[#ff0000]!",
      "arbitrary-class-value|bg-[#ff0000]/50",
      "arbitrary-class-value|bg-[#ff0000^]",
      "arbitrary-class-value|data-[state=open]:bg-[#ff0000]",
      "arbitrary-class-value|h-[32px]",
      "arbitrary-class-value|h-[calc(100%_-_2px)]",
      "arbitrary-class-value|hover:bg-red-500",
      "arbitrary-class-value|max-[42rem]:bg-[#ff0000]",
      "arbitrary-class-value|min-[37rem]:[display:grid]",
      "arbitrary-class-value|min-[37rem]:p-(--cue-space-2)",
      "arbitrary-class-value|p-[1px|2px]",
      "arbitrary-class-value|peer-checked:text-white/80",
      "arbitrary-class-value|shadow-[0_0_0_1px_red]",
      "arbitrary-class-value|supports-[display:grid]:bg-[#ff0000]",
      "arbitrary-class-value|text-[10px]/[1.2]",
      "arbitrary-class-value|text-base/[calc(100%_-_2px)]",
      "arbitrary-class-value|text-white/80",
      "arbitrary-class-value|w-[calc(100%-{2px})]",
      "as-child|ThemeProvider",
      "cue-import-subpath|@cueplusplus/ui:Button->@cueplusplus/ui/primitives",
      "cue-import-subpath|@cueplusplus/ui:Chip->@cueplusplus/ui/primitives",
      "legacy-class|md:ui-legacy",
      "legacy-class|ui-hoisted",
      "legacy-class|ui-legacy!",
      "legacy-class|ui-panel",
      "legacy-import|@requestport/ui",
      "local-svg|svg",
      "raw-color-declaration|![--cue-bg:#ff0000]",
      "raw-color-declaration|[--cue-bg:#ff0000]",
      "raw-color-declaration|[color:#ff0000]",
      "raw-geometry-declaration|[--radius-control:3px]",
      "raw-geometry-declaration|[--radius-control:3px]!",
      "raw-geometry-declaration|[border-radius:3px]",
      "raw-geometry-declaration|[font-size:9px]",
      "raw-geometry-declaration|[padding:12px]",
      "raw-visible-control|button",
      "raw-visible-control|input",
      "raw-visible-control|option",
      "raw-visible-control|select",
      "token-shadow-declaration|![--cue-bg:#ff0000]",
      "token-shadow-declaration|[--cue-bg:#ff0000]",
      "token-shadow-declaration|[--radius-control:3px]",
      "token-shadow-declaration|[--radius-control:3px]!",
      "undocumented-cue-component|Table.Section",
      "untokenized-class-value|!p-4",
      "untokenized-class-value|-mt-4",
      "untokenized-class-value|-mx-2",
      "untokenized-class-value|gap-2",
      "untokenized-class-value|gap-2!",
      "untokenized-class-value|h-8",
      "untokenized-class-value|md:-top-8",
      "untokenized-class-value|md:max-w-40",
      "untokenized-class-value|p-(--brand-gap)",
      "untokenized-class-value|p-4",
      "untokenized-class-value|p-[var(--brand-gap)]",
      "untokenized-class-value|rounded",
      "untokenized-class-value|rounded-lg",
      "untokenized-class-value|scroll-mt-8",
      "untokenized-class-value|scroll-p-4",
      "untokenized-class-value|text-2xl",
      "untokenized-class-value|w-(length:--brand-w)",
      "untokenized-class-value|w-64",
      "untokenized-class-value|w-[var(--brand-w)]",
      "unverified-variant|Chip.tone=string",
      "unverified-variant|Chip.tone=string | undefined",
    ]);
  });

  test("reports order, colour, and geometry in one unmigrated stylesheet", () => {
    expect(forFixture(violations, "bad-stylesheet.css")).toEqual(
      [
        "raw-color-declaration|.legacy-panel{background:#101315}",
        "raw-geometry-declaration|:root{--radius-control:3px}",
        "token-shadow-declaration|:root{--radius-control}",
        "token-shadow-declaration|body{--cue-border-width}",
        "token-shadow-declaration|body{--cue-font-sans}",
        "token-shadow-declaration|body{--cue-radius-full}",
        'token-shadow-declaration|[data-theme="requestport"]{--cue-bg}',
        "raw-color-declaration|.legacy-panel{color:rgb(240, 238, 233)}",
        "raw-geometry-declaration|.legacy-panel{border-radius:4px}",
        "raw-geometry-declaration|.legacy-panel{padding:12px}",
        "raw-geometry-declaration|@media{max-width:899px}",
        "raw-geometry-declaration|.legacy-panel{gap:8px}",
        "raw-geometry-declaration|.legacy-inset{margin:-1px}",
        "raw-geometry-declaration|.legacy-inset{margin-left:-18px}",
        "raw-color-declaration|.legacy-nest{background:#0b0e0f}",
        "raw-geometry-declaration|.legacy-nest &:hover{border-radius:6px}",
        "raw-color-declaration|@theme{--color-ground:#101315}",
        "raw-geometry-declaration|@theme{--spacing-tight:3px}",
        "raw-geometry-declaration|:root{--page-administration:48rem}",
        "raw-geometry-declaration|:root{--page-form:42rem}",
        "raw-color-declaration|.legacy-quote::before{color:#ff0000}",
        "raw-geometry-declaration|.legacy-quote::after{padding:7px}",
        "raw-color-declaration|.legacy-stack{font-family:Rock'nRoll, sans-serif; color: #ff0000}",
        "raw-geometry-declaration|.legacy-tail{padding:6px}",
        "legacy-class|ui-callout",
        'local-theme-block|[data-theme="requestport"]',
        'stylesheet-import-order|@import "@cueplusplus/ui/styles.css"; @import "tailwindcss";',
      ].sort(),
    );
  });

  test("licenses exactly the reviewed tuple, and nothing that resembles it", () => {
    // The production list is empty and staying empty is the contract — the
    // native `PageShell` owns the measure now, so no application rule needs a
    // length of its own. That left the mechanism with no positive case at all:
    // `isAllowedStyleTuple` could have been broken in either direction, or the
    // audit could have stopped consulting it, and every test would still pass.
    //
    // The exception is therefore proved the way the `asChild` boundary is: the
    // list is an option, the fixture run passes a reviewed tuple, and the
    // production run passes nothing. Both bounded page widths section 5.2
    // permits are in the fixture, so licensing one has to report exactly the
    // other — which is what separates an exact matcher from one that licenses
    // a property, or everything.
    const widths = (entries: readonly string[]) =>
      entries.filter((entry) => entry.includes("--page-"));
    const both = [
      "raw-geometry-declaration|:root{--page-administration:48rem}",
      "raw-geometry-declaration|:root{--page-form:42rem}",
    ];

    expect(widths(forFixture(violations, "bad-stylesheet.css"))).toEqual(both);
    expect(
      widths(
        forFixture(
          fixtureAudit(undefined, [
            { property: "--page-form", selector: ":root", value: "42rem" },
          ]),
          "bad-stylesheet.css",
        ),
      ),
    ).toEqual(["raw-geometry-declaration|:root{--page-administration:48rem}"]);
    // A tuple is exact in all three of its parts. A reviewed value that is not
    // the written one licenses nothing, or the list would be a property
    // exemption wearing a value's clothes.
    expect(
      widths(
        forFixture(
          fixtureAudit(undefined, [
            { property: "--page-form", selector: ":root", value: "41rem" },
          ]),
          "bad-stylesheet.css",
        ),
      ),
    ).toEqual(both);
    expect(
      widths(
        forFixture(
          fixtureAudit(undefined, [
            { property: "--page-form", selector: "body", value: "42rem" },
          ]),
          "bad-stylesheet.css",
        ),
      ),
    ).toEqual(both);
  });

  test("clears asChild only inside a declared provider boundary", () => {
    const declared = fixtureAudit([
      "apps/web/test-fixtures/native-cue-audit/bad-legacy-surface.tsx",
    ]);

    expect(
      forFixture(declared, "bad-legacy-surface.tsx").filter((entry) =>
        entry.startsWith("as-child|"),
      ),
    ).toEqual([]);
    expect(
      forFixture(violations, "bad-legacy-surface.tsx").filter((entry) =>
        entry.startsWith("as-child|"),
      ),
    ).toEqual(["as-child|ThemeProvider"]);
  });

  test("refuses to scan a source root its project does not type", () => {
    // Exhaustiveness is the whole value of the scan: a module the project does
    // not type is a module with no violations, which is indistinguishable from
    // a clean one. Pointing the fixtures at the web project — which does not
    // include them — proves the scan says so rather than reporting silence.
    expect(() =>
      auditWorkspace({
        repositoryRoot,
        targets: [
          {
            sourceRoot: fixtureRoot,
            tsconfig: resolve(webRoot, "tsconfig.json"),
          },
        ],
      }),
    ).toThrow("cue-audit-source-root-not-fully-typed");
  });

  test("reaches every rule the vocabulary declares", () => {
    const reached = new Set(violations.map((violation) => violation.rule));

    expect([...reached].sort()).toEqual([...cueAuditRules]);
  });
});

describe("the focus ring the package composes", () => {
  // Synthetic packages, each module a compiled `.js` as the package ships it.
  // The bridge publishes two colour keys, so a bare-key ring is readable too.
  const bridge = {
    colourKeys: new Set(["accent", "focus"]),
    tokenNameByUtility: new Map([
      ["--color-accent", "--cue-accent"],
      ["--color-focus", "--cue-focus"],
    ]),
    transitionClasses: new Set<string>(),
  };
  const ringModule = [
    'const FOCUS_RING = "focus-visible:outline-solid focus-visible:outline-(--cue-focus)";',
    "export { FOCUS_RING };",
  ].join("\n");
  const composition = (
    modules: Record<string, string>,
    transitionClasses: ReadonlySet<string> = bridge.transitionClasses,
  ) =>
    focusRingCompositionOf({
      ...bridge,
      modules: new Map(Object.entries(modules)),
      transitionClasses,
    });

  test("reads a ring written through a custom property and composed through an import", () => {
    expect(
      composition({
        "/pkg/dist/system/_focus-ring.js": ringModule,
        "/pkg/dist/primitives/tabs.js": [
          'import { FOCUS_RING as RING } from "../system/_focus-ring.js";',
          "const trigger = `inline-flex transition-colors ${RING}`;",
          "export { trigger };",
        ].join("\n"),
      }),
    ).toEqual({ animated: true, colour: "var(--cue-focus)" });
  });

  test("does not read a ring quoted in a comment", () => {
    expect(
      composition({
        "/pkg/dist/primitives/link.js": [
          "/**",
          " * Spelt `transition-colors focus-visible:outline-accent` by hand once.",
          " */",
          'const link = "transition-colors focus-visible:outline-focus";',
          "// `transition-colors focus-visible:outline-accent` again, in a line comment.",
          "export { link };",
        ].join("\n"),
      }),
    ).toEqual({ animated: true, colour: "var(--cue-focus)" });
  });

  test("does not open a string at a quote inside a regular expression", () => {
    expect(
      composition({
        "/pkg/dist/lib/quote.js": [
          'const quoted = (value) => /"/u.test(value), ring = "transition-colors focus-visible:outline-(--cue-focus)";',
          "export { quoted, ring };",
        ].join("\n"),
      }),
    ).toEqual({ animated: true, colour: "var(--cue-focus)" });
  });

  test("leaves a ring nothing animates out of the choice", () => {
    // 0.29.0's shape: a field's faint ring has no colour transition, and every
    // keyboard ring that has one is drawn in `--cue-focus`.
    expect(
      composition({
        "/pkg/dist/system/_focus-ring.js": ringModule,
        "/pkg/dist/forms/_chassis.js": [
          'const field = "outline-none focus-visible:outline-[color:color-mix(in_oklab,var(--cue-focus)_15%,transparent)]";',
          "export { field };",
        ].join("\n"),
        "/pkg/dist/primitives/button.js": [
          'import { FOCUS_RING } from "../system/_focus-ring.js";',
          "const chassis = `inline-flex transition ${FOCUS_RING}`;",
          "export { chassis };",
        ].join("\n"),
      }),
    ).toEqual({ animated: true, colour: "var(--cue-focus)" });
  });

  test("refuses rings animated in two colours", () => {
    expect(() =>
      composition({
        "/pkg/dist/a.js":
          'const a = "transition-colors focus-visible:outline-(--cue-focus)";',
        "/pkg/dist/b.js":
          'const b = "transition-[color,outline-color] focus-visible:outline-accent";',
      }),
    ).toThrow(
      "cue-focus-ring-colour-is-not-one:var(--cue-accent),var(--cue-focus)",
    );
  });

  test("counts a stylesheet class that transitions the outline's colour", () => {
    const transitioned = outlineTransitionClasses(
      [
        "@layer components {",
        "  .cue-press { transition-property: color, outline-color, scale; }",
        "}",
        ".cue-fade { transition-property: opacity; }",
      ].join("\n"),
    );

    expect([...transitioned]).toEqual(["cue-press"]);
    expect(
      composition(
        {
          "/pkg/dist/system/_focus-ring.js": ringModule,
          "/pkg/dist/primitives/button.js": [
            'import { FOCUS_RING } from "../system/_focus-ring.js";',
            "const chassis = `cue-press duration-fast outline-none ${FOCUS_RING}`;",
            "export { chassis };",
          ].join("\n"),
        },
        transitioned,
      ),
    ).toEqual({ animated: true, colour: "var(--cue-focus)" });
  });

  test("reads the installed package's animated rings as --cue-focus", () => {
    // `@cueplusplus/ui@0.29.0`. 0.14.1 drew every ring `outline-accent` but
    // the recessed field chassis's and the grouped field's, which were
    // `outline-(--cue-focus)` with no colour transition; the reader before
    // this one never read that spelling, so it saw only the accent.
    expect(cueFocusRingComposition()).toEqual({
      animated: true,
      colour: "var(--cue-focus)",
    });
  });
});

describe("unconditional production scan", () => {
  test("declares the one source root the application still owns", () => {
    // `packages/ui` is gone, so there is no second root to scan and no
    // partitioned baseline to compare against. What replaces both is this
    // suite: the application source, every run of `pnpm test`, reporting nothing.
    expect(
      productionAuditTargets(repositoryRoot).map((target) =>
        target.sourceRoot.slice(repositoryRoot.length + 1),
      ),
    ).toEqual(["apps/web/src"]);
  });

  test("finds no violation anywhere in the application source", () => {
    expect(
      auditWorkspace({
        repositoryRoot,
        targets: productionAuditTargets(repositoryRoot),
      }).map(formatViolation),
    ).toEqual([]);
  }, 120_000);
});
