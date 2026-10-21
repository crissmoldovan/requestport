import { PageShell } from "@cueplusplus/ui/chrome";
import { Stack } from "@cueplusplus/ui/layout";
import { Spinner } from "@cueplusplus/ui/primitives";

/**
 * The authenticated segment's loading boundary. It renders inside the shell's
 * own `<main>`, so it adds no landmark of its own — only the announcement that
 * the work area is still resolving.
 */
export default function ApplicationLoading() {
  return (
    <PageShell width="wide">
      <Stack align="center" direction="row" gap={2}>
        <Spinner label="Loading this page" size="sm" />
        <span>Loading this page…</span>
      </Stack>
    </PageShell>
  );
}
