import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
} from "@playwright/test";
import { E2E_TOKEN_HEADER } from "@requestport/auth/e2e";
import { testPool } from "@requestport/db/testing";
import {
  closeE2EScenarioRun,
  type E2EScenarioTable,
  e2eScenarioFailures,
} from "../../src/lib/e2e-scenario.js";
import { E2E_SCENARIO_COOKIE } from "../../src/lib/e2e-scenario-fault.js";
import { createE2EScenarioRowDeleter } from "../../src/lib/e2e-scenario-seed.js";
import type {
  AcceptanceLandmark,
  AcceptanceSurfaceEntry,
} from "../../src/test/acceptance-surfaces.js";
import { boundarySentence } from "../../src/test/acceptance-surfaces.js";
import type { AcceptanceCase } from "./acceptance-matrix.js";
import {
  bootstrapOwner,
  clearMagicLinkOutbox,
  createFoundationScenario,
  type FoundationScenario,
  fixtureStorage,
  signInWithMagicLink,
} from "./auth.js";
import { isContentSecurityRefusal } from "./console-refusals.js";
import { developmentOverlaySelectors } from "./development-overlay.js";
import { attachLaneDiagnostics } from "./lane-diagnostics.js";
import { askThroughRestarts, tolerateRestarts } from "./scenario-navigation.js";
import {
  releaseScenarioRun,
  scenarioReleaseAttemptTimeoutMs,
} from "./scenario-release.js";
import { accountMenuPanel, onScreen, organizationSwitcher } from "./shell.js";

/**
 * Everything a matrix case needs in order to run: one authenticated tenant,
 * one guarded scenario run, one appearance triple, and the handful of
 * assertions every case makes whatever state it is in.
 *
 * The assertions here are deliberately about what the *application* emits — the
 * triple stamped on `<html>`, the colour the document actually paints, the page
 * the browser actually landed on, the console the page actually wrote. A case
 * that compared a value the fixture supplied against the same value would pass
 * on a broken server, and this engagement has shipped exactly that shape more
 * than once.
 */

/**
 * The published CUE++ preference key the document's own mirror script writes.
 *
 * Spelled here rather than imported. `appearance-script.ts` reaches
 * `@cueplusplus/ui/system`, whose published entry point is TypeScript, and
 * Playwright's type-stripping loader refuses any `.ts` file under
 * `node_modules` — importing it here fails the whole lane before a single case
 * runs. `acceptance-runner-contract.test.ts` pins this literal against the
 * module that emits it, in the lane that can import it.
 */
export const appearanceStorageKey = "cue-ui";

export const scenarioCookieName = E2E_SCENARIO_COOKIE;
export const organizationCookieName = "requestport.organization_id";

function e2eToken(): string {
  const token = process.env.REQUESTPORT_E2E_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("Foundation E2E token is unavailable");
  }

  return token;
}

export type ScenarioRow = Readonly<{ id: string; table: E2EScenarioTable }>;

export type ScenarioRun = Readonly<{
  fault: string;
  namespace: string;
  rows: readonly ScenarioRow[];
  scenario: string;
  /**
   * Which of the hook's registers holds this run.
   *
   * Carried from the open to the release so the hook can tell a restart from a
   * mistake. `next dev` restarts itself when its heap crosses the share it
   * watches, and the register is in the process that exits; a release that
   * names the register it was given is answered `410` by any other one.
   */
  server: string;
}>;

/** Open a guarded run for one catalogued case. */
export async function openScenarioRun(
  request: APIRequestContext,
  scenario: string,
): Promise<ScenarioRun> {
  // Through the restart tolerance, because this is the first thing a case puts
  // on the wire and it is put there before anything the case could report: a
  // reset here failed the case as an unopened run rather than as the restart
  // it was. Opening a run is idempotent in the only sense that matters — an
  // ask the transport never delivered opened nothing.
  const response = await askThroughRestarts(
    async () =>
      await request.post("/api/test/scenarios", {
        data: { scenario },
        headers: { [E2E_TOKEN_HEADER]: e2eToken() },
      }),
  );
  if (response.status() !== 200) {
    throw new Error("Acceptance scenario run could not be opened");
  }

  return (await response.json()) as ScenarioRun;
}

/**
 * Remove one run's own rows without the hook.
 *
 * Reached only when a restarted server answers that it never opened the run —
 * its register lived in the process that exited. The rows are addressed exactly
 * the way the hook addresses them, through the same deleter and the same
 * reverse-foreign-key order, so the sweep cannot drift from the one the
 * lifecycle proves.
 */
async function sweepScenarioRows(run: ScenarioRun): Promise<void> {
  await closeE2EScenarioRun(
    { created: run.rows, namespace: run.namespace, record: () => undefined },
    createE2EScenarioRowDeleter(async ({ text, values }) => {
      const answered = await testPool(fixtureStorage()).query<
        Record<string, unknown>
      >(text, [...values]);

      return { rows: answered.rows };
    }),
  );
}

/**
 * Release a run.
 *
 * Every release is the first and only one for its namespace — the runner
 * releases at most once, whether the driver asked for it or the `finally` did —
 * so anything other than the hook's own "released" answer means the run it
 * opened is not the run it was asked to close, and the rows that run created
 * are still in the database. That is a failure, not a tolerated shrug: a
 * silently ignored refusal here is exactly how a seeded row outlives its case.
 *
 * The one answer that is not the hook's is no answer: `next dev` restarts
 * itself when its heap approaches the ceiling, and a release that met the
 * restart window reported the case as timed out or reset. `scenario-release.ts`
 * holds that decision and its evidence; this function is the two ports it needs.
 */
/**
 * The hook's own account of a refusal, or nothing.
 *
 * Recognised rather than copied: the sentence has to begin with one this
 * repository declares, so a body from anywhere else — a proxy, a crash page —
 * is dropped rather than repeated into a CI log.
 */
async function readScenarioFailure(response: {
  json: () => Promise<unknown>;
}): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { failure?: unknown };
    const failure = body.failure;
    if (typeof failure !== "string") return undefined;

    return Object.values(e2eScenarioFailures).some((sentence) =>
      failure.startsWith(sentence),
    )
      ? failure
      : undefined;
  } catch {
    return undefined;
  }
}

export async function closeScenarioRun(
  request: APIRequestContext,
  run: ScenarioRun,
): Promise<void> {
  await releaseScenarioRun({
    del: async () => {
      try {
        const response = await request.delete("/api/test/scenarios", {
          data: { namespace: run.namespace, server: run.server },
          headers: { [E2E_TOKEN_HEADER]: e2eToken() },
          timeout: scenarioReleaseAttemptTimeoutMs,
        });

        // Only the hook's own sentence, and only when it opened with one this
        // suite knows. The body is the hook's, not the database's — every
        // failure it can send is a fixed sentence from a checked-in list — but
        // reading it back through that list is what keeps an unexpected body
        // out of a public log.
        const failure = await readScenarioFailure(response);

        return { failure, kind: "answered", status: response.status() };
      } catch {
        // Refused, reset, or no reply inside the attempt. The driver error text
        // carries a call log with the session cookie and the run token, so it
        // is dropped rather than re-thrown.
        return { kind: "unreachable" };
      }
    },
    sleep: (ms) =>
      new Promise<void>((done) => {
        setTimeout(done, ms);
      }),
    sweep: () => sweepScenarioRows(run),
  });
}

/** The first row a run created in one table, or `null`. */
export function seededRow(
  run: ScenarioRun,
  table: E2EScenarioTable,
): string | null {
  return run.rows.find((row) => row.table === table)?.id ?? null;
}

/**
 * The name a seeded project row holds, read from the row itself.
 *
 * The page's heading is the record's own name, so the comparison has to be
 * against what the database stores rather than against a string this suite
 * composed: a heading assertion built from the fixture's own guess at the name
 * would pass on a page that rendered nothing the row contains.
 */
export async function readProjectRecord(id: string): Promise<AcceptanceRecord> {
  const found = await testPool(fixtureStorage()).query<{ name: string }>(
    'SELECT "name" FROM "projects" WHERE "id" = $1',
    [id],
  );
  const name = found.rows[0]?.name;
  if (name === undefined) throw new Error("Acceptance project row is missing");

  return { id, name };
}

export async function readRequestRecord(id: string): Promise<AcceptanceRecord> {
  const found = await testPool(fixtureStorage()).query<{ title: string }>(
    'SELECT "title" FROM "requests" WHERE "id" = $1',
    [id],
  );
  const title = found.rows[0]?.title;
  if (title === undefined) throw new Error("Acceptance request row is missing");

  return { id, name: title };
}

/* ------------------------------------------------------------------ *
 * The tenant every case runs inside.
 * ------------------------------------------------------------------ */

export type AcceptanceTenant = {
  /** The session every case reuses, replaced when a case signs out on purpose. */
  cookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
  /** The second tenant, so a switch has somewhere to go and something to change. */
  readonly bootstrapOrganizationId: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
  /**
   * The tenant's own project and request.
   *
   * A record-addressed surface has to be addressable for *every* case, not only
   * for the two that seed a row of their own: a member-denied case at a project
   * detail page cannot compare what two roles can reach if both of them land on
   * the not-found boundary. So a case that seeds nothing addresses these.
   */
  readonly project: AcceptanceRecord;
  readonly request: AcceptanceRecord;
  readonly scenario: FoundationScenario;
  readonly userId: string;
};

/** One addressable record: the identifier in the URL and the heading it draws. */
export type AcceptanceRecord = Readonly<{ id: string; name: string }>;

async function readUserId(email: string): Promise<string> {
  const found = await testPool(fixtureStorage()).query<{ id: string }>(
    'SELECT "id" FROM "user" WHERE lower("email") = lower($1)',
    [email],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) throw new Error("Acceptance identity was not created");

  return id;
}

async function readOrganizationId(slug: string): Promise<string> {
  const found = await testPool(fixtureStorage()).query<{ id: string }>(
    'SELECT "id" FROM "organizations" WHERE lower("slug") = lower($1)',
    [slug],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) throw new Error("Acceptance tenant was not created");

  return id;
}

/**
 * One request in a tenant, in the one state a row can hold without having gone
 * through the workflow that assigns a key.
 */
async function seedTenantRequest(
  organizationId: string,
  userId: string,
  projectSlug: string,
  projectName: string,
): Promise<{ projectId: string; requestId: string }> {
  const project = await testPool(fixtureStorage()).query<{ id: string }>(
    'SELECT "id" FROM "projects" WHERE "organization_id" = $1 AND "slug" = $2',
    [organizationId, projectSlug],
  );
  const projectId = project.rows[0]?.id;
  if (projectId === undefined) {
    throw new Error("Acceptance tenant project was not created");
  }

  const inserted = await testPool(fixtureStorage()).query<{ id: string }>(
    `INSERT INTO "requests"
       ("id", "organization_id", "source_kind", "target_project_id", "type",
        "title", "description_md", "priority", "state", "reporter_type",
        "reporter_id", "version")
     VALUES (gen_random_uuid(), $1, 'human_direct', $2, 'feature', $3, $4,
             'normal', 'draft', 'user', $5, 1)
     RETURNING "id"`,
    [
      organizationId,
      projectId,
      `${projectName} acceptance`,
      "Seeded for table, overflow and request-surface coverage.",
      userId,
    ],
  );
  const requestId = inserted.rows[0]?.id;
  if (requestId === undefined) {
    throw new Error("Acceptance tenant request was not created");
  }

  return { projectId, requestId };
}

/**
 * Sign one owner in and give them a tenant, through the product's own routes.
 *
 * Nothing is written straight into the session or the membership: the identity
 * is allowlisted by the checked-in bootstrap command, the session comes from a
 * real magic link, and the organization is created through the form a first
 * sign-in lands on. That is what makes the appearance defaults `0014` seeds
 * real rows rather than fixture rows.
 */
export async function createAcceptanceTenant(
  context: BrowserContext,
  label: string,
): Promise<AcceptanceTenant> {
  const base = createFoundationScenario(label);
  // A long organization name and a slug padded to its own limit, so every
  // surface that quotes a tenant is quoting a genuinely long value and the
  // long-value and overflow cases have something to be about.
  const scenario: FoundationScenario = {
    ...base,
    uiOrganizationName: "W".repeat(120),
    uiOrganizationSlug: base.uiOrganizationSlug.padEnd(63, "x"),
  };
  const page = tolerateRestarts(await context.newPage());
  // Watched like the page a spec is handed. This one builds the tenant every
  // case in the lane then runs against, so when it fails the whole lane fails
  // with it — and in CI run 33506245529 it did, having recorded nothing at all,
  // because the diagnostics were installed on the fixture that hands a spec its
  // page and this page never comes from there.
  attachLaneDiagnostics(page);

  await clearMagicLinkOutbox(context.request);
  await bootstrapOwner(scenario);
  await signInWithMagicLink(page, context.request, scenario.ownerEmail);

  await onScreen(page.getByLabel("Organization name")).fill(
    scenario.uiOrganizationName,
  );
  await onScreen(page.getByLabel("Organization slug")).fill(
    scenario.uiOrganizationSlug,
  );
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  // Stage two activates the bootstrap membership, which is what gives this
  // account a second tenant to switch into — and `0014`'s trigger a second
  // appearance default, moved off the shared one so a switch has a visible
  // consequence.
  await bootstrapOwner(scenario);

  await page.goto("/settings/projects/new");
  await onScreen(page.getByLabel("Project name")).fill(scenario.projectName);
  await onScreen(page.getByLabel("Request key prefix")).fill(
    scenario.projectKey,
  );
  await onScreen(page.getByLabel("Project slug")).fill(scenario.projectSlug);
  await onScreen(page.getByLabel("GitHub repository")).fill(
    scenario.repositoryUrl,
  );
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(
    page.getByRole("cell", { name: scenario.projectName }),
  ).toBeVisible();

  // One request, written straight into the tenant.
  //
  // Not through `/requests/new`: creating a request there is a routing preview,
  // a transition, and a React form action that resets its own uncontrolled
  // fields, and this fixture is not the place to prove any of that — the
  // request exists so the tables, overflow and request surfaces have a row
  // rather than an empty state. What a browser case then asserts is what the
  // *application* renders from that row. The seeded row is a draft, which is
  // the one state the schema lets a request hold without a sequence number or
  // a display key it never earned.
  const organizationId = await readOrganizationId(scenario.uiOrganizationSlug);
  const userId = await readUserId(scenario.ownerEmail);
  const records = await seedTenantRequest(
    organizationId,
    userId,
    scenario.projectSlug,
    scenario.projectName,
  );

  const tenant: AcceptanceTenant = {
    bootstrapOrganizationId: await readOrganizationId(
      scenario.bootstrapOrganizationSlug,
    ),
    cookies: await context.cookies(),
    organizationId,
    organizationSlug: scenario.uiOrganizationSlug,
    project: await readProjectRecord(records.projectId),
    request: await readRequestRecord(records.requestId),
    scenario,
    userId,
  };
  await page.close();

  return tenant;
}

/* ------------------------------------------------------------------ *
 * Appearance.
 * ------------------------------------------------------------------ */

export type AppearanceTriple = Readonly<{
  density: string;
  mode: string;
  theme: string;
}>;

/** The same three axes, each of which a user may leave inherited. */
export type AppearanceOverrideTriple = Readonly<{
  density: string | null;
  mode: string | null;
  theme: string | null;
}>;

/**
 * Put this account's global override on the case's triple.
 *
 * The write goes to the row the product reads — the same table the appearance
 * form writes — and the assertion afterwards is on what the *server* resolved
 * and the document painted. The row is the input; the stamp on `<html>` is the
 * output, and the two are only equal while resolution works.
 */
export async function writeUserAppearance(
  userId: string,
  triple: AppearanceOverrideTriple,
): Promise<void> {
  await testPool(fixtureStorage()).query(
    `INSERT INTO "user_appearance_preferences"
       ("user_id", "theme", "density", "mode", "version")
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT ("user_id") DO UPDATE
        SET "theme" = EXCLUDED."theme",
            "density" = EXCLUDED."density",
            "mode" = EXCLUDED."mode",
            "version" = "user_appearance_preferences"."version" + 1,
            "updated_at" = clock_timestamp()`,
    [userId, triple.theme, triple.density, triple.mode],
  );
}

/**
 * Clear this account's overrides, leaving the all-null tombstone behind.
 *
 * The row stays and its version keeps rising, which is the model's own rule:
 * a reset-to-inherit must never let the identity return to version `0`.
 */
export async function clearUserAppearance(userId: string): Promise<void> {
  await writeUserAppearance(userId, {
    density: null,
    mode: null,
    theme: null,
  });
}

export async function writeOrganizationAppearance(
  organizationId: string,
  triple: AppearanceTriple,
): Promise<void> {
  const updated = await testPool(fixtureStorage()).query(
    `UPDATE "organization_appearance_defaults"
        SET "theme" = $2, "density" = $3, "mode" = $4,
            "version" = "organization_appearance_defaults"."version" + 1,
            "updated_at" = clock_timestamp()
      WHERE "organization_id" = $1`,
    [organizationId, triple.theme, triple.density, triple.mode],
  );
  if (updated.rowCount !== 1) {
    throw new Error("Acceptance organization appearance was not applied");
  }
}

export async function readOrganizationAppearance(
  organizationId: string,
): Promise<AppearanceTriple> {
  const found = await testPool(fixtureStorage()).query<AppearanceTriple>(
    `SELECT "theme", "density", "mode"
       FROM "organization_appearance_defaults"
      WHERE "organization_id" = $1`,
    [organizationId],
  );
  const row = found.rows[0];
  if (row === undefined) {
    throw new Error("Acceptance organization appearance is missing");
  }

  return row;
}

/* ------------------------------------------------------------------ *
 * What every case asserts, whatever state it is in.
 * ------------------------------------------------------------------ */

const appearanceAttributes = ["data-theme", "data-density", "data-mode"];

/**
 * Watch `<html>` for a change to the appearance triple, from before the first
 * script the page itself runs.
 *
 * "No flash" is a claim about the first frame, and the only way to check a
 * frame that has already gone is to have been watching. An init script is
 * delivered before any page script, so the observer is attached before the
 * pre-paint stamp could be overwritten by anything — a provider mount, a
 * storage read, a hydration pass. Whatever the triple was when the document
 * arrived is what it must still be when the document has loaded.
 */
export async function armNoFlashWatch(page: Page): Promise<void> {
  await page.addInitScript(
    ({ attributes, key }) => {
      const seen: string[] = [];
      const window_ = window as unknown as Record<string, unknown>;
      window_[key] = seen;

      const attach = (root: HTMLElement) => {
        const initial = new Map(
          attributes.map((name) => [name, root.getAttribute(name)] as const),
        );
        // The triple the *document itself* arrived carrying, read the moment
        // the parser created `<html>` and before a single script in its head
        // has run. A stamp that had to wait for the pre-paint script, or for
        // hydration, is absent here and correct later — and no reading taken
        // after `load` can tell those two apart.
        window_[`${key}Initial`] = {
          density: root.getAttribute("data-density"),
          mode: root.getAttribute("data-mode"),
          theme: root.getAttribute("data-theme"),
        };
        new MutationObserver((records) => {
          for (const entry of records) {
            const name = entry.attributeName ?? "";
            const before = initial.get(name) ?? entry.oldValue ?? null;
            const after = root.getAttribute(name);
            if (before === after) continue;
            seen.push(`${name}:${String(before)}->${String(after)}`);
            window_[key] = seen;
          }
        }).observe(root, {
          attributeFilter: [...attributes],
          attributeOldValue: true,
        });
      };

      // An init script runs before the parser has made anything, so
      // `documentElement` is usually still `null` here. Waiting for
      // `readystatechange` would wait until parsing has *finished*, by which
      // time the head scripts have run and every stamp this watch exists to see
      // has already happened — a watch armed then records nothing whatever the
      // document did, which is a passing assertion about a page nobody watched.
      // So the document itself is observed until its element exists.
      if (document.documentElement) attach(document.documentElement);
      else {
        new MutationObserver((_records, observer) => {
          if (!document.documentElement) return;
          observer.disconnect();
          attach(document.documentElement);
        }).observe(document, { childList: true, subtree: true });
      }
    },
    { attributes: appearanceAttributes, key: "__requestportAppearanceFlash" },
  );
}

/** The triple the document carried before it ran a single script of its own. */
export async function readPrepaintAppearance(
  page: Page,
): Promise<AppearanceTriple | null> {
  return page.evaluate(
    (key) =>
      ((window as unknown as Record<string, unknown>)[`${key}Initial`] as
        | { density: string; mode: string; theme: string }
        | undefined) ?? null,
    "__requestportAppearanceFlash",
  );
}

/**
 * Nothing changed the triple after the document arrived.
 *
 * `stampedOnMount` is the one exception, and it belongs to exactly one case.
 * `global-error` replaces the root layout, so the document that arrives is not
 * the boundary's own: the layout threw before it could stamp anything, React
 * mounts the boundary into a bare `<html>`, and the boundary stamps the fixed
 * fallback triple for the first time. That is the stamp arriving on a document
 * that carried none, not one appearance replacing another. Exactly those three
 * transitions are allowed, only for the case that names them, and only to the
 * triple it names — a stamp to any other value is still a flash, and so is any
 * change on a document that did arrive stamped.
 */
export async function expectNoAppearanceFlash(
  page: Page,
  options: Readonly<{ stampedOnMount?: AppearanceTriple }> = {},
): Promise<void> {
  const recorded = await page.evaluate(
    (key) =>
      ((window as unknown as Record<string, unknown>)[key] as
        | string[]
        | undefined) ?? null,
    "__requestportAppearanceFlash",
  );

  // `null` means the watch was never installed — a passing assertion on a page
  // nobody was watching is exactly the shape this suite must not ship.
  expect(recorded).not.toBeNull();
  const stamped = options.stampedOnMount;
  const allowed =
    stamped === undefined
      ? []
      : (["density", "mode", "theme"] as const).map(
          (axis) => `data-${axis}:null->${stamped[axis]}`,
        );

  expect((recorded ?? []).filter((entry) => !allowed.includes(entry))).toEqual(
    [],
  );
}

/**
 * The triple the browser's own record holds, or `null` when it holds nothing a
 * reader can parse.
 *
 * The record is a mirror the document rewrites in its head, never a preference
 * source — `appearancePrepaintScript` is emitted with the storage read removed
 * entirely, which `appearance-script.test.ts` pins at the source. What a
 * browser can still check is the writing half: whatever the record held, the
 * next document replaces it with the triple the server resolved.
 */
export async function readStoredAppearance(
  page: Page,
): Promise<AppearanceTriple | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;

      return {
        density: String(record.density ?? ""),
        mode: String(record.mode ?? ""),
        theme: String(record.theme ?? ""),
      };
    } catch {
      return null;
    }
  }, appearanceStorageKey);
}

/** The triple the document is actually wearing. */
export async function readEmittedAppearance(
  page: Page,
): Promise<AppearanceTriple> {
  return page.evaluate(() => ({
    density: document.documentElement.getAttribute("data-density") ?? "",
    mode: document.documentElement.getAttribute("data-mode") ?? "",
    theme: document.documentElement.getAttribute("data-theme") ?? "",
  }));
}

export async function expectAppearance(
  page: Page,
  triple: AppearanceTriple,
): Promise<void> {
  expect(await readEmittedAppearance(page)).toEqual(triple);
}

/**
 * The scheme the document actually painted, read from the colour it painted in.
 *
 * The attribute says `system`; it does not say which of the two the operating
 * system chose, and that choice is the whole of the `scheme` axis. The one
 * thing that answers it is the colour on the page, so the background's relative
 * luminance is measured and the answer is "dark" or "light". A stylesheet that
 * stopped following `prefers-color-scheme` fails here and nowhere else.
 */
export async function readPaintedScheme(page: Page): Promise<{
  luminance: number;
  scheme: "dark" | "light";
}> {
  const luminance = await page.evaluate(() => {
    const opaque = (value: string) => {
      const parsed = /rgba?\(([^)]+)\)/u.exec(value);
      if (!parsed) return null;
      const parts = (parsed[1] ?? "").split(/[,\s/]+/u).filter(Boolean);
      const alpha = parts.length > 3 ? Number.parseFloat(parts[3] ?? "1") : 1;
      if (!(alpha > 0)) return null;

      return parts.slice(0, 3).map((part) => Number.parseFloat(part) / 255);
    };

    // What the page actually paints behind its content. A theme that paints on
    // the document element, one that paints on the body, and one that paints
    // neither and leaves the canvas to `color-scheme` are all legitimate, so
    // the first opaque answer wins and the canvas keyword answers last — and
    // that keyword resolves through the very `color-scheme` the pre-paint
    // script set, which is the property under test.
    const probe = document.createElement("div");
    probe.style.backgroundColor = "Canvas";
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();

    const channels = opaque(getComputedStyle(document.body).backgroundColor) ??
      opaque(getComputedStyle(document.documentElement).backgroundColor) ??
      opaque(canvas) ?? [1, 1, 1];
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );

    return (
      0.2126 * (linear[0] ?? 0) +
      0.7152 * (linear[1] ?? 0) +
      0.0722 * (linear[2] ?? 0)
    );
  });

  return { luminance, scheme: luminance < 0.5 ? "dark" : "light" };
}

export async function expectPaintedScheme(
  page: Page,
  expected: "dark" | "light",
): Promise<void> {
  const painted = await readPaintedScheme(page);

  expect({ luminance: painted.luminance, scheme: painted.scheme }).toEqual({
    luminance: painted.luminance,
    scheme: expected,
  });
}

/** The scheme a case's mode and OS setting resolve to together. */
export function resolvedScheme(testCase: AcceptanceCase): "dark" | "light" {
  return testCase.mode === "system"
    ? testCase.scheme
    : (testCase.mode as "dark" | "light");
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const measured = await page.evaluate(
    (selectors: readonly string[]) => {
      // The development server's own chrome is taken out of the measurement
      // first. `next dev` mounts its devtools — and, on a failure, its error
      // overlay — as ordinary elements in the document, in flow and at a width of
      // their own choosing, so a document carrying one measures wider than the
      // viewport however the application is laid out. That is what the one case
      // driving the global boundary reported: the overlay was open, and nothing
      // the application rendered was outside the viewport at all.
      //
      // Hidden rather than removed, and put back exactly as found, inside one
      // synchronous evaluation — so the overlay is never disturbed and nothing
      // else ever sees the document without it.
      const overlays = [
        ...document.querySelectorAll<HTMLElement>(selectors.join(",")),
      ];
      const restore = overlays.map((overlay) => overlay.style.display);
      for (const overlay of overlays) overlay.style.display = "none";
      const measurement = {
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      };
      overlays.forEach((overlay, index) => {
        overlay.style.display = restore[index] ?? "";
      });

      return measurement;
    },
    developmentOverlaySelectors as readonly string[],
  );

  // The numbers are in the assertion so a failure names how far the document
  // overflowed rather than only that it did.
  expect({ ...measured, fits: measured.scroll <= measured.client }).toEqual({
    ...measured,
    fits: true,
  });
}

/**
 * Everything the page wrote to the console, and every hydration complaint React
 * made, collected from the moment the page existed.
 */
export type ConsoleLog = Readonly<{
  errors: string[];
  hydration: string[];
  /**
   * Every Content Security Policy refusal the page reported, of any shape.
   *
   * The bucket is deliberately wide and the tolerance lives in the assertion,
   * because the other arrangement is a tautology: this bucket used to admit
   * only the development server's own inline-style refusal, and the console
   * assertion then filtered out every line naming that same directive — a
   * filtered array that was empty for every possible input, on every page, for
   * ever. Wide bucket, narrow tolerance: a refusal the development server does
   * not produce reaches the assertion and fails it.
   */
  csp: string[];
}>;

/**
 * The one class of CSP refusal a development server produces on its own, in
 * each engine's words for it.
 *
 * `next dev --webpack` serves every stylesheet as an inline `<style>` element
 * injected by its own runtime, and the application's CSP restricts
 * `style-src-elem` to `'self'` and the request nonce — so the development
 * server's stylesheets are refused and the browser reports one error per
 * injection. A production build emits those styles as files, which `'self'`
 * allows, so the condition belongs to the server the suite runs against rather
 * than to the pages under test, and the exact deployed CSP is proven against
 * the deployed headers, which is where it can be proven at all.
 *
 * Two spellings because there are two engines and only one of them had ever
 * run. Chromium names the element-level directive and quotes it back; WebKit
 * implements neither `style-src-elem` nor `style-src-attr`, so it names
 * `style-src` and says nothing about the element. The tolerance was written in
 * the first engine's words, and the first WebKit lane this branch ever ran
 * reported refusals of the second kind against a product that caused none of
 * them. How many it reported is not the argument and was never checked: one
 * engine wording a condition the other already worded is.
 *
 * Both are anchored at the start, and the second at the end too, because it is
 * a complete fixed sentence. A refusal naming any other directive — a script,
 * a connection, a style *attribute* the page itself wrote — is the
 * application's and still fails the case.
 */

/**
 * A failure of the development server's Fast Refresh transport.
 *
 * The other thing `next dev --webpack` says about itself. It keeps a client in
 * every document that polls the build for updates over
 * the `hot-update` manifests under `/_next/static/webpack/`, and a memory restart
 * leaves the client asking a fresh server for a build that no longer exists.
 * The server logs `Fast Refresh had to perform a full reload`, reloads the
 * document, and the abandoned poll fails in the console — which is how CI run
 * 33355052056 failed the console case on a line naming that resource.
 *
 * Keyed on the resource rather than on the sentence, and deliberately: the
 * resource is what makes the failure the development server's — no production
 * build serves it, so no deployed page can produce this line — while the
 * sentence is engine-specific and was not reproduced. An error naming any other
 * resource, including any other `_next` path, is the application's.
 */
const fastRefreshTransport =
  /\/_next\/static\/webpack\/[\w.-]*hot-update\.(?:js|json)\b/u;

/*
 * WHAT THIS WAS. Read this before adding an entry, because the last two guesses
 * were both wrong and both were written down as if they were not.
 *
 * The refusal the built lanes reported was `@base-ui/react`'s scrollbar style:
 * `.base-ui-disable-scrollbar{scrollbar-width:none}` and its `::-webkit-scrollbar`
 * rule, rendered by `utils/styles.mjs` as a hoisted `<style precedence>`.
 * Hashing that content reproduces the hash Chromium named, which is how it was
 * identified — not by inference. `ScrollAreaRoot` and `SelectPopup` give that element a nonce they
 * read from `CSPContext`; nothing supplied that context, so it shipped
 * unnonced. `app-shell` renders a Select in the organisation switcher, which is
 * why every authenticated page showed it and `/sign-in` never did.
 *
 * `appearance-root.tsx` now renders Base UI's `CSPProvider` with the request
 * nonce, and `framework-boundaries.dom.test.tsx` asserts the nonce on the
 * element itself rather than on the provider — a test that only checked the
 * provider was rendered would pass with the nonce wired to nothing.
 *
 * Two earlier readings of this refusal were wrong, and both were recorded as
 * established:
 *
 * - that it was `ThemeProvider`'s density override layer. RequestPort passes no
 *   `overrides`, so that element never existed here. A cue-ui issue was raised
 *   on that belief; the nonce prop it produced is correct and stays, but it
 *   addressed a different element.
 * - that `@base-ui/react` creates no style element at all, recorded in the
 *   reskin's staging acceptance evidence while attributing a *different*
 *   refusal to `react-resizable-panels`. That one was a constructed sheet, and
 *   real for as long as the requests workbench drew its seam with that
 *   package; the claim beside it was not. The workbench is cue-ui's
 *   `SplitPane` now, and the console no longer loads the package.
 *
 * What remains below is the development server's entry, which these lanes do
 * not run. It is attributed, and not here: `console-hygiene.test.ts` — the test
 * that consumes it — records that `next dev` serves every stylesheet as an
 * injected `<style>` the page's own policy refuses, reproduced under a matching
 * policy shape. Which stylesheet hashes to that particular value was never
 * pinned down, and nobody has needed it to be.
 */
/**
 * The inline styles the deployed policy blocks, named by their content hashes.
 *
 * This list was written when the lanes ran `next dev`, and its name still says
 * so. They have not since the acceptance moved to a built server, and the
 * refusal did not go with the development server: a production build emits one
 * on every appearance case. Removing the tolerance to find that out failed
 * three cases and printed the refusals in full.
 *
 * So the second of these is not a development artifact being tolerated. It is a
 * real inline style in the built application that the deployed Content Security
 * Policy refuses for want of a nonce, and the browser blocks — an open question
 * about the application rather than about the harness, recorded in the staging
 * acceptance evidence rather than left inside a filter whose name says
 * "development" and whose behaviour means "always".
 *
 * Naming the hashes is what keeps this honest on Chromium: it covers the two
 * refusals that are known, and a third inline style the policy blocks fails the
 * case that met it.
 *
 * It is not honest on WebKit, and saying so is the point. WebKit's sentence
 * carries no hash at all — there is nothing in it to key on — so the entry that
 * matches it forgives *every* blocked inline stylesheet in that lane. A new
 * inline style the deployed policy refuses is therefore caught by the Chromium
 * console cases and waved through by the WebKit one. The gate is
 * engine-partial, not hash-scoped on both, and a reader who believed otherwise
 * would take a green WebKit console case as evidence it has not started
 * happening.
 */
const blockedInlineStyleHashes = [
  // Recorded from the development server, in `console-hygiene.test.ts`.
  "sha256-iEVGxKLx+0na6M5/ZMcf4NsQvcN7WlHucqi4A0LN7IM=",
];

const developmentStyleRefusals = [
  ...blockedInlineStyleHashes.map(
    (hash) =>
      new RegExp(
        `^Applying inline style violates the following Content Security Policy directive 'style-src-elem\\b.*\\('${hash.replace(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`)}'\\)`,
        "u",
      ),
  ),
  /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.$/u,
];

export function developmentStyleRefusal(text: string): boolean {
  return developmentStyleRefusals.some((refusal) => refusal.test(text));
}

/**
 * A route prefetch the engine refused before it left the browser.
 *
 * A built application prefetches the routes it links to; the development server
 * this suite used to drive did not, so these appeared the first time the lanes
 * ran against a build. WebKit refuses them and says so once per link, every
 * line naming an `_rsc` query, while Chromium refuses none and passes the same
 * lane — two engines wording one condition, which is the whole case.
 *
 * They are refusals rather than failures, and the distinction is checked rather
 * than assumed: the lane records every answer at or above the first refusal
 * status and none was ever recorded for one of these addresses, because the
 * request never reached the server. Nothing the application renders depends on
 * a prefetch either — the lane that produced these passed every case but the
 * one asserting the console was empty.
 *
 * Narrow on both halves on purpose. A line has to name a prefetch *and* carry
 * the engine's refusal wording; a refusal naming any other address, and any
 * failure of a prefetch that did reach the server, is still the application's.
 */
const prefetchQuery = /[?&]_rsc=/u;
const engineRefusal = /due to access control checks/u;

export function enginePrefetchRefusal(text: string): boolean {
  return prefetchQuery.test(text) && engineRefusal.test(text);
}

export function developmentFastRefreshFailure(text: string): boolean {
  return fastRefreshTransport.test(text);
}

/**
 * What a hydration mismatch looks like, in both builds React can be.
 *
 * The prose half is development React. The lanes do not run development React:
 * `start-e2e-server.mjs` builds and then serves with `next start`, so a
 * mismatch arrives minified — a `Minified React error` naming a code and a
 * `react.dev/errors` link — which matched none of the prose and landed in
 * `errors`. A detector that cannot fire is worse than none, because it reads as
 * coverage.
 *
 * Only the codes that mean *mismatch*: the initial UI disagreeing with the
 * server, and text content disagreeing. Deliberately not the ones that say
 * React recovered from an error *during* hydration — the matrix's own `error`
 * and `loading` cases produce those on purpose, and collecting them would fail
 * the cases that work. The regex below is the list; this comment deliberately
 * does not restate it.
 */
const hydrationMismatch =
  /hydrat|did not match|server (?:html|rendered)|Minified React error #(?:418|425)\b|react\.dev\/errors\/(?:418|425)\b/iu;

export function isHydrationMismatch(text: string): boolean {
  return hydrationMismatch.test(text);
}

export function collectConsole(page: Page): ConsoleLog {
  const errors: string[] = [];
  const hydration: string[] = [];
  const csp: string[] = [];

  page.on("console", (message) => {
    const text = message.text();
    if (isHydrationMismatch(text)) {
      hydration.push(text);
    }
    if (message.type() !== "error") return;
    if (isContentSecurityRefusal(text)) csp.push(text);
    else errors.push(text);
  });
  // An uncaught hydration error arrives here rather than on `console`, so it
  // has to be classified here too — otherwise the one route by which React
  // reports the most serious mismatches bypasses the bucket entirely.
  page.on("pageerror", (error) => {
    if (isHydrationMismatch(error.message)) hydration.push(error.message);
    errors.push(error.message);
  });

  return { csp, errors, hydration };
}

/** The landmark a surface prints once it has rendered. */
export type AcceptanceRecords = Readonly<{
  project: AcceptanceRecord;
  request: AcceptanceRecord;
}>;

/**
 * The page a case lands on when its tenant is not the one it seeded.
 *
 * A case whose organization context is wrong does not fail where the mistake
 * is. It renders the tenant not-found page perfectly well, and then the
 * landmark it was waiting for never appears — so the run waits out the whole
 * expectation timeout and then reports a heading that did not become visible,
 * naming the surface rather than the reason. `route-state-0108` was read as a browser flake twice on exactly
 * that: `/settings/operations` in its `member_denied` state, rendering "Nothing
 * lives at this address" while the assertion waited for "Operations".
 *
 * This does not repair the race that puts a case there — that is a seeding
 * question and this is not the place to answer it. It makes the first
 * occurrence say which question to ask, and now carries enough to answer it.
 *
 * The mechanism is not mysterious. `resolveCurrentOrganization` ends in
 * `preferred ?? organizations[0] ?? null`, so a cookie naming an organization
 * that is not in `listActiveOrganizationsForUser` does not fail — it silently
 * becomes the account's *first* organization. The acceptance tenant has two,
 * and the one created through the form wears the padded name
 * `createAcceptanceTenant` gives it — which is exactly what the shell reported
 * when this last fired.
 *
 * So the two readings worth distinguishing are: the cookie was never applied,
 * and the cookie was applied but named an organization the account could not
 * yet see. The message carries the cookie's own value for that reason — an
 * absent cookie and a cookie naming an invisible membership are different
 * faults with the same surface.
 */
/*
 * The tenant's not-found lines: the authenticated segment's, and the settings
 * segment's, whose boundary answers a settings page's not-found inside the
 * settings layout. Read from the boundary table rather than spelled again, so
 * a reworded boundary cannot leave this detector looking for a line nothing
 * prints.
 */
const TENANT_NOT_FOUND_HINTS = [
  boundarySentence("app", "not-found"),
  boundarySentence("app-settings", "not-found"),
];

export async function refuseTenantNotFound(
  page: Page,
  landmark: AcceptanceLandmark,
): Promise<void> {
  // The `boundary:not-found` cases expect this page and say so: their landmark
  // is that very sentence. Refusing it for them would fail the surfaces the
  // matrix drives here deliberately.
  if (
    landmark.kind === "text" &&
    TENANT_NOT_FOUND_HINTS.includes(landmark.text)
  ) {
    return;
  }

  // Cheap and immediate: no waiting, so a surface still rendering is simply not
  // this page yet, and the landmark's own wait remains the one that matters.
  const shown = await Promise.all(
    TENANT_NOT_FOUND_HINTS.map((hint) => page.getByText(hint).count()),
  );
  if (shown.every((count) => count === 0)) return;

  // Through the shared fixture, which is the one place that names the switcher.
  // A second spelling of that label here is a copy that drifts, and the browser
  // spec contract refuses one.
  const organization = await organizationSwitcher(page)
    .textContent()
    .catch(() => null);

  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === organizationCookieName,
  );

  throw new Error(
    [
      "The surface rendered the tenant not-found page instead of its own.",
      landmark.kind === "seeded-heading"
        ? `Waiting for the ${landmark.from} record's heading.`
        : `Waiting for ${landmark.kind} "${landmark.text}".`,
      `The shell's current organization reads: ${organization ?? "(not rendered)"}.`,
      `The ${organizationCookieName} cookie holds: ${cookie?.value ?? "(no cookie)"}.`,
      "If the cookie is absent, it was never applied to this context. If it",
      "names an organization, that organization was not in the account's active",
      "list when the surface rendered, and `resolveCurrentOrganization` fell",
      "back to the first one — so the question is the membership, not this",
      "surface.",
    ].join(" "),
  );
}

/**
 * The page a case lands on when its own render threw.
 *
 * The same argument as `refuseTenantNotFound`, one boundary along. A surface
 * whose server render fails does not fail where the mistake is: it renders the
 * error boundary perfectly well, the landmark never appears, and the case waits
 * out the whole expectation timeout before reporting a heading that did not
 * become visible — naming the surface rather than the reason.
 *
 * Observed on a `route:/requests/[requestId]` case: the expectation's whole
 * timeout spent waiting, then a missing request heading. The page had rendered
 * "Something went wrong"
 * because `listOrganizationMembers` failed with a WebSocket error from the
 * driver's connection to the local proxy. Nothing in the failure said so, and
 * the case before it and the case after it passed — so it read as a browser
 * flake, which is the reading that costs the most to correct.
 *
 * This does not repair whatever threw. It makes the failure name the boundary
 * it actually reached, and point at the server log, which is where the cause is.
 */
export async function refuseErrorBoundary(
  page: Page,
  entry: AcceptanceSurfaceEntry,
): Promise<void> {
  /*
   * Exempt on the surface being a boundary case, not on its landmark's text.
   * Matching the text exempted every surface that *uses* a boundary sentence as
   * its landmark — the five record surfaces whose landmark is the not-found
   * sentence, which is dozens of ordinary route cases — so the refusal was
   * silent for exactly the cases it was written to catch.
   */
  if (entry.boundary !== undefined) return;

  /*
   * This segment's own error sentence, because boundaries nest: an
   * `app-appearance`, `auth` or `root` surface that throws renders its own
   * sentence and the app's never appears. Looking only for the app's left every
   * non-app surface uncovered.
   *
   * `boundarySentence` throws for a segment that owns no error boundary, which
   * is the convention this file's neighbours already follow: a sentence that
   * cannot be named is a row to fix, not a detector to switch off quietly.
   */
  const sentence = boundarySentence(entry.segment, "error");

  // Cheap and immediate: no waiting, so a surface still rendering is simply not
  // this page yet, and the landmark's own wait remains the one that matters.
  if ((await page.getByText(sentence).count()) === 0) return;

  throw new Error(
    [
      "The surface rendered its error boundary instead of its own content, so",
      "its render threw.",
      entry.landmark.kind === "seeded-heading"
        ? `Waiting for the ${entry.landmark.from} record's heading.`
        : `Waiting for ${entry.landmark.kind} "${entry.landmark.text}".`,
      "The reason is in the acceptance server's log, not here: look for the",
      "throw logged immediately before this case failed. A failed query whose",
      "cause is an ErrorEvent is the driver's WebSocket to the local proxy",
      "dropping, which is the local stack and not this surface.",
    ].join(" "),
  );
}

export async function expectLandmark(
  page: Page,
  entry: AcceptanceSurfaceEntry,
  seeded: AcceptanceRecords,
): Promise<void> {
  const { landmark } = entry;

  await refuseTenantNotFound(page, landmark);
  await refuseErrorBoundary(page, entry);

  if (landmark.kind === "text") {
    await expect(
      onScreen(page.getByText(landmark.text, { exact: true })),
    ).toBeVisible();

    return;
  }
  if (landmark.kind === "heading") {
    await expect(
      page.getByRole("heading", { exact: true, name: landmark.text }),
    ).toBeVisible();

    return;
  }

  const record = landmark.from === "project" ? seeded.project : seeded.request;

  await expect(
    page.getByRole("heading", { exact: true, name: record.name }),
  ).toBeVisible();
}

/** The address a case drives, with the run's own identifiers filled in. */
export function acceptancePath(
  entry: AcceptanceSurfaceEntry,
  filled: AcceptanceRecords & Readonly<{ missing: string }>,
): string {
  return entry.path
    .replace(":missing", filled.missing)
    .replace(":project", filled.project.id)
    .replace(":request", filled.request.id);
}

/**
 * The control that opens the account menu, and the menu itself.
 *
 * Shared rather than private to the appearance drivers because the account menu
 * is the one way into `/settings/appearance` from any page, in one step and
 * without a document load: the primary navigation does not link it (its
 * Settings entry opens `/settings/organization`, and only the settings section
 * navigation drawn there links Appearance), and `user-control.tsx` renders the
 * link inside this menu.
 *
 * The open is retried, and the retry is the wait. A committed write lands a new
 * document, and between the server's markup arriving and React attaching to it
 * the trigger swallows a click without saying so; nothing rendered on the
 * server marks hydration.
 */
export const accountMenuTrigger = (page: Page) =>
  page.getByRole("button", { name: /^Open user menu for/u });

export async function openAccountMenu(page: Page) {
  const panel = accountMenuPanel(page);

  await expect(async () => {
    await accountMenuTrigger(page).click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ intervals: [250, 500, 1_000], timeout: 30_000 });

  return panel;
}

/** The accessible name of every control a surface offers, sorted. */
export async function controlNames(page: Page): Promise<string[]> {
  const names = await page
    .locator("main a, main button, main [data-slot='sidebar-item']")
    .evaluateAll((elements) =>
      elements.map((element) =>
        (element.getAttribute("aria-label") ?? element.textContent ?? "")
          .replace(/\s+/gu, " ")
          .trim(),
      ),
    );

  return [...new Set(names.filter((name) => name !== ""))].sort();
}

export async function setCookieValue(
  context: BrowserContext,
  name: string,
  value: string,
  baseURL: string,
): Promise<void> {
  await context.addCookies([{ name, url: baseURL, value }]);
}

export async function clearCookieValue(
  context: BrowserContext,
  name: string,
): Promise<void> {
  await context.clearCookies({ name });
}
