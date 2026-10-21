import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The harness each child runs (`child.mjs`, beside this file). */
const HARNESS = fileURLToPath(new URL("./child.mjs", import.meta.url));

export type ChildResult = {
  readonly code: number | null;
  readonly lines: readonly Record<string, unknown>[];
  readonly stderr: string;
};

export type Child = {
  /** Resolves with the first line `matches` accepts, or rejects on exit. */
  line(
    matches: (line: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  readonly exited: Promise<ChildResult>;
};

/**
 * Start one scenario of `child.mjs` in a new Node process. Its stdout is read
 * as one JSON object per line; anything else on it fails the line's parse,
 * and so the test.
 */
export function startChild(scenario: string, input: unknown): Child {
  const child = spawn(
    process.execPath,
    [HARNESS, scenario, JSON.stringify(input)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const lines: Record<string, unknown>[] = [];
  const waiting: Array<{
    matches: (line: Record<string, unknown>) => boolean;
    resolve: (line: Record<string, unknown>) => void;
  }> = [];
  let stderr = "";
  let pending = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf("\n");
      if (end === -1) break;
      const line = JSON.parse(pending.slice(0, end)) as Record<string, unknown>;
      pending = pending.slice(end + 1);
      lines.push(line);
      for (const waiter of waiting.filter((each) => each.matches(line))) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<ChildResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, lines, stderr }));
  });

  return {
    exited,
    line(matches) {
      const seen = lines.find(matches);
      if (seen !== undefined) return Promise.resolve(seen);

      return new Promise((resolve, reject) => {
        waiting.push({ matches, resolve });
        exited.then(
          (result) =>
            reject(
              new Error(
                `the child exited (${result.code}) before that line: ${result.stderr}`,
              ),
            ),
          reject,
        );
      });
    },
  };
}
