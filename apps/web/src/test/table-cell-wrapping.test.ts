import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * A cell inside a scrolling table does not break its own words.
 *
 * `TableScrollRegion` exists so that "an unbroken email address or repository
 * slug scrolls its own columns rather than the console" — the words are from
 * the comment above the administration views. `break-all` inside one is a
 * second answer to the question the region already answered, and the two
 * contradict: the region has decided not to fit, and breaking a word
 * mid-character is a decision to fit anyway.
 *
 * What that looked like: a member's email address rendered as five stacked
 * fragments beside visible free space, in a table that was also scrolling
 * horizontally — and identically at 1440px, because `break-all` never consults
 * the available width. Reported from a screenshot, and invisible to the
 * acceptance matrix, which asserts no document overflow at four widths and is
 * perfectly satisfied by a value shattered into five pieces.
 *
 * Outside a table this rule does not apply. A long identifier in a definition
 * list or a card may have nothing to scroll and every reason to wrap.
 */
const componentRoot = resolve(import.meta.dirname, "..");

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

describe("what a table cell does with a long value", () => {
  test("never breaks a word inside a scrolling table", async () => {
    const offenders: string[] = [];

    for (const path of await sourceFiles(componentRoot)) {
      const lines = (await readFile(path, "utf8")).split("\n");

      lines.forEach((line, index) => {
        if (!line.includes("break-all")) return;
        // The nearest enclosing element decides: a cell has the region behind
        // it, anything else is on its own.
        const context = lines
          .slice(Math.max(0, index - 12), index + 1)
          .join("\n");
        if (!/<Table\.(Cell|Head)\b/u.test(context)) return;

        offenders.push(`${path.slice(componentRoot.length + 1)}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
