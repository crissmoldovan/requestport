/**
 * Which runner executes RequestPort's background jobs.
 *
 * `trigger` is Trigger.dev, and it is what an unset variable means, so a
 * deployment that has never heard of this variable — production included —
 * behaves exactly as it did before the variable existed. `postgres` is the
 * worker in this package (`requestport-jobs`), which drains the same tables
 * from a long-lived process, connecting to the application's database as
 * the worker's three logins (`worker-root.ts`).
 *
 * Anything else is refused rather than read as `trigger`: a mistyped value
 * that quietly selected Trigger.dev would leave a self-hosted install whose
 * web process dispatches to a service it has no credentials for, and whose
 * outbox nothing drains.
 *
 * `postgres` is also refused wherever `VERCEL_ENV` is set, empty included, as
 * `packages/db` counts it for its local proxy. Vercel runs the web application
 * and nothing long-lived, so no `requestport-jobs` worker exists there: a
 * deployment selecting it would commit outbox rows that nothing drains, and
 * every direct start would be deferred to a worker that never comes.
 *
 * Both processes that read the variable ask this at boot — the web server in
 * `apps/web/src/instrumentation.ts`, the worker in `cli.ts` before it starts a
 * loop — so a bad value stops the process from starting rather than
 * surfacing on the first dispatch.
 *
 * This module imports nothing, so the web application can ask the question
 * without bundling the job bodies.
 */
export const jobRunnerVariable = "REQUESTPORT_JOB_RUNNER";

export const jobRunnerKinds = ["trigger", "postgres"] as const;

export type JobRunnerKind = (typeof jobRunnerKinds)[number];

export function resolveJobRunnerKind(
  env: Readonly<Record<string, string | undefined>>,
): JobRunnerKind {
  const value = env[jobRunnerVariable];

  if (value === undefined || value === "") return "trigger";
  if (value === "postgres" && env.VERCEL_ENV !== undefined) {
    throw new Error(
      `${jobRunnerVariable}=postgres is refused wherever VERCEL_ENV is set (here ${JSON.stringify(env.VERCEL_ENV)}): no requestport-jobs worker runs on Vercel, so nothing would drain the outbox. Leave ${jobRunnerVariable} unset there to use Trigger.dev.`,
    );
  }
  if ((jobRunnerKinds as readonly string[]).includes(value)) {
    return value as JobRunnerKind;
  }

  throw new Error(
    `${jobRunnerVariable} must be "trigger" or "postgres", or unset for "trigger"; got ${JSON.stringify(value)}`,
  );
}
