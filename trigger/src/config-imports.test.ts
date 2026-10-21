import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * What this worker may import from the configuration package.
 *
 * `@requestport/config` re-exports both halves, and its client half parses
 * `process.env` the moment it is imported. Nothing here runs in a browser and
 * nothing here needs that half — but importing the package's root pulls it in
 * anyway, and the parse then happens wherever the module is loaded.
 *
 * That is not a runtime concern only. Deploying this worker discovers its tasks
 * by importing every module, so a build with no public origin in its
 * environment fails while bundling, once per module, and the deploy reports one
 * word for all of it. The first live promotion of this project ended exactly
 * there.
 *
 * So the root is refused and the narrow entry points are used instead. Each one
 * carries what it says and nothing else, and a server-side worker asking for a
 * logger gets a logger.
 */

/**
 * Both trees this worker is built from.
 *
 * The task bodies moved to `@requestport/jobs` so a Postgres worker can run
 * them too; this worker still bundles every one of them, so every rule below
 * holds for that tree as well as for the task definitions here. Walked
 * recursively, because the bodies sit in a subdirectory there.
 */
const sourceRoots = [
  import.meta.dirname,
  resolve(import.meta.dirname, "../../packages/jobs/src"),
];
const barrelSpecifier = '"@requestport/config"';

function workerSources(): { file: string; path: string; source: string }[] {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  return sourceRoots.flatMap((root) =>
    readdirSync(root, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return {
          file: relative(repositoryRoot, path),
          path,
          source: readFileSync(path, "utf8"),
        };
      }),
  );
}

const isTestSupport = (file: string) =>
  file.endsWith(".test.ts") || file.endsWith("/test-setup.ts");

describe("what the worker imports from the configuration package", () => {
  test("never reaches the root, which parses the browser's environment", () => {
    const sources = workerSources();
    const reaching = sources
      .filter(({ source }) => source.includes(`from ${barrelSpecifier}`))
      .map(({ file }) => file);

    // Planted, because a scan over an empty directory reports nothing missing
    // and would pass on a worker that had no modules at all.
    expect(sources.length).toBeGreaterThan(0);
    expect(reaching).toEqual([]);
  });

  test("reaches the narrow entry points instead", () => {
    // The partner of the refusal above: a worker that imported nothing from the
    // package would satisfy it while proving nothing about what replaced the
    // root.
    const used = new Set(
      workerSources().flatMap(({ source }) =>
        [...source.matchAll(/from "(@requestport\/config\/[a-z-]+)"/gu)].map(
          (match) => match[1] as string,
        ),
      ),
    );

    expect([...used].sort()).toEqual([
      "@requestport/config/logger",
      "@requestport/config/server-deferred",
    ]);
  });
});

/**
 * The build's own question, asked here.
 *
 * A deploy discovers this worker's tasks by importing every module, in a
 * container that holds none of this application's secrets — and the eagerly
 * parsed `@requestport/config/server` refuses to be imported without them, so
 * the deploy failed. That failure is invisible to a test suite that runs with a
 * full environment, which is how the same root cause reached staging three
 * times running.
 *
 * The first repair was worse than useless: it added a lazily-parsed export
 * alongside the eager one, in the same module. An import runs the whole module,
 * so naming the lazy export changed nothing at all, and only a run against the
 * real thing said so. Hence this: import every module with the secrets removed,
 * exactly as the build does, and let the assertion be the same one the deploy
 * makes.
 */
describe("what the worker does when a build imports it", () => {
  const secrets = [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "DATABASE_URL",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "NEXT_PUBLIC_APP_URL",
    "NODE_ENV",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Every module, imported cold and transformed on the way in. It runs in well
  // under two seconds here and took longer than the five-second default on a
  // CI runner, which failed the release for the timeout rather than for
  // anything the assertion says.
  test("every module imports with none of the secrets present", {
    timeout: 120_000,
  }, async () => {
    for (const secret of secrets) {
      vi.stubEnv(secret, undefined);
    }
    vi.resetModules();

    const modules = workerSources().filter(({ file }) => !isTestSupport(file));
    const refused: string[] = [];

    for (const { file, path } of modules) {
      try {
        await import(/* @vite-ignore */ path);
      } catch (error) {
        refused.push(`${file}: ${(error as Error).message.split("\n")[0]}`);
      }
    }

    expect(modules.length).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });

  test("but reading the configuration without it still refuses", {
    timeout: 120_000,
  }, async () => {
    for (const secret of secrets) {
      vi.stubEnv(secret, undefined);
    }
    vi.resetModules();

    const { serverEnv } = await import("@requestport/config/server-deferred");

    expect(() => serverEnv.DATABASE_URL).toThrow();
  });
});

/**
 * Why this worker's authentication secret need not be the application's.
 *
 * Vercel holds `BETTER_AUTH_SECRET` as a sensitive variable: a deployment
 * receives it and an API caller does not, so nothing outside a deployment can
 * read the one the application runs on. The worker is given its own instead,
 * and that is only safe while the two are never compared.
 *
 * They are not. This worker validates no session — nothing here reads a cookie
 * or a token — and its single use of the secret is a keyed fingerprint under a
 * salt of its own, `requestport-work-sweep-v1`, while the application uses the
 * raw value. The two derivations were already in different namespaces before
 * the values were, so a command receipt written by one was never going to be
 * found by the other.
 *
 * A future task that read the secret plainly would quietly break that, and the
 * breakage would look like a duplicate execution rather than a configuration
 * error. So the raw read is refused here rather than remembered.
 */
describe("what the worker does with the authentication secret", () => {
  test("reads it only through a keyed derivation of its own", () => {
    const reading = workerSources().filter(
      ({ file, source }) =>
        !isTestSupport(file) && source.includes("BETTER_AUTH_SECRET"),
    );
    const raw = reading
      .filter(
        ({ source }) =>
          !/createHmac\(\s*"sha256",\s*serverEnv\.BETTER_AUTH_SECRET\s*\)/u.test(
            source,
          ),
      )
      .map(({ file }) => file);

    expect(reading.length).toBeGreaterThan(0);
    expect(raw).toEqual([]);
  });

  test("never validates a session, which is what would need the same value", () => {
    const validating = workerSources()
      .filter(
        ({ file, source }) =>
          !isTestSupport(file) &&
          /\bgetSession\b|\bvalidateSession\b|\bbetterAuth\b/u.test(source),
      )
      .map(({ file }) => file);

    expect(validating).toEqual([]);
  });
});
