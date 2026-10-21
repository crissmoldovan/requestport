/**
 * The stdio bridge in a process of its own, for the tests that start more
 * than one at a time or steer one's timing: `runMcpBridge`, the function
 * `cli.ts` runs for `requestport mcp`, on this process's stdin and stdout and
 * with this process's environment, after tsx is registered as
 * `bin/requestport.mjs` registers it.
 *
 *   node bridge-child.mjs <options as JSON>
 *
 * Every option is optional:
 * - `go`: a file to wait for before the bridge starts. `<go>.ready-<pid>` is
 *   written first, once the modules are loaded, so the test can start two
 *   bridges together, as `packages/client`'s two-process tests start their
 *   children.
 * - `answered`: a file written when the first answer of the token endpoint
 *   arrives, before `tokenDelayMs` holds it.
 * - `after`: a file to wait for after `go`: another bridge's `answered`, so
 *   this one starts while that one holds the token it is rotating.
 * - `lockDirectory`: handed to the bridge in place of its own
 *   (`commandLockDirectory`), for the control that gives each bridge a lock
 *   of its own.
 * - `tokenDelayMs`: each answer of the token endpoint reaches the bridge this
 *   much later, so that two refreshes started together overlap.
 * - `tokenLog`: a file that gets one line per refresh request, the SHA-256
 *   of the refresh token it presents (never the token).
 * - `consoleProbe`: `console.log` is called before every request, as a
 *   module that logs would be.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import process from "node:process";

import { register } from "tsx/esm/api";

register();

const options = JSON.parse(process.argv[2] ?? "{}");
const { runMcpBridge } = await import("../mcp-bridge.ts");

const pause = (ms) => new Promise((resume) => setTimeout(resume, ms));
const realFetch = globalThis.fetch;

async function fetch(input, init) {
  const method = init?.method ?? "GET";
  if (options.consoleProbe === true) {
    console.log(`console probe: a ${method} request`);
  }
  const url = new URL(input instanceof Request ? input.url : String(input));
  const token = method === "POST" && url.pathname.endsWith("/oauth2/token");
  if (token && typeof options.tokenLog === "string") {
    const presented = new URLSearchParams(String(init?.body ?? "")).get(
      "refresh_token",
    );
    if (presented !== null) {
      appendFileSync(
        options.tokenLog,
        `${createHash("sha256").update(presented).digest("hex")}\n`,
      );
    }
  }
  const response = await realFetch(input, init);
  if (token && typeof options.answered === "string") {
    writeFileSync(options.answered, "");
  }
  if (token && typeof options.tokenDelayMs === "number") {
    await pause(options.tokenDelayMs);
  }
  return response;
}

if (typeof options.go === "string") {
  writeFileSync(`${options.go}.ready-${process.pid}`, "");
  while (!existsSync(options.go)) await pause(5);
}
if (typeof options.after === "string") {
  while (!existsSync(options.after)) await pause(5);
}

process.exit(
  await runMcpBridge([], process.env, {
    fetch,
    ...(typeof options.lockDirectory === "string"
      ? { lockDirectory: options.lockDirectory }
      : {}),
  }),
);
