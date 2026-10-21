import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FOREIGN_HOOK,
  HOOK_MARKER,
  hookBody,
  installGitHooks,
} from "./install-git-hooks.mjs";

function fakeFilesystem(initial = {}) {
  const files = new Map(Object.entries(initial));
  const modes = new Map();

  return {
    files,
    modes,
    exists: (path) => files.has(path),
    read: (path) => files.get(path),
    write: (path, contents) => files.set(path, contents),
    chmod: (path, mode) => modes.set(path, mode),
  };
}

describe("installing the pre-push hook", () => {
  test("writes a hook that delegates to the checked-in source", () => {
    // A shim rather than a copy: the hook a developer installed months ago
    // would otherwise keep running whatever the tree said back then, and
    // nothing would ever tell them the two had diverged.
    const body = hookBody("/repo");

    assert.match(body, /^#!\/bin\/sh/u);
    assert.ok(body.includes(HOOK_MARKER));
    assert.match(body, /scripts\/hooks\/pre-push/u);
  });

  test("installs it executable, and reports what it did", () => {
    const fs = fakeFilesystem();
    const result = installGitHooks({
      hooksDirectory: "/repo/.git/hooks",
      repositoryRoot: "/repo",
      ...fs,
    });

    assert.equal(result.installed, true);
    assert.equal(result.reason, "written");
    assert.ok(fs.files.has("/repo/.git/hooks/pre-push"));
    assert.equal(fs.modes.get("/repo/.git/hooks/pre-push"), 0o755);
  });

  test("is idempotent — installing twice changes nothing and says so", () => {
    const fs = fakeFilesystem();
    const options = {
      hooksDirectory: "/repo/.git/hooks",
      repositoryRoot: "/repo",
      ...fs,
    };

    installGitHooks(options);
    const second = installGitHooks(options);

    assert.equal(second.installed, true);
    assert.equal(second.reason, "already current");
  });

  test("replaces its own older hook rather than leaving it stale", () => {
    const fs = fakeFilesystem({
      "/repo/.git/hooks/pre-push": `#!/bin/sh\n${HOOK_MARKER}\nexec something-older\n`,
    });
    const result = installGitHooks({
      hooksDirectory: "/repo/.git/hooks",
      repositoryRoot: "/repo",
      ...fs,
    });

    assert.equal(result.reason, "written");
    assert.equal(fs.files.get("/repo/.git/hooks/pre-push"), hookBody("/repo"));
  });

  test("refuses to overwrite a hook somebody else wrote", () => {
    // `.git/hooks` is shared by every worktree of this repository and is not
    // ours alone. Clobbering a hook we did not write would silently remove
    // somebody's own tooling, and they would find out by it not running.
    const theirs = "#!/bin/sh\necho my own hook\n";
    const fs = fakeFilesystem({ "/repo/.git/hooks/pre-push": theirs });
    const result = installGitHooks({
      hooksDirectory: "/repo/.git/hooks",
      repositoryRoot: "/repo",
      ...fs,
    });

    assert.equal(result.installed, false);
    assert.equal(result.reason, FOREIGN_HOOK);
    assert.equal(fs.files.get("/repo/.git/hooks/pre-push"), theirs);
  });
});
