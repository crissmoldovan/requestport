import { EmptyState, Eyebrow, PageShell, Panel } from "@cueplusplus/ui/chrome";
import { Button } from "@cueplusplus/ui/primitives";
import { Compass } from "lucide-react";
import NextLink from "next/link";

/**
 * The settings segment's not-found boundary (ruling 260), rendered in the page
 * column of `settings/layout.tsx`, so the section navigation stays beside it.
 *
 * A settings page answers not-found for a record it does not hold, a record
 * of another tenant, and a page a member may not open (routing and
 * operations), and all three read identically on purpose: an existence hint
 * is a tenant leak, and a denial that named itself would describe the page to
 * someone who may not see it. The way out is the organization page, which
 * every member may open.
 */
export default function SettingsNotFound() {
  return (
    <PageShell
      eyebrow={<Eyebrow>Settings</Eyebrow>}
      title="Not found"
      width="wide"
    >
      <Panel>
        <EmptyState
          action={
            <Button
              render={<NextLink href="/settings/organization" />}
              variant="primary"
            >
              Go to organization settings
            </Button>
          }
          hint="That setting is not available in the current organization."
          icon={Compass}
          title="Nothing lives at this address"
        />
      </Panel>
    </PageShell>
  );
}
