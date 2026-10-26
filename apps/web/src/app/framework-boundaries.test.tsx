import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { appearanceFallback } from "@requestport/domain";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fallbackAppearanceSnapshot } from "../lib/appearance.js";
import {
  appearanceMirrorScript,
  appearancePrepaintScript,
} from "../lib/appearance-script.js";
import { routeStateInventory } from "../test/route-state-inventory.js";
import { reviewedInlineStyleProps } from "../test/ui-style-allowlist.js";

const nonce = "abcdef0123456789abcdef0123456789";

/**
 * `next/font` runs inside the Next compiler, so the generated family names only
 * exist in a build. These stand-ins keep the exact published shape — a CSS
 * variable class plus a generated `style.fontFamily` — so the boundary tests
 * assert the loaded generated face rather than the literal word "Geist".
 */
const generated = vi.hoisted(() => ({
  sansVariable: "__variable_geist_sans_1f2e3d",
  sansFamily: "__Geist_1f2e3d, __Geist_Fallback_1f2e3d, sans-serif",
  monoVariable: "__variable_geist_mono_4c5b6a",
  monoFamily:
    "__Geist_Mono_4c5b6a, __Geist_Mono_Fallback_4c5b6a, ui-monospace, monospace",
  getAppearance: vi.fn(),
  faceClassName: "__variable_face_geist __variable_face_inter",
}));

vi.mock("./appearance-faces.js", () => ({
  appearanceFaceClassName: generated.faceClassName,
}));

vi.mock("geist/font/sans", () => ({
  GeistSans: {
    variable: generated.sansVariable,
    className: "geist-sans",
    style: { fontFamily: generated.sansFamily },
  },
}));

vi.mock("geist/font/mono", () => ({
  GeistMono: {
    variable: generated.monoVariable,
    className: "geist-mono",
    style: { fontFamily: generated.monoFamily },
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-nonce": nonce }),
}));

vi.mock("../lib/server-appearance.js", () => ({
  getAppearance: generated.getAppearance,
}));

const personalised = {
  theme: "terminal",
  density: "normal",
  mode: "light",
  font: "plex",
  look: "match",
  paint: "frost",
} as const;

function personalisedSnapshot() {
  return {
    user: {
      theme: "terminal",
      density: null,
      mode: null,
      font: "plex",
      look: null,
      paint: null,
      version: 6,
    },
    organization: {
      theme: "venu",
      density: "normal",
      mode: "light",
      font: "match",
      look: "match",
      paint: "frost",
      version: 2,
    },
    effective: {
      ...personalised,
      source: {
        theme: "user",
        density: "organization",
        mode: "organization",
        font: "user",
        look: "organization",
        paint: "organization",
      },
    },
  };
}

async function rootElement() {
  const { default: RootLayout } = await import("./layout.js");
  return (await RootLayout({
    children: <p data-testid="page">Overview</p>,
  })) as ReactElement<Record<string, unknown>>;
}

async function rootMarkup() {
  return renderToStaticMarkup(await rootElement());
}

async function globalErrorMarkup() {
  const { default: GlobalError } = await import("./global-error.js");
  return renderToStaticMarkup(
    <GlobalError
      error={Object.assign(
        new Error("global-error-sentinel-must-never-render"),
        {
          digest: "6f6e6c79",
        },
      )}
      reset={() => {}}
      retry={() => {}}
    />,
  );
}

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

/** `apps/web/src`, the root of every module this application ships. */
const applicationRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Every application module, test suites excluded. The contracts below are
 * traded against a document-wide policy — one CSP, one document boundary — so
 * they have to see the whole application rather than the three files that
 * happen to implement the boundary today.
 */
async function applicationModules() {
  const entries = await readdir(applicationRoot, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !/\.test\.tsx?$/u.test(entry.name),
    )
    .map((entry) =>
      relative(applicationRoot, join(entry.parentPath, entry.name)),
    )
    .sort();
}

async function applicationModule(modulePath: string) {
  return readFile(join(applicationRoot, modulePath), "utf8");
}

const asChildPattern = /(?:^|[\s{])asChild(?![0-9A-Za-z_])/mu;

/**
 * `style-src-attr 'unsafe-inline'` is a document-wide directive, so the source
 * contract traded against it has to be document-wide too: every inline-style
 * sink the application owns — the provider's `fontFamilies` prop and any
 * `style` prop — is audited in every module, not only in the three that
 * implement the boundary. The fixtures below make both audits falsifiable.
 */
const approvedFontFamiliesTuple =
  "fontFamilies={{ sans: GeistSans.style.fontFamily, mono: GeistMono.style.fontFamily }}";

/**
 * The one module whose provider root may publish the loaded Geist faces:
 * `global-error`, which resolves nothing. The root provider publishes none
 * since ruling 255 — `fontFamilies` would shadow the pairing the person's
 * typeface names — and its faces reach that pairing through the
 * `--cue-face-*` classes the root layout puts on `<html>`.
 */
const fontFamiliesBoundaries = [join("app", "global-error.tsx")];

/**
 * The reviewed application `style` props, keyed by the module allowed to write
 * them.
 *
 * RequestPort's mark (ruling 192): the app bar's wrapper that sets it beside
 * the name, and the mark's own fill, stroke and flex. No cue-ui component takes
 * custom artwork in the theme's accent. And the account menu's height cap
 * (ruling 255): cue-ui's popover limits its width and not its height, so the
 * panel takes the room Base UI's positioner measured. Every other `style`
 * attribute anywhere under `apps/web/src` is a violation, and adding one means
 * reviewing it here first.
 */
const reviewedStyleProps: Record<string, readonly string[]> = {
  "components/app-shell.tsx": [
    'style={{ alignItems: "center", display: "inline-flex", gap: "0.5rem", }}',
  ],
  "components/request-port-mark.tsx": [
    "style={{ fill: accent }}",
    "style={{ flexShrink: 0 }}",
    "style={{ stroke: accent }}",
  ],
  "components/user-control.tsx": [
    'style={{ maxHeight: "var(--available-height)" }}',
  ],
};

/** Collapse formatting so the contract is about the value, not the indentation. */
function canonicalTuple(text: string): string {
  return text.replaceAll(/\s+/gu, " ").replace(/,\s*\}\}$/u, " }}");
}

function auditFontFamiliesSink(text: string, expectedTuples: number): string[] {
  const violations: string[] = [];
  const normalised = text.replaceAll(/\s+/gu, " ");
  const fontFamilies = [...normalised.matchAll(/fontFamilies=\{\{[^}]*\}\}/gu)];

  if (fontFamilies.length !== expectedTuples) {
    violations.push(`fontFamilies-tuple-count:${fontFamilies.length}`);
  }
  for (const match of fontFamilies) {
    const canonical = canonicalTuple(match[0]);
    if (canonical !== approvedFontFamiliesTuple) {
      violations.push(`fontFamilies-value:${canonical}`);
    }
  }
  return violations;
}

/**
 * Every `style={…}` attribute in a module, read with balanced braces so the
 * whole written value is compared rather than the first `{`. Quoted text and
 * template literals are skipped, so a `${…}` placeholder cannot close it early.
 */
function styleProps(text: string): string[] {
  const props: string[] = [];

  // Not preceded by a name character, `.` or `-`: `data-style={…}` is an
  // attribute of its own, not the style attribute.
  for (const match of text.matchAll(/(?<![0-9A-Za-z_.-])style=\{/gu)) {
    const start = match.index;
    let depth = 0;
    let quote = "";
    let cursor = start + match[0].length - 1;
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    props.push(text.slice(start, cursor + 1).replaceAll(/\s+/gu, " "));
  }
  return props;
}

function auditInlineStyleSinks(
  text: string,
  reviewed: readonly string[] = [],
): string[] {
  return styleProps(text)
    .filter((prop) => !reviewed.includes(prop))
    .map((prop) => `style-prop:${prop}`);
}

type OpeningTag = {
  attributes: string;
  childrenStart: number;
  name: string;
  selfClosing: boolean;
};

/**
 * A minimal JSX opening-tag reader: enough to find where an element's children
 * begin, without a parser. It tracks quoting and brace depth, so an attribute
 * expression such as `onReady={() => ready(1 > 0)}` cannot end a tag early.
 */
function openingTags(text: string): OpeningTag[] {
  const tags: OpeningTag[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "<") continue;
    const name = /^<([A-Za-z][\w.]*)/u.exec(text.slice(index, index + 64))?.[1];
    if (!name) continue;

    let depth = 0;
    let quote = "";
    let cursor = index + name.length + 1;
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
    }
    if (cursor >= text.length) continue;

    const attributes = text.slice(index + name.length + 1, cursor);
    tags.push({
      attributes,
      childrenStart: cursor + 1,
      name,
      selfClosing: attributes.trimEnd().endsWith("/"),
    });
    index = cursor;
  }
  return tags;
}

/**
 * `asChild` is `React.Children.only` plus `cloneElement`. A module cannot hand
 * that sink an element it did not create: across the RSC boundary the child
 * arrives as a streamed lazy row, `Children.only` rejects it, and every
 * document render fails at runtime — a failure no direct-invocation test can
 * see, because it only exists once the flight boundary is real. Both halves of
 * the rule are therefore mechanical: the module carries `"use client"`, and the
 * element being cloned is written out as JSX in that same module. A client
 * module that clones a bare `{children}` satisfies the first half and still
 * fails every render, so the second half is the one that has teeth.
 */
function auditClientOwnedAsChild(text: string): string[] {
  const violations: string[] = [];
  const isClientModule = /^\s*["']use client["'];/u.test(text);

  for (const tag of openingTags(text)) {
    if (!asChildPattern.test(tag.attributes)) continue;
    if (!isClientModule) violations.push("as-child-in-server-module");

    const child = tag.selfClosing
      ? ""
      : text.slice(tag.childrenStart).trimStart();
    if (!/^<[A-Za-z]/u.test(child)) {
      violations.push(`as-child-clones-a-foreign-child:${tag.name}`);
    }
  }
  return violations;
}

beforeEach(() => {
  generated.getAppearance.mockReset();
  generated.getAppearance.mockResolvedValue({
    snapshot: personalisedSnapshot(),
    status: "authenticated",
  });
});

/**
 * Everything the parser sees before the first paint can begin: the `<html>`
 * element, the head, and the `<body>` opening tag with every attribute on it.
 *
 * The region ends at the end of that tag rather than at its start. `<body>` is
 * server-rendered by `AppearanceRoot` — the appearance axes and the provider
 * root marker are attributes on it — so a
 * region cut at the `<` left the one element written from a server read of a
 * person's stored preferences outside the only sweep that looks for a leak.
 * Reading to the next `>` is exact rather than approximate: React escapes `>`
 * inside an attribute value, so the first one after `<body` closes the tag.
 *
 * What stays outside is the page subtree, and deliberately. Below that tag is
 * the product's own markup, whose purpose is to render the signed-in person's
 * organizations, addresses and record versions; a rule refusing those strings
 * there would refuse the application working. The region is the part of the
 * document the server writes before any authentication decision has been made,
 * which is why it is the part that may carry nothing.
 */
function preBodyRegion(markup: string): string {
  const bodyOpen = markup.indexOf("<body");
  const bodyClose = markup.indexOf(">", bodyOpen);

  expect(bodyOpen, "the document must have a body").toBeGreaterThan(-1);
  expect(bodyClose, "the body's opening tag must close").toBeGreaterThan(
    bodyOpen,
  );

  return markup.slice(0, bodyClose + 1);
}

/**
 * What a pre-paint region carries that it may not, named rather than asserted.
 *
 * A predicate rather than four assertions inside one test, so the same sweep
 * can be run over a planted document as well as over a rendered one. A rule
 * that reports nothing on a clean document and nothing on a document with an
 * address stamped on `<body>` is indistinguishable from the assertion side,
 * which is exactly the state this file was in.
 */
function preBodyLeaks(markup: string): string[] {
  const region = preBodyRegion(markup);
  const found: string[] = [];

  if (/[a-f0-9]{8}-[a-f0-9]{4}-/u.test(region)) found.push("identifier");
  if (region.includes("@")) found.push("address");
  if (region.includes("version")) found.push("version");
  if (region.includes("organization")) found.push("organization");

  return found;
}

/**
 * The document's three structural boundaries, located rather than assumed.
 *
 * `indexOf` answers `-1` for a tag that is not in the markup, and every
 * position these tests compared was satisfied by that answer — a document with
 * no head at all passed the assertion that the head came first. Each boundary
 * is required to exist, and to sit in document order, before any slice built
 * from it is handed back.
 *
 * `aboveBody` is `preBodyRegion` above, which is the whole pre-paint document
 * rather than the head alone: the `<html>` element and the `<body>` opening tag
 * are both server-stamped from the appearance triple before any authentication
 * decision has been made, so both are part of what a secrecy sweep has to read.
 */
function documentRegions(markup: string) {
  const headOpen = markup.indexOf("<head>");
  const headClose = markup.indexOf("</head>");
  const bodyOpen = markup.indexOf("<body");

  expect(headOpen, "the document must have a head").toBeGreaterThan(-1);
  expect(headClose, "the head must close").toBeGreaterThan(headOpen);
  expect(bodyOpen, "the body must open after the head closes").toBeGreaterThan(
    headClose,
  );

  return {
    aboveBody: preBodyRegion(markup),
    belowHead: markup.slice(headClose),
    head: markup.slice(headOpen, headClose),
  };
}

describe("root document appearance boundary", () => {
  test("carries the six validated axes, a match resolved, and every face's class on <html> (ruling 255)", async () => {
    const element = await rootElement();

    expect(element.type).toBe("html");
    expect(element.props.suppressHydrationWarning).toBe(true);
    expect(element.props.lang).toBe("en");
    expect(element.props["data-theme"]).toBe(personalised.theme);
    expect(element.props["data-density"]).toBe(personalised.density);
    expect(element.props["data-mode"]).toBe(personalised.mode);
    expect(element.props["data-font"]).toBe("plex");
    // terminal has no Look of its own, so its match is classic's set.
    expect(element.props["data-style"]).toBe("console");
    expect(element.props["data-paint"]).toBe("frost");
    expect(element.props.className).toBe(generated.faceClassName);
  });

  test("stamps match on typeface, Look and surface as the classic Look on a theme with none of its own (ruling 255)", async () => {
    const matching = {
      theme: "requestport",
      density: "normal",
      mode: "system",
      font: "match",
      look: "match",
      paint: "match",
    } as const;
    generated.getAppearance.mockResolvedValue({
      snapshot: {
        user: {
          theme: null,
          density: null,
          mode: null,
          font: null,
          look: null,
          paint: null,
          version: 0,
        },
        organization: { ...matching, version: 3 },
        effective: {
          ...matching,
          source: {
            theme: "organization",
            density: "organization",
            mode: "organization",
            font: "organization",
            look: "organization",
            paint: "organization",
          },
        },
      },
      status: "authenticated",
    });

    const element = await rootElement();

    // requestport has no Look in the registry, so each match is classic's:
    // Geist, the console style set, no paint. None of them is the stored word.
    expect(element.props["data-theme"]).toBe("requestport");
    expect(element.props["data-font"]).toBe("geist");
    expect(element.props["data-style"]).toBe("console");
    expect(element.props["data-paint"]).toBe("none");
  });

  // Since `@cueplusplus/ui` 0.24.0 a field outside this attribute draws its
  // focus ring as `--cue-focus` mixed to 15% with transparent, which §13's
  // keyboard-focus rows refuse; inside it the ring is the full token again.
  test("opts every field on the page into the contrast edge and its full focus ring", async () => {
    const element = await rootElement();

    expect(element.props["data-field-edge"]).toBe("contrast");
  });

  /**
   * Both blocking bodies, inside the head, in order.
   *
   * The authoritative pre-paint has to have run before the parser reaches
   * `<body>`, or the first paint is whatever the server stamp said and the
   * script is a no-flash correction nobody sees in time. Position was
   * previously argued from `indexOf("<head>")`, which answers `-1` when there
   * is no head at all — so a document with both scripts moved after `</body>`
   * satisfied it. The head is located first, and each script is required to
   * lie whole inside it.
   */
  test("runs the mirror script before the authoritative pre-paint script", async () => {
    const markup = await rootMarkup();
    const { head } = documentRegions(markup);
    const mirrorBody = appearanceMirrorScript(personalised);
    const prepaintBody = appearancePrepaintScript(personalised);

    expect(head).toContain(mirrorBody);
    expect(head).toContain(prepaintBody);
    expect(head.indexOf(prepaintBody)).toBeGreaterThan(
      head.indexOf(mirrorBody),
    );
  });

  // Neither body may also appear below the head: a second copy would run after
  // the paint the first one exists to get ahead of.
  test("leaves no appearance script below the head", async () => {
    const markup = await rootMarkup();
    const { belowHead } = documentRegions(markup);

    expect(belowHead).not.toContain(appearanceMirrorScript(personalised));
    expect(belowHead).not.toContain(appearancePrepaintScript(personalised));
    expect(belowHead).not.toContain("<script");
  });

  test("gives both blocking scripts the request nonce and nothing else", async () => {
    const markup = await rootMarkup();
    const scripts = [
      ...markup.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gu),
    ];

    expect(scripts).toHaveLength(2);
    for (const [, attributes] of scripts) {
      expect(attributes).toContain(`nonce="${nonce}"`);
      expect(attributes).not.toContain("src=");
    }
    expect(markup).not.toContain("unsafe-inline");
  });

  test("stamps <body> through the one verified provider boundary", async () => {
    const markup = await rootMarkup();
    const body = /<body([^>]*)>/u.exec(markup)?.[1] ?? "";

    expect(body).toContain('data-cue-root=""');
    expect(body).toContain(`data-theme="${personalised.theme}"`);
    expect(body).toContain(`data-density="${personalised.density}"`);
    expect(body).toContain(`data-mode="${personalised.mode}"`);
    expect(body).toContain('data-style="console"');
    expect(body).toContain('data-paint="frost"');
    // No font family is written on it: the typeface is the pairing `<html>`
    // carries, and an inline family here would shadow it.
    expect(body).not.toContain("--cue-font-sans");
    expect(body).not.toContain("--cue-font-mono");
    expect(body).toContain("color-scheme:light");
    expect(markup).toContain("Overview");
  });

  test("publishes the logical system mode rather than a resolved one", async () => {
    generated.getAppearance.mockResolvedValue({
      snapshot: fallbackAppearanceSnapshot(),
      status: "anonymous",
    });

    const element = await rootElement();
    const markup = renderToStaticMarkup(element);

    expect(element.props["data-mode"]).toBe("system");
    expect(markup).toContain('data-mode="system"');
    expect(markup).toContain("color-scheme:light dark");
    expect(markup).toContain(appearanceMirrorScript(appearanceFallback));
    expect(markup).toContain(appearancePrepaintScript(appearanceFallback));
  });

  test("still renders the page when appearance resolution is unavailable", async () => {
    // Appearance is a presentation boundary, never an authentication or
    // product-data decision: an unavailable read paints the fallback and lets
    // the sign-in page or product boundary below it render unchanged.
    generated.getAppearance.mockResolvedValue({
      snapshot: fallbackAppearanceSnapshot(),
      status: "unavailable",
    });

    const markup = await rootMarkup();

    expect(markup).toContain("Overview");
    expect(markup).toContain(`data-theme="${appearanceFallback.theme}"`);
    expect(markup).not.toContain("unavailable");
  });

  // Everything the parser sees before `<body>` closes its own tag, which is
  // everything the server stamped before any authentication decision: the
  // `<html>` element, the head, and the provider-owned body tag together.
  //
  // One part of the shipped head is not in this markup at all. Next renders the
  // `metadata` export itself, outside the element rendered here, so no sweep in
  // this file can see it. It is a pair of string literals in `layout.tsx` with
  // no server read behind them, which is why that is a gap and not a hole —
  // written down rather than assumed, because a metadata field fed by a read
  // would leave this region silently.
  test("emits no identifier, address, or preference copy above the body", async () => {
    expect(preBodyLeaks(await rootMarkup())).toEqual([]);
  });

  /**
   * The other document this application server-renders whole.
   *
   * `global-error` replaces the root layout: it stamps its own `<html>` and its
   * own `<body>` from the fixed fallback triple, through the same provider, and
   * no sweep in this file had ever read either. It is the only other element
   * outside the region above, so it is swept rather than argued about.
   */
  test("emits nothing above the body of the error document either", async () => {
    expect(preBodyLeaks(await globalErrorMarkup())).toEqual([]);
  });

  /**
   * The region's own two edges, planted.
   *
   * `<body>` is server-rendered by `AppearanceRoot` — the appearance triple,
   * the provider-root marker and the published font families are all attributes
   * on it — and a region ending at the `<` of that tag excluded every one of
   * them. The second document pins the other edge: the page subtree below the
   * tag stays out, because its whole purpose is to render the signed-in
   * person's organizations, addresses and record versions, and a rule refusing
   * those strings there would refuse the application working.
   */
  test("reads the body's own opening tag, and nothing under it", () => {
    expect(
      preBodyLeaks(
        '<html lang="en"><head></head><body data-owner="owner@example.com"><p>Overview</p></body></html>',
      ),
    ).toEqual(["address"]);
    expect(
      preBodyLeaks(
        '<html lang="en"><head></head><body data-cue-root=""><p>owner@example.com</p></body></html>',
      ),
    ).toEqual([]);
  });

  test("mounts exactly one provider root for the whole document", async () => {
    const markup = await rootMarkup();

    expect([...markup.matchAll(/data-cue-root/gu)]).toHaveLength(1);
  });
});

describe("global error boundary", () => {
  test("renders its own document at the fixed RequestPort fallback triple", async () => {
    const markup = await globalErrorMarkup();

    expect(markup).toContain(`data-theme="${appearanceFallback.theme}"`);
    expect(markup).toContain(`data-density="${appearanceFallback.density}"`);
    expect(markup).toContain(`data-mode="${appearanceFallback.mode}"`);
    expect(markup.startsWith("<html")).toBe(true);
    expect(markup).toContain("<body");
    expect([...markup.matchAll(/data-cue-root/gu)]).toHaveLength(1);
  });

  test("republishes the loaded Geist families on its own provider root", async () => {
    const body = /<body([^>]*)>/u.exec(await globalErrorMarkup())?.[1] ?? "";

    expect(body).toContain(`--cue-font-sans:${generated.sansFamily}`);
    expect(body).toContain(`--cue-font-mono:${generated.monoFamily}`);
    expect(body).toContain("color-scheme:light dark");
  });

  test("offers a reset action and leaks no thrown detail", async () => {
    const markup = await globalErrorMarkup();

    expect(markup).toContain("Try again");
    expect(markup).toContain("<button");
    expect(markup).not.toContain("global-error-sentinel-must-never-render");
    expect(markup).not.toContain("6f6e6c79");
  });

  test("owns the global stylesheet the root layout would otherwise import", async () => {
    expect(await source("./global-error.tsx")).toContain(
      'import "./globals.css"',
    );
  });

  test("never reads or writes browser storage", async () => {
    const text = await source("./global-error.tsx");

    expect(text).not.toContain("localStorage");
    expect(text).not.toContain("sessionStorage");
    expect(text).toContain("persistPreferences={false}");
  });
});

/** The three modules that make up the two document boundaries. */
const boundaryModules = [
  "./layout.tsx",
  "./appearance-root.tsx",
  "./global-error.tsx",
] as const;

describe("provider boundary source contract", () => {
  test("keeps every asChild clone inside its own client module", async () => {
    for (const file of boundaryModules) {
      expect(auditClientOwnedAsChild(await source(file))).toEqual([]);
    }
    expect(await source("./layout.tsx")).not.toContain("asChild");
  });

  test("rejects an asChild boundary declared in a server module", () => {
    expect(
      auditClientOwnedAsChild(
        "<ThemeProvider asChild><body>{children}</body></ThemeProvider>",
      ),
    ).toEqual(["as-child-in-server-module"]);
    expect(
      auditClientOwnedAsChild(
        '"use client";\n<ThemeProvider asChild><body /></ThemeProvider>',
      ),
    ).toEqual([]);
  });

  test("rejects a client module that clones a child it did not create", () => {
    // The failing shape the rule exists to stop: the module is a client module,
    // so the "use client" half of the rule is satisfied, but the element being
    // cloned still crosses the RSC boundary as a streamed row.
    expect(
      auditClientOwnedAsChild(
        '"use client";\nexport function ThemeShell({ children }) {\n  return <ThemeProvider asChild>{children}</ThemeProvider>;\n}',
      ),
    ).toEqual(["as-child-clones-a-foreign-child:ThemeProvider"]);
    expect(
      auditClientOwnedAsChild(
        '"use client";\n<ThemeProvider asChild>{props.children}</ThemeProvider>',
      ),
    ).toEqual(["as-child-clones-a-foreign-child:ThemeProvider"]);
    expect(
      auditClientOwnedAsChild('"use client";\n<ThemeProvider asChild />'),
    ).toEqual(["as-child-clones-a-foreign-child:ThemeProvider"]);
    expect(
      auditClientOwnedAsChild(
        '"use client";\n<ThemeProvider asChild mode="dark" onReady={() => ready(1 > 0)}>\n  <body>{children}</body>\n</ThemeProvider>',
      ),
    ).toEqual([]);
  });

  test("holds the asChild rule across every application module", async () => {
    const owners: string[] = [];

    for (const modulePath of await applicationModules()) {
      const text = await applicationModule(modulePath);

      expect({
        modulePath,
        violations: auditClientOwnedAsChild(text),
      }).toEqual({ modulePath, violations: [] });
      if (asChildPattern.test(text)) owners.push(modulePath);
    }

    expect(owners).toEqual([
      join("app", "appearance-root.tsx"),
      join("app", "global-error.tsx"),
    ]);
  });
});

describe("inline-style source contract", () => {
  test("permits exactly one approved provider tuple at each boundary, and none at the root", async () => {
    expect(auditFontFamiliesSink(await source("./layout.tsx"), 0)).toEqual([]);
    expect(
      auditFontFamiliesSink(await source("./appearance-root.tsx"), 0),
    ).toEqual([]);
    for (const file of ["./global-error.tsx"]) {
      expect(auditFontFamiliesSink(await source(file), 1)).toEqual([]);

      const text = (await source(file)).replaceAll(/\s+/gu, " ");
      const tuples = [...text.matchAll(/fontFamilies=\{\{[^}]*\}\}/gu)].map(
        (match) => canonicalTuple(match[0]),
      );

      expect(tuples).toEqual([approvedFontFamiliesTuple]);
    }
  });

  test("rejects a second, absent, or application-derived provider tuple", () => {
    expect(
      auditFontFamiliesSink("<ThemeProvider>{children}</ThemeProvider>", 1),
    ).toEqual(["fontFamilies-tuple-count:0"]);
    expect(
      auditFontFamiliesSink(
        "<ThemeProvider fontFamilies={{ sans: user.font, mono: GeistMono.style.fontFamily }} />",
        1,
      ),
    ).toEqual([
      "fontFamilies-value:fontFamilies={{ sans: user.font, mono: GeistMono.style.fontFamily }}",
    ]);
    expect(
      auditFontFamiliesSink(
        `${approvedFontFamiliesTuple}\n${approvedFontFamiliesTuple}`,
        1,
      ),
    ).toEqual(["fontFamilies-tuple-count:2"]);
  });

  test("holds the fontFamilies sink closed in every other module", async () => {
    for (const modulePath of await applicationModules()) {
      const expected = fontFamiliesBoundaries.includes(modulePath) ? 1 : 0;

      expect({
        modulePath,
        violations: auditFontFamiliesSink(
          await applicationModule(modulePath),
          expected,
        ),
      }).toEqual({ modulePath, violations: [] });
    }
  });

  test("rejects every application style prop but the reviewed tuples", async () => {
    for (const modulePath of await applicationModules()) {
      expect({
        modulePath,
        violations: auditInlineStyleSinks(
          await applicationModule(modulePath),
          reviewedStyleProps[modulePath] ?? [],
        ),
      }).toEqual({ modulePath, violations: [] });
    }
    expect(Object.keys(reviewedStyleProps)).toEqual([
      "components/app-shell.tsx",
      "components/request-port-mark.tsx",
      "components/user-control.tsx",
    ]);
    expect(Object.keys(reviewedInlineStyleProps)).toEqual([
      "apps/web/src/components/app-shell.tsx",
      "apps/web/src/components/request-port-mark.tsx",
      "apps/web/src/components/user-control.tsx",
    ]);
  });

  test("rejects an unreviewed or request-derived style value", () => {
    expect(
      auditInlineStyleSinks("<div style={{ color: theme.accent }} />"),
    ).toEqual(["style-prop:style={{ color: theme.accent }}"]);
    expect(
      auditInlineStyleSinks('<div style={{ "--x": searchParams.get("w") }} />'),
    ).toEqual(['style-prop:style={{ "--x": searchParams.get("w") }}']);
    // A tuple only passes because it was reviewed and recorded, never because
    // of where it is written.
    expect(
      auditInlineStyleSinks('<div style={{ "--x": "50%" }} />', [
        'style={{ "--x": "50%" }}',
      ]),
    ).toEqual([]);
    // An attribute whose name ends in `style` is not the style attribute: the
    // root layout stamps cue-ui's `data-style` axis (ruling 255), which writes
    // no inline style.
    expect(
      auditInlineStyleSinks("<html data-style={presentation.styleSet} />"),
    ).toEqual([]);
    expect(
      auditInlineStyleSinks("<html data-style={x} style={{ color: y }} />"),
    ).toEqual(["style-prop:style={{ color: y }}"]);
  });
});

/**
 * The App Router boundaries, addressed exactly as the inventory addresses them.
 * The inventory is the list; this table is how each one is rendered, so a row
 * the plan owes cannot be quietly skipped here.
 */
const boundaryRenderers: Record<string, () => Promise<string>> = {
  "(app)/error.tsx": async () =>
    renderToStaticMarkup(
      (await import("./(app)/error.js")).default({
        error: thrown(),
        reset: () => {},
      }),
    ),
  "(app)/loading.tsx": async () =>
    renderToStaticMarkup((await import("./(app)/loading.js")).default()),
  "(app)/not-found.tsx": async () =>
    renderToStaticMarkup((await import("./(app)/not-found.js")).default()),
  "(app)/settings/appearance/error.tsx": async () =>
    renderToStaticMarkup(
      (await import("./(app)/settings/appearance/error.js")).default({
        error: thrown(),
        reset: () => {},
      }),
    ),
  "(app)/settings/appearance/loading.tsx": async () =>
    renderToStaticMarkup(
      (await import("./(app)/settings/appearance/loading.js")).default(),
    ),
  "(app)/settings/error.tsx": async () =>
    renderToStaticMarkup(
      (await import("./(app)/settings/error.js")).default({
        error: thrown(),
        reset: () => {},
      }),
    ),
  "(app)/settings/not-found.tsx": async () =>
    renderToStaticMarkup(
      (await import("./(app)/settings/not-found.js")).default(),
    ),
  "(auth)/error.tsx": async () =>
    renderToStaticMarkup(
      (await import("./(auth)/error.js")).default({
        error: thrown(),
        reset: () => {},
      }),
    ),
  "(auth)/loading.tsx": async () =>
    renderToStaticMarkup((await import("./(auth)/loading.js")).default()),
  "(auth)/not-found.tsx": async () =>
    renderToStaticMarkup((await import("./(auth)/not-found.js")).default()),
  "error.tsx": async () =>
    renderToStaticMarkup(
      (await import("./error.js")).default({
        error: thrown(),
        reset: () => {},
      }),
    ),
  "global-error.tsx": globalErrorMarkup,
  "oauth/loading.tsx": async () =>
    renderToStaticMarkup((await import("./oauth/loading.js")).default()),
  "not-found.tsx": async () =>
    renderToStaticMarkup((await import("./not-found.js")).default()),
};

function thrown() {
  return Object.assign(new Error("boundary-sentinel-must-never-render"), {
    digest: "6f6e6c79",
  });
}

/**
 * The retired recipe names, assembled rather than quoted.
 *
 * This suite lives under `apps/web/src`, which the native audit scans for class
 * literals — so writing one of these out whole would make the file that checks
 * for them a place they are written. The prefix on its own is not a class name,
 * and joining it to a suffix here keeps the check exact without ever spelling
 * one.
 */
const retiredRecipes = [
  "button",
  "empty-state",
  "field",
  "input",
  "panel",
  "table",
].map((name) => `ui-${name}`);

/** The boundaries that own the whole document below `<body>`. */
const documentOwningBoundaries = new Set([
  "(auth)/error.tsx",
  "(auth)/loading.tsx",
  "(auth)/not-found.tsx",
  "error.tsx",
  "global-error.tsx",
  "not-found.tsx",
  "oauth/loading.tsx",
]);

describe("App Router framework boundaries", () => {
  test("renders exactly the boundaries the inventory requires", () => {
    expect(Object.keys(boundaryRenderers).sort()).toEqual(
      routeStateInventory
        .filter((entry) => entry.kind !== "route")
        .map((entry) => entry.source)
        .sort(),
    );
  });

  test.each(Object.keys(boundaryRenderers).sort())(
    "%s paints native CUE++ and leaks no thrown detail",
    async (source) => {
      const markup = await (boundaryRenderers[source] ?? (async () => ""))();

      expect(markup.length).toBeGreaterThan(0);
      expect(markup).not.toContain("boundary-sentinel-must-never-render");
      expect(markup).not.toContain("6f6e6c79");
      for (const recipe of retiredRecipes) {
        expect({ found: markup.includes(recipe), recipe, source }).toEqual({
          found: false,
          recipe,
          source,
        });
      }
      expect(auditInlineStyleSinks(markup)).toEqual([]);
    },
  );

  test.each([...documentOwningBoundaries].sort())(
    "%s carries the page's own main landmark",
    async (source) => {
      const markup = await (boundaryRenderers[source] ?? (async () => ""))();

      expect(markup.match(/<main/gu)).toHaveLength(1);
    },
  );

  test.each(
    Object.keys(boundaryRenderers)
      .filter((source) => !documentOwningBoundaries.has(source))
      .sort(),
  )("%s adds no second main landmark inside its layout", async (source) => {
    const markup = await (boundaryRenderers[source] ?? (async () => ""))();

    expect(markup).not.toContain("<main");
  });

  test("gives every error boundary a working reset control", async () => {
    for (const source of [
      "(app)/error.tsx",
      "(app)/settings/appearance/error.tsx",
      "(app)/settings/error.tsx",
      "(auth)/error.tsx",
      "error.tsx",
      "global-error.tsx",
    ]) {
      const markup = await (boundaryRenderers[source] ?? (async () => ""))();

      expect({ found: markup.includes("Try again"), source }).toEqual({
        found: true,
        source,
      });
    }
  });

  test("routes every not-found boundary back to a reachable destination", async () => {
    for (const [source, href] of [
      ["(app)/not-found.tsx", "/"],
      // The organization page, which every member may open (ruling 260).
      ["(app)/settings/not-found.tsx", "/settings/organization"],
      ["(auth)/not-found.tsx", "/sign-in"],
      ["not-found.tsx", "/"],
    ] as const) {
      const markup = await (boundaryRenderers[source] ?? (async () => ""))();

      expect({ found: markup.includes(`href="${href}"`), source }).toEqual({
        found: true,
        source,
      });
    }
  });

  test("announces each loading boundary through the native spinner", async () => {
    for (const source of [
      "(app)/loading.tsx",
      "(app)/settings/appearance/loading.tsx",
      "(auth)/loading.tsx",
      "oauth/loading.tsx",
    ]) {
      const markup = await (boundaryRenderers[source] ?? (async () => ""))();

      expect({ found: markup.includes('role="status"'), source }).toEqual({
        found: true,
        source,
      });
    }
  });

  /**
   * Task 4 recorded that CUE++'s `EmptyState` publishes its title as a `<span>`
   * rather than as a heading. That is re-verified here rather than remembered,
   * because it is the reason every boundary supplies its own `<h1>` instead of
   * leaning on the empty state for the page's accessible outline.
   */
  test("keeps the empty-state title a span, so each boundary owns its heading", async () => {
    const markup = renderToStaticMarkup(
      <EmptyState hint="Nothing here" title="No requests" />,
    );

    expect(markup).toContain('data-slot="empty-state-title"');
    expect(markup).toMatch(/<span[^>]*data-slot="empty-state-title"/u);
    expect(markup).not.toMatch(/<h[1-6]/u);
    expect(markup).not.toContain('role="heading"');

    for (const source of [
      "(app)/error.tsx",
      "(app)/not-found.tsx",
      "(app)/settings/error.tsx",
      "(app)/settings/not-found.tsx",
      "(auth)/error.tsx",
      "(auth)/not-found.tsx",
      "error.tsx",
      "global-error.tsx",
      "not-found.tsx",
    ]) {
      const boundary = await (boundaryRenderers[source] ?? (async () => ""))();

      expect({ heading: /<h1[\s>]/u.test(boundary), source }).toEqual({
        heading: true,
        source,
      });
    }
  });
});
