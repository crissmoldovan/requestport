import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * The shell navigates with the App Router, which a static render has no
 * instance of. Nothing here clicks; the DOM suite is where navigation is
 * asserted.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () =>
    new URLSearchParams("requestId=00000000-0000-4000-8000-000000000101"),
}));

import {
  RequestWorkbenchShell,
  workbenchListSize,
} from "./request-workbench-shell.js";

function workbenchMarkup(hasDetail: boolean) {
  return renderToStaticMarkup(
    <RequestWorkbenchShell
      backHref="/requests?view=inbox"
      detail={<p>The selected request</p>}
      hasDetail={hasDetail}
      list={<p>The request list</p>}
    />,
  );
}

describe("request workbench layout", () => {
  test("puts the list beside the detail in cue-ui's SplitPane", () => {
    const markup = workbenchMarkup(true);

    expect(markup).toContain('data-slot="split-pane"');
    // A server render has measured nothing, so it draws side by side; the
    // browser stacks the panes once it has measured a narrow frame.
    expect(markup).toContain('data-layout="split"');
    expect(markup).toContain('data-slot="split-pane-list"');
    expect(markup).toContain('data-slot="split-pane-detail"');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize the requests"');
    expect(markup).toContain('aria-label="Request list"');
    expect(markup).toContain('aria-label="Selected request"');
    expect(markup).toContain("The request list");
    expect(markup).toContain("The selected request");
  });

  test("clips the side-by-side server render to its frame", () => {
    // The server render is side by side at every width. On a phone the list's
    // fixed width would scroll the whole document sideways until the browser
    // measures and stacks the panes; clipping keeps that render inside the
    // frame without making the frame a scroll container.
    const markup = workbenchMarkup(true);

    expect(markup).toMatch(
      /<div[^>]*data-slot="split-pane"[^>]*class="[^"]*\boverflow-x-clip\b/u,
    );
  });

  test("leaves no resizable group behind", () => {
    const markup = workbenchMarkup(true);

    expect(markup).not.toContain('data-slot="resizable-group"');
    expect(markup).not.toContain('data-slot="resizable-handle"');
  });

  test("shows a native empty state while no request is selected", () => {
    const markup = workbenchMarkup(false);

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No request selected");
    expect(markup).not.toContain("The selected request");
  });

  test("starts the list inside its own bounds", () => {
    expect(workbenchListSize.default).toBeGreaterThanOrEqual(
      workbenchListSize.minimum,
    );
    expect(workbenchListSize.default).toBeLessThanOrEqual(
      workbenchListSize.maximum,
    );
    expect(markupWidth(workbenchMarkup(true))).toBe(workbenchListSize.default);
  });
});

/** The list pane's width as the server render sets it, in pixels. */
function markupWidth(markup: string): number {
  const match = markup.match(
    /data-slot="split-pane-list"[^>]*style="width:(\d+)px"/u,
  );
  return Number(match?.[1] ?? Number.NaN);
}
