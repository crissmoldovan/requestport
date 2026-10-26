import command from "@cueplusplus/theme-command";
import cue from "@cueplusplus/theme-cue";
import dusk from "@cueplusplus/theme-dusk";
import graphite from "@cueplusplus/theme-graphite";
import hivehub from "@cueplusplus/theme-hivehub";
import kiln from "@cueplusplus/theme-kiln";
import ledger from "@cueplusplus/theme-ledger";
import luma from "@cueplusplus/theme-luma";
import monolith from "@cueplusplus/theme-monolith";
import porcelain from "@cueplusplus/theme-porcelain";
import prism from "@cueplusplus/theme-prism";
import quotamate from "@cueplusplus/theme-quotamate";
import signal from "@cueplusplus/theme-signal";
import snuffle from "@cueplusplus/theme-snuffle";
import tender from "@cueplusplus/theme-tender";
import terminal from "@cueplusplus/theme-terminal";
import venu from "@cueplusplus/theme-venu";
import zine from "@cueplusplus/theme-zine";
import type { ThemeManifest } from "@cueplusplus/ui/system";
import requestport from "@requestport/theme";

/**
 * The themes RequestPort registers, in the order of the locked appearance
 * vocabulary: its own `requestport`, from `packages/theme`, and every stock
 * theme `@cueplusplus/ui@0.29.0` ships but cue-ui's own `requestport`
 * (ruling 255).
 *
 * Since `@cueplusplus/ui@0.9.0` no theme ships inside the component package.
 * Each is its own package, and the provider and the pre-paint script both take
 * the list explicitly. Handed none, they accept any well-formed theme name and
 * validate density and font against the base axes alone. What paints is decided
 * separately, by the `[data-theme]` blocks the stylesheets declare, which is why
 * `globals.css` imports the same nineteen.
 *
 * Importing each package from its root rather than its `manifest.json` subpath
 * is also what closes `ThemeName` to the nineteen imported here: every package
 * augments the registry type, so a misspelt theme is a type error.
 *
 * `app-themes.test.ts` holds this list to the vocabulary in
 * `@requestport/domain`, and `globals.test.ts` holds the stylesheet imports to
 * this list.
 */
export const appThemes: readonly ThemeManifest[] = [
  requestport,
  cue,
  terminal,
  signal,
  venu,
  hivehub,
  dusk,
  luma,
  snuffle,
  command,
  graphite,
  kiln,
  ledger,
  monolith,
  porcelain,
  prism,
  quotamate,
  tender,
  zine,
];
