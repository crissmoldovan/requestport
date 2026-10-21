import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  boundedWorkbenchLayout,
  defaultWorkbenchLayout,
  initialWorkbenchLayout,
  RequestWorkbenchShell,
  workbenchPanels,
} from "./request-workbench-shell.js";

function workbenchMarkup(hasDetail: boolean) {
  return renderToStaticMarkup(
    <RequestWorkbenchShell
      detail={<p>Selected request</p>}
      hasDetail={hasDetail}
      list={<p>Request list</p>}
    />,
  );
}

describe("request workbench layout", () => {
  test("splits the workbench with the native resizable group", () => {
    const markup = workbenchMarkup(true);

    expect(markup).toContain('data-slot="resizable-group"');
    expect(markup).toContain('data-orientation="horizontal"');
    expect(markup.match(/data-slot="resizable-panel"/gu)).toHaveLength(2);
    expect(markup).toContain('data-slot="resizable-handle"');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain(`id="${workbenchPanels.list.id}"`);
    expect(markup).toContain(`id="${workbenchPanels.detail.id}"`);
    expect(markup).toContain('aria-label="Request list"');
    expect(markup).toContain('aria-label="Selected request"');
    expect(markup).toContain("Request list");
    expect(markup).toContain("Selected request");
  });

  test("leaves no hand-rolled resizer, style attribute, or retired recipe", () => {
    const markup = workbenchMarkup(true);

    expect(markup).not.toContain("request-workbench");
    expect(markup).not.toContain("--request-list-width");
    expect(markup).not.toContain('aria-label="Resize request list"');
  });

  test("shows a native empty state while no request is selected", () => {
    const markup = workbenchMarkup(false);

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No request selected");
    expect(markup).not.toContain("Selected request</p>");
  });
});

describe("bounded workbench sizes", () => {
  test("starts inside its own bounds", () => {
    const list = defaultWorkbenchLayout[workbenchPanels.list.id] ?? 0;

    expect(list).toBeGreaterThanOrEqual(workbenchPanels.list.minimum);
    expect(list).toBeLessThanOrEqual(workbenchPanels.list.maximum);
    expect(
      list + (defaultWorkbenchLayout[workbenchPanels.detail.id] ?? 0),
    ).toBe(100);
  });

  test("clamps a saved size back inside the reviewed bounds", () => {
    expect(
      boundedWorkbenchLayout({
        [workbenchPanels.detail.id]: 8,
        [workbenchPanels.list.id]: 92,
      }),
    ).toEqual({
      [workbenchPanels.detail.id]: 100 - workbenchPanels.list.maximum,
      [workbenchPanels.list.id]: workbenchPanels.list.maximum,
    });
    expect(
      boundedWorkbenchLayout({
        [workbenchPanels.detail.id]: 96,
        [workbenchPanels.list.id]: 4,
      }),
    ).toEqual({
      [workbenchPanels.detail.id]: 100 - workbenchPanels.list.minimum,
      [workbenchPanels.list.id]: workbenchPanels.list.minimum,
    });
  });

  test("never lets a server render start from a saved seam", () => {
    // The node lane has no `window`, which is exactly the condition a Next
    // server render is in: module scope there is the process, shared by every
    // reader, so the seam a browser saved must not reach it.
    expect(initialWorkbenchLayout()).toEqual(defaultWorkbenchLayout);
  });

  test("refuses a malformed or unknown saved layout", () => {
    expect(boundedWorkbenchLayout({})).toEqual(defaultWorkbenchLayout);
    expect(
      boundedWorkbenchLayout({
        [workbenchPanels.list.id]: Number.NaN,
      }),
    ).toEqual(defaultWorkbenchLayout);
    expect(boundedWorkbenchLayout({ "some-other-panel": 50 })).toEqual(
      defaultWorkbenchLayout,
    );
  });
});
