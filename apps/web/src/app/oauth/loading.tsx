import { PageShell } from "@cueplusplus/ui/chrome";
import { Stack } from "@cueplusplus/ui/layout";
import { Spinner } from "@cueplusplus/ui/primitives";

/**
 * The root loading boundary. It renders under the document the root layout
 * already painted, so it owns the page's `<main>` landmark and nothing else:
 * the appearance triple, the fonts, and the provider are already resolved
 * above it.
 */
export default function RootLoading() {
  return (
    <main>
      <PageShell width="narrow">
        <Stack align="center" direction="row" gap={2}>
          <Spinner label="Loading RequestPort" size="sm" />
          <span>Loading RequestPort…</span>
        </Stack>
      </PageShell>
    </main>
  );
}
