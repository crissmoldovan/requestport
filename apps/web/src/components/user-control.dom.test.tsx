import { ThemeProvider } from "@cueplusplus/ui/system";
import type { AppearanceSnapshot } from "@requestport/domain/browser";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

const account = vi.hoisted(() => ({ signOut: vi.fn(async () => {}) }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/requests",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@requestport/auth/client", () => ({
  authClient: { signOut: account.signOut },
}));

import type { AppearanceActionState } from "../app/(app)/settings/appearance/action-state.js";
import {
  APPEARANCE_RENDER_CONTEXT_ENDPOINT,
  appearanceRenderContextExpiryMarginSeconds,
  appearanceRenderContextTtlSeconds,
  appearanceRenderContextUsable,
} from "../lib/appearance-context-mint.js";
import { UserControl } from "./user-control.js";

const assign = vi.fn();
const send = vi.fn();

/**
 * A render context of the real shape, issued at `issuedAt`.
 *
 * The signature is not sealed, because the panel never checks one: the server
 * verifies the token and only the server does. What the panel reads is the
 * unauthenticated issue time, which is the one thing it can decide on its own —
 * whether the submission it is about to make has already expired.
 */
function context(issuedAt: number) {
  const payload = btoa(
    JSON.stringify({ a: "actor", o: null, t: Math.floor(issuedAt / 1_000) }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

  return `v1.${payload}.c2lnbmF0dXJl`;
}

/** Older than the fifteen minutes a rendered form stays submittable for. */
const outlived = () => context(Date.now() - 1_000_000);
const appearanceAction = vi.fn(
  async (
    _previous: AppearanceActionState,
    _formData: FormData,
  ): Promise<AppearanceActionState> => ({
    message:
      "Appearance changed in another session. Reload the page and try again.",
    status: "version_conflict",
  }),
);

/** The `renderContext` the appearance form last submitted. */
function submittedContext() {
  const data = appearanceAction.mock.calls.at(-1)?.[1];
  if (!data) throw new Error("the appearance action was never invoked");

  return data.get("renderContext");
}

function mintResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => {
  vi.useRealTimers();
  account.signOut.mockClear();
  assign.mockReset();
  send.mockReset();
  appearanceAction.mockClear();
  vi.unstubAllGlobals();
});

const snapshot: AppearanceSnapshot = {
  effective: {
    density: "normal",
    font: "match",
    look: "match",
    mode: "dark",
    paint: "match",
    source: {
      density: "organization",
      font: "organization",
      look: "organization",
      mode: "organization",
      paint: "organization",
      theme: "organization",
    },
    theme: "cue",
  },
  organization: {
    density: "normal",
    font: "match",
    look: "match",
    mode: "dark",
    paint: "match",
    theme: "cue",
    version: 3,
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

function menuTree(
  action?: typeof appearanceAction,
  contextToken: string = context(Date.now()),
  overrides: { canEditOrganizationDefaults?: boolean } = {},
) {
  return (
    <ThemeProvider
      density={snapshot.effective.density}
      mode={snapshot.effective.mode}
      persistPreferences={false}
      theme={snapshot.effective.theme}
    >
      <UserControl
        appearance={{
          action,
          canEditOrganizationDefaults:
            overrides.canEditOrganizationDefaults ?? false,
          contextToken,
          idempotencyNonce: "6f1c2f1e-0000-4000-8000-000000000001",
          organizationName: "CUE++",
          snapshot,
        }}
        email="owner@example.com"
        name="Ada Lovelace"
      />
    </ThemeProvider>
  );
}

/**
 * Render the menu, and keep the ability to hand it a different token later.
 *
 * `contextToken` is a prop the panel reads rather than keys on, and the effect
 * that schedules expiry depends on it, so replacing it reschedules the deadline
 * instead of resetting the panel. That is what lets a test start the clock
 * *after* the panel is open — see the expiry test for why that matters.
 */
function renderMenu(
  action?: typeof appearanceAction,
  contextToken: string = context(Date.now()),
  overrides: { canEditOrganizationDefaults?: boolean } = {},
) {
  const result = render(menuTree(action, contextToken, overrides));

  return {
    ...result,
    withToken: (next: string) =>
      result.rerender(menuTree(action, next, overrides)),
  };
}

/** Choose a theme, which is also what makes the panel's Apply appear. */
async function chooseThemeInMenu(user: ReturnType<typeof userEvent.setup>) {
  // Found rather than got: a panel whose token has outlived itself renders a
  // retry in place of the controls, and they arrive only once a mint answers.
  await user.click(await screen.findByRole("combobox", { name: "Theme" }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: "Terminal" }));
}

async function openMenuAndPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
  );
  await screen.findByRole("dialog");

  await user.click(screen.getByRole("combobox", { name: "Theme" }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: "Terminal" }));

  await waitFor(() => {
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "terminal",
    );
  });
}

describe("user menu appearance panel", () => {
  test("opens the account menu with the compact appearance panel", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );

    const menu = await screen.findByRole("dialog");

    expect(menu.closest("[data-cue-portal]")).not.toBeNull();
    expect(within(menu).getByText("owner@example.com")).toBeInTheDocument();
    expect(
      within(menu).getByRole("combobox", { name: "Theme" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("link", { name: "Appearance settings" }),
    ).toHaveAttribute("href", "/settings/appearance");
    expect(
      within(menu).getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  test("restores the confirmed triple when Escape dismisses the menu", async () => {
    const user = userEvent.setup();
    renderMenu();

    await openMenuAndPreview(user);
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("cue");
    });
  });

  test("restores the confirmed triple when the menu is dismissed by an outside press", async () => {
    const user = userEvent.setup();
    renderMenu();

    await openMenuAndPreview(user);
    await user.click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("cue");
    });
  });

  test("reopens with the confirmed values rather than the discarded draft", async () => {
    const user = userEvent.setup();
    renderMenu();

    await openMenuAndPreview(user);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );
    const menu = await screen.findByRole("dialog");

    expect(
      within(menu).getByRole("combobox", { name: "Theme" }),
    ).toHaveTextContent("Organization default");
  });
});

/**
 * The panel names the organization default and offers no route to it.
 *
 * *Use organization defaults* (once *Reset to organization defaults*) implies
 * those defaults exist; nothing said
 * they were the viewer's to change, or that the link below the panel is where
 * that happens. An owner who changed a theme here and looked for a way to make
 * it everyone's found a button that resets *to* the default and nothing that
 * sets it.
 *
 * A member's link is unchanged, because for a member it is accurate.
 */
/**
 * The panel names the organization default and offered no route to it.
 *
 * *Use organization defaults* (once *Reset to organization defaults*) implies
 * those defaults exist; nothing said
 * they were the viewer's to change, or that the link below is where that
 * happens. An owner who changed a theme here and looked for a way to make it
 * everyone's found a button that resets *to* the default and nothing that sets
 * it.
 *
 * The first attempt at this put the answer in the link's own text, which was
 * the wrong shape and the browser lanes said so: `clientRouteLabel` reaches
 * `/settings/appearance` by clicking that link by its exact accessible name, so
 * a name that changed with the viewer's role broke the route entirely for
 * owners. A navigation link's name is a stable address — for a selector, for
 * muscle memory, for anything written down. The information belongs beside it.
 */
describe("what the account menu says about organization defaults", () => {
  test("keeps the link's name the same for everyone", async () => {
    for (const canEditOrganizationDefaults of [true, false]) {
      const view = renderMenu(appearanceAction, context(Date.now()), {
        canEditOrganizationDefaults,
      });

      await userEvent.setup().click(
        screen.getByRole("button", {
          name: "Open user menu for Ada Lovelace",
        }),
      );
      const menu = await screen.findByRole("dialog");

      expect(
        within(menu).getByRole("link", { name: "Appearance settings" }),
      ).toHaveAttribute("href", "/settings/appearance");

      view.unmount();
    }
  });

  test("tells an owner the defaults are theirs to change, beside the link", async () => {
    renderMenu(appearanceAction, context(Date.now()), {
      canEditOrganizationDefaults: true,
    });

    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
      );
    const menu = await screen.findByRole("dialog");

    // The apostrophe the reader sees is typographic, so the expectation carries
    // that character rather than the one a keyboard types.
    expect(menu).toHaveTextContent(
      "The organization’s defaults are set there too.",
    );
  });

  test("says nothing of the kind to a member", async () => {
    renderMenu(appearanceAction, context(Date.now()), {
      canEditOrganizationDefaults: false,
    });

    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
      );
    const menu = await screen.findByRole("dialog");

    expect(menu).not.toHaveTextContent("defaults are set there too");
  });
});

describe("account menu render context", () => {
  /**
   * The account menu lives in the shared layout, so its render-context token
   * was minted once per *tab* and then aged across every soft navigation. After
   * fifteen minutes of ordinary rail-link browsing the first Apply came back
   * `context_conflict` — "reload the page and try again" — from a control whose
   * whole point is not having to.
   *
   * Opening the panel is when the form reaches the reader's hand, so that is
   * when the context it records is minted. The token still binds the actor the
   * form was rendered for; only the moment it names moves.
   */
  test("mints a fresh context when the panel opens and submits that one", async () => {
    const user = userEvent.setup();
    send.mockResolvedValue(mintResponse({ token: "v1.fresh.context" }));
    vi.stubGlobal("fetch", send);
    renderMenu(appearanceAction);

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );
    const menu = await screen.findByRole("dialog");

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0] as unknown as [string])[0]).toBe(
      APPEARANCE_RENDER_CONTEXT_ENDPOINT,
    );

    // Something has to have changed before there is anything to apply.
    await chooseThemeInMenu(user);
    await user.click(within(menu).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(appearanceAction).toHaveBeenCalledTimes(1));
    expect(submittedContext()).toBe("v1.fresh.context");
  });

  test("keeps the rendered token when the mint cannot answer", async () => {
    const user = userEvent.setup();
    const rendered = context(Date.now());
    send.mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", send);
    renderMenu(appearanceAction, rendered);

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );
    const menu = await screen.findByRole("dialog");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    await chooseThemeInMenu(user);
    await user.click(within(menu).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(appearanceAction).toHaveBeenCalledTimes(1));
    expect(submittedContext()).toBe(rendered);
  });

  /**
   * The journey the mint exists for, run to the end.
   *
   * A tab left open past the fifteen minutes holds a token the server is
   * already certain to refuse. Rendering the form with it and swapping only
   * when the mint answers left the whole failure intact whenever the mint was
   * slow or errored: `null` means "keep the token you have", and the token this
   * reader has is the expired one. So the panel does not offer a submission it
   * knows cannot be accepted, and the reader is given the way out — which is a
   * mint, not the page reload this control exists to avoid.
   */
  test("never spends a token the tab has already outlived", async () => {
    const user = userEvent.setup();
    send.mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", send);
    renderMenu(appearanceAction, outlived());

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );
    const menu = await screen.findByRole("dialog");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(
        within(menu).getByRole("button", { name: "Try again" }),
      ).toBeEnabled(),
    );
    expect(within(menu).queryByRole("button", { name: "Apply" })).toBeNull();
    expect(appearanceAction).not.toHaveBeenCalled();
  });

  /**
   * The other half of the same journey.
   *
   * "Already expired when the panel opened" was closed by reading the issue
   * time during render. But `ready` is only ever computed while React renders,
   * and a panel nobody touches does not render again — so a token that crossed
   * the margin *while the panel sat open* was still handed to Apply verbatim,
   * and the reader got back the `context_conflict` the whole control exists to
   * avoid. Nothing polls: the panel knows exactly when the token it is offering
   * stops being worth spending, so it waits until then and not a moment more.
   */
  test("stops offering a token that expires while the panel sits open", async () => {
    const user = userEvent.setup();
    send.mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", send);
    // Real time, because the panel's own deadline is the thing under test and a
    // mocked clock would only prove the mock.
    //
    // The deadline starts *after* the panel is open, and that is the whole
    // difference between this test and the one that used to flake here. It
    // opened with a token already two and a half seconds from spending, so that
    // budget had to cover opening the menu, choosing a theme and finding Apply.
    // Under load those interactions take longer than the budget, Apply is gone
    // before the assertion looks, and the failure reads `Unable to find
    // role="button" and name "Apply"` — a slow machine, reported as a broken
    // panel. `gotchas.md` carried it as a load flake for exactly that reason.
    //
    // Opening on a full-life token removes the setup from the budget. Nothing
    // about the behaviour under test is softened: the token below is still
    // usable when it is handed over, the panel still sits untouched, and the
    // deadline it then passes is a real one.
    const { withToken } = renderMenu(appearanceAction, context(Date.now()));

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );
    const menu = await screen.findByRole("dialog");
    // Apply appears for two reasons now — a usable token and something to save.
    // This test is about the first, so the second is arranged deliberately
    // rather than inherited from a pristine form.
    await chooseThemeInMenu(user);
    expect(
      await within(menu).findByRole("button", { name: "Apply" }),
    ).toBeEnabled();

    // Now, with the panel open and Apply proven present, hand it a token that
    // is live but nearly spent. The effect that schedules expiry depends on the
    // token, so this reschedules the deadline rather than resetting the panel.
    const nearly = context(
      Date.now() -
        (appearanceRenderContextTtlSeconds -
          appearanceRenderContextExpiryMarginSeconds) *
          1_000 +
        2_500,
    );
    expect(appearanceRenderContextUsable(nearly)).toBe(true);
    withToken(nearly);
    // Still offered the moment it arrives: what follows is the deadline passing
    // while nobody touches the panel, not a token that was already spent.
    expect(within(menu).getByRole("button", { name: "Apply" })).toBeEnabled();

    await waitFor(
      () =>
        expect(
          within(menu).queryByRole("button", { name: "Apply" }),
        ).toBeNull(),
      { timeout: 15_000 },
    );

    expect(
      within(menu).getByRole("button", { name: "Try again" }),
    ).toBeEnabled();
    expect(appearanceAction).not.toHaveBeenCalled();
  }, 30_000);

  test("gives an old tab a working control once a retry mints", async () => {
    const user = userEvent.setup();
    send
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(mintResponse({ token: "v1.fresh.context" }));
    vi.stubGlobal("fetch", send);
    renderMenu(appearanceAction, outlived());

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );
    const menu = await screen.findByRole("dialog");
    const retry = await within(menu).findByRole("button", {
      name: "Try again",
    });
    await waitFor(() => expect(retry).toBeEnabled());

    await user.click(retry);

    // The retry restores a usable token; a change is what makes Apply appear.
    await chooseThemeInMenu(user);
    const apply = await within(menu).findByRole("button", { name: "Apply" });
    await user.click(apply);

    await waitFor(() => expect(appearanceAction).toHaveBeenCalledTimes(1));
    expect(submittedContext()).toBe("v1.fresh.context");
  });

  test("mints again on every open, not once per document", async () => {
    const user = userEvent.setup();
    send.mockResolvedValue(mintResponse({ token: "v1.fresh.context" }));
    vi.stubGlobal("fetch", send);
    renderMenu(appearanceAction);

    const trigger = screen.getByRole("button", {
      name: "Open user menu for Ada Lovelace",
    });
    await user.click(trigger);
    await screen.findByRole("dialog");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(trigger);
    await screen.findByRole("dialog");

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });
});

describe("account menu sign-out", () => {
  test("ends the session and leaves through a full-document navigation", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "http://localhost/requests" },
    });
    const user = userEvent.setup();
    renderMenu();

    await user.click(
      screen.getByRole("button", { name: "Open user menu for Ada Lovelace" }),
    );
    const menu = await screen.findByRole("dialog");
    await user.click(within(menu).getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(account.signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/sign-in"));
  });

  test("names the account on the trigger without printing it in the bar", () => {
    renderMenu();

    const trigger = screen.getByRole("button", {
      name: "Open user menu for Ada Lovelace",
    });

    expect(trigger).toHaveTextContent("AL");
    expect(trigger.textContent).not.toContain("owner@example.com");
  });
});
