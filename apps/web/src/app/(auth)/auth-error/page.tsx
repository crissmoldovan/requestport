import { EmptyState } from "@cueplusplus/ui/chrome";
import { Card } from "@cueplusplus/ui/layout";
import { Button } from "@cueplusplus/ui/primitives";
import { TriangleAlert } from "lucide-react";
import NextLink from "next/link";

import { applyE2EScenarioBoundary } from "../../../lib/server-scenario-boundary.js";
import { WaysIn } from "../ways-in.js";

type AuthErrorPageProps = {
  searchParams: Promise<{ error?: string | string[] }>;
};

export default async function AuthErrorPage({
  searchParams,
}: AuthErrorPageProps) {
  // A public surface still has a segment loading, error, and not-found
  // boundary, and the inventory declares all three for it. This is where a
  // guarded local run reaches them; on every deployed build it does nothing at
  // all, because no run can be open there.
  await applyE2EScenarioBoundary();
  const error = (await searchParams).error;
  const errorCode = Array.isArray(error) ? error[0] : error;
  const message =
    errorCode === "signup_disabled"
      ? "This RequestPort is invite-only"
      : "We couldn’t sign you in. Please try again.";

  // The ways in share one frame (ruling 259): the mark, the heading, a card.
  return (
    <WaysIn title="Sign-in unavailable">
      <Card.Root className="w-full">
        <Card.Content>
          {/* The provider's own reason never reaches the page: only the two
           * fixed messages above are ever rendered. */}
          <EmptyState
            action={
              <Button render={<NextLink href="/sign-in" />} variant="primary">
                Return to sign in
              </Button>
            }
            hint="No session was created, and nothing about the account has changed."
            icon={TriangleAlert}
            title={message}
          />
        </Card.Content>
      </Card.Root>
    </WaysIn>
  );
}
