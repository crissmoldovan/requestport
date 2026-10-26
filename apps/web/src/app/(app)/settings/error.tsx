"use client";

import { EmptyState, Eyebrow, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { TriangleAlert } from "lucide-react";

/**
 * The settings segment's error boundary (ruling 260).
 *
 * Next.js nests a segment's `error.tsx` inside that segment's `layout.tsx`, so
 * a settings page that fails renders this in the page column of
 * `settings/layout.tsx`: the section navigation stays drawn beside it, and
 * the person can go on to another settings page. The appearance page keeps
 * its own, nearer boundary. Like the authenticated segment's boundary, it says
 * nothing the thrown error carried.
 */
export default function SettingsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageShell
      eyebrow={<Eyebrow>Settings</Eyebrow>}
      title="Something went wrong"
      width="wide"
    >
      <Panel>
        <EmptyState
          action={
            <Button onClick={reset} type="button" variant="primary">
              Try again
            </Button>
          }
          hint="RequestPort could not load this settings page. Nothing was changed, and the other settings pages are still reachable beside it."
          icon={TriangleAlert}
          title="This settings page could not be loaded"
        />
      </Panel>
    </PageShell>
  );
}
