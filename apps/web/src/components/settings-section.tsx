import { Panel, PanelHeader, Row } from "@cueplusplus/ui/chrome";
import { Stack } from "@cueplusplus/ui/layout";
import type { ReactNode } from "react";

import { PageSection } from "./page-layout.js";
import {
  sectionHeadingClasses,
  sectionHeadingNoteClasses,
} from "./section-heading.js";

/**
 * One administration section: a labelled region, a panel, and a heading the
 * region is named by.
 *
 * The measure and the page gutter are not among its parts — they belong to the
 * one `Page` column every section sits in, and a section that opened a shell of
 * its own is what put two page paddings between a heading and its first panel.
 *
 * Every settings and agent surface repeats those three parts, so they are
 * composed once here rather than at each of the thirty-odd call sites. The
 * heading goes in `PanelHeader`'s *leading cluster* rather than its `title`
 * slot, because that slot is a `<span>` — phrasing content — and a section of a
 * document needs a real `<h2>` a screen-reader user can jump between. The
 * cluster is a `<div>`, so the heading is valid there, and borrowing the slot's
 * own typography keeps the two reading identically.
 */

export function SettingsSection({
  action,
  bleed = false,
  children,
  headingId,
  note,
  title,
}: {
  action?: ReactNode;
  /**
   * Hand the body the panel without the row gutter. A table draws its own cell
   * padding, so nesting one inside a `Row` doubles the gutter the row tokens
   * already set.
   */
  bleed?: boolean;
  children: ReactNode;
  headingId: string;
  note?: ReactNode;
  title: string;
}) {
  return (
    <PageSection labelledBy={headingId}>
      <Panel>
        <PanelHeader actions={action}>
          <h2 className={sectionHeadingClasses} id={headingId}>
            {title}
          </h2>
          {note ? (
            <span className={sectionHeadingNoteClasses}>{note}</span>
          ) : null}
        </PanelHeader>
        {bleed ? (
          children
        ) : (
          <Row>
            <Stack direction="column" gap={3}>
              {children}
            </Stack>
          </Row>
        )}
      </Panel>
    </PageSection>
  );
}
