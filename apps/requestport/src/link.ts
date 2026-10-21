import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { CredentialStore } from "@requestport/client/credentials";
import {
  findProjectFile,
  isBindableServer,
  PROJECT_DIRECTORY,
  PROJECT_FILE,
  type ProjectBinding,
  ProjectBindingError,
  readProjectBinding,
} from "@requestport/client/project";
import { createTokenSource } from "@requestport/client/token-source";
import { z } from "zod";

import {
  type AgentAuthorizationOptions,
  type AskWhoami,
  type ExpectedProject,
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
import { HOLDING_PROJECT_ID } from "./holding-store.js";
import { legacyNotice, reportable } from "./login.js";
import {
  type McpProject,
  PROJECT_READ_SCOPE,
  projectOverMcp,
} from "./whoami.js";

export const LINK_USAGE = `Usage: requestport link --server <url> [--project <id>] [--no-browser]

Binds this checkout to one RequestPort project: writes
.requestport/project.json in the working directory, naming the server, the
organization, the project and its slug, and no secret, so that it can be
committed. The project is the one the mcp credential on this machine is for,
as whoami over MCP answers. Unless --project, or a binding found here or
above, names a project for which an mcp credential is stored, one is
authorized first, as requestport login does: a URL is printed on stderr and
opened in a browser, and the person consents there.

A binding already found here or in a directory above is never replaced: one
naming another server, or another project than --project, is refused, and
otherwise it is left as it is.

Options:
  --server <url>   The RequestPort server: https, or http on this machine,
                   with no path.
  --project <id>   The project to bind: a grant for another is refused, and
                   nothing is stored or written. Unless given, the project
                   of the binding found here or above; with neither, the
                   project chosen at consent.
  --no-browser     Prints the URL and opens nothing.
  --help           Prints this text.

Environment:
  ${CREDENTIAL_STORE_VARIABLE}  file or keychain; unset, the keychain where
                                macOS has one, and the file elsewhere.
  REQUESTPORT_NO_BROWSER        Set, the same as --no-browser.`;

/** A mistake in what was typed. Its message never repeats a value. */
class UsageError extends Error {}

/** Why `link` stopped. Its message names no secret. */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

interface LinkArguments {
  readonly noBrowser: boolean;
  readonly project?: string;
  readonly server: string;
}

const VALUE_OPTIONS = ["--server", "--project"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

function isValueOption(name: string): name is ValueOption {
  return (VALUE_OPTIONS as readonly string[]).includes(name);
}

/**
 * The options, read by hand as `login`'s are: a refusal names only options
 * this command defines, never what was typed.
 */
export function parseLinkArguments(
  argv: readonly string[],
): LinkArguments | "help" {
  const values: Partial<Record<ValueOption, string>> = {};
  let noBrowser = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--no-browser") {
      noBrowser = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!isValueOption(name)) {
      throw new UsageError(
        argument.startsWith("-")
          ? "unknown option."
          : "link takes options only, and no argument.",
      );
    }
    if (values[name] !== undefined) {
      throw new UsageError(`${name} is given more than once.`);
    }
    let value: string | undefined;
    if (equals === -1) {
      index += 1;
      value = argv[index];
    } else {
      value = argument.slice(equals + 1);
    }
    if (value === undefined || value === "") {
      throw new UsageError(`${name} needs a value.`);
    }
    values[name] = value;
  }

  const server = values["--server"];
  if (server === undefined) {
    throw new UsageError("--server is required.");
  }
  if (!isBindableServer(server)) {
    throw new UsageError(
      "--server must be an https URL, or http on this machine, with no path, user name, password, query or fragment.",
    );
  }
  const project = values["--project"];
  if (project !== undefined && !z.uuid().safeParse(project).success) {
    throw new UsageError("--project must be a project id, which is a UUID.");
  }

  return {
    noBrowser,
    ...(project === undefined ? {} : { project: project.toLowerCase() }),
    server: new URL(server).origin,
  };
}

export interface LinkOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface LinkDependencies {
  /** Where the binding is looked for and written; the process's working directory. */
  readonly cwd?: string;
  readonly output?: LinkOutput;
  /** The browser; `browserOpenerFor`'s unless given, `null` for none. */
  readonly openBrowser?: BrowserOpener | null;
  /** The credential store; `commandCredentialStore(env)` unless given. */
  readonly store?: CredentialStore;
  /**
   * The lock directory of the token source over a credential already
   * stored; `commandLockDirectory(env)` unless given.
   */
  readonly lockDirectory?: string;
  /** Passed to the authorization: `fetch`, the receiver, its temporary directory. */
  readonly authorization?: Pick<
    AgentAuthorizationOptions,
    "fetch" | "startCallbackReceiver" | "temporaryDirectory"
  >;
  /**
   * For tests: called with the temporary file's path once it is written and
   * synced, before it is renamed over the binding's path.
   */
  readonly beforeRename?: (temporary: string) => void;
}

const processOutput: LinkOutput = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

/** An error's `code` when it is an errno name, for a message. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z]{1,20}$/u.test(code)
    ? ` (${code})`
    : "";
}

function sameBinding(a: ProjectBinding, b: ProjectBinding): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.projectId === b.projectId &&
    a.projectSlug === b.projectSlug &&
    a.server === b.server
  );
}

/**
 * Writes `<cwd>/.requestport/project.json` whole: to a temporary file beside
 * it, created exclusively, written and synced, then renamed over the path,
 * so a reader finds no file or the whole of it. Then it is read back through
 * `readProjectBinding` from `cwd`, and must be the file found and say what
 * was written. A write or read back that fails removes what this wrote: the
 * temporary file, the binding, and `.requestport` when this made it.
 *
 * The caller has looked for a binding first and found none. Nothing locks
 * the checkout between that look and the rename, so a binding written there
 * meanwhile by another process would be replaced.
 */
function writeBinding(
  cwd: string,
  binding: ProjectBinding,
  beforeRename?: (temporary: string) => void,
): string {
  const directory = join(cwd, PROJECT_DIRECTORY);
  const path = join(directory, PROJECT_FILE);
  const madeDirectory = !existsSync(directory);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const removeDirectory = () => {
    if (!madeDirectory) return;
    try {
      rmdirSync(directory);
    } catch {
      // Not empty: something else is in it now, and it is left.
    }
  };

  try {
    mkdirSync(directory, { recursive: true });
    const descriptor = openSync(temporary, "wx");
    try {
      writeFileSync(descriptor, `${JSON.stringify(binding, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    beforeRename?.(temporary);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    removeDirectory();
    throw new LinkError(
      `Could not write ${path}${codeOf(error)}. The binding was not written.`,
    );
  }

  try {
    const read = readProjectBinding(cwd);
    if (findProjectFile(cwd) !== path || !sameBinding(read, binding)) {
      throw new LinkError(
        `${path} did not read back as it was written, so it was removed. The binding was not written.`,
      );
    }
  } catch (error) {
    rmSync(path, { force: true });
    removeDirectory();
    if (error instanceof ProjectBindingError) {
      throw new LinkError(
        `${error.message} It was removed; the binding was not written.`,
      );
    }
    throw error;
  }
  return path;
}

/**
 * `requestport link` (manifest-h.md §2.8.4): the mcp credential for the
 * project, stored already or authorized now through `login`'s holding-store
 * flow; `whoami` over MCP, and `list_projects` for the project's slug, which
 * the binding requires (track-h.md, H.6's survey, question 3); then
 * `.requestport/project.json` written in the working directory and read
 * back. A binding found here or above is never replaced: one naming another
 * server, or another project than `--project`, is refused naming both before
 * anything else is done; one naming this server and project is left as it
 * is (question 4).
 *
 * Exit codes: 0 bound (written now, or left as it was), 1 not, 2 a usage
 * error.
 */
export async function runLink(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: LinkDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? processOutput;

  let parsed: LinkArguments | "help";
  let store: CredentialStore;
  try {
    parsed = parseLinkArguments(argv);
    if (parsed === "help") {
      output.stdout(`${LINK_USAGE}\n`);
      return 0;
    }
    store = dependencies.store ?? commandCredentialStore(env);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof CredentialStoreChoiceError
    ) {
      output.stderr(`requestport link: ${error.message}\n\n${LINK_USAGE}\n`);
      return 2;
    }
    throw error;
  }

  const { server } = parsed;
  const fetch = dependencies.authorization?.fetch;
  const withFetch = fetch === undefined ? {} : { fetch };

  try {
    const cwd = resolve(dependencies.cwd ?? process.cwd());
    const found = findProjectFile(cwd);
    const binding = found === undefined ? undefined : readProjectBinding(cwd);

    let expected: ExpectedProject | undefined;
    if (binding !== undefined) {
      const boundServer = new URL(binding.server).origin;
      const boundProject = binding.projectId.toLowerCase();
      if (boundServer !== server) {
        throw new LinkError(
          `${found} binds this checkout to project ${boundProject} on ${boundServer}, but --server names ${server}. Nothing was stored, and nothing was written.`,
        );
      }
      if (parsed.project !== undefined && parsed.project !== boundProject) {
        throw new LinkError(
          `${found} binds this checkout to project ${boundProject}, but --project names project ${parsed.project}. Nothing was stored, and nothing was written.`,
        );
      }
      expected = {
        namedBy: `this checkout's binding (${found})`,
        projectId: boundProject,
      };
    } else if (parsed.project !== undefined) {
      expected = { namedBy: "--project", projectId: parsed.project };
    }

    let project: McpProject & { readonly projectId: string };
    if (
      expected !== undefined &&
      store.read(server, expected.projectId, "mcp") !== undefined
    ) {
      // Stored already: no consent. Its token source refreshes it, under the
      // same lock as every other command's on this machine.
      const asked = await projectOverMcp({
        ...withFetch,
        server,
        tokens: createTokenSource({
          audience: "mcp",
          ...withFetch,
          lockDirectory:
            dependencies.lockDirectory ?? commandLockDirectory(env),
          projectId: expected.projectId,
          server,
          store,
        }),
      });
      if (asked.projectId !== expected.projectId) {
        throw new LinkError(
          asked.projectId === null
            ? `The mcp credential stored for project ${expected.projectId} on ${server} names no project, by whoami. Nothing was written.`
            : `The mcp credential stored for project ${expected.projectId} on ${server} is for project ${asked.projectId}, by whoami, but ${expected.namedBy} names project ${expected.projectId}. Nothing was written.`,
        );
      }
      project = { ...asked, projectId: asked.projectId };
      output.stdout(
        `Using the mcp credential stored for project ${project.projectId} (organization ${project.organizationId}) on ${server}.\n`,
      );
    } else {
      project = await authorizeForLink({
        dependencies,
        env,
        expected,
        noBrowser: parsed.noBrowser,
        output,
        server,
        store,
      });
    }

    if (project.projectSlug === undefined) {
      throw new LinkError(
        `The mcp grant does not carry the ${PROJECT_READ_SCOPE} scope, which link needs to read the project's slug (list_projects). Nothing was written.`,
      );
    }

    if (binding !== undefined) {
      output.stdout(
        `${found} already binds this checkout to project ${binding.projectId} (${binding.projectSlug}) on ${server}; it is left as it is.\n`,
      );
      return 0;
    }

    const path = writeBinding(
      cwd,
      {
        organizationId: project.organizationId,
        projectId: project.projectId,
        projectSlug: project.projectSlug,
        server,
      },
      dependencies.beforeRename,
    );
    output.stdout(
      `Wrote ${path}: this checkout is bound to project ${project.projectId} (${project.projectSlug}) of organization ${project.organizationId} on ${server}.\n`,
    );
    return 0;
  } catch (error) {
    output.stderr(
      `requestport link: ${
        error instanceof LinkError
          ? error.message
          : reportable(error, "the link did not complete")
      }\n`,
    );
    return 1;
  }
}

/**
 * `login`'s holding-store flow for `mcp`, its `whoami` asked by
 * `projectOverMcp`, so the slug is learned in the same session. The
 * credential is stored only once the grant is for the project expected and
 * carries the scope the slug needs; then it is stored as `login` stores it.
 */
async function authorizeForLink(input: {
  readonly dependencies: LinkDependencies;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly expected: ExpectedProject | undefined;
  readonly noBrowser: boolean;
  readonly output: LinkOutput;
  readonly server: string;
  readonly store: CredentialStore;
}): Promise<McpProject & { readonly projectId: string }> {
  const { dependencies, expected, output, server, store } = input;

  let noticed = false;
  if (
    expected !== undefined &&
    store.hasLegacyRecord(server, expected.projectId)
  ) {
    output.stderr(
      legacyNotice(expected.projectId, server, "authorizing again", "link"),
    );
    noticed = true;
  }

  let learned: McpProject | undefined;
  const whoami: AskWhoami = async (asked) => {
    const withFetch = asked.fetch === undefined ? {} : { fetch: asked.fetch };
    learned = await projectOverMcp({
      ...withFetch,
      server: asked.server,
      tokens: createTokenSource({
        audience: "mcp",
        ...withFetch,
        lockDirectory: asked.lockDirectory,
        projectId: HOLDING_PROJECT_ID,
        server: asked.server,
        store: asked.holding,
      }),
    });
    return {
      organizationId: learned.organizationId,
      projectId: learned.projectId,
    };
  };

  const openBrowser =
    dependencies.openBrowser === null
      ? undefined
      : (dependencies.openBrowser ??
        browserOpenerFor(input.env, input.noBrowser));
  const held = await obtainAuthorization({
    ...dependencies.authorization,
    audience: "mcp",
    ...(expected === undefined ? {} : { expected }),
    onAuthorizationUrl: (url) => {
      output.stderr(
        `requestport link: to authorize the mcp credential, open this URL in a browser:\n\n  ${url}\n\n`,
      );
    },
    ...(openBrowser === undefined ? {} : { openBrowser }),
    server,
    whoami,
  });

  // `obtainAuthorization` returned, so `whoami` ran and named a project.
  const project = learned as McpProject;
  if (project.projectSlug === undefined) {
    throw new LinkError(
      `The mcp grant does not carry the ${PROJECT_READ_SCOPE} scope, which link needs to read the project's slug (list_projects). Nothing was stored, and nothing was written.`,
    );
  }

  const { organizationId, projectId } = held.identity;
  if (!noticed && store.hasLegacyRecord(server, projectId)) {
    output.stderr(legacyNotice(projectId, server, "it is replaced", "link"));
  }
  storeAuthorization(held, store);
  output.stdout(
    `Stored the mcp credential for project ${projectId} (organization ${organizationId}) on ${server}.\n`,
  );
  return { ...project, projectId };
}
