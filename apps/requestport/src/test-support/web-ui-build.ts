import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/*
 * Which webpack module is where in the self-host build's server output, read
 * without running any of it (H.0b's `spikes/h0-probe/k9-chunks.mjs`, as a
 * module): each built file is evaluated in a `vm` context whose `require`
 * answers a stand-in runtime that records the module tables it is handed
 * and never calls a factory. A factory's source is its own text in the file
 * (`Function.prototype.toString`), so each module id's span in each file is
 * found, and a position in the file (a stack frame's line and column) maps
 * back to the module id it falls in. Within one webpack runtime, which keeps
 * one module cache keyed by id, an id is one module instance (K9), so two
 * ids that carry one source file's code are two copies of it.
 */

export interface ModuleSpan {
  id: string;
  start: number;
  end: number;
}

export interface SelfHostBuildScan {
  /** For each marker, the module ids whose factory carries it. */
  idsCarrying(marker: string): string[];
  /** The module id at a stack frame's position in a built file, if any. */
  moduleAt(file: string, line: number, column: number): string | undefined;
  /** Files that could not be read as a module table, by their path in the server output. */
  unreadable: string[];
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function moduleTableOf(path: string, source: string): Record<string, unknown> {
  const installed: { modules?: Record<string, unknown> }[] = [];
  const runtime = Object.assign(() => ({}), {
    C(chunk: { modules?: Record<string, unknown> }) {
      installed.push(chunk);
    },
    X() {},
    e: () => Promise.resolve(),
  });
  const module = { exports: {} as { modules?: Record<string, unknown> } };
  vm.runInNewContext(
    source,
    {
      require: (specifier: string) =>
        /webpack-runtime(\.js)?$/u.test(specifier) ? runtime : {},
      module,
      exports: module.exports,
      self: {},
      globalThis: {},
      process: { env: {} },
      console: { log() {}, warn() {}, error() {} },
    },
    { filename: path, timeout: 5_000 },
  );
  const modules: Record<string, unknown> = {};
  for (const table of [module.exports, ...installed]) {
    if (table?.modules) Object.assign(modules, table.modules);
  }
  return modules;
}

/** Reads every `.js` file under `serverDirectory`, the build's `server/`. */
export function scanSelfHostBuild(serverDirectory: string): SelfHostBuildScan {
  const spans = new Map<
    string,
    { lineStarts: number[]; spans: ModuleSpan[] }
  >();
  const factories = new Map<string, string[]>();
  const unreadable: string[] = [];
  for (const path of walk(serverDirectory).filter((file) =>
    file.endsWith(".js"),
  )) {
    const source = readFileSync(path, "utf8");
    let modules: Record<string, unknown>;
    try {
      modules = moduleTableOf(path, source);
    } catch {
      unreadable.push(relative(serverDirectory, path));
      continue;
    }
    const lineStarts = [0];
    for (
      let at = source.indexOf("\n");
      at !== -1;
      at = source.indexOf("\n", at + 1)
    ) {
      lineStarts.push(at + 1);
    }
    const found: ModuleSpan[] = [];
    for (const [id, factory] of Object.entries(modules)) {
      const text = String(factory);
      const start = source.indexOf(text);
      if (start !== -1) found.push({ id, start, end: start + text.length });
      factories.set(id, [...(factories.get(id) ?? []), text]);
    }
    spans.set(path, { lineStarts, spans: found });
  }
  return {
    idsCarrying(marker) {
      return [...factories]
        .filter(([, texts]) => texts.some((text) => text.includes(marker)))
        .map(([id]) => id)
        .sort();
    },
    moduleAt(file, line, column) {
      const entry = spans.get(
        file.startsWith("file://") ? fileURLToPath(file) : file,
      );
      if (entry === undefined) return undefined;
      const offset = (entry.lineStarts[line - 1] ?? Number.NaN) + column - 1;
      return entry.spans.find(
        (span) => offset >= span.start && offset < span.end,
      )?.id;
    },
    unreadable,
  };
}
