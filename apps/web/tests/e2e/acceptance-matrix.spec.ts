import { randomUUID } from "node:crypto";
import { type Browser, type BrowserContext, expect } from "@playwright/test";

import {
  acceptanceSkipReason,
  acceptanceSurface,
} from "../../src/test/acceptance-surfaces.js";
import { acceptanceAppearanceDrivers } from "../fixtures/acceptance-appearance-drivers.js";
import { acceptanceDrivers } from "../fixtures/acceptance-drivers.js";
import {
  type AcceptanceCase,
  acceptanceCases,
  routeStateTag,
} from "../fixtures/acceptance-matrix.js";
import { acceptanceHasTouch } from "../fixtures/acceptance-pointer.js";
import {
  type AcceptanceTenant,
  acceptancePath,
  armNoFlashWatch,
  clearCookieValue,
  closeScenarioRun,
  collectConsole,
  createAcceptanceTenant,
  expectAppearance,
  expectNoAppearanceFlash,
  expectNoDocumentOverflow,
  expectPaintedScheme,
  openScenarioRun,
  organizationCookieName,
  readProjectRecord,
  readRequestRecord,
  resolvedScheme,
  scenarioCookieName,
  seededRow,
  setCookieValue,
  writeUserAppearance,
} from "../fixtures/acceptance-run.js";
import { cleanupFoundationScenario } from "../fixtures/auth.js";
import { test } from "../fixtures/engine.ts";

/**
 * The acceptance case table, executed.
 *
 * Nothing here enumerates a case. The table is read from the file CI validates
 * and every row becomes a test that drives *its* surface at *its* theme,
 * density, mode, OS scheme, viewport and engine, through *its* fixture owner's
 * scenario. A hand-written copy of those rows would drift from that file
 * within a week and the drift would be invisible in both directions — a case
 * the table demands and the suite never runs reads exactly like a case that
 * passed.
 *
 * Two properties keep it honest:
 *
 * - every case makes the same four claims about what the *application* emitted,
 *   through a `settle` the runner requires a driver to call exactly once. A
 *   driver that forgot is a failure, not a pass;
 * - a case this pass cannot yet drive is skipped by a checked-in rule that says
 *   why, and `acceptance-runner-contract.test.ts` fails on a rule that matches
 *   nothing and on a case skipped without one.
 */

/** The fallback triple `global-error` paints, having resolved nothing. */
const appearanceFallback = {
  density: "ultra-compact",
  mode: "system",
  theme: "requestport",
} as const;

let tenantPromise: Promise<AcceptanceTenant> | null = null;
let tenantContext: BrowserContext | null = null;
let tenant: AcceptanceTenant | null = null;

/**
 * One authenticated tenant for the whole lane, created on first use.
 *
 * Lazily, because a project whose every case is skipped — the engine this host
 * cannot drive — must not sign anyone in or leave a tenant behind.
 */
async function acquireTenant(browser: Browser): Promise<AcceptanceTenant> {
  tenantPromise ??= (async () => {
    tenantContext = await browser.newContext();
    tenant = await createAcceptanceTenant(tenantContext, "acceptance");

    return tenant;
  })();

  return tenantPromise;
}

async function disposeTenant() {
  const created = tenant;
  tenant = null;
  tenantPromise = null;
  const context = tenantContext;
  tenantContext = null;
  try {
    if (created) await cleanupFoundationScenario(created.scenario);
  } finally {
    await context?.close();
  }
}

const drivers = { ...acceptanceDrivers, ...acceptanceAppearanceDrivers };

function caseTitle(testCase: AcceptanceCase): string {
  return [
    testCase.id,
    testCase.surface,
    testCase.state,
    `${testCase.theme}/${testCase.density}/${testCase.mode}`,
    `${testCase.scheme} scheme`,
    `${testCase.viewport.width}px`,
  ].join(" · ");
}

for (const lane of ["appearance", "route-state"] as const) {
  const lanes = acceptanceCases.filter((entry) => entry.lane === lane);
  const tag = lane === "route-state" ? ` ${routeStateTag}` : "";

  test.describe(`acceptance matrix · ${lane} lane${tag}`, () => {
    test.afterAll(async () => {
      await disposeTenant();
    });

    for (const testCase of lanes) {
      test.describe(caseTitle(testCase), () => {
        test.use({
          colorScheme: testCase.scheme,
          /*
           * A window narrowed to a phone's width is not a phone: it still
           * reports a mouse, so `(pointer: coarse)` does not match and the
           * accommodation the token layer publishes behind it — the one that
           * keeps an ultra-compact target off the design system's floor — is
           * never rendered. The table declares the pointer; this hands it over.
           */
          hasTouch: acceptanceHasTouch(testCase.pointer),
          viewport: testCase.viewport,
        });

        test(`drives ${testCase.surface}`, async ({
          baseURL,
          browser,
          browserName,
          context,
          page,
        }) => {
          test.skip(
            browserName !== testCase.engine,
            `The table declares this case on ${testCase.engine}.`,
          );
          const declined = acceptanceSkipReason(
            testCase.surface,
            testCase.state,
            testCase.fixtureOwner,
          );
          test.skip(declined !== null, declined ?? "");

          const entry = acceptanceSurface(testCase.surface);
          const driver = drivers[testCase.fixtureOwner];
          expect(driver).toBeDefined();
          if (driver === undefined) return;

          // The first case that actually runs pays for the tenant: a bootstrap,
          // a magic-link sign-in, an organization, a project and a request,
          // every one of them against routes a development server compiles on
          // first request. That is minutes of wall clock and nothing to do with
          // the case, so only the case that pays for it gets the longer budget;
          // every later case keeps the suite's own.
          if (tenantPromise === null) test.setTimeout(900_000);
          const active = await acquireTenant(browser);
          const origin = baseURL ?? "";
          await context.addCookies(active.cookies);
          await setCookieValue(
            context,
            organizationCookieName,
            active.organizationId,
            origin,
          );

          const triple = {
            density: testCase.density,
            mode: testCase.mode,
            theme: testCase.theme,
          };
          await writeUserAppearance(active.userId, triple);
          // Nothing leaves the loopback origin.
          //
          // A local acceptance run drives real forms, and two of the surfaces
          // in the table post to an identity provider. A generic submission
          // must not become an outbound request to a third party — so every
          // request to any other origin is refused here, before it is made,
          // rather than trusted not to happen.
          //
          // Matched by predicate rather than by pattern so a same-origin
          // request is never intercepted at all: routing every asset of a
          // development server through the driver costs more than the guard is
          // worth, and the guard only has anything to say about the requests it
          // refuses.
          await page.route(
            (target) => `${target.protocol}//${target.host}` !== origin,
            async (route) => {
              await route.abort();
            },
          );
          await armNoFlashWatch(page);
          const consoleLog = collectConsole(page);

          const run = await openScenarioRun(
            context.request,
            testCase.fixtureOwner,
          );
          let released = false;
          const release = async () => {
            if (released) return;
            released = true;
            await closeScenarioRun(context.request, run);
          };

          let settled = 0;
          const settle = async (
            options: Readonly<{ appearance?: "case" | "fallback" }> = {},
          ) => {
            settled += 1;
            const expected =
              options.appearance === "fallback" ? appearanceFallback : triple;
            await expectAppearance(page, expected);
            await expectNoAppearanceFlash(
              page,
              options.appearance === "fallback"
                ? { stampedOnMount: appearanceFallback }
                : {},
            );
            await expectPaintedScheme(
              page,
              expected.mode === "system"
                ? testCase.scheme
                : resolvedScheme(testCase),
            );
            await expectNoDocumentOverflow(page);
          };

          try {
            await setCookieValue(
              context,
              scenarioCookieName,
              run.namespace,
              origin,
            );
            // A case that seeded a row of its own addresses that row; every
            // other case addresses the tenant's, so a record-addressed surface
            // is reachable for all of them rather than only for the two owners
            // that create one. The heading each draws is the record's own name,
            // read back from the row rather than composed here.
            const seededProject = seededRow(run, "projects");
            const seededRequest = seededRow(run, "requests");
            const seeded = {
              project:
                seededProject === null
                  ? active.project
                  : await readProjectRecord(seededProject),
              request:
                seededRequest === null
                  ? active.request
                  : await readRequestRecord(seededRequest),
            };

            const reportHydration = () => {
              /*
               * Reported even when the driver threw, and this is the whole
               * point. A hydration mismatch makes React re-render over the
               * server's markup, so the page holds two of a control and the
               * driver fails on a selector that matched twice — *inside* the
               * driver. An assertion placed after the call never runs for
               * exactly the case it was written to explain, and can only ever
               * convert passing cases into failures.
               */
              if (consoleLog.hydration.length === 0) return;

              throw new Error(
                [
                  "The page recorded a hydration complaint, which is the cause",
                  "of a family of failures that never name it: React recovers by",
                  "re-rendering the subtree on the client while the server's",
                  "markup is still in the document, so the page holds two of a",
                  "control and a selector matches twice.",
                  "",
                  ...consoleLog.hydration,
                ].join("\n"),
              );
            };

            try {
              await driver({
                baseURL: origin,
                consoleLog,
                context,
                entry,
                page,
                release,
                replaceSessionCookies: (cookies) => {
                  active.cookies = cookies;
                },
                run,
                seeded,
                settle,
                tenant: active,
                testCase,
                triple,
                url: acceptancePath(entry, {
                  missing: randomUUID(),
                  ...seeded,
                }),
              });
            } catch (error) {
              // The driver's own failure stays the failure; a complaint
              // recorded before it is the explanation, so it is raised first
              // and carries the original as its cause.
              if (consoleLog.hydration.length > 0) reportHydration();
              throw error;
            }

            reportHydration();

            /*
             * A hydration complaint is the cause of a whole family of failures
             * that never name it. React recovers from one by re-rendering the
             * subtree on the client while the server's markup is still in the
             * document, so the page holds two of a control and the case fails
             * on a selector that matched twice — a strict-mode violation naming
             * a label. `projects.spec.ts` records that happening twice, fixed
             * twice as something else; the third was a Slack case in this lane,
             * failing on two identical `empty-state-title` spans.
             *
             * The console was already collected here and no route/state driver
             * ever read it, which is exactly why the same fault reads as a
             * mystery duplicate in this lane and as a named failure in the
             * appearance one. Refused for every case, in the spec, because a
             * driver that has to remember is a driver that will not.
             *
             * Only the hydration bucket. A case driving `error` or
             * `provider_unavailable` expects the console to carry errors, and
             * refusing those here would fail the cases that work.
             */
            // A driver that never asserted the universal claims is a case that
            // reported nothing; a driver that asserted them twice measured one
            // document and called it two.
            expect({ case: testCase.id, settled }).toEqual({
              case: testCase.id,
              settled: 1,
            });
          } finally {
            await release();
            await clearCookieValue(context, scenarioCookieName);
          }
        });
      });
    }
  });
}
