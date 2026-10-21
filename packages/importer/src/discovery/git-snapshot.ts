import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function sanitizeRepositoryUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const scpLike = /^[^@\s]+@([^:\s]+):([^\s]+)$/u.exec(trimmed);
  if (scpLike?.[1] && scpLike[2]) {
    return `ssh://${scpLike[1]}/${scpLike[2].replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function captureGitSnapshot(root: string) {
  const [{ stdout: top }, { stdout: commit }, { stdout: status }, remote] =
    await Promise.all([
      exec("git", ["-C", root, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }),
      exec("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }),
      exec("git", ["-C", root, "status", "--porcelain=v1"], {
        encoding: "utf8",
      }),
      exec("git", ["-C", root, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
      }).catch(() => ({ stdout: "" })),
    ]);
  return {
    repositoryRoot: top.trim(),
    gitCommitSha: commit.trim(),
    dirty: status.trim().length > 0,
    repositoryUrl: sanitizeRepositoryUrl(remote.stdout),
  };
}
