"use client";

import { EmptyState } from "@cueplusplus/ui/chrome";
import { Resizable } from "@cueplusplus/ui/layout/resizable";
import { PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import type { Layout } from "react-resizable-panels";

/**
 * The two panes and the bounds the seam may be dragged between.
 *
 * The bounds are the contract: whatever the group saves — a drag, an arrow
 * key, a Home/End collapse — is clamped back inside them before it is kept, so
 * neither pane can be squeezed to a width its content cannot use.
 */
export const workbenchPanels = {
  detail: { id: "request-detail" },
  list: { id: "request-list", maximum: 65, minimum: 30 },
} as const;

export const defaultWorkbenchLayout: Layout = {
  [workbenchPanels.detail.id]: 57,
  [workbenchPanels.list.id]: 43,
};

/**
 * A saved layout, clamped into the reviewed bounds. Anything the group cannot
 * have produced — a missing pane, a value that is not a finite number — is
 * discarded for the default rather than repaired.
 */
export function boundedWorkbenchLayout(layout: Layout): Layout {
  const list = layout[workbenchPanels.list.id];
  if (typeof list !== "number" || !Number.isFinite(list)) {
    return defaultWorkbenchLayout;
  }
  if (typeof layout[workbenchPanels.detail.id] !== "number") {
    return defaultWorkbenchLayout;
  }

  const bounded = Math.min(
    workbenchPanels.list.maximum,
    Math.max(workbenchPanels.list.minimum, list),
  );

  return {
    [workbenchPanels.detail.id]: 100 - bounded,
    [workbenchPanels.list.id]: bounded,
  };
}

/**
 * The seam position, kept for the life of the tab.
 *
 * The workbench remounts on every request selection, and a reader who has just
 * widened the list does not expect it to snap back. Module scope rather than
 * state so remembering a size can never re-render the pane that reported it,
 * and rather than storage so nothing about the reader's layout leaves the tab.
 */
let savedWorkbenchLayout: Layout = defaultWorkbenchLayout;

/**
 * The layout a fresh mount starts from.
 *
 * Read only in the browser. This module is a client module, but Next still
 * renders it on the server, where module scope is the *process* rather than a
 * tab — so a server render must never hand one reader's seam to another, and
 * must never disagree with the first client paint of the same document.
 */
export function initialWorkbenchLayout(): Layout {
  return typeof window === "undefined"
    ? defaultWorkbenchLayout
    : savedWorkbenchLayout;
}

export function RequestWorkbenchShell({
  detail,
  hasDetail,
  list,
}: {
  detail: ReactNode;
  hasDetail: boolean;
  list: ReactNode;
}) {
  return (
    <Resizable.Group
      defaultLayout={initialWorkbenchLayout()}
      onLayoutChanged={(layout) => {
        savedWorkbenchLayout = boundedWorkbenchLayout(layout);
      }}
      orientation="horizontal"
    >
      <Resizable.Panel
        id={workbenchPanels.list.id}
        maxSize={`${workbenchPanels.list.maximum}%`}
        minSize={`${workbenchPanels.list.minimum}%`}
      >
        <section aria-label="Request list">{list}</section>
      </Resizable.Panel>
      <Resizable.Handle withGrip />
      <Resizable.Panel id={workbenchPanels.detail.id}>
        <aside aria-label="Selected request">
          {hasDetail ? (
            detail
          ) : (
            <EmptyState
              hint="Choose a request from the list to read its record beside it."
              icon={PanelRight}
              title="No request selected"
            />
          )}
        </aside>
      </Resizable.Panel>
    </Resizable.Group>
  );
}
