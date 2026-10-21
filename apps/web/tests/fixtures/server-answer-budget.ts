/**
 * How long any assertion here may wait on a server answer.
 *
 * Playwright's own default budgets for a warm page and a local database. Every
 * journey in this suite submits something that round-trips to a remote
 * database branch, which routinely outlasts it — so the budget belongs to the suite
 * rather than to whichever assertion happened to fail first.
 *
 * It lives beside the fixtures rather than in `playwright.config.ts` because
 * the config imports from here, and a spec that reached back into the config
 * for one number would invert that: the config throws at import unless the
 * whole E2E environment is set, so a spec would carry that condition too.
 *
 * Call sites keep their own timeouts only where the wait is genuinely
 * different — a short probe inside a retry loop, a bound on a spawned process.
 */
export const serverAnswerTimeoutMs = 30_000;
