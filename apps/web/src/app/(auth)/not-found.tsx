import { EmptyState, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { Compass } from "lucide-react";
import NextLink from "next/link";

/** The authentication segment's not-found boundary. */
export default function AuthenticationNotFound() {
  return (
    <main>
      <PageShell title="Page not found" width="narrow">
        <Panel>
          <EmptyState
            action={
              <Button render={<NextLink href="/sign-in" />} variant="primary">
                Go to sign in
              </Button>
            }
            hint="That address does not match an authentication page."
            icon={Compass}
            title="Nothing lives at this address"
          />
        </Panel>
      </PageShell>
    </main>
  );
}
