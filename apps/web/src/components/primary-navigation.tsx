"use client";

import { Sidebar } from "@cueplusplus/ui/layout";
import {
  Activity,
  Bot,
  Building2,
  FolderKanban,
  Gauge,
  Hash,
  Import,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MessageCircleQuestion,
  Route,
  Users,
  Webhook,
} from "lucide-react";
import NextLink from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ComponentType } from "react";

/**
 * The workspace map.
 *
 * Every destination carries a Lucide icon handed to the native
 * `Sidebar.Item` icon slot, which draws it `aria-hidden` at the density rung
 * the theme is on. RequestPort owns the route data; CUE++ owns the row.
 */
export const navigationDestinations = [
  { href: "/", icon: LayoutDashboard, label: "Overview" },
  { href: "/requests", icon: ListChecks, label: "Requests" },
  { href: "/requests?view=inbox", icon: Inbox, label: "Inbox" },
  { href: "/requests?view=my_work", icon: Activity, label: "My work" },
  { href: "/questions", icon: MessageCircleQuestion, label: "Questions" },
  { href: "/activity", icon: Activity, label: "Activity" },
  { href: "/settings/projects", icon: FolderKanban, label: "Projects" },
  {
    href: "/settings/organization",
    icon: Building2,
    label: "Organization",
  },
  { href: "/settings/members", icon: Users, label: "Members" },
  { href: "/settings/routing", icon: Route, label: "Routing" },
  { href: "/settings/operations", icon: Gauge, label: "Operations" },
  // Plan 13, F.3.1: drawn whatever REQUESTPORT_OPERATOR_CREDENTIALS says. With
  // operator credentials off, the page draws its unavailable state and every
  // action on it refuses; the link is the only thing this entry adds.
  { href: "/settings/operators", icon: KeyRound, label: "Operator keys" },
  { href: "/agents", icon: Bot, label: "Agents" },
  { href: "/webhooks", icon: Webhook, label: "Webhooks" },
  { href: "/slack", icon: Hash, label: "Slack" },
  { href: "/imports", icon: Import, label: "Imports" },
] satisfies ReadonlyArray<{
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}>;

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
 */
export function NavigationLinks({
  pathname,
  search = "",
}: {
  pathname: string;
  search?: string;
}) {
  return (
    <Sidebar.Section label="Workspace">
      {navigationDestinations.map((item) => (
        <Sidebar.Item
          active={isNavigationItemCurrent(pathname, item.href, search)}
          icon={item.icon}
          key={item.href}
          render={<NextLink href={item.href} />}
        >
          {item.label}
        </Sidebar.Item>
      ))}
    </Sidebar.Section>
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
