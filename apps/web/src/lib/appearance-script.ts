import { DEFAULT_STORAGE_KEY, prepaintScript } from "@cueplusplus/ui/system";
import {
  type AppearanceDefaults,
  parseAppearanceDefaults,
} from "@requestport/domain";

import { appThemes } from "./app-themes.js";

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
 * the server-resolved triple; it is never read back as a preference source, and
 * a browser whose storage throws simply keeps whatever it had.
 *
 * Every embedded value is re-parsed against the locked vocabulary first, so the
 * emitted body can only ever contain allowlisted enum values — no identifier,
 * session value, tenant, or human copy.
 */
export function appearanceMirrorScript(triple: AppearanceDefaults): string {
  const validated = parseAppearanceDefaults(triple);
  const key = scriptSafeJson(appearanceStorageKey);
  const record = scriptSafeJson(JSON.stringify(validated));
  return `try{localStorage.setItem(${key},${record})}catch(e){}`;
}

/**
 * The authoritative pre-paint stamp. `readStoredPreferences: false` removes the
 * storage read from the emitted source entirely, so the server triple owns the
 * first frame whether storage is stale, malformed, or throwing.
 *
 * `themes` is the registry the provider is given. The script inlines the
 * registered names and the rungs and pairings each theme offers (names only,
 * no colours), so first paint and the provider validate against the same list.
 */
export function appearancePrepaintScript(triple: AppearanceDefaults): string {
  return prepaintScript({
    storageKey: appearanceStorageKey,
    defaults: parseAppearanceDefaults(triple),
    readStoredPreferences: false,
    themes: appThemes,
  });
}
