import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FONT_PAIRINGS } from "@cueplusplus/tokens";
import { appearanceConcreteFonts } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

/*
  Every typeface Settings offers must render from this application's origin
  (ruling 255): each `--cue-face-*` property its cue-ui pairing names has to
  be declared in `appearance-faces.ts` from a file the build can copy, and its
  class has to reach `<html>` through `appearanceFaceClassName`. `next/font`
  runs only inside the Next compiler, so this stand-in records each
  declaration and answers with a class that names its property.
*/

type Declaration = Readonly<{
  src: string | readonly Readonly<{ path: string }>[];
  variable: string;
}>;

const declared = vi.hoisted(() => [] as Declaration[]);

vi.mock("next/font/local", () => ({
  default: (options: Declaration) => {
    declared.push(options);
    return {
      className: `class(${options.variable})`,
      style: { fontFamily: options.variable },
      variable: `face(${options.variable})`,
    };
  },
}));

import { appearanceFaceClassName } from "./appearance-faces.js";

/**
 * The one face an offered pairing names that is not bundled: Paper Mono, the
 * mono of `calsans`. No package on the public registry ships it, so that
 * pairing's mono falls through its stack (`appearance-faces.ts` says so).
 */
const unbundled = new Map([["--cue-face-paper-mono", "calsans"]]);

/** The classes `<html>` receives, as listed: a repeat stays a repeat. */
const classList = appearanceFaceClassName.split(" ");
const classes = new Set(classList);
const declaredProperties = new Set(declared.map((face) => face.variable));

describe("the faces of every offered typeface", () => {
  test("declares and puts on <html> every face an offered typeface names, but Paper Mono", () => {
    const missing: string[] = [];
    for (const font of appearanceConcreteFonts) {
      for (const face of FONT_PAIRINGS[font].faces) {
        if (unbundled.get(face) === font) continue;
        if (!declaredProperties.has(face) || !classes.has(`face(${face})`)) {
          missing.push(`${font}: ${face}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("still needs its one exception, and does not declare it", () => {
    for (const [face, font] of unbundled) {
      expect(FONT_PAIRINGS[font as keyof typeof FONT_PAIRINGS].faces).toContain(
        face,
      );
      expect(declaredProperties.has(face)).toBe(false);
    }
  });

  test("puts every declared face on <html>, once", () => {
    // Counted in the list itself: a Set would fold a repeated class into one
    // before anything could see it.
    const occurrences = new Map<string, number>();
    for (const name of classList) {
      occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
    }
    const expected = [...declaredProperties]
      .map((property) => `face(${property})`)
      .sort();

    expect([...occurrences.keys()].sort()).toEqual(expected);
    expect(
      [...occurrences].filter(([, count]) => count !== 1),
      "a class on <html> more than once",
    ).toEqual([]);
    expect(classList).toHaveLength(expected.length);
    expect(declared).toHaveLength(declaredProperties.size);
  });

  test("reads every face from a file in this checkout, for the build to copy", () => {
    const absent = declared
      .flatMap((face) =>
        typeof face.src === "string"
          ? [face.src]
          : face.src.map((source) => source.path),
      )
      .filter(
        (path) => !existsSync(fileURLToPath(new URL(path, import.meta.url))),
      );
    expect(absent).toEqual([]);
  });
});
