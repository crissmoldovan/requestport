import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import {
  appearanceDensities,
  appearanceModes,
  appearanceThemes,
} from "@requestport/domain/browser";
import {
  type AsExpression,
  type Expression,
  isAsExpression,
  isExportDeclaration,
  isImportDeclaration,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningLikeElement,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateHead,
  isTemplateMiddleOrTail,
  type JsxAttribute,
  type JsxOpeningLikeElement,
  type Node,
  type SourceFile,
  type StringLiteral,
} from "typescript/unstable/ast";
import {
  API,
  type Checker,
  type Symbol as CheckerSymbol,
  type Type,
  TypeFlags,
} from "typescript/unstable/sync";

import {
  providerBoundaryModules as defaultProviderBoundaryModules,
  isAllowedMediaThreshold,
  isAllowedStyleTuple,
  reviewedInlineStyleProps,
  reviewedLocalSvgModules,
  reviewedScaleUtilities,
  type StyleAllowlistTuple,
} from "./ui-style-allowlist.js";

/**
 * The TypeScript-aware native CUE++ audit.
 *
 * Two authorities decide what "native" means, and neither is memory:
 *
 * - the **TypeScript checker** resolves what an import and a JSX tag actually
 *   are. A tag is a CUE++ component because its symbol's declaration lives
 *   inside the installed package, and a variant value is verified because its
 *   *type* is a union of string literals — not because the source happens to
 *   spell one. That is what lets `tone={tone}` pass when `tone` is typed
 *   `"ok" | "warn"` and fail when it is typed `string`;
 * - the **installed package manifest** decides which components exist and
 *   which literals each closed axis admits, and the package's own `exports`
 *   map decides the smallest subpath a symbol can be imported from.
 *
 * Everything else — legacy imports, retired recipe classes, raw visible
 * controls, the local SVG system, `asChild` outside its two boundaries,
 * application `style` props, raw colours and raw lengths in CSS — is a
 * syntactic rule over the same resolved tree.
 *
 * The scan is unconditional. Every migration partition is finished, so the
 * environment gate and the committed baseline that selected between them are
 * both gone: `pnpm test` runs the fixture suite *and* the production scan, and
 * the production scan's contract is simply that it finds nothing. A baseline is
 * what a migration in progress needs; what a finished one needs is a gate.
 */

export const cueAuditRules = [
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
] as const;

export type CueAuditRule = (typeof cueAuditRules)[number];

export type CueAuditViolation = {
  readonly rule: CueAuditRule;
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly detail: string;
};

export function formatViolation(violation: CueAuditViolation): string {
  return `${violation.rule}|${violation.file}|${violation.detail}`;
}

/* ------------------------------------------------------------------ *
 * The installed CUE++ package: exports map, manifest, closed axes.
 * ------------------------------------------------------------------ */

const require = createRequire(import.meta.url);

type ManifestComponent = {
  readonly name: string;
  readonly path: string;
};

type CueSurface = {
  readonly packageRoot: string;
  readonly subpathByTarget: ReadonlyMap<string, string>;
  readonly subpathByDirectory: ReadonlyMap<string, string>;
  readonly documented: ReadonlySet<string>;
  readonly axesByComponent: ReadonlyMap<
    string,
    ReadonlyMap<string, Set<string>>
  >;
  /**
   * Every custom property the installed token layer declares, read from the
   * stylesheet chain the package ships rather than from the manifest's three
   * bridge lists.
   */
  readonly tokenProperties: ReadonlySet<string>;
  /**
   * The Tailwind theme keys the bridge publishes, by namespace: `spacing` ->
   * `control-sm`, `radius` -> `control`, `text` -> `body`, `color` -> `fg`.
   * These are the values a utility may name and still resolve through a
   * `--cue-*` token.
   */
  readonly themeKeysByNamespace: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The `--cue-*` property each bridge name resolves through: `--color-accent`
   * -> `--cue-accent`. A utility names the bridge key; what it paints with is
   * the token behind it, and only the bridge knows which.
   */
  readonly tokenNameByUtility: ReadonlyMap<string, string>;
};

let cachedSurface: CueSurface | undefined;

/** Every quoted literal in a manifest prop type, when the type is only those. */
function stringLiteralUnion(type: string): string[] | undefined {
  const parts = type.split("|").map((part) => part.trim());
  const values: string[] = [];

  for (const part of parts) {
    const quoted = /^"((?:[^"\\]|\\.)*)"$/u.exec(part);
    if (!quoted) return undefined;
    values.push(quoted[1] ?? "");
  }

  return values.length > 1 ? values : undefined;
}

/**
 * Every custom property an installed stylesheet and everything it imports
 * declares.
 *
 * The chain is followed rather than assumed: `@cueplusplus/ui/styles.css`
 * declares nothing itself and imports the two sheets that do, so a reader that
 * stopped at the entry would report an empty set and look exactly like a
 * package that publishes no tokens.
 *
 * An `@import` that cannot be resolved throws rather than being skipped. A
 * skipped import is a silently smaller guard, which is the failure mode this
 * whole module is written against: the scan would still pass, and the names
 * behind that import would quietly become redeclarable.
 */
function declaredCustomProperties(entry: string): Set<string> {
  const declared = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  for (let next = queue.shift(); next; next = queue.shift()) {
    const stylesheet = realpathSync(next);
    if (seen.has(stylesheet)) continue;
    seen.add(stylesheet);

    const source = withoutComments(readFileSync(stylesheet, "utf8"));
    for (const declaration of declarationsIn(source)) {
      if (declaration.property.startsWith("--")) {
        declared.add(declaration.property);
      }
    }

    for (const match of source.matchAll(
      new RegExp(importStatement.source, "gu"),
    )) {
      const specifier = (match[1] ?? "").slice(1, -1);
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(stylesheet), specifier));
        continue;
      }
      try {
        queue.push(require.resolve(specifier));
      } catch {
        throw new Error(`cue-token-stylesheet-unresolved:${specifier}`);
      }
    }
  }

  return declared;
}

function loadCueSurface(): CueSurface {
  if (cachedSurface) return cachedSurface;

  const packageRoot = realpathSync(
    dirname(require.resolve("@cueplusplus/ui/package.json")),
  );
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { exports: Record<string, unknown> };

  const subpathByTarget = new Map<string, string>();
  const subpathByDirectory = new Map<string, string>();

  for (const [subpath, target] of Object.entries(packageJson.exports)) {
    const types =
      typeof target === "string"
        ? target
        : (target as { types?: string } | null)?.types;
    if (!types?.endsWith(".d.ts")) continue;

    const normalised = types.replace(/^\.\//u, "");
    subpathByTarget.set(normalised, subpath);

    const directory = posix.dirname(normalised);
    const existing = subpathByDirectory.get(directory);
    if (!existing || subpath.length < existing.length) {
      subpathByDirectory.set(directory, subpath);
    }
  }

  const manifestPath = require.resolve("@cueplusplus/ui/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    components: ManifestComponent[];
    systemApis: { name: string }[];
    tokens: { path: string };
  };
  const manifestDirectory = dirname(manifestPath);

  // What the token layer publishes, read from the stylesheet it ships rather
  // than from a document about it.
  //
  // The companion token document lists three things: the `--cue-*` colours, the
  // `--cue-*` geometry, and the bridge names its `@theme inline` block maps
  // onto them. Those are the names the *bridge* reaches — and the token layer
  // declares more that no bridge key names at all: the focus ring and
  // its offset, the two border widths, the pill radius, the icon stroke, the
  // three font families, the label tracking, the two transition durations and
  // the easing curve. A guard assembled from the three lists therefore left
  // every one of them free for an application rule to redeclare, which is the
  // same unlayered shadow the guard exists to stop and is invisible to every
  // other rule: `body { --cue-radius-full: 0 }` flattens every pill in the
  // document on all nine themes while spelling neither a colour nor a length.
  //
  // Following the stylesheet's own `@import` chain is what keeps the guard
  // honest as the package grows. The manifest's three lists are unioned in
  // anyway rather than trusted: they are the contract the package-contract
  // suite hashes, so a name that survives there after leaving the stylesheet
  // still cannot be redeclared.
  const tokenDocument = JSON.parse(
    readFileSync(resolve(manifestDirectory, manifest.tokens.path), "utf8"),
  ) as {
    colorTokens: string[];
    geometryTokens: string[];
    utilityMap: Record<string, string>;
  };
  const tokenProperties = new Set<string>([
    ...tokenDocument.colorTokens,
    ...tokenDocument.geometryTokens,
    ...Object.keys(tokenDocument.utilityMap),
    ...declaredCustomProperties(require.resolve("@cueplusplus/ui/styles.css")),
  ]);

  // `--spacing-control-sm` publishes the utility value `control-sm` in the
  // `spacing` namespace, which is what makes `h-control-sm` a token-backed
  // height and `h-8` a second ladder. Reading the split out of the bridge is
  // what keeps `rounded-control`, `text-body` and `gap-chip` conforming without
  // a list of them here.
  const themeKeysByNamespace = new Map<string, Set<string>>();
  for (const name of Object.keys(tokenDocument.utilityMap)) {
    const split = /^--([a-z]+)-(.+)$/u.exec(name);
    if (!split) continue;
    const namespace = split[1] ?? "";
    const keys = themeKeysByNamespace.get(namespace) ?? new Set<string>();
    keys.add(split[2] ?? "");
    themeKeysByNamespace.set(namespace, keys);
  }

  const documented = new Set<string>();
  const axesByComponent = new Map<string, ReadonlyMap<string, Set<string>>>();

  for (const api of manifest.systemApis) documented.add(api.name);

  for (const component of manifest.components) {
    documented.add(component.name);

    const document = JSON.parse(
      readFileSync(resolve(manifestDirectory, component.path), "utf8"),
    ) as {
      props?: { name: string; type: string }[];
      subcomponents?: string[];
      variants?: Record<string, string[]>;
    };

    for (const subcomponent of document.subcomponents ?? []) {
      documented.add(`${component.name}.${subcomponent}`);
    }

    const axes = new Map<string, Set<string>>();
    for (const property of document.props ?? []) {
      const values = stringLiteralUnion(property.type);
      if (values) axes.set(property.name, new Set(values));
    }
    for (const [axis, values] of Object.entries(document.variants ?? {})) {
      // A boolean variant is not a literal axis: `interactive` is `true|false`
      // on the component's own type, and JSX writes it as a boolean.
      if (values.every((value) => value === "true" || value === "false")) {
        continue;
      }
      axes.set(axis, new Set(values));
    }
    if (axes.size > 0) axesByComponent.set(component.name, axes);
  }

  cachedSurface = {
    axesByComponent,
    documented,
    packageRoot,
    subpathByDirectory,
    subpathByTarget,
    themeKeysByNamespace,
    tokenNameByUtility: new Map(Object.entries(tokenDocument.utilityMap)),
    tokenProperties,
  };

  return cachedSurface;
}

/**
 * The smallest exported subpath a declaration file can be imported through: an
 * exact export target when the package publishes the file itself, otherwise the
 * subpath its directory is published under, otherwise the barrel.
 */
export function smallestCueSubpath(declarationPath: string): string {
  const surface = loadCueSurface();
  const normalised = declarationPath.split(sep).join("/").replace(/^\.\//u, "");
  const subpath =
    surface.subpathByTarget.get(normalised) ??
    surface.subpathByDirectory.get(posix.dirname(normalised)) ??
    ".";

  return subpath === "."
    ? "@cueplusplus/ui"
    : `@cueplusplus/ui${subpath.slice(1)}`;
}

export function documentedCueComponents(): ReadonlySet<string> {
  return loadCueSurface().documented;
}

/**
 * The custom-property names an application rule may never declare.
 *
 * Tailwind emits the CUE++ token bridge inside `@layer theme`, and an unlayered
 * declaration outranks every layer — so one `:root { --radius-control: 3px }`
 * in an application stylesheet silently replaces
 * `calc(var(--cue-radius-control) * var(--cue-radius-scale))` for every
 * installed component that reads it, on every theme and at every density. The
 * shadow is invisible to the rest of the scan: the same declaration written
 * token-valued breaks no colour rule and no geometry rule, and nothing in the
 * document says which stylesheet won.
 */
export function shadowedTokenProperties(): ReadonlySet<string> {
  return loadCueSurface().tokenProperties;
}

/* ------------------------------------------------------------------ *
 * Stylesheet rules.
 * ------------------------------------------------------------------ */

const rawColour =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:aqua|black|blue|brown|cyan|fuchsia|gold|gray|green|grey|indigo|lime|magenta|maroon|navy|olive|orange|pink|purple|red|salmon|silver|teal|violet|white|yellow)\b/u;

/**
 * A raw length, sign included.
 *
 * The optional `-` has to be matched rather than forbidden: `margin: -1px` is
 * the same hand-written geometry as `margin: 1px`, and a rule that only looked
 * at what follows a sign would never see it. The lookbehind is what keeps the
 * identifier boundary — it rejects a digit that continues a word, so the `2rem`
 * in `var(--gap-2rem)` is a name and not a measurement, and it rejects a sign
 * that continues one, so the `-2rem` in that same name is not one either.
 */
const rawLength =
  /(?<![\w-])-?\d*\.?\d+(?:px|rem|em|pt|pc|ch|ex|cm|mm|in|q)\b/iu;

const publishedImports = [
  '@import "tailwindcss";',
  '@import "@cueplusplus/ui/styles.css";',
];

/**
 * A retired recipe class, in either half of the codebase.
 *
 * Anchored at both ends, because a class name is a whole token: the `ui-` in
 * `"…, ui-monospace, monospace"` carries a comma and is not one. The `[a-z]`
 * after the prefix keeps the pattern from matching the bare prefix this module
 * has to write down in order to look for it.
 *
 * In the class channel it is matched against `parseClassToken(token).utility`,
 * so the anchors bound the *recipe* rather than the spelling: a variant chain,
 * the important flag and Tailwind's sign all come off before the test runs. In
 * the stylesheet channel {@link legacyRecipeSelector} does the same job against
 * a selector, where none of those three can appear.
 */
const legacyRecipeClass = /^ui-[a-z][\w-]*$/u;

/**
 * The CSS generic font families that share the prefix. They are keywords in a
 * `font-family` stack — the root layout hands the provider one — and no amount
 * of retiring RequestPort's own recipes will remove them.
 */
const cssGenericFamilies = new Set([
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

/** The same class written as a selector, which is how the stylesheet holds it. */
const legacyRecipeSelector = /\.(ui-[a-z][\w-]*)/gu;

/**
 * A selector keyed on one of the three appearance attributes.
 *
 * The installed package owns every preset and writes these attributes itself.
 * A local block keyed on the same attribute is a second, hand-maintained theme
 * that drifts from the package the moment the package ships a new one — and it
 * can be written entirely in `--cue-*` tokens, so no colour or geometry rule
 * would ever see it. Ordinary component state attributes such as
 * `[data-state="open"]` are not appearance, and are not matched.
 */
const localThemeSelector =
  /\[data-(?:theme|density|mode)(?:[~|^$*]?=[^\]]*)?\]/gu;

/**
 * A running answer to "is this character text rather than punctuation?", fed
 * one character at a time.
 *
 * Both layers that read a stylesheet — the comment stripper and the declaration
 * walker — have to agree about where the strings are, or the layer that does
 * not know deletes real CSS and leaves an odd quote behind for the layer that
 * does. They share this scanner so that agreement cannot drift.
 *
 * The recovery is CSS's own bad-string-token rule: an unescaped newline inside
 * a string is a parse error that ends the string. Without it a single unpaired
 * quote — an apostrophe in a font stack, a `/*` inside a `content` value — put
 * the reader inside a string for the rest of the file and silently retired
 * every declaration after it from the scan. A backslash still claims the next
 * character, inside a string and out, so an escaped newline legally continues a
 * string and an escaped quote in an identifier stays text.
 */
function textScanner(): (character: string) => boolean {
  let quote = "";
  let escaped = false;

  return (character) => {
    if (escaped) {
      escaped = false;
      return true;
    }
    if (character === "\\") {
      escaped = true;
      return true;
    }
    if (quote) {
      if (character === quote || character === "\n") quote = "";
      return true;
    }
    if (character === '"' || character === "'") {
      quote = character;
      return true;
    }

    return false;
  };
}

/**
 * A stylesheet with its comments removed, and nothing else removed with them.
 *
 * A comment opens only outside a string. A stripper that matched the opening
 * delimiter anywhere deleted everything from a `content` value that quotes one
 * to the next real closing delimiter — two whole rules, in valid CSS, gone
 * before any rule ever saw them, and an odd quote left in what remained. The
 * comment's own contents are never fed to the scanner, so an apostrophe in
 * prose opens nothing either.
 */
function withoutComments(css: string): string {
  const isText = textScanner();
  let output = "";
  let index = 0;

  while (index < css.length) {
    const character = css[index] ?? "";
    if (!isText(character) && character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      // An unterminated comment runs to the end of the file, which is what CSS
      // says it does.
      index = end < 0 ? css.length : end + 2;
      continue;
    }
    output += character;
    index += 1;
  }

  return output;
}

function collapse(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

/** One `@import` statement, normalised to the double-quoted spelling. */
const importStatement = /@import\s+("[^"]*"|'[^']*')\s*;/u;

function normaliseImport(quoted: string): string {
  return `@import ${quoted.replaceAll("'", '"')};`;
}

/**
 * The `@import` statements a stylesheet *opens* with, in order.
 *
 * Position is the whole rule. CSS applies an `@import` written after a rule not
 * at all, so a stylesheet that opens with its own declarations and only then
 * writes the published pair ships the console with no token layer — and a rule
 * that collected the first two `@import` statements found anywhere in the file
 * called that conforming. Whitespace and comments are not rules; the comment
 * stripper has already removed the latter.
 */
function leadingImports(source: string): string[] {
  const statements: string[] = [];
  let rest = source;

  for (;;) {
    rest = rest.replace(/^\s+/u, "");
    const match = new RegExp(`^${importStatement.source}`, "u").exec(rest);
    if (!match) return statements;
    statements.push(normaliseImport(match[1] ?? ""));
    rest = rest.slice(match[0].length);
  }
}

export type StylesheetAuditOptions = {
  /**
   * The reviewed selector/property/value tuples this run licenses.
   *
   * Defaults to the production list, which is empty and contracted to stay
   * empty. It is an option so that the mechanism itself is falsifiable: a
   * matcher measured only against no entries is indistinguishable from one that
   * licenses nothing, and section 5.2 names this list as the only way a raw
   * local layout length is ever allowed.
   */
  readonly styleAllowlist?: readonly StyleAllowlistTuple[];
  /**
   * Whether this stylesheet is the one a document loads, rather than a fragment
   * another stylesheet imports.
   *
   * An entry stylesheet must open with the published pair. A partial must not
   * carry it at all: it is inlined into a sheet that already did, and repeating
   * it there duplicates the entire token layer. Requiring the preamble of every
   * `.css` file would force exactly that duplication on any future partial.
   */
  readonly entry?: boolean;
};

export function auditStylesheet(
  css: string,
  file: string,
  options: StylesheetAuditOptions = {},
): CueAuditViolation[] {
  const violations: CueAuditViolation[] = [];
  const source = withoutComments(css);
  const entry = options.entry ?? true;
  const shadowable = loadCueSurface().tokenProperties;

  if (entry) {
    // An absent pair is not a conforming pair. A stylesheet that never imports
    // `@cueplusplus/ui/styles.css` ships an unstyled CUE++ surface while
    // spelling nothing wrong, so "does not open with one" has to be reported
    // exactly like the wrong order is.
    const opening = leadingImports(source).slice(0, 2);
    if (
      opening[0] !== publishedImports[0] ||
      opening[1] !== publishedImports[1]
    ) {
      violations.push({
        detail: opening.join(" ") || "(no leading import)",
        file,
        rule: "stylesheet-import-order",
      });
    }
  } else {
    const all = [
      ...source.matchAll(new RegExp(importStatement.source, "gu")),
    ].map((match) => normaliseImport(match[1] ?? ""));
    const repeated = publishedImports.find((published) =>
      all.includes(published),
    );
    if (repeated) {
      violations.push({
        detail: `imported partial re-imports ${repeated}`,
        file,
        rule: "stylesheet-import-order",
      });
    }
  }

  // A `.ui-*` rule whose every value is a token breaks no colour or geometry
  // rule, so without this the retired recipe system could survive the scan
  // intact behind class names the components no longer have to spell.
  for (const recipe of new Set(
    [...source.matchAll(legacyRecipeSelector)].map((match) => match[1] ?? ""),
  )) {
    violations.push({ detail: recipe, file, rule: "legacy-class" });
  }

  for (const block of new Set(
    [...source.matchAll(localThemeSelector)].map((match) => match[0]),
  )) {
    violations.push({ detail: block, file, rule: "local-theme-block" });
  }

  for (const media of source.matchAll(/@media([^{]*)\{/gu)) {
    for (const feature of (media[1] ?? "").matchAll(
      /\(\s*([\w-]+)\s*:\s*([^)]+)\)/gu,
    )) {
      const name = feature[1] ?? "";
      const value = collapse(feature[2] ?? "");
      if (!rawLength.test(value) || isAllowedMediaThreshold(value)) continue;
      violations.push({
        detail: `@media{${name}:${value}}`,
        file,
        rule: "raw-geometry-declaration",
      });
    }
  }

  for (const { selector, property, value } of declarationsIn(source)) {
    if (
      !isAllowedStyleTuple(selector, property, value, options.styleAllowlist)
    ) {
      const detail = `${selector}{${property}:${value}}`;
      if (rawColour.test(value)) {
        violations.push({ detail, file, rule: "raw-color-declaration" });
      }
      if (rawLength.test(value)) {
        violations.push({ detail, file, rule: "raw-geometry-declaration" });
      }
    }

    // Deliberately outside the allowlist's reach. A reviewed tuple licenses a
    // *value*; nothing licenses redeclaring a name the package publishes,
    // because the value is not what does the damage — the name is.
    if (shadowable.has(property)) {
      violations.push({
        detail: `${selector}{${property}}`,
        file,
        rule: "token-shadow-declaration",
      });
    }
  }

  return violations;
}

export type CssDeclaration = {
  /** The full nesting path, outermost selector first, joined by spaces. */
  readonly selector: string;
  readonly property: string;
  readonly value: string;
};

/**
 * The at-rules whose prelude names a *condition* rather than a place in the
 * document, and whose block therefore holds rules instead of declarations.
 * Only these contribute nothing to the nesting path, so what they wrap is
 * judged against the selector it is genuinely written under.
 *
 * `@starting-style` is one of them: it names *when* a declaration applies — the
 * first style of a transition — and wraps rules exactly as the other five do,
 * whether written around a rule or nested inside the one it starts.
 *
 * The list is closed the other way round from an exemption list: every at-rule
 * it does not name — `@theme`, `@property`, `@font-face`, `@counter-style`,
 * `@page`, `@keyframes`, Tailwind v4's `@utility`, and whatever CSS ships next
 * — is treated as holding declarations, so an unfamiliar at-rule is judged
 * rather than excused. §14.3 makes a blanket extension exemption invalid, and
 * `@theme { --page-form: 42rem }` is byte-for-byte the same measurement as the
 * `:root` tuple the allowlist has to review.
 */
const conditionalGroupRules = new Set([
  "@container",
  "@layer",
  "@media",
  "@scope",
  "@starting-style",
  "@supports",
]);

/** `@media (min-width: 40rem)` → `@media`; anything else → `""`. */
function conditionalGroupRule(prelude: string): string {
  const name = /^@[\w-]+/u.exec(prelude)?.[0].toLowerCase() ?? "";

  return conditionalGroupRules.has(name) ? name : "";
}

type OpenBlock = {
  /** The prelude exactly as written, collapsed. */
  readonly prelude: string;
  /** A condition names no place, so it leaves the nesting path alone. */
  readonly conditional: boolean;
};

/**
 * Every declaration in a stylesheet, each against the place it is written in.
 *
 * A regular expression cannot do this. Matching `selector { body }` with a body
 * that excludes braces only ever matches the *innermost* block, so a rule that
 * contains a nested one has all of its own declarations skipped — and native
 * nesting with `&` is ordinary Tailwind v4 CSS. This walks the braces instead
 * and keeps a stack, so `.a { color: …; &:hover { color: … } }` reports both,
 * the second against `.a &:hover` rather than against a bare `&:hover` whose
 * parent nobody could recover.
 *
 * At-rules split in two. A conditional group rule (`@media`, `@supports`,
 * `@layer`, `@container`, `@scope`, `@starting-style`) contributes no path
 * segment, so the
 * declarations inside it are reported against the rule they are actually
 * written in. Every other at-rule holds declarations directly, and its prelude
 * *is* the place they are written in: `@theme { --color-ground: #101315 }`
 * reports against `@theme`. When a condition is the only thing wrapping a
 * declaration — invalid CSS, but a scanner that trusts authors to write valid
 * CSS is not a scanner — the condition is the nearest place there is, and the
 * declaration is reported against it.
 *
 * A string is text all the way through. `{`, `}` and `;` punctuate a stylesheet
 * only outside quotes: `content: "}"` closed the rule it is written in and took
 * every declaration after it out of the scan, and `content: "{"` pushed a block
 * nobody wrote and reported the rest of the rule against a selector nobody
 * wrote. Both are silent — the stylesheet still parses in a browser, and the
 * scan simply stops seeing what the rule declares — which is the shape of hole
 * a source gate cannot have.
 *
 * Where a string *ends* is the other half of that, and is why the rule lives in
 * `textScanner` rather than here: a reader that waits for a closing quote that
 * never comes stops reading the file at the first apostrophe, which trades one
 * silent hole for a far larger one.
 */
export function declarationsIn(css: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  // Comments are stripped here rather than only by the caller. A prose block
  // written above a rule is not part of its selector, and a reader that kept it
  // reported `/* … */ :root` — a selector no allowlist tuple and no contract
  // can ever match, so every declaration in the rule below a comment quietly
  // stopped being measurable by name. The stripper is idempotent, so the one
  // caller that already strips loses nothing by it.
  const source = withoutComments(css);
  /** One entry per open block, outermost first. */
  const path: OpenBlock[] = [];
  let pending = "";
  const isText = textScanner();

  const flush = () => {
    const text = pending;
    pending = "";
    const places = path.filter((block) => !block.conditional);
    const selector =
      places.length > 0
        ? places.map((block) => block.prelude).join(" ")
        : (path.at(-1)?.prelude ?? "");
    if (!selector) return;
    const separator = text.indexOf(":");
    if (separator < 0) return;
    const property = collapse(text.slice(0, separator));
    const value = collapse(text.slice(separator + 1));
    if (!property || !value || property.startsWith("@")) return;
    declarations.push({ property, selector, value });
  };

  for (const character of source) {
    if (isText(character)) {
      pending += character;
      continue;
    }
    if (character === "{") {
      const prelude = collapse(pending);
      pending = "";
      path.push({
        conditional: conditionalGroupRule(prelude) !== "",
        prelude,
      });
      continue;
    }
    if (character === "}") {
      flush();
      path.pop();
      continue;
    }
    if (character === ";") {
      flush();
      continue;
    }
    pending += character;
  }

  return declarations;
}

/* ------------------------------------------------------------------ *
 * Module rules.
 * ------------------------------------------------------------------ */

/**
 * The retired workspace package, matched by the specifier a module writes.
 *
 * Before retirement the rule resolved the specifier's symbol and asked whether
 * the declaration lived under `packages/ui/src`. That reading cannot survive
 * the package's deletion: an import of something that no longer exists resolves
 * to nothing, so the rule would report nothing — a prohibition that becomes
 * unfalsifiable exactly when the thing it prohibits is finally gone. The name
 * is what §14.3 actually forbids ("`@requestport/ui` imports after
 * retirement"), and a name is still there to be read whether or not anything
 * answers it.
 */
const legacyPackage = "@requestport/ui";

function isLegacyPackageSpecifier(specifier: string): boolean {
  return (
    specifier === legacyPackage || specifier.startsWith(`${legacyPackage}/`)
  );
}

/**
 * Intrinsic elements CUE++ owns outright. `form`, `a`, and the text elements
 * are absent on purpose: they carry no visual recipe. A hidden `input` is
 * absent too — the form contract keeps native hidden inputs for server-action
 * metadata such as expected versions and idempotency keys.
 */
const visibleControls = new Set([
  "button",
  "dialog",
  "details",
  "fieldset",
  "input",
  "label",
  "legend",
  "meter",
  "optgroup",
  "option",
  "progress",
  "select",
  "summary",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

/**
 * A Tailwind palette utility.
 *
 * Anchored at both ends of the *utility* rather than of the token it is written
 * in: the token also carries the variant chain and the value modifier, and
 * neither changes which colour is being spelled. It is matched against
 * `parseClassToken(token).utility` for that reason.
 */
const tailwindPalette =
  /^(?:accent|bg|border|caret|decoration|divide|fill|from|outline|placeholder|ring|shadow|stroke|text|to|via)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{1,3})?$/u;

/* ------------------------------------------------------------------ *
 * The canonical class-token parser.
 * ------------------------------------------------------------------ */

/**
 * What a raw token turned out to be, read the way Tailwind reads it.
 *
 * Before this existed every class rule did its own anchoring on the raw string
 * — `arbitraryPropertyUtility` was `/^\[([^\]]+)\]$/`, `arbitraryUtility` ended
 * in `]$`, `tailwindPalette` ended in `$`, and the scale rule tested
 * `base.startsWith(family.prefix + "-")`. Each of those anchors was a separate
 * chance for a legal Tailwind spelling to fall out of a rule's field of view,
 * and they did not fail one at a time: a single `!` on either end of a token
 * made it unreadable to *all four* at once, and a leading `-` hid every
 * negative rung of every governed family from the one rule that measures rungs.
 *
 * So the token is decomposed once, here, and every rule is expressed against
 * the decomposition instead of against the string. A rule can then be wrong
 * about what it forbids, but it can no longer be blind to how the thing it
 * forbids happens to be spelled.
 *
 * The four `*Form` members below are the forms Tailwind compiles into a rule.
 * The rest are the forms that are *not* a class at all, and they are named
 * rather than lumped together precisely because "the parser did not understand
 * this" must never be a silent exemption: `inertClassTokenForms` is the written
 * exclusion list, `classTokenForms` is closed, and the suite proves both that
 * every token in the repository lands in one of them and that no token this
 * repository writes in an inert form compiles to a single byte of CSS under the
 * installed Tailwind. That last clause is the whole of the claim — the module
 * is not entitled to say such a token *cannot* compile, only that the installed
 * compiler, asked, emits nothing for it, and that a compiler which stopped
 * agreeing would fail the suite and name the token.
 */
export const utilityClassTokenForms = [
  /** `[--radius-control:3px]` — a whole declaration written as a class. */
  "arbitrary-property",
  /** `bg-[#ff0000]` — a utility carrying a bracketed value. */
  "arbitrary-value",
  /** `text-(length:--cue-text-label)` — v4's custom-property shorthand. */
  "custom-property",
  /** `p-4`, `bg-red-500`, `rounded`, `underline` — a named value or none. */
  "named",
] as const;

/**
 * The forms that are not a Tailwind class, with the reason each is inert.
 *
 * Every one of these is excluded from the class rules on purpose, and the
 * exclusion is decided by the token's *structure* rather than by a list of
 * characters. A hand-written alphabet was tried and was the wrong instrument:
 * it refused `w-[calc(100%-{2px})]` and `bg-[#ff0000^]` before a rule could run,
 * both of which the installed Tailwind compiles into the stylesheet, so one
 * character made a token invisible to the whole class channel at once.
 *
 * What licenses the exclusion instead is the compiler. The suite hands every
 * declined token to the installed tailwindcss and requires the emitted
 * stylesheet to come back byte-identical to the one no token produces, naming
 * the offender when it does not. That is a narrower claim than the one this
 * list used to make, and it is the one the module is entitled to: these forms
 * **do not reach the stylesheet under the installed Tailwind version**, and a
 * version that changed its mind would fail the oracle rather than quietly
 * reopen the channel.
 */
export const inertClassTokenForms = [
  /**
   * `[data-slot="dialog-backdrop"]`, `[&_svg]` — a bracket group standing
   * alone. It is a selector or a variant, and a variant with nothing after it
   * is not a utility.
   */
  "bracket-group",
  /**
   * `./(auth)/sign-in/page.js`, `var(--cue-bg)`, `notFound()` — a group that is
   * not where a Tailwind value sits. Tailwind's own candidate scanner reads a
   * bracket or a parenthesis only as the tail of a utility, so a module path, a
   * `var()` reference and a call expression are prose to it.
   */
  "misplaced-group",
  /**
   * `untokenized-class-value|p-4` — this audit's own bookkeeping, recognised by
   * the one place its separator can sit that a Tailwind candidate's cannot:
   * outside every bracket and parenthesis group.
   *
   * A `|` *inside* a group is a different thing entirely and is judged like any
   * other value — `p-[1px|2px]` compiles to `padding: 1px|2px` under the
   * installed Tailwind, which is exactly the raw measurement section 5.2 exists
   * to reject. The old gate refused the whole token on the character alone and
   * so refused that one too.
   */
  "recorded-line",
  /**
   * `calc(var(--cue-radius-control)`, `(?:[^` — brackets or parentheses the
   * group tracker cannot balance.
   *
   * *Cannot* rather than *does not*, and the distance between those two words
   * is this form's whole honest content. The tracker counts the four
   * delimiters and does not read quotes, so a bracket written inside a quoted
   * string counts as one: a content utility whose value is a quoted closing
   * bracket is a closed group to Tailwind, which compiles it, and an unbalanced
   * one here. So "Tailwind requires a closed group, so an open one names
   * nothing" is not what licenses this bucket — it was the claim this form
   * carried, and it was false of exactly the tokens that matter.
   *
   * What licenses it is the oracle, the same thing that licenses every other
   * decline: a token landing here is handed to the installed compiler, and one
   * that compiles fails the suite by name. Proven by probe rather than by
   * argument — such a token, written into an application module, leaves the
   * production scan reporting nothing and fails the decline oracle naming it.
   * The gap that leaves is recorded in `ui-style-allowlist.ts` with the rest.
   */
  "unbalanced-group",
  /** `hover:`, `-`, `!` — a variant chain or a sign with no utility behind it. */
  "empty-utility",
] as const;

export const classTokenForms = [
  ...utilityClassTokenForms,
  ...inertClassTokenForms,
] as const;

export type ClassTokenForm = (typeof classTokenForms)[number];

export type ParsedClassToken = {
  readonly raw: string;
  readonly form: ClassTokenForm;
  /**
   * The variant chain in written order, each without its trailing `:` —
   * `hover`, `md`, `[&_svg]`, `supports-[display:grid]`, `min-[37rem]`.
   */
  readonly variants: readonly string[];
  /**
   * The utility with the variant chain, the sign, the `!` and the `/…` modifier
   * all removed. `""` for every inert form.
   */
  readonly utility: string;
  /** Tailwind's leading `-`: the sign on `-mt-4`, `-outline-offset-2`. */
  readonly negated: boolean;
  /** `!` in either spelling — v4's `p-4!` and the legacy `!p-4` alike. */
  readonly important: boolean;
  /** The `/…` written after a value, without its slash: `50`, `[1.2]`, `2`. */
  readonly modifier?: string;
  /** The utility name in front of a group: `bg` in `bg-[#ff0000]`. */
  readonly name?: string;
  /**
   * A group's contents: a bracket's value with Tailwind's `_`-for-space
   * convention read back, or — for the parenthesised form — the custom property
   * named, verbatim, because a property name is an identifier and not a value.
   */
  readonly value?: string;
  /** The data-type hint v4 allows in front of a custom property. */
  readonly hint?: string;
  /** An arbitrary *property* utility's two halves. */
  readonly declaration?: {
    readonly property: string;
    readonly value: string;
  };
};

/**
 * Split on a separator that sits outside every bracket and parenthesis group.
 *
 * Both delimiters are counted, which is the whole of the fix for section 5.2's
 * own conforming spelling: `text-(length:--cue-text-label)` puts a `:` inside
 * parentheses, and a splitter that counted only brackets read that `:` as a
 * variant boundary and handed every downstream rule `--cue-text-label)` as the
 * utility. The rules were reasoning about garbage for exactly the tokens they
 * exist to bless.
 */
function splitOutsideGroups(
  text: string,
  separator: string,
): { parts: string[]; balanced: boolean } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "[" || character === "(") depth += 1;
    else if (character === "]" || character === ")") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    if (depth < 0) return { balanced: false, parts: [] };
  }

  parts.push(text.slice(start));

  return { balanced: depth === 0, parts };
}

/** The index of the group opener that closes on the token's last character. */
function trailingGroupStart(utility: string): number | undefined {
  const closer = utility.at(-1);
  if (closer !== "]" && closer !== ")") return undefined;
  const opener = closer === "]" ? "[" : "(";
  let depth = 0;

  for (let index = utility.length - 1; index >= 0; index -= 1) {
    const character = utility[index];
    if (character === closer) depth += 1;
    else if (character === opener) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return undefined;
}

/**
 * A bracket group's contents, read the way Tailwind reads them.
 *
 * Tailwind spells a space inside an arbitrary value as `_`, so a value is only
 * a value once the convention is read back: `[padding:12px_4px]` is two
 * lengths, `h-[calc(100%_-_2px)]` is one, and `shadow-[0_0_0_1px_red]` is a
 * length and a colour. This has to happen in *one* place, because `_` is a word
 * character and both value rules are word-boundary rules — the raw-length
 * lookbehind and every raw-colour boundary are defeated by the convention
 * itself. It used to happen in the arbitrary-*property* branch only, so the
 * identical measurement read as conforming in one branch and raw in the other.
 *
 * "One place" means every site that produces a value for a rule to read, and
 * there are four: the arbitrary property's declaration, the arbitrary value,
 * the bracketed modifier, and the variant bracket a responsive threshold is
 * written in. The last of those was missed when the other three were fixed,
 * which left `[@media(min-width:_37rem)]` unmeasured by the one rule that
 * bounds a breakpoint.
 *
 * The substitution is unconditional, and Tailwind's is not: it keeps `_` inside
 * `var(…)` and honours a `\_` escape. That divergence can only ever make this
 * audit read a value as *wider* than Tailwind does — replacing `_` with a space
 * adds word boundaries and never removes one — so it can make a rule stricter
 * and never blinder. It is recorded in `ui-style-allowlist.ts` with the rest of
 * the class channel's limits.
 */
function arbitraryValueText(inside: string): string {
  return inside.replaceAll("_", " ").trim();
}

function inert(raw: string, form: ClassTokenForm): ParsedClassToken {
  return {
    form,
    important: false,
    negated: false,
    raw,
    utility: "",
    variants: [],
  };
}

/**
 * One raw class token, decomposed.
 *
 * The order the pieces come off matters and is Tailwind's own: variants first,
 * then the `!` (which v4 writes last and v3 wrote first, and which sits outside
 * the sign either way — `!-mt-4` and `-mt-4!` are the same utility), then the
 * sign, then the `/…` modifier, and only then the value group. Taking the sign
 * before the `!` would leave `!` glued to `-mt-4`; taking the modifier before
 * the `!` would leave it glued to `50` in `bg-red-500/50!`.
 */
export function parseClassToken(raw: string): ParsedClassToken {
  // The only token this parser declines on a character is the one carrying the
  // separator it writes its own findings with, and it declines it only where a
  // Tailwind candidate could never put one: outside every group. Everything
  // else is decided by structure, and every decline is proven inert by handing
  // it to the installed compiler rather than by asserting an alphabet.
  const recorded = splitOutsideGroups(raw, "|");
  if (!recorded.balanced) return inert(raw, "unbalanced-group");
  if (recorded.parts.length > 1) return inert(raw, "recorded-line");

  const chain = splitOutsideGroups(raw, ":");
  if (!chain.balanced) return inert(raw, "unbalanced-group");

  const variants = chain.parts.slice(0, -1);
  let body = chain.parts.at(-1) ?? "";
  let important = false;
  if (body.startsWith("!")) {
    important = true;
    body = body.slice(1);
  }
  if (body.endsWith("!")) {
    important = true;
    body = body.slice(0, -1);
  }
  let negated = false;
  if (body.startsWith("-")) {
    negated = true;
    body = body.slice(1);
  }

  const parts = splitOutsideGroups(body, "/");
  if (!parts.balanced) return inert(raw, "unbalanced-group");
  const modifier = parts.parts.length > 1 ? parts.parts.at(-1) : undefined;
  const utility = parts.parts
    .slice(0, parts.parts.length > 1 ? -1 : undefined)
    .join("/");
  if (utility.length === 0) return inert(raw, "empty-utility");

  const common = { important, modifier, negated, raw, utility, variants };
  const start = trailingGroupStart(utility);

  if (start === undefined) {
    return /[[\]()]/u.test(utility)
      ? inert(raw, "misplaced-group")
      : { ...common, form: "named" };
  }

  const inside = utility.slice(start + 1, -1);

  if (start === 0) {
    if (utility.startsWith("(")) return inert(raw, "misplaced-group");
    // A bracket group standing alone is a declaration when it spells one and a
    // selector when it does not: `[--radius-control:3px]` declares, `[&_svg]`
    // and `[data-slot="input"]` name a thing to match.
    const halves = splitOutsideGroups(inside, ":");
    if (!halves.balanced || halves.parts.length < 2) {
      return inert(raw, "bracket-group");
    }
    const [property = "", ...rest] = halves.parts;

    return {
      ...common,
      declaration: {
        property: property.trim(),
        value: arbitraryValueText(rest.join(":")),
      },
      form: "arbitrary-property",
    };
  }

  if (utility[start - 1] !== "-") return inert(raw, "misplaced-group");
  const name = utility.slice(0, start - 1);

  if (utility[start] === "[") {
    return {
      ...common,
      form: "arbitrary-value",
      name,
      value: arbitraryValueText(inside),
    };
  }

  // v4's `(…)` shorthand is exactly `[var(…)]`, so its contents are a custom
  // property and optionally the data-type hint in front of it. Anything else
  // between the parentheses compiles to nothing at all.
  const hinted = splitOutsideGroups(inside, ":");
  const hint = hinted.parts.length > 1 ? hinted.parts[0] : undefined;
  const property = hinted.parts.at(-1) ?? "";
  if (
    !hinted.balanced ||
    hinted.parts.length > 2 ||
    !property.startsWith("--")
  ) {
    return inert(raw, "misplaced-group");
  }

  return { ...common, form: "custom-property", hint, name, value: property };
}

function isStringLiteralLike(node: Node): boolean {
  return (
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isTemplateHead(node) ||
    isTemplateMiddleOrTail(node)
  );
}

function classTokens(literals: readonly string[]): string[] {
  return literals.flatMap((literal) =>
    literal.split(/\s+/u).filter((token) => token.length > 0),
  );
}

/** `undefined` and `null`, the two members an absent value contributes. */
const nullishTypeFlags = TypeFlags.Undefined | TypeFlags.Null;

/**
 * Every string literal a type admits, or `undefined` if it admits anything else.
 *
 * A nullish member is dropped rather than read as "anything else". Every closed
 * axis in the manifest is marked `required: false`, so the ordinary shape of a
 * React prop that forwards one is `"ok" | "warn" | undefined` — type-safe,
 * manifest-conformant, and rejected outright by a rule that stopped at the
 * first non-literal member. A value that is only nullish contributes no member
 * to check, which is what passing nothing already means.
 */
function literalStringMembers(type: Type | undefined): string[] | undefined {
  if (!type) return undefined;
  const members = type.isUnionType() ? type.getTypes() : [type];
  const values: string[] = [];

  for (const member of members) {
    if (member.flags & nullishTypeFlags) continue;
    if (!member.isStringLiteralType()) return undefined;
    values.push(member.value);
  }

  return values;
}

/**
 * The three closed appearance axes, read from the domain package rather than
 * restated here, so widening one there widens this rule with it.
 */
const appearanceAxisVocabularies: readonly ReadonlySet<string>[] = [
  new Set<string>(appearanceThemes),
  new Set<string>(appearanceDensities),
  new Set<string>(appearanceModes),
];

const appearanceThemeNames: ReadonlySet<string> = new Set<string>(
  appearanceThemes,
);

/**
 * Whether an asserted type is one of the appearance axes, or one theme name.
 *
 * Specification section 14.3 forbids a theme-name cast because section 9's
 * resolution contract exists to *parse* an axis, never to assert one:
 * `raw as AppearanceTheme` re-admits exactly the unvalidated value the schema
 * is there to reject. The test is the whole vocabulary of an axis, or a single
 * literal that is a theme name — a lone `"normal"` or `"large"` is an ordinary
 * English word long before it is a density, and asserting one is not this.
 */
function isAppearanceAssertion(members: readonly string[]): boolean {
  if (members.length === 0) return false;
  if (members.length === 1) {
    return appearanceThemeNames.has(members[0] ?? "");
  }

  return appearanceAxisVocabularies.some(
    (axis) =>
      axis.size === members.length &&
      members.every((member) => axis.has(member)),
  );
}

function rootIdentifier(node: Expression): Expression {
  let current = node;
  while (isPropertyAccessExpression(current)) current = current.expression;

  return current;
}

export type AuditTarget = {
  /** Absolute path of the tsconfig that types this root. */
  readonly tsconfig: string;
  /** Absolute directory whose files are audited. */
  readonly sourceRoot: string;
};

export type CueAuditOptions = {
  readonly repositoryRoot: string;
  readonly targets: readonly AuditTarget[];
  readonly providerBoundaryModules?: readonly string[];
  /** See {@link StylesheetAuditOptions.styleAllowlist}. */
  readonly styleAllowlist?: readonly StyleAllowlistTuple[];
};

export function productionAuditTargets(
  repositoryRoot: string,
): readonly AuditTarget[] {
  return [
    {
      sourceRoot: resolve(repositoryRoot, "apps/web/src"),
      tsconfig: resolve(repositoryRoot, "apps/web/tsconfig.json"),
    },
  ];
}

function toRepositoryRelative(
  repositoryRoot: string,
  path: string,
): string | undefined {
  // tsgo hands back canonical (case-folded) paths for declarations while
  // keeping the original case in file names; comparing lower-cased keeps both
  // shapes working without ever mangling the reported path.
  const lower = path.toLowerCase();
  const rootLower = `${repositoryRoot.toLowerCase()}${sep}`;
  if (!lower.startsWith(rootLower)) return undefined;

  return path
    .slice(repositoryRoot.length + 1)
    .split(sep)
    .join("/");
}

function auditModules(options: CueAuditOptions): CueAuditViolation[] {
  const { repositoryRoot, targets } = options;
  const boundaries = new Set(
    options.providerBoundaryModules ?? defaultProviderBoundaryModules,
  );
  const surface = loadCueSurface();
  const cueRootLower = surface.packageRoot.toLowerCase();
  const violations: CueAuditViolation[] = [];
  const api = new API({ cwd: repositoryRoot });

  try {
    const snapshot = api.updateSnapshot({
      openProjects: targets.map((target) => target.tsconfig),
    });

    for (const target of targets) {
      const project = snapshot.getProject(target.tsconfig);
      const checker = project?.checker;
      const rootLower = `${target.sourceRoot.toLowerCase()}${sep}`;
      const audited = new Set<string>();

      for (const fileName of project?.program.getSourceFileNames() ?? []) {
        if (!fileName.toLowerCase().startsWith(rootLower)) continue;
        if (fileName.endsWith(".d.ts")) continue;
        const file = toRepositoryRelative(repositoryRoot, fileName);
        const sourceFile = project?.program.getSourceFile(fileName);
        if (!checker || !file || !sourceFile) continue;

        audited.add(fileName.toLowerCase());
        auditSourceFile({
          boundaries,
          checker,
          cueRootLower,
          file,
          sourceFile,
          surface,
          violations,
        });
      }

      // Exhaustiveness is the value of the scan: a module the project does not
      // type reports no violations, which reads exactly like a clean one. A
      // source root the project cannot see is therefore an error, never a
      // silently smaller scan.
      for (const modulePath of modulesUnder(target.sourceRoot)) {
        if (audited.has(modulePath.toLowerCase())) continue;
        throw new Error(
          `cue-audit-source-root-not-fully-typed:${
            toRepositoryRelative(repositoryRoot, modulePath) ?? modulePath
          }`,
        );
      }
    }
  } finally {
    api.close();
  }

  return violations;
}

type SourceFileAudit = {
  readonly boundaries: ReadonlySet<string>;
  readonly checker: Checker;
  readonly cueRootLower: string;
  readonly file: string;
  readonly sourceFile: SourceFile;
  readonly surface: CueSurface;
  readonly violations: CueAuditViolation[];
};

function auditSourceFile(context: SourceFileAudit): void {
  const {
    boundaries,
    checker,
    cueRootLower,
    file,
    sourceFile,
    surface,
    violations,
  } = context;

  const moduleSpecifiers: StringLiteral[] = [];
  const importBindings: {
    name: Expression;
    exported: string;
    specifier: string;
  }[] = [];
  /** Local names bound by `import * as X from "…"`. */
  const namespaceBindings = new Set<string>();
  /** Local names bound to a module that publishes an anchor. */
  const anchorBindings = new Set<string>();
  const tags: JsxOpeningLikeElement[] = [];
  const literals: string[] = [];
  const assertions: AsExpression[] = [];
  const attributes: {
    owner: JsxOpeningLikeElement;
    attribute: JsxAttribute;
  }[] = [];

  (function walk(node: Node) {
    if (isStringLiteralLike(node)) literals.push((node as StringLiteral).text);
    // `as const` freezes a literal it already has; it asserts nothing.
    if (isAsExpression(node) && node.type.getText() !== "const") {
      assertions.push(node);
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && isStringLiteral(specifier)) {
        moduleSpecifiers.push(specifier);
        const clause = isImportDeclaration(node)
          ? node.importClause
          : undefined;
        const named = clause?.namedBindings;
        if (named && isNamespaceImport(named)) {
          namespaceBindings.add(named.name.getText());
        }
        if (anchorModules.has(specifier.text)) {
          // A default import is the framework's own spelling — `import Link
          // from "next/link"` — and it is the only place in this walk a default
          // binding is read, because it is the only place one names an element.
          if (clause?.name) anchorBindings.add(clause.name.getText());
          for (const element of named && isNamedImports(named)
            ? named.elements
            : []) {
            anchorBindings.add(element.name.getText());
          }
        }
        for (const element of named && isNamedImports(named)
          ? named.elements
          : []) {
          importBindings.push({
            exported: (element.propertyName ?? element.name).getText(),
            name: element.name,
            specifier: specifier.text,
          });
        }
      }
    }
    if (isJsxOpeningLikeElement(node)) {
      tags.push(node);
      for (const attribute of node.attributes.properties) {
        if (isJsxAttribute(attribute)) {
          attributes.push({ attribute, owner: node });
        }
      }
    }
    node.forEachChild(walk);
  })(sourceFile);

  // Class names are read wherever the module writes them, not only under a
  // `className` attribute. Hoisting `"ui-panel"` into a constant, returning it
  // from a helper, or handing it to a `cn()` call does not make it a different
  // class, and a rule that only looked at the attribute would exempt all three.
  for (const token of new Set(classTokens(literals))) {
    // Every rule below reads the *decomposition* rather than the token. That is
    // the whole of the fix: a rule can still be wrong about what it forbids,
    // but it can no longer be blind to the spelling — the `!` on either end,
    // the leading sign, the `/…` modifier and the `:` inside a parenthesised
    // custom property are all taken off before any rule looks.
    const parsed = parseClassToken(token);
    if (parsed.form === "recorded-line") continue;
    // A generic family is a keyword in a `font-family` stack rather than a
    // class, and the root layout writes one bare — never behind a variant — so
    // this one exclusion stays on the raw token. `hover:ui-monospace` is not a
    // font stack, and is still read as the recipe it is spelled as.
    if (cssGenericFamilies.has(token)) continue;
    // Read from the parsed utility rather than the raw token, like every other
    // class rule. This was the one rule the canonical parser never reached, and
    // the anchors it kept were the ones the parser exists to take off: `md:` in
    // front of a retired recipe, or the important flag behind it, hid it from
    // the only rule that looks for one. The *detail* stays the written token —
    // what a reviewer has to go and delete is the spelling, not the stem.
    if (legacyRecipeClass.test(parsed.utility)) {
      violations.push({ detail: token, file, rule: "legacy-class" });
      continue;
    }
    if (!isUtilityClassToken(parsed)) continue;

    // A variant's bracket is a condition rather than a paint, and the one
    // condition section 5.2 bounds is the breakpoint: three thresholds, no
    // more. The stylesheet channel has enforced that since it was written; the
    // class channel could not see a variant bracket at all, because the
    // arbitrary-value rule required the *whole token* to end in `]`. So a
    // bracket qualifying a perfectly conforming utility —
    // `min-[37rem]:p-(--cue-space-2)` — introduced a fourth breakpoint that
    // reached the emitted stylesheet with nothing to say about it.
    //
    // The chain is read before the utility is, and for every form rather than
    // for some. The declaration branch below returns, so reading the chain
    // after it made the one utility form that carries no utility name also the
    // one form whose condition nobody read: `min-[37rem]:[display:grid]` was a
    // fourth threshold the scan had nothing to say about, while the identical
    // threshold in front of a named, an arbitrary-value or a custom-property
    // utility was caught. What section 5.2 bounds is the threshold, not the
    // utility standing behind it.
    //
    // A colour in a variant is not read here on purpose: a condition paints
    // nothing, and `data-[tone=red]:` is a state test rather than a palette.
    if (parsed.variants.some(hasUnreviewedThreshold)) {
      violations.push({ detail: token, file, rule: "arbitrary-class-value" });
    }

    // Tailwind v4's arbitrary *property* form is a whole CSS declaration
    // written as a class, and it is the only utility that carries no utility
    // name: `[--radius-control:3px]`, `[color:#ff0000]`.
    //
    // It is judged as the declaration it is, against the same three rules a
    // stylesheet declaration is judged against. The shadow rule matters most
    // here: Tailwind emits these into `@layer utilities` and the CUE++ bridge
    // sits in `@layer theme`, so a redeclared token name in a class outranks
    // the bridge everywhere the class lands — the same defect as the retired
    // unlayered `:root` rule, one subtree at a time.
    if (parsed.declaration) {
      const { property, value } = parsed.declaration;
      if (surface.tokenProperties.has(property)) {
        violations.push({
          detail: token,
          file,
          rule: "token-shadow-declaration",
        });
      }
      if (rawColour.test(value)) {
        violations.push({ detail: token, file, rule: "raw-color-declaration" });
      }
      if (rawLength.test(value)) {
        violations.push({
          detail: token,
          file,
          rule: "raw-geometry-declaration",
        });
      }
      continue;
    }

    if (tailwindPalette.test(parsed.utility) || hasRawArbitraryValue(parsed)) {
      violations.push({ detail: token, file, rule: "arbitrary-class-value" });
      continue;
    }

    // Tailwind's own scale, which is the other half of the same hole. `p-4`,
    // `h-8`, `gap-2`, `w-64`, `rounded-lg` and `text-2xl` carry no bracket and
    // no palette name, so nothing in the audit looked at them — and none of
    // them resolves through a CUE++ density token. They resolve through
    // Tailwind's `--spacing`, radius and type ladders instead: `h-8` pins a
    // control at a fixed 2rem that does not move when the reader changes
    // density, and `text-2xl` is the second type scale the reskin retired.
    //
    // The conforming spellings already exist in this codebase and keep
    // passing: `h-control-sm` names a key the bridge publishes, and
    // `text-(length:--cue-text-label)` names the token outright.
    const rung = untokenizedScaleValue(parsed, surface);
    if (
      rung !== undefined &&
      !(reviewedScaleUtilities[file] ?? []).includes(token)
    ) {
      violations.push({ detail: token, file, rule: "untokenized-class-value" });
    }
  }

  const assertedTypes = checker.getTypeAtLocation(assertions);
  assertions.forEach((assertion, index) => {
    const members = literalStringMembers(assertedTypes[index]);
    if (!members || !isAppearanceAssertion(members)) return;
    violations.push({
      detail: collapse(assertion.getText()),
      file,
      rule: "appearance-type-cast",
    });
  });

  /** Local JSX name to the name CUE++ publishes it under. */
  const cueExportNames = new Map(
    importBindings
      .filter((binding) => binding.specifier.startsWith("@cueplusplus/ui"))
      .map((binding) => [binding.name.getText(), binding.exported] as const),
  );

  for (const specifier of moduleSpecifiers) {
    if (!isLegacyPackageSpecifier(specifier.text)) continue;
    violations.push({ detail: specifier.text, file, rule: "legacy-import" });
  }

  const bindingSymbols = checker.getSymbolAtLocation(
    importBindings.map((binding) => binding.name),
  );
  bindingSymbols.forEach((symbol, index) => {
    const binding = importBindings[index];
    if (!binding || !symbol) return;
    if (!binding.specifier.startsWith("@cueplusplus/ui")) return;

    const target = aliasTarget(checker, symbol);
    const declared = target?.declarations?.[0]?.path?.toLowerCase();
    if (!declared?.startsWith(`${cueRootLower}${sep}`)) return;

    const expected = smallestCueSubpath(
      relative(cueRootLower, declared).split(sep).join("/"),
    );
    if (expected === binding.specifier) return;
    violations.push({
      detail: `${binding.specifier}:${binding.name.getText()}->${expected}`,
      file,
      rule: "cue-import-subpath",
    });
  });

  const tagSymbols = checker.getSymbolAtLocation(
    tags.map((tag) => rootIdentifier(tag.tagName)),
  );
  const cueTagByNode = new Map<JsxOpeningLikeElement, string>();

  tags.forEach((tag, index) => {
    const written = tag.tagName.getText();
    if (/^[a-z]/u.test(written) && !written.includes(".")) {
      if (written === "svg") {
        if (!reviewedLocalSvgModules.includes(file)) {
          violations.push({ detail: "svg", file, rule: "local-svg" });
        }
        return;
      }
      if (!visibleControls.has(written)) return;
      if (written === "input" && hasHiddenType(tag)) return;
      violations.push({ detail: written, file, rule: "raw-visible-control" });
      return;
    }

    const target = aliasTarget(checker, tagSymbols[index]);
    const declared = target?.declarations?.[0]?.path?.toLowerCase();
    if (!declared?.startsWith(`${cueRootLower}${sep}`)) return;

    // The symbol says the tag is a CUE++ component; the *name* it is documented
    // under is the one the package exports it as, rather than the local name
    // this module chose. Aliasing a CUE++ import is routine — `Link` and
    // `Button` collide with plenty — and reading the alias as the component
    // name reported every documented component imported that way as
    // undocumented, and quietly stopped verifying its variants. The fully
    // resolved symbol's own name is no help: the published declarations are
    // bundled, so `Field` is declared as `Field$1`.
    //
    // Three shapes reach a CUE++ component under a name the local import does
    // not spell, and all three have to land on the same documented name:
    //
    // - a named import, aliased or not — the specifier says it came from the
    //   package and the property name is what the package calls it;
    // - a namespace import, where the *member* is the exported name and the
    //   namespace itself names nothing the manifest documents;
    // - a local barrel that re-exports the component, where the consumer's
    //   specifier is local and only the alias chain knows where the tag ends
    //   up.
    const member = written.indexOf(".");
    const local = member < 0 ? written : written.slice(0, member);
    const suffix = member < 0 ? "" : written.slice(member + 1);
    const resolved =
      namespaceBindings.has(local) && suffix
        ? suffix
        : `${
            cueExportNames.get(local) ??
            publishedCueName(checker, tagSymbols[index], cueRootLower) ??
            local
          }${member < 0 ? "" : written.slice(member)}`;

    cueTagByNode.set(tag, resolved);
    if (!surface.documented.has(resolved)) {
      violations.push({
        detail: resolved,
        file,
        rule: "undocumented-cue-component",
      });
    }
  });

  type AxisValue = {
    component: string;
    property: string;
    value: Expression;
    /** Present when the value is written out as a literal in the JSX itself. */
    literal?: string;
  };
  const axisValues: AxisValue[] = [];

  for (const { attribute, owner } of attributes) {
    const name = attribute.name.getText();

    if (
      name === "asChild" &&
      !boundaries.has(file) &&
      isApplicationModule(file)
    ) {
      violations.push({
        detail: owner.tagName.getText(),
        file,
        rule: "as-child",
      });
    }

    if (name === "className") {
      const written = owner.tagName.getText();
      // An anchor the application styles itself has to say what its focus ring
      // is. Section 13 requires the indicator to come from the CUE++ focus
      // token, and `raw-visible-control` excludes `a` on purpose — an anchor
      // carries no visual recipe, so nothing else in the audit ever looks at
      // one. The retired stylesheet's element-level `:focus-visible` rule used
      // to supply the ring for every anchor in the document; retiring it was
      // right (it was unlayered, so it had been overriding the package's own
      // ring on every button, input and select) but it left the anchors with
      // the browser default while every CUE++ control beside them draws
      // `outline-color: var(--cue-accent)`.
      //
      // An anchor with no `className` is not this: it is either unstyled or
      // inside a component that owns its recipe, and the application is making
      // no claim about how it looks.
      if (written === anchorElement || anchorBindings.has(written)) {
        const literals: string[] = [];
        (function collect(node: Node) {
          if (isStringLiteralLike(node)) {
            literals.push((node as StringLiteral).text);
          }
          node.forEachChild(collect);
        })(attribute);
        const claim = focusOutlineClaim(classTokens(literals), surface);
        if (!claim.held) {
          // An anchor that writes nothing is named by its tag; one that writes
          // a focus claim that does not draw a ring is named by the claim, so
          // the finding says which of a file's anchors it is about and what
          // about it is wrong.
          violations.push({
            detail:
              claim.written.length > 0
                ? `${written}:${claim.written.join(" ")}`
                : written,
            file,
            rule: "anchor-focus-contract",
          });
        }
      }
    }

    if (name === "style") {
      const written = collapse(attribute.getText());
      // The list holds the object only (see ui-style-allowlist.ts); the
      // attribute's name is added back here from `name`, not written out, so a
      // text scan of this module reads no style prop in it.
      const reviewed = (reviewedInlineStyleProps[file] ?? []).map(
        (value) => `${name}={${value}}`,
      );
      if (!reviewed.includes(written)) {
        violations.push({
          detail: written,
          file,
          rule: "application-style-prop",
        });
      }
    }

    const component = cueTagByNode.get(owner);
    if (!component) continue;
    const axes = surface.axesByComponent.get(component.split(".")[0] ?? "");
    if (!axes?.has(name) || !attribute.initializer) continue;

    const initializer = attribute.initializer;
    const value = isJsxExpression(initializer)
      ? initializer.expression
      : initializer;
    if (!value) continue;
    axisValues.push({
      component,
      literal: isStringLiteral(value) ? value.text : undefined,
      property: name,
      value,
    });
  }

  // A literal written in the JSX is read straight off the node; only a value
  // that came from somewhere else needs the checker to say what it can be.
  const inferred = axisValues.filter((entry) => entry.literal === undefined);
  const inferredTypes = checker.getTypeAtLocation(
    inferred.map((entry) => entry.value),
  );
  const typeByEntry = new Map<AxisValue, Type | undefined>(
    inferred.map((entry, index) => [entry, inferredTypes[index]]),
  );

  for (const entry of axisValues) {
    const axis = surface.axesByComponent
      .get(entry.component.split(".")[0] ?? "")
      ?.get(entry.property);
    const type = typeByEntry.get(entry);
    const members =
      entry.literal === undefined
        ? literalStringMembers(type)
        : [entry.literal];

    if (members && axis && members.every((member) => axis.has(member))) {
      continue;
    }
    violations.push({
      detail: `${entry.component}.${entry.property}=${
        entry.literal === undefined
          ? type
            ? checker.typeToString(type)
            : "unknown"
          : JSON.stringify(entry.literal)
      }`,
      file,
      rule: "unverified-variant",
    });
  }
}

/**
 * The name the installed package exports a symbol under, found by stepping the
 * alias chain rather than by reading the import that happens to be in view.
 *
 * The first symbol on the chain whose declaration lives inside the package is
 * the package's own export alias, and its name is the manifest's name — even
 * when the declaration that alias finally points at is a bundled `Field$1`, and
 * even when the module in front of it is a local barrel that renamed it. One
 * hop at a time is the whole point: `getAliasedSymbol` jumps to the end and the
 * end is where the name stops being the published one.
 *
 * `undefined` when the chain leaves the package's reach, which leaves the
 * caller reporting the local name — the same answer it gave before, for the
 * same tags.
 */
function publishedCueName(
  checker: Checker,
  symbol: CheckerSymbol | undefined,
  cueRootLower: string,
): string | undefined {
  let current = symbol;

  // A chain longer than this is a re-export cycle, not a barrel.
  for (let hop = 0; current && hop < 16; hop += 1) {
    const declared = current.declarations?.[0]?.path?.toLowerCase();
    if (declared?.startsWith(`${cueRootLower}${sep}`)) return current.name;

    let next: CheckerSymbol | undefined;
    try {
      next = checker.getImmediateAliasedSymbol(current);
    } catch {
      return undefined;
    }
    if (!next || next.id === current.id) return undefined;
    current = next;
  }

  return undefined;
}

function aliasTarget(
  checker: Checker,
  symbol: CheckerSymbol | undefined,
): CheckerSymbol | undefined {
  if (!symbol) return undefined;
  try {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased && !checker.isUnknownSymbol(aliased)) return aliased;
  } catch {}

  return symbol;
}

/**
 * A module the application ships, as opposed to a suite that renders one.
 *
 * `asChild` is `React.Children.only` plus `cloneElement`, and the rule against
 * it protects shipped modules from cloning an element they did not create
 * across the RSC boundary. A suite that mounts the verified provider to drive a
 * real portal is exercising that boundary rather than opening a second one, so
 * the same exclusion the document-wide contract in
 * `src/app/framework-boundaries.test.tsx` makes applies here.
 */
export function isApplicationModule(file: string): boolean {
  return !/\.test\.tsx?$/u.test(file);
}

function hasHiddenType(tag: JsxOpeningLikeElement): boolean {
  for (const attribute of tag.attributes.properties) {
    if (!isJsxAttribute(attribute)) continue;
    if (attribute.name.getText() !== "type") continue;
    const initializer = attribute.initializer;
    if (initializer && isStringLiteral(initializer)) {
      return initializer.text === "hidden";
    }
  }

  return false;
}

/**
 * Whether a parsed token carries a raw colour or a raw length in a value the
 * *utility* writes.
 *
 * The value, the modifier and — through {@link parseClassToken} — nothing else
 * are read. A variant's bracket is a condition rather than a paint, so it is
 * judged separately and on its own terms; reading it here is what used to make
 * `max-[42rem]:bg-[#ff0000]` a finding about its breakpoint instead of about
 * its colour.
 *
 * A *bracketed* modifier is read as well, because it is an arbitrary value in
 * its own right: `text-base/[12px]` writes a raw line height that no rung of
 * the type ladder answers. A bare modifier is not read, because it is a rung or
 * a percentage rather than a value — and because reading it made a documentation
 * URL whose path happens to end in a palette name into a colour finding.
 */
function hasRawArbitraryValue(parsed: ParsedClassToken): boolean {
  // The modifier is kept raw on the parsed token because the rung rule reads it
  // back as a *rung* — `w-1/2` is a half — so the one consumer that reads it as
  // a value normalises it here, through the same function the two value
  // branches use rather than through a second copy of the convention.
  const bracketedModifier = /^\[(.*)\]$/su.exec(parsed.modifier ?? "")?.[1];
  const written = [
    parsed.form === "arbitrary-value" ? parsed.value : undefined,
    bracketedModifier === undefined
      ? undefined
      : arbitraryValueText(bracketedModifier),
  ];

  return written.some(
    (value) =>
      value !== undefined && (rawColour.test(value) || rawLength.test(value)),
  );
}

/**
 * Every raw length written inside a variant's bracket that section 5.2 does not
 * license as a responsive threshold.
 *
 * Only *named* variants escape this, and they escape it deliberately: `md:` is
 * a key Tailwind's own theme publishes, the shell uses it, and holding a theme
 * key to the tuple allowlist would flag conforming application layout rather
 * than the hand-written threshold this rule is about. That narrowing is
 * recorded in `ui-style-allowlist.ts` with the rest of them.
 */
function hasUnreviewedThreshold(variant: string): boolean {
  const start = trailingGroupStart(variant);
  if (start === undefined || variant[start] !== "[") return false;

  // Through the same normalisation the two value branches and the bracketed
  // modifier use. A variant bracket is the fourth site that produces a value,
  // and it was the one site the convention was never read back in: `_` is a
  // word character, so `[@media(min-width:_37rem)]` defeated the raw-length
  // lookbehind exactly as `h-[calc(100%_-_2px)]` did before the convention was
  // read at all — a fourth breakpoint that reached the stylesheet in silence.
  return [
    ...arbitraryValueText(variant.slice(start + 1, -1)).matchAll(rawLengths),
  ].some((match) => !isAllowedMediaThreshold(match[0]));
}

/** {@link rawLength}, over every match rather than the first. */
const rawLengths = new RegExp(rawLength.source, "giu");

/** Whether the parsed token is one of the four forms Tailwind compiles. */
function isUtilityClassToken(parsed: ParsedClassToken): boolean {
  return (utilityClassTokenForms as readonly string[]).includes(parsed.form);
}

/**
 * The modules that publish an anchor the application routes through: the
 * framework's own `Link`, which renders an `<a>` and forwards `className` to it
 * untouched.
 *
 * A CUE++ `Link` is not here on purpose. It carries the package's focus recipe
 * itself, so an application that reaches for it has already met the contract —
 * which is what makes routing through it, rather than copying four utilities,
 * the fix this rule wants.
 */
const anchorModules = new Set(["next/link"]);

/** The intrinsic element the rule is really about. */
const anchorElement = "a";

/**
 * What an anchor's own classes claim about its focus indicator, and whether the
 * claim amounts to a ring.
 *
 * The first version of this rule asked only for a `focus-visible:` outline
 * utility that was not the literal `outline-none`, and every spelling that
 * removes the ring satisfied it. Tailwind v4 spells that same suppression
 * `outline-hidden`, which the rule *admitted* under its other name; `outline-0`
 * sets a width of `0`; and a bare colour such as `outline-accent` sets
 * `outline-color` and neither a width nor a style, so it paints an outline that
 * is never drawn. A rule delivered to hold section 13 could be satisfied by
 * markup with no visible focus indicator at all.
 *
 * So the claim has to add up to a ring: a **width** that is not `0`, a **colour** that
 * resolves through a CUE++ token, and no suppressing spelling anywhere in the
 * `focus-visible:` outline utilities. That is what the package's chassis wrote
 * at 0.14.1 — `focus-visible:outline-2`, `focus-visible:outline-solid`,
 * `focus-visible:outline-accent`. Since 0.17.0 it writes the colour as
 * `focus-visible:outline-(--cue-focus)`, which this rule reads as a token
 * colour, and the width as an arbitrary length, which it does not read as a
 * width; either way the fix stays "route through the package's `Link`" rather
 * than "copy four utilities".
 *
 * The width is deliberately not required to name `--cue-focus-ring`. The token
 * layer declares it, but the bridge publishes no theme key for it, so there is
 * no shorter conforming spelling than the raw custom property and the package
 * itself writes the rung. Requiring the token would flag the design system's
 * own focus contract, so the rule requires what the bridge does publish: the
 * *colour* comes from a CUE++ key.
 */
const outlineUtility = "outline";

/** Every spelling whose whole effect is to take the ring away. */
const suppressedOutlineValues = new Set(["none", "hidden", "0"]);

/** A width rung that draws something. `0` is in the set above, not here. */
const positiveRung = /^[1-9]\d*$/u;

function focusOutlineClaim(
  tokens: readonly string[],
  surface: CueSurface,
): { held: boolean; written: readonly string[] } {
  const written: string[] = [];
  let width = false;
  let colour = false;
  let suppressed = false;

  for (const token of tokens) {
    const parsed = parseClassToken(token);
    if (!parsed.variants.includes(focusVisibleVariant)) continue;
    const name =
      parsed.form === "custom-property" ? parsed.name : parsed.utility;
    if (name !== outlineUtility && !name?.startsWith(`${outlineUtility}-`)) {
      continue;
    }
    written.push(token);

    // `outline-(length:--cue-focus-ring)` is a width and `outline-(--cue-accent)`
    // a colour: v4 reads the unhinted shorthand on this family as the colour.
    if (parsed.form === "custom-property") {
      if (
        parsed.name !== outlineUtility ||
        !(parsed.value ?? "").startsWith(cueTokenPrefix)
      ) {
        continue;
      }
      if (parsed.hint === "length") width = true;
      else if (parsed.hint === undefined || parsed.hint === "color") {
        colour = true;
      }
      continue;
    }

    if (parsed.form !== "named") continue;
    const value = parsed.utility.slice(outlineUtility.length + 1);
    if (suppressedOutlineValues.has(value)) suppressed = true;
    else if (positiveRung.test(value)) width = true;
    else if (surface.themeKeysByNamespace.get(colourNamespace)?.has(value)) {
      colour = true;
    }
  }

  return { held: width && colour && !suppressed, written };
}

/** The bridge namespace a CUE++ ink key is published under. */
const colourNamespace = "color";

/** The variant section 13's indicator is written under. */
const focusVisibleVariant = "focus-visible";

/**
 * The transition utilities whose property list covers the outline's colour.
 *
 * Tailwind v4 added `outline-color` to the list `transition` and its two
 * narrower spellings animate. A chassis that carries one of them and paints its
 * ring on `:focus-visible` is therefore not drawing a ring — it is *fading* one
 * in, from whatever colour the element's outline already had.
 */
const transitionUtility = "transition";
const colourTransitionUtilities = new Set([
  transitionUtility,
  `${transitionUtility}-all`,
  `${transitionUtility}-colors`,
]);

/**
 * One string or template literal in a compiled module.
 *
 * A template keeps each `${…}` substitution as the expression's source text,
 * so a class string the package assembles from shared constants can be read
 * whole once those constants are resolved.
 */
type ModuleLiteral = Readonly<{
  /**
   * The name a `const`, `let` or `var` binds the literal to, when the literal
   * is that binding's whole initialiser.
   */
  boundTo: string | undefined;
  parts: readonly (string | Readonly<{ expression: string }>)[];
}>;

type ScannedModule = Readonly<{
  /**
   * The module without its comments or its templates' text: a template is
   * written as its substitutions' code, each in parentheses, then "``".
   */
  code: string;
  literals: readonly ModuleLiteral[];
}>;

const identifierCharacter = /[\w$]/u;

/** The words after which a `/` opens a regular expression. */
const regexAfterWords = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** The punctuation after which a `/` opens a regular expression. */
const regexAfterPunctuation = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

/**
 * Every string and template literal in one compiled module, read by a lexer.
 *
 * A pattern run over the whole file reads the module's comments too, and the
 * package's comments quote class strings in backticks: `system/_focus-ring.js`
 * at 0.29.0 describes the rings it replaced as `focus-visible:outline-2 …
 * focus-visible:outline-accent`, and a pattern reads that as a ring the
 * package draws. The lexer skips both kinds of comment and steps over a
 * regular-expression literal, so a quote inside one does not open a string.
 * Whether a `/` opens one is judged from the token in front of it alone.
 * Where a parser needs more than that — a regular expression straight after a
 * `)` or a `}`, a division after a property named like a keyword — this lexer
 * can judge wrongly: a regular expression read as a division has its body
 * read as code, where a quote opens a string.
 */
function scanModule(source: string): ScannedModule {
  const literals: ModuleLiteral[] = [];
  const code: string[] = [];
  let tail = "";
  let last = "";
  let word = "";
  let previous = "";
  let position = 0;

  const write = (text: string): void => {
    code.push(text);
    tail = (tail + text).slice(-160);
    for (const character of text) {
      if (/\s/u.test(character)) {
        previous = character;
        continue;
      }
      if (identifierCharacter.test(character)) {
        word = identifierCharacter.test(previous)
          ? word + character
          : character;
      } else {
        word = "";
      }
      last = character;
      previous = character;
    }
  };

  const bindingBefore = (): string | undefined =>
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(tail)?.[1];
  const endsInitialiser = (): boolean =>
    /^[ \t]*(?:[;,\n]|$)/u.test(source.slice(position, position + 40));
  const regexMayStart = (): boolean =>
    last === "" ||
    regexAfterPunctuation.has(last) ||
    (identifierCharacter.test(last) && regexAfterWords.has(word));

  const scanString = (quote: string): void => {
    const start = position;
    const boundTo = bindingBefore();
    position += 1;
    while (position < source.length) {
      const character = source[position];
      if (character === "\\") position += 2;
      else if (character === quote) {
        position += 1;
        break;
      } else if (character === "\n") break;
      else position += 1;
    }
    const closed = position - 1 > start && source[position - 1] === quote;
    literals.push({
      boundTo: boundTo !== undefined && endsInitialiser() ? boundTo : undefined,
      parts: [source.slice(start + 1, closed ? position - 1 : position)],
    });
    write(source.slice(start, position));
  };

  const scanRegex = (): void => {
    let inClass = false;
    position += 1;
    while (position < source.length) {
      const character = source[position];
      if (character === "\\") {
        position += 2;
        continue;
      }
      if (character === "\n") break;
      position += 1;
      if (character === "[") inClass = true;
      else if (character === "]") inClass = false;
      else if (character === "/" && !inClass) break;
    }
    while (identifierCharacter.test(source[position] ?? "")) position += 1;
    write("/r/");
  };

  const scanTemplate = (): void => {
    const boundTo = bindingBefore();
    const parts: (string | { expression: string })[] = [];
    let text = "";
    position += 1;
    while (position < source.length) {
      const character = source[position] ?? "";
      if (character === "\\") {
        text += source.slice(position, position + 2);
        position += 2;
        continue;
      }
      if (character === "`") {
        position += 1;
        break;
      }
      if (character === "$" && source[position + 1] === "{") {
        parts.push(text);
        text = "";
        position += 2;
        const start = position;
        // An expression opens where a regular expression may start.
        write("(");
        scanCode(true);
        parts.push({ expression: source.slice(start, position).trim() });
        write(")");
        position += 1;
        continue;
      }
      text += character;
      position += 1;
    }
    parts.push(text);
    literals.push({
      boundTo: boundTo !== undefined && endsInitialiser() ? boundTo : undefined,
      parts,
    });
    write("``");
  };

  /** Code up to the end, or up to the `}` that closes a substitution. */
  const scanCode = (toClosingBrace: boolean): void => {
    let depth = 0;
    while (position < source.length) {
      const character = source[position] ?? "";
      const next = source[position + 1] ?? "";
      if (character === "/" && next === "/") {
        const end = source.indexOf("\n", position);
        position = end < 0 ? source.length : end;
        continue;
      }
      if (character === "/" && next === "*") {
        const end = source.indexOf("*/", position + 2);
        position = end < 0 ? source.length : end + 2;
        write(" ");
        continue;
      }
      if (character === '"' || character === "'") {
        scanString(character);
        continue;
      }
      if (character === "`") {
        scanTemplate();
        continue;
      }
      if (character === "/" && regexMayStart()) {
        scanRegex();
        continue;
      }
      if (toClosingBrace && character === "{") depth += 1;
      if (toClosingBrace && character === "}") {
        if (depth === 0) return;
        depth -= 1;
      }
      write(character);
      position += 1;
    }
  };

  scanCode(false);
  return { code: code.join(""), literals };
}

type ModuleReference = Readonly<{ from: string; name: string }>;

/** What one module binds, imports and exports, as the resolver needs it. */
type ModuleShape = Readonly<{
  constants: ReadonlyMap<string, ModuleLiteral>;
  exports: ReadonlyMap<string, ModuleReference | Readonly<{ local: string }>>;
  imports: ReadonlyMap<string, ModuleReference>;
  literals: readonly ModuleLiteral[];
}>;

const namedImport =
  /\bimport\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/gu;
const namedExport = /\bexport\s*\{([^}]*)\}(?:\s*from\s*(["'])([^"']+)\2)?/gu;

/** `a, b as c` → `[["a", "a"], ["b", "c"]]`: each name and what it is called. */
function namedBindings(list: string): [string, string][] {
  return list
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const [name = "", alias] = item.split(/\s+as\s+/u);
      return [name.trim(), (alias ?? name).trim()];
    });
}

/**
 * Class strings with their `${NAME}` substitutions put back.
 *
 * The package composes its classes: `system/_focus-ring.ts` holds the ring,
 * and a chassis writes `` `… transition-colors ${FOCUS_RING}` ``. Read as
 * written, the literal that draws a ring and the literal that animates it are
 * different literals, so nothing ever sees the two together. A substitution
 * that is one identifier is resolved through the module's own literal-valued
 * bindings and its relative named imports, recursively; any other expression
 * stands for no classes. A name bound twice in one module resolves to its
 * first binding, and a binding initialised by anything but one literal (a
 * `cn(…)` call, a concatenation) is not resolved at all, so a ring and a
 * transition joined only by a call are not seen together.
 */
function classStringResolver(modules: ReadonlyMap<string, string>) {
  const shapes = new Map<string, ModuleShape | undefined>();

  const shapeOf = (path: string): ModuleShape | undefined => {
    if (shapes.has(path)) return shapes.get(path);
    const source = modules.get(path);
    let shape: ModuleShape | undefined;
    if (source !== undefined) {
      const scanned = scanModule(source);
      const constants = new Map<string, ModuleLiteral>();
      for (const literal of scanned.literals) {
        if (literal.boundTo !== undefined && !constants.has(literal.boundTo)) {
          constants.set(literal.boundTo, literal);
        }
      }
      const target = (specifier: string): string | undefined =>
        specifier.startsWith(".") ? join(dirname(path), specifier) : undefined;
      const imports = new Map<string, ModuleReference>();
      for (const match of scanned.code.matchAll(namedImport)) {
        const from = target(match[3] ?? "");
        if (from === undefined) continue;
        for (const [name, local] of namedBindings(match[1] ?? "")) {
          imports.set(local, { from, name });
        }
      }
      const exports = new Map<
        string,
        ModuleReference | Readonly<{ local: string }>
      >();
      for (const match of scanned.code.matchAll(namedExport)) {
        const specifier = match[3];
        const from = specifier === undefined ? undefined : target(specifier);
        if (specifier !== undefined && from === undefined) continue;
        for (const [name, exported] of namedBindings(match[1] ?? "")) {
          exports.set(
            exported,
            from === undefined ? { local: name } : { from, name },
          );
        }
      }
      shape = { constants, exports, imports, literals: scanned.literals };
    }
    shapes.set(path, shape);
    return shape;
  };

  const exported = (
    path: string,
    name: string,
    seen: ReadonlySet<string>,
  ): string | undefined => {
    const entry = shapeOf(path)?.exports.get(name);
    if (entry === undefined) return bound(path, name, seen);
    return "local" in entry
      ? bound(path, entry.local, seen)
      : exported(entry.from, entry.name, seen);
  };

  const bound = (
    path: string,
    name: string,
    seen: ReadonlySet<string>,
  ): string | undefined => {
    const key = `${path}#${name}`;
    if (seen.has(key)) return undefined;
    const within = new Set(seen).add(key);
    const shape = shapeOf(path);
    const constant = shape?.constants.get(name);
    if (constant !== undefined) return text(path, constant, within);
    const imported = shape?.imports.get(name);
    return imported === undefined
      ? undefined
      : exported(imported.from, imported.name, within);
  };

  const text = (
    path: string,
    literal: ModuleLiteral,
    seen: ReadonlySet<string> = new Set(),
  ): string =>
    literal.parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (!/^[A-Za-z_$][\w$]*$/u.test(part.expression)) return " ";
        return ` ${bound(path, part.expression, seen) ?? ""} `;
      })
      .join("");

  return { shapeOf, text };
}

/** Every compiled module the installed package ships, at any depth. */
function compiledPackageModules(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const next = join(root, entry.name);
    if (entry.isDirectory()) return compiledPackageModules(next);

    return entry.name.endsWith(".js") ? [next] : [];
  });
}

export type CueFocusRingComposition = Readonly<{
  /**
   * Whether a class string that draws a ring also animates `outline-color`,
   * so the ring fades in from whatever colour the outline had at rest.
   */
  animated: boolean;
  /**
   * The colour those animated rings are drawn in — or, when none is animated,
   * the one colour every ring is drawn in: a `var(--…)` reference for a bridge
   * key or a custom property, or the colour an arbitrary value writes.
   */
  colour: string;
}>;

/** What `focusRingCompositionOf` reads: a package's modules and its bridge. */
export type FocusRingSources = Readonly<{
  /** Each compiled module's source, by its path. */
  modules: ReadonlyMap<string, string>;
  /** The colour keys the bridge publishes: `accent` for `outline-accent`. */
  colourKeys: ReadonlySet<string>;
  /** The bridge's `--color-<key>` names, each mapped to the token it reads. */
  tokenNameByUtility: ReadonlyMap<string, string>;
  /** The classes the package's stylesheet transitions `outline-color` on. */
  transitionClasses: ReadonlySet<string>;
}>;

/**
 * The colour one class token paints a `:focus-visible` ring in, or nothing.
 *
 * Three spellings draw one: a bridge key (`focus-visible:outline-accent`, how
 * 0.14.1 wrote every ring but two), a custom property
 * (`focus-visible:outline-(--cue-focus)`, how 0.14.1 wrote those two — the
 * recessed field chassis's and, under `has-focus-visible:`, the grouped
 * field's — and how every ring but a field's is written since 0.17.0), and an arbitrary value
 * hinted or shaped as a colour (`focus-visible:outline-[color:color-mix(…)]`,
 * a recessed field's faint ring since 0.24.0). The variant chain must be
 * `focus-visible` alone, as the prefix this replaced required.
 */
function ringColourOf(
  token: string,
  sources: FocusRingSources,
): string | undefined {
  const parsed = parseClassToken(token);
  if (
    parsed.negated ||
    parsed.variants.length !== 1 ||
    parsed.variants[0] !== focusVisibleVariant
  ) {
    return undefined;
  }
  if (parsed.form === "named") {
    if (!parsed.utility.startsWith(`${outlineUtility}-`)) return undefined;
    const key = parsed.utility.slice(outlineUtility.length + 1);
    if (!sources.colourKeys.has(key)) return undefined;
    const property = sources.tokenNameByUtility.get(
      `--${colourNamespace}-${key}`,
    );
    if (property === undefined) {
      throw new Error(`cue-focus-ring-colour-is-unbridged:${key}`);
    }
    return `var(${property})`;
  }
  if (parsed.name !== outlineUtility) return undefined;
  if (parsed.form === "custom-property") {
    return parsed.hint === undefined || parsed.hint === "color"
      ? `var(${parsed.value})`
      : undefined;
  }
  if (parsed.form !== "arbitrary-value") return undefined;
  const value = parsed.value ?? "";
  const hinted = /^([a-z-]+):(.+)$/su.exec(value);
  if (hinted)
    return hinted[1] === "color" ? (hinted[2] ?? "").trim() : undefined;
  // Unhinted, Tailwind reads a length as the width and anything else as the
  // colour.
  return /^(?:-?[\d.]|calc\(|min\(|max\(|clamp\()/u.test(value)
    ? undefined
    : value;
}

/**
 * The CSS properties these readers look for, assembled from the names above
 * rather than spelled, because the class rules read every string literal this
 * module writes and a utility-shaped one written out here would be read.
 */
const outlineColourProperty = `${outlineUtility}-${colourNamespace}`;
const transitionProperty = `${transitionUtility}-property`;

/** Whether one class token gives its element a transition on `outline-color`. */
function animatesOutlineColour(
  token: string,
  transitionClasses: ReadonlySet<string>,
): boolean {
  if (colourTransitionUtilities.has(token) || transitionClasses.has(token)) {
    return true;
  }
  const parsed = parseClassToken(token);
  if (
    parsed.variants.length > 0 ||
    parsed.form !== "arbitrary-value" ||
    parsed.name !== transitionUtility
  ) {
    return false;
  }
  return (parsed.value ?? "")
    .split(",")
    .map((property) => property.trim())
    .some(
      (property) => property === outlineColourProperty || property === "all",
    );
}

/**
 * The single-class selectors a stylesheet gives a transition on
 * `outline-color`: `.cue-press`, the button's press since 0.25.0, carries the
 * colours `transition-colors` did beside `scale`.
 */
export function outlineTransitionClasses(css: string): Set<string> {
  const classes = new Set<string>();
  for (const { property, selector, value } of declarationsIn(css)) {
    if (property !== transitionProperty && property !== transitionUtility) {
      continue;
    }
    const listed = value.split(/[\s,]+/u);
    if (!listed.includes(outlineColourProperty) && !listed.includes("all")) {
      continue;
    }
    for (const one of selector.split(",")) {
      const named = /^\.([A-Za-z][\w-]*)$/u.exec(one.trim());
      if (named?.[1]) classes.add(named[1]);
    }
  }
  return classes;
}

/**
 * How a package draws its focus rings, from its compiled modules.
 *
 * Each string and template literal is read with its `${NAME}` substitutions
 * resolved (`classStringResolver`), and a ring counts as animated when the
 * class string that draws it also animates `outline-color`. The resting colour
 * matters only for those: a ring drawn with no colour transition appears in
 * its own colour in the frame focus lands, whatever the outline held at rest.
 * That is what lets 0.29.0's two colours stand — every keyboard ring in
 * `--cue-focus`, animated, and a recessed field's ring in that token mixed
 * to 15%, which no field chassis animates.
 *
 * Animated rings in more than one colour would need more than one resting
 * declaration and a decision about which, so that is refused rather than
 * silently answered; so are rings in more than one colour of which none is
 * animated.
 */
export function focusRingCompositionOf(
  sources: FocusRingSources,
): CueFocusRingComposition {
  const resolver = classStringResolver(sources.modules);
  const drawn = new Set<string>();
  const animated = new Set<string>();

  for (const path of sources.modules.keys()) {
    for (const literal of resolver.shapeOf(path)?.literals ?? []) {
      const written = resolver
        .text(path, literal)
        .split(/\s+/u)
        .filter((token) => token.length > 0);
      const painted = written.flatMap((token) => {
        const colour = ringColourOf(token, sources);
        return colour === undefined ? [] : [colour];
      });
      if (painted.length === 0) continue;

      for (const colour of painted) drawn.add(colour);
      if (
        written.some((token) =>
          animatesOutlineColour(token, sources.transitionClasses),
        )
      ) {
        for (const colour of painted) animated.add(colour);
      }
    }
  }

  const chosen = animated.size > 0 ? animated : drawn;
  if (chosen.size !== 1) {
    throw new Error(
      `cue-focus-ring-colour-is-not-one:${[...chosen].toSorted().join(",")}`,
    );
  }

  const [colour = ""] = [...chosen];
  return Object.freeze({ animated: animated.size > 0, colour });
}

/**
 * How the installed package draws a focus ring, read from the package.
 *
 * The ring is painted on `:focus-visible` and suppressed at rest, so the colour
 * an element's outline resolves to *changes* the moment focus lands — and the
 * class string that draws it carries a transition that covers exactly that
 * property (`transition-colors`, or since 0.25.0 a button's `cue-press`).
 * Nothing declares what the outline's colour is before the change, so it is
 * `currentColor`: the control's own ink. The ring is therefore drawn, at full
 * width and solid, in the control's text colour for the whole of the
 * transition, which on the primary action is its light-on-accent ink — a ring
 * that begins invisible against a light ground.
 *
 * An application cannot edit the package's chassis, and it does not have to:
 * declaring the ring's own colour as the resting outline colour leaves the
 * change with nothing to animate, and the ring is its token colour in the frame
 * it appears. This function is what tells the stylesheet which colour that is,
 * so the rule follows the package rather than a memory of it. It reads every
 * compiled module under `dist`, and the stylesheet `@cueplusplus/ui/styles.css`
 * resolves to (that file alone, not what it imports) for the classes it
 * transitions.
 */
export function cueFocusRingComposition(): CueFocusRingComposition {
  const surface = loadCueSurface();
  const modules = new Map<string, string>();
  for (const module of compiledPackageModules(
    join(surface.packageRoot, "dist"),
  )) {
    modules.set(module, readFileSync(module, "utf8"));
  }

  return focusRingCompositionOf({
    colourKeys:
      surface.themeKeysByNamespace.get(colourNamespace) ?? new Set<string>(),
    modules,
    tokenNameByUtility: surface.tokenNameByUtility,
    transitionClasses: outlineTransitionClasses(
      readFileSync(require.resolve("@cueplusplus/ui/styles.css"), "utf8"),
    ),
  });
}

/**
 * Tailwind's radius family, assembled rather than spelled.
 *
 * A bare `rounded` is itself a governed utility — Tailwind's own default rung —
 * so writing it out here would make this module violate the rule it is
 * defining. The audit's suite assembles a retired recipe class for exactly the
 * same reason: the class rules read every string literal a module writes, which
 * is what stops a recipe being hoisted out of the attribute it used to live in,
 * and bookkeeping about a class is not exempt from being one.
 */
const bareScaleUtility = "rounded-t".slice(0, -2);

const radiusFamilies = [
  "-tl",
  "-tr",
  "-br",
  "-bl",
  "-ss",
  "-se",
  "-ee",
  "-es",
  "-t",
  "-r",
  "-b",
  "-l",
  "-s",
  "-e",
  "",
].map((corner) => ({
  modified: false,
  namespaces: ["radius"],
  prefix: `${bareScaleUtility}${corner}`,
}));

/**
 * Scroll padding and scroll margin, assembled over the nine edges each names.
 *
 * Section 5.2 names padding and margin among the families the class channel
 * must reject, and these are both of them: `scroll-p-4` and `scroll-mt-8` take
 * the same `--spacing` ladder rung as `p-4` and `mt-8`, and resolve through a
 * CUE++ density token exactly as little. They were neither governed nor written
 * down as an exception, which is the one state an exclusion may never be in.
 */
const scrollFamilies = ["m", "p"].flatMap((box) =>
  ["x", "y", "t", "r", "b", "l", "s", "e", ""].map((edge) => ({
    modified: false,
    namespaces: ["spacing"],
    prefix: `scroll-${box}${edge}`,
  })),
);

/**
 * The utility families whose value is a *measurement* — the ones section 5.2
 * requires to resolve through a CUE++ density token — with the Tailwind theme
 * namespaces whose keys do resolve through one.
 *
 * The `text-` prefix carries two namespaces because it spells two things: a
 * type step (`--text-*`) and an ink colour (`--color-*`). Both are published,
 * so both are conforming, and everything else `text-` can spell — `center`,
 * `nowrap`, `balance` — is neither a measurement nor a colour and is judged by
 * the value test below rather than by this list.
 *
 * Four families the specification does not name are deliberately absent, and
 * they are absent for a reason rather than by oversight:
 *
 * - **border, outline and ring widths and offsets.** The token layer declares
 *   `--cue-border-width`, `--cue-focus-ring` and `--cue-focus-ring-offset`, but
 *   the bridge publishes no key for any of them, so there is no shorter
 *   conforming spelling than the raw custom property — and the package's own
 *   chassis writes `outline-2` and `outline-offset-2`. Governing them would
 *   flag the design system's own focus contract.
 * - **font family and weight, leading and tracking.** A weight and a face are
 *   not lengths the density ladder scales, and `--cue-tracking-label` likewise
 *   has no bridge key.
 * - **translate, basis and indent.** These take fractions and percentages far
 *   more often than rungs. The one written in this codebase is the settings
 *   layout's `basis-lg` (Tailwind's `--container-lg`, 32rem; ruling 256): a
 *   page measure, for which CUE++ publishes no token.
 *
 * Every one of those is still reached by `arbitrary-class-value` the moment it
 * is written with a bracket, which is the form a raw measurement takes.
 */
const scaleFamilies: readonly {
  readonly prefix: string;
  readonly namespaces: readonly string[];
  /** Whether a `/` suffix on this family is a modifier rather than a fraction. */
  readonly modified: boolean;
}[] = [
  { modified: false, namespaces: ["spacing"], prefix: "max-h" },
  { modified: false, namespaces: ["spacing"], prefix: "max-w" },
  { modified: false, namespaces: ["spacing"], prefix: "min-h" },
  { modified: false, namespaces: ["spacing"], prefix: "min-w" },
  { modified: false, namespaces: ["spacing"], prefix: "size" },
  { modified: false, namespaces: ["spacing"], prefix: "h" },
  { modified: false, namespaces: ["spacing"], prefix: "w" },
  { modified: false, namespaces: ["spacing"], prefix: "px" },
  { modified: false, namespaces: ["spacing"], prefix: "py" },
  { modified: false, namespaces: ["spacing"], prefix: "pt" },
  { modified: false, namespaces: ["spacing"], prefix: "pr" },
  { modified: false, namespaces: ["spacing"], prefix: "pb" },
  { modified: false, namespaces: ["spacing"], prefix: "pl" },
  { modified: false, namespaces: ["spacing"], prefix: "ps" },
  { modified: false, namespaces: ["spacing"], prefix: "pe" },
  { modified: false, namespaces: ["spacing"], prefix: "p" },
  { modified: false, namespaces: ["spacing"], prefix: "mx" },
  { modified: false, namespaces: ["spacing"], prefix: "my" },
  { modified: false, namespaces: ["spacing"], prefix: "mt" },
  { modified: false, namespaces: ["spacing"], prefix: "mr" },
  { modified: false, namespaces: ["spacing"], prefix: "mb" },
  { modified: false, namespaces: ["spacing"], prefix: "ml" },
  { modified: false, namespaces: ["spacing"], prefix: "ms" },
  { modified: false, namespaces: ["spacing"], prefix: "me" },
  { modified: false, namespaces: ["spacing"], prefix: "m" },
  { modified: false, namespaces: ["spacing"], prefix: "gap-x" },
  { modified: false, namespaces: ["spacing"], prefix: "gap-y" },
  { modified: false, namespaces: ["spacing"], prefix: "gap" },
  { modified: false, namespaces: ["spacing"], prefix: "space-x" },
  { modified: false, namespaces: ["spacing"], prefix: "space-y" },
  { modified: false, namespaces: ["spacing"], prefix: "inset-x" },
  { modified: false, namespaces: ["spacing"], prefix: "inset-y" },
  { modified: false, namespaces: ["spacing"], prefix: "inset" },
  { modified: false, namespaces: ["spacing"], prefix: "top" },
  { modified: false, namespaces: ["spacing"], prefix: "right" },
  { modified: false, namespaces: ["spacing"], prefix: "bottom" },
  { modified: false, namespaces: ["spacing"], prefix: "left" },
  { modified: false, namespaces: ["spacing"], prefix: "start" },
  { modified: false, namespaces: ["spacing"], prefix: "end" },
  ...radiusFamilies,
  ...scrollFamilies,
  { modified: true, namespaces: ["text", "color"], prefix: "text" },
  // Longest prefix first, so which family a utility belongs to is decided by
  // the list's *contents* rather than by the order somebody typed it in.
  // `scroll-px` has to be tried before `scroll-p` and `rounded-tl` before
  // `rounded-t`, and a family added at the wrong line would otherwise be a
  // silent hole of exactly the kind this round is about.
].sort((left, right) => right.prefix.length - left.prefix.length);

/**
 * The prefixes the class channel measures, for the exception register to be
 * checked against. A family named in that register and present here at the same
 * time is a contradiction, and the register's own suite says so.
 */
export const governedScaleFamilies: readonly string[] = scaleFamilies.map(
  (family) => family.prefix,
);

/**
 * One step of a Tailwind scale, written as Tailwind's own ladders spell it.
 *
 * This is the one rule in the module shaped as a denylist rather than as a
 * whitelist, and the reason is where it reads from. The class rules read every
 * string literal a module writes — that is what stops a recipe being hoisted
 * into a constant — so a rule that fired on any value it did not recognise
 * would fire on `top-level`, `end-of-file` and `size-limit`. The value side is
 * therefore shaped like a rung, and the *conforming* side stays a positive
 * test: a `--cue-*` reference or a published theme key.
 *
 * A bare `0` is not a rung. Section 5.2 allows `0`, percentages, viewport
 * units, fractions and intrinsic keywords outright, because none of them is a
 * measurement that a density could scale — `min-w-0` is app-owned layout and
 * `w-full` is not a width at all.
 */
const tailwindScaleStep =
  /^(?:0\.\d+|[1-9]\d*(?:\.\d+)?|px|3xs|2xs|xs|sm|md|lg|xl|[2-9]xl|base|prose)$/u;

/**
 * The family and rung a token spells, when it spells a measurement Tailwind's
 * own scale answers rather than a CUE++ token.
 *
 * `undefined` covers three different conforming shapes and one non-shape: a
 * value written through a `--cue-*` custom property, a value naming a theme key
 * the bridge publishes, a value that carries no measurement at all, and a token
 * that is not a governed utility in the first place.
 *
 * The token arrives parsed, which is what lets the sign be *judged* rather than
 * stumbled over. `-mt-4` is the same hand-written geometry as `mt-4` — the
 * stylesheet channel's own raw-length rule matches a sign for exactly that
 * reason — but the family test used to be `base.startsWith(prefix + "-")`, and
 * a negative utility's base begins with the sign, so every negative rung of
 * every governed family fell straight through.
 */
function untokenizedScaleValue(
  parsed: ParsedClassToken,
  surface: CueSurface,
): string | undefined {
  // Tailwind's bare default rung: the one spelling that carries no value.
  if (parsed.form === "named" && parsed.utility === bareScaleUtility) return "";

  for (const family of scaleFamilies) {
    // v4's `(…)` shorthand resolves the value through a custom property, and
    // it is conforming exactly when that property is one CUE++ publishes.
    // `gap-(--cue-space-1)` answers a density; `p-(--brand-gap)` answers
    // nothing a theme or a density can move.
    if (parsed.form === "custom-property") {
      if (parsed.name !== family.prefix) continue;
      const property = parsed.value ?? "";

      return property.startsWith(cueTokenPrefix) ? undefined : property;
    }

    // The spelling those parentheses abbreviate. `p-(--brand-gap)` is exact
    // shorthand for `p-[var(--brand-gap)]` and the installed Tailwind emits the
    // identical declaration for both, so a rule that governed one and dropped
    // the other missed the very spelling it was written for.
    //
    // Only a *reference* is judged here. A bracketed value with no custom
    // property in it is either a raw measurement, which `arbitrary-class-value`
    // already holds, or one of the unit-free values section 5.2 allows outright
    // — `w-[100%]` and `w-[min-content]` name no length a density could scale.
    if (parsed.form === "arbitrary-value") {
      if (parsed.name !== family.prefix) continue;

      return [...(parsed.value ?? "").matchAll(customPropertyReferences)]
        .map((match) => match[0])
        .find((property) => !property.startsWith(cueTokenPrefix));
    }

    if (parsed.form !== "named") continue;
    if (!parsed.utility.startsWith(`${family.prefix}-`)) continue;

    const written = parsed.utility.slice(family.prefix.length + 1);
    // A `/` means two different things by family. On `text-` it is the
    // line-height modifier and the rung is in front of it; on a sizing family
    // it is a fraction, and `w-1/2` is a half rather than the first rung of the
    // spacing ladder. Reading it back on is what keeps every fraction in the
    // shell from being reported as a raw measurement.
    const value =
      family.modified || parsed.modifier === undefined
        ? written
        : `${written}/${parsed.modifier}`;

    if (value.includes(cueTokenPrefix)) return undefined;
    if (
      family.namespaces.some((namespace) =>
        surface.themeKeysByNamespace.get(namespace)?.has(value),
      )
    ) {
      return undefined;
    }

    return tailwindScaleStep.test(value) ? value : undefined;
  }

  return undefined;
}

/** The prefix every custom property the installed token layer publishes uses. */
const cueTokenPrefix = "--cue-";

/**
 * Every custom property a bracketed value names, in either spelling Tailwind
 * accepts: the `var(--x)` reference and the bare `--x` that `[--x]` compiles to.
 */
const customPropertyReferences = /--[\w-]+/gu;

/* ------------------------------------------------------------------ *
 * The whole scan.
 * ------------------------------------------------------------------ */

function modulesUnder(sourceRoot: string): string[] {
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function stylesheetsUnder(sourceRoot: string): string[] {
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Every stylesheet another stylesheet pulls in through a relative `@import`.
 *
 * That is what makes a `.css` file a fragment rather than a document's entry
 * point, and it is the only difference the import-order rule needs: an entry
 * opens with the published pair, a fragment is inlined into one that already
 * did and must not repeat it.
 */
function importedStylesheets(stylesheets: readonly string[]): Set<string> {
  const imported = new Set<string>();

  for (const stylesheet of stylesheets) {
    const source = withoutComments(readFileSync(stylesheet, "utf8"));
    for (const match of source.matchAll(
      new RegExp(importStatement.source, "gu"),
    )) {
      const specifier = (match[1] ?? "").slice(1, -1);
      if (!specifier.startsWith(".")) continue;
      imported.add(resolve(dirname(stylesheet), specifier));
    }
  }

  return imported;
}

export function auditWorkspace(
  options: CueAuditOptions,
): readonly CueAuditViolation[] {
  const violations = [...auditModules(options)];

  for (const target of options.targets) {
    const stylesheets = stylesheetsUnder(target.sourceRoot);
    const imported = importedStylesheets(stylesheets);

    for (const stylesheet of stylesheets) {
      const file = toRepositoryRelative(options.repositoryRoot, stylesheet);
      if (!file) continue;
      violations.push(
        ...auditStylesheet(readFileSync(stylesheet, "utf8"), file, {
          entry: !imported.has(stylesheet),
          styleAllowlist: options.styleAllowlist,
        }),
      );
    }
  }

  const unique = new Map<string, CueAuditViolation>();
  for (const violation of violations) {
    unique.set(formatViolation(violation), violation);
  }

  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, violation]) => violation);
}
