import { PageShell } from "@cueplusplus/ui/chrome";
import { Stack } from "@cueplusplus/ui/layout";
import type { ReactNode } from "react";

import { RequestPortMark } from "../../components/request-port-mark.js";

/**
 * The frame the ways in share (ruling 259): sign-in, the auth error page and
 * the agent consent page.
 *
 * One narrow `PageShell`, and in it, centred, the product's mark and name, the
 * page's one `<h1>`, the lines under it, and then the page's own content — a
 * card, as the reference build's sign-in draws it. The shell supplies the
 * measure and the gutter, so nothing here writes a width of its own.
 */
export function WaysIn({
  children,
  lines,
  title,
}: {
  children: ReactNode;
  /** The short lines under the heading: where it signs in to, what it offers. */
  lines?: ReactNode;
  title: string;
}) {
  return (
    <main>
      <PageShell width="narrow">
        <Stack align="center" direction="column" gap={5}>
          <Stack align="center" direction="column" gap={2}>
            <span className="flex items-center gap-(--cue-space-2) font-semibold text-fg">
              <RequestPortMark />
              RequestPort
            </span>
            <h1 className="text-center text-(length:--cue-text-title) font-semibold text-fg">
              {title}
            </h1>
            {lines}
          </Stack>
          {children}
        </Stack>
      </PageShell>
    </main>
  );
}
