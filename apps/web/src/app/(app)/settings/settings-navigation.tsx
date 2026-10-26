"use client";

import { Sidebar } from "@cueplusplus/ui/layout";
import NextLink from "next/link";
import { usePathname } from "next/navigation";

import {
  isNavigationItemCurrent,
  settingsDestinations,
} from "../../../components/primary-navigation.js";

/**
 * The settings section navigation (ruling 256): the seven settings pages as a
 * CUE++ `Sidebar.Root`, which is a `<nav>` landmark of its own, named
 * "Settings" so it never reads as a second copy of the primary map.
 *
 * It draws no collapse rail, and it takes its width from the line it sits on
 * rather than from the column's default: `grow` lets it fill a line it has to
 * itself, which is the line above the page once the layout has wrapped it
 * there. The primary column's ground and rim are left off, so the list reads
 * as part of the page beside it rather than as a second sidebar.
 */
export function SettingsNavigationLinks({ pathname }: { pathname: string }) {
  return (
    <Sidebar.Root
      aria-label="Settings"
      className="grow border-r-0 bg-transparent"
    >
      <Sidebar.Section label="Settings">
        {settingsDestinations.map((item) => (
          <Sidebar.Item
            active={isNavigationItemCurrent(pathname, item.href)}
            icon={item.icon}
            key={item.href}
            render={<NextLink href={item.href} />}
          >
            {item.label}
          </Sidebar.Item>
        ))}
      </Sidebar.Section>
    </Sidebar.Root>
  );
}

export function SettingsNavigation() {
  return <SettingsNavigationLinks pathname={usePathname()} />;
}
