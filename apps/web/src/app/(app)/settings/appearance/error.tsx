"use client";

import { Stack } from "@cueplusplus/ui/layout";
import { Button } from "@cueplusplus/ui/primitives";

/**
 * The route error boundary. It never renders anything derived from the thrown
 * error — no message, digest, query, or provider payload — and it never claims
 * the stored preferences changed, because a failed read never wrote anything.
 */
export default function AppearanceSettingsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Stack direction="column" gap={3}>
      <h1>Appearance settings are unavailable</h1>
      <p>
        This page could not be loaded. Your saved appearance is unchanged, and
        the rest of RequestPort is unaffected.
      </p>
      <Stack direction="row" gap={2}>
        <Button onClick={reset} size="sm" type="button" variant="secondary">
          Try again
        </Button>
      </Stack>
    </Stack>
  );
}
