import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { createStopSignalHandler } from "./cli.js";

/**
 * The worker's stop handler over a clock the case sets: what it starts, logs
 * and exits with, in order. Nothing here sends a real signal or exits.
 */
function stopHandler() {
  const firstAt = 50_000;
  let clock = firstAt;
  const record: string[] = [];
  const handle = createStopSignalHandler({
    stop: () => record.push("stop"),
    logger: {
      info: (event, fields) =>
        record.push(`info ${event} ${JSON.stringify(fields)}`),
      warn: (event, fields) =>
        record.push(`warn ${event} ${JSON.stringify(fields)}`),
    },
    exit: (code) => record.push(`exit ${code}`),
    now: () => clock,
  });
  return {
    record,
    /** `signal`, arriving `afterMs` after the first signal. */
    send(signal: NodeJS.Signals, afterMs: number) {
      clock = firstAt + afterMs;
      handle(signal);
    },
  };
}

const stopping = (signal: string) =>
  `info worker.stopping {"status":"${signal}"}`;

describe("the worker's stop signals (ruling 246)", () => {
  test.each(["SIGTERM", "SIGINT"] as const)(
    "the first %s logs worker.stopping and starts the drain",
    (signal) => {
      const handler = stopHandler();

      handler.send(signal, 0);

      expect(handler.record).toEqual([stopping(signal.toLowerCase()), "stop"]);
    },
  );

  test.each([0, 999])(
    "a second SIGTERM %i ms after the first is the same stop: it logs worker.stop_repeated with the signal and the milliseconds since the first, and the drain goes on",
    (afterMs) => {
      const handler = stopHandler();

      handler.send("SIGTERM", 0);
      handler.send("SIGTERM", afterMs);

      expect(handler.record).toEqual([
        stopping("sigterm"),
        "stop",
        `info worker.stop_repeated {"status":"sigterm","durationMs":${afterMs}}`,
      ]);
    },
  );

  test("a second SIGTERM 1,000 ms after the first logs worker.forced_exit and exits at once with 1", () => {
    const handler = stopHandler();

    handler.send("SIGTERM", 0);
    handler.send("SIGTERM", 1_000);

    expect(handler.record).toEqual([
      stopping("sigterm"),
      "stop",
      'warn worker.forced_exit {"status":"sigterm"}',
      "exit 1",
    ]);
  });

  test("SIGINT then SIGTERM counts as a repeat: a terminal's Ctrl-C and a SIGTERM passed on are one stop", () => {
    const handler = stopHandler();

    handler.send("SIGINT", 0);
    handler.send("SIGTERM", 12);

    expect(handler.record).toEqual([
      stopping("sigint"),
      "stop",
      'info worker.stop_repeated {"status":"sigterm","durationMs":12}',
    ]);
  });

  test("the second counts from the first signal, not from the last repeat: one at 600 ms is a repeat, one at 1,000 ms exits", () => {
    const handler = stopHandler();

    handler.send("SIGINT", 0);
    handler.send("SIGINT", 600);
    handler.send("SIGINT", 1_000);

    expect(handler.record).toEqual([
      stopping("sigint"),
      "stop",
      'info worker.stop_repeated {"status":"sigint","durationMs":600}',
      'warn worker.forced_exit {"status":"sigint"}',
      "exit 1",
    ]);
  });

  test("requestport-jobs --help says that a second signal within 1 s of the first is the same stop, and a later one exits at once", () => {
    const help = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../bin/requestport-jobs.mjs"), "--help"],
      { encoding: "utf8" },
    );

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(
      `SIGTERM or SIGINT stops claiming work and waits for what is running. Another
SIGTERM or SIGINT less than 1 s after the first is the same stop: a
terminal's Ctrl-C can arrive twice when pnpm or npm runs this from a
script, once from the terminal and once passed on. One 1 s or more after
the first exits at once.
`,
    );
  });
});
