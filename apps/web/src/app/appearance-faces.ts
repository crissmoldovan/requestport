import localFont from "next/font/local";

/*
  Every face the offered typefaces name (ruling 255), served from this
  application's own origin: `next/font/local` copies each file into the build's
  static media, so `font-src 'self'` covers them and a self-hosted instance
  needs no network. Each file is the Latin subset its package ships; text
  outside Latin falls through the pairing's stack to the platform.

  cue-ui's `[data-font]` blocks name each face through a `--cue-face-*`
  property (`FONT_FACES` in `@cueplusplus/tokens`), with the family's literal
  name as the fallback. `next/font` hashes family names, so each face is
  declared under its property here, and the root layout puts every `variable`
  class on `<html>`, where `data-font` is stamped and the pairing resolves.

  The one face of an offered pairing that is not here is Paper Mono, the mono
  of `calsans`: no package on the public registry ships it, so that pairing's
  mono falls through its stack (`"Geist Mono"` by its literal name, then the
  platform's monospace).

  Only the faces of the default Look — the cue theme's `geist` pairing, Geist
  over JetBrains Mono — are preloaded. Every other file is fetched only when a
  chosen typeface puts its family in a computed style.
*/

const geist = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--cue-face-geist",
  weight: "100 900",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--cue-face-jetbrains-mono",
  weight: "100 800",
  display: "swap",
});

const geistMono = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--cue-face-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
});

const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--cue-face-inter",
  weight: "100 900",
  display: "swap",
  preload: false,
});

const ibmPlexSans = localFont({
  src: "../../node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2",
  variable: "--cue-face-ibm-plex-sans",
  weight: "100 700",
  display: "swap",
  preload: false,
});

const ibmPlexMono = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
  ],
  variable: "--cue-face-ibm-plex-mono",
  display: "swap",
  preload: false,
});

const sourceCodePro = localFont({
  src: "../../node_modules/@fontsource-variable/source-code-pro/files/source-code-pro-latin-wght-normal.woff2",
  variable: "--cue-face-source-code-pro",
  weight: "200 900",
  display: "swap",
  preload: false,
});

const dmSans = localFont({
  src: "../../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2",
  variable: "--cue-face-dm-sans",
  weight: "100 1000",
  display: "swap",
  preload: false,
});

const anybody = localFont({
  src: "../../node_modules/@fontsource-variable/anybody/files/anybody-latin-wght-normal.woff2",
  variable: "--cue-face-anybody",
  weight: "100 900",
  display: "swap",
  preload: false,
});

const spaceMono = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource/space-mono/files/space-mono-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource/space-mono/files/space-mono-latin-700-normal.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--cue-face-space-mono",
  display: "swap",
  preload: false,
});

const calSans = localFont({
  src: "../../node_modules/@fontsource/cal-sans/files/cal-sans-latin-400-normal.woff2",
  variable: "--cue-face-cal-sans",
  weight: "400",
  display: "swap",
  preload: false,
});

const fraunces = localFont({
  src: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2",
  variable: "--cue-face-fraunces",
  weight: "100 900",
  display: "swap",
  preload: false,
});

/** Every face's `variable` class, for the root `<html>` element. */
export const appearanceFaceClassName = [
  geist,
  jetbrainsMono,
  geistMono,
  inter,
  ibmPlexSans,
  ibmPlexMono,
  sourceCodePro,
  dmSans,
  anybody,
  spaceMono,
  calSans,
  fraunces,
]
  .map((face) => face.variable)
  .join(" ");
