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
} as const;

/** Every byte a value could use to escape the host `<script>` element. */
const hostileValue = "</script><svg onload=alert(1)>\u2028\u2029";

/** The whole emitted mirror body, so nothing can be smuggled between assertions. */
const expectedMirrorScript =
  'try{localStorage.setItem("cue-ui","{\\"theme\\":\\"venu\\",\\"density\\":\\"large\\",\\"mode\\":\\"light\\"}")}catch(e){}';

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
  test("writes exactly the complete validated triple under the published key", () => {
    expect(appearanceStorageKey).toBe(DEFAULT_STORAGE_KEY);
    expect(appearanceMirrorScript(confirmed)).toBe(expectedMirrorScript);
  });

  test("survives a browser whose storage throws on write", () => {
    expect(appearanceMirrorScript(confirmed)).toMatch(/^try\{.+\}catch\(/su);
  });

  test("degrades an unknown axis to the fixed RequestPort fallback", () => {
    const script = appearanceMirrorScript({
      theme: "midnight",
      density: "gigantic",
      mode: "sepia",
    } as unknown as typeof confirmed);

    expect(script).toBe(
      appearanceMirrorScript({ ...appearanceFallback } as typeof confirmed),
    );
    expect(script).not.toContain("midnight");
    expect(script).not.toContain("gigantic");
    expect(script).not.toContain("sepia");
  });

  test("cannot close the host script element from a hostile axis", () => {
    const script = appearanceMirrorScript({
      theme: hostileValue,
      density: hostileValue,
      mode: hostileValue,
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
  test("stamps the server triple and never reads stored preferences", () => {
    const script = appearancePrepaintScript(confirmed);

    expect(script).toContain('"venu"');
    expect(script).toContain('"large"');
    expect(script).toContain('"light"');
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
