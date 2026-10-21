import { EmptyState, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { Compass } from "lucide-react";
import NextLink from "next/link";

/**
 * The root not-found boundary, for a URL that matches no route at all. It says
 * nothing about what does exist: an unmatched address is not an invitation to
 * enumerate the ones that would have matched.
 */
export default function RootNotFound() {
  return (
    <main>
      <PageShell title="Page not found" width="narrow">
        <Panel>
          <EmptyState
            action={
              <Button render={<NextLink href="/" />} variant="primary">
                Go to the overview
              </Button>
            }
            hint="That address does not match anything in RequestPort."
            icon={Compass}
            title="Nothing lives at this address"
          />
        </Panel>
      </PageShell>
    </main>
  );
}
