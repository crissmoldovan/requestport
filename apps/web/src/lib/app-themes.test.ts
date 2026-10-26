import { createRequire } from "node:module";
import { appearanceThemes } from "@requestport/domain/browser";
import { describe, expect, test } from "vitest";

import { appThemes } from "./app-themes.js";

describe("the registered CUE++ themes", () => {
  test("are exactly the locked appearance vocabulary, in its order", () => {
    // A theme the vocabulary allows but nothing registers would be stamped
    // on the document and paint nothing; a theme registered but not allowed
    // could never be chosen. Either way the two lists have drifted.
    expect(appThemes.map((theme) => theme.name)).toEqual([...appearanceThemes]);
  });

  test("each come from their own package", () => {
    // RequestPort's own palette is a workspace package: the product owns the
    // colours it ships. The other eighteen are design-system packages.
    expect(appThemes.map((theme) => theme.package)).toEqual(
      appearanceThemes.map((name) =>
        name === "requestport"
          ? "@requestport/theme"
          : `@cueplusplus/theme-${name}`,
      ),
    );
  });

  test("include every stock theme @cueplusplus/ui 0.29.0 ships, and RequestPort's own in place of cue-ui's (ruling 255)", () => {
    const manifest = createRequire(import.meta.url)(
      "@cueplusplus/ui/manifest.json",
    ) as { version: string; themes: string[] };

    expect(manifest.version).toBe("0.29.0");
    expect(appThemes.map((theme) => theme.name).toSorted()).toEqual(
      [...manifest.themes].toSorted(),
    );
    expect(
      appThemes.find((theme) => theme.name === "requestport")?.package,
    ).toBe("@requestport/theme");
  });
});
