"use client";

import { AppBar, AppShell as ConsoleFrame } from "@cueplusplus/ui/chrome";
import { Stack } from "@cueplusplus/ui/layout";
import { Button, Kbd } from "@cueplusplus/ui/primitives";
import type { OrganizationAccess } from "@requestport/domain";
import { Plus, Search } from "lucide-react";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";

import { OrganizationSwitcher } from "./organization-switcher.js";
import { PrimaryNavigation } from "./primary-navigation.js";
import { RequestPortMark } from "./request-port-mark.js";
import { type UserAppearanceMenu, UserControl } from "./user-control.js";

/**
 * The authenticated console frame.
 *
 * `AppShell` is the native component that owns the one piece of arithmetic a
 * console cannot get wrong twice: a frame exactly one viewport tall, one
 * scroller inside it, and the navigation in both of its shapes — the `Sidebar`
 * column on a wide viewport and the `Drawer` on a narrow one — from a single
 * set of children. RequestPort keeps what is genuinely its own: the route map,
 * the tenant switcher, the account menu, and the product copy.
 *
 * The directive above is load-bearing, and `src/test/server-component-boundary.
 * test.ts` is what keeps it there. `AppShell` is published from a client module,
 * so a server module importing it holds a client *reference* rather than the
 * compound object — `ConsoleFrame.Root` is `undefined` before any code here
 * runs, and every authenticated route paints its error boundary. The icons are
 * the same boundary read the other way: a lucide icon is a component function,
 * and a function is not serialisable across it. Both stop being crossings the
 * moment this module is a client module itself, which costs nothing — the frame
 * renders no data of its own, and every subtree it is handed arrives already
 * rendered as `children`.
 */
export function AppShell({
  appearance,
  children,
  currentOrganization,
  organizations,
  user,
}: {
  appearance: UserAppearanceMenu;
  children: ReactNode;
  currentOrganization: OrganizationAccess | null;
  organizations: OrganizationAccess[];
  user: { email: string; image: string | null; name: string };
}) {
  const pathname = usePathname();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);

  // The drawer is a modal dialog, and a client-side navigation does not unmount
  // it: following a destination on a narrow viewport left the workspace map
  // open *over* the page it had just opened, with the rest of the document
  // hidden from assistive technology behind it. Closing it belongs to the shell
  // — the frame publishes its own open state for exactly this, and every link
  // inside it is an ordinary `next/link`. The reset happens during the render
  // the new path arrives in rather than in an effect after it, so the drawer is
  // never painted over the page it just opened.
  if (openedAt !== pathname) {
    setOpenedAt(pathname);
    setNavigationOpen(false);
  }

  return (
    <ConsoleFrame.Root
      navOpen={navigationOpen}
      onNavOpenChange={setNavigationOpen}
    >
      {/* The frame owns the viewport, so the bar never scrolls out from under
       * itself and needs no sticky position of its own. */}
      <AppBar.Root className="justify-between" sticky={false}>
        <Stack align="center" className="min-w-0" direction="row" gap={3}>
          <ConsoleFrame.NavTrigger label="Open navigation" />
          <AppBar.Brand
            render={<NextLink aria-label="RequestPort overview" href="/" />}
          >
            <span
              style={{
                alignItems: "center",
                display: "inline-flex",
                gap: "0.5rem",
              }}
            >
              <RequestPortMark />
              requestport
            </span>
          </AppBar.Brand>
          <OrganizationSwitcher
            currentOrganization={currentOrganization}
            organizations={organizations}
          />
        </Stack>
        {/* Below the shell's own breakpoint both actions keep their icon and
         * drop their label: a bar is one row, and three labelled controls plus
         * the tenant switcher do not fit a 390px viewport. The label moves to
         * `aria-label` rather than disappearing, so each control is named the
         * same at every width — to a screen reader and to a journey alike.
         *
         * The accessible name is the visible label, ellipsis included, rather
         * than a tidied-up paraphrase of it. WCAG 2.5.3 asks that a control's
         * name contain the text a sighted user reads on it, because that is the
         * string a speech-input user will say — and "Search or run a command"
         * is not the label the wide viewport shows. The `⌘K` badge stays out of
         * it: a shortcut hint is not part of what the control is called. */}
        <AppBar.Actions>
          <Button
            aria-label="Search or run a command…"
            icon={Search}
            render={<NextLink href="/search" />}
            size="sm"
            variant="ghost"
          >
            <span className="hidden md:contents">
              Search or run a command…
              <Kbd>⌘K</Kbd>
            </span>
          </Button>
          <Button
            aria-label="New request"
            icon={Plus}
            render={<NextLink href="/requests/new" />}
            size="sm"
            variant="primary"
          >
            <span className="hidden md:contents">New request</span>
          </Button>
          <UserControl
            appearance={appearance}
            email={user.email}
            name={user.name}
          />
        </AppBar.Actions>
      </AppBar.Root>
      <ConsoleFrame.Body>
        <ConsoleFrame.Sidebar aria-label="Primary" drawerTitle="Navigation">
          <PrimaryNavigation />
        </ConsoleFrame.Sidebar>
        <ConsoleFrame.Content>
          <ConsoleFrame.Scroller>{children}</ConsoleFrame.Scroller>
        </ConsoleFrame.Content>
      </ConsoleFrame.Body>
    </ConsoleFrame.Root>
  );
}
