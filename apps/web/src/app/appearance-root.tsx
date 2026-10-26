"use client";

import { ThemeProvider } from "@cueplusplus/ui/system";
import type { AppearanceDefaults } from "@requestport/domain/browser";
import type { ReactNode } from "react";

import { appThemes } from "../lib/app-themes.js";
import { appearancePresentation } from "../lib/appearance-presentation.js";

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
 * The six axes are a prop, not state: the server resolved them, the head
 * scripts already stamped them, and `persistPreferences={false}` keeps the
 * browser record a mirror rather than a second preference source. The
 * typeface, style set and paint are handed over with every `match` resolved
 * through the theme's Look (`appearancePresentation`); no `fontFamilies` is
 * passed, because it would shadow the pairing the typeface names — the faces
 * reach the pairing through the `--cue-face-*` classes the root layout puts
 * on `<html>` (`appearance-faces.ts`).
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
  const presentation = appearancePresentation(appearance);
  return (
    <ThemeProvider
      asChild
      density={presentation.density}
      font={presentation.font}
      mode={presentation.mode}
      /*
       * What the nonce reaches, at `@cueplusplus/ui@0.29.0`.
       *
       * **Base UI's** style element, and its prehydration `<script>`: given a
       * nonce, `ThemeProvider` renders Base UI's own `CSPProvider` around this
       * tree, as it has since 0.14.1. That is what the acceptance suite's
       * blocked-style tolerance used to forgive, and why this application
       * renders no `CSPProvider` of its own — cue-ui's contract is this prop
       * **or** your own provider, never both, because an inner provider
       * replaces an outer one rather than extending it.
       *
       * None of the provider's own `<style>` elements, today. It renders its
       * density layer only when `overrides.densities` is given and its colour
       * layer only when `overrides.colors` is, and this component passes no
       * `overrides`. The nonce is threaded anyway because the moment an
       * override is added the element appears, and a client-rendered `<style>`
       * cannot pick up a server nonce by itself.
       */
      nonce={nonce}
      paint={presentation.paint}
      persistPreferences={false}
      styleSet={presentation.styleSet}
      theme={presentation.theme}
      themes={appThemes}
    >
      <body>{children}</body>
    </ThemeProvider>
  );
}
