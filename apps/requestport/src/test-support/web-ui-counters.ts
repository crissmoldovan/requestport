import Module from "node:module";

/*
 * What Done when 11 counts inside a serving `requestport start` (manifest-h.md
 * §2.7.1; rulings 143 and 145), installed by `web-ui.test-entry.ts` before it
 * imports anything else, and read back through `webUiCounters()`. It changes
 * no file on disk: every count is taken at a point every copy of the code,
 * the host's and each of the module copies Next's build carries, goes
 * through, and the one count that needs a line of code where there is none
 * (Better Auth's constructions, below) gets it as the module is loaded, in
 * this process only.
 *
 * - **Storages.** Every storage `createStorage` builds, in any copy of
 *   `@requestport/db`, records its tenant binding in the one map all copies
 *   share, `globalThis[Symbol.for("requestport.tenant-bindings")]`
 *   (`packages/db/src/client.ts`). That map is installed here first, and
 *   counts each handle it is given, with the call sites that gave it, so the
 *   test can say which module copy built it (by the file, and, in Next's
 *   chunks, the module id at that position: `web-ui-build.ts`).
 * - **pg pools and PGlite engines.** Every copy of `client.ts` that is not
 *   bundled loads `pg` and `@electric-sql/pglite` through Node's `require`
 *   (`loadPgDriver`, `loadPgliteDriver`); each is counted as it is
 *   constructed, with its call sites and the file the package resolved to.
 * - **Better Auth instances, built anywhere.** Every Better Auth instance is
 *   built by `createBetterAuth` (`better-auth@1.7.6` `dist/auth/base.mjs`,
 *   which `betterAuth()` calls), and each copy of it, the host's file and the
 *   one each of Next's chunks bundles, returns an object whose `$context`
 *   member is followed by `$ERROR_CODES`. A load hook (`module.registerHooks`,
 *   which sees `import` and `require` alike) rewrites that member, in each
 *   module that carries `createBetterAuth`'s own error message, to a computed
 *   key that first calls the counter here, so each construction is counted
 *   with its call site, as the instance object is built; a module that
 *   carries the message without exactly one such member per copy fails to
 *   load, so the count is never taken blind (`countingBetterAuthConstructions`).
 *   The member keeps its key and its value: the computed key is `$context`.
 * - **The handed Better Auth's initialisations**, by wrapping its
 *   `auth.options.database`, the adapter factory Better Auth calls once as
 *   each instance initialises (H.0c, For the driver 8), when the host sets its
 *   handoff. This counts the handed composition's instances only; the
 *   constructions above count every one.
 * - **Module evaluations**, per webpack module id, for the ids
 *   `RP_H5_MODULE_IDS` names, as H.0b's K9 counted them: an accessor on each
 *   webpack runtime's factory table that wraps the factory it is given.
 * - **The order**: when the handoff was set, and when each webpack runtime was
 *   first loaded, which happens only as Next prepares and serves.
 *
 * And, for the controls only, what the environment asks it to take away:
 * - `RP_H5_HANDOFF_OMIT=<member>`: the handoff Next reads lacks that member;
 * - `RP_H5_REMOVE_DOMAIN_ERROR_BRAND=1`: no `DomainError` in this process
 *   carries its brand (`Object.defineProperty` drops that one key);
 * - `RP_H5_UNNAME_API_ERROR=1`: an `APIError` the handed
 *   `requireHumanSession` throws reaches Next's copy named `Error`;
 * - `RP_H5_INSTALLER_IGNORES_HANDOFF=1`: each copy of Better Auth's installer
 *   (`packages/auth/src/server.ts`) in Next's server output reads the
 *   handoff under another key, so it finds none and calls `createAuth`, whose
 *   own gate, which still reads the handoff, is then what answers. The load
 *   hook below rewrites, in each module of Next's output that carries the
 *   installer's refusal message, the `Symbol.for("requestport.host")` its
 *   reader opens with (the last one before that message, and within
 *   `INSTALLER_READ_WINDOW` characters of it); a module in which a copy of
 *   the message has no such read fails to load, so the control never passes
 *   blind. The rewritten files are recorded in `installerReadsRewritten`.
 */

export interface CallSiteRecord {
  file: string | null;
  line: number | null;
  column: number | null;
}

export interface Construction {
  /** The file the package resolved to, for a pool or an engine. */
  module?: string;
  /** The stack where it was built, innermost first, this module's frames left out. */
  sites: CallSiteRecord[];
}

export interface WebUiCounters {
  events: string[];
  storages: Construction[];
  pgPools: Construction[];
  pgliteEngines: Construction[];
  /** The handed Better Auth's initialisations. */
  betterAuthInstances: number;
  /** Every Better Auth instance built in this process, by any copy of better-auth. */
  betterAuthConstructions: Construction[];
  evaluations: Record<string, number>;
  handoffMembers: string[] | null;
  controls: string[];
  /** Under `RP_H5_INSTALLER_IGNORES_HANDOFF`, each file whose installer reads were rewritten, and how many. */
  installerReadsRewritten: { file: string; copies: number }[];
}

const STATE = Symbol.for("requestport.test.web-ui-counters");
const HOST = Symbol.for("requestport.host");
const TENANT_BINDINGS = Symbol.for("requestport.tenant-bindings");
const DOMAIN_ERROR_BRAND = Symbol.for("requestport.domain-error");
const BETTER_AUTH_CONSTRUCTED = Symbol.for(
  "requestport.test.better-auth-constructed",
);

/** A message only `createBetterAuth` carries (`better-auth@1.7.6` `dist/auth/base.mjs`), in every copy, minified or not. */
const BETTER_AUTH_CONSTRUCTION_MARKER =
  "Could not get base URL from request. Please provide a valid base URL.";
/** The member of the object `createBetterAuth` answers: `$context: authContext, $ERROR_CODES:` in base.mjs, `$context:c,$ERROR_CODES:` in Next's chunks. */
const BETTER_AUTH_CONSTRUCTION_SITE =
  /\$context:(\s*[\w$]+,\s*\$ERROR_CODES:)/gu;

/**
 * `source` with each copy of `createBetterAuth`'s answer counting itself as
 * it is built, or undefined when it carries no copy. Throws when the copies
 * and the members found differ, so a Better Auth this cannot count fails the
 * start rather than passing uncounted.
 */
function countingBetterAuthConstructions(source: string): string | undefined {
  if (!source.includes(BETTER_AUTH_CONSTRUCTION_MARKER)) return undefined;
  const copies = source.split(BETTER_AUTH_CONSTRUCTION_MARKER).length - 1;
  const sites = [...source.matchAll(BETTER_AUTH_CONSTRUCTION_SITE)].length;
  if (sites !== copies) {
    throw new Error(
      `web-ui-counters: a module carries ${copies} copies of createBetterAuth ` +
        `and ${sites} members to count them at, so its Better Auth ` +
        "constructions cannot be counted.",
    );
  }
  return source.replace(
    BETTER_AUTH_CONSTRUCTION_SITE,
    (_member, rest: string) =>
      `[(globalThis[Symbol.for("requestport.test.better-auth-constructed")]?.(),"$context")]:${rest}`,
  );
}

/** Better Auth's installer's refusal (`packages/auth/src/server.ts`): one per copy of the installer. */
const INSTALLER_MARKER =
  "RequestPort's Better Auth installer (@requestport/auth/server) refused";
const HANDOFF_READ = 'Symbol.for("requestport.host")';
/** How far before its message an installer copy's read of the handoff may be: 135 characters in Next's chunks, measured. */
const INSTALLER_READ_WINDOW = 400;

/**
 * `source` with each copy of Better Auth's installer reading the handoff
 * under a key nothing sets, and how many copies; undefined when it carries
 * none. Throws when a copy has no read of the handoff in its window.
 */
function installerIgnoringHandoff(
  source: string,
): { source: string; copies: number } | undefined {
  const at: number[] = [];
  for (
    let index = source.indexOf(INSTALLER_MARKER);
    index !== -1;
    index = source.indexOf(INSTALLER_MARKER, index + 1)
  ) {
    at.push(index);
  }
  if (at.length === 0) return undefined;
  const reads = at.map((index) => {
    const read = source.lastIndexOf(HANDOFF_READ, index);
    if (read === -1 || index - read > INSTALLER_READ_WINDOW) {
      throw new Error(
        "web-ui-counters: a copy of Better Auth's installer has no read of " +
          "the host's handoff before its refusal, so " +
          "RP_H5_INSTALLER_IGNORES_HANDOFF cannot apply to it.",
      );
    }
    return read;
  });
  let rewritten = source;
  for (const read of [...new Set(reads)].sort((a, b) => b - a)) {
    rewritten =
      rewritten.slice(0, read) +
      'Symbol.for("requestport.test.no-handoff")' +
      rewritten.slice(read + HANDOFF_READ.length);
  }
  return { source: rewritten, copies: new Set(reads).size };
}

type LoadResult = { format?: string | null; source?: unknown };
type LoadHook = (
  url: string,
  context: unknown,
  nextLoad: (url: string, context: unknown) => LoadResult,
) => LoadResult;

const holder = globalThis as unknown as Record<symbol, unknown>;

/** The counts so far, in this process. */
export function webUiCounters(): WebUiCounters {
  return holder[STATE] as WebUiCounters;
}

/** The call sites above `below`, raw: the generated file's own positions. */
function sitesAbove(
  below: ((...args: never[]) => unknown) | (new (...args: never[]) => object),
): CallSiteRecord[] {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  Error.prepareStackTrace = (_error, callSites) => callSites;
  Error.stackTraceLimit = 40;
  try {
    const captured: { stack?: NodeJS.CallSite[] } = {};
    Error.captureStackTrace(captured, below);
    return (captured.stack ?? []).map((site) => ({
      file: site.getFileName() ?? null,
      line: site.getLineNumber(),
      column: site.getColumnNumber(),
    }));
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
}

export function installWebUiCounters(env: NodeJS.ProcessEnv): void {
  if (holder[STATE] !== undefined) return;
  const counters: WebUiCounters = {
    events: [],
    storages: [],
    pgPools: [],
    pgliteEngines: [],
    betterAuthInstances: 0,
    betterAuthConstructions: [],
    evaluations: {},
    handoffMembers: null,
    controls: [],
    installerReadsRewritten: [],
  };
  holder[STATE] = counters;

  // Storages, through the tenant-binding map every copy of client.ts shares.
  class CountingWeakMap extends WeakMap<object, unknown> {
    override set(key: object, value: unknown) {
      if (!this.has(key)) {
        counters.storages.push({
          sites: sitesAbove(CountingWeakMap.prototype.set),
        });
      }
      return super.set(key, value);
    }
  }
  holder[TENANT_BINDINGS] = new CountingWeakMap();

  // pg pools and PGlite engines, as Node's require hands the packages out.
  const internals = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
    _resolveFilename(request: string, parent: unknown): string;
  };
  const load = internals._load;
  const patchedPg = new WeakSet<object>();
  const wrappedPglite = new WeakMap<object, object>();
  const hookedRuntimes = new WeakSet<object>();
  const moduleIds = (env.RP_H5_MODULE_IDS ?? "").split(",").filter(Boolean);
  internals._load = function countingLoad(request, parent, isMain) {
    const loaded = load.call(this, request, parent, isMain) as Record<
      string,
      unknown
    >;
    if (request === "pg" && !patchedPg.has(loaded)) {
      patchedPg.add(loaded);
      const resolved = internals._resolveFilename(request, parent);
      const Pool = loaded.Pool as new (...args: unknown[]) => object;
      loaded.Pool = class CountedPool extends Pool {
        constructor(...args: unknown[]) {
          super(...args);
          counters.pgPools.push({
            module: resolved,
            sites: sitesAbove(CountedPool),
          });
        }
      };
    }
    if (request === "@electric-sql/pglite") {
      let wrapper = wrappedPglite.get(loaded);
      if (wrapper === undefined) {
        const resolved = internals._resolveFilename(request, parent);
        const PGlite = loaded.PGlite as new (...args: unknown[]) => object;
        class CountedPGlite extends PGlite {
          constructor(...args: unknown[]) {
            super(...args);
            counters.pgliteEngines.push({
              module: resolved,
              sites: sitesAbove(CountedPGlite),
            });
          }
        }
        wrapper = Object.create(loaded, {
          PGlite: { value: CountedPGlite, enumerable: true },
        }) as object;
        wrappedPglite.set(loaded, wrapper);
      }
      return wrapper;
    }
    if (
      /(^|\/)webpack-runtime(\.js)?$/u.test(request) &&
      typeof loaded === "function" &&
      typeof (loaded as { m?: unknown }).m === "object" &&
      !hookedRuntimes.has(loaded)
    ) {
      hookedRuntimes.add(loaded);
      counters.events.push(
        `webpack runtime loaded: ${internals._resolveFilename(request, parent)}`,
      );
      const table = (loaded as unknown as { m: Record<string, unknown> }).m;
      for (const id of moduleIds) {
        type Factory = (this: unknown, ...args: unknown[]) => unknown;
        const counted = (factory: Factory): Factory =>
          function countedFactory(this: unknown, ...args: unknown[]) {
            counters.evaluations[id] = (counters.evaluations[id] ?? 0) + 1;
            return factory.apply(this, args);
          };
        let current = table[id] as Factory | undefined;
        if (current) current = counted(current);
        Object.defineProperty(table, id, {
          configurable: true,
          enumerable: true,
          get: () => current,
          set: (factory: Factory) => {
            current = counted(factory);
          },
        });
      }
    }
    return loaded;
  };

  // Better Auth's constructions, in every copy, as each module is loaded.
  holder[BETTER_AUTH_CONSTRUCTED] = function betterAuthConstructed() {
    counters.betterAuthConstructions.push({
      sites: sitesAbove(betterAuthConstructed),
    });
  };
  const hooks = Module as unknown as {
    registerHooks?: (hooks: { load: LoadHook }) => unknown;
  };
  if (typeof hooks.registerHooks !== "function") {
    throw new Error(
      "web-ui-counters: this Node has no module.registerHooks, so Better Auth's constructions cannot be counted.",
    );
  }
  const installerIgnoresHandoff = env.RP_H5_INSTALLER_IGNORES_HANDOFF === "1";
  hooks.registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (
        (loaded.format !== "module" && loaded.format !== "commonjs") ||
        loaded.source === undefined ||
        loaded.source === null
      ) {
        return loaded;
      }
      const source =
        typeof loaded.source === "string"
          ? loaded.source
          : Buffer.from(loaded.source as Uint8Array).toString("utf8");
      let changed = countingBetterAuthConstructions(source);
      // The control: only in Next's server output, never the host's copy.
      if (installerIgnoresHandoff && url.includes("/.next-self-host/")) {
        const ignoring = installerIgnoringHandoff(changed ?? source);
        if (ignoring !== undefined) {
          counters.installerReadsRewritten.push({
            file: url,
            copies: ignoring.copies,
          });
          changed = ignoring.source;
        }
      }
      return changed === undefined ? loaded : { ...loaded, source: changed };
    },
  });

  // The controls.
  const omit = env.RP_H5_HANDOFF_OMIT;
  if (omit) counters.controls.push(`handoff without ${omit}`);
  if (env.RP_H5_REMOVE_DOMAIN_ERROR_BRAND === "1") {
    counters.controls.push("DomainError unbranded");
    const define = Object.defineProperty;
    Object.defineProperty = function definedUnlessBrand<T>(
      target: T,
      key: PropertyKey,
      descriptor: PropertyDescriptor & ThisType<unknown>,
    ): T {
      if (key === DOMAIN_ERROR_BRAND) return target;
      return define(target, key, descriptor);
    };
  }
  const unnameApiError = env.RP_H5_UNNAME_API_ERROR === "1";
  if (unnameApiError) counters.controls.push("APIError unnamed");
  if (installerIgnoresHandoff) {
    counters.controls.push("Better Auth installer ignores the handoff");
  }

  // The handoff, as the host sets it.
  let handed: unknown;
  Object.defineProperty(holder, HOST, {
    configurable: true,
    enumerable: false,
    get: () => handed,
    set: (value: unknown) => {
      counters.events.push("handoff set");
      handed = instrumentHandoff(value);
    },
  });

  function instrumentHandoff(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const handoff = value as Record<string, unknown>;
    const auth = handoff.auth as
      | {
          auth?: { options?: { database?: unknown } };
          requireHumanSession?: (...args: unknown[]) => Promise<unknown>;
        }
      | undefined;
    const options = auth?.auth?.options;
    if (options && typeof options.database === "function") {
      const factory = options.database as (...args: unknown[]) => unknown;
      options.database = (...args: unknown[]) => {
        counters.betterAuthInstances += 1;
        return factory(...args);
      };
    }
    if (!omit && !unnameApiError) {
      counters.handoffMembers = Object.keys(handoff).sort();
      return value;
    }
    const changed: Record<string, unknown> = { ...handoff };
    if (omit) delete changed[omit];
    if (unnameApiError && auth?.requireHumanSession) {
      const requireHumanSession = auth.requireHumanSession;
      changed.auth = {
        ...auth,
        requireHumanSession: async (...args: unknown[]) => {
          try {
            return await requireHumanSession(...args);
          } catch (error) {
            if ((error as { name?: unknown })?.name === "APIError") {
              (error as { name: string }).name = "Error";
            }
            throw error;
          }
        },
      };
    }
    counters.handoffMembers = Object.keys(changed).sort();
    return changed;
  }
}
