/**
 * Liveness and readiness (Plan 13, H.1; manifest-h.md §2.2; ruling 140).
 *
 * Moved here from the web's two health routes, which now answer with these:
 * `apps/web/src/app/api/health/live/route.ts` and `…/ready/route.ts`. This
 * module imports nothing, so a route that imports it still loads where the
 * server configuration does not parse, and readiness answers 503 there
 * (ruling 140; `route.configuration.test.ts`).
 */

/** How long readiness waits for its probe before answering 503. */
export const READINESS_TIMEOUT_MS = 2_000;

/** `{ ok: true }`, not to be stored. */
export function livenessResponse(): Response {
  return Response.json(
    { ok: true },
    { headers: { "cache-control": "no-store" } },
  );
}

/** The probe readiness races against `READINESS_TIMEOUT_MS`: a storage's `ready()`. */
export type ReadinessProbe = () => Promise<unknown>;

/**
 * Whatever must hold before the probe runs, which answers the probe. A throw
 * answers 503. Its own time is not raced: the web's check loads the server
 * configuration and asks the web root for its storage first, as the route
 * did before the race (ruling 140), and the host's answers its storage.
 */
export type ReadinessCheck = () => Promise<ReadinessProbe>;

/**
 * `{ ready: true }` once the probe resolves within `READINESS_TIMEOUT_MS`;
 * `503 { ready: false }` if the check throws, or the probe rejects or is
 * still silent then. Neither answer is to be stored.
 *
 * A 503 writes one console line saying which of the three it was and what
 * was caught, by the error's `name` and `code` (Plan 13, H.5; ruling 145:
 * "the readiness handler logs what it catches"), and never its message,
 * which for a pg error can carry connection details. A 200 writes nothing.
 */
export async function readinessResponse(
  check: ReadinessCheck,
): Promise<Response> {
  const failure = await readinessFailure(check);

  if (failure === undefined) {
    return Response.json(
      { ready: true },
      { headers: { "cache-control": "no-store" } },
    );
  }
  console.error(`RequestPort readiness answered 503: ${failure}.`);
  return Response.json(
    { ready: false },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

/** Why readiness answers 503, or undefined when it answers 200. */
async function readinessFailure(
  check: ReadinessCheck,
): Promise<string | undefined> {
  let probe: ReadinessProbe;

  try {
    probe = await check();
  } catch (error) {
    return `the check threw ${caught(error)}`;
  }
  try {
    // `Promise.resolve`, so that a probe answering a value that is not a
    // promise counts as answered, as it did when the race was handed it.
    const answered = await Promise.race([
      Promise.resolve(probe()).then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), READINESS_TIMEOUT_MS),
      ),
    ]);

    return answered
      ? undefined
      : `the probe did not answer within ${READINESS_TIMEOUT_MS} ms`;
  } catch (error) {
    return `the probe rejected with ${caught(error)}`;
  }
}

/** A `name` that reads as an identifier: no URL, no sentence. */
const READABLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
/** A `code` as Node and pg write them (`ECONNREFUSED`, `28P01`). */
const READABLE_CODE = /^[A-Za-z0-9_]{1,64}$/u;

/**
 * What was caught, by its `name` and `code` only, each only where it reads
 * as an identifier; a thrown value that is not an object, by its type.
 */
function caught(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error !== "object") return `a ${typeof error}`;
  const { name, code } = error as { name?: unknown; code?: unknown };
  const named =
    typeof name === "string" && READABLE_NAME.test(name) ? name : "an error";
  const coded =
    (typeof code === "string" && READABLE_CODE.test(code)) ||
    (typeof code === "number" && Number.isInteger(code))
      ? ` (code ${code})`
      : "";

  return `${named}${coded}`;
}
