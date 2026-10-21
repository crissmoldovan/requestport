/* The types of `bundle.mjs`, for the TypeScript that imports it. */
import type { Metafile } from "esbuild";

/** One entry of a bundle: a subpath of the package it builds. */
export interface BundleEntry {
  /** The subpath, as a manifest's `exports` names it. */
  readonly subpath: string;
  /** Its output's file name in `dist/`, without the extension. */
  readonly name: string;
  /** Its source, from the repository's root. */
  readonly source: string;
}

export interface Bundle {
  readonly entries: readonly BundleEntry[];
  /** The `@requestport/*` packages left external, not inlined. */
  readonly external: readonly string[];
  /** The tsc project that emits its declarations, from the repository's root. */
  readonly declarations: string | undefined;
  /**
   * Each private module the bundle builds as its public variant, both by
   * path from the repository's root; without it, each module as it is.
   */
  readonly publicVariants?: Readonly<Record<string, string>>;
  /**
   * Each test seam's real module the bundle's JavaScript builds as its inert
   * module, both by path from the repository's root; without it, each module
   * as it is.
   */
  readonly inertSeams?: Readonly<Record<string, string>>;
}

/** A row of `bundles`: a package of the set, or `auth`, `mcp` or `server`. */
export interface PackageBundle extends Bundle {
  /** The package it builds, as its source manifest names it. */
  readonly package: string;
  /** The modules of other packages it may inline, from the repository's root. */
  readonly inlines: readonly string[];
  /** `publicVariants`, which every row names (ruling 183 item 9). */
  readonly publicVariants: Readonly<Record<string, string>>;
  /** `inertSeams`, which every row names (rulings 174, 190 and 193). */
  readonly inertSeams: Readonly<Record<string, string>>;
}

/** The rows of `bundles`, in the order `buildOrder` is given them in. */
export type BundleName =
  | "domain"
  | "notifications"
  | "webhooks"
  | "importer"
  | "config"
  | "db"
  | "jobs"
  | "core"
  | "auth"
  | "mcp"
  | "server";

/** A test seam of `testSeams`. */
export interface TestSeam {
  /** What the seam is, as a refusal names it. */
  readonly name: string;
  /** The real module, by its path from the repository's root. */
  readonly real: string;
  /** The inert module the builds put in its place, from the repository's root. */
  readonly inert: string;
  /**
   * Text that shows the real module in a build: of the repository's source,
   * held by the real module alone, a path by none, but E2E mode's two
   * variables, which other E2E modules hold too.
   */
  readonly markers: readonly string[];
}

/** A seam's marker that a text holds, with its seam. */
export interface SeamMarker {
  readonly seam: TestSeam;
  readonly marker: string;
}

/** An entry of `forbiddenModules`. */
export interface ForbiddenModule {
  /** The module, by its path from the repository's root. */
  readonly module: string;
  /** Why no bundle, or no bundle but `publishedBy`'s, may inline it. */
  readonly reason: string;
  /** The package whose own bundle may inline it, when one may. */
  readonly publishedBy?: string;
}

export declare const repositoryRoot: string;
export declare const packageSet: readonly string[];
export declare const hostPackages: readonly string[];
export declare const bundles: Readonly<Record<BundleName, PackageBundle>>;
export declare const publicVariants: Readonly<Record<string, string>>;
export declare const testSeams: readonly TestSeam[];
export declare function seamMarkersIn(text: string): SeamMarker[];
export declare const inertSeams: Readonly<Record<string, string>>;
export declare function publicVariantOf(
  bundle: Bundle,
  module: string,
): string | undefined;
export declare function inertSeamOf(
  bundle: Bundle,
  module: string,
): string | undefined;
/** A doc comment of a private module that its public variant does not hold. */
export interface PrivateDocComment {
  readonly module: string;
  readonly variant: string;
  readonly comment: string;
}
export declare function privateDocComments(
  variants?: Readonly<Record<string, string>>,
): PrivateDocComment[];
export declare function holdsDocComment(text: string, comment: string): boolean;
export declare function testOnlyModule(path: string): boolean;
export declare const forbiddenModules: readonly ForbiddenModule[];
export declare function forbiddenModule(path: string, packed?: string): boolean;
export declare function packageName(specifier: string): string;
export declare function isExternal(bundle: Bundle, specifier: string): boolean;
export declare function buildBundle(
  bundle: Bundle,
  packageDirectory: string,
): Promise<{ metafile: Metafile; declarations: string[] }>;
export declare function buildPackage(
  bundle: PackageBundle,
  packageDirectory: string,
): Promise<{ metafile: Metafile; declarations: string[] }>;
export declare function siblingProblems(
  bundle: PackageBundle,
  metafile: Metafile,
  dist: string,
  declarations: readonly string[],
): Promise<string[]>;
export declare function buildOrder(
  set?: Readonly<Record<string, PackageBundle>>,
): string[];
export declare function topologicalOrder(
  graph: ReadonlyArray<readonly [string, readonly string[]]>,
): string[];
