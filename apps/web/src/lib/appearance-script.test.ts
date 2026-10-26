import { DEFAULT_STORAGE_KEY } from "@cueplusplus/ui/system";
import { appearanceFallback } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  appearanceMirrorScript,
  appearancePrepaintScript,
  appearanceStorageKey,
  scriptSafeJson,
} from "./appearance-script.js";

const confirmed = {
  theme: "venu",
  density: "large",
  mode: "light",
  font: "plex",
  look: "match",
  paint: "frost",
} as const;

/** Every byte a value could use to escape the host `<script>` element. */
const hostileValue = "</script><svg onload=alert(1)>\u2028\u2029";

/**
 * The whole emitted mirror body, so nothing can be smuggled between assertions:
 * CUE++'s record shape, with venu's `match` look resolved to classic's
 * `console` (venu has no Look of its own).
 */
const expectedMirrorScript =
  'try{localStorage.setItem("cue-ui","{\\"theme\\":\\"venu\\",\\"density\\":\\"large\\",\\"font\\":\\"plex\\",\\"mode\\":\\"light\\",\\"style\\":\\"console\\",\\"paint\\":\\"frost\\"}")}catch(e){}';

describe("script-safe serialisation", () => {
  test("escapes every sequence that can break out of an inline script", () => {
    const serialised = scriptSafeJson({ value: hostileValue });

    expect(serialised).not.toContain("<");
    expect(serialised).not.toContain(">");
    expect(serialised).not.toContain("\u2028");
    expect(serialised).not.toContain("\u2029");
    expect(serialised).toContain("\\u003c");
    expect(serialised).toContain("\\u003e");
    expect(serialised).toContain("\\u2028");
    expect(serialised).toContain("\\u2029");
    // The escapes stay valid JSON, so the browser still reads the same value.
    expect(JSON.parse(serialised)).toEqual({ value: hostileValue });
  });
});

describe("authoritative no-flash mirror script", () => {
  test("writes exactly the six validated axes, in CUE++'s record shape, under the published key", () => {
    expect(appearanceStorageKey).toBe(DEFAULT_STORAGE_KEY);
    expect(appearanceMirrorScript(confirmed)).toBe(expectedMirrorScript);
  });

  test("survives a browser whose storage throws on write", () => {
    expect(appearanceMirrorScript(confirmed)).toMatch(/^try\{.+\}catch\(/su);
  });

  test("writes what a match resolves to through the theme's Look, never the word match", () => {
    const script = appearanceMirrorScript({
      theme: "graphite",
      density: "normal",
      mode: "system",
      font: "match",
      look: "match",
      paint: "match",
    });

    expect(script).toContain('\\"font\\":\\"geist-mono\\"');
    expect(script).toContain('\\"style\\":\\"graphite\\"');
    expect(script).toContain('\\"paint\\":\\"bevel\\"');
    expect(script).not.toContain("match");
  });

  test("degrades an unknown axis to the fixed fallback", () => {
    const script = appearanceMirrorScript({
      theme: "midnight",
      density: "gigantic",
      mode: "sepia",
      font: "comic",
      look: "brutal",
      paint: "chrome",
    } as unknown as typeof confirmed);

    expect(script).toBe(
      appearanceMirrorScript({ ...appearanceFallback } as typeof confirmed),
    );
    expect(script).not.toContain("midnight");
    expect(script).not.toContain("gigantic");
    expect(script).not.toContain("sepia");
    expect(script).not.toContain("comic");
  });

  test("cannot close the host script element from a hostile axis", () => {
    const script = appearanceMirrorScript({
      theme: hostileValue,
      density: hostileValue,
      mode: hostileValue,
      font: hostileValue,
      look: hostileValue,
      paint: hostileValue,
    } as unknown as typeof confirmed);

    expect(script).not.toContain("<");
    expect(script).not.toContain(">");
    expect(script).not.toContain("\u2028");
    expect(script).not.toContain("\u2029");
    expect(script).toBe(
      appearanceMirrorScript({ ...appearanceFallback } as typeof confirmed),
    );
  });

  test("carries no identifier, address, or human copy", () => {
    const script = appearanceMirrorScript(confirmed);

    expect(script).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-/u);
    expect(script).not.toContain("@");
    expect(script).not.toContain("organization");
    expect(script).not.toContain("session");
    expect(script).not.toContain("userId");
  });
});

describe("authoritative pre-paint script", () => {
  test("stamps the server's six axes and never reads stored preferences", () => {
    const script = appearancePrepaintScript(confirmed);

    expect(script).toContain('"venu"');
    expect(script).toContain('"large"');
    expect(script).toContain('"light"');
    expect(script).toContain('"plex"');
    expect(script).toContain('"console"');
    expect(script).toContain('"frost"');
    expect(script).not.toContain("localStorage");
    // The published body legitimately contains `>` in `indexOf(…)>-1`; what it
    // must never contain is a `<`, which is the only way to close the host
    // element.
    expect(script).not.toContain("<");
  });

  test("degrades an unknown axis rather than handing it to the published script", () => {
    const script = appearancePrepaintScript({
      theme: "midnight",
      density: "gigantic",
      mode: "sepia",
      font: "comic",
      look: "brutal",
      paint: "chrome",
    } as unknown as typeof confirmed);

    expect(script).toBe(
      appearancePrepaintScript({ ...appearanceFallback } as typeof confirmed),
    );
    expect(script).not.toContain("midnight");
  });

  test("shares the storage key the provider and mirror use", () => {
    expect(appearancePrepaintScript(confirmed)).toContain('"cue-ui"');
  });
});
