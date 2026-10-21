import { type SpawnOptions, spawn } from "node:child_process";

/**
 * Set to anything but empty, no command opens a browser: the URL is printed
 * on stderr and nothing is launched. For a machine with no browser, and for
 * `requestport mcp` (`mcp-bridge.ts`), which an agent's configuration starts
 * and which takes no flag of `login`'s (track-h.md, H.6's survey, question
 * 2).
 */
export const NO_BROWSER_VARIABLE = "REQUESTPORT_NO_BROWSER";

export type BrowserOpener = (url: string) => void;

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};

export interface BrowserOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: Spawn;
}

/**
 * The program that hands a URL to the person's browser, and its arguments:
 * `open` on macOS, `rundll32 url.dll,FileProtocolHandler` on Windows (no
 * shell, so an `&` in the URL is not a command separator, as it would be
 * after `cmd /c start`), and `xdg-open` elsewhere. Only an http or https URL
 * is handed over; anything else answers `undefined`, because the URL comes
 * from the server's metadata, and `open` would launch whatever a `file:` or
 * an application's own scheme names.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") return undefined;

  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return {
        command: "rundll32",
        args: ["url.dll,FileProtocolHandler", url],
      };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * Opens `url` in the person's browser, and never fails: the URL has already
 * been printed, so a missing program, a headless machine or a launcher that
 * exits non-zero leaves the person to open it themselves. The child is
 * detached and not waited for, and nothing it prints reaches this process's
 * output, which for `requestport mcp` carries the protocol.
 */
export function openBrowser(url: string, options: BrowserOptions = {}): void {
  const command = browserCommand(url, options.platform);
  if (command === undefined) return;

  try {
    const child = (options.spawn ?? spawn)(command.command, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // A program that cannot be started is reported as an event, not thrown.
    // The event's message would name the program and its arguments, the URL
    // among them, so it is not repeated anywhere.
    child.on("error", () => {});
    child.unref();
  } catch {
    // As above: the URL is already with the person.
  }
}

/**
 * The opener a command uses: none when `--no-browser` was given or
 * `REQUESTPORT_NO_BROWSER` is set, `openBrowser` otherwise.
 */
export function browserOpenerFor(
  env: Readonly<Record<string, string | undefined>>,
  noBrowser: boolean,
  options: BrowserOptions = {},
): BrowserOpener | undefined {
  const switchedOff =
    noBrowser ||
    (env[NO_BROWSER_VARIABLE] !== undefined && env[NO_BROWSER_VARIABLE] !== "");
  return switchedOff ? undefined : (url) => openBrowser(url, options);
}
