import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acceptanceReportDirectory } from "../apps/web/tests/fixtures/acceptance-report.ts";
import {
  createE2ERunDirectory,
  E2E_RUN_DIRECTORY_VARIABLE,
} from "../apps/web/tests/fixtures/e2e-run-directory.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CHILD_START_FAILURE = "RequestPort E2E command failed to start.";

/**
 * The acceptance lanes, in the order they run.
 *
 * `apps/web/playwright.config.ts` partitions the tree into these four
 * projects, but a partition is only a shard if the lanes run as separate
 * units: `playwright test` with no `--project` runs all four in one process,
 * under one run-wide `globalTimeout`, which is how CI run 33190770436 was
 * cancelled naming no failing case. One child per lane gives each
 * its own process, its own dev server and its own measured budget, so a lane
 * that stops making progress is reported by Playwright — which knows the case
 * — rather than by the workflow, which does not.
 *
 * They run one after another rather than together: every lane starts its own
 * server on the same fixed loopback port, so two at once would collide.
 */
export const FOUNDATION_E2E_LANES = Object.freeze([
  "appearance-chromium",
  "route-state-chromium",
  "appearance-webkit",
  "route-state-webkit",
]);

/**
 * Removes the reports of the lanes this run is about to answer for.
 *
 * Each lane writes one file there, so a file an earlier run left behind is
 * indistinguishable from an answer this run gave — and a lane that never
 * started would be read with the previous run's outcome for it.
 *
 * Scoped to the lanes rather than emptying the directory, which is what it did
 * while a run was always every lane. Once a run could be a subset — `pnpm
 * test:e2e <lane>`, and `pnpm test:webkit`, which runs the WebKit lanes in a
 * container — emptying it meant a long WebKit run's reports were deleted by the
 * next `verify-locally --e2e`, a run that never touched those lanes and had
 * nothing to put in their place.
 *
 * The cost is the other half of the same coin, and it is real: after a subset
 * run this directory holds this run's answers beside an earlier run's for the
 * lanes this one did not run, and nothing in a report says which run wrote it.
 * A full set of files is therefore no longer evidence of a single run. Nothing
 * reads them that way today — `scripts/write-run-evidence.mjs` was deleted with
 * the rest of the CI-era tooling — and anything that replaces it must stamp the
 * commit and start time onto each report rather than trust the set, because the
 * alternative is the whole-directory reset that deleted a WebKit run's reports.
 */
export function resetFoundationE2EReports(
  lanes = FOUNDATION_E2E_LANES,
  directory = acceptanceReportDirectory,
) {
  mkdirSync(directory, { recursive: true });

  for (const lane of lanes) {
    rmSync(resolve(directory, `${lane}.json`), { force: true });
  }

  // A process asked for no shard answers for every lane and writes `all.json`.
  // Any run at all makes that stale, and neither the per-lane removal above nor
  // the WebKit runner's own clearing would ever touch it — so it outlived every
  // later run and stayed readable as one of them.
  rmSync(resolve(directory, "all.json"), { force: true });
}

export function createFoundationE2EEnvironment({
  baseEnvironment = process.env,
  createToken = () => randomBytes(32).toString("base64url"),
} = {}) {
  const token = createToken();
  if (typeof token !== "string" || token.length < 32) {
    throw new Error(CHILD_START_FAILURE);
  }
  return {
    ...baseEnvironment,
    NODE_ENV: "test",
    REQUESTPORT_E2E_MODE: "1",
    REQUESTPORT_E2E_TOKEN: token,
  };
}

/**
 * The exact argv one lane runs as.
 *
 * Still through the package's own `test:e2e` script, so the checked-in entry
 * point stays the only way this suite is launched; the lane is named on the
 * command line rather than through the environment, because `--project` is
 * what makes Playwright run that partition and nothing else.
 */
const REPEAT_FLAG = "--repeat-each=";

export function buildLaneCommand(lane, repeatEach) {
  if (!FOUNDATION_E2E_LANES.includes(lane)) {
    throw new Error(CHILD_START_FAILURE);
  }
  return {
    args: [
      "--filter",
      "@requestport/web",
      "run",
      "test:e2e",
      "--project",
      lane,
      // Omitted entirely rather than passed as a repeat of one, so an
      // ordinary run's argv is the argv it has always been and a repeat is
      // visible in the process list of the run that asked for one.
      ...(repeatEach === undefined ? [] : [`--repeat-each=${repeatEach}`]),
    ],
    command: "pnpm",
  };
}

/**
 * How many times each case in a lane runs, read from the command line.
 *
 * An intermittent failure is measured by repetition, and repeating the whole
 * command repeats the build with it: in the Playwright image the build is most
 * of the cost and the lane is minutes of it. `--repeat-each` buys the
 * repetitions without buying the builds.
 *
 * Refused rather than ignored when it is malformed. `lanesFrom` drops every
 * flag, so a mistyped count would fall through to a single pass and report a
 * green loop for a repeat nobody ran — the same answer a mistyped lane name is
 * already refused for, and the reason that refusal exists.
 */
export function repeatFrom(argv = []) {
  const flag = argv.find((argument) => argument.startsWith(REPEAT_FLAG));

  if (flag === undefined) return undefined;

  const value = flag.slice(REPEAT_FLAG.length);

  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(
      `Unusable ${REPEAT_FLAG}${value}: a repeat must be a positive whole number.`,
    );
  }

  return Number(value);
}

/**
 * Runs one lane, and keeps what it said.
 *
 * `stdio` is piped rather than inherited so the output can go to two places at
 * once: the terminal, where a person is watching, and a file, where it is
 * still readable tomorrow. Everything the lane printed is in that file,
 * including the `[WebServer]` lines — a refusal's reason is written to the
 * server log and nowhere else, so a run whose only record was the terminal
 * could be diagnosed only by reproducing it.
 */
function spawnLane(lane, repeatEach, runDirectory) {
  const { args, command } = buildLaneCommand(lane, repeatEach);
  const environment = createFoundationE2EEnvironment();
  if (runDirectory) {
    environment[E2E_RUN_DIRECTORY_VARIABLE] = runDirectory;
  }
  const child = spawn(command, args, {
    env: environment,
    stdio: runDirectory ? ["inherit", "pipe", "pipe"] : "inherit",
  });

  if (runDirectory) {
    /*
      Copied with `write`, never with `pipe`.

      `pipe` honours backpressure by pausing its source, and the source here is
      the lane's own stdout: a slow sink therefore stops the child from
      writing, and a process blocked on a write is a process not serving the
      page the browser is waiting for. That is not theoretical — piping this
      output is what made an acceptance case fail on a duplicated control,
      which is what React leaves behind when a render is interrupted and it
      recovers by re-rendering over the server's markup. The case passed on the
      same commit the moment the output was inherited instead.

      Ignoring the return of `write` drops backpressure on purpose. The cost is
      memory if a sink cannot keep up; the cost of the alternative is stalling
      the run being measured, which corrupts the measurement.
    */
    const log = createWriteStream(resolve(runDirectory, `${lane}.log`), {
      flags: "a",
    });
    const copy = (source, sink) => {
      source?.on("data", (chunk) => {
        sink.write(chunk);
        log.write(chunk);
      });
    };
    copy(child.stdout, process.stdout);
    copy(child.stderr, process.stderr);
    child.once("close", () => log.end());
  }

  return new Promise((resolveLane) => {
    let settled = false;
    const finish = (exitCode, message) => {
      if (settled) return;
      settled = true;
      if (message) console.error(message);
      resolveLane(exitCode);
    };

    child.once("error", () => finish(1, CHILD_START_FAILURE));
    child.once("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Brings a lane's artefacts into the run that produced them.
 *
 * They are copied rather than written there directly: `outputDir` is emptied
 * by Playwright at the start of a run, and `run-webkit-lanes.mjs` clears a
 * lane's artefacts by that same path, so the two are coupled and moving one
 * silently breaks the other. Copying leaves both where they are and still puts
 * everything one run produced under one directory.
 */
export function collectLaneArtifacts(lane, runDirectory) {
  if (!runDirectory) return;

  const root = resolve(repositoryRoot, "apps/web/test-results");
  if (!existsSync(root)) return;

  /*
    A failing case's screenshot and trace are not in the lane's directory.

    `outputDir` is named for the lane, but Playwright writes each failing case
    into a sibling directory named for the case and ending in the project —
    the config's own docblock says the per-lane directory "receives almost
    nothing". Copying only the lane's directory therefore collected a
    `.last-run.json` and nothing a person could look at, which is the opposite
    of what a kept result is for.
  */
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== lane && !entry.name.endsWith(`-${lane}`)) continue;

    cpSync(
      resolve(root, entry.name),
      resolve(runDirectory, "artifacts", entry.name),
      { recursive: true },
    );
  }
}

/** The commit a run answered for, or `unknown` outside a repository. */
function headRevision() {
  const answered = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  return answered.status === 0 ? answered.stdout.trim() : "unknown";
}

/** Whether the tree the run was made from had uncommitted changes. */
function workingTreeIsDirty() {
  const answered = spawnSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  return answered.status === 0 ? answered.stdout.trim() !== "" : null;
}

/** The per-lane counts Playwright recorded, read back from its own reports. */
function laneOutcomes(runDirectory) {
  const outcomes = [];

  for (const entry of readdirSync(runDirectory).toSorted()) {
    if (!entry.endsWith(".report.json")) continue;

    try {
      const report = JSON.parse(
        readFileSync(resolve(runDirectory, entry), "utf8"),
      );
      const stats = report.stats ?? {};
      outcomes.push({
        lanes: entry.slice(0, -".report.json".length),
        expected: stats.expected ?? 0,
        unexpected: stats.unexpected ?? 0,
        flaky: stats.flaky ?? 0,
        skipped: stats.skipped ?? 0,
        durationMs: Math.round(stats.duration ?? 0),
      });
    } catch {
      // A report that cannot be read is itself the result worth recording:
      // the lane either died before writing one or wrote something partial.
      outcomes.push({ lanes: entry, unreadable: true });
    }
  }

  return outcomes;
}

/**
 * Writes the result of a run, every time, whatever the run did.
 *
 * A run that fails early is the one whose record matters most, so this is
 * called from a `finally` rather than after a success. The counts are read
 * back from Playwright's own reports instead of being tallied here, so the
 * summary cannot disagree with them.
 */
export function recordE2ERunSummary(
  runDirectory,
  { lanes, startedAt, exitCode },
) {
  if (!runDirectory) return;

  const outcomes = laneOutcomes(runDirectory);
  const finishedAt = new Date();
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    commit: headRevision(),
    dirtyWorkingTree: workingTreeIsDirty(),
    lanesRequested: [...lanes],
    lanesReported: outcomes,
    exitCode,
    passed: exitCode === 0,
  };

  writeFileSync(
    resolve(runDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  const rows = outcomes
    .map((outcome) =>
      outcome.unreadable
        ? `| ${outcome.lanes} | unreadable report | | | |`
        : `| ${outcome.lanes} | ${outcome.expected} | ${outcome.unexpected} | ${outcome.flaky} | ${outcome.skipped} |`,
    )
    .join("\n");

  writeFileSync(
    resolve(runDirectory, "summary.md"),
    [
      `# Acceptance run ${summary.startedAt}`,
      "",
      `- result: **${summary.passed ? "passed" : `failed (exit ${exitCode})`}**`,
      `- commit: \`${summary.commit}\`${summary.dirtyWorkingTree ? " (working tree dirty)" : ""}`,
      `- lanes requested: ${summary.lanesRequested.join(", ") || "(none)"}`,
      `- duration: ${Math.round(summary.durationMs / 1000)}s`,
      "",
      "| lanes | passed | failed | flaky | skipped |",
      "| --- | --- | --- | --- | --- |",
      rows || "| (no report was written) | | | | |",
      "",
      "Each lane's full output is beside this file as `<lane>.log`, its",
      "machine-readable report as `<lanes>.report.json`, and any screenshots or",
      "traces under `artifacts/`.",
      "",
    ].join("\n"),
  );

  console.error(`RequestPort E2E result: ${runDirectory}`);
}

/**
 * Runs every lane, stopping at the first one that fails.
 *
 * A failed lane has already named the case that failed, and the lanes after it
 * would spend another three budgets to say nothing more.
 *
 * The lane is named on the way out. Each child runs under that shard's own
 * budget, so an overrun is an overrun of that shard — but Playwright reports a
 * timeout without knowing which of the four partitions it was asked to be, and
 * this loop is the only place that does.
 */
export async function runFoundationE2ELanes({
  lanes = FOUNDATION_E2E_LANES,
  repeatEach,
  resetReports = resetFoundationE2EReports,
  runLane = spawnLane,
  runDirectory,
  recordSummary = recordE2ERunSummary,
} = {}) {
  resetReports(lanes);

  const startedAt = new Date();
  let exitCode = 0;

  try {
    for (const lane of lanes) {
      exitCode = await runLane(lane, repeatEach, runDirectory);
      collectLaneArtifacts(lane, runDirectory);

      if (exitCode !== 0) {
        console.error(`RequestPort E2E lane ${lane} failed.`);

        return exitCode;
      }
    }

    return 0;
  } finally {
    // In a `finally`, because the run that fails early is the one whose record
    // matters most — and because a lane that throws would otherwise leave a
    // directory holding logs nobody wrote a verdict for.
    recordSummary(runDirectory, { lanes, startedAt, exitCode });
  }
}

/**
 * The lanes a run was asked for, or all of them.
 *
 * Named rather than numbered, and an unknown name is refused rather than
 * skipped: a typo that silently ran three lanes instead of four would report a
 * pass for a partition nobody exercised, which is the one answer this must
 * never give. Flags are ignored so a caller can pass `--` separators through.
 */
export function lanesFrom(argv = [], all = FOUNDATION_E2E_LANES) {
  const named = argv.filter((argument) => !argument.startsWith("-"));

  if (named.length === 0) return all;

  const unknown = named.filter((lane) => !all.includes(lane));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown acceptance lane(s): ${unknown.join(", ")}. Known lanes: ${all.join(", ")}.`,
    );
  }

  return named;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Selected before the promise chain, and reported here: thrown inside the
  // call expression it escaped the `.catch` below entirely, so a mistyped lane
  // surfaced as an uncaught stack trace rather than as the sentence it
  // composed naming the lanes that exist.
  let lanes;
  let repeatEach;
  try {
    lanes = lanesFrom(process.argv.slice(2));
    repeatEach = repeatFrom(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // Cleared, because a repeat refused *after* the lanes parsed would
    // otherwise leave `lanes` set and run the whole suite anyway — reporting
    // on a run the caller did not ask for.
    lanes = undefined;
    process.exitCode = 1;
  }

  if (lanes !== undefined) {
    runFoundationE2ELanes({
      lanes,
      repeatEach,
      runDirectory: createE2ERunDirectory(),
    })
      .then((exitCode) => {
        process.exitCode = exitCode;
      })
      .catch(() => {
        console.error(CHILD_START_FAILURE);
        process.exitCode = 1;
      });
  }
}
