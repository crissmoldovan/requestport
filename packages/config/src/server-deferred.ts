import { type ParsedServerEnv, parseServerEnv } from "./server-schema.js";

/**
 * The same configuration, parsed the first time something reads it.
 *
 * `./server.ts` parses as it is imported, which is what makes a missing
 * variable a refusal to start. That is right for a server and wrong for a
 * bundler: deploying the Trigger worker discovers its tasks by importing every
 * module, so importing that one asked a build to hold `DATABASE_URL`,
 * `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_SECRET` and `RESEND_API_KEY`. A build
 * has no business holding any of them, and the deploy failed rather than be
 * given them.
 *
 * This is a separate module rather than another export from `./server.ts`
 * because an import runs the whole module: naming a lazy export from a module
 * that parses eagerly still parses eagerly. The split is the entire mechanism.
 *
 * Nothing about the validation changes — the same schema, the same refusal, the
 * same message — only when it happens: for a task, the moment it runs; for a
 * build, never.
 *
 * A proxy rather than a getter per field because the parsed shape differs
 * between the preview and the ordinary environment, and a list of fields
 * written here would be a third spelling of a schema that already has two.
 */
let parsed: ParsedServerEnv | undefined;

function read(): ParsedServerEnv {
  parsed ??= parseServerEnv(process.env);

  return parsed;
}

export const serverEnv: ParsedServerEnv = new Proxy({} as ParsedServerEnv, {
  get: (_target, key) => read()[key as keyof ParsedServerEnv],
  has: (_target, key) => key in read(),
  ownKeys: () => Reflect.ownKeys(read()),
  getOwnPropertyDescriptor: (_target, key) =>
    Reflect.getOwnPropertyDescriptor(read(), key),

  // Writing through this proxy would define the property on the empty target
  // with a partial descriptor — non-writable and non-configurable — and every
  // later read of that name would throw an invariant error about a value the
  // trap did not return. Permanent, for the life of the process, and utterly
  // opaque. The configuration is read, never assigned; saying so is kinder than
  // the TypeError that would otherwise arrive much later and elsewhere.
  defineProperty: (_target, key) => {
    throw new TypeError(
      `The server configuration is read-only: cannot define ${String(key)}.`,
    );
  },
  deleteProperty: (_target, key) => {
    throw new TypeError(
      `The server configuration is read-only: cannot delete ${String(key)}.`,
    );
  },
  set: (_target, key) => {
    throw new TypeError(
      `The server configuration is read-only: cannot assign ${String(key)}.`,
    );
  },
});
