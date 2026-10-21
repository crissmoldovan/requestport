import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  sectionHeadingClasses,
  sectionHeadingNoteClasses,
} from "../components/section-heading.js";

/**
 * A heading is never the part that gets cut.
 *
 * *Pending invitations* rendered as `Pending invita…` beside an intact
 * `0 awaiting acceptance`, and a panel title rendered as `P…`. The heading says
 * where you are; the count beside it is detail, and detail is what should give
 * way. `truncate` on the heading decided the opposite.
 *
 * The rule was wrong in four files at once because the class string was copied
 * into four files. So this asserts both halves: the shared style truncates
 * nothing, and no heading element anywhere carries `truncate` in a class
 * literal of its own — which is how a fifth copy would arrive.
 *
 * Like the table-cell rule, this is invisible to the acceptance matrix: a
 * heading clipped to `P…` overflows nothing and passes every width.
 */
const sourceRoot = resolve(import.meta.dirname, "..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test."))
      files.push(path);
  }

  return files;
}

describe("what a section heading does when the line is too short", () => {
  test("the shared heading style truncates nothing", () => {
    expect(sectionHeadingClasses).not.toContain("truncate");
  });

  test("the note beside it is the part that gives way", () => {
    // `truncate` alone never engages on a flex item: its default
    // `min-width: auto` refuses to shrink below its own content.
    expect(sectionHeadingNoteClasses).toContain("truncate");
    expect(sectionHeadingNoteClasses).toContain("min-w-0");
  });

  test("no heading element carries a truncating class of its own", async () => {
    const offenders: string[] = [];

    for (const path of await sourceFiles(sourceRoot)) {
      const lines = (await readFile(path, "utf8")).split("\n");

      lines.forEach((line, index) => {
        if (!line.includes("truncate")) return;
        // A class literal belongs to the element that opened above it.
        const context = lines
          .slice(Math.max(0, index - 6), index + 1)
          .join("\n");
        if (!/<h[1-6]\b/u.test(context)) return;

        offenders.push(`${path.slice(sourceRoot.length + 1)}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
