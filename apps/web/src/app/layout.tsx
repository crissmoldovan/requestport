import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import "./globals.css";

import {
  appearanceMirrorScript,
  appearancePrepaintScript,
} from "../lib/appearance-script.js";
import { getAppearance } from "../lib/server-appearance.js";
import { AppearanceRoot } from "./appearance-root.js";

export const metadata: Metadata = {
  title: "RequestPort",
  description: "Cross-project work, one canonical record.",
};

/**
 * The one server-owned appearance boundary. It resolves the validated effective
 * triple before the document is rendered, stamps it on `<html>`, replays it
 * through the two blocking head scripts, and hands the same triple to the one
 * outer CUE++ provider — so the head stamp, the server markup, the first client
 * render, and provider state agree even when localStorage reads or writes
 * throw. `persistPreferences={false}` keeps the browser record a mirror rather
 * than a second preference source.
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

  return (
    <html
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-density={effective.density}
      data-mode={effective.mode}
      data-theme={effective.theme}
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
          // biome-ignore lint/security/noDangerouslySetInnerHtml: published CUE++ pre-paint body for the same validated triple.
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
