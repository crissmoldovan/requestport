import {
  applicationStorageOptionsFromEnv,
  createStorage,
  type HostHandoff,
  hostHandoff,
  hostHandoffRefusal,
  type Storage,
  storageOptionsFromEnv,
} from "./client.js";
import { applyLocalProxy, isHostedDriver } from "./hosted-driver.js";
import {
  createDatabaseRoleGuard,
  type DatabaseSurface,
  DatabaseSurfaceError,
  declaredDatabaseSurface,
} from "./role-guard.js";
import { tenantWrappingEnabled } from "./tenant-context.js";

/*
 * `@requestport/db/wiring` — what the repository's own composition roots use
 * to reach their storage (Plan 13, Track G; manifest-g.md §2.2, §2.9;
 * track-g.md, G.0a). A library caller builds its storages with
 * `createStorage` from the package barrel instead. Nothing here is part of
 * the published surface: `storageOptionsFromEnv` is repository-internal
 * wiring by E's contract (track-e.md, "The storage contract"), and so is
 * `applicationStorageOptionsFromEnv`, its twin for the application root
 * (Plan 13, I.2 step 5).
 */

/*
 * The host's handoff (Plan 13, H.5; manifest-h.md §2.7.1; rulings 141, 145
 * and 160): `globalThis[Symbol.for("requestport.host")]`, which a host that
 * serves Next's request handler in its own process sets to what it built.
 * The application root below answers its storage through
 * `hostHandoffMember`. Better Auth's installer (`@requestport/auth/server`)
 * and the web's RequestPort (`apps/web/src/lib/server-web-request-port.ts`)
 * read their members with the same rule in their own modules, because
 * suites that load them (H.1's route goldens, and the web's that run its
 * RequestPort) replace this module with a stand-in carrying
 * `applicationStorageFromEnv` alone. The host sets it with
 * `installHostHandoff`, and hands the factories its construction token
 * through `withHostConstructionToken` (`client.ts`).
 * Where nothing sets the handoff, as on Vercel and in the Trigger.dev
 * worker, each reader answers undefined and each root builds as before.
 */
export {
  applicationStorageOptionsFromEnv,
  storageOptionsFromEnv,
  withHostConstructionToken,
} from "./client.js";

/**
 * A construction token for the host's own factories: a fresh object, which
 * the host keeps in its own closure, hands to the factories it calls
 * (`withHostConstructionToken`) and to `installHostHandoff`, and to nothing
 * else. It is never a member of the handoff.
 */
export function hostConstructionToken(): object {
  return Object.freeze({});
}

/**
 * Sets the host's handoff to `members` and `admitsConstruction`, which admits
 * `token` alone, frozen (`requestport start`'s serving composition,
 * `apps/requestport/src/serve/serve.ts`). Refuses while a handoff is set, so a
 * process holds one. Answers how to take it back, which removes this handoff
 * and leaves any other alone.
 */
export function installHostHandoff(
  members: { requestPort: unknown; auth: unknown; storage: Storage },
  token: object,
): () => void {
  const holder = globalThis as Record<symbol, unknown>;
  const key = Symbol.for("requestport.host");

  if (holder[key] !== undefined) {
    throw new Error(
      "The host's handoff is already set in this process: one process serves one instance.",
    );
  }
  const installed = Object.freeze({
    requestPort: members.requestPort,
    auth: members.auth,
    storage: members.storage,
    admitsConstruction: (candidate: unknown) => candidate === token,
  });

  holder[key] = installed;
  return () => {
    if (holder[key] === installed) delete holder[key];
  };
}

/**
 * The member of the host's handoff that `site` answers from: undefined where
 * no handoff is set, the member where it carries one, and otherwise (the
 * member absent or null) a `HostHandoffRefusalError` naming `site` and the
 * member, thrown after its one console line (ruling 145). It builds nothing.
 */
export function hostHandoffMember<
  Member extends "requestPort" | "auth" | "storage",
>(site: string, member: Member): NonNullable<HostHandoff[Member]> | undefined {
  const handoff = hostHandoff();

  if (handoff === undefined) return undefined;
  const value = handoff[member];

  if (value === undefined || value === null) {
    throw hostHandoffRefusal(site, `it carries no ${member}`);
  }
  return value;
}

/*
 * `requestport start`'s operator step (Plan 13, H.4; ruling 158, item 1):
 * the owner's preflight, the claim and its lock, the journal read, migrate
 * and provisioning, over the owner URL it is handed (`operator-session.ts`),
 * the logins' names and URLs, and the refusal of production's and staging's
 * databases that its caller applies to that URL before the session opens.
 * Loading them opens nothing: `operator-session.ts` defines constants and
 * functions, and imports no migrator; its caller hands it one.
 */
export { refuseUnapprovedSharedPgDatabase } from "./database-url.js";
export {
  type ClaimOutcome,
  INSTANCE_LOGIN_GROUPS,
  INSTANCE_LOGIN_KINDS,
  type InstanceLoginKind,
  type InstanceLogins,
  instanceLoginNames,
  instanceLoginUrls,
  OperatorRefusalError,
  type OperatorRefusalReason,
  type OperatorSession,
  type OperatorSessionOptions,
  type OwnerPreflight,
  openOperatorSession,
  type ProvisionedLogin,
  packagedMigrationsFolder,
} from "./operator-session.js";

/** A surface a composition root serves. `test` is only ever a Vitest setup's. */
export type RootDatabaseSurface = Exclude<DatabaseSurface, "test">;

/**
 * A root's declaration check (manifest-g.md §2.9; M4, as ruling 71 holds
 * it): throws `DatabaseSurfaceError` unless this process has declared
 * `expected`, and answers the surface it found. Synchronous, so a root that
 * calls it first builds nothing in a process that has not declared — the
 * role guard alone would only object when a connection is first made.
 *
 * `test` passes in place of `expected`. The Vitest projects that reach a
 * database declare `test` in their setup file
 * (`test-support/declare-test-surface.ts`); the others, `packages/jobs`'
 * unit project and `apps/cli`'s among them, declare nothing in theirs.
 * `declareDatabaseSurface` refuses `test` outside Vitest, so no deployed
 * process passes this way.
 *
 * `embedded` passes in place of `application` while the host's handoff is
 * set, and only then (ruling 141): `requestport start` on PGlite declares
 * `embedded` and serves Next in the same process, whose web roots ask for
 * `application`, and `rootStorageFromEnv` then answers them the handoff's
 * storage (or refuses, when it carries none), building nothing. Without the
 * handoff, or for any other root, a process declared `embedded` is refused
 * here as before.
 */
export function assertDeclaredDatabaseSurface(
  expected: RootDatabaseSurface,
): DatabaseSurface {
  const declared = declaredDatabaseSurface();

  if (declared === expected || declared === "test") return declared;
  if (
    expected === "application" &&
    declared === "embedded" &&
    hostHandoff() !== undefined
  ) {
    return declared;
  }
  throw new DatabaseSurfaceError(
    declared === undefined
      ? "RequestPort database surface not declared: the " +
          `${expected} root builds no storage until its entry point has ` +
          `called declareDatabaseSurface("${expected}") (manifest-g.md §2.9).`
      : `RequestPort database surface is declared as ${declared}; the ` +
          `${expected} root builds no storage in a process declared as ` +
          `anything but ${expected} (manifest-g.md §2.9).`,
  );
}

/*
 * The roots' storages live on `globalThis`, under a registered symbol, as the
 * surface declaration does (`role-guard.ts`), and for its reason: a bundler
 * can give one process two copies of this module — Next's build of the web
 * carries two, the second in a chunk only two server-action modules reach,
 * which `"use client"` components import; `instrumentation.ts`'s chunk
 * carries neither (measured by H.0b, K9; ruling 143) — and a storage held in
 * a module variable would then be two pools (manifest-g.md §2.12, as ruling
 * 118 amends it). One storage per surface, built by the first root to ask
 * for it. A process declares one surface (D21), so it holds one; a Vitest
 * process, declared as `test`, may ask for each. The holder is installed by
 * that first ask, never as this module loads. Tests that build a root afresh
 * under another environment clear it there, as they clear the declaration.
 */
const ROOT_STORAGES = Symbol.for("requestport.root-storages");

type RootStorageHolder = {
  [ROOT_STORAGES]?: Partial<Record<RootDatabaseSurface, Storage>>;
};

/**
 * The storage this process's root for `surface` uses, after
 * `assertDeclaredDatabaseSurface(surface)`. The first call for a surface
 * builds it; every later one, from any copy of this module, answers the same
 * object (above).
 *
 * While the host's handoff is set, the application root answers the storage
 * it carries, and builds and holds none, in a process declared `application`
 * or, beside `requestport start` on PGlite, `embedded` (above); a handoff that
 * carries none is refused here (`hostHandoffMember`). The other roots are not
 * answered from it: a storage they would build meets `createStorage`'s
 * refusal.
 *
 * It is built from `client.ts`'s options over `process.env`: the
 * application root's from `applicationStorageOptionsFromEnv`, the one reader
 * of the application variable, and every other root's from
 * `storageOptionsFromEnv`, the owner's URL whatever that variable says
 * (manifest-i2.md §2.8 item 2; I.2 step 5, slice 1). Each has a role guard
 * of its own. The application root's `tenantBinding` is `"wrapped"`: since
 * I.2 step 5 its storage connects only through the application variable, or
 * a preview's own, never through `DATABASE_URL` (`readApplicationDatabaseUrl`).
 * Every other root's is the one the environment gives
 * (`tenantWrappingEnabled` over `process.env`), read once, here: one built
 * where the application variable is set is therefore `"wrapped"` over the
 * owner's URL. For a role
 * that bypasses row-level security, which the operator's role check expects
 * (`role-guard.ts`), a bound transaction reads what an unbound read would.
 * Before it builds a storage on the hosted driver it applies that driver's
 * local proxy (`applyLocalProxy` in `hosted-driver.ts`, which changes nothing
 * wherever `VERCEL_ENV` is set). Building it reads the variables those
 * name, and opens no connection: the connection string is read, behind the
 * guard's declaration and environment checks, when the pool first constructs
 * a client, and the guard's role check runs before the storage's first use
 * (`client.ts`).
 */
export function rootStorageFromEnv(surface: RootDatabaseSurface): Storage {
  assertDeclaredDatabaseSurface(surface);

  if (surface === "application") {
    const handed = hostHandoffMember(
      "application root (rootStorageFromEnv)",
      "storage",
    );

    if (handed !== undefined) return handed;
  }

  const holder = globalThis as RootStorageHolder;
  const held = holder[ROOT_STORAGES] ?? {};
  const storage = held[surface] ?? buildRootStorage(surface);

  held[surface] = storage;
  holder[ROOT_STORAGES] = held;
  return storage;
}

function buildRootStorage(surface: RootDatabaseSurface): Storage {
  const options =
    surface === "application"
      ? applicationStorageOptionsFromEnv(process.env)
      : storageOptionsFromEnv(process.env);

  if (isHostedDriver(options.driver)) applyLocalProxy(process.env);
  return createStorage({
    ...options,
    guard: createDatabaseRoleGuard(),
    tenantBinding:
      surface === "application" || tenantWrappingEnabled(process.env)
        ? "wrapped"
        : "off",
  });
}

/**
 * The web process's application storage, which the web root and Better
 * Auth's installer share (manifest-g.md §2.12): `rootStorageFromEnv`, for
 * the `application` surface.
 */
export function applicationStorageFromEnv(): Storage {
  return rootStorageFromEnv("application");
}
