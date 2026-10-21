import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { acceptanceSkipReason } from "../apps/web/src/test/acceptance-skip-rules.ts";
import {
  acceptanceReportDirectory,
  acceptanceReportFile,
} from "../apps/web/tests/fixtures/acceptance-report.ts";
import { acceptanceShardCounts } from "../apps/web/tests/fixtures/acceptance-shards.ts";
import { e2eResultsRoot } from "../apps/web/tests/fixtures/e2e-run-directory.ts";
import {
  magicLinkDeliveryRecoveryMs,
  magicLinkPollBudgetMs,
  magicLinkSubmissions,
  restartTransportFailures,
  scenarioNavigationRecoveryMs,
} from "../apps/web/tests/fixtures/scenario-navigation.ts";
import * as hostedDeployment from "./hosted-deployment.mjs";
import {
  buildLaneCommand,
  createFoundationE2EEnvironment,
  FOUNDATION_E2E_LANES,
  resetFoundationE2EReports,
  runFoundationE2ELanes,
} from "./run-foundation-e2e.mjs";

const webDirectory = resolve(import.meta.dirname, "../apps/web");

/**
 * The skip option of a case that reads a path the public seed does not carry
 * (manifest-j.md §2.4 item 6, Appendix A.3; ruling 92): a reason naming
 * `paths` when `scripts/hosted-deployment.mjs` declares the tree public, as
 * the seed's substitution makes it, and `false` otherwise. So in this private
 * tree the case never skips, a missing path still fails it, and
 * `private-paths.test.mjs` fails if a path named here is gone.
 */
function skipInPublicTree(...paths) {
  return hostedDeployment.kind === "public"
    ? `the public tree does not carry ${paths.join(", ")} (scripts/hosted-deployment.mjs declares kind "public")`
    : false;
}
const supportModule = pathToFileURL(
  resolve(webDirectory, "tests/fixtures/webkit-support.ts"),
).href;
const acceptanceSpecDirectory = resolve(webDirectory, "tests/e2e");
const acceptanceTableDirectory = resolve(
  import.meta.dirname,
  "../docs/implementation/acceptance",
);
const acceptanceMatrixPath = resolve(
  acceptanceTableDirectory,
  "requestport-cue-reskin-matrix.json",
);
const playwrightConfigPath = resolve(webDirectory, "playwright.config.ts");
const playwrightCli = createRequire(
  pathToFileURL(resolve(webDirectory, "package.json")).href,
).resolve("@playwright/test/cli");

/**
 * The environment the Playwright config refuses to load without.
 */
const guardedEnvironment = {
  ...process.env,
  NODE_ENV: "test",
  REQUESTPORT_E2E_MODE: "1",
  REQUESTPORT_E2E_TOKEN: "config-test-token-that-is-at-least-thirty-two-chars",
};

/**
 * The WebKit build Playwright 1.62.1 pins for macOS 14 on Apple silicon, and
 * the mainline revision its driver speaks. Both are read out of the installed
 * `browsers.json` at run time; these are the values that manifest carries and
 * that the observed protocol error came from.
 */
const observedManifest = {
  revision: "2336",
  revisionOverrides: { mac14: "2251", "mac14-arm64": "2251" },
};

const hosts = {
  ciLinux: { architecture: "x64", operatingSystem: "linux", release: "6.8.0" },
  ciLinuxArm: {
    architecture: "arm64",
    operatingSystem: "linux",
    release: "6.8.0",
  },
  macIntel: {
    architecture: "x64",
    operatingSystem: "darwin",
    release: "23.5.0",
  },
  macNext: {
    architecture: "arm64",
    operatingSystem: "darwin",
    release: "24.1.0",
  },
  macObserved: {
    architecture: "arm64",
    operatingSystem: "darwin",
    release: "23.5.0",
  },
  windows: {
    architecture: "x64",
    operatingSystem: "win32",
    release: "10.0.22631",
  },
};

/**
 * The hosts this suite accepts a WebKit skip on.
 *
 * Everything else in `hosts` has to run the engine, under the observed
 * manifest *and* under one that pins its own platform. Declaring a new
 * incompatible platform therefore means naming its host here and saying why,
 * which is an edit a reviewer sees.
 */
const webkitIncompatibleHosts = ["macObserved"];

/**
 * Call one export of the WebKit support module in a child process.
 *
 * The module is TypeScript with no build step, so it is loaded the same way
 * the Playwright config is: stripped types in a child, reading the real
 * installed manifest unless the call supplies one.
 */
function callSupport(name, argument) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `const support = await import(${JSON.stringify(supportModule)});
       process.stdout.write(JSON.stringify(support.${name}(${JSON.stringify(argument)}) ?? null));`,
    ],
    { cwd: webDirectory, encoding: "utf8", env: guardedEnvironment },
  );

  assert.equal(result.status, 0, result.stderr);

  return JSON.parse(result.stdout);
}

function skipReason(input) {
  return callSupport("webkitProtocolSkipReason", input);
}

test("loading the Playwright config preserves an injected NO_COLOR value", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      'await import("./playwright.config.ts"); process.stdout.write(process.env.NO_COLOR);',
    ],
    {
      cwd: webDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        NO_COLOR: "requestport-sentinel",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN:
          "config-test-token-that-is-at-least-thirty-two-chars",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "requestport-sentinel");
});

test("bounds every E2E assertion by a remote round trip, not a local default", () => {
  // Playwright's assertion default is 5s, which is a budget for a warm page
  // against a local database. These journeys submit server actions that the
  // development server compiles on first request and that then round-trip to a
  // remote database branch, so on a cold server the first submission of a route
  // regularly outlasts 5s. Leaving the default in place made the suite pass or
  // fail on whether the route happened to be compiled already — exactly the
  // non-determinism the browser-acceptance contract forbids — and it was
  // invisible, because the assertions that had already tripped over it carried
  // hand-written budgets while their siblings, waiting on exactly the same
  // round trip, did not. The budget therefore belongs to the suite rather than
  // to whichever assertion happened to fail first.
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      'const { default: config } = await import("./playwright.config.ts"); process.stdout.write(JSON.stringify({ expect: config.expect ?? null, timeout: config.timeout ?? null }));',
    ],
    {
      cwd: webDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN:
          "config-test-token-that-is-at-least-thirty-two-chars",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);

  assert.ok(config.expect, "the suite must declare its own assertion budget");
  assert.ok(
    Number(config.expect.timeout) >= 20_000,
    "an assertion on a server answer must allow for a cold compile and a remote round trip",
  );
  assert.ok(
    Number(config.timeout) > Number(config.expect.timeout),
    "a failing assertion must be reportable inside the default test budget",
  );
});

test("foundation E2E always replaces a caller-supplied token", () => {
  const environment = createFoundationE2EEnvironment({
    baseEnvironment: {
      NODE_ENV: "production",
      REQUESTPORT_E2E_MODE: "0",
      REQUESTPORT_E2E_TOKEN: "persistent-caller-token-that-must-not-be-reused",
    },
    createToken: () => "fresh-per-run-token-that-is-at-least-thirty-two-chars",
  });

  assert.equal(environment.NODE_ENV, "test");
  assert.equal(environment.REQUESTPORT_E2E_MODE, "1");
  assert.equal(
    environment.REQUESTPORT_E2E_TOKEN,
    "fresh-per-run-token-that-is-at-least-thirty-two-chars",
  );
});

/**
 * Load the config in a child process and hand back a serialisable summary.
 *
 * The config refuses to load outside the guarded entry, so the environment it
 * demands is supplied here exactly as `test:e2e` supplies it. Reading the
 * loaded object rather than the file's text is what makes these assertions
 * about the configuration Playwright will actually run under.
 */
function loadConfigSummary(extraArgv = []) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `const { default: config } = await import("./playwright.config.ts");
       const { acceptanceProviderSettings } = await import(
         "./tests/fixtures/acceptance-provider-settings.ts"
       );
       const budget = await import("./playwright.config.ts");
       // Read from the fixture that installs it rather than through the
       // config, so a bound the config declares can be compared with the bound
       // the tolerance retries at instead of with itself.
       const navigation = await import(
         "./tests/fixtures/scenario-navigation.ts"
       );
       process.stdout.write(JSON.stringify({
         globalTimeout: config.globalTimeout ?? null,
         webServerTimeout: config.webServer?.timeout ?? null,
         webServerStartBudgetMs: budget.webServerStartBudgetMs ?? null,
         overrunWebServerStartBudgetMs:
           budget.overrunWebServerStartBudgetMs ?? null,
         jobBudgetMs: budget.jobBudgetMs ?? null,
         largestShardCases: budget.largestShardCases ?? null,
         shardBudgetsMs: Object.fromEntries(
           [...(budget.shardBudgetsMs ?? [])].toSorted(),
         ),
         shardRunnableCases: Object.fromEntries(
           [...(budget.shardRunnableCases ?? [])].toSorted(),
         ),
         shardSelectedCases: Object.fromEntries(
           [...(budget.shardSelectedCases ?? [])].toSorted(),
         ),
         measuredCiAnnouncedRestarts: budget.measuredCiAnnouncedRestarts ?? null,
         measuredCiCaseMs: budget.measuredCiCaseMs ?? null,
         measuredCiCasesPerRestart: budget.measuredCiCasesPerRestart ?? null,
         measuredCiCompletedAttempts: budget.measuredCiCompletedAttempts ?? null,
         measuredCiLaneStartMs: budget.measuredCiLaneStartMs ?? null,
         measuredCiRestartDamagedAttempts:
           budget.measuredCiRestartDamagedAttempts ?? null,
         measuredCiRestartDamagedTotalMs:
           budget.measuredCiRestartDamagedTotalMs ?? null,
         measuredCiRestartRecoveryMs: budget.measuredCiRestartRecoveryMs ?? null,
         measuredCiOrdinaryAttempts: budget.measuredCiOrdinaryAttempts ?? null,
         measuredCiOrdinaryTotalMs: budget.measuredCiOrdinaryTotalMs ?? null,
         measuredCiNonBrowserMs: budget.measuredCiNonBrowserMs ?? null,
         measuredCiSkippedAttempts: budget.measuredCiSkippedAttempts ?? null,
         measuredCiSkippedCaseMs: budget.measuredCiSkippedCaseMs ?? null,
         measuredCiSkippedTotalMs: budget.measuredCiSkippedTotalMs ?? null,
         measuredCiTenantBootstrapMs: budget.measuredCiTenantBootstrapMs ?? null,
         laneRetries: budget.laneRetries ?? null,
         longJourneyCiFactor: budget.longJourneyCiFactor ?? null,
         longJourneyMs: Object.fromEntries(
           [...(budget.longJourneyMs ?? [])].toSorted(),
         ),
         longJourneyProvenance: budget.longJourneyProvenance ?? {},
         measuredLocalDensityMs: budget.measuredLocalDensityMs ?? null,
         measuredLocalProjectsMs: budget.measuredLocalProjectsMs ?? null,
         observedCiLongJourneyFloorMs:
           budget.observedCiLongJourneyFloorMs ?? null,
         shardLongJourneyMs: Object.fromEntries(
           [...(budget.shardLongJourneyMs ?? [])].toSorted(),
         ),
         measuredCiAttemptsDamagedPerRestart:
           budget.measuredCiAttemptsDamagedPerRestart ?? null,
         retries: config.retries ?? null,
         // One budget per shard at each retry count the runner can be given,
         // so a test can ask what retrying costs a lane without restating the
         // arithmetic that answers it.
         shardBudgetsAtRetries: Object.fromEntries(
           [0, 1].map((retries) => [
             retries,
             Object.fromEntries(
               [...(budget.shardRunnableCases ?? [])].map(
                 ([name, runnable]) => [
                   name,
                   budget.shardBudgetMs(
                     runnable,
                     (budget.shardSelectedCases?.get(name) ?? 0) - runnable,
                     retries,
                     budget.shardLongJourneyMs?.get(name) ?? [],
                   ),
                 ],
               ),
             ),
           ]),
         ),
         scenarioNavigationAttemptTimeoutMs:
           navigation.scenarioNavigationAttemptTimeoutMs ?? null,
         scenarioNavigationRecoveryMs:
           budget.scenarioNavigationRecoveryMs ?? null,
         scenarioReleaseRecoveryMs: budget.scenarioReleaseRecoveryMs ?? null,
         shardBudgetProvenance: budget.shardBudgetProvenance ?? {},
         shardHeadroomFactor: budget.shardHeadroomFactor ?? null,
         navigationTimeout: config.use?.navigationTimeout ?? null,
         actionTimeout: config.use?.actionTimeout ?? null,
         outputDir: config.outputDir ?? null,
         preserveOutput: config.preserveOutput ?? null,
         reporter: config.reporter ?? null,
         projects: (config.projects ?? []).map((project) => ({
           // Which artifact settings this project overrides for itself, if any.
           artifactKeys: Object.keys(project.use ?? {}).filter((key) =>
             ["screenshot", "trace", "video"].includes(key),
           ),
           browserName: project.use?.browserName ?? null,
           grep: project.grep ? String(project.grep) : null,
           grepInvert: project.grepInvert ? String(project.grepInvert) : null,
           name: project.name ?? null,
         })),
         // Names and booleans only. The values are placeholders rather than
         // credentials, and a test that printed them would still be a test
         // that prints whatever the next author puts in that record.
         providerSettings: Object.entries(acceptanceProviderSettings).map(
           ([key, value]) => ({
             applied: config.webServer?.env?.[key] === value,
             key,
           }),
         ),
         use: {
           screenshot: config.use?.screenshot ?? null,
           trace: config.use?.trace ?? null,
           video: config.use?.video ?? null,
         },
       }));`,
      // `--` keeps a lane name from being read as a Node option; the config
      // reads it out of `process.argv` exactly as Playwright's own child does.
      ...(extraArgv.length > 0 ? ["--", ...extraArgv] : []),
    ],
    {
      cwd: webDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN:
          "config-test-token-that-is-at-least-thirty-two-chars",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);

  return JSON.parse(result.stdout);
}

test("starts the acceptance server with the whole Slack provider group", () => {
  const { providerSettings } = loadConfigSummary();

  // `/slack` prints "Slack configuration required" both for a provider the run
  // made unreachable and for a provider nobody configured. The injected fault
  // is only observable while the second reason is absent, so the guarded
  // server carries the settings — and the server schema treats the four Slack
  // fields as one all-or-nothing group, so a partial group refuses to start
  // rather than quietly restoring a case that cannot fail.
  assert.deepEqual(providerSettings.map((setting) => setting.key).sort(), [
    "REQUESTPORT_SLACK_CLIENT_ID",
    "REQUESTPORT_SLACK_CLIENT_SECRET",
    "REQUESTPORT_SLACK_SIGNING_SECRET",
    "REQUESTPORT_SLACK_STATE_SECRET",
    "REQUESTPORT_WORKSPACE_KEK",
  ]);
  assert.deepEqual(
    providerSettings.filter((setting) => !setting.applied),
    [],
  );
});

test("runs every lane on both mandatory engines and on no other", () => {
  const { projects } = loadConfigSummary();
  const engines = [
    ...new Set(projects.map((project) => project.browserName)),
  ].sort();

  // Plan 10 fixed the supported-engine policy: Chromium and WebKit are
  // mandatory, and Firefox is added only if the upstream support policy
  // already promises it. The installed `@cueplusplus/ui` package promises no
  // engine at all, so Firefox automation stays the documented non-goal.
  assert.deepEqual(engines, ["chromium", "webkit"]);
  assert.equal(
    projects.every((project) => typeof project.name === "string"),
    true,
  );
});

test("shards the route/state matrix separately from appearance and interaction", () => {
  const { projects } = loadConfigSummary();
  const lanes = new Map();

  for (const project of projects) {
    const lane = project.name.replace(/-(chromium|webkit)$/u, "");
    lanes.set(lane, [...(lanes.get(lane) ?? []), project]);
  }

  assert.deepEqual([...lanes.keys()].sort(), ["appearance", "route-state"]);
  for (const [, laneProjects] of lanes) {
    assert.deepEqual(
      laneProjects.map((project) => project.browserName).sort(),
      ["chromium", "webkit"],
    );
  }

  // The two lanes partition the tree: one selects the tagged route/state
  // cases, the other selects everything that is not one of them. A case can
  // therefore never be run twice on one engine, nor silently dropped.
  for (const project of lanes.get("route-state")) {
    assert.equal(project.grep, "/@route-state/");
    assert.equal(project.grepInvert, null);
  }
  for (const project of lanes.get("appearance")) {
    assert.equal(project.grepInvert, "/@route-state/");
    assert.equal(project.grep, null);
  }
});

/**
 * Every case Playwright selects, per project, asked of Playwright.
 *
 * A project selects by grep, not from the case table, so the only authority on
 * what a shard carries is the tree Playwright loads through this very config.
 * `--list` loads it, reports the project each test was selected for, and runs
 * nothing: no browser is launched and the web server never starts.
 *
 * `DATABASE_URL` is a syntactically valid placeholder on an unroutable port.
 * Since Plan 13's G.5 no spec or fixture builds a database client at import
 * time. The placeholder stays so that a listing could never reach a real
 * database, should one start to.
 */
function listAcceptanceSelection(project, extra = []) {
  const result = spawnSync(
    process.execPath,
    [
      playwrightCli,
      "test",
      "--list",
      "--reporter=json",
      ...(project === undefined ? [] : [`--project=${project}`]),
      ...extra,
    ],
    {
      cwd: webDirectory,
      encoding: "utf8",
      env: {
        ...guardedEnvironment,
        DATABASE_URL:
          "postgres://listing:listing@127.0.0.1:1/requestport_listing_only",
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  // The config announces a host-specific engine skip on stdout before the
  // reporter writes anything, so the report starts at its first brace.
  const listed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.deepEqual(listed.errors, [], "the listing must load every spec");

  const cases = new Map();
  const files = new Set();
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      files.add(spec.file ?? file);
      for (const entry of spec.tests) {
        cases.set(entry.projectName, (cases.get(entry.projectName) ?? 0) + 1);
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.file ?? file);
  };
  for (const suite of listed.suites) walk(suite, suite.file);

  return { cases, files, globalTimeout: listed.config.globalTimeout };
}

test("counts each shard from the cases its own project selects", () => {
  const { largestShardCases, shardRunnableCases, shardSelectedCases } =
    loadConfigSummary();
  const { cases, files } = listAcceptanceSelection();

  // The defect this closes. The counts every budget was derived from were read
  // out of `acceptanceCases`, and a Playwright project does not select from
  // that table — it greps titles. Both appearance shards also carry the
  // untagged non-matrix cases, which were charged nothing at all, so each
  // appearance lane ran more cases than the budget for it had paid for.
  assert.deepEqual(
    shardSelectedCases,
    Object.fromEntries([...cases].toSorted()),
    "each shard must be counted from what its project selects",
  );

  // A spec no shard claims is a spec whose cost no budget carries. The two
  // lanes partition by tag, so the union of what they select has to be every
  // spec file on disk.
  assert.deepEqual(
    [...files].toSorted(),
    readdirSync(acceptanceSpecDirectory)
      .filter((name) => name.endsWith(".spec.ts"))
      .toSorted(),
    "every spec under the acceptance tree must be claimed by a shard",
  );

  // What a shard selects is not what it starts, and the difference is two
  // classes rather than one. The runner skips a case whose declared engine is
  // not this project's, and it skips a case the checked-in rules decline —
  // both from inside the case, after the browser context has been handed over.
  //
  // The defect this closes, which is the third round of one shape. The budget
  // subtracted the engine skip alone, so both route/state lanes were charged
  // the price of a whole case for every case the rules decline, and the count
  // the workflow's timeout rests on was a count of cases nothing runs.
  const matrix = JSON.parse(readFileSync(acceptanceMatrixPath, "utf8"));
  const runnable = Object.fromEntries(
    [...cases].toSorted().map(([project, selected]) => {
      const named = /^(appearance|route-state)-(chromium|webkit)$/u.exec(
        project,
      );
      assert.ok(named, `unexpected project name ${project}`);

      return [
        project,
        selected -
          matrix.cases.filter(
            (entry) =>
              entry.lane === named[1] &&
              (entry.engine !== named[2] ||
                acceptanceSkipReason(
                  entry.surface,
                  entry.state,
                  entry.fixtureOwner,
                ) !== null),
          ).length,
      ];
    }),
  );

  assert.deepEqual(shardRunnableCases, runnable);
  assert.equal(largestShardCases, Math.max(...Object.values(runnable)));
});

/**
 * The engines the config declares, read off the projects it declares them as.
 *
 * Naming them here would be a second list of the pair the config partitions
 * on, and the two would disagree the first time one of them changed.
 */
function declaredEngines(projects) {
  return [
    ...new Set(projects.map((project) => project.browserName)),
  ].toSorted();
}

/**
 * The one source of restart-transport wordings that is not an engine.
 *
 * A request the suite makes through Playwright's own request context is made
 * by Node in the driver process, so it fails in Node's words whichever browser
 * the lane is driving. Named here so the check below can insist on it while
 * still failing on a key that matches no engine at all — a misspelled engine
 * would otherwise look like this one and leave the same silent hole.
 */
const restartTransportDriverSource = "driver";

test("gives every engine the matrix runs a restart vocabulary of its own", () => {
  const engines = declaredEngines(loadConfigSummary().projects);

  // The defect this closes. The tolerance that survives a development-server
  // restart classifies the failure by its wording, and the wordings it held
  // were all one engine's — written while only that engine had ever run, and
  // read by both lanes. Nothing said the list was an engine's vocabulary, so
  // nothing noticed when the other engine's lane started and met a restart
  // wording no entry matched. The engines are read off the projects the config
  // will really run, so adding one fails here until its words are written down.
  assert.deepEqual(
    Object.keys(restartTransportFailures).toSorted(),
    [...engines, restartTransportDriverSource].toSorted(),
  );

  // A key with nothing behind it would satisfy the comparison above and
  // classify nothing, which is the state the WebKit lane was already in.
  for (const [source, vocabulary] of Object.entries(restartTransportFailures)) {
    assert.ok(
      vocabulary.length > 0,
      `${source}: an engine in the matrix says something when a request never arrives`,
    );
  }
});

test("charges a shard less once one more case is declined", () => {
  const summary = loadConfigSummary();
  const engines = declaredEngines(summary.projects);
  const standing = acceptanceShardCounts(engines);

  // The counts the config publishes are the ones this module derives, so what
  // the plant below moves is the quantity the budget is actually charged for.
  assert.deepEqual(
    Object.fromEntries([...standing.runnable].toSorted()),
    summary.shardRunnableCases,
  );

  // A rule planted against the first case the checked-in rules still claim.
  // Chosen from the table rather than written down, so this stays a proof
  // about the derivation rather than about one case that may be retired.
  const matrix = JSON.parse(readFileSync(acceptanceMatrixPath, "utf8"));
  const claimed = matrix.cases.find(
    (entry) =>
      acceptanceSkipReason(entry.surface, entry.state, entry.fixtureOwner) ===
      null,
  );
  assert.ok(claimed, "some case in the table must still be claimed");

  const planted = acceptanceShardCounts(engines, (surface, state, owner) =>
    surface === claimed.surface &&
    state === claimed.state &&
    owner === claimed.fixtureOwner
      ? "planted"
      : acceptanceSkipReason(surface, state, owner),
  );
  const shard = `${claimed.lane}-${claimed.engine}`;
  const budget = (counts) =>
    shardBudgetFrom(
      summary,
      counts.runnable.get(shard),
      counts.selected.get(shard) - counts.runnable.get(shard),
    );

  // A rule is stated about a surface and a state, and the table drives the
  // same pair at several appearances, so the plant lands on every case in this
  // shard that shares it. Counted rather than assumed to be one.
  const landed = matrix.cases.filter(
    (entry) =>
      entry.lane === claimed.lane &&
      entry.engine === claimed.engine &&
      entry.surface === claimed.surface &&
      entry.state === claimed.state &&
      entry.fixtureOwner === claimed.fixtureOwner,
  ).length;
  assert.ok(landed > 0, "the planted rule must decline something");

  // A declined case is still selected — the project greps titles and a rule
  // decides nothing until the case has been handed a browser context — so what
  // a rule moves is what the lane starts, and the budget with it.
  assert.equal(planted.selected.get(shard), standing.selected.get(shard));
  assert.equal(
    planted.runnable.get(shard),
    standing.runnable.get(shard) - landed,
  );
  assert.ok(
    budget(planted) < budget(standing),
    `declining one more case must lower the ${shard} budget`,
  );
});

/**
 * What one shard's budget has to be, restated from the measured terms.
 *
 * Every term is charged to the quantity that spends it. The lane pays once for
 * coming up and once for the tenant, and the case that pays for the tenant is
 * one of the runnable cases rather than an extra one. What its project selects
 * and does not run still costs the lane a slot, so the difference between the
 * two counts is charged at what a skipped slot measured. And a development
 * server that restarts itself costs the lane far more than the release loop's
 * own bound: the restart is charged what one measured, end to end.
 *
 * The cases a mean cannot pay for are charged at their own cost rather than at
 * it, and so are the attempts the runner makes again — spent from the dearest
 * case the lane carries downwards, because a case can be re-run no more often
 * than the runner retries it.
 */
function shardBudgetFrom(
  summary,
  runnable,
  skipped,
  retries = summary.laneRetries,
  longJourneys = [],
) {
  const restarts = Math.ceil(runnable / summary.measuredCiCasesPerRestart);
  const dearestFirst = [...longJourneys].toSorted(
    (dearer, cheaper) => cheaper - dearer,
  );
  const retried =
    retries * restarts * summary.measuredCiAttemptsDamagedPerRestart;
  const retriedLong = dearestFirst.slice(
    0,
    Math.min(retried, retries * dearestFirst.length),
  );
  const total = (charges) => charges.reduce((sum, charge) => sum + charge, 0);

  return Math.round(
    (summary.measuredCiLaneStartMs +
      summary.measuredCiTenantBootstrapMs +
      (runnable - 1 - dearestFirst.length) * summary.measuredCiCaseMs +
      total(dearestFirst) +
      skipped * summary.measuredCiSkippedCaseMs +
      restarts * summary.measuredCiRestartRecoveryMs +
      total(retriedLong) +
      (retried - retriedLong.length) * summary.measuredCiCaseMs) *
      summary.shardHeadroomFactor,
  );
}

test("bounds each shard by its own budget in the process that runs it", () => {
  const summary = loadConfigSummary();
  const { shardLongJourneyMs, shardRunnableCases, shardSelectedCases } =
    summary;
  const budget = (project) =>
    shardBudgetFrom(
      summary,
      shardRunnableCases[project],
      shardSelectedCases[project] - shardRunnableCases[project],
      summary.laneRetries,
      shardLongJourneyMs[project] ?? [],
    );

  // The defect this closes. Four per-shard budgets were computed, summed, and
  // cited in the workflow's own timeout — and then none of them was applied to
  // the shard that spends it. Every lane ran under the largest shard's ceiling,
  // so the smallest shard could overrun its own budget by half an hour before
  // anything noticed, and what finally stopped it was the job timeout, which
  // names no lane and no case.
  //
  // Read out of Playwright's own report of the config it would run this
  // project under, because that is where the bound has to hold.
  for (const project of Object.keys(shardRunnableCases)) {
    assert.equal(
      listAcceptanceSelection(project).globalTimeout,
      budget(project),
      `${project} must run under its own budget`,
    );
  }

  // With no project named, one process runs every lane, so it is answerable
  // for all four budgets rather than for one of them.
  assert.equal(
    listAcceptanceSelection().globalTimeout,
    Object.keys(shardRunnableCases).reduce(
      (total, project) => total + budget(project),
      0,
    ),
  );
});

test("scales a shard's budget by the repeat it was asked to run", () => {
  const project = "route-state-webkit";
  const once = listAcceptanceSelection(project).globalTimeout;

  for (const repeat of [2, 20]) {
    assert.equal(
      listAcceptanceSelection(project, [`--repeat-each=${repeat}`])
        .globalTimeout,
      once * repeat,
      `a repeat of ${repeat} must be given a repeat of ${repeat} budgets`,
    );
  }

  /*
   * The defect this closes, measured rather than reasoned: a hunt that asked
   * every case in this lane for more passes than its unscaled budget could pay
   * for spent that budget and was ended by Playwright with "Timed out waiting
   * for the test suite to run" — cases reported as "did not run" and the lane
   * reported as failed, for a run that had failed nothing. A budget that does
   * not know about the repeat turns a too-large request into a false red.
   */
  assert.equal(
    listAcceptanceSelection(project, ["--repeat-each=notanumber"])
      .globalTimeout,
    once,
    "a count playwright itself will not take must not change the budget",
  );
});

test("bounds one shard by a budget measured where the shard runs", () => {
  const summary = loadConfigSummary();
  const {
    largestShardCases,
    measuredCiCaseMs,
    measuredCiRestartRecoveryMs,
    measuredCiSkippedCaseMs,
    shardBudgetsMs,
    shardHeadroomFactor,
    shardRunnableCases,
    shardSelectedCases,
  } = summary;
  const largest = Object.entries(shardRunnableCases).find(
    ([, cases]) => cases === largestShardCases,
  );

  assert.ok(largest, "some shard must be the largest");

  // The defect this closes. The previous budget was a laptop measurement
  // doubled, and the measurement was taken on a developer Mac with more cores
  // than the runner has, where the WebKit cases are skipped. On
  // `ubuntu-latest` the ceiling it produced
  // expired mid-lane in CI runs 33207988275 and 33207990750, leaving tests
  // unreported. The budget is still derived rather than asserted; what changed
  // is that every measurement in it comes from the host that runs the shard.
  assert.equal(
    shardBudgetsMs[largest[0]],
    shardBudgetFrom(
      summary,
      largestShardCases,
      shardSelectedCases[largest[0]] - largestShardCases,
      summary.laneRetries,
      summary.shardLongJourneyMs[largest[0]] ?? [],
    ),
  );
  assert.ok(
    measuredCiCaseMs >= 5_000,
    "the per-case measurement must be a real case, not a placeholder",
  );
  assert.ok(
    shardHeadroomFactor >= 1.2 && shardHeadroomFactor <= 1.5,
    "a budget with more than half again of slack is not a budget",
  );

  // The two terms the previous budget did not have, each bounded by what it is
  // for. A slot the project skips costs less than a case it runs, or it is not
  // a skip; and a development server restarting itself costs the lane more than
  // a case does, which is the whole reason the release loop's own bound was the
  // wrong charge for it.
  assert.ok(
    measuredCiSkippedCaseMs > 0 && measuredCiSkippedCaseMs < measuredCiCaseMs,
    "a skipped slot costs something, and less than a case",
  );
  assert.ok(
    measuredCiRestartRecoveryMs > measuredCiCaseMs,
    "a restart costs the lane more than the case it interrupted",
  );
});

test("lets the magic-link poll outlast the restart it is measured against", () => {
  const { measuredCiRestartRecoveryMs } = loadConfigSummary();

  // The defect this closes, and why it is bound here rather than argued in the
  // fixture. The magic-link poll used to spend a few seconds in all, and the
  // outage it was asking across is the one this config measures — so it could
  // not survive a single restart under any circumstances, and a WebKit lane
  // failed on exactly that with one opaque sentence to show for it. The
  // fixture derives its recovery from bounds it can reach; what it cannot
  // reach is the measurement, so the comparison lives where both are in
  // scope.
  assert.equal(
    magicLinkDeliveryRecoveryMs,
    magicLinkSubmissions *
      (scenarioNavigationRecoveryMs + magicLinkPollBudgetMs),
    "the declared recovery is what that loop can actually spend",
  );
  assert.ok(
    magicLinkDeliveryRecoveryMs >= measuredCiRestartRecoveryMs,
    "a poll that cannot spend what a restart costs cannot survive one",
  );
});

test("charges a lane for the retries the runner it configures will run", () => {
  const { laneRetries, retries, shardBudgetsAtRetries, shardBudgetsMs } =
    loadConfigSummary();

  // The defect this closes. The runner is given a retry in CI and the budget
  // had no term for one. The per-case mean every shard is charged from was
  // taken over the measured lane's ordinary attempts with its retries taken
  // out, so a lane that retried anything spent wall clock nothing had paid
  // for — and a lane cannot be bounded by a ceiling that omits attempts its
  // own runner will make.
  for (const shard of Object.keys(shardBudgetsMs)) {
    assert.ok(
      shardBudgetsAtRetries["1"][shard] > shardBudgetsAtRetries["0"][shard],
      `${shard}: a runner that retries must cost the lane more than one that does not`,
    );
  }

  // The runner's setting and the budget's charge are one binding, so the
  // ceiling a lane runs under is the ceiling for the attempts that lane will
  // actually make.
  assert.equal(
    retries,
    laneRetries,
    "the runner and the budget must read one retry setting",
  );
  assert.deepEqual(
    shardBudgetsMs,
    shardBudgetsAtRetries[String(laneRetries)],
    "each shard runs under the budget for the retries it is configured to make",
  );
});

test("charges the longest journeys at what each costs, not at the lane's mean", () => {
  const summary = loadConfigSummary();
  const {
    longJourneyMs,
    measuredCiCaseMs,
    shardLongJourneyMs,
    shardRunnableCases,
    shardSelectedCases,
  } = summary;

  // The defect this closes. Every case in a lane was charged one mean, and two
  // cases in this tree cost several times it — so the ceiling could not pay for
  // the lane's own most expensive case, let alone for retrying it, and the
  // retry term multiplied that same mean.
  assert.ok(
    Object.keys(longJourneyMs).length > 0,
    "a budget that charges no journey individually is charging them all at the mean",
  );
  for (const [file, charge] of Object.entries(longJourneyMs)) {
    assert.ok(
      charge > measuredCiCaseMs,
      `${file}: a case charged apart from the mean must cost more than the mean`,
    );
  }

  const carrying = Object.entries(shardLongJourneyMs).filter(
    ([, journeys]) => journeys.length > 0,
  );
  assert.ok(carrying.length > 0, "some shard must run a long journey");

  for (const [shard, journeys] of carrying) {
    const skipped = shardSelectedCases[shard] - shardRunnableCases[shard];
    const charged = shardBudgetFrom(
      summary,
      shardRunnableCases[shard],
      skipped,
      summary.laneRetries,
      journeys,
    );
    const meaned = shardBudgetFrom(
      summary,
      shardRunnableCases[shard],
      skipped,
      summary.laneRetries,
    );

    assert.ok(
      charged > meaned,
      `${shard}: charging its long journeys at what they cost must exceed charging them at the mean`,
    );
    assert.ok(
      shardRunnableCases[shard] > journeys.length + 1,
      `${shard}: a lane must run more than its long journeys and the case that bootstraps its tenant`,
    );
  }

  // And a lane that runs none of them is left exactly as it was, or the term
  // is a blanket rise rather than a charge attributed to what spends it.
  for (const [shard, journeys] of Object.entries(shardLongJourneyMs)) {
    if (journeys.length > 0) continue;
    const skipped = shardSelectedCases[shard] - shardRunnableCases[shard];

    assert.equal(
      shardBudgetFrom(
        summary,
        shardRunnableCases[shard],
        skipped,
        summary.laneRetries,
        journeys,
      ),
      shardBudgetFrom(summary, shardRunnableCases[shard], skipped),
      `${shard}: a lane that runs no long journey may not be charged for one`,
    );
  }
});

test("pays for retrying the dearest case a lane carries, not an average one", () => {
  const {
    measuredCiCaseMs,
    shardBudgetsAtRetries,
    shardHeadroomFactor,
    shardLongJourneyMs,
  } = loadConfigSummary();

  // The defect this closes. The retry term multiplied the per-case mean, so a
  // lane whose dearest case costs several times that mean had a ceiling that
  // could not pay for re-running it — and a retry of exactly that case is the
  // scenario that puts the lane back over the ceiling.
  assert.ok(
    Object.values(shardLongJourneyMs).some((journeys) => journeys.length > 0),
    "a lane that carries no long journey cannot show what retrying one costs",
  );

  for (const [shard, journeys] of Object.entries(shardLongJourneyMs)) {
    if (journeys.length === 0) continue;

    const charged =
      shardBudgetsAtRetries["1"][shard] - shardBudgetsAtRetries["0"][shard];

    assert.ok(
      charged >= Math.max(...journeys) * shardHeadroomFactor,
      `${shard}: a retry charge that cannot pay to re-run its dearest case is not a ceiling`,
    );
    assert.ok(
      charged > journeys.length * measuredCiCaseMs * shardHeadroomFactor,
      `${shard}: a retry charge at the mean is what this replaces`,
    );
  }
});

test("floors a long journey by the clock its own comment cites", () => {
  const {
    longJourneyCiFactor,
    measuredLocalDensityMs,
    observedCiLongJourneyFloorMs,
  } = loadConfigSummary();
  const doc = playwrightConfigDoc(
    "export const observedCiLongJourneyFloorMs\\b",
  );
  const clock = [...doc.matchAll(/\b(\d{2}):(\d{2}):(\d{2})\b/gu)].map(
    ([, hours, minutes, seconds]) =>
      (Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)) * 1_000,
  );

  assert.equal(
    clock.length,
    2,
    "the floor must cite the clock it was read off",
  );
  assert.equal(
    observedCiLongJourneyFloorMs,
    clock[1] - clock[0],
    "the floor must be the span its own comment cites",
  );

  // The estimate is that floor over the local cost of the same case, and it is
  // a floor on both counts: the case was interrupted rather than completed, and
  // nothing has timed the other journey on the runner at all.
  assert.equal(
    longJourneyCiFactor,
    observedCiLongJourneyFloorMs / measuredLocalDensityMs,
    "the estimate must scale by the comparison it names",
  );
  assert.ok(
    longJourneyCiFactor > 1,
    "the runner is not faster than the host these were measured on",
  );
});

test("charges a restart what a restart measured, not what a retry bounds", () => {
  const {
    measuredCiAnnouncedRestarts,
    measuredCiCaseMs,
    measuredCiRestartDamagedAttempts,
    measuredCiRestartDamagedTotalMs,
    measuredCiRestartRecoveryMs,
    measuredCiSkippedAttempts,
    measuredCiSkippedCaseMs,
    measuredCiSkippedTotalMs,
    scenarioNavigationRecoveryMs,
    scenarioReleaseRecoveryMs,
  } = loadConfigSummary();

  // The defect this closes. A restart was charged the bound on the release
  // loop — the one recovery the fixtures happened to declare a constant for —
  // and a restart costs the lane far more than that: the child that takes over
  // recompiles the route the next case asks for, and the case that met the
  // restart pays for meeting it. The measured lane expired inside its budget
  // with cases unstarted while every other term in that budget was right.
  //
  // So the charge is what a restart cost, measured end to end: the attempts a
  // restart damaged, less what those attempts would have cost as ordinary ones,
  // over the restarts the lane announced.
  assert.equal(
    measuredCiRestartRecoveryMs,
    Math.max(
      Math.round(
        (measuredCiRestartDamagedTotalMs -
          measuredCiRestartDamagedAttempts * measuredCiCaseMs) /
          measuredCiAnnouncedRestarts,
      ),
      scenarioNavigationRecoveryMs + scenarioReleaseRecoveryMs,
    ),
    "a restart is charged the excess the damaged attempts measured",
  );
  assert.deepEqual(
    figuresIn(playwrightConfigDoc("export const measuredCiRestartRecoveryMs")),
    [],
    "the restart charge is computed from named terms, so its comment states none",
  );

  // And the slot a project selects but does not run, which cost the previous
  // budget nothing at all.
  assert.equal(
    measuredCiSkippedCaseMs,
    Math.round(measuredCiSkippedTotalMs / measuredCiSkippedAttempts),
    "a skipped slot is charged the mean of the slots the lane skipped",
  );
  assert.deepEqual(
    figuresIn(playwrightConfigDoc("export const measuredCiSkippedCaseMs")),
    [],
    "the skip charge is computed from named terms, so its comment states none",
  );
});

test("bounds a navigation by the same budget its tolerance retries at", () => {
  const {
    actionTimeout,
    navigationTimeout,
    scenarioNavigationAttemptTimeoutMs,
  } = loadConfigSummary();

  // The defect this closes, and it is the standing shape of this engagement:
  // prose that nothing binds drifting from the code beneath it. This block
  // said navigation stayed unbounded on purpose while the fixture that hands
  // every spec its page had already begun installing a bound on it, so the one
  // statement of the rule a reader would find was the opposite of the rule.
  //
  // The bound is declared here as well as installed there, from one binding,
  // so the claim is checkable: a page that never reaches the tolerance is
  // bounded anyway, and a rule stated in this comment is a rule this test
  // fails on.
  assert.equal(
    navigationTimeout,
    scenarioNavigationAttemptTimeoutMs,
    "a navigation must be bounded by the budget its own tolerance retries at",
  );
  assert.ok(
    actionTimeout > 0,
    "an action must be bounded, or a covered control consumes the whole case",
  );
  assert.ok(
    playwrightConfigDoc("navigationTimeout:").includes(
      "scenarioNavigationAttemptTimeoutMs",
    ),
    "the block that bounds a navigation must name the binding it bounds it by",
  );
});

/** An Actions run id, as the workflow and the provenance record cite them. */
const citedRun = /\b\d{11}\b/u;

/**
 * The doc comment that justifies one exported binding in the Playwright config.
 *
 * A figure written into a comment is not checked by anything that reads the
 * comment. Handing the comment text to a test is what lets a figure in it be
 * compared against the value the config computes, so a comment either carries
 * a figure a test binds or it carries no figure at all.
 */
function playwrightConfigDoc(anchor) {
  const justified = new RegExp(
    String.raw`/\*\*((?:(?!\*/)[\s\S])*)\*/\s*${anchor}`,
    "u",
  ).exec(readFileSync(playwrightConfigPath, "utf8"));

  assert.ok(justified, `${anchor} must be justified where it is declared`);

  return justified[1];
}

/**
 * The words English writes a quantity with, and the ones it also writes
 * something else with.
 *
 * `unitNumberWords` are the spellings that are not only numerals: `one` is an
 * article and a pronoun before it is a count — "one after another", "no one",
 * "the one file that holds the budgets" — and its neighbours up to `nine` read
 * the same way. Every other spelling here is a numeral and nothing else.
 */
const unitNumberWords = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const otherNumberWords = [
  "zero",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
];
const numberWordPhrase = new RegExp(
  String.raw`\b(?:${[...unitNumberWords, ...otherNumberWords].join(
    "|",
  )})(?:(?:[\s-]+(?:and[\s-]+)?)(?:${[
    ...unitNumberWords,
    ...otherNumberWords,
  ].join("|")}))*\b`,
  "giu",
);
const unitNumberWordSet = new Set(unitNumberWords);

/**
 * Every figure in a block of prose, whether it is written in digits or in
 * English.
 *
 * The defect this closes. The sweep read digit runs, so a count spelled out
 * evaded it everywhere — and two comments describing the size of the case
 * table went on stating a number the table had left behind, in the one
 * notation nothing looked at. A figure is a figure in either notation.
 *
 * A numeral *phrase* is what the English half reads: a run of number words,
 * joined by spaces, hyphens or `and`. A lone unit word is left, because it is
 * not always a numeral — refusing it would refuse "one after another" and "no
 * one" — while a unit word standing next to another number word is a numeral
 * and nothing else. Everything from `ten` upward is refused wherever it
 * appears; those spellings have no other use.
 *
 * Identifiers are not figures — nothing is computed from one — so an inline
 * code span and an Actions run id are struck out before the rest is read. What
 * is left is arithmetic, and arithmetic in prose is only worth what a test
 * binds it to.
 */
function figuresIn(prose, { stripCode = true } = {}) {
  const searchable = stripCode ? strippedProse(prose) : prose;

  return [
    // A digit glued to a letter, a digit, a dot or an underscore before it is
    // part of a name — `arm64`, `mac14`, `v1.62.1` — not a figure. Read as
    // one, "an arm64 laptop" in a basis restated a figure the day a shard's
    // case count came to equal the digits in the name.
    ...(searchable.match(
      /(?<![\p{L}\p{N}._])\d[\d._,]*\d|(?<![\p{L}\p{N}._])\d/gu,
    ) ?? []),
    ...spelledFiguresIn(prose),
  ];
}

/** Prose with the things that are not figures struck out. */
function strippedProse(prose) {
  return prose.replace(/`[^`]*`/gu, "").replace(/\b\d{11}\b/gu, "");
}

/**
 * The figures a block of prose spells out in English.
 *
 * Separable from the digits because nothing can bind one. A figure written in
 * digits can be compared with a value something derives, and several comments
 * in this repository are held to exactly that; a figure written in words can be
 * compared with nothing, so in prose about a table that changes every round it
 * is a copy with no owner and it goes stale silently.
 */
function spelledFiguresIn(prose) {
  return (strippedProse(prose).match(numberWordPhrase) ?? []).filter(
    (phrase) => {
      const words = phrase.toLowerCase().split(/[\s-]+/u);

      return words.length > 1 || !unitNumberWordSet.has(words[0]);
    },
  );
}

test("reads a figure spelled in English as the figure it is", () => {
  // Planted both ways, because a helper that reported nothing on prose with a
  // spelled count and nothing on prose without one would look identical in
  // every sweep below.
  assert.deepEqual(figuresIn("Two hundred and fifteen cases"), [
    "Two hundred and fifteen",
  ]);
  assert.deepEqual(figuresIn("fifteen chances"), ["fifteen"]);
  assert.deepEqual(figuresIn("forty-seven declined rows"), ["forty-seven"]);
  assert.deepEqual(figuresIn("two hundred"), ["two hundred"]);

  // And the spellings English overloads are left where they are, or the rule
  // would refuse the prose these comments are actually written in.
  assert.deepEqual(figuresIn("one after another, and no one noticed"), []);
  assert.deepEqual(figuresIn("the two lanes are shards"), []);
  assert.deepEqual(figuresIn("a run id 33207988275 is not a figure"), []);
  assert.deepEqual(figuresIn("`fifteen` names a binding"), []);
});

test("reads no figure out of a name that ends in digits", () => {
  // Planted both ways, as above: a name is not a figure, and a figure with a
  // unit after it still is.
  assert.deepEqual(figuresIn("on an arm64 laptop"), []);
  assert.deepEqual(figuresIn("linux-x64 and mac15-arm64"), []);
  assert.deepEqual(figuresIn("the v1.62.1 image", { stripCode: false }), []);
  assert.deepEqual(figuresIn("macOS 14/arm64"), ["14"]);
  assert.deepEqual(figuresIn("64 cases in 64ms (64)"), ["64", "64", "64"]);
});

test("times the non-browser half by the clock its comment cites", () => {
  const { measuredCiNonBrowserMs } = loadConfigSummary();
  const doc = playwrightConfigDoc("export const measuredCiNonBrowserMs\\b");
  const clock = [...doc.matchAll(/\b(\d{2}):(\d{2}):(\d{2})\b/gu)].map(
    ([, hours, minutes, seconds]) =>
      (Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)) * 1_000,
  );

  // The defect this closes. The constant, the clock span its own comment
  // derived it from, and the workflow's restatement of that span were three
  // different renderings of one measurement, and nothing compared them. The
  // span is read out of the comment here, and the constant has to be it.
  assert.equal(
    clock.length,
    2,
    "the non-browser measurement must cite the clock it was read off",
  );
  assert.equal(
    measuredCiNonBrowserMs,
    clock[1] - clock[0],
    "the non-browser half must be the span its own comment cites",
  );
});

test("averages one case over the attempts the mean was taken from", () => {
  const {
    measuredCiCaseMs,
    measuredCiOrdinaryAttempts,
    measuredCiOrdinaryTotalMs,
  } = loadConfigSummary();

  // The defect this closes. The comment stated a total, a divisor and a
  // quotient, and the constant beside it was a rounded version of none of
  // them. The terms belong in the code, where the division is done once and
  // where it can be checked.
  assert.equal(
    measuredCiCaseMs,
    Math.round(measuredCiOrdinaryTotalMs / measuredCiOrdinaryAttempts),
    "the per-case cost must be the mean of the attempts it is taken over",
  );
  assert.deepEqual(
    figuresIn(playwrightConfigDoc("export const measuredCiCaseMs\\b")),
    [],
    "the per-case cost is computed from named terms, so its comment states none",
  );
});

test("counts a restart against the attempts the lane actually reached", () => {
  const {
    measuredCiAnnouncedRestarts,
    measuredCiCasesPerRestart,
    measuredCiCompletedAttempts,
    measuredCiOrdinaryAttempts,
    measuredCiRestartDamagedAttempts,
  } = loadConfigSummary();
  const doc = playwrightConfigDoc("export const measuredCiCasesPerRestart\\b");

  // The defect this closes. The comment divided the restarts the measured
  // lane announced by that lane's runnable case count — a count it never
  // reached, since the provenance record says of the same lane that it expired
  // before completing. A rate may only be divided by what ran.
  assert.equal(
    measuredCiCompletedAttempts,
    measuredCiOrdinaryAttempts + measuredCiRestartDamagedAttempts + 1,
    "the attempts a lane completed are the ones it reported, not the ones it selected",
  );
  assert.equal(
    measuredCiCasesPerRestart,
    Math.floor(measuredCiCompletedAttempts / measuredCiAnnouncedRestarts),
    "the restart rate must divide completed attempts by announced restarts",
  );
  assert.deepEqual(
    figuresIn(doc),
    [],
    "the restart rate is computed from named terms, so its comment states none",
  );
  assert.match(
    doc,
    /provisional/iu,
    "a rate taken over a lane that expired is provisional and must say so",
  );
});

/**
 * The bindings the budgets are built out of, each anchored where it is declared.
 *
 * This list has one job: every one of these must carry a rationale in the place
 * it is declared. It used to have a second one — the no-figure rule was read
 * through it — and that is the hole the sweep below closes. A list of doc
 * comments cannot enforce a rule about comments, because the comment a new
 * author writes is the one the list does not name.
 */
const budgetProseAnchors = [
  "export const shardBudgetProvenance\\b",
  "export const measuredCiLaneStartMs\\b",
  "export const measuredCiOrdinaryAttempts\\b",
  "export const measuredCiOrdinaryTotalMs\\b",
  "export const measuredCiAnnouncedRestarts\\b",
  "export const measuredCiRestartDamagedAttempts\\b",
  "export const measuredCiRestartDamagedTotalMs\\b",
  "export const measuredCiAttemptsDamagedPerRestart\\b",
  "export const laneRetries\\b",
  "export const measuredCiRestartRecoveryMs\\b",
  "export const measuredCiSkippedAttempts\\b",
  "export const measuredCiSkippedTotalMs\\b",
  "export const measuredCiSkippedCaseMs\\b",
  "export const measuredCiCompletedAttempts\\b",
  "const \\{\\s+runnable: shardRunnableCases",
  "export const largestShardCases\\b",
  "export const shardHeadroomFactor\\b",
  "export function shardBudgetMs\\b",
  "export const shardBudgetsMs\\b",
  "function requestedShardNames\\b",
  "const runningShards\\b",
];

/** Every comment in one module, as one block of prose. */
function commentsIn(path) {
  const source = readFileSync(path, "utf8");

  return [
    ...(source.match(/\/\*[\s\S]*?\*\//gu) ?? []),
    ...(source.match(/^[ \t]*\/\/.*$/gmu) ?? []),
  ].join("\n");
}

test("justifies every binding these budgets are argued from", () => {
  for (const anchor of budgetProseAnchors) playwrightConfigDoc(anchor);

  // Derived rather than trusted. A list of anchors is only as complete as the
  // last author's memory of it, so every binding this config exports is
  // required to be justified whether the list names it or not.
  const exported = [
    ...readFileSync(playwrightConfigPath, "utf8").matchAll(
      /^export (?:const|function) ([A-Za-z]\w*)/gmu,
    ),
  ].map(([, name]) => name);

  assert.ok(exported.length > 0, "this config must export its budget terms");
  for (const name of exported) {
    playwrightConfigDoc(`export (?:const|function) ${name}\\b`);
  }
});

test("gives the web server three times the start budget a gate's build overran", () => {
  const summary = loadConfigSummary();

  // The build can run inside the web server's start, so its budget is the one
  // the forced build has to fit; the prose beside it says three times.
  assert.equal(summary.webServerTimeout, summary.webServerStartBudgetMs);
  assert.equal(
    summary.webServerStartBudgetMs,
    3 * summary.overrunWebServerStartBudgetMs,
  );
});

test("leaves no unbound figure in the prose these budgets are argued from", () => {
  const { measuredCiTenantBootstrapMs } = loadConfigSummary();

  // The defect this closes, and the reason it is now a whole-file sweep. Four
  // rounds each fixed the arithmetic in one comment and left new arithmetic in
  // the next; the rule that was supposed to stop that read an allowlist of doc
  // comments, so the one file that actually holds the budgets was the one file
  // a new comment could carry a figure into unnoticed. Every comment in it is
  // read now — what a figure meant is said in words, and the figure itself is a
  // constant the code divides.
  //
  // Two comments are excised rather than exempted, because each states a figure
  // a test binds to what the config computes; both are asserted again below.
  const bound = [
    playwrightConfigDoc("export const measuredCiTenantBootstrapMs\\b"),
    playwrightConfigDoc("export const measuredCiNonBrowserMs\\b"),
    playwrightConfigDoc("export const observedCiLongJourneyFloorMs\\b"),
  ];
  let prose = commentsIn(playwrightConfigPath);
  for (const doc of bound) prose = prose.replace(doc, "");

  assert.deepEqual(
    figuresIn(prose),
    [],
    "a comment in this config states no arithmetic",
  );

  assert.deepEqual(
    figuresIn(bound[0]),
    [String(measuredCiTenantBootstrapMs / 1_000)],
    "the bootstrap comment may state its own constant, in seconds, and nothing else",
  );

  // And the other two may state the clock each was read off, which the tests
  // above require the constant beside it to be.
  for (const doc of bound.slice(1)) {
    const clock = [...doc.matchAll(/\b(\d{2}):(\d{2}):(\d{2})\b/gu)];
    assert.deepEqual(
      figuresIn(doc),
      clock.flatMap(([, ...parts]) => parts),
      "a comment timed off a clock may state that clock and nothing else",
    );
  }

  // The table's own two modules join the sweep. They are where a count of the
  // case table is most tempting to write down, and they are where two stale
  // ones sat: the runner and the fixture that reads the table each opened by
  // saying how large it was, in a notation no rule read.
  for (const module of [
    resolve(webDirectory, "tests/e2e/acceptance-matrix.spec.ts"),
    resolve(webDirectory, "tests/fixtures/acceptance-matrix.ts"),
    resolve(webDirectory, "tests/fixtures/acceptance-shards.ts"),
    resolve(import.meta.dirname, "run-foundation-e2e.mjs"),
  ]) {
    assert.deepEqual(
      figuresIn(commentsIn(module)),
      [],
      `${module}: a comment here states no arithmetic either`,
    );
  }
});

/** Every module under one root, in no particular order. */
function modulesUnder(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(next);
        continue;
      }
      if (/\.(?:mjs|ts|tsx)$/u.test(entry.name)) found.push(next);
    }
  };
  walk(directory);

  return found;
}

/**
 * Every checked-in table whose size a comment could state, derived rather than
 * named.
 *
 * The defect this closes, which is the third round of one shape. The rule below
 * used to read an allowlist of files; then it read one file *name* — the case
 * matrix — and a module was a reader if it mentioned that name. Both are lists
 * with one entry more or less, and the counts the rule exists to stop were
 * never only counts of the case table: the route/state inventory is a checked-in
 * table too, `acceptance-surfaces.ts` opened by stating how many rows of it are
 * framework boundaries, and no rule read that module at all.
 *
 * A table is found by where it lives and what it is, in two forms. The
 * acceptance directory holds the tables this project checks in as data, so
 * every file in it is one — a new table added there joins by being added. And
 * `apps/web/src/test` is where the specification's tables are mirrored for the
 * suites to consume, so a module there that exports an enumerated `as const`
 * list is one too. Neither clause names a file.
 */
function checkedInTables() {
  const tables = readdirSync(acceptanceTableDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(acceptanceTableDirectory, entry.name));

  for (const module of modulesUnder(resolve(webDirectory, "src/test"))) {
    if (module.endsWith(".test.ts") || module.endsWith(".test.tsx")) continue;
    if (
      /^export const \w+[^=]*= \[[\s\S]*?^\] as const;/mu.test(
        readFileSync(module, "utf8"),
      )
    ) {
      tables.push(module);
    }
  }

  return tables.toSorted();
}

/** The relative specifiers one module imports, as resolved file paths. */
function importedModules(module) {
  const directory = resolve(module, "..");

  return [...readFileSync(module, "utf8").matchAll(/from "(\.[^"]*)"/gu)]
    .map(([, specifier]) => resolve(directory, specifier))
    .flatMap((target) => [
      target,
      target.replace(/\.js$/u, ".ts"),
      target.replace(/\.js$/u, ".tsx"),
    ]);
}

/**
 * Every module that reads a checked-in table, found rather than listed.
 *
 * Two ways in, and the second is why this is a derivation rather than a longer
 * list. A module reads a table if it names the table's file — so the parser and
 * the runner join by parsing — or if it imports a module that does, to any
 * depth: the fixtures that hand rows to a spec never mention the JSON, they
 * import the module that reads it, and a count written in one of those is the
 * same stale copy as a count written beside the parse.
 *
 * The set is closed by iteration rather than by recursion so that a cycle
 * terminates, and the sweep below refuses a spelled figure in any of them.
 */
function checkedInTableReaders() {
  const tables = checkedInTables();
  const names = tables.map((table) => basename(table));
  const modules = [
    resolve(webDirectory, "src"),
    resolve(webDirectory, "tests"),
    import.meta.dirname,
  ].flatMap((root) => modulesUnder(root));
  const readers = new Set(
    tables.filter((table) => /\.(?:mjs|ts|tsx)$/u.test(table)),
  );

  for (let growing = true; growing; ) {
    growing = false;
    for (const module of modules) {
      if (readers.has(module)) continue;
      const source = readFileSync(module, "utf8");
      const readsTable =
        names.some(
          (name) =>
            source.includes(name) ||
            source.includes(name.replace(/\.[^.]+$/u, "")),
        ) || importedModules(module).some((target) => readers.has(target));
      if (readsTable) {
        readers.add(module);
        growing = true;
      }
    }
  }

  return [...readers].toSorted();
}

test("leaves no spelled count in a module that reads a checked-in table", () => {
  const tables = checkedInTables();
  const readers = checkedInTableReaders();

  // A derivation that found nothing would satisfy every assertion below. Both
  // tables this repository's counts have described are required by name here —
  // the only place a name appears — and this file reads one of them itself.
  assert.ok(
    tables.includes(acceptanceMatrixPath),
    "the derivation must find the checked-in case matrix",
  );
  assert.ok(
    tables.includes(resolve(webDirectory, "src/test/route-state-inventory.ts")),
    "the derivation must find the checked-in route/state inventory",
  );
  assert.ok(
    readers.includes(
      resolve(import.meta.dirname, "playwright-config.test.mjs"),
    ),
    "the derivation must find this file, which reads the case matrix",
  );
  assert.ok(
    readers.includes(resolve(webDirectory, "src/test/acceptance-surfaces.ts")),
    "the derivation must find the module that counts inventory rows",
  );
  assert.ok(
    readers.length > tables.length,
    "a table has readers besides itself",
  );

  for (const module of readers) {
    assert.deepEqual(
      spelledFiguresIn(commentsIn(module)),
      [],
      `${module}: a count spelled out here is a copy nothing can bind`,
    );
  }
});

/**
 * The key whose strings are the console's own words rather than the author's.
 *
 * The tolerance is argued against lines a browser really printed, and those
 * lines carry figures that belong to the line: a port, a status, a hash. They
 * are the data the predicates are asked about, so a figure inside one is not a
 * claim anybody made. Every other string beside them is prose the author wrote,
 * and the sweep below reads all of it — a new prose field joins by existing,
 * which is the direction this has to fail in.
 */
const consoleLineKey = "text";

/**
 * Every module the console tolerance is argued in, found rather than named.
 *
 * Two ways in, and neither is a list. A module declares the tolerance if it
 * exports a predicate saying what the development server is forgiven — the
 * `development*` naming both of them already carry — and a module joins the
 * argument by importing one of those predicates by name. Importing the fixture
 * is not enough: half this suite imports it for the scenario helpers and has
 * nothing to say about the console.
 */
function consoleToleranceModules() {
  const modules = [
    resolve(webDirectory, "src"),
    resolve(webDirectory, "tests"),
  ].flatMap((root) => modulesUnder(root));
  const declaring = modules.filter((module) =>
    /^export function development\w+/mu.test(readFileSync(module, "utf8")),
  );

  return [
    ...declaring,
    ...modules.filter((module) => {
      const imports = [
        ...readFileSync(module, "utf8").matchAll(
          /import\s*\{([^}]*)\}\s*from\s*"(\.[^"]*)"/gu,
        ),
      ];

      return imports.some(
        ([, named, specifier]) =>
          /\bdevelopment\w+/u.test(named) &&
          [specifier, specifier.replace(/\.js$/u, ".ts")]
            .map((target) => resolve(module, "..", target))
            .some((target) => declaring.includes(target)),
      );
    }),
  ].toSorted();
}

/** Everything an author wrote in one module, as one block of prose. */
function toleranceProse(module) {
  const source = readFileSync(module, "utf8");

  return [
    commentsIn(module),
    ...[...source.matchAll(/\b(\w+): "((?:\\.|[^"\\])*)"/gu)]
      .filter(([, key]) => key !== consoleLineKey)
      .map(([, , written]) => written),
  ].join("\n");
}

test("argues the console tolerance from no count of what a run reported", () => {
  const modules = consoleToleranceModules();

  // A derivation that found nothing would pass every assertion below, so all
  // three sides are required: the fixture that declares the tolerance, the
  // driver that applies it to a real console, and the case that argues what it
  // forgives. This is the only place any of them is named.
  assert.deepEqual(
    modules,
    [
      resolve(webDirectory, "src/test/console-hygiene.test.ts"),
      resolve(webDirectory, "tests/fixtures/acceptance-appearance-drivers.ts"),
      resolve(webDirectory, "tests/fixtures/acceptance-run.ts"),
    ],
    "the derivation must find the tolerance, its driver and its case",
  );

  for (const module of modules) {
    // The exemption is self-checking, and only a module that uses it is asked
    // to justify it. Exempting strings under that key requires the module to be
    // handing the tolerance that same key, so renaming the field fails here
    // rather than quietly exempting nothing.
    const source = readFileSync(module, "utf8");
    if (new RegExp(String.raw`\b${consoleLineKey}: "`, "u").test(source)) {
      assert.match(
        source,
        new RegExp(String.raw`\.${consoleLineKey}\b`, "u"),
        `${module}: the tolerance must be asked about the lines it exempts`,
      );
    }

    // A count of console lines is the one figure nothing here can ever bind:
    // it is read off a job log that is not checked in, it was wrong the first
    // time it was written down, and the argument for the tolerance never
    // needed it — two engines wording one condition is the whole case.
    assert.deepEqual(
      figuresIn(toleranceProse(module)),
      [],
      `${module}: prose arguing this tolerance states no arithmetic`,
    );
  }
});

/**
 * Every figure this config computes, as a comment might have written it.
 *
 * A comment that restates one of these is a copy of a derivation, and a copy
 * drifts the moment the derivation moves — which is how four rounds of these
 * comments each ended up arguing from numbers the code no longer used. A
 * single-digit rendering is left out: it carries no information and would
 * collide with prose that is not arithmetic at all.
 */
function computedFigures(summary) {
  return new Set(
    [
      summary.jobBudgetMs,
      summary.laneRetries,
      summary.largestShardCases,
      summary.measuredCiAttemptsDamagedPerRestart,
      summary.measuredCiCaseMs,
      summary.measuredCiCasesPerRestart,
      summary.measuredCiCompletedAttempts,
      summary.measuredCiLaneStartMs,
      summary.measuredCiNonBrowserMs,
      summary.measuredCiOrdinaryAttempts,
      summary.measuredCiOrdinaryTotalMs,
      summary.measuredCiRestartDamagedTotalMs,
      summary.measuredCiRestartRecoveryMs,
      summary.measuredCiSkippedAttempts,
      summary.measuredCiSkippedCaseMs,
      summary.measuredCiSkippedTotalMs,
      summary.measuredCiTenantBootstrapMs,
      summary.measuredLocalDensityMs,
      summary.measuredLocalProjectsMs,
      summary.observedCiLongJourneyFloorMs,
      ...Object.values(summary.longJourneyMs),
      summary.scenarioNavigationRecoveryMs,
      summary.scenarioReleaseRecoveryMs,
      ...Object.values(summary.shardBudgetsMs),
      ...Object.values(summary.shardRunnableCases),
      ...Object.values(summary.shardSelectedCases),
    ].flatMap((value) =>
      [
        String(value),
        String(value / 1_000),
        (value / 60_000).toFixed(1),
      ].filter((rendering) => rendering.length > 1),
    ),
  );
}

test("says what every long-journey charge rests on", () => {
  const { longJourneyMs, longJourneyProvenance } = loadConfigSummary();

  /*
    The same rule the shard record below is held to, applied to the per-case
    charges — which carried a provenance record that nothing checked.

    That is the failure the shard test names in its own comment: a record that
    says it is checked and is not is worse than one that admits it is prose,
    because the claim is what stops the next reader checking. The record was
    written for three cases and a fourth was charged without one, which is
    exactly how it starts.
  */
  assert.deepEqual(
    Object.keys(longJourneyProvenance).toSorted(),
    Object.keys(longJourneyMs).toSorted(),
    "every case charged apart from the mean must say what its charge rests on",
  );

  for (const [file, entry] of Object.entries(longJourneyProvenance)) {
    assert.ok(
      ["measured", "estimated"].includes(entry.status),
      `${file} must be measured or estimated, not ${entry.status}`,
    );
    assert.ok(
      typeof entry.basis === "string" && entry.basis.trim().length >= 40,
      `${file} must state what its charge rests on`,
    );

    if (entry.status === "measured") {
      assert.match(
        entry.basis,
        citedRun,
        `${file} claims a measurement, so it must cite the run it came from`,
      );
      continue;
    }

    // An estimate that cites a run reads as checked, which is the one thing
    // this record must never do.
    assert.doesNotMatch(
      entry.basis,
      citedRun,
      `${file} is an estimate, so it must not cite a run as though measured`,
    );
  }
});

test("holds the provenance record to the rules its own comment states", () => {
  // The defect this closes. That comment said these four things were required
  // here, and none of them was: `citedRun` was written for the last of them
  // and referenced nowhere. A record that says it is checked and is not is
  // worse than one that admits it is prose, because the claim is what stops
  // the next reader checking.
  const { projects, shardBudgetProvenance } = loadConfigSummary();
  const declared = projects
    .map(({ name }) => name)
    .filter(Boolean)
    .toSorted();

  assert.deepEqual(
    Object.keys(shardBudgetProvenance).toSorted(),
    declared,
    "every declared project must say what its budget rests on",
  );

  for (const [shard, entry] of Object.entries(shardBudgetProvenance)) {
    assert.ok(
      ["measured", "estimated"].includes(entry.status),
      `${shard} must be measured or estimated, not ${entry.status}`,
    );

    // An empty basis is the failure this record's own comment says it
    // prevents: an estimate with a stated basis can be argued with, and one
    // with none cannot. A sentence is the floor.
    assert.ok(
      typeof entry.basis === "string" && entry.basis.trim().length >= 40,
      `${shard} must state what its budget rests on`,
    );

    if (entry.status === "measured") {
      assert.match(
        entry.basis,
        citedRun,
        `${shard} claims a measurement, so it must cite the run it came from`,
      );
      continue;
    }

    // An estimate that cites a run reads as checked. That is the failure this
    // whole record exists to prevent, so it is the one it must refuse.
    assert.doesNotMatch(
      entry.basis,
      citedRun,
      `${shard} is an estimate and may not cite a run`,
    );
  }
});

test("refuses a basis that restates a figure the config derives", () => {
  // The same rule the comments follow, applied to the record beside them. The
  // sweep below reads comments, and a `basis` is a string literal — so every
  // figure in one escaped it, and a basis could quote a budget or a case count
  // that had since moved.
  const summary = loadConfigSummary();
  const computed = computedFigures(summary);
  const restated = [
    ...new Set(
      Object.values(summary.shardBudgetProvenance)
        // Backticks are NOT stripped here, unlike in a comment. In a comment
        // they mark a binding by name; in a basis they mark nothing, and the
        // shipped bases already use them — so stripping them let a basis quote
        // a budget or a case count that had since moved.
        .flatMap((entry) => figuresIn(entry.basis, { stripCode: false }))
        .filter((figure) => computed.has(figure)),
    ),
  ].toSorted();

  assert.deepEqual(
    restated,
    [],
    "a basis may not restate a figure the config derives",
  );
});

test("refuses a comment that restates a figure the config computes", () => {
  const summary = loadConfigSummary();
  const computed = computedFigures(summary);

  // The rule the doc comments already follow, applied to the comments of the
  // tests that enforce it. A defect narrative is prose like any other: it may
  // say what went wrong without transcribing a value that something else
  // derives, because the transcription is what goes stale.
  const restated = [
    ...new Set(
      figuresIn(
        commentsIn(resolve(import.meta.dirname, "playwright-config.test.mjs")),
      ).filter((figure) => computed.has(figure)),
    ),
  ].toSorted();

  assert.deepEqual(
    restated,
    [],
    "a comment here may not restate a figure the config derives",
  );
});
test("justifies the headroom against the largest gap it has to cover", () => {
  const { shardBudgetProvenance, shardRunnableCases } = loadConfigSummary();
  const justified =
    /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export const shardHeadroomFactor\b/u.exec(
      readFileSync(playwrightConfigPath, "utf8"),
    );

  assert.ok(justified, "the headroom must be justified where it is declared");

  // The defect this closes. The rationale enumerated WebKit and a slower
  // runner and sized the factor for "both", and left out the largest unknown
  // of all: no route/state case has ever been timed, and the route/state
  // shards carry more cases than the one lane that was. A headroom argument
  // that omits the biggest thing it is covering is not an argument.
  const largestMeasured = Math.max(
    ...Object.entries(shardBudgetProvenance)
      .filter(([, entry]) => entry.status === "measured")
      .map(([shard]) => shardRunnableCases[shard]),
  );

  for (const [shard, entry] of Object.entries(shardBudgetProvenance)) {
    if (entry.status === "measured") continue;
    if (shardRunnableCases[shard] <= largestMeasured) continue;

    assert.ok(
      justified[1].includes(shard),
      `${shard} is estimated and carries ${shardRunnableCases[shard]} cases against the ${largestMeasured} of the largest measured shard, so the headroom must name it`,
    );
  }
});

test("sums the job budget without restating the counts it sums", () => {
  // The defect this closes. The comment argued the job from the counts the
  // case table declares, and from a hypothetical count of cases that "do not
  // exist" — the table counts the shard-count fix rejected. The budgets summed
  // here are charged for the runnable counts derived from the tree, so the
  // comment was arguing from numbers the code had stopped using, and nothing
  // noticed because nothing reads a comment.
  assert.deepEqual(
    figuresIn(playwrightConfigDoc("export const jobBudgetMs\\b")),
    [],
    "the job budget is a sum of computed budgets, so its comment restates no count",
  );
});

test("keeps the job budget equal to the shards it says it sums", () => {
  // This also compared the budget against the verify workflow's
  // `timeout-minutes`, so that a shard overrunning would be reported as a
  // timed-out shard rather than a cancelled job. There is no job any more. The
  // arithmetic survives on its own merit: `jobBudgetMs` is quoted in comments
  // and read by two other tests, and a sum that has drifted from its parts is
  // wrong whether or not anything schedules it.
  const { jobBudgetMs, measuredCiNonBrowserMs, shardBudgetsMs } =
    loadConfigSummary();

  assert.equal(
    jobBudgetMs,
    Object.values(shardBudgetsMs).reduce((total, budget) => total + budget, 0) +
      measuredCiNonBrowserMs,
  );
});

test("runs one process per lane, not four lanes in one process", () => {
  const { projects } = loadConfigSummary();

  // The defect this closes: the config partitioned four projects by
  // grep/grepInvert while the runner invoked `playwright test` once, with no
  // --project and no --shard, so all four lanes shared one process and one
  // run-wide globalTimeout. CI run 33190770436 was cancelled on that
  // invocation, naming no failing case.
  assert.deepEqual(
    [...FOUNDATION_E2E_LANES].toSorted(),
    projects.map((project) => project.name).toSorted(),
  );
  for (const lane of FOUNDATION_E2E_LANES) {
    assert.deepEqual(buildLaneCommand(lane), {
      args: [
        "--filter",
        "@requestport/web",
        "run",
        "test:e2e",
        "--project",
        lane,
      ],
      command: "pnpm",
    });
  }
});

test("gives every lane its own process and its own budget", async () => {
  const seen = [];
  const code = await runFoundationE2ELanes({
    runLane: async (lane) => {
      seen.push(lane);
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(seen, [...FOUNDATION_E2E_LANES]);
});

test("stops at the first lane that fails and reports its exit code", async () => {
  const seen = [];
  const code = await runFoundationE2ELanes({
    runLane: async (lane) => {
      seen.push(lane);
      return lane === FOUNDATION_E2E_LANES[1] ? 3 : 0;
    },
  });

  assert.equal(code, 3);
  assert.deepEqual(seen, FOUNDATION_E2E_LANES.slice(0, 2));
});

test("names the lane that failed instead of leaving the log to guess", async () => {
  const said = [];
  const reportError = console.error;
  console.error = (...parts) => {
    said.push(parts.join(" "));
  };

  let code;
  try {
    code = await runFoundationE2ELanes({
      runLane: async (lane) => (lane === FOUNDATION_E2E_LANES[2] ? 1 : 0),
    });
  } finally {
    console.error = reportError;
  }

  // A lane now runs under its own budget, so an overrun is that lane's
  // overrun. Playwright reports the timeout inside the child, but it knows
  // nothing about which of the four it was asked to be — so the runner, which
  // does, says it.
  assert.equal(code, 1);
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], new RegExp(`\\b${FOUNDATION_E2E_LANES[2]}\\b`, "u"));
});

test("leaves each lane a report a program can read", () => {
  const { outputDir, reporter } = loadConfigSummary();
  const lane = FOUNDATION_E2E_LANES[0];

  // `line` is written for a person and is gone when the job ends. The
  // run-evidence document is built from what each lane actually ran, case by
  // case, so a lane has to leave behind something a program reads — and the
  // file is named for the shards the process was asked to run, because the
  // lanes share this directory and would otherwise overwrite one another.
  assert.deepEqual(reporter.slice(0, 2), [
    ["line"],
    ["json", { outputFile: acceptanceReportFile([]) }],
  ]);
  assert.deepEqual(
    loadConfigSummary(["--project", lane]).reporter.slice(0, 2),
    [["line"], ["json", { outputFile: acceptanceReportFile([lane]) }]],
  );

  /*
    And a third report, under a directory named for when the run started.

    The report above is named for the lanes and nothing else, so the next run
    of the same lanes overwrites it and a set of them may hold answers from
    several runs. This one cannot be overwritten, which is what makes "every
    run leaves a result" true rather than usually true. The assertions are on
    the shape — a run-stamped directory, a report named for the lanes inside
    it — because the stamp is a clock reading and cannot be predicted here.
  */
  const stamped = (reporters) => {
    const last = reporters.at(-1);
    assert.equal(last?.[0], "json", "the run's own report must be JSON");
    return last[1].outputFile;
  };

  for (const [argv, expectedName] of [
    [[], "all"],
    [["--project", lane], lane],
  ]) {
    const outputFile = stamped(loadConfigSummary(argv).reporter);

    assert.ok(
      outputFile.startsWith(`${e2eResultsRoot}/`),
      `a run's report must live under ${e2eResultsRoot}, not ${outputFile}`,
    );
    assert.equal(
      basename(outputFile),
      `${expectedName}.report.json`,
      "a run's report must be named for the lanes that wrote it",
    );
    assert.match(
      basename(dirname(outputFile)),
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/u,
      "a run's directory must be named by date and time",
    );
  }

  // Playwright empties `outputDir` at the start of every run, so a report
  // written into it would be deleted by the lane that follows.
  assert.ok(
    !acceptanceReportDirectory.startsWith(resolve(webDirectory, outputDir)),
    "a lane report must not live where the next lane's run empties",
  );
});

test("removes this run's lane reports before the first lane runs", async (t) => {
  const order = [];

  await runFoundationE2ELanes({
    lanes: [FOUNDATION_E2E_LANES[0]],
    resetReports: () => order.push("reset"),
    runLane: () => {
      order.push("lane");

      return Promise.resolve(0);
    },
  });

  // A report left by an earlier run is indistinguishable from one this run
  // wrote, and the evidence writer requires a report for every lane — so a
  // lane that never started would be sealed with a previous run's answer.
  assert.deepEqual(order, ["reset", "lane"]);

  const directory = mkdtempSync(join(tmpdir(), "requestport-lane-reports-"));

  t.after(() => rmSync(directory, { force: true, recursive: true }));

  writeFileSync(join(directory, "appearance-chromium.json"), "previous run");
  writeFileSync(join(directory, "route-state-webkit.json"), "another lane");

  resetFoundationE2EReports(["appearance-chromium"], directory);

  // Only the lanes this run is about to answer for. The reset used to empty
  // the directory wholesale, which was right while a run was always every
  // lane — and became a long `pnpm test:webkit` having its reports deleted by
  // a later `verify-locally --e2e` that never touched those lanes.
  assert.deepEqual(readdirSync(directory), ["route-state-webkit.json"]);
});

test("keeps failure artifacts and discards the rest", () => {
  const { outputDir, preserveOutput, projects, use } = loadConfigSummary();

  assert.equal(outputDir, "test-results");
  assert.equal(preserveOutput, "failures-only");
  assert.equal(use.trace, "retain-on-failure");
  assert.equal(use.screenshot, "only-on-failure");
  // Video is the one artifact whose size is unbounded by the failure itself.
  assert.equal(use.video, "off");

  // One policy, and only one. The runbook claimed a lane could switch artifacts
  // off for itself; no lane does, and a per-lane exception would mean the
  // policy a reader checks is not the policy that ran.
  for (const project of projects) {
    assert.deepEqual(
      { keys: project.artifactKeys, name: project.name },
      { keys: [], name: project.name },
      `${project.name} must not carry an artifact policy of its own`,
    );
  }
});

test("is described by the runbook as the single policy it actually is", {
  skip: skipInPublicTree(
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
  ),
}, () => {
  const { preserveOutput, use } = loadConfigSummary();
  const runbook = readFileSync(
    resolve(
      import.meta.dirname,
      "../docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
    ),
    "utf8",
  );

  // The defect this closes: the runbook said "the local browser suite disables
  // trace, screenshot and video for the magic-link outbox lane for this
  // reason". There is no such lane and no such disabling — magic-link sign-in
  // happens in the tenant bootstrap every lane's first case pays for. Reading
  // the settings out of the loaded config and requiring the document to quote
  // them is what stops the document describing a policy nobody wrote.
  for (const [setting, value] of Object.entries({
    ...use,
    preserveOutput,
  })) {
    assert.ok(
      runbook.includes(`\`${setting}: ${value}\``),
      `the runbook must quote the policy the config sets: \`${setting}: ${value}\``,
    );
  }
});

test("names the host platform Playwright installs a browser build for", () => {
  const named = Object.fromEntries(
    Object.entries(hosts).map(([name, host]) => [
      name,
      callSupport("detectHostPlatform", host),
    ]),
  );

  assert.deepEqual(named, {
    ciLinux: "linux-x64",
    ciLinuxArm: "linux-arm64",
    macIntel: "mac14",
    macNext: "mac15-arm64",
    macObserved: "mac14-arm64",
    windows: "win32-x64",
  });
});

test("skips WebKit only on the platform and revision pair that cannot run it", () => {
  // The one observed incompatibility: Playwright 1.62.1 installs WebKit 2251
  // on macOS 14/arm64 while its driver speaks mainline 2336, so every page
  // fails at `Page.overrideSetting: Unknown setting: PushAPIEnabled`.
  const observed = skipReason({
    host: hosts.macObserved,
    manifest: observedManifest,
    playwrightVersion: "1.62.1",
  });

  assert.equal(typeof observed, "string");
  for (const fragment of ["mac14-arm64", "2251", "2336", "PushAPIEnabled"]) {
    assert.ok(
      observed.includes(fragment),
      `the announcement must name ${fragment}: ${observed}`,
    );
  }

  // Every other host runs both engines. CI is `ubuntu-latest`, which is the
  // first entry here, so the skip cannot reach the run that owns the coverage.
  //
  // Each is asked twice, because one `null` answer conflates two states. The
  // observed manifest pins macOS 14 and nothing else, so under it a host is
  // unskipped whether or not it is on the declared list — which is how a name
  // could be added there and lie inert until Playwright pinned it. Asking again
  // under a manifest that pins *this* host's own platform removes the pin from
  // the question and leaves only the list.
  for (const [name, host] of Object.entries(hosts)) {
    if (webkitIncompatibleHosts.includes(name)) continue;
    const hostPlatform = callSupport("detectHostPlatform", host);

    assert.equal(
      skipReason({
        host,
        manifest: observedManifest,
        playwrightVersion: "1.62.1",
      }),
      null,
      `${name} must run WebKit`,
    );
    assert.equal(
      skipReason({
        host,
        manifest: {
          revision: "2336",
          revisionOverrides: { [hostPlatform]: "2251" },
        },
        playwrightVersion: "1.62.1",
      }),
      null,
      `${name} must run WebKit even where Playwright pins its build, so ${hostPlatform} must not be declared incompatible`,
    );
  }
});

test("decides the skip from the declared list, not from the pin alone", () => {
  // The hole this closes. `webkitProtocolSkipReason` answers `null` both for a
  // host that is not declared incompatible and for one that *is* declared but
  // that Playwright happens not to pin, and the fixture manifest pins only
  // macOS 14. So "every other host runs WebKit" could not tell "Linux runs the
  // engine" from "Linux is on the declared list and simply has not been pinned
  // yet" — and the second is a mandatory engine silently leaving CI on the day
  // Playwright does pin it. Telling them apart means asking the same question
  // with the platform pinned, against a list this test can widen.
  const declared = callSupport("webkitProtocolIncompatiblePlatformList", null);
  const pinned = {
    revision: "2336",
    revisionOverrides: { "linux-x64": "2251" },
  };

  const announced = skipReason({
    host: hosts.ciLinux,
    manifest: pinned,
    platforms: [...declared, "linux-x64"],
    playwrightVersion: "1.62.1",
  });

  assert.equal(
    typeof announced,
    "string",
    "a declared platform Playwright pins behind the mainline must be skipped, whichever platform it is",
  );
  assert.ok(announced.includes("linux-x64"), announced);

  // The same host, under the same pin, is not skipped when the list does not
  // name it. The declared list is therefore what decides, which is what makes
  // the assertions below about the *real* list mean something.
  assert.equal(
    skipReason({
      host: hosts.ciLinux,
      manifest: pinned,
      platforms: declared,
      playwrightVersion: "1.62.1",
    }),
    null,
  );
});

test("lets the skip expire with the pin rather than outliving it", () => {
  const caughtUp = {
    revision: "2336",
    revisionOverrides: { "mac14-arm64": "2336" },
  };
  const unpinned = { revision: "2336" };

  for (const manifest of [caughtUp, unpinned]) {
    assert.equal(
      skipReason({
        host: hosts.macObserved,
        manifest,
        playwrightVersion: "1.62.1",
      }),
      null,
    );
  }

  // A manifest that cannot be read is not evidence of an incompatibility, so
  // the engine runs and reports whatever it finds.
  assert.equal(
    skipReason({
      host: hosts.macObserved,
      manifest: null,
      playwrightVersion: "1.62.1",
    }),
    null,
  );
});

test("declares the incompatible platforms rather than matching everything", () => {
  const declared = callSupport("webkitProtocolIncompatiblePlatformList", null);

  assert.ok(Array.isArray(declared));
  assert.ok(declared.length > 0, "an empty list would skip nothing");
  assert.ok(
    declared.length < 4,
    "a list this long is a policy, not a known incompatibility",
  );
  assert.deepEqual(
    declared.filter((entry) => typeof entry !== "string" || entry === ""),
    [],
  );

  // The loop above proves every named host runs WebKit even under a pin, and
  // that is the whole of this suite's evidence. A declared platform no host
  // here names slips past it entirely — inert while Playwright leaves it
  // unpinned, a mandatory engine leaving the run on the day it does not. So the
  // list may only name platforms this suite drives, and widening it means
  // adding the host too.
  const named = Object.values(hosts).map((host) =>
    callSupport("detectHostPlatform", host),
  );

  assert.deepEqual(
    declared.filter((entry) => !named.includes(entry)),
    [],
    `a declared platform must be one this suite names a host for: ${named.join(", ")}`,
  );
});

test("announces the skip on the host it applies to and nowhere else", () => {
  const active = skipReason(null);
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      'await import("./playwright.config.ts");',
    ],
    { cwd: webDirectory, encoding: "utf8", env: guardedEnvironment },
  );

  assert.equal(result.status, 0, result.stderr);
  const announced = `${result.stdout}${result.stderr}`.includes(
    "PushAPIEnabled",
  );
  assert.equal(
    announced,
    active !== null,
    `this host ${active === null ? "runs" : "skips"} WebKit, so the config ${active === null ? "must not announce" : "must announce"} a skip`,
  );
});

test("keeps both engines in the matrix whatever the host can drive", () => {
  const { projects } = loadConfigSummary();
  const engines = [
    ...new Set(projects.map((project) => project.browserName)),
  ].sort();

  // A skip is a property of one run on one host. Dropping the project would
  // make the engine list itself host-dependent, and a matrix that shrinks
  // quietly is the failure this whole arrangement exists to avoid.
  assert.deepEqual(engines, ["chromium", "webkit"]);
});
