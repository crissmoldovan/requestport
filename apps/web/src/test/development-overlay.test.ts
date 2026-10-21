import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, test } from "vitest";

import { developmentOverlaySelectors } from "../../tests/fixtures/development-overlay.js";
import { withoutComments } from "./source-text.js";

/**
 * The development server's own chrome, named by the package that mounts it.
 *
 * `next dev` injects its devtools into every document it serves, and on a
 * failure it opens its error overlay there too. Both are ordinary elements in
 * the document the acceptance lanes measure, so every rule this suite states
 * about the application is stated about them as well unless they are taken out
 * first — and the two directions of that have each already been paid for. The
 * focus driver refuses the overlay's focusable host; the overflow assertion did
 * not, and reported the overlay's width as the application overflowing its
 * viewport on the one case that makes the overlay open.
 *
 * An exclusion is only safe while it names what is actually there, so the names
 * are read back out of the installed `next`. The package describes exactly this
 * nesting — under the App Router the portal is mounted inside a script carrying
 * the overlay attribute, under the Pages Router it sits directly in the body —
 * and an upgrade that renames either fails here rather than quietly putting the
 * tool back into the measurement.
 */

const require = createRequire(import.meta.url);
const nextRoot = dirname(require.resolve("next/package.json"));
const webRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(webRoot, "tests");

/** The one module allowed to spell the overlay's names. */
const overlayModule = "fixtures/development-overlay.ts";

/**
 * The names a selector puts in the document: an element name, and the
 * attributes it is qualified by.
 */
export function namesIn(selector: string): string[] {
  return [
    ...(/^[A-Za-z][\w-]*/u.exec(selector) ?? []),
    ...[...selector.matchAll(/\[([\w-]+)/gu)].map((match) => match[1] ?? ""),
  ].filter((name) => name.length > 0);
}

/**
 * The devtools sources of the installed package.
 *
 * Scoped to the directories that build and ship the overlay rather than to the
 * whole distribution, which is large enough that scanning it would make this
 * suite the slowest thing in the lane.
 */
function devtoolSources(): string[] {
  const roots = [
    join(nextRoot, "dist/build/webpack/loaders/devtool"),
    join(nextRoot, "dist/compiled/next-devtools"),
  ];

  return roots.flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(entry.parentPath, entry.name)),
  );
}

/** Every file under the browser tree, web-app-relative and POSIX-spelled. */
function browserFiles(): string[] {
  return readdirSync(fixtureRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) =>
      relative(fixtureRoot, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
}

describe("the development server's own chrome", () => {
  test("names what the installed package actually mounts", () => {
    const sources = devtoolSources().map((file) => readFileSync(file, "utf8"));

    expect(sources.length).toBeGreaterThan(0);
    const missing = developmentOverlaySelectors.flatMap((selector) =>
      namesIn(selector).filter(
        (name) => !sources.some((source) => source.includes(name)),
      ),
    );

    expect(missing).toEqual([]);
  });

  test("reads an element name and its attributes out of a selector", () => {
    // Planted, because a reader that answered nothing would make the check
    // above pass against a package that mounts nothing of the sort.
    expect(namesIn("script[data-nextjs-dev-overlay]")).toEqual([
      "script",
      "data-nextjs-dev-overlay",
    ]);
    expect(namesIn("nextjs-portal")).toEqual(["nextjs-portal"]);
    expect(namesIn("")).toEqual([]);
  });

  test("keeps the exclusion in one module the whole tree reads", () => {
    // Two readers already exclude the overlay — the focus driver and the
    // overflow assertion — and a name spelled twice is a name that will be
    // renamed once.
    //
    // Only the identifying halves are searched for. `script` is an element
    // every kind of module mentions for reasons of its own, so a scan that
    // treated it as a spelling of the overlay would report most of the tree
    // and mean nothing; what identifies this chrome is the hyphenated custom
    // element and the hyphenated attribute that qualifies it.
    const identifying = developmentOverlaySelectors.flatMap((selector) =>
      namesIn(selector).filter((name) => name.includes("-")),
    );
    const spelled = browserFiles().filter(
      (file) =>
        file !== overlayModule &&
        identifying.some((name) =>
          withoutComments(
            readFileSync(join(fixtureRoot, file), "utf8"),
          ).includes(name),
        ),
    );

    expect(identifying.length).toBeGreaterThan(0);
    expect(spelled).toEqual([]);
  });
});
