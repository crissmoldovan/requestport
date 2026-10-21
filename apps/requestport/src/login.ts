import { AuthorizationError } from "@requestport/client/authorize";
import { CallbackServerError } from "@requestport/client/callback-server";
import {
  type Audience,
  type CredentialStore,
  CredentialStoreError,
} from "@requestport/client/credentials";
import { RequestPortApiError } from "@requestport/client/http";
import { OAuthError } from "@requestport/client/oauth";
import {
  findProjectFile,
  isBindableServer,
  ProjectBindingError,
  readProjectBinding,
} from "@requestport/client/project";
import {
  AuthorizationRequiredError,
  LockTimeoutError,
  TokenRefreshError,
} from "@requestport/client/token-source";
import { z } from "zod";

import {
  type AgentAuthorizationOptions,
  type ExpectedProject,
  type HeldAuthorization,
  obtainAuthorization,
  ProjectMismatchError,
  storeAuthorization,
} from "./agent-authorization.js";
import { type BrowserOpener, browserOpenerFor } from "./browser.js";
import {
  CREDENTIAL_STORE_VARIABLE,
  CredentialStoreChoiceError,
  commandCredentialStore,
} from "./credential-store.js";
import { WhoamiError } from "./whoami.js";

export const LOGIN_USAGE = `Usage: requestport login [--server <url>] [--project <id>] [--for mcp|api|both] [--no-browser]

Authorizes an agent credential on this machine for one RequestPort project:
prints a URL on stderr, opens it in a browser, and waits while the person
consents there and chooses the project.

Options:
  --server <url>   The RequestPort server: https, or http on this machine,
                   with no path. Unless given, the one this checkout's
                   binding (.requestport/project.json) names.
  --project <id>   The project the grant must be for: a grant for another is
                   refused, and nothing is stored. Unless given, the binding's
                   project, when the binding names this server; with neither,
                   the project chosen at consent.
  --for <which>    mcp (the default), the credential for /mcp; api, the
                   one for /api/v1; or both, one after the other, each with
                   its own consent.
  --no-browser     Prints the URL and opens nothing.
  --help           Prints this text.

Environment:
  ${CREDENTIAL_STORE_VARIABLE}  file or keychain; unset, the keychain where
                                macOS has one, and the file elsewhere.
  REQUESTPORT_NO_BROWSER        Set, the same as --no-browser.`;

/** A mistake in what was typed. Its message never repeats a value. */
class UsageError extends Error {}

type Which = Audience | "both";

interface LoginArguments {
  readonly for: Which;
  readonly noBrowser: boolean;
  readonly project?: string;
  readonly server?: string;
}

const VALUE_OPTIONS = ["--server", "--project", "--for"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

function isValueOption(name: string): name is ValueOption {
  return (VALUE_OPTIONS as readonly string[]).includes(name);
}

/**
 * The options, read by hand rather than by `node:util`'s `parseArgs`, whose
 * refusals quote the option that was typed: anything typed may be a secret
 * pasted in the wrong place, so a refusal names only options this command
 * defines.
 */
export function parseLoginArguments(
  argv: readonly string[],
): LoginArguments | "help" {
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
          : "login takes options only, and no argument.",
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

  const which = values["--for"] ?? "mcp";
  if (which !== "mcp" && which !== "api" && which !== "both") {
    throw new UsageError("--for must be mcp, api or both.");
  }
  const server = values["--server"];
  if (server !== undefined && !isBindableServer(server)) {
    throw new UsageError(
      "--server must be an https URL, or http on this machine, with no path, user name, password, query or fragment.",
    );
  }
  const project = values["--project"];
  if (project !== undefined && !z.uuid().safeParse(project).success) {
    throw new UsageError("--project must be a project id, which is a UUID.");
  }

  return {
    for: which,
    noBrowser,
    ...(project === undefined ? {} : { project: project.toLowerCase() }),
    ...(server === undefined ? {} : { server: new URL(server).origin }),
  };
}

export interface LoginOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface LoginDependencies {
  /** Where the binding is looked for; the process's working directory. */
  readonly cwd?: string;
  readonly output?: LoginOutput;
  /** The browser; `browserOpenerFor`'s unless given, `null` for none. */
  readonly openBrowser?: BrowserOpener | null;
  /** The credential store; `commandCredentialStore(env)` unless given. */
  readonly store?: CredentialStore;
  /** Passed to each authorization: `fetch`, the receiver, `whoami`. */
  readonly authorization?: Pick<
    AgentAuthorizationOptions,
    "fetch" | "startCallbackReceiver" | "temporaryDirectory" | "whoami"
  >;
}

const processOutput: LoginOutput = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

/** The error types whose messages name no secret, by their packages' rule. */
const REPORTABLE = [
  AuthorizationError,
  AuthorizationRequiredError,
  CallbackServerError,
  CredentialStoreChoiceError,
  CredentialStoreError,
  LockTimeoutError,
  OAuthError,
  ProjectBindingError,
  ProjectMismatchError,
  RequestPortApiError,
  TokenRefreshError,
  WhoamiError,
] as const;

/**
 * What a failure may print: the message of a type in `REPORTABLE`, and of
 * anything else only its name, after `what` (`requestport link` reports
 * through this too).
 */
export function reportable(
  error: unknown,
  what = "the authorization did not complete",
): string {
  if (REPORTABLE.some((type) => error instanceof type)) {
    return (error as Error).message;
  }
  // Anything else came from code that made no promise about its message.
  const name =
    error instanceof Error && /^[A-Za-z]{1,40}$/u.test(error.name)
      ? ` (${error.name})`
      : "";
  return `${what}${name}.`;
}

/** The notice that a record stored by an earlier client is replaced. */
export function legacyNotice(
  projectId: string,
  server: string,
  then: string,
  command = "login",
) {
  return `requestport ${command}: the credential stored for project ${projectId} on ${server} was stored by an earlier client without its registration; ${then}.\n`;
}

/**
 * `requestport login` (manifest-h.md §2.8.4): the holding-store flow for the
 * audience asked, `mcp` unless `--for` says otherwise, and for `both` the two
 * in turn, each with its own registration and consent. The authorization URL
 * goes to stderr and the browser, never stdout. A grant for another project
 * than the one expected is refused naming both, and then nothing is stored:
 * with `--for both`, neither credential is stored unless both are for the
 * expected project, which, with neither `--project` nor a binding, is the one
 * the first consent chose.
 *
 * Exit codes: 0 stored, 1 not stored, 2 a usage error.
 */
export async function runLogin(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: LoginDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? processOutput;

  let parsed: LoginArguments | "help";
  let store: CredentialStore;
  try {
    parsed = parseLoginArguments(argv);
    if (parsed === "help") {
      output.stdout(`${LOGIN_USAGE}\n`);
      return 0;
    }
    store = dependencies.store ?? commandCredentialStore(env);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof CredentialStoreChoiceError
    ) {
      output.stderr(`requestport login: ${error.message}\n\n${LOGIN_USAGE}\n`);
      return 2;
    }
    throw error;
  }

  try {
    const cwd = dependencies.cwd ?? process.cwd();
    const bindingPath = findProjectFile(cwd);
    const binding =
      bindingPath === undefined ? undefined : readProjectBinding(cwd);
    const server =
      parsed.server ??
      (binding === undefined ? undefined : new URL(binding.server).origin);
    if (server === undefined) {
      output.stderr(
        `requestport login: no server: give --server, or run this inside a checkout whose .requestport/project.json names one.\n\n${LOGIN_USAGE}\n`,
      );
      return 2;
    }

    let expected: ExpectedProject | undefined =
      parsed.project !== undefined
        ? { namedBy: "--project", projectId: parsed.project }
        : binding !== undefined && new URL(binding.server).origin === server
          ? {
              namedBy: `this checkout's binding (${bindingPath})`,
              projectId: binding.projectId.toLowerCase(),
            }
          : undefined;

    let noticed = false;
    if (
      expected !== undefined &&
      store.hasLegacyRecord(server, expected.projectId)
    ) {
      output.stderr(
        legacyNotice(expected.projectId, server, "authorizing again"),
      );
      noticed = true;
    }

    const openBrowser =
      dependencies.openBrowser === null
        ? undefined
        : (dependencies.openBrowser ?? browserOpenerFor(env, parsed.noBrowser));
    const audiences: readonly Audience[] =
      parsed.for === "both" ? ["mcp", "api"] : [parsed.for];

    const held: HeldAuthorization[] = [];
    for (const audience of audiences) {
      const authorization = await obtainAuthorization({
        ...dependencies.authorization,
        audience,
        ...(expected === undefined ? {} : { expected }),
        onAuthorizationUrl: (url) => {
          output.stderr(
            `requestport login: to authorize the ${audience} credential, open this URL in a browser:\n\n  ${url}\n\n`,
          );
        },
        ...(openBrowser === undefined ? {} : { openBrowser }),
        server,
      });
      held.push(authorization);
      expected ??= {
        namedBy: `the ${audience} grant made first`,
        projectId: authorization.identity.projectId,
      };
    }

    for (const authorization of held) {
      const { organizationId, projectId } = authorization.identity;
      if (!noticed && store.hasLegacyRecord(server, projectId)) {
        output.stderr(legacyNotice(projectId, server, "it is replaced"));
        noticed = true;
      }
      storeAuthorization(authorization, store);
      output.stdout(
        `Stored the ${authorization.audience} credential for project ${projectId} (organization ${organizationId}) on ${server}.\n`,
      );
    }
    return 0;
  } catch (error) {
    output.stderr(`requestport login: ${reportable(error)}\n`);
    return 1;
  }
}
