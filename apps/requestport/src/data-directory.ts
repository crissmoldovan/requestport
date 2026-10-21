import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The data directory: where one instance's files are kept (manifest-h.md
 * §2.3), and which directories are refused for it.
 *
 * The default is a per-user application data path, chosen per platform as
 * H.0b fixed it (`spikes/h0-probe/datadir-rule.mjs`; track-h.md, "The data
 * directory, fixed"):
 *
 *   darwin           ~/Library/Application Support/RequestPort
 *   win32            %LOCALAPPDATA%\RequestPort, or <home>\AppData\Local\RequestPort
 *                    when LOCALAPPDATA is unset or not absolute
 *   anything else    $XDG_DATA_HOME/requestport, or ~/.local/share/requestport
 *                    when XDG_DATA_HOME is unset, empty or not absolute
 *
 * Refused, for `--data-dir` and for the default alike: a directory named
 * `.requestport`, or one inside such a directory. That name is the client's:
 * `~/.requestport` holds agents' credentials and token locks
 * (`packages/client/src/credentials.ts`, `token-source.ts`), and a checkout's
 * `.requestport` holds its binding (`packages/client/src/project.ts`). The
 * comparison is of real paths, so a symbolic link does not walk around it
 * (`/var` is `/private/var` on macOS).
 */

/** The application's directory name in each platform's per-user data path. */
export const APPLICATION_NAME = Object.freeze({
  darwin: "RequestPort",
  win32: "RequestPort",
  other: "requestport",
});

/** The client's directory name, as the agent credential store and a checkout's binding use it. */
export const CLIENT_DIRECTORY_NAME = ".requestport";

export type PlatformEnvironment = Readonly<Record<string, string | undefined>>;

export interface PlatformInput {
  platform?: NodeJS.Platform;
  env?: PlatformEnvironment;
  home?: string;
}

/** The default data directory, from its inputs alone: it touches no file. */
export function defaultDataDirectory({
  platform = process.platform,
  env = process.env,
  home = homedir(),
}: PlatformInput = {}): string {
  if (platform === "darwin") {
    return path.posix.join(
      home,
      "Library",
      "Application Support",
      APPLICATION_NAME.darwin,
    );
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base =
      local && path.win32.isAbsolute(local)
        ? local
        : path.win32.join(home, "AppData", "Local");
    return path.win32.join(base, APPLICATION_NAME.win32);
  }
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg && path.posix.isAbsolute(xdg)
      ? xdg
      : path.posix.join(home, ".local", "share");
  return path.posix.join(base, APPLICATION_NAME.other);
}

/**
 * Why a data directory is refused, or `null`. `candidate` and `home` are
 * compared as given, so a caller passes real paths (`resolveDataDirectory`
 * does). A directory inside `<home>/.requestport` is the agent credential
 * store; any other directory named `.requestport`, or inside one, is a
 * checkout's binding. On win32 the name is compared without regard to case,
 * as that platform's file names are.
 */
export function refusedDataDirectory(
  candidate: string,
  {
    platform = process.platform,
    home = homedir(),
  }: { platform?: NodeJS.Platform; home?: string } = {},
): string | null {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  const resolved = flavour.resolve(candidate);
  const credentialStore = flavour.join(
    flavour.resolve(home),
    CLIENT_DIRECTORY_NAME,
  );
  const relative = flavour.relative(credentialStore, resolved);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !flavour.isAbsolute(relative))
  ) {
    return "the agent credential store (~/.requestport)";
  }
  const named = (part: string) =>
    platform === "win32"
      ? part.toLowerCase() === CLIENT_DIRECTORY_NAME
      : part === CLIENT_DIRECTORY_NAME;
  if (resolved.split(flavour.sep).some(named)) {
    return "a checkout's binding (.requestport)";
  }
  return null;
}

export class DataDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDirectoryError";
  }
}

/**
 * The real path of `target`, which need not exist yet: the real path of its
 * nearest existing ancestor, with the rest of `target` joined to it.
 */
export function realPathOf(target: string): string {
  const missing: string[] = [];
  let existing = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export interface ResolvedDataDirectory {
  /** The directory's real path. */
  path: string;
  /** Whether `--data-dir` named it, or it is the platform's default. */
  source: "--data-dir" | "default";
}

/**
 * The data directory a start uses, as a real path, or a `DataDirectoryError`
 * naming why it is refused. `requested` is `--data-dir`'s value, resolved
 * against `cwd`; absent, the platform's default, which is held to the same
 * refusal (H.0b's review: an absolute `XDG_DATA_HOME` or `LOCALAPPDATA`
 * inside `~/.requestport` puts the default there).
 */
export function resolveDataDirectory(
  requested: string | undefined,
  {
    platform = process.platform,
    env = process.env,
    home = homedir(),
    cwd = process.cwd(),
  }: PlatformInput & { cwd?: string } = {},
): ResolvedDataDirectory {
  if (requested !== undefined && requested.trim() === "") {
    throw new DataDirectoryError("--data-dir needs a path.");
  }
  const source = requested === undefined ? "default" : "--data-dir";
  const candidate =
    requested === undefined
      ? defaultDataDirectory({ platform, env, home })
      : path.resolve(cwd, requested);
  const real = realPathOf(candidate);
  const reason = refusedDataDirectory(real, {
    platform,
    home: realPathOf(home),
  });
  if (reason !== null) {
    const named =
      source === "default"
        ? `The default data directory, ${real},`
        : `--data-dir ${real}`;
    throw new DataDirectoryError(
      `${named} is inside ${reason}, which belongs to RequestPort's client. Name another directory with --data-dir <path>.`,
    );
  }
  return { path: real, source };
}

/**
 * Creates the data directory, mode 0700, with any missing parent, or checks
 * the one that exists: a directory, this user's, and closed to group and
 * others, since it holds the instance's secrets. An existing directory that
 * fails is refused with the remedy, never changed. On win32, which has no
 * such modes, it is only created.
 */
export function prepareDataDirectory(
  directory: string,
  { uid = process.getuid?.() }: { uid?: number } = {},
): void {
  const notADirectory = () =>
    new DataDirectoryError(
      `${directory} is not a directory, or a part of its path is a file. Name a directory with --data-dir <path>.`,
    );
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") throw notADirectory();
    throw error;
  }
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) throw notADirectory();
  if (process.platform === "win32") return;
  if (uid !== undefined && stats.uid !== uid) {
    throw new DataDirectoryError(
      `${directory} belongs to another user (uid ${stats.uid}). Name a directory of your own with --data-dir <path>.`,
    );
  }
  const open = stats.mode & 0o077;
  if (open !== 0) {
    throw new DataDirectoryError(
      `${directory} is open to group or others (mode ${(stats.mode & 0o777).toString(8)}), and it holds this instance's secrets. Run \`chmod 700 ${directory}\`, or name another directory with --data-dir <path>.`,
    );
  }
}
