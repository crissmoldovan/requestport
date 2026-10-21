import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
  },
  // The self-host build (Plan 13, H.5; manifest-h.md §2.7.1), which
  // `requestport start` serves beside its host: Next's standalone output, in a
  // distDir of its own so that it never lands in .next, where `--e2e` would
  // serve it. Only the exact value "1" adds these two keys; without it this
  // is the object Vercel builds, which
  // apps/requestport/src/web/next-config.test.ts compares key for key.
  ...(process.env.REQUESTPORT_SELF_HOST_BUILD === "1"
    ? { output: "standalone" as const, distDir: ".next-self-host" }
    : {}),
};

export default nextConfig;
