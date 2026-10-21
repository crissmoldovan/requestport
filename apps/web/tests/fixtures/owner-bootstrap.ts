import { randomUUID } from "node:crypto";

import {
  createFoundationRepository,
  createStorage,
  type Storage,
} from "@requestport/db";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import {
  BOOTSTRAP_OWNER_ACTOR,
  type BootstrapOwnerInput,
  type BootstrapOwnerResult,
  bootstrapOwner,
  type CommandContext,
  DomainError,
} from "@requestport/domain";

/*
 * The acceptance owner's bootstrap, run in the browser lanes' own process
 * (Plan 13, J.6b; ruling 184).
 *
 * It makes the call the operator CLI's `bootstrap-owner` makes:
 * `@requestport/domain`'s `bootstrapOwner`, as `BOOTSTRAP_OWNER_ACTOR`, over
 * `@requestport/db`'s foundation repository. The lanes used to reach that
 * call through `pnpm --filter` and the CLI's workspace, which the public seed
 * leaves out; the two packages this imports are dependencies of apps/web, and
 * the seed keeps them. The input is the CLI's (email, organisation slug,
 * name, and optionally a local credential). Without one, as the lanes'
 * fixture calls it, the command is the two-stage one: the first call answers
 * `awaiting_authentication`, and a call after the owner has signed in
 * activates the membership. With `localCredential: "issue"`, as the sign-in
 * combinations call it (J.6c), it finishes in one call and answers the
 * credential once.
 *
 * The actor names the CLI because it is the one system actor the domain
 * accepts for this command. The correlation id, `e2e_` and a UUID, is what
 * tells this caller's audit rows from the CLI's (`cli_` and a UUID).
 *
 * The storage is built here from this process's environment
 * (`storageOptionsFromEnv`, over `DATABASE_URL`, the owner, whatever the
 * application variable names), as `fixtureStorage` in `auth.ts` is, with no
 * role guard, and closed before this returns. It is not the operator root's
 * storage: `rootStorageFromEnv("operator")` refuses in a process that has not
 * declared the operator surface, and Playwright's process declares none. The
 * role guard is what a composition root gives its storage (`wiring.ts`), and
 * its declaration and role checks enforce for every surface: the operator's
 * and the application's since I.2's step 5 (`ROLE_GUARD_MODES`), the
 * worker's since I.2b's b5 (`WORKER_ROLE_GUARD_MODES`). This storage has no
 * guard, so no check judges it.
 */

/** What the bootstrap runs on; a test replaces both. */
export type OwnerBootstrapDependencies = Readonly<{
  buildStorage: () => Storage;
  run: (
    storage: Storage,
    context: CommandContext,
    input: BootstrapOwnerInput,
  ) => Promise<BootstrapOwnerResult>;
}>;

const defaultDependencies: OwnerBootstrapDependencies = {
  buildStorage: () => createStorage(storageOptionsFromEnv(process.env)),
  run: (storage, context, input) =>
    bootstrapOwner(createFoundationRepository(storage.db), context, input),
};

/**
 * The domain's refusal, reduced to what is safe to repeat: its code, and the
 * field it names when that is a bare name. No message is carried, the
 * domain's or any other error's, so an address a run created is not printed
 * back into a log.
 */
function domainReason(error: unknown): string {
  if (!(error instanceof DomainError)) return "";
  const field = error.details.field;
  return typeof field === "string" && /^[A-Za-z]+$/u.test(field)
    ? ` (${error.code} ${field})`
    : ` (${error.code})`;
}

/**
 * Bootstrap the owner, and answer what the command answered; or throw
 * "Foundation E2E owner bootstrap failed: <step>", where the step is
 * `storage` (building it) or `command` (the domain's call, which is also
 * where the first connection is made). A close that fails changes nothing
 * the command answered, as in the CLI.
 */
export async function runOwnerBootstrap(
  input: BootstrapOwnerInput,
  dependencies: OwnerBootstrapDependencies = defaultDependencies,
): Promise<BootstrapOwnerResult> {
  let storage: Storage;
  try {
    storage = dependencies.buildStorage();
  } catch {
    throw new Error("Foundation E2E owner bootstrap failed: storage");
  }

  try {
    return await dependencies.run(
      storage,
      { actor: BOOTSTRAP_OWNER_ACTOR, correlationId: `e2e_${randomUUID()}` },
      input,
    );
  } catch (error) {
    throw new Error(
      `Foundation E2E owner bootstrap failed: command${domainReason(error)}`,
    );
  } finally {
    await storage.close().catch(() => undefined);
  }
}
