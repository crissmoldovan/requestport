"use client";

import { Toast } from "@cueplusplus/ui/overlays";
import type { ReactNode } from "react";

/**
 * The console's one toast queue and the one viewport that shows it (ruling
 * 260).
 *
 * `AppShell` mounts it, around everything the frame draws, so it sits above
 * every authenticated page and outlives each of them: a confirmation a control
 * raises as its write redirects, or as revalidation removes the row that
 * raised it, stays on screen while the page below changes. No page mounts a
 * provider of its own; `app-shell.test.tsx` fails on one that does. A
 * component suite mounts this same provider around the control it renders
 * when it renders the control without the frame.
 *
 * A client module because `Toast` is a client namespace, which a server module
 * cannot dot into.
 */
export function ConsoleToasts({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Viewport />
    </Toast.Provider>
  );
}
