import { describe, expect, test } from "vitest";

import { moduleLayout } from "./layout.js";

describe("moduleLayout (H.7)", () => {
  test("a module's own .ts URL is the repository's source, as tsx and vitest load it", () => {
    expect(moduleLayout(import.meta.url)).toBe("repository");
    expect(
      moduleLayout("file:///work/requestport/apps/requestport/src/cli.ts"),
    ).toBe("repository");
  });

  test("a .js URL is the packed JavaScript esbuild writes in dist/", () => {
    expect(moduleLayout("file:///opt/requestport/dist/chunk-ABCDEF12.js")).toBe(
      "packed",
    );
    expect(moduleLayout("file:///opt/requestport/dist/requestport.js")).toBe(
      "packed",
    );
  });

  test("any other extension is refused rather than guessed", () => {
    for (const url of [
      "file:///opt/requestport/dist/requestport.mjs",
      "file:///opt/requestport/dist/requestport.cjs",
      "file:///work/requestport/apps/requestport/src/main.tsx",
      "file:///opt/requestport/dist/requestport",
    ]) {
      expect(() => moduleLayout(url)).toThrow(
        `requestport: ${url} is neither the repository's TypeScript (.ts) nor the packed JavaScript (.js).`,
      );
    }
  });
});
