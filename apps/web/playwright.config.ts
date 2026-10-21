import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";
import { acceptanceProviderSettings } from "./tests/fixtures/acceptance-provider-settings.ts";
import { acceptanceReportFile } from "./tests/fixtures/acceptance-report.ts";
import { acceptanceShardCounts } from "./tests/fixtures/acceptance-shards.ts";
import { e2eRunDirectory } from "./tests/fixtures/e2e-run-directory.ts";
import {
  scenarioNavigationAttemptTimeoutMs,
  scenarioNavigationRecoveryMs,
} from "./tests/fixtures/scenario-navigation.ts";
import { scenarioReleaseRecoveryMs } from "./tests/fixtures/scenario-release.ts";
import { serverAnswerTimeoutMs } from "./tests/fixtures/server-answer-budget.ts";
import { webkitProtocolSkipReason } from "./tests/fixtures/webkit-support.ts";

const baseURL = "http://127.0.0.1:3100";
const e2eToken = process.env.REQUESTPORT_E2E_TOKEN;
if (
  process.env.NODE_ENV !== "test" ||
  process.env.REQUESTPORT_E2E_MODE !== "1" ||
  !e2eToken ||
  e2eToken.length < 32
) {
  throw new Error("Run foundation E2E through the repository test:e2e script");
}

/**
 * The sign-in provider combination a run was started for (step H.9).
 *
 * `scripts/run-sign-in-combinations.mjs` sets it for the runs it starts, and
 * its test to list cases and load this file; neither `--e2e` nor
 * `pnpm test:e2e` sets it. Set, this configuration runs `signInMethodsProject`
 * alone against the server that runner started on the acceptance port, and
 * declares no web server of its own (see the default export). Unset, the
 * configuration is the four
 * acceptance lanes and nothing here applies to them: their `testDir` is
 * `tests/e2e`, and the sign-in spec lives in `tests/sign-in-combinations`,
 * which no lane reads.
 *
 * Refused unless it is a lower-case name, because it names a report file and
 * a results directory. Whether it is one of the four combinations is the
 * spec's question: it fails a combination's cases against any other.
 */
export const signInCombinationVariable = "REQUESTPORT_SIGN_IN_COMBINATION";
const signInCombination = process.env[signInCombinationVariable];
if (
  signInCombination !== undefined &&
  !/^[a-z][a-z-]*$/u.test(signInCombination)
) {
  throw new Error(
    `${signInCombinationVariable} must be a lower-case combination name`,
  );
}

/** The one project a sign-in combination run declares, on one engine. */
export const signInMethodsProject = Object.freeze({
  name: "sign-in-methods",
  testDir: "./tests/sign-in-combinations",
  use: { browserName: "chromium" as const },
});

/**
 * The tag that routes a spec into the route/state lane.
 *
 * The two lanes are shards, and a shard is only a shard if it partitions: the
 * route/state lane selects exactly the tagged cases and the appearance and
 * interaction lane selects exactly the rest, so no case is run twice on one
 * engine and none is silently dropped. Routing by tag rather than by directory
 * means a spec declares which matrix it belongs to in the spec, where the
 * person writing it can see it.
 */
const routeStateTag = /@route-state/;

/**
 * The engines this release supports.
 *
 * The upstream theme plan fixed the policy: Chromium and WebKit are mandatory,
 * and Firefox is added only if the upstream support policy already promises it.
 * The installed
 * `@cueplusplus/ui` package promises no engine at all — its manifest and
 * `package.json` name none — so Firefox automation remains the documented
 * non-goal rather than a third required project.
 */
const supportedEngines = ["chromium", "webkit"] as const;

/**
 * The one host that cannot drive the WebKit build Playwright installs for it.
 *
 * Both engines stay in the matrix on every platform — the projects below are
 * built from `supportedEngines` and nothing removes one. What a known
 * incompatibility changes is whether the WebKit *cases* run: on the declared
 * platform they are skipped, each carrying this reason, and the run says so
 * once here as well so a green local run never quietly means "one engine did
 * not happen". CI is `ubuntu-latest`, which is not that platform, so the
 * mandated coverage is unaffected. `webkit-support.ts` derives the condition
 * from Playwright's own revision manifest, so the skip expires by itself.
 */
const webkitProtocolSkip = webkitProtocolSkipReason();
if (webkitProtocolSkip !== null) console.warn(`\n${webkitProtocolSkip}\n`);

/**
 * Which shard budgets rest on a measurement, and which do not.
 *
 * One lane has ever been timed, and it has still never finished. So there is a
 * single lane's worth of timing, taken from a lane that was cut short, and
 * every other budget is those same terms multiplied by a case count.
 *
 * That is an estimate, and it is written down as one. A citation attached to a
 * number the cited run never produced is worse than an admitted estimate,
 * because the citation makes it look checked; an estimate with a stated basis
 * can be argued with, and is replaced by the first run that completes the lane.
 *
 * A `basis` is a record of what a run reported, not a derivation performed
 * here, which is why the figures live in it rather than in this comment.
 * `scripts/playwright-config.test.mjs` requires every declared project to
 * appear here, requires every entry to state a basis rather than leave one
 * empty, requires a measured entry to carry a run id — its shape, which is all
 * a test can check — refuses an estimated entry that carries one at all, and
 * refuses any basis that restates in digits a figure this config derives.
 *
 * An earlier version of this comment claimed a set of rules that were enforced
 * nowhere, including one about naming the host that is still not enforced and
 * is no longer claimed. That is the shape of defect this record exists to
 * prevent: a citation that makes an unchecked thing look checked.
 */
export const shardBudgetProvenance = Object.freeze({
  "appearance-chromium": Object.freeze({
    basis:
      "Timed on ubuntu-latest in CI run 33259821308 (2026-08-29). The lane did not complete: it expired with 2 of its selected tests never started, so every term is the wall clock of the attempts it did finish and no whole-lane figure has ever been observed. That run's selection is deliberately not quoted here any more: the lane has gained a case since, so the figure would be a true record of the run and a false statement about this lane, and the test that reads it cannot tell those apart. The long journeys this lane carries are charged individually rather than at that lane's mean, from estimates recorded in longJourneyProvenance.",
    status: "measured",
  }),
  "appearance-webkit": Object.freeze({
    basis:
      "Estimated by applying the appearance-chromium terms to this shard's own counts, with the long journeys it carries charged individually from the estimates recorded in longJourneyProvenance. WebKit is the slower of the two engines. The lane itself now runs to completion inside `mcr.microsoft.com/playwright:v1.62.1-noble` under `pnpm test:webkit`, which retires the older claim here that no WebKit case had ever run anywhere. That is an observation on an arm64 laptop, not the runner these terms were taken on, and no WebKit case has been timed individually on any host — so it is not the basis, and this stays an estimate.",
    status: "estimated",
  }),
  "route-state-chromium": Object.freeze({
    basis:
      "Estimated by applying the appearance-chromium terms to this shard's own counts. No route/state case has ever been timed, and this shard carries the most cases of the four.",
    status: "estimated",
  }),
  "route-state-webkit": Object.freeze({
    basis:
      "Estimated by applying the appearance-chromium terms to this shard's own counts. No route/state case and no WebKit case has been timed individually on any host. The lane runs to completion under `pnpm test:webkit` in the Playwright image, on an arm64 laptop rather than the runner the terms came from. Running to completion is not passing: docs/implementation/gotchas.md records this lane failing intermittently, in more than one way, and no wall clock from it is quoted here because a lane that fails a case mid-run is not a lane whose duration means anything.",
    status: "estimated",
  }),
});

/** Playwright process start to the first case: the web server coming up. */
export const measuredCiLaneStartMs = 34_001;

/**
 * The tenant every lane bootstraps once.
 *
 * The first case that actually runs pays for a bootstrap, a magic-link
 * sign-in, an organization, a project and a request, all against routes the
 * development server compiles on first request. It took 112.697s; every later
 * case in the lane took what the lines below say. That case is one of the
 * lane's own runnable cases rather than an extra one, which is why the budget
 * charges the per-case cost to the rest of them.
 */
export const measuredCiTenantBootstrapMs = 112_697;

/**
 * The attempts the per-case mean is taken over.
 *
 * The measured lane's attempts, less the tenant bootstrap, less every slot it
 * skipped, less the retries, and less the ones a development-server restart
 * damaged.
 */
export const measuredCiOrdinaryAttempts = 31;

/** What those attempts cost in all, as the measured lane reported them. */
export const measuredCiOrdinaryTotalMs = 465_844;

/**
 * One ordinary case.
 *
 * The mean of the two terms above rather than a number typed beside them, so
 * the division is done once, in the place a reviewer can re-run it.
 */
export const measuredCiCaseMs = Math.round(
  measuredCiOrdinaryTotalMs / measuredCiOrdinaryAttempts,
);

/**
 * The slots the measured lane selected and did not run.
 *
 * A project greps titles, and the matrix runner then skips the case from
 * inside it: because the case declares another engine, or because the
 * checked-in rules decline the state it drives. Neither decides anything until
 * the case has been given a browser context, so neither is free — and the
 * budget before this one charged the first nothing at all and the second the
 * price of a case it never started. The lane this was measured on met only the
 * engine skip; both are charged at it, because both are the same slot.
 */
export const measuredCiSkippedAttempts = 16;

/** What those slots cost in all, as the measured lane reported them. */
export const measuredCiSkippedTotalMs = 4_446;

/** One skipped slot, divided once, in the place a reviewer can re-run it. */
export const measuredCiSkippedCaseMs = Math.round(
  measuredCiSkippedTotalMs / measuredCiSkippedAttempts,
);

/** Restarts the measured lane announced before it expired. */
export const measuredCiAnnouncedRestarts = 3;

/** Attempts of that lane that one of those restarts damaged. */
export const measuredCiRestartDamagedAttempts = 6;

/**
 * What those damaged attempts cost in all.
 *
 * Each restart cost the lane a pair of attempts: the one that met it, and the
 * next one to ask the fresh child for a route it had not compiled yet.
 */
export const measuredCiRestartDamagedTotalMs = 601_756;

/**
 * The attempts one restart is measured to damage.
 *
 * Derived from the terms above rather than typed beside them, and it is what
 * the measured lane reported: a restart costs the lane the attempt that met it
 * and the attempt after it, which asks the fresh child for a route it has not
 * compiled yet. It is also, so far, every attempt this suite has ever had to
 * run again — each flaky case any lane has reported failed at a restart — so
 * it is what the retry charge below is derived from.
 */
export const measuredCiAttemptsDamagedPerRestart = Math.round(
  measuredCiRestartDamagedAttempts / measuredCiAnnouncedRestarts,
);

/**
 * How many times the runner re-runs a case that failed.
 *
 * One binding, read by the budget below and by the runner further down it,
 * because a budget that assumed a different number from the runner would be a
 * ceiling for a lane that does not exist. Playwright is given a retry in CI
 * and none on a developer machine.
 *
 * The hole this closes. The per-case mean every shard is charged from was
 * taken over the measured lane's ordinary attempts with its retries taken out,
 * and nothing charged them back — so every attempt the runner made again was
 * wall clock no budget had paid for, in the lane where a restart makes an
 * attempt fail and a retry is what recovers it.
 */
export const laneRetries = process.env.CI ? 1 : 0;

/**
 * What one restart costs the lane.
 *
 * The excess the damaged attempts carried over what they would have cost as
 * ordinary ones, over the restarts the lane announced — floored by what the two
 * retry loops that survive a restart are allowed to spend on one, because a
 * budget that charged less than the code can spend would be no bound at all.
 *
 * The defect this replaces. A restart used to be charged the release loop's own
 * ceiling, which is the one recovery the fixtures happened to declare a
 * constant for and is not what a restart costs: the child that takes over
 * recompiles whatever route is asked for next, and the case that met the
 * restart pays for meeting it. Every other term in that budget was right, and
 * the lane still expired inside it with cases unstarted.
 */
export const measuredCiRestartRecoveryMs = Math.max(
  Math.round(
    (measuredCiRestartDamagedTotalMs -
      measuredCiRestartDamagedAttempts * measuredCiCaseMs) /
      measuredCiAnnouncedRestarts,
  ),
  scenarioReleaseRecoveryMs + scenarioNavigationRecoveryMs,
);

/**
 * Attempts the measured lane completed before it expired.
 *
 * The ordinary attempts the mean is taken over, plus the ones a restart
 * damaged, plus the one tenant bootstrap. The lane expired rather than
 * finishing, so this is what it reached — not what its project selected, and
 * not what it would have run. Dividing a rate by the latter charges it to
 * cases that never executed.
 */
export const measuredCiCompletedAttempts =
  measuredCiOrdinaryAttempts + measuredCiRestartDamagedAttempts + 1;

/**
 * How often the development server restarts itself.
 *
 * `next dev` exits once its heap use crosses the share of the limit its
 * supervisor watches, so a fresh child can take over. The rate is the attempts
 * the lane completed over the restarts announced while it completed them; what
 * one restart costs is the term above.
 *
 * It is provisional. The lane it is taken from expired, so this is a rate over
 * part of a lane, and the first run that completes one replaces it.
 */
export const measuredCiCasesPerRestart = Math.floor(
  measuredCiCompletedAttempts / measuredCiAnnouncedRestarts,
);

/**
 * What the two longest journeys in this tree cost where they can be timed.
 *
 * A per-case mean is a fair charge only while the cases it is taken over cost
 * roughly the same, and these two do not: one drives every density at every
 * width and the other completes owner setup, project administration, an
 * invitation and a member's access in a single case. On this repository's
 * development host they cost these. Each is read from the lane report
 * `test:e2e` writes rather than typed off a console, and each is the dearer of
 * the observations this host has produced for that case, because a ceiling
 * built on the cheaper of two runs of the same case is one that run-to-run
 * spread alone can breach.
 *
 * They are named by file because that is what the shard derivation attributes a
 * case to, so a lane is charged for one exactly when it runs it.
 */
export const measuredLocalDensityMs = 130_498;

/** The other, read the same way and chosen the same way. */
export const measuredLocalProjectsMs = 63_443;

/**
 * The third, and the only one of them that walks an OAuth authorization.
 *
 * `agent-consent.spec.ts` bootstraps a tenant, signs in through a magic link,
 * creates an organization, registers a client through dynamic client
 * registration, walks `/oauth2/authorize`, approves the consent and follows the
 * redirect to the client's callback. Read on the development host, the same way
 * as the two above.
 */
export const measuredLocalAgentConsentMs = 66_012;

/**
 * The fourth, and the only one of these read from a run this repository kept.
 *
 * `agent-journey.spec.ts` continues where the consent journey stops: it
 * redeems the token, creates a project, provisions a working credential and
 * spends it, files and submits a request, crosses to the browser for a human
 * to triage and answer, and crosses back to read the timeline. Read on the
 * development host like the three above, from the acceptance run directory the
 * lane runner now writes, so the number has an artefact behind it rather than
 * a memory of one.
 */
export const measuredLocalAgentJourneyMs = 45_400;

/**
 * What the longer of those two had already spent on the runner.
 *
 * CI run 33315836689 started that case at 14:35:33 and a development-server
 * restart interrupted it at 14:38:14, so the span between them is time the case
 * had spent in CI without finishing. It is a floor rather than a cost — the
 * case has never completed on the runner — and it is the only comparison this
 * suite has between a long journey here and the same journey there.
 * `scripts/playwright-config.test.mjs` reads that clock out of this comment and
 * refuses a constant that is not the span between them.
 */
export const observedCiLongJourneyFloorMs = 161_000;

/**
 * How much slower the runner is than the host those local figures came from.
 *
 * The floor over the local cost of the same case, divided once, here, where a
 * reviewer can re-run it. Both terms are about that one case, which is why it
 * is a ratio rather than a second measurement: nothing has timed the other
 * journey on the runner at all, and applying the ratio to it is the honest
 * thing available. It is itself a floor, because the case it comes from was
 * interrupted rather than completed — `shardHeadroomFactor` still sits on top
 * of everything this produces.
 */
export const longJourneyCiFactor =
  observedCiLongJourneyFloorMs / measuredLocalDensityMs;

/**
 * What a lane is charged for each of those journeys, by the file it lives in.
 *
 * The local cost scaled by the ratio above. Both entries are estimates and are
 * recorded as such below; neither is a figure any run has ever reported for a
 * completed case.
 */
export const longJourneyMs: ReadonlyMap<string, number> = new Map([
  ["density.spec.ts", Math.round(measuredLocalDensityMs * longJourneyCiFactor)],
  [
    "projects.spec.ts",
    Math.round(measuredLocalProjectsMs * longJourneyCiFactor),
  ],
  [
    "agent-consent.spec.ts",
    Math.round(measuredLocalAgentConsentMs * longJourneyCiFactor),
  ],
  [
    "agent-journey.spec.ts",
    Math.round(measuredLocalAgentJourneyMs * longJourneyCiFactor),
  ],
]);

/**
 * Where each of those charges comes from.
 *
 * The same discipline `shardBudgetProvenance` applies to a lane, applied to a
 * case: an estimate is admitted as one and states its basis, and it cites no
 * run, because no run has produced the cost of either of these cases.
 * `scripts/playwright-config.test.mjs` requires every charge the budget makes
 * to appear here, and refuses an estimate that cites a run.
 */
export const longJourneyProvenance = Object.freeze({
  "density.spec.ts": Object.freeze({
    basis:
      "Estimated: this case's wall clock on the development host, scaled by the only comparison this suite has between that host and the runner — the elapsed time this same case had accumulated in CI before a development-server restart interrupted it, recorded and bound where that floor is declared. The case has never completed on the runner, so no run has produced its cost.",
    status: "estimated",
  }),
  "projects.spec.ts": Object.freeze({
    basis:
      "Estimated: this case's wall clock on the development host, scaled by that same comparison. Nothing has timed this case on the runner at all, so the ratio is borrowed from the other long journey.",
    status: "estimated",
  }),
  "agent-consent.spec.ts": Object.freeze({
    basis:
      "Estimated: this case's wall clock on the development host, scaled by that same comparison. It is newer than every run this file cites, so no run has reported it at all, and the ratio is borrowed exactly as the journey above borrows it.",
    status: "estimated",
  }),
  "agent-journey.spec.ts": Object.freeze({
    basis:
      "Estimated: this case's wall clock on the development host, taken from a kept acceptance run directory rather than from a terminal, and scaled by that same borrowed ratio. The runner it would be scaled to no longer exists, so the scaling is the weakest part of this charge and is named as such: what the number rests on is a local measurement, and the factor is inherited from a comparison made when there was still a runner to compare against.",
    status: "estimated",
  }),
});

/**
 * Re-exported so the budget above and the tests that check it read one value.
 *
 * Both are ceilings a retry loop declares for itself, and together they are
 * what this suite can spend waiting out one restart. The restart charge is
 * floored by their sum rather than composed of it: the measurement is what a
 * restart cost, and these are what it may not cost less than.
 */
export { scenarioNavigationRecoveryMs, scenarioReleaseRecoveryMs };

/**
 * The non-browser half of the verify job.
 *
 * Two databases provisioned, the migration history applied twice, the cutover
 * race, lint, typecheck, unit tests, build and two browser installs: 15:17:31
 * to 15:31:27 in the measured run. `scripts/playwright-config.test.mjs` reads
 * that span out of this comment and refuses a constant that is not it. The
 * checkout and the dependency install come before it and the evidence upload
 * after it, so the job's own ceiling has to leave room for them on top of this.
 */
export const measuredCiNonBrowserMs = 836_000;

/**
 * How many cases each shard actually carries.
 *
 * Derived from the tree Playwright loads, not from the case table. A project
 * selects by grep, so both appearance shards also carry every untagged spec —
 * cases the previous count charged to nobody, on top of what the table
 * declares. `acceptance-shards.ts` attributes every case in the tree to
 * a lane by the same tag the projects grep on, refuses a spec no shard claims,
 * and is checked against Playwright's own listing by
 * `scripts/playwright-config.test.mjs`.
 *
 * `selected` is what the grep picks up; `runnable` is what the project will
 * actually start, which is what is left once the runner has skipped the cases
 * the table declares on the other engine *and* the cases the checked-in rules
 * decline. The second class is asked of the same function the runner asks, so
 * a rule added to that list lowers this count in the same edit — which
 * `scripts/playwright-config.test.mjs` proves by planting one. Both counts are
 * charged below, at what each measured: a case at what a case costs, and the
 * difference between the counts at what a skipped slot costs.
 */
const {
  runnable: shardRunnableCases,
  runnableFiles: shardRunnableFiles,
  selected: shardSelectedCases,
} = acceptanceShardCounts(supportedEngines);

export { shardRunnableCases, shardSelectedCases };

/**
 * What each shard's own long journeys are charged, dearest first.
 *
 * Derived from the files the shard actually runs rather than declared per lane,
 * so a journey is charged to a shard exactly when that shard starts it — and a
 * rule that declines it, or an engine that skips it, takes the charge away in
 * the same edit. Dearest first because the retry term below spends from the
 * front: a lane that retries something is likelier to have retried the case
 * that was running when the server restarted under it, and the ceiling has to
 * survive that rather than the cheapest case it could have been.
 */
export const shardLongJourneyMs: ReadonlyMap<string, readonly number[]> =
  new Map(
    [...shardRunnableCases.keys()].map((name) => [
      name,
      [...(shardRunnableFiles.get(name) ?? new Map<string, number>())]
        .flatMap(([file, started]) => {
          const charge = longJourneyMs.get(file);

          return charge === undefined
            ? []
            : Array.from({ length: started }, () => charge);
        })
        .toSorted((dearer, cheaper) => cheaper - dearer),
    ]),
  );

/** The biggest shard the acceptance tree produces. */
export const largestShardCases = Math.max(...shardRunnableCases.values());

/**
 * What the measurement still does not cover.
 *
 * Three things, and the third is the largest. WebKit, the slower engine of the
 * two, for which no case has been timed individually on any host — its lanes do
 * run under `pnpm test:webkit`, which retires the older claim that WebKit had
 * never run anywhere, and what that yields is a whole-lane wall clock on a
 * laptop rather than the per-case terms a budget is built from. A runner slower
 * than the one the terms were taken on. And the route/state lanes: no
 * route/state case has been timed individually either, and
 * `route-state-chromium` and `route-state-webkit` each carry more cases than
 * the one lane that was timed, so most of the browser half of this job is a
 * per-case cost measured on a different lane and multiplied by a count.
 *
 * A quarter again is what this factor buys on top of terms measured where the
 * shard runs; doubling it, as the laptop-derived budget did, would be slack
 * large enough to hide a hang. It does not make an untimed lane safe and is
 * not meant to: `shardBudgetProvenance` names the lanes that are estimated,
 * and the first run that completes one replaces the estimate rather than
 * widening this.
 */
export const shardHeadroomFactor = 1.25;

/**
 * How long one shard may take.
 *
 * A shard runs in its own process, so this budget *is* the per-shard budget —
 * and it only became one when the runner started launching a child per
 * project. Before that, `playwright test` ran all four lanes in one process
 * under this one number, so it had to cover their sum; a run that overspent
 * was cancelled by the workflow, which reports nothing about which case was
 * running, rather than failing as the timeout Playwright would have named.
 *
 * Every term is charged to the quantity that spends it: the lane comes up
 * once, the tenant is bootstrapped once by a case that is one of the runnable
 * ones, the rest of the runnable cases cost what a case costs, every slot the
 * project selects and then skips — for its engine or for its state — costs
 * what a skip costs, and the development server restarts itself at the
 * measured rate and costs the measured recovery each time.
 *
 * Except the journeys a mean cannot pay for. Two cases in this tree cost
 * several times what an average one does, so a lane that carries them is
 * charged each of them at what it costs and the rest of its cases at the mean.
 * Charging all of them at the mean is what left the ceiling unable to pay for
 * the lane's own most expensive case.
 *
 * And the attempts the runner makes again. A restart damages more attempts
 * than the one it interrupts, and the runner is given a retry for each of
 * them. What a retry costs is what the retried case costs, so the charge is
 * spent from the dearest case the lane carries downwards, and only then at the
 * mean: a case can be re-run no more often than the runner retries it, and the
 * scenario that put the previous ceiling back at risk was a retry of the
 * dearest one. Charging the attempts to the restarts rather than to the case
 * count is what keeps their number a measurement: every case this suite has
 * ever retried failed at a restart.
 *
 * Derived rather than asserted, and every term is either a measurement from
 * the host that runs the shard, a count read from the checked-in table, an
 * estimate whose basis is recorded beside it, or a bound another module
 * declares. Changing it means changing one of those, which is a change a
 * reviewer can argue with.
 */
export function shardBudgetMs(
  runnable: number,
  skipped: number,
  retries: number = laneRetries,
  longJourneys: readonly number[] = [],
): number {
  const restarts = Math.ceil(runnable / measuredCiCasesPerRestart);
  const dearestFirst = [...longJourneys].toSorted(
    (dearer, cheaper) => cheaper - dearer,
  );
  const retried = retries * restarts * measuredCiAttemptsDamagedPerRestart;
  const retriedLong = dearestFirst.slice(
    0,
    Math.min(retried, retries * dearestFirst.length),
  );
  const total = (charges: readonly number[]) =>
    charges.reduce((sum, charge) => sum + charge, 0);

  return Math.round(
    (measuredCiLaneStartMs +
      measuredCiTenantBootstrapMs +
      (runnable - 1 - dearestFirst.length) * measuredCiCaseMs +
      total(dearestFirst) +
      skipped * measuredCiSkippedCaseMs +
      restarts * measuredCiRestartRecoveryMs +
      total(retriedLong) +
      (retried - retriedLong.length) * measuredCiCaseMs) *
      shardHeadroomFactor,
  );
}

/** One budget per shard, named by the project that spends it. */
export const shardBudgetsMs = new Map(
  [...shardRunnableCases].map(([name, runnable]) => [
    name,
    shardBudgetMs(
      runnable,
      (shardSelectedCases.get(name) ?? 0) - runnable,
      laneRetries,
      shardLongJourneyMs.get(name) ?? [],
    ),
  ]),
);

/**
 * The shards this process was launched to run.
 *
 * `run-foundation-e2e.mjs` gives every lane its own process and names it with
 * `--project`, so a process knows exactly which shards it is answerable for.
 * Anything else — a bare `playwright test`, a listing — runs every lane in one
 * process and is answerable for all of them.
 */
function requestedShardNames(argv: readonly string[]): readonly string[] {
  const flag = "--project";
  const requested = argv.flatMap((argument, index) => {
    if (argument === flag)
      return argv[index + 1] === undefined ? [] : [argv[index + 1] as string];

    return argument.startsWith(`${flag}=`)
      ? [argument.slice(flag.length + 1)]
      : [];
  });

  return requested.filter((name) => shardBudgetsMs.has(name));
}

/**
 * How many passes of each case this process was asked for.
 *
 * `--repeat-each` multiplies the work without multiplying anything the budget
 * is derived from, so an unscaled budget is spent before the run finishes and
 * Playwright ends it with a suite timeout: cases reported as "did not run" and
 * the lane reported as failed, for a run that failed nothing. Scaling the
 * budget by the repeat keeps an overrun an overrun and a repeat a repeat.
 *
 * A count Playwright itself would reject leaves the budget alone, because the
 * run it would have paid for is one Playwright will refuse to start.
 */
function requestedRepeatEach(argv: readonly string[]): number {
  const flag = "--repeat-each";
  const [requested] = argv.flatMap((argument, index) => {
    if (argument === flag)
      return argv[index + 1] === undefined ? [] : [argv[index + 1] as string];

    return argument.startsWith(`${flag}=`)
      ? [argument.slice(flag.length + 1)]
      : [];
  });

  if (requested === undefined) return 1;

  const count = Number(requested);

  return Number.isInteger(count) && count > 0 ? count : 1;
}

/**
 * How long this process may take: the budget of every shard it will run.
 *
 * A computed budget that is never applied to the shard that spends it is not a
 * bound. Before this, every lane ran under the *largest* shard's ceiling, so an
 * appearance/webkit shard could overrun its own budget by half an hour and
 * still be inside the number Playwright was enforcing; what eventually stopped
 * it was the job timeout, which cancels the run and names no lane and no case.
 * Bounding a process by what it was asked to run makes an overrun fail as an
 * overrun of that lane, reported by Playwright, in that lane's own log.
 */
const runningShards = requestedShardNames(process.argv);

/**
 * What this process answers for, as one word for a filename. A process asked
 * for no shard runs every lane and answers for all of them.
 */
const runName =
  runningShards.length > 0 ? [...runningShards].toSorted().join("+") : "all";
const shardTimeoutMs =
  (runningShards.length > 0
    ? runningShards
    : [...shardBudgetsMs.keys()]
  ).reduce((total, name) => total + (shardBudgetsMs.get(name) ?? 0), 0) *
  requestedRepeatEach(process.argv);

/**
 * What the whole verification job has to be able to host.
 *
 * The shards share one fixed loopback port, so they run one after another in
 * this job and it pays for every one of them — each for its *own* budget,
 * rather than for the largest budget counted once per shard, which would
 * charge the job for cases no shard carries. Each of those budgets is charged
 * for what its project actually runs and actually skips, so no count is
 * restated here: `shardRunnableCases` and `shardSelectedCases` are the counts,
 * derived from the tree.
 *
 * `measuredCiNonBrowserMs` is the rest of the job. A runner hosting this had to
 * declare at least this much, or an overrun was cancelled by the job — which
 * names no case — instead of failing as the timeout Playwright would have
 * named. No runner hosts it any more: the lanes run on a developer machine now,
 * where nothing imposes an outer limit. The budget is kept because it is what
 * the shard timeouts are derived from, and because a sum that has drifted from
 * its parts is wrong whether or not anything schedules it.
 */
export const jobBudgetMs =
  [...shardBudgetsMs.values()].reduce((total, budget) => total + budget, 0) +
  measuredCiNonBrowserMs;

/**
 * The start budget the web server had until a gate's build overran it.
 *
 * The web server's start is more than a start. `start-e2e-server.mjs` builds
 * the tree first whenever the build on disk is older than any of its sources,
 * which is every gate after a rebase or an edit, and under `--force` that
 * build recompiles every package before `next build`, because `TURBO_FORCE`
 * reaches it. So this budget has to hold the build as well as the start.
 * Gates begun on a quiet development host compiled in a small part of it.
 * One of Track `E.2`'s forced gates, begun at a higher load that other work
 * kept raising, ran out of it during static page generation, with nothing
 * failed and no case run.
 */
export const overrunWebServerStartBudgetMs = 300_000;

/**
 * Three times the budget that was overrun. A server that never starts is still
 * reported, only later; a build that is finishing is not cut off.
 */
export const webServerStartBudgetMs = 3 * overrunWebServerStartBudgetMs;

const acceptanceLanes = defineConfig({
  expect: { timeout: serverAnswerTimeoutMs },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalTimeout: shardTimeoutMs,
  /**
   * One directory per lane, because Playwright empties this one at the start of
   * every run and the lanes are separate processes that run one after another.
   * Sharing it meant the last lane erased what the earlier ones had left, so a
   * run whose fourth lane failed could only ever explain that lane — a flake in
   * the first was gone by the time anything looked. `acceptance-report.ts`
   * already keeps the lane reports out of here for the same reason; the traces
   * and screenshots a failure leaves behind need the same treatment.
   *
   * It only half works, and the half that does not is load-bearing elsewhere.
   * A case's own directory is computed in the **worker**, which re-imports this
   * file in a process whose `process.argv` carries no `--project` — so
   * `runningShards` is empty there and a failing case writes to a flat
   * `test-results/<case>-<project>/`, not under the lane. Observed: a container
   * run left `test-results/acceptance-matrix-…-route-state-webkit/trace.zip`
   * beside a `test-results/route-state-webkit/` holding nothing but
   * `.last-run.json`.
   *
   * So the per-lane directory receives almost nothing, and the start-of-run
   * emptying quoted above never reaches the case directories either. That is
   * why `scripts/run-webkit-lanes.mjs` clears a lane's artefacts by name before
   * laying down a run's. Repairing this — reading the project from Playwright's
   * own `configCLIOverrides` rather than from `process.argv` — would make that
   * clearing match different paths, so the two must move together.
   */
  outputDir: ["test-results", ...runningShards].join("/"),
  /**
   * Artifacts are kept only where they explain something. A passing case's
   * output directory is deleted, a failing case keeps its trace and its final
   * screenshot, and video — the one artifact whose size is unbounded by the
   * failure itself — is never recorded. CI retention is bounded on top of
   * this; nothing here writes an artifact a passing run would have to store.
   */
  preserveOutput: "failures-only",
  projects: supportedEngines.flatMap((browserName) => [
    {
      grepInvert: routeStateTag,
      name: `appearance-${browserName}`,
      use: { browserName },
    },
    {
      grep: routeStateTag,
      name: `route-state-${browserName}`,
      use: { browserName },
    },
  ]),
  /**
   * Two reporters, for two readers.
   *
   * `line` is written for a person watching the job and is gone when the job
   * ends. The run-evidence document is built from what each lane actually ran,
   * case by case, so a lane also has to leave behind something a program can
   * read — and it is named for the shards this process was asked to run,
   * because every lane shares one report directory and would otherwise
   * overwrite the answer the lane before it gave.
   */
  reporter: [
    ["line"],
    ["json", { outputFile: acceptanceReportFile(runningShards) }],
    /*
      The run's own copy, under a directory named for when the run started.

      The report beside this one is named for the lanes and nothing else, so it
      is overwritten by the next run of the same lanes and a directory holding
      every lane may hold answers from several runs — its own docblock says so,
      and says that whatever replaced it would have to stamp a run onto each
      report. This is that stamp: the directory is the run, every lane of one
      run writes into the same one because `run-foundation-e2e.mjs` names it in
      the environment, and a lane started on its own gets a directory of its
      own. Nothing here is ever overwritten, so a run always leaves a result.
    */
    [
      "json",
      {
        outputFile: resolve(e2eRunDirectory(), `${runName}.report.json`),
      },
    ],
  ],
  retries: laneRetries,
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  /**
   * How long one case may take.
   *
   * The acceptance cases are not one journey each: several make two full
   * navigations of the same surface to compare what a reduced role can reach,
   * one signs out and signs back in, and every one of them writes an appearance
   * preference and opens and releases a guarded scenario run before it starts.
   * The budget before this one was the cost of a single navigation, and it left
   * the heavier cases failing as timeouts rather than as assertions. Nothing
   * here waits on
   * a wall clock — every assertion carries its own, far smaller budget — so a
   * genuine hang still fails as a hang, just later.
   */
  timeout: 120_000,
  use: {
    /**
     * Playwright leaves *action* timeouts unbounded by default, and an unbounded
     * action is the least legible failure this suite can produce: a click on a
     * covered control, or an `evaluate` on a locator that matches nothing, does
     * not fail — it silently consumes the whole test budget and is reported as
     * "the journey ran out of time", pointing at no line and naming no locator.
     * Bounding them turns every one of those back into a named selector and a
     * call log.
     */
    actionTimeout: 45_000,
    baseURL,
    /**
     * And navigation, which this block used to leave unbounded on purpose.
     *
     * The reasoning it gave was that the development server compiles a route on
     * first request, so only the case's own budget should decide how long that
     * may take. That is wrong about the failure a navigation here has to
     * survive: the socket `next dev`'s supervisor holds keeps accepting while
     * no child is serving, so a request in flight is neither delivered nor
     * refused, and a wait with no bound ends only when the case does — which is
     * how a restarting server came to be reported as a journey running out of
     * time, naming no server and no restart.
     *
     * `scenario-navigation.ts` bounds an attempt for exactly that, treats its
     * own bound elapsing as the server not answering, and asks again; it
     * installs `scenarioNavigationAttemptTimeoutMs` on every page it is handed.
     * Declaring the same binding here is what makes the rule true in the place
     * a reader looks for it, and it bounds a page that never reaches the
     * tolerance. `scripts/playwright-config.test.mjs` compares the two, so this
     * comment cannot come to say the opposite of what the suite does again.
     */
    navigationTimeout: scenarioNavigationAttemptTimeoutMs,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  workers: 1,
  /**
   * Asked for by path rather than imported, which is what keeps the specs out
   * of it: the module reads the surfaces table, and a table read from anything
   * `fixtures/engine.ts` imports would make every spec in the tree a reader of
   * a checked-in table. `tests/warm-addresses.ts` says why it warms.
   */
  globalSetup: "./tests/warm-addresses.ts",
  webServer: {
    command:
      "node ../../scripts/with-root-env.mjs node ../../scripts/start-e2e-server.mjs",
    env: {
      ...process.env,
      ...acceptanceProviderSettings,
      BETTER_AUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      NODE_ENV: "test",
      REQUESTPORT_E2E_MODE: "1",
      REQUESTPORT_E2E_TOKEN: e2eToken,
    },
    reuseExistingServer: false,
    /*
      The server's own record, in the run that failed.

      A consent refusal names a code and nothing else in the browser — by
      design, since the reason may carry a person's identity. The reason is
      written to the server log, and without this that log is not in the run
      at all: a red lane could only be diagnosed by reproducing it locally.
    */
    stdout: "pipe" as const,
    timeout: webServerStartBudgetMs,
    url: baseURL,
  },
});

/**
 * One sign-in combination's run: the acceptance lanes' settings, with the
 * sign-in project in place of the four lanes.
 *
 * No web server and no warm-up: the runner has started the server before
 * Playwright starts, and a web server declared here would be refused on a
 * port that server already holds. The results directory and the report are
 * named for the combination, so the four runs of one invocation do not
 * overwrite each other. The global ceiling is five of the per-case `timeout`
 * above; `scripts/run-sign-in-combinations.test.mjs` holds each combination
 * to fewer cases than that.
 */
function signInCombinationRun(combination: string) {
  return defineConfig({
    ...acceptanceLanes,
    globalSetup: undefined,
    globalTimeout: 5 * (acceptanceLanes.timeout ?? 0),
    outputDir: `test-results/sign-in-${combination}`,
    projects: [signInMethodsProject],
    reporter: [
      ["line"],
      [
        "json",
        {
          outputFile: resolve(
            e2eRunDirectory(),
            `sign-in-${combination}.report.json`,
          ),
        },
      ],
    ],
    webServer: undefined,
  });
}

export default signInCombination === undefined
  ? acceptanceLanes
  : signInCombinationRun(signInCombination);
