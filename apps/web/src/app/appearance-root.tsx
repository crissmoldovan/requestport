"use client";

import { ThemeProvider } from "@cueplusplus/ui/system";
import type { AppearanceDefaults } from "@requestport/domain/browser";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";

import { appThemes } from "../lib/app-themes.js";

/**
 * The provider-as-body boundary, and the reason it is a client module.
 *
 * `asChild` is `React.Children.only` plus `cloneElement`. A server layout
 * cannot pass `<body>` through that sink: across the RSC boundary the child
 * arrives as a streamed lazy row rather than an element, `Children.only`
 * rejects it, and every document render fails. Creating `<body>` here — in the
 * same client module that clones it — keeps the element real, while the page
 * subtree stays an ordinary streamed child of the body.
 *
 * The triple is a prop, not state: the server resolved it, the head scripts
 * already stamped it, and `persistPreferences={false}` keeps the browser record
 * a mirror rather than a second preference source.
 */
export function AppearanceRoot({
  appearance,
  children,
  nonce,
}: Readonly<{
  appearance: AppearanceDefaults;
  children: ReactNode;
  nonce: string | undefined;
}>) {
  return (
    <ThemeProvider
      asChild
      density={appearance.density}
      fontFamilies={{
        sans: GeistSans.style.fontFamily,
        mono: GeistMono.style.fontFamily,
      }}
      mode={appearance.mode}
      /*
       * Threaded pre-emptively, and it currently reaches nothing.
       *
       * `ThemeProvider` renders its density override `<style>` only when
       * `overrides.densities` is given — `densityLayer` is `null` otherwise,
       * and this component passes no `overrides`. So the nonce is consumed by
       * no element today. It is passed anyway because the moment an override is
       * added the element appears, and a client-rendered `<style>` cannot pick
       * up a server nonce by itself.
       *
       * It is also what nonces **Base UI's** style element, and its
       * prehydration `<script>`, since `@cueplusplus/ui@0.14.1`: given a nonce
       * `ThemeProvider` renders Base UI's own `CSPProvider` around this tree.
       * That is what the acceptance suite's blocked-style tolerance used to
       * forgive, and why this application renders no `CSPProvider` of its own —
       * cue-ui's contract is this prop **or** your own provider, never both,
       * because an inner provider replaces an outer one rather than extending
       * it.
       */
      nonce={nonce}
      persistPreferences={false}
      theme={appearance.theme}
      themes={appThemes}
    >
      <body>{children}</body>
    </ThemeProvider>
  );
}
