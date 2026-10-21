import { PageShell } from "@cueplusplus/ui/chrome";
import { Stack } from "@cueplusplus/ui/layout";
import { Spinner } from "@cueplusplus/ui/primitives";

/** The authentication segment's loading boundary. */
export default function AuthenticationLoading() {
  return (
    <main>
      <PageShell width="narrow">
        <Stack align="center" direction="row" gap={2}>
          <Spinner label="Loading sign-in" size="sm" />
          <span>Loading sign-in…</span>
        </Stack>
      </PageShell>
    </main>
  );
}
