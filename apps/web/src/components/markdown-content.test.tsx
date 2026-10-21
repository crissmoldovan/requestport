import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { MarkdownContent, safeMarkdownUrl } from "./markdown-content.js";

/**
 * Request prose, rendered from untrusted Markdown.
 *
 * Two things are load-bearing here and neither is decoration: an author-supplied
 * URL may only survive if it is a plain `http(s)` address with no credentials in
 * it, and an unbroken one may not widen the column it is written in — the shell
 * has a single scroller, so a token wider than the measure scrolls the whole
 * console sideways.
 */

const longUrl =
  "https://github.example/example-org/requestport/pull/1234567890/files?diff=unified&w=1";

function markdown(source: string) {
  return renderToStaticMarkup(<MarkdownContent>{source}</MarkdownContent>);
}

describe("safe markdown URLs", () => {
  test("keeps ordinary web and in-app destinations", () => {
    expect(safeMarkdownUrl("https://requestport.test/x")).toBe(
      "https://requestport.test/x",
    );
    expect(safeMarkdownUrl("/requests/1")).toBe("/requests/1");
    expect(safeMarkdownUrl("#section")).toBe("#section");
  });

  test("drops a scheme or an authority that could carry a credential", () => {
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("https://user:pass@requestport.test/x")).toBe("");
    expect(safeMarkdownUrl("//evil.example/x")).toBe("");
    expect(safeMarkdownUrl("not a url")).toBe("");
  });
});

describe("rendered request prose", () => {
  test("wraps an unbroken URL instead of widening its column", () => {
    const markup = markdown(`See ${longUrl} for the change.`);

    expect(markup).toMatch(/class="[^"]*break-words[^"]*"/u);
    expect(markup).toContain("diff=unified");
  });

  test("paints itself from CUE++ tokens rather than a retired recipe", () => {
    const markup = markdown("# Title\n\n`code` and a paragraph.");

    expect(markup).not.toContain("markdown-content");
    expect(markup).toContain("text-fg");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("<code");
  });

  test("refuses to render an external image, keeping its alternative text", () => {
    const markup = markdown("![A diagram](https://evil.example/pixel.png)");

    expect(markup).not.toContain("evil.example");
    expect(markup).toContain("[Image: A diagram]");
  });

  test("opens an external link safely and neuters an unsafe one", () => {
    const markup = markdown(`[out](${longUrl}) and [bad](javascript:alert(1))`);

    expect(markup).toContain('rel="noreferrer noopener"');
    expect(markup).toContain('target="_blank"');
    expect(markup).not.toContain("javascript:alert");
  });
});
