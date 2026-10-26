import { useToast } from "@cueplusplus/ui/overlays";
import { Button } from "@cueplusplus/ui/primitives";
import { ThemeProvider } from "@cueplusplus/ui/system";
import type { AppearanceSnapshot } from "@requestport/domain/browser";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AppShell } from "./app-shell.js";
import { navigationDestinations } from "./primary-navigation.js";

/**
 * The route, as a value the suite can move.
 *
 * The shell resets its drawer when the path changes, and a mock that answers
 * one constant forever can never exercise that: the reset is keyed on a
 * *change*, so a test needs a second render at a second path. `vi.hoisted`
 * keeps the holder alive above the hoisted `vi.mock` factory.
 */
const navigation = vi.hoisted(() => ({ pathname: "/requests" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@requestport/auth/client", () => ({
  authClient: { signOut: async () => {} },
}));

const snapshot: AppearanceSnapshot = {
  effective: {
    density: "ultra-compact",
    font: "match",
    look: "match",
    mode: "system",
    paint: "match",
    source: {
      density: "fallback",
      font: "fallback",
      look: "fallback",
      mode: "fallback",
      paint: "fallback",
      theme: "fallback",
    },
    theme: "requestport",
  },
  organization: {
    density: "ultra-compact",
    font: "match",
    look: "match",
    mode: "system",
    paint: "match",
    theme: "requestport",
    version: 0,
  },
  user: {
    density: null,
    font: null,
    look: null,
    mode: null,
    paint: null,
    theme: null,
    version: 0,
  },
};

const organization = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "CUE++",
  role: "owner",
  slug: "example-org",
} as const;

function shellElement(page: ReactNode = <h1>Requests</h1>) {
  return (
    <ThemeProvider
      density={snapshot.effective.density}
      mode={snapshot.effective.mode}
      persistPreferences={false}
      theme={snapshot.effective.theme}
    >
      <AppShell
        appearance={{
          canEditOrganizationDefaults: false,
          contextToken: "v1.render.context",
          idempotencyNonce: "6f1c2f1e-0000-4000-8000-000000000001",
          organizationName: organization.name,
          snapshot,
        }}
        currentOrganization={organization}
        organizations={[organization]}
        user={{ email: "owner@example.com", image: null, name: "Owner" }}
      >
        {page}
      </AppShell>
    </ThemeProvider>
  );
}

function renderShell() {
  return render(shellElement());
}

function navTrigger() {
  return screen.getByRole("button", { name: "Open navigation" });
}

// The route is shared mutable state, so it is restored between tests rather
// than at the end of the one test that moves it: a failure there would
// otherwise leak a path into every suite that runs after it.
afterEach(() => {
  navigation.pathname = "/requests";
});

describe("responsive navigation drawer", () => {
  test("opens the native drawer from the bar trigger and traps focus inside it", async () => {
    const user = userEvent.setup();
    renderShell();

    const trigger = navTrigger();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    const drawer = await screen.findByRole("dialog");

    expect(drawer.closest("[data-cue-portal]")).not.toBeNull();
    // The trigger is outside the trap now, so it is addressed by the reference
    // taken before the drawer hid the rest of the document from assistive
    // technology — which is itself the focus trap being real.
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(navTrigger).toThrow();
    expect(within(drawer).getByText("Navigation")).toBeInTheDocument();
    expect(
      within(drawer).getByRole("link", { name: "Questions" }),
    ).toHaveAttribute("href", "/questions");
    // The drawer carries the same three sections as the column, Settings
    // included.
    for (const caption of ["Work", "Connect", "Organization"]) {
      expect(within(drawer).getByText(caption)).toBeInTheDocument();
    }
    expect(
      within(drawer).getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("href", "/settings/organization");
    await waitFor(() =>
      expect(drawer.contains(document.activeElement)).toBe(true),
    );
  });

  test("closes on Escape and returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(navTrigger());
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(navTrigger()).toHaveFocus());
  });

  test("closes on an outside press and restores the closed announcement", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(navTrigger());
    await screen.findByRole("dialog");
    await user.click(document.body);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(navTrigger()).toHaveAttribute("aria-expanded", "false");
  });

  test("dismisses through the drawer's own close control", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(navTrigger());
    const drawer = await screen.findByRole("dialog");

    await user.click(
      within(drawer).getByRole("button", { name: "Close navigation" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("closes itself on the navigation it caused", async () => {
    // The drawer is a modal dialog and a client-side navigation does not
    // unmount it, so following a destination on a narrow viewport used to leave
    // the workspace map open *over* the page it had just opened — with the rest
    // of the document hidden from assistive technology behind it. The reset is
    // keyed on the path changing, which is why this suite has to move it.
    const user = userEvent.setup();
    const { rerender } = renderShell();

    await user.click(navTrigger());
    await screen.findByRole("dialog");

    navigation.pathname = "/questions";
    rerender(shellElement());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(navTrigger()).toHaveAttribute("aria-expanded", "false");

    // Re-rendering at the same path leaves a reopened drawer alone: the reset
    // answers a navigation, not every render that follows one.
    await user.click(navTrigger());
    await screen.findByRole("dialog");
    rerender(shellElement());
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});

describe("the bar's actions", () => {
  test("holds the switcher, the search entry and the account menu in one banner, and no New request", () => {
    renderShell();

    const banner = screen.getByRole("banner");

    expect(
      within(banner).getByRole("link", { name: "RequestPort overview" }),
    ).toHaveAttribute("href", "/");
    expect(
      within(banner).getByRole("combobox", { name: "Current organization" }),
    ).toBeInTheDocument();
    expect(
      within(banner).getByRole("link", { name: /^Search or run a command/u }),
    ).toHaveAttribute("href", "/search");
    expect(
      within(banner).getByRole("button", { name: "Open user menu for Owner" }),
    ).toBeInTheDocument();
    // Ruling 256: New request stays in the Requests page's header.
    expect(screen.queryByRole("link", { name: "New request" })).toBeNull();
  });

  test("names the search control with the label it shows", () => {
    // WCAG 2.5.3: the accessible name has to contain the visible label, because
    // that is the string a speech-input user will say. The control keeps its
    // icon and drops its label below the shell's breakpoint, so the label lives
    // in `aria-label` — and it has to be the label, ellipsis included, rather
    // than a tidied-up paraphrase of it.
    renderShell();

    const search = screen.getByRole("link", {
      name: /^Search or run a command/u,
    });
    const visible = "Search or run a command…";

    expect(search.textContent).toContain(visible);
    expect(search.getAttribute("aria-label")).toContain(visible);
    expect(search).toHaveAccessibleName(expect.stringContaining(visible));
  });
});

/**
 * Everything a Tab press reaches, in the order it reaches it.
 *
 * The sequence is walked rather than sampled, because a single press proves
 * nothing about the rest of the order — and it stops on two conditions that a
 * single press cannot tell apart. Focus landing on `document.body` is jsdom's
 * fallback for *nothing focused*, which is exactly why asserting that
 * `activeElement` is merely not null holds no matter what the tab order is;
 * focus returning to something already reached is the order having wrapped.
 */
async function tabOrder(
  user: ReturnType<typeof userEvent.setup>,
  limit: number,
): Promise<HTMLElement[]> {
  const reached: HTMLElement[] = [];

  for (let step = 0; step < limit; step += 1) {
    await user.tab();
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!active || active === document.body) break;
    if (reached.includes(active)) break;
    reached.push(active);
  }

  return reached;
}

describe("desktop navigation column", () => {
  test("marks the current destination once and reaches every link by keyboard", async () => {
    const user = userEvent.setup();
    renderShell();

    const column = screen.getByRole("navigation", { name: "Primary" });
    const current = within(column).getAllByRole("link", { current: "page" });

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "/requests");

    // The column draws the whole map, so "every link" is the map rather than a
    // number this file would have to keep in step with it.
    const links = within(column).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      navigationDestinations.map((item) => item.href),
    );

    // Walked far enough to pass the column twice over, so a link reached only
    // after the order wrapped is not counted as reached.
    const reached = await tabOrder(user, links.length * 4);

    expect(reached.filter((element) => links.includes(element))).toEqual(links);
  });

  test("collapses and expands the column through the native rail", async () => {
    const user = userEvent.setup();
    renderShell();

    const rail = screen.getByRole("button", { name: "Collapse sidebar" });

    expect(rail).toHaveAttribute("aria-expanded", "true");

    await user.click(rail);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Expand sidebar" }),
      ).toHaveAttribute("aria-expanded", "false"),
    );
  });
});

/** A page that raises a toast, as a settings control does when a write lands. */
function PageRaisingToast() {
  const toast = useToast();
  return (
    <Button
      onClick={() => toast.add({ title: "Invitation revoked.", tone: "ok" })}
      type="button"
    >
      Revoke
    </Button>
  );
}

describe("the console's toasts (ruling 260)", () => {
  test("keep a toast a page raised on screen after that page is replaced, as a redirect or a revalidation replaces it", async () => {
    const user = userEvent.setup();
    navigation.pathname = "/settings/members";
    const { rerender } = render(shellElement(<PageRaisingToast />));

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    // The page goes, as it does when the write redirects elsewhere or its row
    // leaves on revalidation; the shell, and the toast it holds, stay.
    navigation.pathname = "/settings/projects";
    rerender(shellElement(<h1>Projects</h1>));

    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    const viewports = screen.getAllByRole("region", { name: "Notifications" });
    expect(viewports).toHaveLength(1);
    expect(
      await within(viewports[0] as HTMLElement).findByText(
        "Invitation revoked.",
      ),
    ).toBeVisible();
  });
});
