"use client";

import { EmptyState, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { TriangleAlert } from "lucide-react";

/**
 * The root error boundary: everything the root layout wraps that is not inside
 * the authenticated or authentication segments — the documentation pages and
 * the OAuth consent route.
 *
 * The thrown error is never rendered. Its message and digest stay server-side,
 * and the page says only what is true of every failure here: nothing was
 * written.
 */
export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <PageShell title="Something went wrong" width="narrow">
        <Panel>
          <EmptyState
            action={
              <Button onClick={reset} type="button" variant="primary">
                Try again
              </Button>
            }
            hint="RequestPort could not render this page. Nothing was changed."
            icon={TriangleAlert}
            title="This page could not be loaded"
          />
        </Panel>
      </PageShell>
    </main>
  );
}
