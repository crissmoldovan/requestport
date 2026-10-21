"use client";

import { EmptyState, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { ThemeProvider } from "@cueplusplus/ui/system";
import { appearanceFallback } from "@requestport/domain/browser";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { TriangleAlert } from "lucide-react";

import { appThemes } from "../lib/app-themes.js";

import "./globals.css";

/**
 * `global-error` replaces the root layout, so it owns the whole document: the
 * global stylesheet, its own `<html>`/`<body>`, and its own CUE++ provider.
 *
 * It deliberately assumes nothing. There is no root context to read, no
 * appearance query to run, and no browser storage to consult — a stale,
 * malformed, or throwing record must not change what this page paints. The
 * fixed RequestPort fallback triple is the whole contract, and `system` mode
 * lets the token layer follow the operating system through CSS alone.
 *
 * The thrown error is never shown. Its message and digest stay server-side.
 */
export default function GlobalError({
  retry,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
}>) {
  return (
    <html
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-density={appearanceFallback.density}
      data-mode={appearanceFallback.mode}
      data-theme={appearanceFallback.theme}
      lang="en"
      suppressHydrationWarning
    >
      <ThemeProvider
        asChild
        density={appearanceFallback.density}
        fontFamilies={{
          sans: GeistSans.style.fontFamily,
          mono: GeistMono.style.fontFamily,
        }}
        mode={appearanceFallback.mode}
        persistPreferences={false}
        theme={appearanceFallback.theme}
        themes={appThemes}
      >
        <body>
          <main>
            {/* The page's own heading comes from the shell rather than from the
             * empty state: CUE++ publishes the empty-state title as a `<span>`,
             * so a boundary that leaned on it would have no heading at all. */}
            <PageShell title="Something went wrong" width="narrow">
              <Panel>
                <EmptyState
                  action={
                    <Button
                      onClick={() => retry()}
                      type="button"
                      variant="primary"
                    >
                      Try again
                    </Button>
                  }
                  hint="RequestPort could not render this page. Nothing was changed, and your work is safe."
                  icon={TriangleAlert}
                  title="This page could not be rendered"
                />
              </Panel>
            </PageShell>
          </main>
        </body>
      </ThemeProvider>
    </html>
  );
}
