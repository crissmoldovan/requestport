"use client";

import { Link, Stack } from "@cueplusplus/ui/layout";
import { Popover } from "@cueplusplus/ui/overlays";
import { Avatar, Button, Separator } from "@cueplusplus/ui/primitives";
import { authClient } from "@requestport/auth/client";
import type { AppearanceSnapshot } from "@requestport/domain/browser";
import NextLink from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AppearanceFormAction } from "../app/(app)/settings/appearance/action-state.js";
import {
  appearanceRenderContextRemainingMs,
  appearanceRenderContextTtlSeconds,
  appearanceRenderContextUsable,
  fetchPersonalAppearanceRenderContext,
} from "../lib/appearance-context-mint.js";
import {
  type OrganizationDefaultPromotion,
  PersonalAppearanceForm,
} from "./appearance-controls.js";

/** Everything the account menu needs to render the compact appearance panel. */
export type UserAppearanceMenu = {
  action?: AppearanceFormAction;
  /**
   * Whether this viewer may change the organization's defaults.
   *
   * The panel edits one layer and names the other, so an owner needs to be told
   * the other is theirs. Decided by `canEditOrganizationAppearance`, which the
   * settings page uses to decide whether to render the form at all — one
   * authority, two views of it.
   */
  canEditOrganizationDefaults: boolean;
  /**
   * What an owner needs to offer their own choice to everyone.
   *
   * Supplied only alongside the authority above, and separately from it because
   * it carries a different render context and a different command — the panel
   * must not be able to write the organization's defaults with the personal
   * form's credentials.
   */
  organizationDefault?: OrganizationDefaultPromotion;
  contextToken: string;
  idempotencyNonce: string;
  organizationName: string | null;
  snapshot: AppearanceSnapshot;
};

/**
 * The account menu. It is a popover rather than a menu because it holds a form:
 * a menu's roving focus and typeahead would fight the appearance controls for
 * every keystroke.
 *
 * Dismissal — Escape, an outside press, or Cancel — unmounts the panel, and the
 * draft preview restores the confirmed triple as it goes.
 */
/** While the panel is waiting on a mint it has nothing else to offer. */
const preparingMessage = "Preparing the appearance controls…";

/**
 * What the reader is told when the mint could not answer and the token the
 * document carries is already spent. It names the remedy that is *not* a page
 * reload, which is the whole reason this control exists.
 */
const unavailableMessage =
  "The appearance controls could not be prepared. Try again.";

export function UserControl({
  appearance,
  email,
  name,
}: {
  appearance: UserAppearanceMenu;
  email: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [minting, setMinting] = useState(false);
  const [renderContext, setRenderContext] = useState<string | null>(null);
  // Whether the token on offer has crossed the expiry margin since the panel
  // opened. Set once, by a deadline of its own, and cleared when a token that
  // has not arrives.
  const [spent, setSpent] = useState(false);
  // Whether the panel that asked for a mint is still the panel on screen. A
  // mint that lands after a dismissal belongs to a form nobody is holding.
  const showing = useRef(false);

  const mint = useCallback(() => {
    setMinting(true);
    void fetchPersonalAppearanceRenderContext().then((token) => {
      if (!showing.current) return;
      setMinting(false);
      if (token) setRenderContext(token);
    });
  }, []);

  // The panel is part of the app chrome, and the App Router keeps a shared
  // layout across every soft navigation — so the token minted in the layout body
  // aged with the *tab*. After fifteen minutes of ordinary rail-link browsing
  // the first Apply came back `context_conflict`, whose only remedy is the page
  // reload this control exists to avoid.
  //
  // The form reaches the reader when the panel opens, so that is when the
  // context it records is minted. Nothing about the check is relaxed: the mint
  // authenticates and binds the actor it just authenticated, and the write still
  // verifies the sealed claims against a freshly authenticated context. Nothing
  // here re-mints in response to a *rejection*, which is the one shortcut that
  // could replay a form rendered for one actor as another: the only things that
  // ask for a token are opening the panel and the reader pressing Try again,
  // and neither has a submission in flight.
  useEffect(() => {
    showing.current = open;
    if (!open) {
      setRenderContext(null);
      setMinting(false);
      return;
    }
    mint();

    return () => {
      showing.current = false;
    };
  }, [mint, open]);

  const offered = renderContext ?? appearance.contextToken;

  // A mint that cannot answer leaves the rendered token in place, and for every
  // tab inside the fifteen minutes that is right: the panel is not gated on a
  // round trip, and the document's own token is one the server will still take.
  //
  // Past the fifteen minutes it is not right, and that is the whole journey
  // this control was built for. "Keep the token you have" then means "submit
  // the one already known to be expired", so the reader pressed Apply and got
  // back the `context_conflict` the mint existed to prevent. A token this side
  // can see is spent is therefore not offered at all; the panel says so and
  // hands over the mint, which is the way out that is not a page reload.
  //
  // The margin can also be crossed *while the panel sits open*, and a panel
  // nobody touches does not render again — so reading the issue time during
  // render closed only half the journey. The remaining life is knowable
  // exactly, so it is waited out exactly: one deadline per token on offer,
  // cancelled when the token changes or the panel closes. Nothing polls, and
  // nothing about the write is relaxed — this only ever narrows what is
  // offered, and the server still verifies the sealed claims against a freshly
  // authenticated context.
  useEffect(() => {
    if (!open) {
      setSpent(false);
      return;
    }

    const remaining = appearanceRenderContextRemainingMs(offered);
    if (remaining !== null && remaining <= 0) {
      setSpent(true);
      return;
    }

    // A token this side cannot date is not a token it knows to be spent, so a
    // mint that answers with one clears the deadline rather than inheriting it.
    setSpent(false);
    if (remaining === null) return;

    // A clock disagreement is the server's to judge, so a token that claims
    // more life than one can ever have waits out one lifetime and no more.
    const timer = setTimeout(
      () => setSpent(true),
      Math.min(remaining, appearanceRenderContextTtlSeconds * 1_000),
    );

    return () => clearTimeout(timer);
  }, [offered, open]);

  const ready =
    !spent &&
    (renderContext !== null ||
      appearanceRenderContextUsable(appearance.contextToken));

  async function signOut() {
    setPending(true);
    await authClient.signOut();
    window.location.assign("/sign-in");
  }

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        render={
          <Button
            aria-label={`Open user menu for ${name}`}
            size="sm"
            variant="ghost"
          >
            <Avatar alt={name} size="sm" />
          </Button>
        }
      />
      {/* The panel quotes the tenant's name — "Inherited from …", and the
       * organization-level copy under it — and a name is arbitrary text. With
       * no wrapping rule one long unbroken token overflows the popover's own
       * box: `Popover.Popup` caps its width at `calc(100vw-2rem)`, so the panel
       * keeps looking correctly sized while its content scrolls sideways inside
       * it, out of reach of a pointer that has nothing to drag. */}
      <Popover.Content align="end" className="break-words" side="bottom">
        <Stack direction="column" gap={3}>
          <Stack direction="column" gap={1}>
            <Popover.Title>{name}</Popover.Title>
            <Popover.Description>{email}</Popover.Description>
          </Stack>
          <Separator />
          {ready ? (
            <PersonalAppearanceForm
              action={appearance.action}
              contextToken={renderContext ?? appearance.contextToken}
              idempotencyNonce={appearance.idempotencyNonce}
              onDismiss={() => setOpen(false)}
              organizationDefault={appearance.organizationDefault}
              organizationName={appearance.organizationName}
              snapshot={appearance.snapshot}
            />
          ) : (
            <Stack direction="column" gap={2}>
              <span>{minting ? preparingMessage : unavailableMessage}</span>
              <Stack direction="row" gap={2} wrap>
                <Button
                  disabled={minting}
                  onClick={mint}
                  size="sm"
                  type="button"
                  variant="primary"
                >
                  Try again
                </Button>
                <Button
                  onClick={() => setOpen(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </Stack>
            </Stack>
          )}
          <Separator />
          <Stack align="center" direction="row" gap={3} justify="between">
            <Stack direction="column" gap={1}>
              <Link render={<NextLink href="/settings/appearance" />}>
                Appearance settings
              </Link>
              {appearance.canEditOrganizationDefaults ? (
                <span>
                  The organization&rsquo;s defaults are set there too.
                </span>
              ) : null}
            </Stack>
            <Button
              disabled={pending}
              onClick={signOut}
              size="sm"
              type="button"
              variant="ghost"
            >
              {pending ? "Signing out…" : "Sign out"}
            </Button>
          </Stack>
        </Stack>
      </Popover.Content>
    </Popover.Root>
  );
}
