import { DEFAULT_STORAGE_KEY, prepaintScript } from "@cueplusplus/ui/system";
import type { AppearanceDefaults } from "@requestport/domain";

import { appThemes } from "./app-themes.js";
import { appearancePresentation } from "./appearance-presentation.js";

/**
 * The published CUE++ preference key. The mirror script, the pre-paint script,
 * and the provider all share it, so a second key can never split the record.
 */
export const appearanceStorageKey = DEFAULT_STORAGE_KEY;

/**
 * JSON that is safe to embed in an inline `<script>` element. `<` and `>` are
 * escaped so no value can close the host element, and the two Unicode line
 * terminators are escaped because they are legal inside a JSON string but end a
 * JavaScript line. The escapes remain valid JSON, so the browser reads back the
 * same value.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * The best-effort no-flash mirror. It rewrites the browser's local record from
 * the server-resolved axes; it is never read back as a preference source, and
 * a browser whose storage throws simply keeps whatever it had.
 *
 * The record is in CUE++'s own shape — `{ theme, density, font, mode }` plus
 * `style` and `paint` — holding the values the page is stamped with, so a
 * `match` is written as the face, set or paint it resolved to, never as the
 * word `match`, which no CUE++ axis accepts.
 *
 * Every embedded value is re-parsed against the locked vocabulary first, so the
 * emitted body can only ever contain allowlisted enum values — no identifier,
 * session value, tenant, or human copy.
 */
export function appearanceMirrorScript(axes: AppearanceDefaults): string {
  const presentation = appearancePresentation(axes);
  const key = scriptSafeJson(appearanceStorageKey);
  const record = scriptSafeJson(
    JSON.stringify({
      theme: presentation.theme,
      density: presentation.density,
      font: presentation.font,
      mode: presentation.mode,
      style: presentation.styleSet,
      paint: presentation.paint,
    }),
  );
  return `try{localStorage.setItem(${key},${record})}catch(e){}`;
}

/**
 * The authoritative pre-paint stamp. `readStoredPreferences: false` removes the
 * storage read from the emitted source entirely, so the server's axes own the
 * first frame whether storage is stale, malformed, or throwing. It names all
 * six — the typeface, style set and paint resolved as the provider is given
 * them — so the first paint and the first commit agree.
 *
 * `themes` is the registry the provider is given. The script inlines the
 * registered names and the rungs and pairings each theme offers (names only,
 * no colours), so first paint and the provider validate against the same list.
 */
export function appearancePrepaintScript(axes: AppearanceDefaults): string {
  const presentation = appearancePresentation(axes);
  return prepaintScript({
    storageKey: appearanceStorageKey,
    defaults: {
      theme: presentation.theme,
      density: presentation.density,
      mode: presentation.mode,
      font: presentation.font,
      styleSet: presentation.styleSet,
      paint: presentation.paint,
    },
    readStoredPreferences: false,
    themes: appThemes,
  });
}
