import { homedir } from "node:os";
import { join } from "node:path";

import {
  type CommandRunner,
  CREDENTIAL_DIRECTORY,
  type CredentialStore,
  createCredentialStore,
} from "@requestport/client/credentials";

/**
 * Which store the agent commands keep credentials in: `file` (the file under
 * the home directory), `keychain` (the macOS login keychain), or, unset or
 * empty, `@requestport/client`'s own choice, which is the keychain wherever
 * `security list-keychains -d user` answers and the file elsewhere.
 *
 * An environment variable rather than a flag, so that every agent command
 * reads the same one, `requestport mcp` (`mcp-bridge.ts`) included, which an
 * agent's configuration starts (track-h.md, H.6's survey, question 1).
 */
export const CREDENTIAL_STORE_VARIABLE = "REQUESTPORT_CREDENTIAL_STORE";

export type CredentialStoreChoice = "auto" | "file" | "keychain";

/** The variable holds something other than `file` or `keychain`. */
export class CredentialStoreChoiceError extends Error {
  constructor() {
    // The value is not repeated: whatever was put there in its place may be
    // a secret.
    super(
      `${CREDENTIAL_STORE_VARIABLE} must be "file" or "keychain", or unset for the automatic choice.`,
    );
    this.name = "CredentialStoreChoiceError";
  }
}

export function credentialStoreChoice(
  env: Readonly<Record<string, string | undefined>>,
): CredentialStoreChoice {
  const value = env[CREDENTIAL_STORE_VARIABLE];
  if (value === undefined || value === "") return "auto";
  if (value === "file" || value === "keychain") return value;
  throw new CredentialStoreChoiceError();
}

/**
 * The home directory as this command's environment names it: `HOME`, or
 * `USERPROFILE` on Windows, and `os.homedir()` when that is unset or empty.
 * A command is handed its environment rather than reading the process's, so
 * the file store, which defaults to `os.homedir()`, is given this instead.
 */
export function homeDirectory(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const named = platform === "win32" ? env.USERPROFILE : env.HOME;
  return named !== undefined && named !== "" ? named : homedir();
}

export interface CommandCredentialStoreOptions {
  /** For tests: the platform the automatic choice asks about. */
  readonly platform?: NodeJS.Platform;
  /** For tests: how `security` is run, so no test reaches a real keychain. */
  readonly run?: CommandRunner;
}

/**
 * The credential store every agent command uses, chosen by
 * `REQUESTPORT_CREDENTIAL_STORE`, with the file store under the environment's
 * home directory.
 */
export function commandCredentialStore(
  env: Readonly<Record<string, string | undefined>>,
  options: CommandCredentialStoreOptions = {},
): CredentialStore {
  const platform = options.platform ?? process.platform;
  return createCredentialStore({
    home: homeDirectory(env, platform),
    platform,
    prefer: credentialStoreChoice(env),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
}

/**
 * Where the agent commands' token sources over that store keep their locks:
 * `locks` in the credential directory under the environment's home
 * directory. A token source given no lock directory uses the same path
 * under `os.homedir()` (`@requestport/client/token-source`), which reads
 * `HOME` on macOS and Linux and `USERPROFILE` on Windows when it is set; so
 * with the process's own environment, that variable set and not empty, the
 * two are one directory, and their locks are shared.
 */
export function commandLockDirectory(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(homeDirectory(env, platform), CREDENTIAL_DIRECTORY, "locks");
}
