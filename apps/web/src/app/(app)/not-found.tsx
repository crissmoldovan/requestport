import { EmptyState, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { Compass } from "lucide-react";
import NextLink from "next/link";

/**
 * The authenticated segment's not-found boundary, reached when a record the
 * URL names is absent — or belongs to another tenant. Both read identically on
 * purpose: an existence hint is a tenant leak.
 */
export default function ApplicationNotFound() {
  return (
    <PageShell title="Not found" width="wide">
      <Panel>
        <EmptyState
          action={
            <Button render={<NextLink href="/" />} variant="primary">
              Go to the overview
            </Button>
          }
          hint="That record is not available in the current organization."
          icon={Compass}
          title="Nothing lives at this address"
        />
      </Panel>
    </PageShell>
  );
}
