import { Dialog } from "@cueplusplus/ui/overlays";
import { Button } from "@cueplusplus/ui/primitives";
import {
  DEFAULT_STORAGE_KEY,
  prepaintScript,
  ThemeProvider,
} from "@cueplusplus/ui/system";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";

const fallbackTheme = "requestport";
const fallbackDensity = "ultra-compact";
const fallbackMode = "system";

const geistSans = "__Geist_1a2b3c, __Geist_Fallback_1a2b3c, sans-serif";
const geistMono =
  "__Geist_Mono_1a2b3c, __Geist_Mono_Fallback_1a2b3c, monospace";

type StorageCalls = { reads: number; writes: number };

/**
 * A triple that shares no axis with the RequestPort fallback, standing in for
 * a user who once changed appearance through the dialog. Every axis differing
 * is what makes the `persistPreferences` assertions falsifiable: a provider
 * that reads storage stamps all three of these instead of the server's.
 */
const storedPreferences = {
  theme: "terminal",
  density: "large",
  mode: "dark",
} as const;

const jsdomStorageDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

/** Seed the CUE++ preference key and return the exact bytes written. */
function seedStoredPreferences(): string {
  const raw = JSON.stringify(storedPreferences);
  window.localStorage.setItem(DEFAULT_STORAGE_KEY, raw);
  return raw;
}

/**
 * Replace `window.localStorage` with an implementation whose every operation
 * throws, the way a locked-down or private-mode browser behaves. The
 * authoritative server triple must survive it untouched.
 */
function installThrowingStorage(): StorageCalls {
  const calls: StorageCalls = { reads: 0, writes: 0 };
  const throwing: Storage = {
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
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: throwing,
  });

  return calls;
}

afterEach(() => {
  if (jsdomStorageDescriptor) {
    Object.defineProperty(window, "localStorage", jsdomStorageDescriptor);
  }

  window.localStorage.clear();
});

describe("CUE++ provider stamps the authoritative RequestPort triple", () => {
  test("overrides a stored triple instead of restoring it", () => {
    const seeded = seedStoredPreferences();

    render(
      <ThemeProvider
        theme={fallbackTheme}
        density={fallbackDensity}
        mode={fallbackMode}
        fontFamilies={{ sans: geistSans, mono: geistMono }}
        persistPreferences={false}
      >
        <p>authoritative</p>
      </ThemeProvider>,
    );

    const root = document.querySelector("[data-cue-root]");

    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-theme")).toBe(fallbackTheme);
    expect(root?.getAttribute("data-density")).toBe(fallbackDensity);
    expect(root?.getAttribute("data-mode")).toBe(fallbackMode);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      fallbackTheme,
    );
    expect(document.documentElement.getAttribute("data-density")).toBe(
      fallbackDensity,
    );
    expect(document.documentElement.getAttribute("data-mode")).toBe(
      fallbackMode,
    );
    expect(window.localStorage.getItem(DEFAULT_STORAGE_KEY)).toBe(seeded);
  });

  /**
   * The falsifying half of the pair. Dropping `persistPreferences={false}`
   * restores CUE++'s default mount-time read, so the same seeded triple wins
   * over the server's — exactly the flash and database disagreement §5.3
   * forbids. Without this control the assertions above hold in both modes and
   * would let the regression through.
   */
  test("positive control: a persisting provider does restore that triple", () => {
    seedStoredPreferences();

    render(
      <ThemeProvider
        theme={fallbackTheme}
        density={fallbackDensity}
        mode={fallbackMode}
        fontFamilies={{ sans: geistSans, mono: geistMono }}
      >
        <p>persisting</p>
      </ThemeProvider>,
    );

    const root = document.querySelector("[data-cue-root]");

    expect(root?.getAttribute("data-theme")).toBe(storedPreferences.theme);
    expect(root?.getAttribute("data-density")).toBe(storedPreferences.density);
    expect(root?.getAttribute("data-mode")).toBe(storedPreferences.mode);
  });

  test("stamps the single body child through the verified asChild boundary", () => {
    seedStoredPreferences();

    render(
      <ThemeProvider
        theme={fallbackTheme}
        density={fallbackDensity}
        mode={fallbackMode}
        fontFamilies={{ sans: geistSans, mono: geistMono }}
        persistPreferences={false}
        asChild
      >
        <section data-testid="document-body">
          <p>authoritative</p>
        </section>
      </ThemeProvider>,
    );

    const body = screen.getByTestId("document-body");

    expect(body.tagName).toBe("SECTION");
    expect(body.hasAttribute("data-cue-root")).toBe(true);
    expect(body.getAttribute("data-theme")).toBe(fallbackTheme);
    expect(body.getAttribute("data-density")).toBe(fallbackDensity);
    expect(body.getAttribute("data-mode")).toBe(fallbackMode);
    expect(body.style.getPropertyValue("--cue-font-sans")).toBe(geistSans);
    expect(body.style.getPropertyValue("--cue-font-mono")).toBe(geistMono);
  });

  test("keeps the server triple when every storage operation throws", () => {
    seedStoredPreferences();
    const calls = installThrowingStorage();

    render(
      <ThemeProvider
        theme={fallbackTheme}
        density={fallbackDensity}
        mode={fallbackMode}
        persistPreferences={false}
      >
        <p>authoritative</p>
      </ThemeProvider>,
    );

    const root = document.querySelector("[data-cue-root]");

    expect(root?.getAttribute("data-theme")).toBe(fallbackTheme);
    expect(root?.getAttribute("data-density")).toBe(fallbackDensity);
    expect(root?.getAttribute("data-mode")).toBe(fallbackMode);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      fallbackTheme,
    );
    expect(document.documentElement.getAttribute("data-density")).toBe(
      fallbackDensity,
    );
    expect(document.documentElement.getAttribute("data-mode")).toBe(
      fallbackMode,
    );
    // A non-persisting provider never touches storage at all, so a throwing
    // implementation is never even given the chance to fail.
    expect(calls.reads).toBe(0);
    expect(calls.writes).toBe(0);
  });
});

describe("authoritative pre-paint runs before hydration", () => {
  const authoritativeOptions = {
    storageKey: DEFAULT_STORAGE_KEY,
    defaults: {
      theme: fallbackTheme,
      density: fallbackDensity,
      mode: fallbackMode,
    },
    readStoredPreferences: false,
  } as const;

  test("stamps the document from the server triple under throwing storage", () => {
    installThrowingStorage();

    const script = prepaintScript(authoritativeOptions);

    // `readStoredPreferences: false` removes the read from the emitted source
    // rather than merely tolerating its failure, so no browser state can reach
    // the stamp on any code path.
    expect(script).not.toContain("localStorage");

    new Function(script)();

    expect(document.documentElement.getAttribute("data-theme")).toBe(
      fallbackTheme,
    );
    expect(document.documentElement.getAttribute("data-density")).toBe(
      fallbackDensity,
    );
    expect(document.documentElement.getAttribute("data-mode")).toBe(
      fallbackMode,
    );
    expect(document.documentElement.style.colorScheme).toBe("light dark");
  });

  test("ignores a readable stored triple that disagrees with the server", () => {
    seedStoredPreferences();

    new Function(prepaintScript(authoritativeOptions))();

    expect(document.documentElement.getAttribute("data-theme")).toBe(
      fallbackTheme,
    );
    expect(document.documentElement.getAttribute("data-density")).toBe(
      fallbackDensity,
    );
    expect(document.documentElement.getAttribute("data-mode")).toBe(
      fallbackMode,
    );
  });

  /**
   * The falsifying half: CUE++'s permissive default reads storage and stamps
   * what it finds. Without this control both assertions above would also hold
   * for `readStoredPreferences: true`, and dropping the flag in Task 4 would
   * reintroduce the pre-paint/server disagreement silently.
   */
  test("positive control: the permissive script does adopt the stored triple", () => {
    seedStoredPreferences();

    const script = prepaintScript({
      storageKey: DEFAULT_STORAGE_KEY,
      defaults: authoritativeOptions.defaults,
    });

    expect(script).toContain("localStorage");

    new Function(script)();

    expect(document.documentElement.getAttribute("data-theme")).toBe(
      storedPreferences.theme,
    );
    expect(document.documentElement.getAttribute("data-density")).toBe(
      storedPreferences.density,
    );
    expect(document.documentElement.getAttribute("data-mode")).toBe(
      storedPreferences.mode,
    );
  });
});

describe("real CUE++ portal interaction", () => {
  test("opens into a stamped portal container and dismisses on Escape", async () => {
    seedStoredPreferences();
    const user = userEvent.setup();

    render(
      <ThemeProvider
        theme={fallbackTheme}
        density={fallbackDensity}
        mode={fallbackMode}
        persistPreferences={false}
      >
        <Dialog.Root>
          <Dialog.Trigger render={<Button>Open appearance</Button>} />
          <Dialog.Content>
            <Dialog.Title>Appearance</Dialog.Title>
            <Dialog.Description>
              Choose a theme, a density, and a mode.
            </Dialog.Description>
          </Dialog.Content>
        </Dialog.Root>
      </ThemeProvider>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open appearance" }));

    const dialog = await screen.findByRole("dialog");
    const portal = dialog.closest("[data-cue-portal]");

    expect(portal).not.toBeNull();
    expect(portal?.parentElement).toBe(document.body);
    expect(portal?.getAttribute("data-theme")).toBe(fallbackTheme);
    expect(portal?.getAttribute("data-density")).toBe(fallbackDensity);
    expect(portal?.getAttribute("data-mode")).toBe(fallbackMode);
    expect(dialog).toHaveAccessibleName("Appearance");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
