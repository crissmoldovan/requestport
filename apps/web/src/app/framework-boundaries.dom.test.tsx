import { Dialog } from "@cueplusplus/ui/overlays";
import { Button } from "@cueplusplus/ui/primitives";
import { DEFAULT_STORAGE_KEY, ThemeProvider } from "@cueplusplus/ui/system";
import {
  appearanceFallback,
  appearanceThemes,
} from "@requestport/domain/browser";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const generated = vi.hoisted(() => ({
  sansVariable: "__variable_geist_sans_1f2e3d",
  sansFamily: "__Geist_1f2e3d, __Geist_Fallback_1f2e3d, sans-serif",
  monoVariable: "__variable_geist_mono_4c5b6a",
  monoFamily:
    "__Geist_Mono_4c5b6a, __Geist_Mono_Fallback_4c5b6a, ui-monospace, monospace",
}));

vi.mock("geist/font/sans", () => ({
  GeistSans: {
    variable: generated.sansVariable,
    className: "geist-sans",
    style: { fontFamily: generated.sansFamily },
  },
}));

vi.mock("geist/font/mono", () => ({
  GeistMono: {
    variable: generated.monoVariable,
    className: "geist-mono",
    style: { fontFamily: generated.monoFamily },
  },
}));

/** A stored triple that shares no axis with the RequestPort fallback. */
const staleStoredPreferences = {
  theme: "terminal",
  density: "large",
  mode: "dark",
} as const;

const jsdomStorageDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

function installThrowingStorage() {
  const calls = { reads: 0, writes: 0 };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      length: 0,
      clear() {
        throw new Error("storage-unavailable");
      },
      getItem() {
        calls.reads += 1;
        throw new Error("storage-unavailable");
      },
      key() {
        throw new Error("storage-unavailable");
      },
      removeItem() {
        throw new Error("storage-unavailable");
      },
      setItem() {
        calls.writes += 1;
        throw new Error("storage-unavailable");
      },
    } satisfies Storage,
  });
  return calls;
}

async function renderGlobalError() {
  const { default: GlobalError } = await import("./global-error.js");
  return render(
    <GlobalError
      error={Object.assign(
        new Error("global-error-sentinel-must-never-render"),
        {
          digest: "6f6e6c79",
        },
      )}
      reset={() => {}}
      retry={() => {}}
    />,
    { container: document.documentElement, baseElement: document.body },
  );
}

function cueRoot() {
  const root = document.querySelector("[data-cue-root]");
  if (!(root instanceof HTMLElement)) throw new Error("provider root missing");
  return root;
}

beforeEach(() => {
  window.localStorage.setItem(
    DEFAULT_STORAGE_KEY,
    JSON.stringify(staleStoredPreferences),
  );
});

afterEach(() => {
  if (jsdomStorageDescriptor) {
    Object.defineProperty(window, "localStorage", jsdomStorageDescriptor);
  }
  window.localStorage.clear();
  for (const attribute of ["data-cue-root", "data-theme"]) {
    for (const stray of document.querySelectorAll(`body[${attribute}]`)) {
      stray.removeAttribute(attribute);
    }
  }
});

describe("provider-as-body hydration", () => {
  test("stamps the real document body and ignores the stale mirror", async () => {
    const { AppearanceRoot } = await import("./appearance-root.js");

    render(
      <AppearanceRoot
        appearance={{ theme: "terminal", density: "normal", mode: "light" }}
        nonce={undefined}
      >
        <p>Overview</p>
      </AppearanceRoot>,
      { container: document.documentElement, baseElement: document.body },
    );

    const body = cueRoot();

    expect(body.tagName).toBe("BODY");
    expect(body.getAttribute("data-theme")).toBe("terminal");
    expect(body.getAttribute("data-density")).toBe("normal");
    expect(body.getAttribute("data-mode")).toBe("light");
    expect(body.style.getPropertyValue("--cue-font-sans")).toBe(
      generated.sansFamily,
    );
    expect(body.style.getPropertyValue("--cue-font-mono")).toBe(
      generated.monoFamily,
    );
    expect(body.style.colorScheme).toBe("light");
    expect(body.textContent).toContain("Overview");
    // The mirror is never read back: the stale triple survives untouched.
    expect(window.localStorage.getItem(DEFAULT_STORAGE_KEY)).toBe(
      JSON.stringify(staleStoredPreferences),
    );
  });

  test("republishes the same loaded families on a real portal after hydration", async () => {
    const user = userEvent.setup();

    render(
      <ThemeProvider
        density="normal"
        fontFamilies={{
          sans: generated.sansFamily,
          mono: generated.monoFamily,
        }}
        mode="light"
        persistPreferences={false}
        theme="terminal"
      >
        <Dialog.Root>
          <Dialog.Trigger render={<Button>Open appearance</Button>} />
          <Dialog.Content>
            <Dialog.Title>Appearance</Dialog.Title>
          </Dialog.Content>
        </Dialog.Root>
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Open appearance" }));

    const portal = (await screen.findByRole("dialog")).closest(
      "[data-cue-portal]",
    );

    expect(portal).toBeInstanceOf(HTMLElement);
    const portalElement = portal as HTMLElement;
    expect(portalElement.getAttribute("data-theme")).toBe("terminal");
    expect(portalElement.getAttribute("data-density")).toBe("normal");
    expect(portalElement.getAttribute("data-mode")).toBe("light");
    expect(portalElement.style.getPropertyValue("--cue-font-sans")).toBe(
      generated.sansFamily,
    );
    expect(portalElement.style.getPropertyValue("--cue-font-mono")).toBe(
      generated.monoFamily,
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test.each(appearanceThemes)(
    "keeps typography provider-owned and colour-only under the %s theme",
    async (theme) => {
      const user = userEvent.setup();

      render(
        <ThemeProvider
          density="ultra-compact"
          fontFamilies={{
            sans: generated.sansFamily,
            mono: generated.monoFamily,
          }}
          mode="system"
          persistPreferences={false}
          theme={theme}
        >
          <Dialog.Root>
            <Dialog.Trigger render={<Button>Open appearance</Button>} />
            <Dialog.Content>
              <Dialog.Title>Appearance</Dialog.Title>
            </Dialog.Content>
          </Dialog.Root>
        </ThemeProvider>,
      );

      const root = cueRoot();
      await user.click(screen.getByRole("button", { name: "Open appearance" }));
      const portal = (await screen.findByRole("dialog")).closest(
        "[data-cue-portal]",
      ) as HTMLElement;

      for (const element of [root, portal]) {
        expect(element.getAttribute("data-theme")).toBe(theme);
        expect(element.style.getPropertyValue("--cue-font-sans")).toBe(
          generated.sansFamily,
        );
        expect(element.style.getPropertyValue("--cue-font-mono")).toBe(
          generated.monoFamily,
        );
      }

      cleanup();
    },
  );
});

describe("global error boundary in the browser", () => {
  test("ignores a stale valid stored triple", async () => {
    await renderGlobalError();

    const root = cueRoot();

    expect(root.getAttribute("data-theme")).toBe(appearanceFallback.theme);
    expect(root.getAttribute("data-density")).toBe(appearanceFallback.density);
    expect(root.getAttribute("data-mode")).toBe(appearanceFallback.mode);
  });

  test("ignores a malformed stored value without failing to render", async () => {
    window.localStorage.setItem(DEFAULT_STORAGE_KEY, "{not-json");

    await renderGlobalError();

    expect(cueRoot().getAttribute("data-theme")).toBe(appearanceFallback.theme);
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  test("never touches storage even when every operation throws", async () => {
    const calls = installThrowingStorage();

    await renderGlobalError();

    expect(cueRoot().getAttribute("data-theme")).toBe(appearanceFallback.theme);
    expect(cueRoot().getAttribute("data-density")).toBe(
      appearanceFallback.density,
    );
    expect(cueRoot().getAttribute("data-mode")).toBe(appearanceFallback.mode);
    expect(calls).toEqual({ reads: 0, writes: 0 });
  });

  test("renders identically under both emulated OS colour schemes", async () => {
    for (const light of [false, true]) {
      vi.stubGlobal("matchMedia", (media: string) => ({
        matches: light && media.includes("light"),
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }));

      const view = await renderGlobalError();
      const root = cueRoot();

      expect(root.getAttribute("data-mode")).toBe(appearanceFallback.mode);
      expect(root.style.colorScheme).toBe("light dark");
      expect(view.getByText("Something went wrong")).toBeInTheDocument();
      cleanup();
    }
  });

  test("recovers through the reset action without leaking the thrown detail", async () => {
    const user = userEvent.setup();
    let retried = 0;
    const { default: GlobalError } = await import("./global-error.js");

    render(
      <GlobalError
        error={new Error("global-error-sentinel-must-never-render")}
        reset={() => {}}
        retry={() => {
          retried += 1;
        }}
      />,
      { container: document.documentElement, baseElement: document.body },
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(retried).toBe(1);
    expect(document.body.textContent).not.toContain(
      "global-error-sentinel-must-never-render",
    );
  });
});

/** The three segment error boundaries that render inside the root document. */
const segmentErrorBoundaries = [
  ["(app)", () => import("./(app)/error.js")],
  ["(auth)", () => import("./(auth)/error.js")],
  ["root", () => import("./error.js")],
] as const;

describe("segment error boundaries in the browser", () => {
  test.each(segmentErrorBoundaries)(
    "%s recovers through its reset control without leaking the thrown detail",
    async (_segment, load) => {
      const user = userEvent.setup();
      let reset = 0;
      const { default: Boundary } = await load();

      render(
        <ThemeProvider persistPreferences={false} theme="requestport">
          <Boundary
            error={Object.assign(
              new Error("boundary-sentinel-must-never-render"),
              { digest: "6f6e6c79" },
            )}
            reset={() => {
              reset += 1;
            }}
          />
        </ThemeProvider>,
      );

      await user.click(screen.getByRole("button", { name: "Try again" }));

      expect(reset).toBe(1);
      expect(document.body.textContent).not.toContain(
        "boundary-sentinel-must-never-render",
      );
      expect(document.body.textContent).not.toContain("6f6e6c79");
      cleanup();
    },
  );
});

describe("the nonce Base UI's own style elements need", () => {
  afterEach(() => {
    cleanup();
    document.head.replaceChildren();
  });

  /*
   * The refusal the acceptance suite tolerated, reproduced at its source.
   *
   * `@base-ui/react` renders one style element: a hoisted `<style precedence>`
   * hiding the scrollbar, whose content hashes to exactly the value Chromium
   * named in `style-src-elem`. `ScrollAreaRoot` and `SelectPopup` pass it a
   * nonce they read from `CSPContext`, and nothing supplied that context here —
   * so it shipped unnonced and the policy refused it, on every authenticated
   * page, because `app-shell` renders a Select in the organisation switcher.
   *
   * Asserted on the element rather than on the provider: a test that only
   * checked a provider was rendered would pass with the nonce wired to nothing.
   */
  test("carries the request nonce onto Base UI's scrollbar style", async () => {
    const { AppearanceRoot } = await import("./appearance-root.js");
    const { ScrollArea } = await import("@base-ui/react/scroll-area");

    render(
      <AppearanceRoot
        appearance={{ theme: "terminal", density: "normal", mode: "light" }}
        nonce="nonce-under-test"
      >
        <ScrollArea.Root>
          <ScrollArea.Viewport>scrollable</ScrollArea.Viewport>
        </ScrollArea.Root>
      </AppearanceRoot>,
      { container: document.documentElement, baseElement: document.body },
    );

    const style = [...document.querySelectorAll("style")].find((element) =>
      element.textContent?.includes("base-ui-disable-scrollbar"),
    );

    expect(
      style,
      "Base UI must have rendered its scrollbar style",
    ).toBeTruthy();
    expect(style?.getAttribute("nonce") ?? style?.nonce).toBe(
      "nonce-under-test",
    );
  });
});
