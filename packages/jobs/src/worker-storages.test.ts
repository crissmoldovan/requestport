import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ownerCapableVariableNames,
  type WorkerStorages,
} from "@requestport/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WorkerSettings } from "./worker-storages.js";

/*
 * The worker's storages and settings holder (`worker-storages.ts`), cut from
 * the worker root (Plan 13, G.7a; ruling 139, option (b)). The holder imports
 * no root. What fills it when nothing is installed is registered by this
 * package's own module (`index.ts`), which every Trigger.dev task module that
 * reaches this package reaches it through; `requestport-jobs` installs its
 * own (`cli.ts`), and core's `postgres` background installs its caller's.
 *
 * The root is a recorder here (`workerStoragesFromRoot`,
 * `workerSettingsFromRoot`), so that each case can say which of its functions
 * filled the holder, and with what. worker-root.test.ts runs the real root
 * through this package's module, and trigger's task-surface.test.ts the real
 * task modules.
 */

const root = vi.hoisted(() => ({
  storages: [] as unknown[][],
  settings: [] as unknown[][],
  built: {
    storages: {
      bound: false,
      dispatcher: { handle: "the root's dispatcher" },
      maintenance: { handle: "the root's maintenance" },
      close: async () => undefined,
    },
    settings: { environment: "the root's settings" },
  },
}));

vi.mock("./worker-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-root.js")>()),
  workerStoragesFromRoot: (...args: unknown[]) => {
    root.storages.push(args);
    return root.built.storages;
  },
  workerSettingsFromRoot: (...args: unknown[]) => {
    root.settings.push(args);
    return root.built.settings;
  },
}));

const started = vi.hoisted(() => ({
  settingsAsked: [] as number[],
  stops: 0,
}));

/*
 * `requestport-jobs`' worker, a recorder: it notes how often the root had
 * been asked for settings when the worker started, and stops at once.
 */
vi.mock("./worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker.js")>()),
  startJobWorker: () => {
    started.settingsAsked.push(root.settings.length);
    return {
      ready: Promise.resolve(),
      stop: async () => {
        started.stops += 1;
        return { drained: true };
      },
    };
  },
}));

/* The root's own storage, which `requestport-jobs` closes when it stops. */
vi.mock("@requestport/db/wiring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@requestport/db/wiring")>()),
  rootStorageFromEnv: () => ({ close: async () => undefined }),
}));

beforeEach(() => {
  vi.resetModules();
  root.storages.length = 0;
  root.settings.length = 0;
  started.settingsAsked.length = 0;
  started.stops = 0;
});
afterEach(() => {
  vi.resetModules();
});

describe("the worker's storages and settings holder", () => {
  test("imported alone, by its subpath, in a process of its own, loads no other module of this repository: not the worker root, the configuration or db's wiring module", {
    timeout: 60_000,
  }, () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    // tsx, resolved from this package, whose dependency it is, reports each
    // module it loads (`onImport`), as core's import test reads its graph.
    // The holder is imported by the specifier core's `worker-holder.ts`
    // names, which this package resolves as its own (`exports`).
    const program = [
      'import { createRequire } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'const require = createRequire(pathToFileURL(process.cwd() + "/package.json"));',
      'const { register } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);',
      "const loaded = [];",
      "register({ onImport: (url) => loaded.push(url) });",
      'await import("@requestport/jobs/worker-storages");',
      "for (let quiet = 0, seen = -1; quiet < 3; ) {",
      "  await new Promise((resolve) => setTimeout(resolve, 50));",
      "  quiet = loaded.length === seen ? quiet + 1 : 0;",
      "  seen = loaded.length;",
      "}",
      "process.stdout.write(JSON.stringify(loaded));",
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "--eval", program],
      {
        cwd: packageRoot,
        env: {},
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 50_000,
      },
    );

    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const ours = [
      ...new Set(
        (JSON.parse(child.stdout) as string[])
          .filter((url) => url.startsWith("file:"))
          .map((url) => fileURLToPath(url))
          .filter((path) => !path.includes("/node_modules/"))
          .map((path) => relative(repositoryRoot, path)),
      ),
    ];
    expect(ours).toEqual(["packages/jobs/src/worker-storages.ts"]);
  });

  test("with nothing installed and no worker root registered, workerStorages() and workerSettings() refuse, say what would fill them, and build nothing", async () => {
    const { workerSettings, workerStorages } = await import(
      "./worker-storages.js"
    );

    expect(() => workerStorages()).toThrow(
      /no worker storages installed, and no worker root registered.*useWorkerStorages.*@requestport\/jobs/u,
    );
    expect(() => workerSettings()).toThrow(
      /no worker settings installed, and no worker root registered.*useWorkerSettings.*@requestport\/jobs/u,
    );
    expect(root).toMatchObject({ storages: [], settings: [] });
  });

  test("loaded with the package's own module, as each Trigger.dev task module loads it, fills from the worker root on the first ask: workerStoragesFromRoot(process.env) and workerSettingsFromRoot(), once each, and again once forgotten", async () => {
    await import("./index.js");
    const {
      useWorkerSettings,
      useWorkerStorages,
      workerSettings,
      workerStorages,
    } = await import("./worker-storages.js");

    // Registering builds nothing.
    expect(root).toMatchObject({ storages: [], settings: [] });

    expect(workerStorages()).toBe(root.built.storages);
    expect(workerStorages()).toBe(root.built.storages);
    expect(root.storages).toHaveLength(1);
    expect(root.storages[0]).toHaveLength(1);
    expect(root.storages[0]?.[0]).toBe(process.env);
    useWorkerStorages(undefined);
    expect(workerStorages()).toBe(root.built.storages);
    expect(root.storages).toHaveLength(2);

    expect(workerSettings()).toBe(root.built.settings);
    expect(workerSettings()).toBe(root.built.settings);
    expect(root.settings).toEqual([[]]);
    useWorkerSettings(undefined);
    expect(workerSettings()).toBe(root.built.settings);
    expect(root.settings).toEqual([[], []]);

    // What is installed is used as it is, and the root is not asked.
    const installed = { ...root.built.settings } as unknown as WorkerSettings;
    useWorkerSettings(installed);
    expect(workerSettings()).toBe(installed);
    expect(root.settings).toHaveLength(2);
  });

  test("requestport-jobs installs the worker root's settings beside its storages, before its worker starts", async () => {
    const { runJobWorkerCli } = await import("./cli.js");
    const { workerSettings, workerStorages } = await import(
      "./worker-storages.js"
    );
    const signals = ["SIGTERM", "SIGINT"] as const;
    const before = Object.fromEntries(
      signals.map((signal) => [signal, process.listeners(signal)]),
    );
    const added = (signal: (typeof signals)[number]) =>
      process
        .listeners(signal)
        .filter((listener) => !before[signal]?.includes(listener));

    try {
      // Without the owner's names, which it refuses to start beside (ruling
      // 218): this process reaches its database through DATABASE_URL.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        REQUESTPORT_JOB_RUNNER: "postgres",
        VERCEL_ENV: undefined,
      };
      for (const name of ownerCapableVariableNames(env)) delete env[name];
      const exit = runJobWorkerCli([], env);

      // Installed before the worker started: no body has asked yet.
      expect(started.settingsAsked).toEqual([1]);
      expect(root.settings).toEqual([[]]);
      expect(root.storages).toHaveLength(1);
      expect(workerSettings()).toBe(root.built.settings);
      expect(workerStorages()).toBe(
        root.built.storages as unknown as WorkerStorages,
      );
      expect(root.settings).toHaveLength(1);

      // Its signal handler, called as the signal would call it.
      const [onSignal] = added("SIGTERM");
      onSignal?.("SIGTERM");
      await expect(exit).resolves.toBe(0);
      expect(started.stops).toBe(1);
    } finally {
      for (const signal of signals) {
        for (const listener of added(signal)) {
          process.removeListener(signal, listener);
        }
      }
    }
  });
});

/*
 * The holder and the host's handoff (Plan 13, H.5; manifest-h.md §2.7.1;
 * rulings 145 and 160). While `globalThis[Symbol.for("requestport.host")]` is
 * set, a copy of this module with nothing installed refuses rather than ask
 * the registered worker root to build, by name, with one console line: the
 * worker's storages in that process are the ones installed in the host's own
 * copy. It reads the symbol itself, because this module imports nothing of
 * the repository's but types. Unset, as in the Trigger.dev worker, which
 * never sets it, the root fills the holder as before (the case above that
 * loads the package's own module).
 */
describe("the worker's storages holder and the host's handoff", () => {
  const HOST = Symbol.for("requestport.host");
  const holder = globalThis as Record<symbol, unknown>;
  const refusalLine =
    "HostHandoffRefusalError: RequestPort's workerStorages() refused: the " +
    "host's handoff is present, and no worker storages are installed in " +
    "this copy of the holder. While it is present, the web answers the " +
    "storage, Better Auth and RequestPort it carries and builds none of its " +
    "own (manifest-h.md §2.7.1).";

  afterEach(() => {
    delete holder[HOST];
    vi.restoreAllMocks();
  });

  test("present, with nothing installed, workerStorages() refuses with HostHandoffRefusalError and one console line, and asks the registered worker root for nothing", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await import("./index.js");
    const { workerStorages } = await import("./worker-storages.js");
    holder[HOST] = { admitsConstruction: () => true };

    let refusal: unknown;
    try {
      workerStorages();
    } catch (error) {
      refusal = error;
    }

    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect(`${(refusal as Error).name}: ${(refusal as Error).message}`).toBe(
      refusalLine,
    );
    expect(logged.mock.calls).toEqual([[refusalLine]]);
    expect(root.storages).toEqual([]);
  });

  test("present, it answers the storages installed in its copy, as the host's own background installs them, and asks the root for nothing", async () => {
    const logged = vi.spyOn(console, "error");
    await import("./index.js");
    const { useWorkerStorages, workerStorages } = await import(
      "./worker-storages.js"
    );
    const installed = { ...root.built.storages } as unknown as WorkerStorages;
    holder[HOST] = {};

    useWorkerStorages(installed);

    expect(workerStorages()).toBe(installed);
    expect(root.storages).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });
});
