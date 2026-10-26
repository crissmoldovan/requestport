import { Stack } from "@cueplusplus/ui/layout";
import type { ReactNode } from "react";

import { SettingsNavigation } from "./settings-navigation.js";

/**
 * Every settings page, beside the settings section navigation (ruling 256).
 *
 * The two parts share one wrapping line. The page's column asks for
 * `basis-lg` and takes nearly all the free space (`grow-999`), so beside it
 * the navigation keeps the CUE++ column's own width. Where the work area
 * cannot hold both on one line, at phone width and on a narrow tablet, the
 * page wraps onto the next line and the navigation, alone on the first,
 * grows across it: the section navigation stacks above the content.
 *
 * Each page keeps its own `Page`, and with it the one `PageShell` that gives
 * the page its measure and gutter. The layout opens none.
 */
export default function SettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <Stack align="start" direction="row" gap={0} wrap>
      <SettingsNavigation />
      <div className="min-w-0 grow-999 basis-lg">{children}</div>
    </Stack>
  );
}
