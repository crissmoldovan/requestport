"use client";

import { Sidebar } from "@cueplusplus/ui/layout";
import {
  Activity,
  Bot,
  Building2,
  Download,
  FolderKanban,
  Gauge,
  Hash,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MessageCircleQuestion,
  Palette,
  Route,
  Settings,
  UserCheck,
  Users,
  Webhook,
} from "lucide-react";
import NextLink from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ComponentType } from "react";

type Destination = {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  /**
   * The subtree the entry is current for, when that is wider than its own
   * address: Settings opens the organization page and stands for every page
   * under `/settings`.
   */
  currentFor?: string;
};

/**
 * The workspace map, in the three sections of the reference build
 * (`docs/design/console-prototype/src/Console.tsx`, ruling 256).
 *
 * Every destination carries a Lucide icon handed to the native
 * `Sidebar.Item` icon slot, which draws it `aria-hidden` at the density rung
 * the theme is on. RequestPort owns the route data; CUE++ owns the row.
 *
 * The settings pages are one entry here. Their own list is
 * `settingsDestinations`, below, which the settings layout draws as the
 * section navigation on every settings page.
 */
export const navigationSections: ReadonlyArray<{
  destinations: ReadonlyArray<Destination>;
  label: string;
}> = [
  {
    destinations: [
      { href: "/", icon: LayoutDashboard, label: "Overview" },
      { href: "/requests?view=inbox", icon: Inbox, label: "Inbox" },
      { href: "/requests?view=my_work", icon: UserCheck, label: "My work" },
      { href: "/requests", icon: ListChecks, label: "Requests" },
      { href: "/questions", icon: MessageCircleQuestion, label: "Questions" },
    ],
    label: "Work",
  },
  {
    destinations: [
      { href: "/agents", icon: Bot, label: "Agents" },
      { href: "/webhooks", icon: Webhook, label: "Webhooks" },
      { href: "/slack", icon: Hash, label: "Slack" },
      { href: "/imports", icon: Download, label: "Imports" },
    ],
    label: "Connect",
  },
  {
    destinations: [
      { href: "/activity", icon: Activity, label: "Activity" },
      {
        currentFor: "/settings",
        href: "/settings/organization",
        icon: Settings,
        label: "Settings",
      },
    ],
    label: "Organization",
  },
];

/** The map's destinations in order, without their sections. */
export const navigationDestinations: ReadonlyArray<Destination> =
  navigationSections.flatMap((section) => section.destinations);

/**
 * The settings pages, in the order the section navigation draws them, with
 * Appearance last (ruling 256).
 */
export const settingsDestinations: ReadonlyArray<Destination> = [
  {
    href: "/settings/organization",
    icon: Building2,
    label: "Organization",
  },
  { href: "/settings/members", icon: Users, label: "Members" },
  { href: "/settings/projects", icon: FolderKanban, label: "Projects" },
  { href: "/settings/routing", icon: Route, label: "Routing" },
  // Plan 13, F.3.1: drawn whatever REQUESTPORT_OPERATOR_CREDENTIALS says. With
  // operator credentials off, the page draws its unavailable state and every
  // action on it refuses; the link is the only thing this entry adds.
  { href: "/settings/operators", icon: KeyRound, label: "Operator keys" },
  { href: "/settings/operations", icon: Gauge, label: "Operations" },
  { href: "/settings/appearance", icon: Palette, label: "Appearance" },
];

export function isNavigationItemCurrent(
  pathname: string,
  href: string,
  search = "",
) {
  const hrefPath = href.split("?", 1)[0] ?? href;
  const hrefQuery = href.includes("?")
    ? new URLSearchParams(href.slice(href.indexOf("?") + 1))
    : null;
  if (hrefQuery) {
    const current = new URLSearchParams(search);
    return (
      pathname === hrefPath &&
      [...hrefQuery.entries()].every(
        ([key, value]) => current.get(key) === value,
      )
    );
  }
  if (href === "/requests" && pathname === "/requests") {
    return !["inbox", "my_work"].includes(
      new URLSearchParams(search).get("view") ?? "",
    );
  }
  return href === "/"
    ? pathname === href
    : pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}

/**
 * The navigation rows themselves, with no landmark of their own: the shell's
 * `AppShell.Sidebar` renders these same children into the desktop column and
 * the narrow-viewport drawer, and both halves announce as the one navigation
 * landmark it owns. A `<nav>` here would announce the map twice.
 *
 * No row carries a count. The shell's layout loads the session, the
 * organizations and the appearance, and nothing it loads counts the inbox,
 * the person's work or the open questions; a badge would need a query of its
 * own on every page, which ruling 256 leaves out.
 */
export function NavigationLinks({
  pathname,
  search = "",
}: {
  pathname: string;
  search?: string;
}) {
  return (
    <>
      {navigationSections.map((section) => (
        <Sidebar.Section key={section.label} label={section.label}>
          {section.destinations.map((item) => (
            <Sidebar.Item
              active={isNavigationItemCurrent(
                pathname,
                item.currentFor ?? item.href,
                search,
              )}
              icon={item.icon}
              key={item.href}
              render={<NextLink href={item.href} />}
            >
              {item.label}
            </Sidebar.Item>
          ))}
        </Sidebar.Section>
      ))}
    </>
  );
}

export function PrimaryNavigation() {
  return (
    <NavigationLinks
      pathname={usePathname()}
      search={useSearchParams().toString()}
    />
  );
}
