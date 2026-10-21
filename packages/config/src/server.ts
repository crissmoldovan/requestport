/**
 * The server's configuration, parsed as this module is imported.
 *
 * Importing this is a declaration that the process cannot run without a valid
 * configuration: a missing variable is a refusal to start rather than a failure
 * halfway through a request. Everything that serves traffic wants that.
 *
 * A build does not. See `./server-deferred.ts` for the reading the Trigger
 * worker uses, and why it needs a module of its own rather than another export
 * from this one.
 */
export * from "./server-schema.js";

import { parseServerEnv } from "./server-schema.js";

export const serverEnv = parseServerEnv(process.env);
