import { Eyebrow, PageShell } from "@cueplusplus/ui/chrome";
import type { ReactNode } from "react";

type PageWidth = "administration" | "form" | "wide";

/**
 * RequestPort's three measures, mapped onto the published CUE++ page widths.
 *
 * `narrow` is the 42rem reading column the forms have always used, `wide` the
 * working column for administration tables, and `broad` the workbench measure.
 * The lengths themselves belong to the package, which is the point: the two
 * raw widths the application used to own are the two the reskin retires.
 */
export const pageShellWidth = {
  administration: "wide",
  form: "narrow",
  wide: "broad",
} as const satisfies Record<PageWidth, "broad" | "narrow" | "wide">;

/**
 * One page: one padded measure column.
 *
 * The installed `PageShell` is not a heading widget — it is "a centred content
 * column with a standard page header", and it supplies the measure *and* the
 * gutter (`px-(--cue-space-6) py-(--cue-space-7)`) unconditionally, emitting
 * the header only when something fills it. Composing a page out of one shell
 * per part therefore stacked a full page gutter between every part: the header
 * shell closed with `py-(--cue-space-7)` and the first section shell opened
 * with the same, so the distance from a page heading to its first panel was two
 * page paddings on every migrated route.
 *
 * So a page opens exactly one shell. The header props fill its header, the
 * sections are its children, and the rhythm between them is the shell's own
 * `gap-(--cue-space-6)` — the package's number rather than one this application
 * re-derives. That is also how the package documents its own use.
 *
 * An organization name, a project slug and a repository URL are all arbitrary
 * text, and a page quotes them. Without a wrapping rule a single long unbroken
 * token widens the column past the shell's one scroller, which scrolls the
 * whole console sideways rather than wrapping the word. `overflow-wrap` is
 * inherited, so the column sets it once for everything inside it.
 *
 * The eyebrow needs more than that. `Eyebrow` is an `inline-flex` box, so its
 * text is a flex item whose minimum width is its min-content width, and
 * `break-word` does not lower min-content: the item grows to the longest
 * unbroken run and overflows anyway. `anywhere` does lower it. A 63-character
 * organization slug at 390px ran past the edge this way once the default
 * density became `normal`, whose label size is larger than ultra-compact's.
 * It is set on the eyebrow alone because, on the column, it would also let an
 * auto-layout table squeeze its columns to a character's width.
 */
export function Page({
  action,
  children,
  description,
  eyebrow,
  title,
  width = "administration",
}: {
  action?: ReactNode;
  children?: ReactNode;
  description: string;
  eyebrow: string;
  title: string;
  width?: PageWidth;
}) {
  return (
    <PageShell
      actions={action}
      className="break-words"
      eyebrow={<Eyebrow className="wrap-anywhere">{eyebrow}</Eyebrow>}
      subtitle={description}
      title={title}
      width={pageShellWidth[width]}
    >
      {children}
    </PageShell>
  );
}

/**
 * One labelled region of a page.
 *
 * It carries no measure and no gutter of its own: both belong to the one
 * `Page` column it sits in, and a section that opened a second shell is exactly
 * what put two page paddings between a heading and the panel under it.
 */
export function PageSection({
  children,
  labelledBy,
}: {
  children: ReactNode;
  labelledBy?: string;
}) {
  return <section aria-labelledby={labelledBy}>{children}</section>;
}
