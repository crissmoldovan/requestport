import { Console } from "node:console";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  CI_CREDENTIAL_VARIABLE,
  readCiCredential,
} from "@requestport/client/ci";
import {
  type CredentialStore,
  resourceFor,
} from "@requestport/client/credentials";
import type { FetchLike } from "@requestport/client/oauth";
import {
  findProjectFile,
  type ProjectBinding,
} from "@requestport/client/project";
import {
  resolveConnection,
  verifyConnection,
} from "@requestport/client/resolve";
import {
  AuthorizationRequiredError,
  createTokenSource,
  LockTimeoutError,
  TokenRefreshError,
  type TokenSource,
} from "@requestport/client/token-source";

import {
  type AgentAuthorizationOptions,
  obtainAuthorization,
  storeAuthorization,
} from "./agent-authorization.js";
import { type BrowserOpener, browserOpenerFor } from "./browser.js";
import {
  CREDENTIAL_STORE_VARIABLE,
  CredentialStoreChoiceError,
  commandCredentialStore,
  commandLockDirectory,
} from "./credential-store.js";
import { legacyNotice, reportable } from "./login.js";
import { failureOf, whoamiOverMcp } from "./whoami.js";

export const MCP_USAGE = `Usage: requestport mcp [--no-browser]

Serves the Model Context Protocol to an agent on stdin and stdout, and
forwards every message to the RequestPort server this checkout's binding
(.requestport/project.json) names, at <server>/mcp, with a bearer token from
the mcp credential stored on this machine for the binding's project. stdout
carries the protocol and nothing else; this text and every notice go to
stderr.

Before it reads stdin it asks whoami over MCP, and it refuses a credential
for another project than the binding's. With no mcp credential stored for
that project, one is authorized first, as requestport login does: a URL is
printed on stderr and opened in a browser, and the person consents there.
An agent's client waits about a minute for its first answer, so running
requestport login first is the surer way.

It exits when stdin closes.

Options:
  --no-browser     Prints the URL and opens nothing.
  --help           Prints this text, on stderr.

Environment:
  ${CREDENTIAL_STORE_VARIABLE}  file or keychain; unset, the keychain where
                                macOS has one, and the file elsewhere.
  REQUESTPORT_NO_BROWSER        Set, the same as --no-browser.
  ${CI_CREDENTIAL_VARIABLE}       Set and not blank, its value, trimmed, is the
                                bearer token: no credential is read, stored,
                                refreshed or authorized.`;

/**
 * The JSON-RPC error code of a request the bridge could not forward: the
 * token source gave no token, or the server could not be reached, refused,
 * or failed. It is in the range JSON-RPC 2.0 leaves to the implementation
 * (-32000 to -32099).
 */
export const UPSTREAM_FAILED = -32_000;

/** A mistake in what was typed. Its message never repeats a value. */
class UsageError extends Error {}

/** Why the bridge did not start serving. Its message names no secret. */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

interface McpArguments {
  readonly noBrowser: boolean;
}

export function parseMcpArguments(
  argv: readonly string[],
): McpArguments | "help" {
  let noBrowser = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--no-browser") {
      noBrowser = true;
      continue;
    }
    throw new UsageError(
      argument.startsWith("-")
        ? "unknown option."
        : "mcp takes options only, and no argument.",
    );
  }
  return { noBrowser };
}

export interface McpBridgeDependencies {
  /** Where the binding is looked for; the process's working directory. */
  readonly cwd?: string;
  /** The protocol's input; the process's stdin unless given. */
  readonly stdin?: Readable;
  /** The protocol's output; the process's stdout unless given. */
  readonly stdout?: Writable;
  /** Everything that is not the protocol; the process's stderr unless given. */
  readonly stderr?: (text: string) => void;
  /** The browser; `browserOpenerFor`'s unless given, `null` for none. */
  readonly openBrowser?: BrowserOpener | null;
  /** The credential store; `commandCredentialStore(env)` unless given. */
  readonly store?: CredentialStore;
  /**
   * The lock directory of the mcp token source over the store;
   * `commandLockDirectory(env)` unless given, the one `link` uses too.
   */
  readonly lockDirectory?: string;
  /** Every request this makes: discovery, refresh, `/mcp`. */
  readonly fetch?: FetchLike;
  /** Passed to an authorization: the receiver, its temporary directory. */
  readonly authorization?: Pick<
    AgentAuthorizationOptions,
    "startCallbackReceiver" | "temporaryDirectory"
  >;
}

/**
 * Sends every `console` method to stderr. `console.log`, `info`, `debug`,
 * `dir`, `table` and others write to stdout, and a line there that is not a
 * JSON-RPC message is one the agent's client cannot read
 * (`@modelcontextprotocol/client`'s own `Client.listPrompts` calls
 * `console.debug`, for one). Answers a function that puts the console back.
 */
function consoleToStderr(): () => void {
  const original = globalThis.console;
  globalThis.console = new Console({
    stderr: process.stderr,
    stdout: process.stderr,
  });
  return () => {
    globalThis.console = original;
  };
}

/**
 * What the relay may put in a JSON-RPC error, or on stderr, about a request
 * it could not forward: the token source's own refusal, as `packages/client`
 * words it with no token in it (authorization required, naming `requestport
 * login --for mcp`; a refresh that did not complete; or the lock it waited
 * for, by path); a 401 to the retry a 401 earned (`retried`), naming the
 * command; or the HTTP status, or that the request did not complete.
 * Neither the server's answer nor the SDK's message is repeated: either may
 * quote what was sent or received.
 */
function forwardFailure(
  error: unknown,
  origin: string,
  retried: { readonly projectId: string } | undefined,
): string {
  if (
    error instanceof AuthorizationRequiredError ||
    error instanceof TokenRefreshError ||
    error instanceof LockTimeoutError
  ) {
    return error.message;
  }
  // Of the requests the relay makes (each message's POST, and the GET of
  // the event stream), the HTTP transport throws an `SdkHttpError` with
  // status 401 only for a 401 to one it retried after `onUnauthorized`; a
  // 401 it did not retry is an `UnauthorizedError`, which `failureOf` names.
  if (
    retried !== undefined &&
    error instanceof SdkHttpError &&
    error.status === 401
  ) {
    return `${origin}/mcp refused the access token of the mcp credential for project ${retried.projectId} (HTTP 401), and refused it again after a fresh refresh. The stored credential is kept. To authorize again, run "requestport login --for mcp".`;
  }
  return `The request could not be forwarded to ${origin}/mcp: ${failureOf(error)}.`;
}

/** The token every request presents, and whose credential it is. */
interface Connected {
  readonly binding: ProjectBinding;
  readonly server: string;
  readonly tokens: TokenSource;
}

/**
 * The credential and the checkout held to one answer before anything is
 * read from stdin: `resolveConnection` with this command's store; an
 * authorization first when it is required, expecting the binding's project;
 * then `whoami` over MCP and `verifyConnection`, which refuses a credential
 * for another project naming both (manifest-h.md §2.8.4).
 */
async function connect(input: {
  readonly cwd: string;
  readonly dependencies: McpBridgeDependencies;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly noBrowser: boolean;
  readonly stderr: (text: string) => void;
  readonly store: CredentialStore;
}): Promise<Connected> {
  const { cwd, dependencies, env, stderr, store } = input;
  const fetch = dependencies.fetch;
  const withFetch = fetch === undefined ? {} : { fetch };

  const connection = resolveConnection({
    environment: env,
    from: cwd,
    store,
  });
  const server = new URL(connection.server).origin;
  const projectId = connection.projectId;
  // login and link store a credential under the binding's project id in lower
  // case, and whoami answers it in lower case. A binding written otherwise
  // would find no credential and then refuse its own grant, so it is refused
  // here, before anything is authorized (track-h.md, H.6's review).
  if (projectId !== projectId.toLowerCase()) {
    throw new BridgeError(
      `${findProjectFile(cwd) ?? "This checkout's binding"} names project ${projectId}, which is not in lower case. requestport login and link store the project id in lower case, so the bridge would find no credential for it. Write the id in lower case in that file, or run "requestport link" again, then start the bridge again.`,
    );
  }

  let tokens: TokenSource;
  const ci = readCiCredential(env);
  if (
    connection.status === "ready" &&
    connection.source === "environment" &&
    ci !== undefined
  ) {
    // The credential CI was handed, presented as it is: nothing is read,
    // stored or refreshed, and a 401 is not retried (track-h.md, H.6's
    // survey, question 11). Its value is never printed.
    const token = ci.accessToken;
    tokens = { accessToken: async () => token };
    stderr(
      `requestport mcp: using the credential supplied by ${CI_CREDENTIAL_VARIABLE}.\n`,
    );
  } else {
    if (connection.status === "authorization-required") {
      await authorizeForBridge({ ...input, projectId, server });
    }
    tokens = createTokenSource({
      audience: "mcp",
      ...withFetch,
      lockDirectory: dependencies.lockDirectory ?? commandLockDirectory(env),
      projectId,
      server,
      store,
    });
  }

  const identity = await whoamiOverMcp({ ...withFetch, server, tokens });
  if (identity.projectId === null) {
    throw new BridgeError(
      `This checkout is bound to project ${projectId} (${connection.binding.projectSlug}), but the mcp credential names no project, by whoami. Refusing rather than filing work against the wrong project.`,
    );
  }
  const binding = verifyConnection({
    from: cwd,
    identity: { projectId: identity.projectId },
  });
  return { binding, server, tokens };
}

/**
 * `login`'s holding-store flow for `mcp`, expecting the binding's project:
 * the URL on stderr and the browser, never stdout; a grant for another
 * project refused naming both, with nothing stored; otherwise stored as
 * `login` stores it.
 */
async function authorizeForBridge(input: {
  readonly cwd: string;
  readonly dependencies: McpBridgeDependencies;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly noBrowser: boolean;
  readonly projectId: string;
  readonly server: string;
  readonly stderr: (text: string) => void;
  readonly store: CredentialStore;
}): Promise<void> {
  const { dependencies, projectId, server, stderr, store } = input;
  if (store.hasLegacyRecord(server, projectId)) {
    stderr(legacyNotice(projectId, server, "authorizing again", "mcp"));
  }
  const openBrowser =
    dependencies.openBrowser === null
      ? undefined
      : (dependencies.openBrowser ??
        browserOpenerFor(input.env, input.noBrowser));
  const held = await obtainAuthorization({
    ...dependencies.authorization,
    audience: "mcp",
    expected: {
      namedBy: `this checkout's binding (${findProjectFile(input.cwd)})`,
      projectId,
    },
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    onAuthorizationUrl: (url) => {
      stderr(
        `requestport mcp: to authorize the mcp credential, open this URL in a browser:\n\n  ${url}\n\n`,
      );
    },
    ...(openBrowser === undefined ? {} : { openBrowser }),
    server,
  });
  storeAuthorization(held, store);
  stderr(
    `requestport mcp: stored the mcp credential for project ${held.identity.projectId} (organization ${held.identity.organizationId}) on ${server}.\n`,
  );
}

/**
 * The relay: `StdioServerTransport` on the protocol's streams, and each
 * message it reads sent on to `<server>/mcp` through
 * `StreamableHTTPClientTransport`, whose `AuthProvider` takes a token from
 * `tokens` before every request; each message the server answers is written
 * back. The `initialize` result's protocol version is set on the HTTP
 * transport, as the SDK's own `Client` does after its handshake, so later
 * requests carry it. A 401 drops the access token the source keeps
 * (`forgetAccessToken`), and the HTTP transport sends the request once more
 * with a token from a refresh (r9-rulings.md, ruling 102). Requests refused
 * while that refresh is under way share it; a 401 that arrives after it
 * ended drops the token it issued too, and costs one more refresh. A source
 * with nothing to refresh, `REQUESTPORT_AGENT_TOKEN`'s, has no
 * `forgetAccessToken`, so its 401 is not retried. A request that could not be
 * forwarded is answered with a JSON-RPC error (`UPSTREAM_FAILED`) that names
 * no token. When stdin closes, the HTTP transport is closed, which aborts any
 * request still in flight, and the relay ends.
 */
function relay(input: {
  readonly fetch?: FetchLike;
  readonly projectId: string;
  readonly server: string;
  readonly stderr: (text: string) => void;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly tokens: TokenSource;
}): Promise<number> {
  const { stderr, tokens } = input;
  const endpoint = new URL(resourceFor(input.server, "mcp"));
  const origin = endpoint.origin;
  const retried =
    tokens.forgetAccessToken === undefined
      ? undefined
      : { projectId: input.projectId };
  const upstream = new StreamableHTTPClientTransport(endpoint, {
    authProvider: {
      token: () => tokens.accessToken(),
      // Awaited by the transport on a 401, which then retries once, and on
      // a second 401 throws rather than calling this again.
      ...(retried === undefined
        ? {}
        : {
            onUnauthorized: async () => {
              tokens.forgetAccessToken?.();
            },
          }),
    },
    ...(input.fetch === undefined
      ? {}
      : { fetch: input.fetch as typeof fetch }),
  });
  const stdio = new StdioServerTransport(input.stdin, input.stdout);
  const initializing = new Set<string | number>();
  let closed = false;

  return new Promise<number>((resolveExit) => {
    const end = () => {
      if (closed) return;
      closed = true;
      upstream
        .close()
        .catch(() => {})
        .finally(() => resolveExit(0));
    };

    stdio.onmessage = (message: JSONRPCMessage) => {
      if (isJSONRPCRequest(message) && message.method === "initialize") {
        initializing.add(message.id);
      }
      upstream.send(message).catch((error: unknown) => {
        if (closed || !isJSONRPCRequest(message)) return;
        stdio
          .send({
            error: {
              code: UPSTREAM_FAILED,
              message: `requestport mcp: ${forwardFailure(error, origin, retried)}`,
            },
            id: message.id,
            jsonrpc: "2.0",
          })
          .catch(() => {});
      });
    };
    upstream.onmessage = (message: JSONRPCMessage) => {
      if (isJSONRPCResultResponse(message) && initializing.delete(message.id)) {
        const version = (message.result as { protocolVersion?: unknown })
          .protocolVersion;
        if (typeof version === "string") upstream.setProtocolVersion(version);
      }
      stdio.send(message).catch(() => {});
    };
    // The HTTP transport reports every failure here as well as to the send
    // that met it; the request's own answer says what failed, so this line
    // is for the person reading stderr, and it too names no token.
    upstream.onerror = (error: Error) => {
      if (closed) return;
      stderr(`requestport mcp: ${forwardFailure(error, origin, retried)}\n`);
    };
    // A line on stdin that is not a JSON-RPC message, or a failed write to
    // stdout. The line itself is not repeated: it may hold anything.
    stdio.onerror = (error: Error) => {
      stderr(
        `requestport mcp: the agent's side of the connection failed (${/^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : "Error"}).\n`,
      );
    };
    stdio.onclose = end;

    upstream
      .start()
      .then(() => stdio.start())
      .catch(() => {
        stderr("requestport mcp: the relay could not start.\n");
        closed = true;
        resolveExit(1);
      });
  });
}

/**
 * `requestport mcp` (manifest-h.md §2.8.4), the stdio bridge: the
 * connection resolved and held to the binding (`connect`), then the relay
 * until stdin closes. Nothing but the protocol is written to stdout: the
 * usage, every notice and every refusal go to stderr, and while the protocol
 * is on this process's stdout, so does `console`.
 *
 * Exit codes: 0 stdin closed after serving, 1 not served, 2 a usage error.
 */
export async function runMcpBridge(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: McpBridgeDependencies = {},
): Promise<number> {
  const stderr =
    dependencies.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });

  let parsed: McpArguments | "help";
  let store: CredentialStore;
  try {
    parsed = parseMcpArguments(argv);
    if (parsed === "help") {
      stderr(`${MCP_USAGE}\n`);
      return 0;
    }
    store = dependencies.store ?? commandCredentialStore(env);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof CredentialStoreChoiceError
    ) {
      stderr(`requestport mcp: ${error.message}\n\n${MCP_USAGE}\n`);
      return 2;
    }
    throw error;
  }

  const stdout = dependencies.stdout ?? process.stdout;
  const restoreConsole =
    stdout === process.stdout ? consoleToStderr() : () => {};
  try {
    const cwd = resolve(dependencies.cwd ?? process.cwd());
    let connected: Connected;
    try {
      if (findProjectFile(cwd) === undefined) {
        throw new BridgeError(
          `No .requestport/project.json found in ${cwd} or any directory above it: run "requestport link --server <url>" in the checkout first.`,
        );
      }
      connected = await connect({
        cwd,
        dependencies,
        env,
        noBrowser: parsed.noBrowser,
        stderr,
        store,
      });
    } catch (error) {
      stderr(
        `requestport mcp: ${
          error instanceof BridgeError
            ? error.message
            : reportable(error, "the bridge did not start")
        }\n`,
      );
      return 1;
    }

    const { binding, server } = connected;
    stderr(
      `requestport mcp: serving project ${binding.projectId} (${binding.projectSlug}) on ${server}.\n`,
    );
    return await relay({
      ...(dependencies.fetch === undefined
        ? {}
        : { fetch: dependencies.fetch }),
      projectId: binding.projectId,
      server,
      stderr,
      stdin: dependencies.stdin ?? process.stdin,
      stdout,
      tokens: connected.tokens,
    });
  } finally {
    restoreConsole();
  }
}
