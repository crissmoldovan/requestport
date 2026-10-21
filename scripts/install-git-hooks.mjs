#!/usr/bin/env node

/**
 * Install the pre-push hook, and be honest about what it is worth.
 *
 * With no CI, the gate a change passes is the one a developer runs. This makes
 * running it the default rather than an act of memory — but it is a reminder,
 * not an enforcement, and the difference matters enough to write down:
 *
 * - it gates `git push` from this machine, and nothing else. Work merges
 *   server-side; the merge commit never passes through here.
 * - `git push --no-verify` skips it, by design, and there is no way to prevent
 *   that from inside a repository.
 * - a second machine, or an edit made in the browser, never sees it.
 * - branch protection could have required a status instead, but this repository
 *   cannot use it: the GitHub API answers 403 "Upgrade to GitHub Pro or make
 *   this repository public" for protection and rulesets alike.
 *
 * So: a helpful default that catches the ordinary mistake, installed by
 * `pnpm install` so a fresh clone gets it without being told.
 *
 * `.git/hooks` is shared by every worktree of a repository — `git rev-parse
 * --git-path hooks` resolves to the common directory from inside a worktree,
 * not to a per-worktree one — so one install covers them all, and clobbering a
 * hook somebody else wrote would take away tooling from all of them at once.
 * That is why a foreign hook is left exactly where it is.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_MARKER =
  "# requestport-pre-push-hook (scripts/install-git-hooks.mjs)";

export const FOREIGN_HOOK =
  "a pre-push hook is already installed and this did not write it";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * A shim, not a copy.
 *
 * A copied hook keeps running whatever the tree said on the day it was
 * installed, and nothing ever reports that the two have diverged. This delegates
 * to the checked-in script, so the hook a developer runs is the hook in the
 * commit they are pushing.
 *
 * It resolves the working tree at run time rather than baking in a path: the
 * same `.git/hooks` serves every worktree, and each has its own root.
 */
export function hookBody() {
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Delegates to the checked-in hook so this file never goes stale.",
    'root="$(git rev-parse --show-toplevel)"',
    'if [ -x "$root/scripts/hooks/pre-push" ]; then',
    '  exec "$root/scripts/hooks/pre-push" "$@"',
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

export function installGitHooks({
  hooksDirectory,
  repositoryRoot: root = repositoryRoot,
  exists = existsSync,
  read = readFileSync,
  write = writeFileSync,
  chmod = chmodSync,
}) {
  const path = resolve(hooksDirectory, "pre-push");
  const wanted = hookBody(root);

  if (exists(path)) {
    const current = String(read(path, "utf8"));

    if (!current.includes(HOOK_MARKER)) {
      return { installed: false, path, reason: FOREIGN_HOOK };
    }

    if (current === wanted) {
      return { installed: true, path, reason: "already current" };
    }
  }

  write(path, wanted, "utf8");
  chmod(path, 0o755);

  return { installed: true, path, reason: "written" };
}

/** Where git keeps this checkout's hooks, asked of git rather than assumed. */
export function resolveHooksDirectory(spawn = spawnSync) {
  const configured = spawn("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8",
  });
  const fromConfig = (configured.stdout ?? "").trim();

  if (fromConfig !== "") return resolve(repositoryRoot, fromConfig);

  const path = spawn("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const resolved = (path.stdout ?? "").trim();

  return resolved === "" ? undefined : resolve(repositoryRoot, resolved);
}

export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const hooksDirectory = resolveHooksDirectory();

  // Installed from `prepare`, so it must never fail an install. Somebody
  // running `pnpm install` outside a git checkout — a tarball, a Docker build —
  // has no hooks directory and does not need one.
  if (hooksDirectory === undefined || !existsSync(hooksDirectory)) {
    process.exit(0);
  }

  const result = installGitHooks({ hooksDirectory });

  if (!result.installed) {
    console.log(
      `Left the existing pre-push hook alone: ${result.reason}.\n` +
        `To use this repository's instead, move ${result.path} aside and run: node scripts/install-git-hooks.mjs`,
    );
    process.exit(0);
  }

  if (result.reason === "written") {
    console.log(`Installed the pre-push hook at ${result.path}.`);
  }
}
