import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import "./globals.css";

import { appearancePresentation } from "../lib/appearance-presentation.js";
import {
  appearanceMirrorScript,
  appearancePrepaintScript,
} from "../lib/appearance-script.js";
import { getAppearance } from "../lib/server-appearance.js";
import { appearanceFaceClassName } from "./appearance-faces.js";
import { AppearanceRoot } from "./appearance-root.js";

export const metadata: Metadata = {
  title: "RequestPort",
  description: "Cross-project work, one canonical record.",
};

/**
 * The one server-owned appearance boundary. It resolves the validated effective
 * six axes before the document is rendered, stamps them on `<html>` (the
 * typeface, style set and paint with `match` resolved through the theme's
 * Look), replays them through the two blocking head scripts, and hands the
 * same axes to the one outer CUE++ provider — so the head stamp, the server
 * markup, the first client render, and provider state agree even when
 * localStorage reads or writes throw. `persistPreferences={false}` keeps the
 * browser record a mirror rather than a second preference source. Every face
 * an offered typeface names is declared on `<html>` by its class.
 *
 * `data-field-edge="contrast"` is `@cueplusplus/ui`'s opt-in for every
 * recessed field under it (inputs, textareas, selects, comboboxes): a resting
 * edge in the theme's `--cue-field-edge`, its border moved to 3:1 against
 * `surface-1`, and the full focus ring. Since 0.24.0 a field outside it paints
 * its ring as `--cue-focus` mixed to 15% with transparent, which is not the
 * focus token §13 asks every focus indicator to be drawn from; the app bar's
 * organization select is such a field, and the shell's second or third Tab
 * stop, inside the keyboard-focus acceptance rows' eight. The share itself,
 * `--cue-style-field-focus-mix`, is a name the package publishes, and
 * `globals.css` may not redeclare one (the audit's `token-shadow-declaration`).
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [requestHeaders, appearance] = await Promise.all([
    headers(),
    getAppearance(),
  ]);
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  const effective = appearance.snapshot.effective;
  const presentation = appearancePresentation(effective);

  return (
    <html
      className={appearanceFaceClassName}
      data-density={presentation.density}
      data-field-edge="contrast"
      data-font={presentation.font}
      data-mode={presentation.mode}
      data-paint={presentation.paint}
      data-style={presentation.styleSet}
      data-theme={presentation.theme}
      lang="en"
      suppressHydrationWarning
    >
      {/*
       * Both bodies are built only from allowlisted appearance enum values and
       * escaped by `scriptSafeJson`; a blocking inline script carrying the
       * request nonce is the only way to reach the document before first paint.
       */}
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped enum-only appearance mirror, see above.
          dangerouslySetInnerHTML={{
            __html: appearanceMirrorScript(effective),
          }}
          nonce={nonce}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: published CUE++ pre-paint body for the same validated axes.
          dangerouslySetInnerHTML={{
            __html: appearancePrepaintScript(effective),
          }}
          nonce={nonce}
        />
      </head>
      <AppearanceRoot appearance={effective} nonce={nonce}>
        {children}
      </AppearanceRoot>
    </html>
  );
}
