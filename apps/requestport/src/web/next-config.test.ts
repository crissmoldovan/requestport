import { afterEach, describe, expect, test, vi } from "vitest";

/*
 * apps/web/next.config.ts is Vercel's build input. Without the self-host
 * build variable it must export exactly the object it exported before H.5
 * (manifest-h.md §2.7.1), so this compares with that object written out
 * here, not with a copy read from the source. The file is imported by path:
 * apps/web's own Vitest collects src/** only (survey, slice a).
 */
const NEXT_CONFIG = new URL("../../../web/next.config.ts", import.meta.url)
  .href;

const VERCEL_CONFIG = {
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
  },
};

async function configWith(value: string | undefined): Promise<unknown> {
  vi.resetModules();
  vi.stubEnv("REQUESTPORT_SELF_HOST_BUILD", value);
  const loaded = (await import(/* @vite-ignore */ NEXT_CONFIG)) as {
    default: unknown;
  };
  return loaded.default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apps/web/next.config.ts", () => {
  test.each([
    ["unset", undefined],
    ["0", "0"],
    ["the empty string", ""],
    ["true", "true"],
    [" 1 (padded)", " 1"],
  ])(
    "exports today's object when the variable is %s",
    async (_label, value) => {
      expect(await configWith(value)).toStrictEqual(VERCEL_CONFIG);
    },
  );

  test("adds standalone output in its own distDir when the variable is 1", async () => {
    expect(await configWith("1")).toStrictEqual({
      ...VERCEL_CONFIG,
      output: "standalone",
      distDir: ".next-self-host",
    });
  });
});
