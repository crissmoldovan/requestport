"use client";

import { EmptyState, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { TriangleAlert } from "lucide-react";

/**
 * The authenticated segment's error boundary. The shell around it — bar,
 * navigation, account menu — is still there, so this replaces the work area
 * only, and says nothing the thrown error carried.
 */
export default function ApplicationError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageShell title="Something went wrong" width="wide">
      <Panel>
        <EmptyState
          action={
            <Button onClick={reset} type="button" variant="primary">
              Try again
            </Button>
          }
          hint="RequestPort could not load this page. Nothing was changed, and the rest of the workspace is unaffected."
          icon={TriangleAlert}
          title="This page could not be loaded"
        />
      </Panel>
    </PageShell>
  );
}
