#!/usr/bin/env node
/*
  H.8's agent (manifest-h.md §5, Done when 14; ruling 198): an agent's MCP
  client of `requestport mcp`, started as the README's MCP configuration
  says, and the packed `@requestport/client`'s HTTP client. It is run only in
  H.8's clean container, as `node /harness/agent.mjs`, from the one ESM file
  the harness bundles from this file and the `@modelcontextprotocol/client`
  that `apps/requestport` resolves (`stageCleanHarness`), so the container
  installs nothing for it. The unit file imports its functions on the host
  and gives `serve` stand-ins; no bridge starts there.

  Usage, in the clean container: node /harness/agent.mjs

  It reads one JSON command from standard input, to its end, and answers with
  one JSON line on standard output: `{ ok: true, command, result, bridges }`,
  or `{ ok: false, command, step, error, bridges }`, whose `error` begins
  `agent: <step>:`. The step is the command's name, or `protocol` for input
  that is not a command. `bridges` holds what each bridge the command started
  did: when it started and connected (milliseconds after the command began),
  when its client closed, its pid, its standard error, and any error its
  transport or its client reported. Every console method writes to standard
  error, so standard output carries the answer only.

  The commands:
  - `load` {}: loads the MCP client and answers that it holds `Client` and
    `StdioClientTransport`.
  - `file` { cwd, configuration, title, descriptionMd, targetProjectId,
    timeoutMs }: one bridge, started as the MCP configuration at
    `configuration` says, in `cwd`; `create_request_draft` with the agent
    journey's arguments (`apps/web/tests/e2e/agent-journey.spec.ts`), then
    `submit_request` with the draft's version; then the client closes, which
    ends the bridge's standard input.
  - `whoami` { cwd, configuration, bridges, timeoutMs }: that many bridges,
    each connected without waiting for another, each asked `whoami`; then each
    client closes.
  - `http` { server, projectId, requestId }: the packed `@requestport/client`
    in the one npx directory under `$HOME/.npm/_npx`, its `./http` and
    `./credentials` files read from its manifest's `exports` (they are
    import-only), `createRequestPortHttpClient` over the file store in `HOME`:
    `whoami()`, then `query("requests/<requestId>")`.
  - `credentials` { server, projectId }: what `$HOME/.requestport/credentials.json`
    holds for that project on that server, each audience's client id and
    refresh token given as SHA-256 digests only, and the lock files present
    under `$HOME/.requestport`.

  Each bridge is spawned with the SDK's default environment
  (`getDefaultEnvironment`) and the `npm_config_*` variables of this process's
  environment (`bridgeEnvironment`), so the bridge's npm logs its requests as
  the README lines' npm does in the same container. No answer carries a
  refresh token or an access token: this file reads refresh tokens only to
  digest them, and the packed client and the bridges keep their access tokens
  to themselves.
*/

import { Console } from "node:console";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Each command's fields, beside `command`. */
export const AGENT_COMMANDS = Object.freeze({
  load: [],
  file: [
    "cwd",
    "configuration",
    "title",
    "descriptionMd",
    "targetProjectId",
    "timeoutMs",
  ],
  whoami: ["cwd", "configuration", "bridges", "timeoutMs"],
  http: ["server", "projectId", "requestId"],
  credentials: ["server", "projectId"],
});

const NUMBER_FIELDS = new Set(["bridges", "timeoutMs"]);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Standard input, as a command, or a refusal saying why. */
export function parseAgentCommand(text) {
  let command;

  try {
    command = JSON.parse(text);
  } catch {
    throw new Error("standard input is not JSON");
  }
  if (!isRecord(command)) {
    throw new Error("standard input is not one JSON object");
  }

  const fields = Object.hasOwn(AGENT_COMMANDS, command.command)
    ? AGENT_COMMANDS[command.command]
    : undefined;

  if (fields === undefined) {
    throw new Error(`no command is named ${JSON.stringify(command.command)}`);
  }

  const expected = new Set(["command", ...fields]);

  for (const key of Object.keys(command)) {
    if (!expected.has(key)) {
      throw new Error(`${command.command} takes no field ${key}`);
    }
  }
  for (const key of fields) {
    if (!Object.hasOwn(command, key)) {
      throw new Error(`${command.command} needs ${key}`);
    }
    if (NUMBER_FIELDS.has(key)) {
      if (!Number.isInteger(command[key]) || command[key] <= 0) {
        throw new Error(
          `${command.command}'s ${key} is not a positive whole number`,
        );
      }
    } else if (typeof command[key] !== "string" || command[key] === "") {
      throw new Error(`${command.command}'s ${key} is not a non-empty string`);
    }
  }

  return command;
}

/**
 * The one server an MCP configuration names, `requestport`, as `{ command,
 * args }`: the README's configuration has exactly those two keys.
 */
export function serverOf(text) {
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the MCP configuration is not JSON");
  }

  const servers = isRecord(parsed?.mcpServers) ? parsed.mcpServers : {};
  const names = Object.keys(servers);

  if (names.length !== 1 || names[0] !== "requestport") {
    throw new Error(
      `the MCP configuration names the servers ${JSON.stringify(names)}, not requestport alone`,
    );
  }

  const server = servers.requestport;
  const keys = isRecord(server) ? Object.keys(server).sort() : [];

  if (
    keys.join(",") !== "args,command" ||
    typeof server.command !== "string" ||
    server.command === "" ||
    !Array.isArray(server.args) ||
    !server.args.every((argument) => typeof argument === "string")
  ) {
    throw new Error(
      "the MCP configuration's requestport server is not { command, args }",
    );
  }

  return { command: server.command, args: [...server.args] };
}

/** The variables a bridge gets beside the SDK's default environment. */
export function bridgeEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        /^npm_config_/iu.test(name) && typeof value === "string",
    ),
  );
}

/** A tool's structured answer, or a refusal naming the tool. */
async function callTool(client, name, args, timeoutMs) {
  const answer = await client.callTool(
    { name, arguments: args },
    { timeout: timeoutMs },
  );

  if (answer?.isError === true) {
    const text =
      answer.content?.find((part) => part?.type === "text")?.text ?? "";

    throw new Error(`${name} was refused: ${String(text).slice(0, 300)}`);
  }
  if (!isRecord(answer?.structuredContent)) {
    throw new Error(`${name} answered no structured content`);
  }

  return answer.structuredContent;
}

const messageOf = (error) =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")[0]
    .trim();

/**
 * One bridge: an MCP client of the server the configuration names, over
 * stdio, in `cwd`. `record` is what the answer reports of it.
 */
export function openBridge({ mcp, server, cwd, env, began }) {
  const transport = new mcp.StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd,
    env,
    stderr: "pipe",
  });
  const client = new mcp.Client({ name: "h8-agent", version: "1.0.0" });
  const record = { stderr: "", transportErrors: [] };
  const since = () => Date.now() - began;

  transport.stderr?.on("data", (chunk) => {
    record.stderr += chunk;
  });
  // The client keeps a handler set before it connects, and calls it too.
  transport.onerror = (error) => {
    record.transportErrors.push(messageOf(error));
  };

  return {
    record,
    async connect(timeoutMs) {
      record.startedMs = since();
      try {
        await client.connect(transport, { timeout: timeoutMs });
        record.connectedMs = since();
      } catch (error) {
        record.error = `connect: ${messageOf(error)}`;
        throw error;
      } finally {
        record.pid = transport.pid ?? null;
      }
    },
    async call(name, args, timeoutMs) {
      try {
        return await callTool(client, name, args, timeoutMs);
      } catch (error) {
        record.error = `${name}: ${messageOf(error)}`;
        throw error;
      }
    },
    /** Closes the client, which ends the bridge's standard input; never throws. */
    async close() {
      try {
        await client.close();
      } catch (error) {
        record.closeError = messageOf(error);
      }
      record.closedMs = since();
    },
  };
}

/** The fields of a request a command answered that the harness compares. */
const requestOf = (value) =>
  isRecord(value)
    ? {
        id: value.id,
        state: value.state,
        version: value.version,
      }
    : value;

/** The one directory npx installed into, under `home`. */
export function npxDirectoryOf(home) {
  const parent = join(home, ".npm", "_npx");
  const found = existsSync(parent)
    ? readdirSync(parent, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      )
    : [];

  if (found.length !== 1) {
    throw new Error(
      `${parent} holds ${found.length} npx directories; one was expected`,
    );
  }

  return join(parent, found[0].name);
}

/**
 * The files a package's manifest exports for `subpaths`, under the `import`
 * condition (a packed `@requestport/client` export has `types` and `import`
 * only), each refused unless it stays inside the package.
 */
export function packedExports(packageDirectory, subpaths) {
  const manifest = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  );
  const files = {};

  for (const subpath of subpaths) {
    const entry = manifest.exports?.[subpath];

    if (!isRecord(entry) || typeof entry.import !== "string") {
      throw new Error(
        `${manifest.name} exports no ${subpath} under the import condition`,
      );
    }

    const file = join(packageDirectory, entry.import);
    const inside = relative(packageDirectory, file);

    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`${manifest.name}'s ${subpath} leaves the package`);
    }
    files[subpath] = file;
  }

  return { name: manifest.name, version: manifest.version, files };
}

const sha256 = (value) =>
  typeof value === "string"
    ? createHash("sha256").update(value).digest("hex")
    : null;

/**
 * What a credential file holds for one project on one server: for each
 * audience stored, the client id's and the refresh token's SHA-256, and the
 * record's other fields, none of which is secret. A file that is not JSON is
 * refused without repeating any of it.
 */
export function credentialDigests(text, server, projectId) {
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "credentials.json is not valid JSON (nothing of it is repeated)",
    );
  }

  const records = parsed?.[server]?.[projectId];
  const digests = {};

  for (const audience of ["mcp", "api"]) {
    const record = records?.[audience];

    if (!isRecord(record)) continue;
    digests[audience] = {
      clientIdSha256: sha256(record.clientId),
      refreshTokenSha256: sha256(record.refreshToken),
      obtained: record.obtained ?? null,
      resource: record.resource ?? null,
      version: record.version ?? null,
    };
  }

  return digests;
}

/** The steps, each `(context, command) => result`. */
export const STEPS = Object.freeze({
  async load(context) {
    const mcp = await context.mcp();

    return {
      node: process.version,
      client: typeof mcp.Client === "function",
      stdioTransport: typeof mcp.StdioClientTransport === "function",
    };
  },

  async file(
    context,
    { cwd, configuration, title, descriptionMd, targetProjectId, timeoutMs },
  ) {
    const server = serverOf(context.readFile(configuration));
    const bridge = await context.bridge({ server, cwd });

    try {
      await bridge.connect(timeoutMs);

      const drafted = (
        await bridge.call(
          "create_request_draft",
          {
            descriptionMd,
            expectedVersion: 0,
            idempotencyKey: randomUUID(),
            targetProjectId,
            title,
            type: "feature",
          },
          timeoutMs,
        )
      ).result;

      if (
        !isRecord(drafted) ||
        typeof drafted.id !== "string" ||
        !Number.isInteger(drafted.version)
      ) {
        throw new Error(
          `create_request_draft answered no request: ${JSON.stringify(drafted)?.slice(0, 200)}`,
        );
      }

      const submitted = (
        await bridge.call(
          "submit_request",
          {
            expectedVersion: drafted.version,
            idempotencyKey: randomUUID(),
            requestId: drafted.id,
          },
          timeoutMs,
        )
      ).result;

      return {
        server,
        draft: requestOf(drafted),
        submitted: requestOf(submitted),
      };
    } finally {
      await bridge.close();
    }
  },

  async whoami(context, { cwd, configuration, bridges, timeoutMs }) {
    const server = serverOf(context.readFile(configuration));
    const opened = [];

    for (let index = 0; index < bridges; index += 1) {
      opened.push(await context.bridge({ server, cwd }));
    }

    // Every bridge is started before any is awaited: they run at once.
    const settled = await Promise.allSettled(
      opened.map(async (bridge) => {
        await bridge.connect(timeoutMs);

        const who = await bridge.call("whoami", {}, timeoutMs);

        return {
          organizationId: who.organizationId ?? null,
          projectId: who.projectId ?? null,
          audience: who.audience ?? null,
        };
      }),
    );

    await Promise.all(opened.map((bridge) => bridge.close()));

    const failed = settled
      .map((outcome, index) => ({ outcome, index }))
      .filter(({ outcome }) => outcome.status === "rejected");

    if (failed.length > 0) {
      throw new Error(
        failed
          .map(
            ({ outcome, index }) =>
              `bridge ${index + 1}: ${messageOf(outcome.reason)}`,
          )
          .join("; "),
      );
    }

    return {
      server,
      whoami: settled.map(({ value }) => value),
    };
  },

  async http(context, { server, projectId, requestId }) {
    const directory = npxDirectoryOf(context.home);
    const packed = packedExports(
      join(directory, "node_modules", "@requestport", "client"),
      ["./http", "./credentials"],
    );
    const http = await context.importFile(packed.files["./http"]);
    const credentials = await context.importFile(packed.files["./credentials"]);
    const client = http.createRequestPortHttpClient({
      server,
      projectId,
      store: credentials.createFileStore({ home: context.home }),
    });
    const who = await client.whoami();
    const request = await client.query(`requests/${requestId}`);

    return {
      npxDirectory: directory,
      client: { name: packed.name, version: packed.version },
      exports: Object.fromEntries(
        Object.entries(packed.files).map(([subpath, file]) => [
          subpath,
          relative(directory, file),
        ]),
      ),
      whoami: {
        organizationId: who?.organizationId ?? null,
        projectId: who?.projectId ?? null,
        audience: who?.audience ?? null,
      },
      request: isRecord(request)
        ? {
            id: request.id,
            title: request.title,
            state: request.state,
            type: request.type,
            targetProjectId: request.targetProjectId,
          }
        : request,
    };
  },

  async credentials(context, { server, projectId }) {
    const directory = join(context.home, ".requestport");
    const path = join(directory, "credentials.json");
    const locks = join(directory, "locks");

    return {
      audiences: existsSync(path)
        ? credentialDigests(context.readFile(path), server, projectId)
        : {},
      locks: existsSync(locks) ? readdirSync(locks).sort() : [],
      fileLock: existsSync(join(directory, "credentials.json.lock")),
    };
  },
});

/** The MCP client this file is bundled with, loaded when a step needs it. */
async function loadMcpClient() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ]);

  return { Client, StdioClientTransport };
}

/**
 * Reads one command from `input` and writes one answer to `output`; answers
 * the exit code. `mcp` loads the MCP client, `environment` is the one each
 * bridge's `npm_config_*` variables come from, `home` is `HOME`, and
 * `importFile` imports a file by its path.
 */
export async function serve({
  input,
  output,
  steps = STEPS,
  mcp = loadMcpClient,
  environment = process.env,
  home = homedir(),
  importFile = (path) => import(pathToFileURL(path).href),
}) {
  const write = (answer) => output.write(`${JSON.stringify(answer)}\n`);
  let text = "";

  for await (const chunk of input) text += chunk;

  let command;

  try {
    command = parseAgentCommand(text);
  } catch (error) {
    write({
      ok: false,
      command: null,
      step: "protocol",
      error: `agent: protocol: ${messageOf(error)}`,
      bridges: [],
    });
    return 1;
  }

  const began = Date.now();
  const bridges = [];
  let loaded;
  const context = {
    home,
    importFile,
    readFile: (path) => readFileSync(path, "utf8"),
    mcp: () => {
      loaded ??= mcp();
      return loaded;
    },
    bridge: async ({ server, cwd }) => {
      const opened = openBridge({
        mcp: await context.mcp(),
        server,
        cwd,
        env: bridgeEnvironment(environment),
        began,
      });

      bridges.push(opened.record);
      return opened;
    },
  };

  try {
    const result = await steps[command.command](context, command);

    write({ ok: true, command: command.command, result, bridges });
    return 0;
  } catch (error) {
    write({
      ok: false,
      command: command.command,
      step: command.command,
      error: `agent: ${command.command}: ${messageOf(error)}`,
      bridges,
    });
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The MCP client's own code may log; none of it may reach standard output.
  globalThis.console = new Console({
    stdout: process.stderr,
    stderr: process.stderr,
  });
  process.exitCode = await serve({
    input: process.stdin,
    output: process.stdout,
  });
  // A handle something left open must not keep the answer's process alive.
  setTimeout(() => process.exit(), 10_000).unref();
}
