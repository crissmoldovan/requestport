import { readFileSync } from "node:fs";

/**
 * The `requestport` program's commands. This module imports `node:` modules
 * only, so in the repository `--version` and `--help` load no workspace
 * module; a command loads what it needs when it runs. (K8 measured that in
 * one bundled file every external package is linked before the entry runs,
 * so what the published `--version` loads is H.7's build to decide.)
 */

/** A command: its lines in the usage, and its module, loaded when it runs. */
interface Command {
  usage: string;
  load: () => Promise<
    (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>
  >;
}

/**
 * Each command, one entry each. A command's module is loaded only when it
 * runs, so that `--version` and `--help` load no workspace module; `worker`'s
 * loads `@requestport/jobs`' index, which registers the worker root as it
 * loads, and only that command may load it (`worker.ts`).
 */
const COMMANDS: Readonly<Record<string, Command>> = {
  start: {
    usage: `  start      Initialises a RequestPort instance, on PostgreSQL or PGlite, its
             data directory, its database and the owner, then serves it, with
             its background worker, until it is stopped.
             \`requestport start --help\` says how.`,
    load: async () => (await import("./start/start.js")).runStart,
  },
  worker: {
    usage: `  worker     Runs the background jobs on PostgreSQL, as requestport-jobs does,
             connecting as the worker's three database logins that this
             process's environment names, and refuses to start without them.
             \`requestport worker --help\` says what it reads.`,
    load: async () => (await import("./worker.js")).runWorker,
  },
  login: {
    usage: `  login      Authorizes an agent credential on this machine for a project,
             through the person's consent in a browser.
             \`requestport login --help\` says how.`,
    load: async () => {
      const { runLogin } = await import("./login.js");
      return (argv, env) => runLogin(argv, env);
    },
  },
  link: {
    usage: `  link       Binds this checkout to a project in .requestport/project.json,
             authorizing an agent credential for it first when none is
             stored. \`requestport link --help\` says how.`,
    load: async () => {
      const { runLink } = await import("./link.js");
      return (argv, env) => runLink(argv, env);
    },
  },
  mcp: {
    usage: `  mcp        Serves MCP to an agent on stdin and stdout, forwarding it to the
             server this checkout is bound to with this machine's mcp
             credential. \`requestport mcp --help\` says how.`,
    load: async () => {
      const { runMcpBridge } = await import("./mcp-bridge.js");
      return (argv, env) => runMcpBridge(argv, env);
    },
  },
  // Owner question 6 (ruling 156): this entry and `owner/` are the whole of
  // the public lost-credential command.
  owner: {
    usage: `  owner rotate-credential
             Rotates the owner's local credential, prints the new one once,
             and ends their sessions. \`requestport owner --help\` says how.`,
    load: async () =>
      (await import("./owner/rotate-credential.js")).runOwnerCommand,
  },
};

export const USAGE = `Usage: requestport <command> [options]

Commands:
${Object.values(COMMANDS)
  .map((command) => command.usage)
  .join("\n")}

Options:
  --help     Prints this text.
  --version  Prints this program's version.`;

export interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processOutput: CliOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * The version in this package's manifest. In the repository that is the
 * workspace's own field; the published one is stamped when it is packed
 * (ruling 158, 19).
 */
export function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("requestport: its package.json carries no version.");
  }
  return manifest.version;
}

/**
 * Runs one command and answers the process's exit code: 0 done, 2 a usage
 * error, or the command's own. An unknown command is not repeated back, since
 * a value typed in its place may be a secret.
 */
export async function runRequestPortCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  output: CliOutput = processOutput,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== undefined && Object.hasOwn(COMMANDS, command)) {
    const run = await (COMMANDS[command] as Command).load();
    return run(rest, env);
  }
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      output.stdout(`${USAGE}\n`);
      return 0;
    case "--version":
      output.stdout(`requestport ${packageVersion()}\n`);
      return 0;
    case undefined:
      output.stderr(`requestport: a command is required.\n\n${USAGE}\n`);
      return 2;
    default:
      output.stderr(`requestport: unknown command.\n\n${USAGE}\n`);
      return 2;
  }
}
