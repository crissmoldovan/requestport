import "@testing-library/jest-dom/vitest";

import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * The DOM lane runs real CUE++ components over Base UI, which reaches for
 * browser APIs jsdom does not implement. Every stub here is deterministic: no
 * timers, no randomness, and no dependence on the host machine's colour
 * scheme, so an overlay behaves identically on a laptop and in CI.
 */

const rootStampAttributes = [
  "data-theme",
  "data-density",
  "data-font",
  "data-mode",
];

class DeterministicResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Deterministic dark: `(prefers-color-scheme: light)` never matches, so the
 * provider resolves `system` identically on every machine. Listener plumbing
 * is the real `EventTarget`, so a component that subscribes and unsubscribes
 * behaves exactly as it would in a browser.
 */
class DeterministicMediaQueryList
  extends EventTarget
  implements MediaQueryList
{
  readonly matches: boolean = false;
  onchange:
    | ((this: MediaQueryList, event: MediaQueryListEvent) => void)
    | null = null;

  constructor(readonly media: string) {
    super();
  }

  addListener(): void {}
  removeListener(): void {}
}

function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      new DeterministicMediaQueryList(query),
  });
}

function installPointerAndFocusStubs(): void {
  Object.defineProperties(Element.prototype, {
    hasPointerCapture: {
      configurable: true,
      writable: true,
      value: () => false,
    },
    setPointerCapture: { configurable: true, writable: true, value: () => {} },
    releasePointerCapture: {
      configurable: true,
      writable: true,
      value: () => {},
    },
    scrollIntoView: { configurable: true, writable: true, value: () => {} },
    getAnimations: { configurable: true, writable: true, value: () => [] },
  });
}

function removePortalContainers(): void {
  for (const container of document.querySelectorAll("[data-cue-portal]")) {
    container.remove();
  }
}

function resetDocumentStamp(): void {
  for (const attribute of rootStampAttributes) {
    document.documentElement.removeAttribute(attribute);
  }

  document.documentElement.style.colorScheme = "";
}

configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  installMatchMedia();
  installPointerAndFocusStubs();
  vi.stubGlobal("ResizeObserver", DeterministicResizeObserver);
  resetDocumentStamp();
});

afterEach(() => {
  cleanup();
  removePortalContainers();
  resetDocumentStamp();
  vi.unstubAllGlobals();

  // A test may have replaced storage with a throwing implementation; clearing
  // it is best effort and never fails the test that installed it.
  try {
    window.localStorage?.clear();
  } catch {}
});
