import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  DEFAULT_STORAGE_KEY,
  type DensityLevel,
  type Mode,
  prepaintScript,
  type ThemeName,
} from "@cueplusplus/ui/system";
import { describe, expect, test } from "vitest";

/**
 * The pinned versions and the registry SHA-512 integrities that bind them.
 *
 * registry -> lockfile -> installed package -> manifest -> per-file SHA-256 is
 * one chain with no cycle, and integrity lives outside `manifest.json` so the
 * manifest never self-hashes.
 *
 * The head of that chain moved twice. It was GitHub Packages until that
 * registry began refusing every download for a billing reason; then it was
 * twelve tarballs committed under `vendor/`, whose digests this
 * repository could attest but whose bytes nobody could compare against the
 * published ones. Since 2026-09-16 the packages are on public npm, so the
 * chain is anchored by an attestation again — these two values are what the
 * registry served and what a `--frozen-lockfile` install re-checks.
 */
const pinnedUiVersion = "0.14.1";
const pinnedTokensVersion = "0.14.1";
const publishedUiIntegrity =
  "sha512-cOiRTD23GCc9RRuSY3rBsE23MaA7pMdmzoFZT5hmuzfPTQ9rRwLufXgJtOjrgxA0Au1VaPTuzJYB2Br0oRvVWA==";
const publishedTokensIntegrity =
  "sha512-//FfyrT1eDqTNd68mWS+aeJLQ2rAaMPjBSevQe/tdpcW+DDAFWGa3PjZCWAMXSdRb+E+kxeC6IXhdrY8+XiMsg==";

/**
 * RequestPort's locked appearance axes. The annotations are the proof: these
 * literals only compile while the installed package's public unions still
 * contain every value, so no cast can hide a drifted preset list.
 */
const requestPortThemes: readonly ThemeName[] = [
  "requestport",
  "cue",
  "terminal",
  "signal",
  "venu",
  "hivehub",
  "dusk",
  "luma",
  "snuffle",
];
const requestPortDensities: readonly DensityLevel[] = [
  "ultra-compact",
  "normal",
  "large",
];
const requestPortModes: readonly Mode[] = ["system", "dark", "light"];

const requiredSubpathExports = [
  ".",
  "./styles.css",
  "./manifest.json",
  "./system",
  "./primitives",
  "./forms",
  "./overlays",
  "./chrome",
  "./layout",
  "./layout/resizable",
];

const require = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(webRoot, "../..");
const installedPackageRoot = realpathSync(
  dirname(require.resolve("@cueplusplus/ui/package.json")),
);
const declaredManifestPath = resolve(
  webRoot,
  "node_modules/@cueplusplus/ui/manifest/manifest.json",
);

type ManifestCompanion = { path: string; sha256: string };
type ManifestComponent = ManifestCompanion & {
  name: string;
  slug: string;
  group: string;
  importPath: string;
};
type CueManifest = {
  schemaVersion: number;
  library: string;
  version: string;
  themes: string[];
  densities: string[];
  modes: string[];
  tokens: ManifestCompanion;
  components: ManifestComponent[];
};

/**
 * The only accepted manifest source is a file inside the installed package.
 * A URL, a repository-relative documentation copy, or a companion document
 * that escapes the package directory is rejected before it is ever read.
 */
function assertInsideInstalledPackage(path: string): void {
  const contained = relative(installedPackageRoot, path);

  if (
    contained === "" ||
    contained.startsWith("..") ||
    isAbsolute(contained) ||
    contained.split(sep).includes("node_modules")
  ) {
    throw new Error("cue-manifest-source-must-stay-inside-the-package");
  }
}

function resolvePackageLocalSource(source: string): string {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) {
    throw new Error("cue-manifest-source-must-not-be-a-url");
  }

  const resolved = isAbsolute(source)
    ? resolve(source)
    : resolve(installedPackageRoot, source);

  // Containment is checked lexically first, so an escaping path is rejected
  // before the filesystem is touched at all.
  assertInsideInstalledPackage(resolved);

  if (!existsSync(resolved)) {
    throw new Error("cue-manifest-source-must-exist");
  }

  const real = realpathSync(resolved);

  // Then again after symlink resolution, so a link cannot smuggle a document
  // in from outside the installed package.
  assertInsideInstalledPackage(real);

  return real;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readLockfileIntegrity(
  lockfile: string,
  specifier: string,
): string | undefined {
  const lines = lockfile.split("\n");
  const index = lines.findIndex(
    (line) =>
      line.trim() === `${specifier}:` || line.trim() === `'${specifier}':`,
  );

  if (index === -1) {
    return undefined;
  }

  for (const line of lines.slice(index + 1, index + 8)) {
    const match =
      /^\s+resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)[,}]/u.exec(line);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

const manifestPath = resolvePackageLocalSource(
  require.resolve("@cueplusplus/ui/manifest.json"),
);
const manifestDirectory = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CueManifest;
const installedUiPackage = JSON.parse(
  readFileSync(resolve(installedPackageRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
};
const lockfile = readFileSync(
  resolve(repositoryRoot, "pnpm-lock.yaml"),
  "utf8",
);

describe("installed CUE++ package manifest boundary", () => {
  test("loads the manifest from the installed package, never a floating copy", () => {
    expect(existsSync(declaredManifestPath)).toBe(true);
    expect(realpathSync(declaredManifestPath)).toBe(manifestPath);
    expect(manifestDirectory).toBe(resolve(installedPackageRoot, "manifest"));
    expect(manifest.library).toBe("@cueplusplus/ui");
    expect(manifest.schemaVersion).toBe(2);
  });

  test("rejects a URL, a missing file, and a document outside the package", () => {
    expect(() =>
      resolvePackageLocalSource("https://example.com/r/manifest.json"),
    ).toThrow("cue-manifest-source-must-not-be-a-url");
    expect(() =>
      resolvePackageLocalSource("http://localhost/manifest.json"),
    ).toThrow("cue-manifest-source-must-not-be-a-url");
    expect(() => resolvePackageLocalSource("manifest/absent.json")).toThrow(
      "cue-manifest-source-must-exist",
    );
    expect(() =>
      resolvePackageLocalSource(resolve(repositoryRoot, "package.json")),
    ).toThrow("cue-manifest-source-must-stay-inside-the-package");
  });

  test("binds the declared manifest version to the installed package version", () => {
    expect(installedUiPackage.name).toBe("@cueplusplus/ui");
    expect(installedUiPackage.version).toBe(pinnedUiVersion);
    expect(manifest.version).toBe(pinnedUiVersion);
    expect(installedUiPackage.dependencies["@cueplusplus/tokens"]).toBe(
      pinnedTokensVersion,
    );
  });

  test("matches the published registry integrity through the lockfile", () => {
    // What a `--frozen-lockfile` install re-checks on every machine, including
    // Vercel's. While the packages were vendored this could only compare a
    // digest of a file in this repository against itself; the registry is an
    // attestation by somebody else, which is the part that was missing.
    expect(
      readLockfileIntegrity(lockfile, `@cueplusplus/ui@${pinnedUiVersion}`),
    ).toBe(publishedUiIntegrity);
    expect(
      readLockfileIntegrity(
        lockfile,
        `@cueplusplus/tokens@${pinnedTokensVersion}`,
      ),
    ).toBe(publishedTokensIntegrity);
  });

  test("verifies every companion document against its manifest SHA-256", () => {
    expect(manifest.components.length).toBeGreaterThan(0);

    const tokensPath = resolvePackageLocalSource(
      resolve(manifestDirectory, manifest.tokens.path),
    );
    expect(sha256(tokensPath)).toBe(manifest.tokens.sha256);

    const mismatched = manifest.components.filter((component) => {
      const path = resolvePackageLocalSource(
        resolve(manifestDirectory, component.path),
      );
      return sha256(path) !== component.sha256;
    });

    expect(mismatched.map((component) => component.name)).toEqual([]);
  });

  test("declares every token the document names in the shipped theme layer", () => {
    // The audit reads its shadow guard out of the stylesheet chain rather than
    // out of this document, because the document lists only the names the
    // Tailwind bridge maps and the layer declares more. That leaves one drift
    // this suite has to hold from the other side: a document that names a token
    // the package no longer ships would put a name in the guard that nothing
    // publishes, and nothing else would ever say so.
    // Since 0.9.0 the layer is three files: the blank base, the axes it
    // imports, and the theme package that fills the base in.
    const packageRequire = createRequire(
      resolve(installedPackageRoot, "package.json"),
    );
    const themeCss = [
      packageRequire.resolve("@cueplusplus/theme-base/base.css"),
      packageRequire.resolve("@cueplusplus/tokens/axes.css"),
      require.resolve("@requestport/theme/theme.css"),
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const tokenDocument = JSON.parse(
      readFileSync(resolve(manifestDirectory, manifest.tokens.path), "utf8"),
    ) as { colorTokens: string[]; geometryTokens: string[] };
    const declared = new Set(
      [...themeCss.matchAll(/(--cue-[a-z0-9-]+)\s*:/gu)].map(
        (match) => match[1] ?? "",
      ),
    );

    expect(declared.has("--cue-focus-ring")).toBe(true);
    expect(
      [...tokenDocument.colorTokens, ...tokenDocument.geometryTokens].filter(
        (name) => !declared.has(name),
      ),
    ).toEqual([]);
  });

  test("keeps every component document inside the installed package", () => {
    const escaping = manifest.components.filter((component) => {
      try {
        resolvePackageLocalSource(resolve(manifestDirectory, component.path));
        return false;
      } catch {
        return true;
      }
    });

    expect(escaping.map((component) => component.name)).toEqual([]);
    expect(() =>
      resolvePackageLocalSource(
        resolve(manifestDirectory, "../../../package.json"),
      ),
    ).toThrow("cue-manifest-source-must-stay-inside-the-package");
  });
});

describe("RequestPort appearance axes resolve against the installed package", () => {
  test("declares nine RequestPort themes, eight of them the package's", () => {
    expect(requestPortThemes).toHaveLength(9);
    expect(new Set(requestPortThemes).size).toBe(9);

    // The ninth is RequestPort's own, in `packages/theme`, and the design
    // system's manifest is deliberately not asked about it: cueplusplus/cue-ui#121
    // asks for every product theme to leave that repository, and this suite
    // must not fail when it does. The other eight are still its packages, and
    // a theme this application registers that the package never shipped would
    // paint nothing.
    for (const theme of requestPortThemes) {
      if (theme === "requestport") continue;
      expect(manifest.themes).toContain(theme);
    }
  });

  test("declares three RequestPort densities present in the manifest", () => {
    expect(requestPortDensities).toHaveLength(3);

    for (const density of requestPortDensities) {
      expect(manifest.densities).toContain(density);
    }
  });

  test("declares exactly the three published modes", () => {
    expect([...requestPortModes].sort()).toEqual([...manifest.modes].sort());
    expect(requestPortModes).toHaveLength(3);
  });
});

describe("installed CUE++ exports and stylesheet", () => {
  test("exposes every subpath RequestPort will import", () => {
    for (const subpath of requiredSubpathExports) {
      expect(Object.keys(installedUiPackage.exports)).toContain(subpath);
    }
  });

  test("ships the blank base ahead of the Tailwind token bridge", () => {
    const stylesheetPath = resolvePackageLocalSource(
      require.resolve("@cueplusplus/ui/styles.css"),
    );
    const stylesheet = readFileSync(stylesheetPath, "utf8");
    const themeImport = stylesheet.indexOf(
      '@import "@cueplusplus/theme-base/base.css";',
    );
    const tailwindImport = stylesheet.indexOf(
      '@import "@cueplusplus/tokens/tailwind.css";',
    );

    expect(themeImport).toBeGreaterThan(-1);
    expect(tailwindImport).toBeGreaterThan(themeImport);
    expect(stylesheet).toContain('@source "./";');
  });

  test("publishes the RequestPort theme, its system-mode selectors, and the density rungs", () => {
    const themeCss = readFileSync(
      require.resolve("@requestport/theme/theme.css"),
      "utf8",
    );
    const axesCss = readFileSync(
      require.resolve("@cueplusplus/tokens/axes.css"),
      "utf8",
    );

    expect(themeCss).toContain('[data-theme="requestport"] {');
    expect(themeCss).toContain(
      '[data-theme="requestport"][data-mode="light"] {',
    );
    expect(themeCss).toContain(
      '[data-theme="requestport"][data-mode="system"] {',
    );

    for (const density of requestPortDensities) {
      expect(axesCss).toContain(`[data-density="${density}"] {`);
    }
  });
});

describe("authoritative pre-paint contract", () => {
  test("publishes the shared default storage key", () => {
    expect(DEFAULT_STORAGE_KEY).toBe("cue-ui");
  });

  test("stamps the server triple without reading storage", () => {
    const script = prepaintScript({
      storageKey: DEFAULT_STORAGE_KEY,
      defaults: {
        theme: "requestport",
        density: "ultra-compact",
        mode: "system",
      },
      readStoredPreferences: false,
    });

    expect(script).toContain('"requestport"');
    expect(script).toContain('"ultra-compact"');
    expect(script).toContain('"system"');
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("</script>");
    // Every embedded value is escaped, so no stamped enum can close the host
    // script element.
    expect(script).not.toContain("<");
  });

  test("reads storage only when the caller asks it to", () => {
    const permissive = prepaintScript({
      storageKey: DEFAULT_STORAGE_KEY,
      defaults: {
        theme: "requestport",
        density: "ultra-compact",
        mode: "system",
      },
    });

    expect(permissive).toContain("localStorage");
  });
});
