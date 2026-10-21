"use client";

import { EmptyState, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { TriangleAlert } from "lucide-react";

/**
 * The authentication segment's error boundary.
 *
 * It never reports which provider failed, and never suggests that anything was
 * signed in: a failure here leaves the visitor exactly as anonymous as they
 * were, which is the one fact worth stating.
 *
 * The hint names this boundary and nothing else. The /auth-error page it
 * replaces prints the same reassurance about the session, and a sentence the
 * two share would let an assertion about the boundary be satisfied by the page
 * that rendered because the boundary did not.
 */
export default function AuthenticationError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <PageShell title="Sign-in is unavailable" width="narrow">
        <Panel>
          <EmptyState
            action={
              <Button onClick={reset} type="button" variant="primary">
                Try again
              </Button>
            }
            hint="This sign-in page could not be loaded. No session was created, and nothing about the account has changed."
            icon={TriangleAlert}
            title="This page could not be loaded"
          />
        </Panel>
      </PageShell>
    </main>
  );
}
