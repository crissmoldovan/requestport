import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Whether this host can actually drive the WebKit build Playwright installs
 * for it.
 *
 * WebKit is a mandatory engine and stays one: the acceptance matrix declares
 * it, `playwright.config.ts` declares a project for it on every platform, and
 * `pnpm test:webkit` runs it in the matching Playwright image — which is where
 * it runs now, CI having been deleted on 2026-09-18. What this module answers is narrower — whether *this* host is
 * the one known combination where the installed build and the driver that
 * talks to it are different WebKits, so a run there fails for a reason that
 * has nothing to do with the application.
 *
 * Importers spell this module's specifier with its real `.ts` extension.
 * `playwright.config.ts` is loaded by Node's own type stripping in
 * `scripts/playwright-config.test.mjs`, and that resolver reads real paths
 * only — it will not find a `.ts` file behind a `.js` specifier the way the
 * bundlers elsewhere in this repository do.
 *
 * The combination is read rather than assumed. Playwright's own
 * `browsers.json` carries one mainline `revision` and a `revisionOverrides`
 * table pinning some platforms to older builds; where a declared-incompatible
 * platform is pinned *behind* the mainline the driver speaks, every page fails
 * at `browserContext.newPage: Protocol error (Page.overrideSetting): Unknown
 * setting: PushAPIEnabled`. When the pin catches up, or the platform is not
 * pinned, or the manifest cannot be read at all, the answer is `null` and
 * WebKit runs — the skip expires by itself rather than becoming permanent.
 */

/**
 * The host platforms observed to install a WebKit the driver cannot speak to.
 *
 * One entry, and it names a platform rather than an operating system: macOS 14
 * on Apple silicon, where the observed pin is 2251 against a mainline of 2336.
 * Widening this list is how the skip would stop being a known incompatibility
 * and start being a policy, so `playwright-config.test.mjs` bounds its length,
 * proves every other host it names still runs the engine even under a manifest
 * that pins that host's own platform, and refuses a name no host there covers.
 * An addition is therefore a visible edit to that suite or a red run, never a
 * line that lies inert until Playwright pins the platform it names.
 */
export const webkitProtocolIncompatiblePlatforms = ["mac14-arm64"] as const;

export function webkitProtocolIncompatiblePlatformList(): readonly string[] {
  return webkitProtocolIncompatiblePlatforms;
}

export type WebkitManifest = Readonly<{
  revision: string;
  revisionOverrides?: Readonly<Record<string, string>>;
}>;

export type HostDescriptor = Readonly<{
  architecture: string;
  operatingSystem: string;
  release: string;
}>;

/**
 * Playwright's own name for the host it installs a browser build for.
 *
 * Only the macOS spelling has to be exact, because only macOS appears in the
 * declared list; Darwin's major version has run nine ahead of the macOS one
 * since macOS 11. Every other platform is named well enough to be recognised
 * as *not* one of the declared few, which is all this module asks of it.
 */
export function detectHostPlatform(host: HostDescriptor): string {
  if (host.operatingSystem !== "darwin") {
    return `${host.operatingSystem}-${host.architecture}`;
  }

  const darwinMajor = Number(host.release.split(".")[0]);
  const macOS = Number.isFinite(darwinMajor) ? darwinMajor - 9 : 0;

  return host.architecture === "arm64" ? `mac${macOS}-arm64` : `mac${macOS}`;
}

/** The installed `@playwright/test` package manifest, or `null`. */
function playwrightPackagePath(): string | null {
  try {
    return createRequire(import.meta.url).resolve(
      "@playwright/test/package.json",
    );
  } catch {
    return null;
  }
}

/** The WebKit entry of the installed browser manifest, or `null`. */
function installedWebkitManifest(): WebkitManifest | null {
  const packagePath = playwrightPackagePath();
  if (packagePath === null) return null;

  try {
    // `playwright-core` is not a dependency of this workspace, so it is
    // resolved from the package that does depend on it, and `browsers.json`
    // sits beside that package's own manifest rather than behind an export.
    const corePath = createRequire(packagePath).resolve(
      "playwright-core/package.json",
    );
    const manifest = JSON.parse(
      readFileSync(resolve(dirname(corePath), "browsers.json"), "utf8"),
    ) as {
      browsers: {
        name: string;
        revision: string;
        revisionOverrides?: Record<string, string>;
      }[];
    };

    return (
      manifest.browsers.find((browser) => browser.name === "webkit") ?? null
    );
  } catch {
    return null;
  }
}

/** The installed Playwright version, or `unknown`. */
function installedPlaywrightVersion(): string {
  const packagePath = playwrightPackagePath();
  if (packagePath === null) return "unknown";

  try {
    return (
      (JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string })
        .version ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

export type WebkitSupportInput = Readonly<{
  host?: HostDescriptor;
  manifest?: WebkitManifest | null;
  /**
   * The declared incompatible-platform list to consult.
   *
   * Injectable for the same reason the host and the manifest are, and for one
   * more: `null` is the answer both for a platform that is not declared and
   * for a declared platform Playwright does not pin, so a caller that cannot
   * vary the list cannot tell those two apart. That is precisely how a name
   * could be added to the list unnoticed — inert until the day Playwright pins
   * it, and then a mandatory engine quietly leaving the run.
   * `playwright-config.test.mjs` varies the list to prove that the list, not
   * the absence of a pin, is what decides.
   */
  platforms?: readonly string[];
  playwrightVersion?: string;
}>;

/**
 * Why WebKit cannot run on this host, or `null` when it can.
 *
 * The string is the announcement: it names the platform, both revisions, the
 * protocol error a run would otherwise fail with, and the fact that the engine
 * still runs everywhere else. Nothing here is silent — the configuration
 * prints it once, and every skipped case carries it as its reason.
 */
export function webkitProtocolSkipReason(
  input: WebkitSupportInput | null = null,
): string | null {
  const {
    host = {
      architecture: arch(),
      operatingSystem: platform(),
      release: release(),
    },
    manifest = installedWebkitManifest(),
    platforms = webkitProtocolIncompatiblePlatforms as readonly string[],
    playwrightVersion = installedPlaywrightVersion(),
  } = input ?? {};

  if (manifest === null) return null;

  const hostPlatform = detectHostPlatform(host);
  if (!platforms.includes(hostPlatform)) return null;

  const pinned = manifest.revisionOverrides?.[hostPlatform];
  if (pinned === undefined || pinned === manifest.revision) return null;

  return [
    `WebKit acceptance is skipped on ${hostPlatform}.`,
    `Playwright ${playwrightVersion} installs WebKit ${pinned} there while its driver speaks mainline ${manifest.revision},`,
    "so every page fails at `browserContext.newPage: Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled`.",
    "WebKit stays mandatory and still runs on every other platform;",
    "this skip disappears on its own when the pinned revision catches up.",
  ].join(" ");
}
