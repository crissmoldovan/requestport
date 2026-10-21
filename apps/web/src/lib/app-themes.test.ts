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
    // colours it ships. The other eight are still design-system packages.
    expect(appThemes.map((theme) => theme.package)).toEqual(
      appearanceThemes.map((name) =>
        name === "requestport"
          ? "@requestport/theme"
          : `@cueplusplus/theme-${name}`,
      ),
    );
  });
});
