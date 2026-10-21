import {
  OWNER_URL_FORMS,
  type OwnerUrlForm,
  refuseOwnerUrlInArgv,
} from "../owner-url.js";

export const START_USAGE = `Usage: requestport start [options]

Initialises a RequestPort instance in its data directory and its database,
then serves it. A first start writes the data directory's files, then runs
the operator step as a child process: on PostgreSQL, the owner's checks, the
claim on the database, the migrations and the instance's four logins; on
PGlite, the migrations of the database inside the data directory; then the
owner's account, whose local credential it prints once. A later start runs
the operator step again; each of its steps is idempotent. Then this process
serves the instance at its public URL, with its background worker, until
SIGTERM or SIGINT stops it: on PostgreSQL connecting as the instance's
logins, on PGlite opening its database once the operator step has closed it.

PGlite serves one user on this machine: it binds a loopback address only,
and row-level security does not apply to it, because PGlite connects as its
superuser.

Options:
  --data-dir <path>            The data directory (default: this user's
                               application data directory).
  --owner-url-file <path>      The owner URL, from a file only you can read.
  --owner-url-stdin            The owner URL, as one line of standard input.
  --email <address>            The owner's email address.
  --organization <slug>        The owner's organisation's slug.
  --organization-name <name>   The owner's organisation's name.
  --help                       Prints this text.

Recorded in the data directory's config.json by a first start:
  --storage <pg|pglite>        PostgreSQL, through the owner URL (the default),
                               or PGlite, inside the data directory. It never
                               changes once recorded.
  --public-url <url>           The URL people and agents reach the instance
                               at (default: http://<host>:<port>).
  --port <port>                Its port (default: 3200).
  --host <address>             Its bind address (default: 127.0.0.1; with
                               PGlite, a loopback address only).
  --trusted-proxy <address>    A reverse proxy whose forwarded headers to trust.

A later start refuses any of these that differs from config.json, unless
--public-url is given: then config.json records what is given, but for
--storage. Agent grants are bound to the public URL: those bound to an
earlier one stop working.

At a terminal, start asks for what a first start needs and was not given:
on PostgreSQL the owner URL, without echoing it; then the email and the
organisation.

${OWNER_URL_FORMS}
PGlite takes no owner URL: its database is inside the data directory.`;

export class StartUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "StartUsageError";
  }
}

export interface StartArguments {
  help: boolean;
  dataDirectory?: string;
  storage?: "pg" | "pglite";
  /** Absent: the prompt, when a first start needs the URL. */
  ownerUrlForm?: Exclude<OwnerUrlForm, { kind: "prompt" }>;
  publicUrl?: string;
  port?: number;
  host?: string;
  trustedProxy?: string;
  email?: string;
  organizationSlug?: string;
  organizationName?: string;
}

const VALUE_OPTIONS = {
  "--data-dir": "dataDirectory",
  "--storage": "storage",
  "--owner-url-file": "ownerUrlFile",
  "--public-url": "publicUrl",
  "--port": "port",
  "--host": "host",
  "--trusted-proxy": "trustedProxy",
  "--email": "email",
  "--organization": "organizationSlug",
  "--organization-name": "organizationName",
} as const;

type ValueOption = keyof typeof VALUE_OPTIONS;

const isValueOption = (name: string): name is ValueOption =>
  Object.hasOwn(VALUE_OPTIONS, name);

/**
 * Parses `requestport start`'s arguments. `--owner-url` with a value is
 * refused first, before anything else is read (`refuseOwnerUrlInArgv`). No
 * refusal repeats a value or an argument it does not know, since a value
 * typed in the wrong place may be a secret; it names only options this
 * command defines.
 */
export function parseStartArguments(argv: readonly string[]): StartArguments {
  refuseOwnerUrlInArgv(argv);
  const values = new Map<ValueOption, string>();
  let ownerUrlStdin = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--owner-url-stdin") {
      if (ownerUrlStdin) {
        throw new StartUsageError("--owner-url-stdin is given twice.");
      }
      ownerUrlStdin = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!isValueOption(name)) {
      throw new StartUsageError(
        argument.startsWith("-")
          ? "an option start does not take."
          : "an argument start does not take: it takes options only.",
      );
    }
    if (values.has(name)) throw new StartUsageError(`${name} is given twice.`);
    let value: string | undefined;
    if (equals === -1) {
      value = argv[index + 1];
      index += 1;
    } else {
      value = argument.slice(equals + 1);
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new StartUsageError(`${name} takes a value.`);
    }
    values.set(name, value);
  }

  const ownerUrlFile = values.get("--owner-url-file");
  if (ownerUrlFile !== undefined && ownerUrlStdin) {
    throw new StartUsageError(
      "--owner-url-file and --owner-url-stdin are two forms of one value: give one.",
    );
  }
  const storage = values.get("--storage");
  if (storage !== undefined && storage !== "pg" && storage !== "pglite") {
    throw new StartUsageError("--storage takes pg or pglite.");
  }
  const port = values.get("--port");
  if (port !== undefined && !/^[1-9][0-9]{0,4}$/u.test(port)) {
    throw new StartUsageError("--port takes a port number, 1 to 65535.");
  }
  if (port !== undefined && Number(port) > 65_535) {
    throw new StartUsageError("--port takes a port number, 1 to 65535.");
  }

  const parsed: StartArguments = { help };
  const set = <K extends keyof StartArguments>(
    key: K,
    value: StartArguments[K] | undefined,
  ) => {
    if (value !== undefined) parsed[key] = value;
  };
  set("dataDirectory", values.get("--data-dir"));
  set("storage", storage);
  set(
    "ownerUrlForm",
    ownerUrlFile !== undefined
      ? { kind: "file", path: ownerUrlFile }
      : ownerUrlStdin
        ? { kind: "stdin" }
        : undefined,
  );
  set("publicUrl", values.get("--public-url"));
  set("port", port === undefined ? undefined : Number(port));
  set("host", values.get("--host"));
  set("trustedProxy", values.get("--trusted-proxy"));
  set("email", values.get("--email"));
  set("organizationSlug", values.get("--organization"));
  set("organizationName", values.get("--organization-name"));
  return parsed;
}
