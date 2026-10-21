#!/usr/bin/env node
/*
  H.8's clean-machine run (manifest-h.md §5, Done when 14, as rulings 109,
  190, 193 item 8, 197 item 1 and 198 amend it): RequestPort's packed
  tarballs, installed and run in a container that has never seen them, by
  the README's own commands through `npx`. This file holds the clean
  container, the person, who is driven by
  `requestport-clean-machine/person.mjs` in a driver container, the agent,
  `requestport-clean-machine/agent.mjs`, bundled with its MCP client and run
  in the clean container, and the two storages: PGlite, inside `start`'s
  data directory, and PostgreSQL, in a database container from the official
  image.

  Usage: node scripts/requestport-clean-machine.mjs --pack <directory> --storage pglite|pg [--out <directory>]

  `--pack` is a directory `scripts/pack-requestport.mjs --out` wrote: its
  `build-record.json` and the fourteen tarballs the record names, in the
  order packed, `requestport`'s last. `--out` is where the run writes its
  transcript, its logs and `summary.json`; it must be outside the repository
  and empty, and without it the run makes one under the temporary directory
  and keeps it.

  `main`:

  1. refuses a temporary directory inside the repository, a run directory
     inside it or not empty, a build record that does not name `LOCKSTEP`'s
     thirteen and then `requestport`, a tarball whose size or sha512 is not
     the record's, and a driver image whose Playwright version is not the
     root's `@playwright/test`'s and the staged `playwright-core`'s
     (`driverImage`); on `pg`, reads the migrations journal
     `@requestport/db`'s tarball carries (`journalOf`); then asks `docker
     version`, with a bound, before it stages anything;
  2. stages, under `os.tmpdir()` (`mkdtemp`, then `realpath`, because on
     macOS both `/tmp` and `/var` are symbolic links and every mount source
     is given to docker as the path it resolves to): `tarballs/`, a copy of
     each tarball; `readme/README.md`, the README `requestport`'s tarball
     carries (`package/README.md`); `harness-clean/` (`stageCleanHarness`):
     `agent.mjs`, the agent bundled by esbuild with the
     `@modelcontextprotocol/client` `apps/requestport` resolves; and
     `harness-driver/` (`stageDriverHarness`): `person.mjs` and a copy of
     `playwright-core` with every symbolic link followed;
  3. creates the clean container (`cleanContainerArguments`) from
     `nodeImage()`: user 1000, an empty `HOME` on a tmpfs, no `.npmrc`, npm
     logging every request (`npm_config_loglevel=http`), the tarballs, the
     README and `harness-clean/` read-only, no published port and no
     network of its own; reads what it holds (`INSPECT_SCRIPT`); on `pg`,
     creates the database container in its network namespace
     (`databaseContainerArguments`), from `DATABASE_IMAGE`, with a password
     made for the run (`databasePassword`) that reaches `docker run` in its
     environment, never its arguments; and has the agent load its MCP
     client there (`load`);
  4. issues README 24, `--version`, with npm's cache empty, and counts every
     request npm logged (`fetchCounts`): none may be for `requestport` or an
     `@requestport` name anywhere but the closed registry. README 33's or
     59's requests (step 6) are counted and judged the same way. A request
     is judged by its URL, so the audit `POST`s, whose URL names no
     package, are counted apart and not judged: npm sends each to the main
     registry, never the closed one, and its body, which npm logs only at
     `silly`, names the packages npx installed, at their versions, ours
     among them;
  5. reads the one directory npx installed into: `npm ls --all` exits 0 and
     names each of the thirteen once, and its `package-lock.json` resolves
     each, and `requestport`, from its tarball with the record's integrity
     (`installProblems`);
  6. on `pglite`, issues README 33, `start --storage pglite`. On `pg`, waits
     for the database to accept connections on 127.0.0.1 (`pg_isready`),
     requires every TCP rule of its `pg_hba.conf` to ask for a SCRAM
     password (`hbaProblems`), writes the owner URL (`ownerUrlOf`) from
     standard input into the file README 58 and 59 name, in `HOME`, as
     uid 1000 with the default umask, then issues README 58, `chmod 600`,
     and README 59, `start --owner-url-file`. Either way it holds `start`'s
     standard output, the owner's local credential, in memory only; its
     standard error goes to a file in the container (`START_STDERR`), read
     until it says it is serving, and then its standard output is waited on,
     with a bound, for the credential's line (`CREDENTIAL_WAIT_MS`). On `pg`
     it then reads, through `psql` in
     the database container, the journal `start` applied
     (`migrationProblems`) and the instance's four logins
     (`instanceLoginProblems`), and requires every session open on the
     database to belong to one of those logins, so none is the owner's
     (`sessionProblems`);
  7. creates the driver container in the clean container's network namespace
     (`driverContainerArguments`), from the WebKit lanes' Playwright image,
     reads what it holds (`DRIVER_INSPECT_SCRIPT`), and reads
     `/api/health/ready` and `/sign-in` from it (`READINESS_SCRIPT`);
  8. starts the person there (`node /harness/person.mjs`, spoken to through
     `personClient`) and, in Chromium and then in WebKit (`BROWSERS`), each
     with its own project and checkout (`personPlan`):
     - signs in at the URL `start` printed with README 33's or 59's email
       and the credential `start` printed; creates the project; requires
       `/requests` not to show the title of the request the agent files
       below;
     - makes the checkout, a directory under `HOME` (`CHECKOUTS`), and issues
       README 139, `login`, in it; has the person approve the consent at the
       URL it printed, choosing the project and a new agent principal; then
       requires `login` to exit 0 having stored the `mcp` credential for that
       project on that server, and the browser to have landed on `login`'s
       callback, which answered that it has the authorization
       (`loginProblems`);
     - issues README 148, `link`, in the checkout, its `<project id>` slot
       filled with the project `login` said it stored (`substitute`'s
       `slots`), and requires it to use that credential, ask for no consent
       and write the binding it names (`linkProblems`);
     - issues README 169, `login --for api`, in the checkout, and has the
       person approve its consent with the agent principal the first consent
       made (`principalOption`); requires the `api` credential stored for the
       project (`loginProblems`);
     - writes README 156-163's MCP configuration into the checkout, with the
       one substitution in its `args` (`mcpConfiguration`);
     - runs the agent (`node /harness/agent.mjs`) in the checkout: one bridge
       that files a request (`create_request_draft`, then `submit_request`);
       then two bridges at once, each asking `whoami`; then one more alone.
       Each bridge must ask for no consent, say it serves the project, and
       ask no registry but the closed one for one of ours, and each whoami
       must name the organization and the project (`bridgeProblems`); no
       bridge may be left running after its client closed
       (`bridgeProcesses`); and each bridge step must keep the stored `mcp`
       credential's client id and change its refresh token, compared by
       SHA-256 only, with no lock left (`rotationProblems`); on `pg`, each
       bridge step must also have added one refresh token on the server
       for that credential's client per bridge, left one of its refresh
       tokens unrevoked, and registered no client (`refreshCountProblems`,
       Done when 13 step 7's count);
     - has the agent read the request through the packed HTTP client, which
       must name the project and show the request's title and state
       (`requestProblems`), with the same rules for the `api` credential;
     - and has the person see the request's title at `/requests`.
     Then it closes the person's browsers, and reads the npx directory again:
     still the one, and `npm ls --all` judged as in step 5 after every
     bridge's `npx` has installed into it;
  9. stops `start` (`stopCommand`), then requires the `stopped` line, no
     process left in the clean container but its own, and the port refused
     (`stopProblems`); and requires `start`'s standard error to hold no
     `HostHandoffRefusalError:` line (`startStderrProblems`, ruling 145);
     requires its standard error to say the in-process worker is ready (on
     PGlite, through the in-process exclusive runner), and its log on
     standard output, read by event name and count only (`startEvents`),
     to hold `worker.ready` once, an event of the retention-cleanup
     schedule's body (a scheduler tick through the exclusive runner), and no
     failed worker start, tick or schedule (`workerProblems`); records each
     failure the log names by its event, task and error code
     (`startFailures`); on `pg`, judges the sessions on the
     database just before the stop as step 6 does, and requires none after
     it (`sessionProblems`);
  10. at `main`'s end, on an exception `main` catches, on an uncaught
      exception or an unhandled rejection, and on SIGINT, SIGTERM or SIGHUP
      (no other signal, and never SIGKILL), removes each container it
      created with `docker rm -f -v`, newest first, so the driver and the
      database go before the clean container whose namespace they share,
      then counts what is left (`leftoverCounts`): containers with the run's
      label, anonymous volumes made since the run began and left dangling,
      and networks made since it began. Anything left fails the run. The
      staging directory is removed; the run directory is kept, and a file
      of it that holds a secret the run held (the database password, from
      its creation; the credential, once `start` has printed it) fails the
      run too (`filesHolding`), as a summary that held one does (it is
      written redacted).

  The README lines the run issues are `README_STEPS`, each written there as
  the README says it. Every one passes through `issueReadmeLine`, which takes
  the line, refuses it unless it is a line of one of the README's `sh`
  blocks, makes the one substitution and fills the one named slot
  (`substitute`), and writes the line, the command, the directory it runs in
  and the `docker exec` that runs it (`readmeCommand`) to the transcript
  (`RUN_FILES.transcript`) before it runs. Done when 14's contract test, in
  `requestport-package-contract.test.mjs`, holds `README_STEPS`, the MCP
  configuration and a recorded run's transcript to the README. The MCP
  configuration is written to the transcript as `configuration`, with the
  README's block and the text written. Each container the harness creates,
  and each other command it runs in one, is one of `HARNESS_COMMANDS`
  (`harnessCommand`). The run spawns `docker exec` and `docker run`
  through `createDocker` alone, which writes each README line's or harness
  command's entry to the transcript and then spawns the arguments that entry
  holds, every time, a command repeated while the run waits included; so
  the transcript holds what was spawned, as it was spawned. Each command the
  person is given is written there too, as `person`, without its
  credential, and each command the agent is given, as `agent`. The database
  password and the owner URL that holds it are in no command's arguments:
  the password reaches `docker run` in its environment, and the owner URL
  reaches its file on standard input.
*/

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { loadavg, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { LOCKSTEP } from "./pack-requestport.mjs";
import {
  BROWSERS,
  redact,
  SECRET_FIELDS,
} from "./requestport-clean-machine/person.mjs";
import { PLAYWRIGHT_IMAGE } from "./run-webkit-lanes.mjs";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The person's script, staged into the driver container's `/harness`. */
export const PERSON_SOURCE = join(
  repositoryRoot,
  "scripts/requestport-clean-machine/person.mjs",
);

/** The agent's script, bundled into the clean container's `/harness`. */
export const AGENT_SOURCE = join(
  repositoryRoot,
  "scripts/requestport-clean-machine/agent.mjs",
);

/**
 * The client name `requestport login` registers (`AGENT_CLIENT_NAME` in
 * `packages/client/src/authorize.ts`; the unit file compares the two). The
 * consent page proposes it as a new agent principal's display name, so an
 * existing principal made that way is offered as `<organization> / <it>`.
 */
export const AGENT_CLIENT_NAME = "requestport-agent";

/** The label every container of a run carries, valued with the run's id. */
export const RUN_LABEL = "requestport.h8.run";

/** What the README says where the run names the tarballs (ruling 193 item 8). */
export const PUBLISHED_FORM = "requestport@<version>";

/**
 * An address nothing listens on, so npm's request for an `@requestport` name is
 * refused where npm runs and never reaches a registry (ruling 197 item 1).
 */
export const CLOSED_REGISTRY = "http://127.0.0.1:9/";

/** The Node image's `node` user, which owns the tmpfs `HOME` is on. */
export const CONTAINER_USER = "1000:1000";

/**
 * The clean container's `HOME`, on a tmpfs. Not under `/home/`: the denylist's
 * `local-paths` rule reads `/home/<name>` as a person's directory.
 */
export const CONTAINER_HOME = "/srv/clean-home";

export const CONTAINER_TARBALLS = "/tarballs";
export const CONTAINER_README = "/readme/README.md";
export const CONTAINER_HARNESS = "/harness";

/** Where `start`'s standard error is written in the clean container. */
export const START_STDERR = "/tmp/requestport-start.stderr";

/** The checkouts the agent works in, one per browser, under `HOME`. */
export const CHECKOUTS = `${CONTAINER_HOME}/checkouts`;

/** The file the MCP configuration is written to, in a checkout. */
export const MCP_CONFIGURATION_FILE = ".mcp.json";

/** The agent's bundle, as the clean container sees it. */
export const AGENT_IN_CONTAINER = `${CONTAINER_HARNESS}/agent.mjs`;

/**
 * The one slot a README line the run issues may name beside the one
 * substitution (README 148), and what may fill it: a project id as `login`
 * prints it, lower case.
 */
export const README_SLOTS = Object.freeze({
  "<project id>":
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
});

/**
 * The database container's image on `pg`: the official PostgreSQL image, by
 * the tag present on this machine. Each run records the digest it ran.
 */
export const DATABASE_IMAGE = "postgres:17-alpine";

/** The image's superuser: the owner URL's role. */
export const DATABASE_OWNER = "postgres";

/** The database the image creates (`POSTGRES_DB`), and the owner URL names. */
export const DATABASE_NAME = "requestport";

export const DATABASE_PORT = 5432;

/** The image's data directory, on a tmpfs, so no anonymous volume is made. */
export const DATABASE_DATA = "/var/lib/postgresql/data";

/** The names the transcript gives the harness's own commands. */
export const HARNESS_COMMANDS = Object.freeze([
  "docker run",
  "inspect",
  "npx directory",
  "npm ls",
  "npx lockfile",
  "database readiness",
  "owner url",
  "owner url mode",
  "psql",
  "start stderr",
  "driver inspect",
  "readiness",
  "person",
  "checkout",
  "binding",
  "mcp configuration",
  "agent",
  "processes",
  "stop",
  "port",
  "home size",
]);

/**
 * The operator commands the run issues: README lines, each written here
 * verbatim, in the README's published form and with its slot unfilled. The
 * run issues each through `issueReadmeLine` (`readmeCommand`), which refuses
 * a line that is not a line of the README's `sh` blocks, so a README that no
 * longer says one of these stops the run at that step. Done when 14's
 * contract test (`requestport-package-contract.test.mjs`) holds each to a
 * line of the README, and so fails when either side changes alone.
 */
export const README_STEPS = Object.freeze({
  version: `npx ${PUBLISHED_FORM} --version`,
  startPglite: `npx ${PUBLISHED_FORM} start --storage pglite --email owner@example.com --organization acme --organization-name "Acme"`,
  ownerUrlMode: "chmod 600 owner-url.txt",
  startPg: `npx ${PUBLISHED_FORM} start --owner-url-file owner-url.txt --email owner@example.com --organization acme --organization-name "Acme"`,
  login: `npx ${PUBLISHED_FORM} login --server http://127.0.0.1:3200`,
  link: `npx ${PUBLISHED_FORM} link --server http://127.0.0.1:3200 --project <project id>`,
  loginApi: `npx ${PUBLISHED_FORM} login --for api`,
});

/** The files a run writes into its run directory, beside its logs. */
export const RUN_FILES = Object.freeze({
  transcript: "transcript.jsonl",
  summary: "summary.json",
});

/** The person's script, as the driver container sees it. */
export const PERSON_IN_CONTAINER = `${CONTAINER_HARNESS}/person.mjs`;

/**
 * The `playwright-core` the root's `@playwright/test` runs: resolved through
 * `@playwright/test`, then `playwright`, as Node resolves each from the one
 * before it, so the copy staged is the one the repository's lanes use.
 */
export function playwrightCoreSource(root = repositoryRoot) {
  const from = (base, name) =>
    realpathSync(createRequire(base).resolve(`${name}/package.json`));
  const test = from(join(root, "package.json"), "@playwright/test");
  const playwright = from(test, "playwright");

  return dirname(from(playwright, "playwright-core"));
}

/**
 * The three Playwright versions the driver depends on: the image's tag, the
 * root's `@playwright/test`, and the `playwright-core` staged beside the person.
 */
export function playwrightVersions(
  root = repositoryRoot,
  image = PLAYWRIGHT_IMAGE,
) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const core = JSON.parse(
    readFileSync(join(playwrightCoreSource(root), "package.json"), "utf8"),
  ).version;

  return {
    image: /:v(\d+\.\d+\.\d+)-[a-z]+$/u.exec(image)?.[1],
    test:
      manifest.devDependencies?.["@playwright/test"] ??
      manifest.dependencies?.["@playwright/test"],
    core,
  };
}

/**
 * The driver's image, the WebKit lanes' unless `image` is given, refused
 * unless the Playwright version its tag names is the root's
 * `@playwright/test`'s and the staged `playwright-core`'s.
 */
export function driverImage(root = repositoryRoot, image = PLAYWRIGHT_IMAGE) {
  const versions = playwrightVersions(root, image);

  if (versions.image !== versions.test || versions.test !== versions.core) {
    throw new Error(
      `the driver's Playwright versions disagree: ${JSON.stringify(versions)}`,
    );
  }

  return image;
}

/**
 * The driver container's `/harness`: the person's script and `playwright-core`
 * (which has no dependencies), copied with every symbolic link followed, so
 * nothing in it points back at this machine.
 */
export function stageDriverHarness(directory, root = repositoryRoot) {
  mkdirSync(join(directory, "node_modules"), { recursive: true });
  copyFileSync(PERSON_SOURCE, join(directory, "person.mjs"));
  cpSync(
    playwrightCoreSource(root),
    join(directory, "node_modules", "playwright-core"),
    { dereference: true, recursive: true },
  );
}

/** The workspace whose `@modelcontextprotocol/client` the agent is bundled with. */
const AGENT_CLIENT_FROM = "apps/requestport";

/**
 * The packages a bundle holds, as `<name>@<version>` from each one's own
 * manifest: every input of esbuild's metafile under a `node_modules`
 * directory, by the package that directory names.
 */
export function bundledPackages(metafile, root = repositoryRoot) {
  const found = new Set();

  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");

    if (at === -1) continue;

    const segments = input.slice(at + "node_modules/".length).split("/");
    const name = segments[0].startsWith("@")
      ? `${segments[0]}/${segments[1]}`
      : segments[0];
    const manifest = JSON.parse(
      readFileSync(
        join(root, input.slice(0, at), "node_modules", name, "package.json"),
        "utf8",
      ),
    );

    found.add(`${manifest.name}@${manifest.version}`);
  }

  return [...found].sort();
}

/**
 * The clean container's `/harness`: `agent.mjs`, the agent bundled into one
 * ESM file for Node 22 by esbuild, loaded as `scripts/pack-requestport.mjs`'s
 * bundle loads it (`packages/core`'s 0.28.2). `@modelcontextprotocol/client`
 * and its subpaths are resolved from `apps/requestport`, the workspace that
 * declares the 2.3.0 the lockfile holds; everything they import is resolved
 * from where each lives. The banner gives the bundle a `require`, because the
 * CommonJS packages inside it require Node's own modules. A warning refuses
 * the bundle. Answers the bundle's SHA-256, its size, esbuild's version and
 * the packages it holds (`bundledPackages`).
 */
export async function stageCleanHarness(directory, root = repositoryRoot) {
  const esbuild = createRequire(join(root, "packages/core/package.json"))(
    "esbuild",
  );
  const from = join(root, AGENT_CLIENT_FROM);
  const outfile = join(directory, "agent.mjs");
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [AGENT_SOURCE],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile,
    sourcemap: false,
    metafile: true,
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __agentRequire } from "node:module";\nconst require = __agentRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "agent-mcp-client",
        setup(build) {
          // esbuild reads a filter as a Go regular expression, which takes
          // no JavaScript flag: so no `u`.
          build.onResolve(
            { filter: /^@modelcontextprotocol\/client(\/|$)/ },
            async ({ path, kind, resolveDir }) => {
              if (resolveDir === from) return undefined;

              const resolved = await build.resolve(path, {
                kind,
                resolveDir: from,
              });

              return resolved.errors.length > 0
                ? { errors: resolved.errors }
                : { path: resolved.path };
            },
          );
        },
      },
    ],
  });

  if (result.errors.length > 0 || result.warnings.length > 0) {
    throw new Error(
      `esbuild, the agent: ${[...result.errors, ...result.warnings].map(({ text }) => text).join("; ")}`,
    );
  }

  const bytes = readFileSync(outfile);

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    esbuild: esbuild.version,
    packages: bundledPackages(result.metafile, root),
  };
}

/** The image of the clean container: the Node `.node-version` names. */
export function nodeImage(root = repositoryRoot) {
  const version = readFileSync(join(root, ".node-version"), "utf8").trim();

  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(
      `.node-version holds ${JSON.stringify(version)}, not a Node version`,
    );
  }

  return `node:${version}-bookworm-slim`;
}

/** `docker run`'s arguments for the clean container, after `run`. */
export function cleanContainerArguments({
  run,
  name,
  image,
  tarballs,
  readme,
  harness,
}) {
  return [
    "-d",
    "--init",
    "--name",
    name,
    "--label",
    `${RUN_LABEL}=${run}`,
    "--user",
    CONTAINER_USER,
    "--tmpfs",
    `${CONTAINER_HOME}:rw,exec,uid=1000,gid=1000,mode=0700`,
    "-e",
    `HOME=${CONTAINER_HOME}`,
    "-e",
    "npm_config_loglevel=http",
    "-e",
    "npm_config_update_notifier=false",
    "-v",
    `${tarballs}:${CONTAINER_TARBALLS}:ro`,
    "-v",
    `${readme}:${CONTAINER_README}:ro`,
    "-v",
    `${harness}:${CONTAINER_HARNESS}:ro`,
    "--workdir",
    CONTAINER_HOME,
    image,
    "sleep",
    "infinity",
  ];
}

/**
 * `docker run`'s arguments for the driver container, after `run`: in the clean
 * container's network namespace, so its loopback is the clean container's and
 * it reaches what `start` and `login` bind to 127.0.0.1 there; the staged
 * `harness-driver/` read-only at `/harness`; the image's own user, as the
 * WebKit lanes run it. No `--ipc=host`: Chromium is measured without it.
 */
export function driverContainerArguments({ run, name, clean, image, harness }) {
  return [
    "-d",
    "--init",
    "--name",
    name,
    "--label",
    `${RUN_LABEL}=${run}`,
    "--network",
    `container:${clean}`,
    "-v",
    `${harness}:${CONTAINER_HARNESS}:ro`,
    image,
    "sleep",
    "infinity",
  ];
}

/**
 * `docker run`'s arguments for the database container on `pg`, after `run`: in
 * the clean container's network namespace, so the owner URL names 127.0.0.1;
 * listening on 127.0.0.1 only; its data on a tmpfs. `POSTGRES_PASSWORD` is
 * named without a value, so docker takes it from its own environment and
 * the password is in no argument. `--auth-host=scram-sha-256` makes initdb
 * write SCRAM, not `trust`, for TCP from 127.0.0.1 and ::1: without it the
 * image trusts both, and in a shared namespace no password, the owner's or
 * the instance's logins', would be checked. The socket inside the container
 * stays `trust`, which is how the harness's `psql` reads.
 */
export function databaseContainerArguments({ run, name, clean, image }) {
  return [
    "-d",
    "--name",
    name,
    "--label",
    `${RUN_LABEL}=${run}`,
    "--network",
    `container:${clean}`,
    "--tmpfs",
    DATABASE_DATA,
    "-e",
    "POSTGRES_PASSWORD",
    "-e",
    `POSTGRES_DB=${DATABASE_NAME}`,
    "-e",
    "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
    image,
    "-c",
    `listen_addresses=127.0.0.1`,
  ];
}

/** A password made for one run: URL-safe, so the owner URL escapes nothing. */
export function databasePassword() {
  return randomBytes(24).toString("base64url");
}

const DATABASE_PASSWORD = /^[A-Za-z0-9_-]{32,}$/u;

/**
 * The owner URL README 59's file holds: the image's superuser and the run's
 * password, at 127.0.0.1 in the shared namespace, naming the database the
 * image created. Built at run time, so no URL with a password is written in
 * this file.
 */
export function ownerUrlOf(password) {
  if (typeof password !== "string" || !DATABASE_PASSWORD.test(password)) {
    throw new Error(
      "the database password is not 32 or more URL-safe characters",
    );
  }

  const url = new URL(`postgres://127.0.0.1:${DATABASE_PORT}/${DATABASE_NAME}`);

  url.username = DATABASE_OWNER;
  url.password = password;

  return url.href;
}

/**
 * The file README 58 makes private and README 59 names: one plain file name,
 * the same in both lines, in the directory they run in.
 */
export function ownerUrlFileOf({ chmod, start }) {
  const chmodded = /^chmod 600 (\S+)$/u.exec(chmod)?.[1];
  const named = /\s--owner-url-file\s+(\S+)/u.exec(start)?.[1];

  if (chmodded === undefined || named !== chmodded) {
    throw new Error(
      `README's chmod line names ${chmodded} and its start line ${named}; one file was expected`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(named)) {
    throw new Error(
      `the owner URL's file is not a plain file name in the directory start runs in: ${named}`,
    );
  }

  return named;
}

/**
 * The migrations journal `@requestport/db`'s tarball carries
 * (`package/migrations/meta/_journal.json`): what `start` applies on `pg`.
 */
export function journalOf(tarball) {
  const extracted = spawnSync(
    "tar",
    ["-xzOf", tarball, "package/migrations/meta/_journal.json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  if (extracted.status !== 0 || extracted.stdout === "") {
    throw new Error(
      `${tarball} holds no package/migrations/meta/_journal.json: ${String(extracted.stderr).trim()}`,
    );
  }

  const journal = JSON.parse(extracted.stdout);

  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error(`${tarball}'s migrations journal lists no migration`);
  }

  return journal;
}

/**
 * What the harness reads through `psql` in the database container, each one
 * JSON value. `oauth` keys each client's refresh tokens by the SHA-256 of
 * its client id, which is how the agent reports a stored one, so no client
 * id is printed.
 */
export const DATABASE_SQL = Object.freeze({
  hba: `select coalesce(json_agg(json_build_object('type', type, 'database', database, 'address', address, 'method', auth_method) order by rule_number), '[]'::json) from pg_catalog.pg_hba_file_rules`,
  migrations: `select coalesce(json_agg(created_at::text order by created_at, id), '[]'::json) from drizzle.__drizzle_migrations`,
  logins: `select coalesce(json_agg(json_build_object('login', r.rolname, 'canLogin', r.rolcanlogin, 'superuser', r.rolsuper, 'createdb', r.rolcreatedb, 'replication', r.rolreplication, 'bypassrls', r.rolbypassrls, 'createrole', r.rolcreaterole, 'groups', (select coalesce(json_agg(g.rolname::text order by g.rolname), '[]'::json) from pg_catalog.pg_auth_members m join pg_catalog.pg_roles g on g.oid = m.roleid where m.member = r.oid), 'comment', pg_catalog.shobj_description(r.oid, 'pg_authid')) order by r.rolname), '[]'::json) from pg_catalog.pg_roles r where r.rolname ~ '^rp_'`,
  sessions: `select coalesce(json_object_agg(usename, sessions), '{}'::json) from (select usename::text as usename, count(*) as sessions from pg_catalog.pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() group by usename) as open`,
  oauth: `select json_build_object('clients', (select count(*) from public.oauth_client), 'refreshTokens', (select coalesce(json_object_agg(client, json_build_object('issued', issued, 'live', live)), '{}'::json) from (select encode(sha256(convert_to(client_id, 'UTF8')), 'hex') as client, count(*) as issued, count(*) filter (where revoked is null) as live from public.oauth_refresh_token group by client_id) as tokens))`,
});

/**
 * `pg_isready`'s words in the database container: the owner's database, over
 * TCP on 127.0.0.1, as the owner URL reaches it.
 */
export const DATABASE_READINESS_WORDS = Object.freeze([
  "pg_isready",
  "-q",
  "-h",
  "127.0.0.1",
  "-p",
  String(DATABASE_PORT),
  "-U",
  DATABASE_OWNER,
  "-d",
  DATABASE_NAME,
]);

/**
 * `psql`'s words in the database container for one of `DATABASE_SQL`'s reads:
 * over its socket, as the image's superuser, one JSON value out. Refuses any
 * other SQL.
 */
export function psqlWords(sql) {
  if (!Object.values(DATABASE_SQL).includes(sql)) {
    throw new Error("psql runs DATABASE_SQL's reads only");
  }

  return [
    "psql",
    "-X",
    "-q",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    DATABASE_OWNER,
    "-d",
    DATABASE_NAME,
    "-c",
    sql,
  ];
}

/** What the database's TCP rules must be: each one a SCRAM password. */
export function hbaProblems(rules) {
  const tcp = rules.filter(({ type }) => String(type).startsWith("host"));
  const problems = tcp
    .filter(({ method }) => method !== "scram-sha-256")
    .map(
      ({ type, address, method }) =>
        `the database's ${type} rule for ${address} asks for ${method}, not a SCRAM password`,
    );

  if (tcp.length === 0) problems.push("the database has no TCP rule");

  return problems;
}

/**
 * What `start` left of the journal: each migration of `@requestport/db`'s
 * journal applied once, by its `when`, and nothing else.
 */
export function migrationProblems({ applied, journal }) {
  const expected = journal.entries.map(({ when }) => String(when)).sort();
  const found = [...applied].map(String).sort();

  if (isDeepStrictEqual(found, expected)) return [];

  return [
    `drizzle.__drizzle_migrations holds ${found.length} row(s), not the ${expected.length} of @requestport/db's journal: missing ${JSON.stringify(expected.filter((when) => !found.includes(when)))}, not in it ${JSON.stringify(found.filter((when) => !expected.includes(when)))}`,
  ];
}

/**
 * What the sessions open on the database show: while `start` serves (`when`),
 * a session as any role but `logins`, the instance's four, such as the
 * owner's; once it has stopped (`stopped`), any session at all. The reading
 * session itself is not among them (`DATABASE_SQL.sessions`).
 */
export function sessionProblems({ sessions, logins, when, stopped = false }) {
  const roles = Object.keys(sessions);

  if (stopped) {
    return roles.length === 0
      ? []
      : [
          `${when}, the database has sessions open: ${JSON.stringify(sessions)}`,
        ];
  }

  return roles
    .filter((role) => !logins.includes(role))
    .map(
      (role) =>
        `${when}, the database has ${sessions[role]} session(s) as ${role}, not one of the instance's four logins`,
    );
}

/**
 * The instance's four logins, by name suffix, each with its one group: the
 * operator session's `LOGIN_SUFFIXES` and `INSTANCE_LOGIN_GROUPS` (the unit
 * file compares them).
 */
export const INSTANCE_LOGINS = Object.freeze({
  application: "requestport_application",
  dispatcher: "requestport_dispatcher",
  tenant_processor: "requestport_tenant_processor",
  maintenance: "requestport_maintenance",
});

const LOGIN_ATTRIBUTES = Object.freeze([
  "superuser",
  "createdb",
  "replication",
  "bypassrls",
  "createrole",
]);

/**
 * What the instance's four logins lack (`packages/db`'s operator session): the
 * roles named `rp_…` must be exactly `rp_<id>_<kind>` for one instance id and
 * the four kinds, each able to log in and holding none of `LOGIN_ATTRIBUTES`,
 * each in its kind's group alone, and each carrying the claim comment that
 * names the instance and `database`.
 */
export function instanceLoginProblems({ logins, database }) {
  const problems = [];
  const ids = new Set();
  const kinds = [];

  for (const login of logins) {
    const named =
      /^rp_([a-z0-9]{8,32})_(application|dispatcher|tenant_processor|maintenance)$/u.exec(
        login.login,
      );

    if (named === null) {
      problems.push(
        `${login.login} is not one of an instance's four logins' names`,
      );
      continue;
    }

    const [, id, kind] = named;
    const held = LOGIN_ATTRIBUTES.filter((attribute) => login[attribute]);

    ids.add(id);
    kinds.push(kind);
    if (login.canLogin !== true) problems.push(`${login.login} cannot log in`);
    if (held.length > 0) {
      problems.push(`${login.login} holds ${held.join(", ")}`);
    }
    if (!isDeepStrictEqual(login.groups, [INSTANCE_LOGINS[kind]])) {
      problems.push(
        `${login.login} is in ${JSON.stringify(login.groups)}, not ${INSTANCE_LOGINS[kind]} alone`,
      );
    }
    if (login.comment !== `requestport instance ${id} database ${database}`) {
      problems.push(
        `${login.login}'s comment is ${JSON.stringify(login.comment)}, not the claim on ${database}`,
      );
    }
  }
  if (ids.size !== 1) {
    problems.push(
      `the logins name ${ids.size} instance(s), not one: ${JSON.stringify([...ids])}`,
    );
  }
  if (
    !isDeepStrictEqual([...kinds].sort(), Object.keys(INSTANCE_LOGINS).sort())
  ) {
    problems.push(
      `the instance's logins are ${JSON.stringify(kinds)}, not one of each of ${JSON.stringify(Object.keys(INSTANCE_LOGINS))}`,
    );
  }

  return problems;
}

/**
 * What a step that spent the stored `audience` credential `issued` times left
 * undone on the server: the client's refresh tokens up by `issued` (one per
 * refresh, as Done when 13 step 7 counts them: each refresh issues a new
 * one), one of them not revoked, and no client registered. The client is the
 * one the credential file names after the step, by its digest.
 */
export function refreshCountProblems({
  browser,
  step,
  audience,
  before,
  after,
  issued,
}) {
  const said = `${browser}: ${step}`;
  const client = after?.audiences?.[audience]?.clientIdSha256;

  if (before?.server === undefined || after?.server === undefined) {
    return [`${said}: the server's counts were not read before and after it`];
  }
  if (typeof client !== "string") {
    return [`${said}: no ${audience} credential was stored after it`];
  }

  const problems = [];
  const was = before.server.refreshTokens?.[client]?.issued ?? 0;
  const now = after.server.refreshTokens?.[client]?.issued ?? 0;

  if (now - was !== issued) {
    problems.push(
      `${said}: the server issued ${now - was} refresh token(s) to the ${audience} client, not ${issued}`,
    );
  }
  if (after.server.refreshTokens?.[client]?.live !== 1) {
    problems.push(
      `${said}: the server holds ${after.server.refreshTokens?.[client]?.live ?? 0} unrevoked refresh token(s) for the ${audience} client, not one`,
    );
  }
  if (after.server.clients !== before.server.clients) {
    problems.push(
      `${said}: the server's OAuth clients went from ${before.server.clients} to ${after.server.clients}`,
    );
  }

  return problems;
}

/** Every non-blank line inside a README's ```sh fences, with its number. */
export function readmeShellLines(text) {
  const found = [];
  let inside = false;

  for (const [index, line] of text.split("\n").entries()) {
    if (!inside && /^```sh\s*$/u.test(line)) {
      inside = true;
    } else if (inside && /^```\s*$/u.test(line)) {
      inside = false;
    } else if (inside && line.trim() !== "") {
      found.push({ number: index + 1, line });
    }
  }

  return found;
}

/**
 * The one README line `pick` names, refusing none or more than one: `pick` is
 * the line itself (a `README_STEPS` entry), or a test a line passes.
 */
export function readmeLine(text, pick) {
  const matches = readmeShellLines(text).filter(({ line }) =>
    typeof pick === "string" ? line === pick : pick(line),
  );

  if (matches.length !== 1) {
    throw new Error(
      `the README's sh blocks hold ${matches.length} line(s) of the kind this step issues; one was expected`,
    );
  }

  return matches[0];
}

const TARBALL_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/u;

/**
 * The words that stand where the README says `requestport@<version>`: the
 * runbook's pre-publish form (`docs/implementation/runbooks/package-build.md`),
 * the closed registry for the scope, then `-p file:<tarball>` for each
 * tarball in the record's order, `requestport`'s last, then the command.
 */
export function prePublishWords(tarballs) {
  if (tarballs.at(-1)?.name !== "requestport") {
    throw new Error("the last tarball must be requestport's");
  }
  for (const { file } of tarballs) {
    if (!TARBALL_FILE.test(file)) {
      throw new Error(
        `a tarball's file name is not one plain shell word: ${JSON.stringify(file)}`,
      );
    }
  }

  return [
    `--@requestport:registry=${CLOSED_REGISTRY}`,
    ...tarballs.flatMap(({ file }) => [
      "-p",
      `file:${CONTAINER_TARBALLS}/${file}`,
    ]),
    "requestport",
  ];
}

/**
 * The one substitution: a README line, refused unless it is a line of one of
 * the README's `sh` blocks, with `requestport@<version>` (at most once)
 * replaced by `prePublishWords`. A line without it, such as `chmod 600
 * owner-url.txt`, is issued as it is. A line that names a slot of
 * `README_SLOTS` (once) has it filled from `slots`, with a value the slot
 * admits; a slot the line does not name, a slot that is not one of them, or
 * a slot left unfilled is refused.
 */
export function substitute(line, { readme, tarballs, slots = {} }) {
  const entry = readmeShellLines(readme).find(
    (candidate) => candidate.line === line,
  );

  if (entry === undefined) {
    throw new Error(
      `not a line of the README's sh blocks, so the run does not issue it: ${line}`,
    );
  }

  const occurrences = line.split(PUBLISHED_FORM).length - 1;

  if (occurrences > 1) {
    throw new Error(
      `README line ${entry.number} names ${PUBLISHED_FORM} ${occurrences} times`,
    );
  }

  const words = prePublishWords(tarballs).join(" ");
  let command = line.replace(PUBLISHED_FORM, () => words);

  for (const [slot, value] of Object.entries(slots)) {
    const admits = Object.hasOwn(README_SLOTS, slot)
      ? README_SLOTS[slot]
      : undefined;

    if (admits === undefined) {
      throw new Error(`${slot} is not a slot the run fills`);
    }
    if (line.split(slot).length - 1 !== 1) {
      throw new Error(`README line ${entry.number} does not name ${slot} once`);
    }
    if (typeof value !== "string" || !admits.test(value)) {
      throw new Error(`${JSON.stringify(value)} is not what ${slot} admits`);
    }
    command = command.replace(slot, () => value);
  }
  for (const slot of Object.keys(README_SLOTS)) {
    if (line.includes(slot) && !Object.hasOwn(slots, slot)) {
      throw new Error(
        `README line ${entry.number} names ${slot}, and no value fills it`,
      );
    }
  }

  return {
    readmeLine: entry.number,
    readme: line,
    command,
    ...(Object.keys(slots).length === 0 ? {} : { slots: { ...slots } }),
  };
}

const CAPTURE_FILE = /^\/[A-Za-z0-9._/-]+$/u;

/**
 * A README line as the run issues it in the clean container: `substitute`'s
 * command, given to the container's shell (`sh -c`) in `cwd`, and the
 * transcript entry that says so, written before it runs. The entry holds the
 * README line and its number, the command issued, the directory, the slot
 * filled, and `argv`, the whole `docker exec` that runs it. `capture`, which
 * the run gives `start`'s line alone, puts `exec 2>><capture>;` before the
 * command in the shell's script, so that the shell, and so `start`, write
 * their standard error to that file in the container; the entry names it as
 * `stderrTo`. `docker exec`'s own arguments are `args`.
 */
export function readmeCommand(
  line,
  { readme, tarballs, slots, cwd = CONTAINER_HOME, capture, clean },
) {
  if (capture !== undefined && !CAPTURE_FILE.test(capture)) {
    throw new Error(`not a file to capture into: ${JSON.stringify(capture)}`);
  }

  const issued = substitute(line, { readme, tarballs, slots });
  const shell =
    capture === undefined
      ? issued.command
      : `exec 2>>${capture}; ${issued.command}`;
  const args = ["exec", "-w", cwd, clean, "sh", "-c", shell];

  return {
    args,
    entry: {
      kind: "readme",
      readmeLine: issued.readmeLine,
      readme: issued.readme,
      issued: issued.command,
      cwd,
      ...(issued.slots === undefined ? {} : { slots: issued.slots }),
      ...(capture === undefined ? {} : { stderrTo: capture }),
      argv: ["docker", ...args],
    },
  };
}

/** Every ```json fence of a README: its first and last lines, and its text. */
export function readmeJsonBlocks(text) {
  const blocks = [];
  let open;

  for (const [index, line] of text.split("\n").entries()) {
    if (open === undefined && /^```json\s*$/u.test(line)) {
      open = { from: index + 2, lines: [] };
    } else if (open !== undefined && /^```\s*$/u.test(line)) {
      blocks.push({
        from: open.from,
        to: index,
        text: open.lines.join("\n"),
      });
      open = undefined;
    } else if (open !== undefined) {
      open.lines.push(line);
    }
  }

  return blocks;
}

/**
 * The README's MCP configuration, its one `json` block naming `mcpServers`,
 * with the one substitution in `args`: the element `requestport@<version>`
 * becomes `prePublishWords`, each word an element, and every other element
 * stays as it is. Refused unless the block names one server, whose command
 * is `npx` and whose `args` name the published form once. Answers the
 * block's lines and text, the configuration, and the text written.
 */
export function mcpConfiguration({ readme, tarballs }) {
  const blocks = readmeJsonBlocks(readme).filter((block) => {
    try {
      return JSON.parse(block.text)?.mcpServers !== undefined;
    } catch {
      return false;
    }
  });

  if (blocks.length !== 1) {
    throw new Error(
      `the README's json blocks hold ${blocks.length} MCP configuration(s); one was expected`,
    );
  }

  const [block] = blocks;
  const servers = JSON.parse(block.text).mcpServers;
  const names = Object.keys(servers);

  if (names.length !== 1) {
    throw new Error(
      `README lines ${block.from}-${block.to} name ${names.length} servers; one was expected`,
    );
  }

  const server = servers[names[0]];
  const named = Array.isArray(server.args)
    ? server.args.filter((argument) => argument === PUBLISHED_FORM).length
    : 0;

  if (server.command !== "npx" || named !== 1) {
    throw new Error(
      `README lines ${block.from}-${block.to} do not run npx ${PUBLISHED_FORM} once`,
    );
  }

  const configuration = {
    mcpServers: {
      [names[0]]: {
        ...server,
        args: server.args.flatMap((argument) =>
          argument === PUBLISHED_FORM ? prePublishWords(tarballs) : [argument],
        ),
      },
    },
  };

  return {
    from: block.from,
    to: block.to,
    readme: block.text,
    configuration,
    text: `${JSON.stringify(configuration, null, 2)}\n`,
  };
}

/** The package a registry URL asks for, or undefined for an endpoint. */
export function packageOfUrl(url) {
  const path = decodeURIComponent(new URL(url).pathname).replace(/^\/+/u, "");

  if (path === "" || path.startsWith("-/")) return undefined;

  const segments = path.split("/");

  return segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

const COMPLETED_FETCH = /^npm http fetch (\S+) (\d{3}) (\S+)/u;
const FAILED_FETCH =
  /^npm http fetch (\S+) (\S+) attempt (\d+) failed with (\S+)/u;
const AUDIT_PATH = "/-/npm/v1/security/advisories/bulk";

const ours = (name) =>
  name === "requestport" || name?.startsWith("@requestport/") === true;

/**
 * Every request npm logged at `http` level, counted: completed ones by host,
 * failed attempts by host, the closed registry's attempts by package, the
 * audit `POST`s, and each request for `requestport` or an `@requestport`
 * name that went anywhere but the closed registry (`problems`). A request is
 * read by its URL alone: an audit `POST`'s names no package, though its body
 * names the packages installed, at their versions, ours included (npm logs
 * the body only at `silly`, which the clean container does not log at), so
 * no audit `POST` is a problem here.
 */
export function fetchCounts(stderr) {
  const completed = [];
  const failed = [];

  for (const line of stderr.split("\n")) {
    const done = COMPLETED_FETCH.exec(line);

    if (done !== null) {
      completed.push({
        method: done[1],
        status: Number(done[2]),
        url: done[3],
      });
      continue;
    }

    const attempt = FAILED_FETCH.exec(line);

    if (attempt !== null) {
      failed.push({
        method: attempt[1],
        url: attempt[2],
        attempt: Number(attempt[3]),
        code: attempt[4],
      });
    }
  }

  const tally = (list, key) => {
    const counts = {};
    for (const item of list) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
    return counts;
  };
  const host = ({ url }) => new URL(url).host;
  const closedHost = new URL(CLOSED_REGISTRY).host;
  const closed = failed.filter((request) => host(request) === closedHost);
  const leaked = [...completed, ...failed].filter(
    (request) =>
      host(request) !== closedHost && ours(packageOfUrl(request.url)),
  );

  return {
    completed: completed.length,
    completedByHost: tally(completed, host),
    notSuccessful: completed
      .filter(({ status }) => status >= 400)
      .map(({ method, status, url }) => `${method} ${status} ${url}`),
    failedByHost: tally(failed, host),
    closedRegistryAttempts: closed.length,
    closedRegistryByPackage: tally(closed, ({ url }) => packageOfUrl(url)),
    audit: completed.filter(
      ({ method, url }) =>
        method === "POST" && new URL(url).pathname === AUDIT_PATH,
    ).length,
    problems: leaked.map(
      ({ method, url, status, code }) =>
        `npm asked ${new URL(url).host} for ${packageOfUrl(url)} (${method} ${url}, ${status ?? code})`,
    ),
  };
}

/**
 * What the one npx directory holds, judged: `npm ls --all` exited 0 and names
 * each `@requestport` package once without "deduped"; its `package-lock.json`
 * holds each of them, and `requestport`, once, at the top of `node_modules`,
 * resolved from `file:` and with the build record's integrity.
 */
export function installProblems({ ls, lsStatus, lock, tarballs }) {
  const problems = [];

  if (lsStatus !== 0) problems.push(`npm ls --all exited ${lsStatus}`);

  const listed = ls
    .split("\n")
    .filter((line) => /@requestport\//u.test(line) && !/ deduped$/u.test(line))
    .map((line) => /(@requestport\/[a-z0-9-]+)@/u.exec(line)?.[1]);
  const packages = lock?.packages ?? {};

  for (const { name, file, integrity } of tarballs) {
    if (name !== "requestport") {
      const times = listed.filter((listedName) => listedName === name).length;
      if (times !== 1) {
        problems.push(
          `npm ls --all names ${name} ${times} time(s) not deduped`,
        );
      }
    }

    const paths = Object.keys(packages).filter(
      (path) =>
        path === `node_modules/${name}` ||
        path.endsWith(`/node_modules/${name}`),
    );

    if (paths.length !== 1 || paths[0] !== `node_modules/${name}`) {
      problems.push(
        `the npx lockfile installs ${name} at ${JSON.stringify(paths)}, not once at node_modules/${name}`,
      );
      continue;
    }

    const entry = packages[paths[0]];

    if (
      typeof entry.resolved !== "string" ||
      !entry.resolved.startsWith("file:") ||
      !entry.resolved.endsWith(`/${file}`)
    ) {
      problems.push(
        `the npx lockfile resolves ${name} from ${JSON.stringify(entry.resolved)}, not file:…/${file}`,
      );
    }
    if (entry.integrity !== integrity) {
      problems.push(
        `the npx lockfile's integrity for ${name} is not the build record's`,
      );
    }
  }

  return problems;
}

/** `randomBytes(32).toString("base64url")`: the local credential's shape. */
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The owner's local credential, from what `start` wrote on standard output:
 * the one line of its shape. The message of a refusal names counts only.
 */
export function credentialFrom(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const shaped = lines.filter((line) => CREDENTIAL.test(line));

  if (shaped.length !== 1) {
    throw new Error(
      `start wrote ${shaped.length} line(s) shaped as a local credential on standard output, among ${lines.length}; one was expected`,
    );
  }

  return { credential: shaped[0], lines: lines.length };
}

/**
 * Whether `stdout` holds a whole line of the local credential's shape, ended
 * by its line break: what the run waits for once `start` says it serves
 * (`CREDENTIAL_WAIT_MS`).
 */
export function credentialLineIn(stdout) {
  return stdout
    .slice(0, stdout.lastIndexOf("\n") + 1)
    .split("\n")
    .some((line) => CREDENTIAL.test(line.trim()));
}

/**
 * How long the run waits, once `start` says it serves, for the credential's
 * line on its standard output (ruling 202 item 3). A first `start` writes
 * the credential before it says it serves, but the two reach the harness
 * apart: the serving line through the file a synchronous `docker exec cat`
 * reads, and the credential through `docker exec`'s pipe, whose chunks this
 * process takes only between turns of its event loop, so under load the cat
 * can see the one before the other has been read.
 */
const CREDENTIAL_WAIT_MS = 60_000;

/** The public URL `start` says it serves, or undefined before it says so. */
export function servingUrl(stderr) {
  return /^requestport start: serving (\S+?);/mu.exec(stderr)?.[1];
}

/**
 * The owner README 33's or 59's line creates: its email and organization
 * name.
 */
export function ownerOf(line) {
  const email = /\s--email\s+(\S+)/u.exec(line)?.[1];
  const name = /\s--organization-name\s+(?:"([^"]*)"|(\S+))/u.exec(line);

  if (email === undefined)
    throw new Error(`the line names no --email: ${line}`);
  if (name === null) {
    throw new Error(`the line names no --organization-name: ${line}`);
  }

  return { email, organizationName: name[1] ?? name[2] };
}

/** The URL `login` printed on standard error for an audience, once it has. */
export function authorizationUrl(stderr) {
  const found =
    /^requestport login: to authorize the (mcp|api) credential, open this URL in a browser:\s+(\S+)/mu.exec(
      stderr,
    );

  return found === null ? undefined : { audience: found[1], url: found[2] };
}

const STORED =
  /^Stored the (mcp|api) credential for project (\S+) \(organization (\S+)\) on (\S+)\.$/u;

/** Each credential `login` says, on standard output, that it stored. */
export function storedCredentials(stdout) {
  return stdout
    .split("\n")
    .map((line) => STORED.exec(line.trim()))
    .filter((found) => found !== null)
    .map(([, audience, projectId, organizationId, server]) => ({
      audience,
      projectId,
      organizationId,
      server,
    }));
}

/** The first line `login`'s callback answers the browser with. */
export const CALLBACK_ANSWER = "RequestPort has the authorization.";

/**
 * What a `login` the person consented to left undone: an exit that is not 0,
 * anything but one credential stored, for `audience` (`mcp` unless given),
 * for the project the person created, on the server the line named or the
 * checkout's binding names; a callback that did not answer as `login`'s
 * does; or a request for one of ours outside the closed registry.
 */
export function loginProblems({
  browser,
  login,
  server,
  projectId,
  consent,
  audience = "mcp",
}) {
  const problems = [];
  const said = `${browser}: README ${login.readmeLine}`;

  if (login.status !== 0) problems.push(`${said} exited ${login.status}`);
  if (login.stored.length !== 1) {
    problems.push(
      `${said} stored ${login.stored.length} credential(s), not one`,
    );
  }
  for (const stored of login.stored) {
    if (stored.audience !== audience) {
      problems.push(
        `${said} stored the ${stored.audience} credential, not ${audience}`,
      );
    }
    if (stored.projectId !== projectId) {
      problems.push(
        `${said} stored a credential for project ${stored.projectId}, not ${projectId}, the one the person created`,
      );
    }
    if (stored.server !== server) {
      problems.push(
        `${said} stored a credential on ${stored.server}, not ${server}`,
      );
    }
  }
  if (consent.body?.split("\n")[0] !== CALLBACK_ANSWER) {
    problems.push(
      `${browser}: the callback answered ${JSON.stringify(consent.body)}, not ${JSON.stringify(CALLBACK_ANSWER)}`,
    );
  }
  for (const problem of login.fetches.problems) {
    problems.push(`${said}: ${problem}`);
  }

  return problems;
}

/** A line on which `login`, `link` or `mcp` asks for a consent. */
export const CONSENT_LINE =
  /^requestport (?:login|link|mcp): to authorize the (?:mcp|api) credential, open this URL in a browser:/mu;

/**
 * The option "Agent principal" offers for the principal a consent made with
 * the form's proposed display name: `<organization> / <client name>`
 * (`oauth/agent-consent/page.tsx`).
 */
export function principalOption(owner) {
  return `${owner.organizationName} / ${AGENT_CLIENT_NAME}`;
}

/**
 * What README 148 left undone: an exit that is not 0; a consent asked for, or
 * no word that it used the `mcp` credential `login` stored for the project;
 * no word that it wrote the checkout's binding; a binding that does not name
 * the organization, the project, its slug and the server; or a request for
 * one of ours outside the closed registry.
 */
export function linkProblems({
  browser,
  link,
  server,
  projectId,
  organizationId,
  slug,
  checkout,
  binding,
}) {
  const problems = [];
  const said = `${browser}: README ${link.readmeLine}`;
  const printed = (line) => link.stdout.split("\n").includes(line);
  const expected = { organizationId, projectId, projectSlug: slug, server };

  if (link.status !== 0) problems.push(`${said} exited ${link.status}`);
  if (CONSENT_LINE.test(link.stderr)) {
    problems.push(`${said} asked for a consent`);
  }
  if (
    !printed(
      `Using the mcp credential stored for project ${projectId} (organization ${organizationId}) on ${server}.`,
    )
  ) {
    problems.push(
      `${said} did not say it used the mcp credential stored for project ${projectId}`,
    );
  }
  if (
    !printed(
      `Wrote ${checkout}/.requestport/project.json: this checkout is bound to project ${projectId} (${slug}) of organization ${organizationId} on ${server}.`,
    )
  ) {
    problems.push(`${said} did not say it bound ${checkout}`);
  }
  if (!isDeepStrictEqual(binding, expected)) {
    problems.push(
      `${said} left the binding ${JSON.stringify(binding)}, not ${JSON.stringify(expected)}`,
    );
  }
  for (const problem of link.fetches.problems) {
    problems.push(`${said}: ${problem}`);
  }

  return problems;
}

/**
 * What one of the agent's bridge steps left undone. The agent's own failure;
 * not `bridges` bridges; for each bridge, a consent asked for, no line saying
 * it serves the project, an error its transport reported, or a request for
 * one of ours outside the closed registry; with `whoami`, not one answer per
 * bridge, or one naming another organization or project; and with more than
 * one bridge, one that connected before the last had started, so that they
 * did not run at once.
 */
export function bridgeProblems({
  browser,
  step,
  answer,
  bridges,
  whoami = false,
  server,
  projectId,
  organizationId,
  slug,
}) {
  const problems = [];
  const said = `${browser}: the agent's ${step}`;
  const records = answer.bridges ?? [];
  const serving = `requestport mcp: serving project ${projectId} (${slug}) on ${server}.`;

  if (answer.ok !== true) problems.push(`${said}: ${answer.error}`);
  if (records.length !== bridges) {
    problems.push(
      `${said} started ${records.length} bridge(s), not ${bridges}`,
    );
  }
  for (const [index, record] of records.entries()) {
    const which = `${said}, bridge ${index + 1}`;
    const stderr = String(record.stderr ?? "");

    if (CONSENT_LINE.test(stderr))
      problems.push(`${which} asked for a consent`);
    if (!stderr.split("\n").includes(serving)) {
      problems.push(`${which} did not say it serves project ${projectId}`);
    }
    for (const error of record.transportErrors ?? []) {
      problems.push(`${which}: its transport reported ${error}`);
    }
    for (const problem of fetchCounts(stderr).problems) {
      problems.push(`${which}: ${problem}`);
    }
  }
  if (whoami && answer.ok === true) {
    const answers = answer.result?.whoami ?? [];

    if (answers.length !== bridges) {
      problems.push(
        `${said} answered ${answers.length} whoami, not ${bridges}`,
      );
    }
    for (const [index, who] of answers.entries()) {
      if (
        who?.organizationId !== organizationId ||
        who?.projectId !== projectId
      ) {
        problems.push(
          `${said}, bridge ${index + 1}'s whoami names organization ${who?.organizationId} and project ${who?.projectId}, not ${organizationId} and ${projectId}`,
        );
      }
    }
  }
  if (records.length > 1) {
    const lastStarted = Math.max(
      ...records.map(({ startedMs }) => startedMs ?? Number.POSITIVE_INFINITY),
    );
    const firstConnected = Math.min(
      ...records.map(
        ({ connectedMs }) => connectedMs ?? Number.POSITIVE_INFINITY,
      ),
    );

    if (!(lastStarted < firstConnected)) {
      problems.push(
        `${said}: a bridge connected (${firstConnected} ms) before the last one started (${lastStarted} ms), so they did not run at once`,
      );
    }
  }

  return problems;
}

/**
 * What a step that spent the stored `audience` credential left undone: none
 * stored before it or after it, another client id after it, the same refresh
 * token after it (each compared by its SHA-256), or a lock left under
 * `~/.requestport`.
 */
export function rotationProblems({ browser, step, audience, before, after }) {
  const problems = [];
  const said = `${browser}: ${step}`;
  const was = before?.audiences?.[audience];
  const now = after?.audiences?.[audience];

  if (was === undefined || now === undefined) {
    problems.push(
      `${said}: no ${audience} credential was stored ${was === undefined ? "before" : "after"} it`,
    );
    return problems;
  }
  if (now.clientIdSha256 !== was.clientIdSha256) {
    problems.push(`${said} changed the ${audience} credential's client id`);
  }
  if (now.refreshTokenSha256 === was.refreshTokenSha256) {
    problems.push(
      `${said} left the ${audience} credential's refresh token as it was`,
    );
  }
  if ((after.locks ?? []).length > 0 || after.fileLock === true) {
    problems.push(
      `${said} left a lock: ${JSON.stringify({ locks: after.locks, fileLock: after.fileLock })}`,
    );
  }

  return problems;
}

/**
 * What the packed HTTP client's reading left undone: the agent's failure; a
 * whoami naming another organization or project; or a request that is not
 * the one filed, with its title, in the state `submit_request` answered,
 * for the project.
 */
export function requestProblems({
  browser,
  answer,
  requestId,
  title,
  state,
  projectId,
  organizationId,
}) {
  const said = `${browser}: the packed HTTP client`;

  if (answer.ok !== true) return [`${said}: ${answer.error}`];

  const problems = [];
  const { whoami, request } = answer.result;
  const expected = { id: requestId, title, state, targetProjectId: projectId };

  if (
    whoami?.organizationId !== organizationId ||
    whoami?.projectId !== projectId
  ) {
    problems.push(
      `${said}'s whoami names organization ${whoami?.organizationId} and project ${whoami?.projectId}, not ${organizationId} and ${projectId}`,
    );
  }
  for (const [field, value] of Object.entries(expected)) {
    if (request?.[field] !== value) {
      problems.push(
        `${said} read the request's ${field} as ${JSON.stringify(request?.[field])}, not ${JSON.stringify(value)}`,
      );
    }
  }

  return problems;
}

/**
 * What `start`'s standard error must not hold: a `HostHandoffRefusalError:`
 * line, which a fail-closed factory in Next's copy writes when it is asked
 * for a storage the host's handoff did not give it (ruling 145;
 * `packages/db/src/client.ts`'s `hostHandoffRefusal`).
 */
export function startStderrProblems(stderr) {
  const refusals = (stderr.match(/HostHandoffRefusalError:/gu) ?? []).length;

  return refusals === 0
    ? []
    : [
        `start's standard error holds ${refusals} HostHandoffRefusalError line(s): a factory in Next's copy was refused the host's handoff`,
      ];
}

/**
 * The log events on `start`'s standard output, by name, counted: each line
 * that is a JSON object naming an `event` (`@requestport/config/logger`'s
 * `createLogger` writes them there, through `console.log`). Nothing else of
 * a line is kept, so the owner's credential, which is on the same output,
 * and every field of an event are left out.
 */
export function startEvents(stdout) {
  const counts = {};

  for (const line of String(stdout).split("\n")) {
    let record;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof record.event !== "string"
    ) {
      continue;
    }
    counts[record.event] = (counts[record.event] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** The worker's events that say a start, a tick or a schedule failed. */
const WORKER_FAILURES = Object.freeze([
  "worker.start_failed",
  "worker.tick_failed",
  "schedule.failed",
]);

/** A field a log event carries as a metric label: a short plain token. */
const LOG_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;

/**
 * The failures in `start`'s log on standard output, counted by the event and
 * the two label fields that name what failed: `<event> <taskId> <errorCode>`
 * for `WORKER_FAILURES` and the job runner's `job.failed` and
 * `job.timed_out`, each field `-` when it is absent or not a plain token.
 * Nothing else of a line is kept.
 */
export function startFailures(stdout) {
  const failures = [...WORKER_FAILURES, "job.failed", "job.timed_out"];
  const label = (value) =>
    typeof value === "string" && LOG_LABEL.test(value) ? value : "-";
  const counts = {};

  for (const line of String(stdout).split("\n")) {
    let record;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!failures.includes(record?.event)) continue;

    const key = `${record.event} ${label(record.taskId)} ${label(record.errorCode)}`;

    counts[key] = (counts[key] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * The event the retention-cleanup schedule's body logs once per retention
 * category it completes (`packages/jobs/src/jobs/retention-cleanup.ts`).
 * Nothing in the worker runs that body but the schedule
 * (`packages/jobs/src/catalogue.ts`, `scheduleDefinitions`).
 */
const SCHEDULED_EVENT = "retention.category_completed";

/**
 * What `start`'s in-process worker left unsaid. On standard error, the line
 * `start` prints once its worker is ready (`serving <url>; the in-process
 * worker is ready.`), and on PGlite the line naming the in-process exclusive
 * runner the worker runs through. In the log on standard output (`events`,
 * by `startEvents`): `worker.ready` once, which the worker logs once its
 * first outbox tick has returned through that exclusive runner
 * (`packages/jobs/src/worker.ts`, `markReady` after `runExclusive("outbox",
 * …)`); `SCHEDULED_EVENT` at least once, which only the retention-cleanup
 * schedule's body logs, and which a scheduler tick runs through
 * `runExclusive("schedule:retention-cleanup", …)`
 * (`packages/jobs/src/scheduler.ts`), a runner that runs a tick's body only
 * while it holds the tick's key; and none of `WORKER_FAILURES`.
 */
export function workerProblems({ storage, url, stderr, events }) {
  const problems = [];
  const said = String(stderr).split("\n");
  const ready = `serving ${url}; the in-process worker is ready.`;

  if (!said.includes(`requestport start: ${ready}`)) {
    problems.push(`start's standard error does not say "${ready}"`);
  }
  if (
    storage === "pglite" &&
    !said.includes(
      "requestport start: storage worker: unbound, on the application storage, with the in-process exclusive runner.",
    )
  ) {
    problems.push(
      "start's standard error does not name the in-process exclusive runner PGlite's worker runs through",
    );
  }
  if (events["worker.ready"] !== 1) {
    problems.push(
      `start logged worker.ready ${events["worker.ready"] ?? 0} time(s), not once`,
    );
  }
  if (events[SCHEDULED_EVENT] === undefined) {
    problems.push(
      `start logged no ${SCHEDULED_EVENT}: no scheduler tick ran the retention-cleanup schedule through the exclusive runner`,
    );
  }
  for (const failure of WORKER_FAILURES) {
    if (events[failure] !== undefined) {
      problems.push(`start logged ${failure} ${events[failure]} time(s)`);
    }
  }

  return problems;
}

/**
 * A bridge's processes, of a process list: `npm exec … requestport mcp`, the
 * shell npm runs the bin through, and `requestport mcp` itself, each of whose
 * command lines ends with the word `mcp`.
 */
export function bridgeProcesses(processes) {
  return processes.filter(({ cmd }) => /(?:^|\s)mcp$/u.test(cmd));
}

const BROWSER_NAMES = Object.freeze({ chromium: "Chromium", webkit: "WebKit" });

/**
 * What the person makes in one browser: a project of its own, the slug of the
 * agent principal its first consent creates (a slug is unique in an
 * organization, and both browsers' consents are the one owner's in one), the
 * checkout the agent works in, and the title and description of the request
 * the agent files there.
 */
export function personPlan(browser, run) {
  const name = BROWSER_NAMES[browser];

  if (name === undefined) throw new Error(`no browser is named ${browser}`);

  return {
    project: {
      name: `${name} project`,
      key: browser.toUpperCase(),
      slug: `${browser}-project`,
    },
    principalSlug: `${browser}-agent`,
    checkout: `${CHECKOUTS}/${browser}`,
    requestTitle: `Filed from ${name} in ${run}`,
    requestDescription: `Filed by H.8's agent through the README's MCP configuration, in the checkout of the ${name} project, in run ${run}.`,
  };
}

/**
 * The harness's side of `person.mjs`, over a child's standard streams: `ready`
 * settles with the person's first line, and `ask(command, fields)` writes one
 * command and settles with its answer. A failed step, the process ending, or
 * no answer within `timeoutMs` rejects, naming the browser and the command.
 * Each command goes to the transcript first, without its secret fields.
 */
export function personClient({ child, transcript, timeoutMs }) {
  const waiting = new Map();
  let next = 1;
  let buffer = "";
  let settleReady;
  let failReady;
  const ready = new Promise((settle, fail) => {
    settleReady = settle;
    failReady = fail;
  });

  // Whoever awaits `ready` still sees the rejection; a process that ends
  // before anyone does is not an unhandled one.
  ready.catch(() => {});
  // A write after the process ended fails with EPIPE; the `close` below is
  // what fails the ask, so the stream's error must not end the harness.
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    buffer += chunk;

    let end = buffer.indexOf("\n");

    while (end !== -1) {
      const line = buffer.slice(0, end);

      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");

      let answer;

      try {
        answer = JSON.parse(line);
      } catch {
        continue;
      }
      if (answer?.ready !== undefined) {
        settleReady(answer.ready);
      } else if (waiting.has(answer?.id)) {
        waiting.get(answer.id)(answer);
      }
    }
  });
  let ended;

  child.on("close", (status, signal) => {
    ended = `the person's process ended (exit ${status ?? signal})`;
    failReady(new Error(ended));
    for (const answer of waiting.values()) answer({ ended });
  });

  return {
    ready,
    ask(command, fields) {
      const id = next++;
      const named = `${fields.browser ?? "person"}: ${command}`;
      const recorded = { kind: "person", id, command, ...fields };

      for (const secret of SECRET_FIELDS) delete recorded[secret];
      transcript(recorded);

      return new Promise((settle, fail) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          fail(new Error(`${named}: no answer within ${timeoutMs} ms`));
        }, timeoutMs);

        waiting.set(id, (answer) => {
          clearTimeout(timer);
          waiting.delete(id);
          if (answer.ended !== undefined) {
            fail(new Error(`${named}: ${answer.ended}`));
          } else if (answer.ok !== true) {
            fail(new Error(answer.error ?? `${named}: failed`));
          } else {
            settle(answer);
          }
        });
        if (ended === undefined) {
          child.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`);
        } else {
          waiting.get(id)({ ended });
        }
      });
    },
  };
}

/** What the driver container holds: Node, the browsers, the staged library. */
export const DRIVER_INSPECT_SCRIPT = `
const fs = require("node:fs");
console.log(JSON.stringify({
  node: process.version,
  uid: process.getuid(),
  browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
  browsers: fs.readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright").sort(),
  playwrightCore: JSON.parse(fs.readFileSync("/harness/node_modules/playwright-core/package.json", "utf8")).version,
  person: fs.existsSync("/harness/person.mjs"),
  shmBytes: (() => { try { const s = fs.statfsSync("/dev/shm"); return s.blocks * s.bsize; } catch { return null; } })(),
}));
`;

/** Lists the clean container's processes, as JSON, from /proc. */
export const PROCESSES_SCRIPT = `
const fs = require("node:fs");
const found = [];
for (const entry of fs.readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue;
  try {
    const stat = fs.readFileSync("/proc/" + entry + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cmd = fs.readFileSync("/proc/" + entry + "/cmdline", "utf8").split("\\0").filter(Boolean).join(" ");
    found.push({ pid: Number(entry), ppid: Number(fields[1]), pgrp: Number(fields[2]), cmd });
  } catch {}
}
console.log(JSON.stringify(found));
`;

/** The container's own processes: its init, and the `sleep` it runs. */
export function ownProcess({ pid, ppid, cmd }) {
  return pid === 1 || (ppid === 1 && cmd === "sleep infinity");
}

/** The `npm exec … start` process README 33 or 59 began, of a process list. */
export function startProcess(processes) {
  const found = processes.filter(
    ({ cmd }) => /^npm exec\b/u.test(cmd) && /\bstart\b/u.test(cmd),
  );

  if (found.length !== 1) {
    throw new Error(
      `the clean container runs ${found.length} npm exec start process(es); one was expected`,
    );
  }

  return found[0];
}

/**
 * The shell command that stops `start`, given its npx process: SIGTERM to
 * npx's process group, as a terminal's Ctrl-C reaches the whole group. npm
 * runs the bin through `sh -c`, and SIGTERM to npx's pid alone left the server
 * running in this image with no `stopped` line (the survey's measurement).
 * Written `kill -TERM -<group>`: the image's `sh` is dash, whose `kill` reads
 * `--` as a number and refuses it.
 */
export function stopCommand(npx) {
  if (!Number.isInteger(npx.pgrp) || npx.pgrp <= 1) {
    throw new Error(`not a process group to signal: ${JSON.stringify(npx)}`);
  }

  return `kill -TERM -${npx.pgrp}`;
}

/** What a stop left undone: the `stopped` line, a process, the port. */
export function stopProblems({ stderr, left, port }) {
  const problems = [];

  if (!/^requestport start: stopped:/mu.test(stderr)) {
    problems.push("start's standard error has no `stopped` line");
  }
  for (const { pid, cmd } of left) {
    problems.push(`left in the clean container: ${pid} ${cmd}`);
  }
  if (port !== "ECONNREFUSED") {
    problems.push(`the port answered ${port} after the stop, not ECONNREFUSED`);
  }

  return problems;
}

/** Reads readiness and the sign-in page from inside the namespace. */
export const READINESS_SCRIPT = `
(async () => {
  const base = process.argv[1];
  const ready = await fetch(base + "/api/health/ready");
  const readyBody = await ready.text();
  const signIn = await fetch(base + "/sign-in");
  const signInBody = await signIn.text();
  console.log(JSON.stringify({
    ready: { status: ready.status, body: readyBody.slice(0, 200) },
    signIn: { status: signIn.status, length: signInBody.length, poweredBy: signIn.headers.get("x-powered-by") },
  }));
})().catch((error) => {
  console.log(JSON.stringify({ error: String(error.cause?.code ?? error.message) }));
  process.exitCode = 1;
});
`;

/** Answers `open` or the error code of a TCP connection to a port. */
export const PORT_SCRIPT = `
const socket = require("node:net").connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
socket.on("connect", () => { console.log("open"); socket.destroy(); });
socket.on("error", (error) => console.log(error.code ?? error.message));
`;

/** What the clean container holds before the first README line. */
export const INSPECT_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
const npm = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "package.json");
console.log(JSON.stringify({
  node: process.version,
  npm: JSON.parse(fs.readFileSync(npm, "utf8")).version,
  uid: process.getuid(),
  gid: process.getgid(),
  home,
  homeEntries: fs.readdirSync(home),
  npmrc: fs.existsSync(path.join(home, ".npmrc")),
  globalNpmrc: fs.existsSync(path.join(path.dirname(process.execPath), "..", "etc", "npmrc")),
  tarballs: fs.readdirSync("/tarballs").sort(),
  readme: fs.existsSync("/readme/README.md"),
  npmEnvironment: Object.keys(process.env).filter((name) => /^npm_config_/i.test(name)).sort(),
}));
`;

/** What the inspection must find; each difference is a problem. */
export function inspectProblems(facts, tarballs) {
  const problems = [];

  if (facts.uid !== 1000 || facts.gid !== 1000) {
    problems.push(`the clean container runs as ${facts.uid}:${facts.gid}`);
  }
  if (facts.home !== CONTAINER_HOME) problems.push(`HOME is ${facts.home}`);
  if (!Array.isArray(facts.homeEntries) || facts.homeEntries.length !== 0) {
    problems.push(`HOME is not empty: ${JSON.stringify(facts.homeEntries)}`);
  }
  if (facts.npmrc !== false) problems.push("HOME holds an .npmrc");
  if (facts.globalNpmrc !== false) problems.push("npm's global npmrc exists");
  if (facts.readme !== true) problems.push("the README is not mounted");
  if (
    !isDeepStrictEqual(facts.tarballs, tarballs.map(({ file }) => file).sort())
  ) {
    problems.push(
      `/tarballs holds ${JSON.stringify(facts.tarballs)}, not the record's`,
    );
  }

  return problems;
}

/**
 * A harness command as the transcript holds it: one of `HARNESS_COMMANDS`, and
 * the `docker run` (for `docker run`) or `docker exec` (for any other) that
 * runs it. Refuses any other name, or the other subcommand.
 */
export function harnessCommand(name, args) {
  if (!HARNESS_COMMANDS.includes(name)) {
    throw new Error(`no harness command is named ${name}`);
  }

  const subcommand = name === "docker run" ? "run" : "exec";

  if (args[0] !== subcommand) {
    throw new Error(`${name} runs docker ${subcommand}, not docker ${args[0]}`);
  }

  return { kind: "harness", name, argv: ["docker", ...args] };
}

/**
 * The `docker` subcommands `createDocker`'s `query` runs, which run nothing in
 * a container: the server's version, an image's identity, the volumes, the
 * networks and the run's containers, and the teardown's `rm`.
 */
const DOCKER_QUERIES = Object.freeze([
  ["version"],
  ["image", "inspect"],
  ["volume", "ls"],
  ["network", "ls"],
  ["ps"],
  ["rm"],
]);

/** The `docker exec` or `docker run` arguments of a transcript entry, checked. */
function containerArguments(entry) {
  const argv = entry?.argv;
  const subcommand =
    entry?.kind === "harness" && entry.name === "docker run" ? "run" : "exec";

  if (
    !Array.isArray(argv) ||
    argv.some((word) => typeof word !== "string") ||
    argv[0] !== "docker" ||
    argv[1] !== subcommand
  ) {
    throw new Error(
      `not a docker ${subcommand} to transcribe: ${JSON.stringify(argv)}`,
    );
  }
  if (entry.kind === "harness") {
    harnessCommand(entry.name, argv.slice(1));
  } else if (entry.kind !== "readme") {
    throw new Error(
      `an entry of kind ${JSON.stringify(entry?.kind)} runs nothing in a container`,
    );
  }

  return argv.slice(1);
}

/**
 * The run's docker. `exec(entry)` and `start(entry)` are the only way the run
 * creates a container or runs a command in one: each takes a transcript
 * entry, a README line's (`readmeCommand`) or a harness command's
 * (`harnessCommand`), writes it with `transcript`, and then spawns `docker`
 * with the very arguments its `argv` holds after `docker`. So the transcript
 * holds every `docker exec` and `docker run` the run spawns, each time it
 * spawns one, as it was spawned. `exec` waits for it, `start` does not: it
 * answers the child, `done` (settled, never rejected, with the status, the
 * signal, both outputs and whether `timeout` killed it), and its outputs so
 * far. A started child is in `inflight` until it closes. `query(args)` runs
 * one of `DOCKER_QUERIES` and refuses any other subcommand. `spawn` and
 * `spawnSync` are Node's unless a test gives its own.
 */
export function createDocker({
  transcript,
  spawn: spawnLater = spawn,
  spawnSync: spawnNow = spawnSync,
}) {
  const inflight = new Set();
  const now = (args, { timeout = 120_000, input, environment } = {}) =>
    spawnNow("docker", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout,
      ...(input === undefined ? {} : { input }),
      ...(environment === undefined
        ? {}
        : { env: { ...process.env, ...environment } }),
    });
  const transcribed = (entry) => {
    const args = containerArguments(entry);

    transcript(entry);

    return args;
  };

  return {
    inflight,
    query(args, timeout) {
      if (
        !DOCKER_QUERIES.some((query) =>
          query.every((word, index) => args[index] === word),
        )
      ) {
        throw new Error(
          `docker ${args[0]} is not a query; it runs through exec or start`,
        );
      }

      return now(args, { timeout });
    },
    exec(entry, options) {
      return now(transcribed(entry), options);
    },
    start(entry, { timeout, input = false } = {}) {
      const child = spawnLater("docker", transcribed(entry), {
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      inflight.add(child);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, timeout);
      const done = new Promise((settle) => {
        child.on("error", (error) => {
          clearTimeout(timer);
          inflight.delete(child);
          settle({
            status: null,
            signal: null,
            stdout,
            stderr: String(error),
            timedOut,
          });
        });
        child.on("close", (status, signal) => {
          clearTimeout(timer);
          inflight.delete(child);
          settle({ status, signal, stdout, stderr, timedOut });
        });
      });

      return { child, done, output: () => stdout, errors: () => stderr };
    },
  };
}

/**
 * The containers a run creates, removed newest first. A name is recorded
 * before `docker run` is asked, because a run that fails can leave a
 * container created and not started. `environment`, when given, is added to
 * the environment `docker run` itself runs in, for a variable `args` names
 * without a value.
 */
export function createLedger(docker) {
  const created = [];

  return {
    created,
    create(name, args, environment) {
      created.push(name);
      const result =
        environment === undefined
          ? docker(["run", ...args])
          : docker(["run", ...args], environment);

      if (result.status !== 0) {
        throw new Error(
          `docker run ${name} exited ${result.status}: ${String(result.stderr ?? "").trim()}`,
        );
      }

      return String(result.stdout).trim();
    },
    teardown() {
      const removed = [];

      while (created.length > 0) {
        const name = created.pop();
        const result = docker(["rm", "-f", "-v", name]);

        removed.push({ name, status: result.status });
      }

      return removed;
    },
  };
}

const lines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The anonymous volumes no container uses, and every network, by id. */
export function dockerInventory(docker) {
  const volumes = docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    "label=com.docker.volume.anonymous",
    "--filter",
    "dangling=true",
  ]);
  const networks = docker(["network", "ls", "-q", "--no-trunc"]);

  if (volumes.status !== 0 || networks.status !== 0) {
    throw new Error("docker did not list its volumes and networks");
  }

  return { volumes: lines(volumes.stdout), networks: lines(networks.stdout) };
}

/**
 * What a run left: its labelled containers, and the dangling anonymous
 * volumes and the networks that were not there before it.
 */
export function leftoverCounts(docker, { run, before }) {
  const containers = docker([
    "ps",
    "-a",
    "-q",
    "--filter",
    `label=${RUN_LABEL}=${run}`,
  ]);

  if (containers.status !== 0) {
    throw new Error("docker did not list the run's containers");
  }

  const after = dockerInventory(docker);

  return {
    containers: lines(containers.stdout),
    volumes: after.volumes.filter((id) => !before.volumes.includes(id)),
    networks: after.networks.filter((id) => !before.networks.includes(id)),
  };
}

/** Every file under `directory` whose bytes hold `secret`, by relative path. */
export function filesHolding(directory, secret) {
  if (typeof secret !== "string" || secret === "") {
    throw new Error("filesHolding was given no secret to look for");
  }

  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && readFileSync(path).includes(secret)) {
        found.push(relative(directory, path));
      }
    }
  };

  walk(directory);

  return found.sort();
}

/** Refuses a directory inside the repository, judged by where it resolves. */
export function refuseInsideRepository(path, what, root = repositoryRoot) {
  let existing = resolve(path);

  while (!existsSync(existing)) existing = dirname(existing);

  const real = join(realpathSync(existing), relative(existing, resolve(path)));
  const within = relative(realpathSync(root), real);

  if (within === "" || (!within.startsWith("..") && !isAbsolute(within))) {
    throw new Error(
      `${what} ${path} is inside the repository; choose one outside it`,
    );
  }
}

/** The build record's tarballs, refused unless they are the run's fourteen. */
export function readBuildRecord(pack) {
  const record = JSON.parse(
    readFileSync(join(pack, "build-record.json"), "utf8"),
  );
  const names = (record.tarballs ?? []).map(({ name }) => name);
  const expected = [...LOCKSTEP, "requestport"];

  if (!isDeepStrictEqual(names, expected)) {
    throw new Error(
      `the build record names ${JSON.stringify(names)}, not ${JSON.stringify(expected)}`,
    );
  }

  for (const { file, size, integrity, name } of record.tarballs) {
    if (!TARBALL_FILE.test(file)) {
      throw new Error(
        `${name}'s file name is not one plain shell word: ${file}`,
      );
    }
    const bytes = readFileSync(join(pack, file));
    const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

    if (bytes.length !== size || digest !== integrity) {
      throw new Error(`${file} is not the build record's (size or sha512)`);
    }
  }

  return record;
}

function usage(message) {
  return [
    message,
    "",
    "Usage: node scripts/requestport-clean-machine.mjs --pack <directory> --storage pglite|pg [--out <directory>]",
  ].join("\n");
}

/** The storages the run takes, each the README's own start of it. */
export const STORAGES = Object.freeze(["pglite", "pg"]);

export function parseCommandLine(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pack: { type: "string" },
      storage: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.pack === undefined) throw new Error(usage("--pack is required"));
  if (!STORAGES.includes(values.storage)) {
    throw new Error(usage("--storage must be pglite or pg"));
  }

  return values;
}

const SIGNAL_EXIT = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
const pause = (ms) => new Promise((settle) => setTimeout(settle, ms));
const oneMinuteLoad = () => Number(loadavg()[0].toFixed(2));

/** The command: the steps in this file's header, in order. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseCommandLine(argv);
  const pack = resolve(options.pack);

  refuseInsideRepository(tmpdir(), "the temporary directory");
  if (options.out !== undefined) {
    refuseInsideRepository(options.out, "the run directory");
    if (existsSync(options.out) && readdirSync(options.out).length > 0) {
      throw new Error(`the run directory ${options.out} is not empty`);
    }
  }

  const record = readBuildRecord(pack);
  const tarballs = record.tarballs;
  const playwrightImage = driverImage();
  const onPg = options.storage === "pg";
  const journal = onPg
    ? journalOf(
        join(
          pack,
          tarballs.find(({ name }) => name === "@requestport/db").file,
        ),
      )
    : undefined;
  // Every docker command the run spawns goes through `docker`; `transcript`,
  // defined once the run directory is, is called on the first exec or run.
  const docker = createDocker({ transcript: (entry) => transcript(entry) });
  const query = (args, timeout) => docker.query(args, timeout);
  const version = query(["version", "--format", "{{.Server.Os}}"], 30_000);

  if (version.status !== 0) {
    throw new Error(
      "docker did not answer `docker version` within 30 s; the run needs Docker",
    );
  }

  const out = resolve(
    options.out ??
      mkdtempSync(join(tmpdir(), "requestport-clean-machine-run-")),
  );

  mkdirSync(out, { recursive: true });

  const run = `h8-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let staging;
  // The secrets the run holds: on pg the database password, which the owner
  // URL carries, from when it is made (step 3); the owner's local credential
  // once `start` has printed it. Held here so that `redact` can take them out
  // of what the run writes, and `finish` can look for each in every file the
  // run kept.
  const held = [];
  const secrets = () => held.map(({ value }) => value);
  const summary = {
    run,
    started: new Date().toISOString(),
    load: { start: oneMinuteLoad() },
    tmpdir: tmpdir(),
    out,
    storage: options.storage,
    buildRecord: {
      commit: record.commit,
      treeStatus: record.treeStatus,
      node: record.node,
      pnpm: record.pnpm,
    },
    tarballs: tarballs.map(({ name, file, size, integrity }) => ({
      name,
      file,
      size,
      integrity,
    })),
    steps: {},
    problems: [],
  };
  // A creation may pull its image first. Each `docker run` is the harness
  // command `docker run`, transcribed as it is spawned.
  const ledger = createLedger((args, environment) =>
    args[0] === "run"
      ? docker.exec(harnessCommand("docker run", args), {
          timeout: 600_000,
          environment,
        })
      : query(args, 600_000),
  );
  let before;
  let finished = false;

  const transcript = (entry) =>
    appendFileSync(
      join(out, RUN_FILES.transcript),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  /** A harness command, run in its container and waited for. */
  const inContainer = (name, args, options) =>
    docker.exec(harnessCommand(name, args), options);
  const say = (text) =>
    console.log(`requestport-clean-machine ${run}: ${text}`);

  /** Removes the containers, counts what is left, writes the summary. */
  const finish = (exitCode) => {
    if (finished) return exitCode;
    finished = true;

    for (const child of docker.inflight) child.kill("SIGTERM");
    summary.removed = ledger.teardown();
    try {
      summary.left =
        before === undefined
          ? { containers: [], volumes: [], networks: [] }
          : leftoverCounts(query, { run, before });
    } catch (error) {
      summary.left = { error: String(error.message) };
    }
    if (staging !== undefined) {
      rmSync(staging, { force: true, recursive: true });
      summary.stagingRemoved = !existsSync(staging);
    }

    const left = summary.left;
    const leftCount =
      left.error === undefined
        ? left.containers.length + left.volumes.length + left.networks.length
        : 1;

    if (leftCount > 0) {
      summary.problems.push(`left behind: ${JSON.stringify(left)}`);
    }
    for (const { what, value } of held) {
      for (const file of filesHolding(out, value)) {
        summary.problems.push(`${file} in the run directory holds ${what}`);
      }
      if (JSON.stringify(summary).includes(value)) {
        summary.problems.push(
          `the summary held ${what}; it is written redacted`,
        );
      }
    }
    summary.load.end = oneMinuteLoad();
    summary.ended = new Date().toISOString();

    const code =
      exitCode !== 0 ? exitCode : summary.problems.length > 0 ? 1 : 0;

    summary.exitCode = code;
    writeFileSync(
      join(out, RUN_FILES.summary),
      `${redact(JSON.stringify(summary, null, 2), secrets())}\n`,
    );
    say(
      `exit ${code}; ${summary.problems.length} problem(s); left ${leftCount}; the run directory is ${out}`,
    );
    for (const problem of summary.problems) {
      say(`problem: ${redact(problem, secrets())}`);
    }

    return code;
  };

  const onSignal = (signal) => {
    summary.signal = signal;
    process.exit(finish(SIGNAL_EXIT[signal]));
  };
  // An exception nothing catches, or a rejection nothing handles, ends the
  // run as an exception `main` catches does: a problem, then `finish`.
  const ended = (how) => (error) => {
    summary.problems.push(
      `${how} ended the run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(finish(1));
  };
  const onUncaught = ended("an uncaught exception");
  const onUnhandled = ended("an unhandled rejection");

  for (const signal of Object.keys(SIGNAL_EXIT)) process.on(signal, onSignal);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  try {
    // 2. Staging, after the signal handlers, so that a signal removes it.
    staging = realpathSync(
      mkdtempSync(join(tmpdir(), "requestport-clean-machine-")),
    );
    summary.staging = staging;

    const stagedTarballs = join(staging, "tarballs");
    const stagedReadme = join(staging, "readme", "README.md");
    const stagedHarness = join(staging, "harness-clean");
    const stagedDriver = join(staging, "harness-driver");

    mkdirSync(stagedTarballs);
    mkdirSync(dirname(stagedReadme));
    mkdirSync(stagedHarness);
    for (const { file } of tarballs) {
      copyFileSync(join(pack, file), join(stagedTarballs, file));
    }
    summary.agentBundle = await stageCleanHarness(stagedHarness);
    stageDriverHarness(stagedDriver);

    const extracted = spawnSync(
      "tar",
      [
        "-xzOf",
        join(stagedTarballs, tarballs.at(-1).file),
        "package/README.md",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );

    if (extracted.status !== 0 || extracted.stdout === "") {
      throw new Error(
        `requestport's tarball holds no package/README.md: ${extracted.stderr}`,
      );
    }

    const readme = extracted.stdout;

    writeFileSync(stagedReadme, readme);
    summary.readme = {
      sha256: createHash("sha256").update(readme).digest("hex"),
    };

    // 3. The clean container.
    const image = nodeImage();
    const clean = `${run}-clean`;

    before = dockerInventory(query);

    const args = cleanContainerArguments({
      run,
      name: clean,
      image,
      tarballs: stagedTarballs,
      readme: stagedReadme,
      harness: stagedHarness,
    });

    ledger.create(clean, args);

    const inspected = query([
      "image",
      "inspect",
      image,
      "--format",
      "{{.Id}} {{json .RepoDigests}}",
    ]);

    summary.images = { clean: { image, inspect: inspected.stdout.trim() } };

    const inspectArgs = ["exec", clean, "node", "-e", INSPECT_SCRIPT];

    const facts = JSON.parse(
      inContainer("inspect", inspectArgs).stdout || "{}",
    );

    summary.steps.inspect = facts;
    summary.problems.push(...inspectProblems(facts, tarballs));

    // On pg, the database container, in the clean container's namespace. It
    // initialises while README 24 installs.
    const database = onPg ? `${run}-database` : undefined;
    let password;

    if (onPg) {
      password = databasePassword();
      held.push({ what: "the database password", value: password });

      const databaseArgs = databaseContainerArguments({
        run,
        name: database,
        clean,
        image: DATABASE_IMAGE,
      });

      ledger.create(database, databaseArgs, { POSTGRES_PASSWORD: password });
      summary.steps.database = { created: new Date().toISOString() };
      summary.images.database = {
        image: DATABASE_IMAGE,
        inspect: query([
          "image",
          "inspect",
          DATABASE_IMAGE,
          "--format",
          "{{.Id}} {{json .RepoDigests}}",
        ]).stdout.trim(),
      };
    }

    /**
     * The agent, given one command on standard input in `cwd`: its answer,
     * or `{ ok: false, error }` when it gave none. Its standard error, and
     * each bridge's, go to files of the run directory, redacted; the answer
     * keeps each bridge's standard error for the judges, and the summary
     * keeps its size and its file's name only (`summaryOfAgent`).
     */
    const askAgent = async (label, fields, { cwd = CONTAINER_HOME } = {}) => {
      const args = ["exec", "-i", "-w", cwd, clean, "node", AGENT_IN_CONTAINER];

      const agent = docker.start(harnessCommand("agent", args), {
        input: true,
        timeout: 900_000,
      });

      transcript({ kind: "agent", label, cwd, ...fields });

      agent.child.stdin.on("error", () => {});
      agent.child.stdin.end(`${JSON.stringify(fields)}\n`);

      const ended = await agent.done;
      const last = lines(ended.stdout).at(-1);
      let answer;

      try {
        answer = JSON.parse(last ?? "");
      } catch {
        answer = undefined;
      }
      if (answer === null || typeof answer !== "object") {
        answer = {
          ok: false,
          error: `the agent exited ${ended.status}${ended.timedOut ? " (timed out)" : ""} with no answer`,
          bridges: [],
        };
      }
      writeFileSync(
        join(out, `agent-${label}.stderr`),
        redact(ended.stderr, secrets()),
      );
      for (const [index, bridge] of (answer.bridges ?? []).entries()) {
        writeFileSync(
          join(out, `bridge-${label}-${index + 1}.stderr`),
          redact(String(bridge.stderr ?? ""), secrets()),
        );
      }

      return { ...answer, status: ended.status };
    };

    // The agent's bundle loads in the clean container.
    const loaded = await askAgent("load", { command: "load" });

    summary.steps.agentLoad = {
      status: loaded.status,
      ok: loaded.ok,
      result: loaded.result,
      error: loaded.error,
    };
    if (
      loaded.ok !== true ||
      loaded.result?.client !== true ||
      loaded.result?.stdioTransport !== true
    ) {
      summary.problems.push(
        `the agent did not load its MCP client in the clean container: ${loaded.error ?? JSON.stringify(loaded.result)}`,
      );
    }

    /**
     * The only way the run issues a README line in the clean container: the
     * line, refused unless the README's sh blocks hold it, substituted and
     * its slots filled (`readmeCommand`), in the transcript with the
     * directory it runs in and the `docker exec` that runs it, then given to
     * the container's shell there.
     */
    const issueReadmeLine = (
      line,
      { capture, timeout, cwd = CONTAINER_HOME, slots } = {},
    ) => {
      const { entry } = readmeCommand(line, {
        readme,
        tarballs,
        slots,
        cwd,
        capture,
        clean,
      });

      return docker.start(entry, { timeout });
    };

    // 4. README 24, cold.
    const versionLine = readmeLine(readme, README_STEPS.version);
    let began = Date.now();
    const cold = await issueReadmeLine(versionLine.line, { timeout: 1_200_000 })
      .done;

    writeFileSync(join(out, "cold-version.stderr"), cold.stderr);
    summary.steps.coldVersion = {
      readmeLine: versionLine.number,
      status: cold.status,
      ms: Date.now() - began,
      stdout: cold.stdout.trim(),
      timedOut: cold.timedOut,
      fetches: fetchCounts(cold.stderr),
    };
    summary.problems.push(...summary.steps.coldVersion.fetches.problems);
    say(
      `README ${versionLine.number}, cold: exit ${cold.status} in ${summary.steps.coldVersion.ms} ms`,
    );
    if (
      cold.status !== 0 ||
      cold.stdout.trim() !== `requestport ${tarballs.at(-1).version}`
    ) {
      throw new Error(
        `README ${versionLine.number} exited ${cold.status} and printed ${JSON.stringify(cold.stdout.trim())}`,
      );
    }

    // 5. The one npx directory.
    const npxArgs = ["exec", clean, "sh", "-c", 'ls -d "$HOME"/.npm/_npx/*/'];

    const npxDirectories = lines(inContainer("npx directory", npxArgs).stdout);

    if (npxDirectories.length !== 1) {
      throw new Error(
        `npx installed into ${npxDirectories.length} directories, not one`,
      );
    }

    const npxDirectory = npxDirectories[0].replace(/\/$/u, "");
    const lsArgs = ["exec", "-w", npxDirectory, clean, "npm", "ls", "--all"];

    const ls = inContainer("npm ls", lsArgs);
    const lockArgs = [
      "exec",
      clean,
      "cat",
      `${npxDirectory}/package-lock.json`,
    ];

    const lock = JSON.parse(
      inContainer("npx lockfile", lockArgs).stdout || "{}",
    );

    writeFileSync(join(out, "npm-ls.txt"), ls.stdout);
    summary.steps.install = {
      directory: npxDirectory,
      lsStatus: ls.status,
      lsLines: lines(ls.stdout).length,
      requestportLines: lines(ls.stdout).filter(
        (line) => /@requestport\//u.test(line) && !/ deduped$/u.test(line),
      ),
      lsFetches: fetchCounts(ls.stderr).completed,
      problems: installProblems({
        ls: ls.stdout,
        lsStatus: ls.status,
        lock,
        tarballs,
      }),
    };
    summary.problems.push(...summary.steps.install.problems);

    /**
     * One JSON value read through `psql` in the database container, over its
     * socket, as the image's superuser: a harness command, not a README one.
     */
    const psql = (sql) => {
      const psqlArgs = ["exec", database, ...psqlWords(sql)];

      const read = inContainer("psql", psqlArgs);

      if (read.status !== 0) {
        throw new Error(
          `psql in the database container exited ${read.status}: ${redact(String(read.stderr).trim(), secrets())}`,
        );
      }

      return JSON.parse(read.stdout);
    };

    // 6. On PGlite, README 33. On PostgreSQL, the database ready, the owner
    // URL in its file, then README 58 and README 59.
    let startLine;

    if (onPg) {
      const readyArgs = ["exec", database, ...DATABASE_READINESS_WORDS];
      const waited = Date.now();
      let ready = false;
      let polls = 0;

      while (!ready && Date.now() - waited < 120_000) {
        polls += 1;
        ready =
          inContainer("database readiness", readyArgs, { timeout: 30_000 })
            .status === 0;
        if (!ready) await pause(500);
      }
      summary.steps.database.ready = { waitedMs: Date.now() - waited, polls };
      if (!ready) {
        throw new Error(
          "the database did not accept connections on 127.0.0.1 within 120 s",
        );
      }

      const rules = psql(DATABASE_SQL.hba);

      summary.steps.database.rules = rules;
      summary.problems.push(...hbaProblems(rules));

      const chmodLine = readmeLine(readme, README_STEPS.ownerUrlMode);

      startLine = readmeLine(readme, README_STEPS.startPg);

      const file = ownerUrlFileOf({
        chmod: chmodLine.line,
        start: startLine.line,
      });
      const writeArgs = [
        "exec",
        "-i",
        "-w",
        CONTAINER_HOME,
        clean,
        "sh",
        "-c",
        'cat > "$1" && stat -c "%a %u" "$1"',
        "sh",
        file,
      ];

      const written = inContainer("owner url", writeArgs, {
        input: `${ownerUrlOf(password)}\n`,
      });

      if (written.status !== 0) {
        throw new Error(`the owner URL was not written to ${file}`);
      }

      const chmodded = await issueReadmeLine(chmodLine.line, {
        timeout: 60_000,
      }).done;
      const modeArgs = [
        "exec",
        "-w",
        CONTAINER_HOME,
        clean,
        "stat",
        "-c",
        "%a %u",
        file,
      ];

      const mode = inContainer("owner url mode", modeArgs).stdout.trim();

      summary.steps.ownerUrl = {
        file: `${CONTAINER_HOME}/${file}`,
        written: written.stdout.trim(),
        chmod: { readmeLine: chmodLine.number, status: chmodded.status },
        after: mode,
      };
      if (chmodded.status !== 0 || mode !== "600 1000") {
        summary.problems.push(
          `README ${chmodLine.number} exited ${chmodded.status} and left ${file} at "${mode}", not "600 1000"`,
        );
      }
    } else {
      startLine = readmeLine(readme, README_STEPS.startPglite);
    }

    began = Date.now();
    const start = issueReadmeLine(startLine.line, { capture: START_STDERR });
    let startClosed;
    void start.done.then((result) => {
      startClosed = result;
    });

    const stderrArgs = ["exec", clean, "cat", START_STDERR];
    let stderr = "";
    let url;

    while (
      url === undefined &&
      startClosed === undefined &&
      Date.now() - began < 300_000
    ) {
      await pause(1000);
      stderr = inContainer("start stderr", stderrArgs).stdout ?? "";
      url = servingUrl(stderr);
    }

    summary.steps.start = {
      readmeLine: startLine.number,
      servingAfterMs: Date.now() - began,
      url,
    };
    if (url === undefined) {
      writeFileSync(join(out, "start.stderr"), redact(stderr, secrets()));
      throw new Error(
        `README ${startLine.number} did not serve within 300 s (${startClosed === undefined ? "still running" : `exited ${startClosed.status}`})`,
      );
    }
    say(
      `README ${startLine.number}: serving ${url} after ${summary.steps.start.servingAfterMs} ms`,
    );

    // The credential's line, a turn at a time, until it has arrived, start
    // has ended or the bound has passed (`CREDENTIAL_WAIT_MS`); then
    // `credentialFrom` reads what there is and refuses anything but one.
    const servedAt = Date.now();

    while (
      !credentialLineIn(start.output()) &&
      startClosed === undefined &&
      Date.now() - servedAt < CREDENTIAL_WAIT_MS
    ) {
      await pause(100);
    }

    const { credential, lines: stdoutLines } = credentialFrom(start.output());

    held.push({ what: "the local credential", value: credential });

    summary.steps.start.stdout = {
      lines: stdoutLines,
      credentialShaped: 1,
      credentialAfterServingMs: Date.now() - servedAt,
    };

    // On pg, what start left on the server: the journal, the instance's four
    // logins, and the sessions open while it serves.
    let loginNames = [];
    /** The sessions open on the database now, judged by `sessionProblems`. */
    const sessionsAt = (key, when, stopped = false) => {
      const sessions = psql(DATABASE_SQL.sessions);

      summary.steps.server[key] = sessions;
      summary.problems.push(
        ...sessionProblems({ sessions, logins: loginNames, when, stopped }),
      );
    };

    if (onPg) {
      const applied = psql(DATABASE_SQL.migrations);
      const logins = psql(DATABASE_SQL.logins);

      loginNames = logins.map(({ login }) => login);
      summary.steps.server = {
        migrations: {
          applied: applied.length,
          journal: journal.entries.length,
          last: journal.entries.at(-1).tag,
          problems: migrationProblems({ applied, journal }),
        },
        logins: {
          names: loginNames,
          problems: instanceLoginProblems({ logins, database: DATABASE_NAME }),
        },
      };
      summary.problems.push(
        ...summary.steps.server.migrations.problems,
        ...summary.steps.server.logins.problems,
      );
      sessionsAt("sessionsWhileServing", "once start served");
      say(
        `the server holds ${applied.length} applied migration(s) and the logins ${JSON.stringify(summary.steps.server.logins.names)}`,
      );
    }

    // 7. The driver container, in the namespace; readiness from it.
    const driver = `${run}-driver`;
    const driverArgs = driverContainerArguments({
      run,
      name: driver,
      clean,
      image: playwrightImage,
      harness: stagedDriver,
    });

    ledger.create(driver, driverArgs);
    summary.images.driver = {
      image: playwrightImage,
      inspect: query([
        "image",
        "inspect",
        playwrightImage,
        "--format",
        "{{.Id}} {{json .RepoDigests}}",
      ]).stdout.trim(),
    };

    const driverInspectArgs = [
      "exec",
      driver,
      "node",
      "-e",
      DRIVER_INSPECT_SCRIPT,
    ];

    summary.steps.driver = JSON.parse(
      inContainer("driver inspect", driverInspectArgs).stdout || "{}",
    );
    if (summary.steps.driver.playwrightCore !== playwrightVersions().core) {
      summary.problems.push(
        `the driver container's playwright-core is ${summary.steps.driver.playwrightCore}, not the one staged`,
      );
    }

    const readinessArgs = ["exec", driver, "node", "-e", READINESS_SCRIPT, url];

    const readiness = JSON.parse(
      inContainer("readiness", readinessArgs).stdout || "{}",
    );

    summary.steps.readiness = readiness;
    if (
      readiness.ready?.status !== 200 ||
      readiness.ready?.body !== '{"ready":true}'
    ) {
      summary.problems.push(
        `readiness answered ${JSON.stringify(readiness.ready ?? readiness)}`,
      );
    }
    if (readiness.signIn?.status !== 200) {
      summary.problems.push(
        `/sign-in answered ${JSON.stringify(readiness.signIn ?? readiness)}`,
      );
    }

    // 8. The person, in Chromium and then in WebKit, and the agent in each
    // one's checkout.
    const owner = ownerOf(startLine.line);
    const loginLine = readmeLine(readme, README_STEPS.login);
    const linkLine = readmeLine(readme, README_STEPS.link);
    const loginApiLine = readmeLine(readme, README_STEPS.loginApi);
    const loginServer = /\s--server\s+(\S+)/u.exec(loginLine.line)?.[1];

    for (const line of [loginLine, linkLine]) {
      const named = /\s--server\s+(\S+)/u.exec(line.line)?.[1];

      if (named !== url) {
        throw new Error(
          `README ${line.number} names the server ${named}, and start serves ${url}`,
        );
      }
    }

    const configuration = mcpConfiguration({ readme, tarballs });
    const personArgs = ["exec", "-i", driver, "node", PERSON_IN_CONTAINER];

    const personProcess = docker.start(harnessCommand("person", personArgs), {
      input: true,
    });
    const person = personClient({
      child: personProcess.child,
      transcript,
      timeoutMs: 300_000,
    });
    const ask = async (command, fields) => {
      const answer = await person.ask(command, fields);

      for (const error of answer.serverErrors ?? []) {
        summary.problems.push(
          `${fields.browser}: ${command}: the page received ${error}`,
        );
      }

      return answer;
    };

    // The bound resolves rather than rejects: a rejection nobody awaits once
    // the person has answered would end the process past `finish`.
    const personReady = await Promise.race([
      person.ready,
      pause(120_000).then(() => undefined),
    ]);

    if (personReady === undefined) {
      throw new Error("the person did not start within 120 s");
    }
    summary.steps.person = { ready: personReady };

    const processesArgs = ["exec", clean, "node", "-e", PROCESSES_SCRIPT];
    const processes = () =>
      JSON.parse(inContainer("processes", processesArgs).stdout || "[]");

    /**
     * A README `login` line, issued in `cwd`, its consent approved by the
     * person: the URL from its standard error, then the consent in the
     * project and with the principal given, then its exit. Its standard
     * error goes to `<label>.stderr`, redacted.
     */
    const consentedLogin = async ({
      browser,
      line,
      cwd,
      project,
      principal,
      label,
    }) => {
      const loginBegan = Date.now();
      const login = issueReadmeLine(line.line, { cwd, timeout: 600_000 });
      let loginClosed;
      let authorization;

      void login.done.then((result) => {
        loginClosed = result;
      });
      while (
        authorization === undefined &&
        loginClosed === undefined &&
        Date.now() - loginBegan < 180_000
      ) {
        await pause(500);
        authorization = authorizationUrl(login.errors());
      }
      if (authorization === undefined) {
        throw new Error(
          `${browser}: README ${line.number} printed no authorization URL within 180 s (${loginClosed === undefined ? "still running" : `exited ${loginClosed.status}`})`,
        );
      }

      const urlAfterMs = Date.now() - loginBegan;
      const consent = await ask("consent", {
        browser,
        url: authorization.url,
        project,
        principal,
      });
      const ended = await Promise.race([
        login.done,
        pause(120_000).then(() => undefined),
      ]);

      if (ended === undefined) {
        throw new Error(
          `${browser}: README ${line.number} did not exit within 120 s of the consent`,
        );
      }
      writeFileSync(
        join(out, `${label}.stderr`),
        redact(ended.stderr, secrets()),
      );

      return {
        readmeLine: line.number,
        cwd,
        audienceAsked: authorization.audience,
        urlAfterMs,
        status: ended.status,
        ms: Date.now() - loginBegan,
        stdoutLines: lines(ended.stdout).length,
        stored: storedCredentials(ended.stdout),
        fetches: fetchCounts(ended.stderr),
        consent: { principal, ...consent.result },
      };
    };

    /** An agent's answer as the summary keeps it: no bridge's standard error. */
    const summaryOfAgent = (label, answer) => ({
      ...answer,
      bridges: (answer.bridges ?? []).map(({ stderr, ...bridge }, index) => ({
        ...bridge,
        stderrFile: `bridge-${label}-${index + 1}.stderr`,
        stderrLines: lines(stderr).length,
        fetches: fetchCounts(String(stderr ?? "")),
      })),
    });

    /**
     * The bridges left in the clean container after the agent's `step`, each
     * a problem; read until none is left, for 10 s at most.
     */
    const bridgesLeft = async (browser, step) => {
      const waited = Date.now();
      let left = bridgeProcesses(processes());

      while (left.length > 0 && Date.now() - waited < 10_000) {
        await pause(500);
        left = bridgeProcesses(processes());
      }
      for (const { pid, cmd } of left) {
        summary.problems.push(
          `${browser}: a bridge is left after the agent's ${step}: ${pid} ${cmd}`,
        );
      }

      return left.length;
    };

    /**
     * What the credential file holds for the project, read by the agent; on
     * pg, with the server's OAuth clients and refresh tokens as `server`.
     */
    const credentialsAt = async (browser, label, projectId) => {
      const answer = await askAgent(`${browser}-credentials-${label}`, {
        command: "credentials",
        server: url,
        projectId,
      });

      if (answer.ok !== true) {
        throw new Error(
          `${browser}: the agent did not read the credential file: ${answer.error}`,
        );
      }

      return onPg
        ? { ...answer.result, server: psql(DATABASE_SQL.oauth) }
        : answer.result;
    };

    for (const browser of BROWSERS) {
      const plan = personPlan(browser, run);
      const steps = { project: plan.project };
      const projectOption = `${owner.organizationName} / ${plan.project.name}`;

      summary.steps.person[browser] = steps;

      const signedIn = await ask("signIn", {
        browser,
        base: url,
        email: owner.email,
        credential,
      });

      steps.browserVersion = signedIn.browserVersion;
      steps.signIn = signedIn.result;
      say(`${browser}: signed in as ${owner.email}`);

      const created = await ask("createProject", {
        browser,
        base: url,
        ...plan.project,
      });

      steps.project = { ...plan.project, ...created.result };
      say(
        `${browser}: created ${plan.project.name}, ${created.result.projectId}`,
      );

      const unfiled = await ask("seeRequest", {
        browser,
        base: url,
        title: plan.requestTitle,
        within: 5_000,
      });

      steps.requestBeforeFiling = {
        title: plan.requestTitle,
        ...unfiled.result,
      };
      if (unfiled.result.shown !== false) {
        summary.problems.push(
          `${browser}: /requests shows ${JSON.stringify(plan.requestTitle)} before anyone filed it`,
        );
      }

      // The checkout the agent works in.
      const checkoutArgs = ["exec", clean, "mkdir", "-p", plan.checkout];

      if (inContainer("checkout", checkoutArgs).status !== 0) {
        throw new Error(`${browser}: ${plan.checkout} was not made`);
      }
      steps.checkout = plan.checkout;

      // README 139 in the checkout; the mcp consent, with a new principal.
      steps.login = await consentedLogin({
        browser,
        line: loginLine,
        cwd: plan.checkout,
        project: projectOption,
        principal: { new: { slug: plan.principalSlug } },
        label: `login-${browser}`,
      });
      steps.problems = loginProblems({
        browser,
        login: steps.login,
        server: loginServer,
        projectId: steps.project.projectId,
        consent: steps.login.consent,
      });
      summary.problems.push(...steps.problems);
      say(
        `${browser}: README ${loginLine.number} exited ${steps.login.status}; ${steps.problems.length} problem(s)`,
      );
      if (steps.login.stored.length !== 1) {
        throw new Error(
          `${browser}: README ${loginLine.number} stored ${steps.login.stored.length} credential(s), so there is no one project id to link`,
        );
      }

      // The project id README 148's slot is filled with, from login's line.
      const { projectId, organizationId } = steps.login.stored[0];

      // README 148 in the checkout.
      const linkBegan = Date.now();
      const linked = await issueReadmeLine(linkLine.line, {
        cwd: plan.checkout,
        slots: { "<project id>": projectId },
        timeout: 300_000,
      }).done;

      writeFileSync(
        join(out, `link-${browser}.stderr`),
        redact(linked.stderr, secrets()),
      );

      const bindingArgs = [
        "exec",
        clean,
        "cat",
        `${plan.checkout}/.requestport/project.json`,
      ];

      let binding;

      try {
        binding = JSON.parse(inContainer("binding", bindingArgs).stdout);
      } catch {
        binding = null;
      }
      steps.link = {
        readmeLine: linkLine.number,
        cwd: plan.checkout,
        status: linked.status,
        timedOut: linked.timedOut,
        ms: Date.now() - linkBegan,
        stdout: lines(linked.stdout),
        fetches: fetchCounts(linked.stderr),
        binding,
      };
      steps.link.problems = linkProblems({
        browser,
        link: {
          readmeLine: linkLine.number,
          status: linked.status,
          stdout: linked.stdout,
          stderr: linked.stderr,
          fetches: steps.link.fetches,
        },
        server: url,
        projectId,
        organizationId,
        slug: plan.project.slug,
        checkout: plan.checkout,
        binding,
      });
      summary.problems.push(...steps.link.problems);
      say(
        `${browser}: README ${linkLine.number} exited ${linked.status}; ${steps.link.problems.length} problem(s)`,
      );

      // README 169 in the checkout; the api consent, with the principal the
      // first consent made.
      steps.loginApi = await consentedLogin({
        browser,
        line: loginApiLine,
        cwd: plan.checkout,
        project: projectOption,
        principal: { existing: principalOption(owner) },
        label: `login-api-${browser}`,
      });
      steps.loginApi.problems = loginProblems({
        browser,
        login: steps.loginApi,
        server: url,
        projectId,
        consent: steps.loginApi.consent,
        audience: "api",
      });
      summary.problems.push(...steps.loginApi.problems);
      say(
        `${browser}: README ${loginApiLine.number} exited ${steps.loginApi.status}; ${steps.loginApi.problems.length} problem(s)`,
      );

      // README 156-163, the one substitution in its args, in the checkout.
      const configurationPath = `${plan.checkout}/${MCP_CONFIGURATION_FILE}`;
      const configurationArgs = [
        "exec",
        "-i",
        clean,
        "sh",
        "-c",
        'cat > "$1"',
        "sh",
        configurationPath,
      ];

      transcript({
        kind: "configuration",
        readmeLines: { from: configuration.from, to: configuration.to },
        readme: configuration.readme,
        written: configuration.text,
        path: configurationPath,
      });
      if (
        inContainer("mcp configuration", configurationArgs, {
          input: configuration.text,
        }).status !== 0
      ) {
        throw new Error(`${browser}: ${configurationPath} was not written`);
      }
      steps.configuration = configurationPath;

      // The agent: one bridge files the request; two at once, then one
      // alone, each ask whoami; each a refresh of the stored mcp credential.
      const judgeBridges = (step, answer, bridges, whoami) =>
        bridgeProblems({
          browser,
          step,
          answer,
          bridges,
          whoami,
          server: url,
          projectId,
          organizationId,
          slug: plan.project.slug,
        });
      /**
       * A step that spent the stored `audience` credential `issued` times,
       * once per bridge or once for the HTTP client: judged in the
       * credential file and, on pg, on the server.
       */
      const spent = ({ step, audience, before, after, issued }) => {
        const judged = { browser, step, audience, before, after };

        summary.problems.push(
          ...rotationProblems(judged),
          ...(onPg ? refreshCountProblems({ ...judged, issued }) : []),
        );
      };
      const snapshots = {
        beforeFile: await credentialsAt(browser, "before-file", projectId),
      };
      const agentIn = { cwd: plan.checkout };
      const filed = await askAgent(
        `${browser}-file`,
        {
          command: "file",
          cwd: plan.checkout,
          configuration: configurationPath,
          title: plan.requestTitle,
          descriptionMd: plan.requestDescription,
          targetProjectId: projectId,
          timeoutMs: 300_000,
        },
        agentIn,
      );

      steps.file = summaryOfAgent(`${browser}-file`, filed);
      summary.problems.push(...judgeBridges("file", filed, 1, false));
      await bridgesLeft(browser, "file");
      snapshots.afterFile = await credentialsAt(
        browser,
        "after-file",
        projectId,
      );
      spent({
        step: "the agent's file",
        audience: "mcp",
        before: snapshots.beforeFile,
        after: snapshots.afterFile,
        issued: 1,
      });

      const submitted = filed.result?.submitted;

      if (filed.ok !== true || typeof submitted?.id !== "string") {
        throw new Error(
          `${browser}: the agent filed no request: ${filed.error}`,
        );
      }
      say(
        `${browser}: the agent filed ${submitted.id} (${submitted.state}) through one bridge`,
      );

      let previous = snapshots.afterFile;

      for (const [step, bridges, key] of [
        ["pair", 2, "afterPair"],
        ["alone", 1, "afterAlone"],
      ]) {
        const answer = await askAgent(
          `${browser}-${step}`,
          {
            command: "whoami",
            cwd: plan.checkout,
            configuration: configurationPath,
            bridges,
            timeoutMs: 300_000,
          },
          agentIn,
        );

        steps[step] = summaryOfAgent(`${browser}-${step}`, answer);
        summary.problems.push(...judgeBridges(step, answer, bridges, true));
        await bridgesLeft(browser, step);

        const after = await credentialsAt(browser, `after-${step}`, projectId);

        spent({
          step: `the agent's ${step}`,
          audience: "mcp",
          before: previous,
          after,
          issued: bridges,
        });
        snapshots[key] = after;
        previous = after;
        say(
          `${browser}: the agent's ${step}, ${bridges} bridge(s): ${answer.ok === true ? "whoami from each" : answer.error}`,
        );
      }

      // The request through the packed HTTP client, a refresh of the api
      // credential.
      const read = await askAgent(
        `${browser}-http`,
        { command: "http", server: url, projectId, requestId: submitted.id },
        agentIn,
      );

      steps.http = summaryOfAgent(`${browser}-http`, read);
      summary.problems.push(
        ...requestProblems({
          browser,
          answer: read,
          requestId: submitted.id,
          title: plan.requestTitle,
          state: submitted.state,
          projectId,
          organizationId,
        }),
      );
      snapshots.afterHttp = await credentialsAt(
        browser,
        "after-http",
        projectId,
      );
      spent({
        step: "the packed HTTP client",
        audience: "api",
        before: previous,
        after: snapshots.afterHttp,
        issued: 1,
      });
      steps.credentials = snapshots;

      // The request, seen by the person.
      const seen = await ask("seeRequest", {
        browser,
        base: url,
        title: plan.requestTitle,
        within: 30_000,
      });

      steps.requestSeen = { title: plan.requestTitle, ...seen.result };
      if (seen.result.shown !== true) {
        summary.problems.push(
          `${browser}: /requests does not show ${JSON.stringify(plan.requestTitle)}, which the agent filed`,
        );
      }
      say(
        `${browser}: /requests ${seen.result.shown === true ? "shows" : "does not show"} the request`,
      );
    }

    await ask("close", {});

    const personEnded = await Promise.race([
      personProcess.done,
      pause(30_000).then(() => undefined),
    ]);

    summary.steps.person.exit =
      personEnded === undefined
        ? "still running after 30 s"
        : { status: personEnded.status, signal: personEnded.signal };
    writeFileSync(
      join(out, "person.stderr"),
      redact(personProcess.errors(), secrets()),
    );

    // The npx directory after every bridge's npx installed into it.
    const npxAfter = lines(inContainer("npx directory", npxArgs).stdout).map(
      (directory) => directory.replace(/\/$/u, ""),
    );

    const lsAfter = inContainer("npm ls", lsArgs);
    const lockAfter = JSON.parse(
      inContainer("npx lockfile", lockArgs).stdout || "{}",
    );

    writeFileSync(join(out, "npm-ls-after-agents.txt"), lsAfter.stdout);
    summary.steps.installAfterAgents = {
      directories: npxAfter,
      lsStatus: lsAfter.status,
      lsLines: lines(lsAfter.stdout).length,
      problems: [
        ...(isDeepStrictEqual(npxAfter, [npxDirectory])
          ? []
          : [
              `after the agents, npx installed into ${JSON.stringify(npxAfter)}, not ${npxDirectory} alone`,
            ]),
        ...installProblems({
          ls: lsAfter.stdout,
          lsStatus: lsAfter.status,
          lock: lockAfter,
          tarballs,
        }).map((problem) => `after the agents, ${problem}`),
      ],
    };
    summary.problems.push(...summary.steps.installAfterAgents.problems);

    // 9. The stop.
    if (onPg) sessionsAt("sessionsBeforeStop", "before the stop");

    const serving = processes();
    const npx = startProcess(serving);
    const kill = stopCommand(npx);
    const stopArgs = ["exec", clean, "sh", "-c", kill];

    const stopped = inContainer("stop", stopArgs);
    const stopBegan = Date.now();
    const closed = await Promise.race([
      start.done,
      pause(60_000).then(() => undefined),
    ]);
    let left = processes().filter((entry) => !ownProcess(entry));

    while (left.length > 0 && Date.now() - stopBegan < 30_000) {
      await pause(1000);
      left = processes().filter((entry) => !ownProcess(entry));
    }

    stderr = inContainer("start stderr", stderrArgs).stdout ?? "";

    const portArgs = [
      "exec",
      driver,
      "node",
      "-e",
      PORT_SCRIPT,
      String(new URL(url).port),
    ];

    const port = inContainer("port", portArgs).stdout.trim();

    summary.steps.stop = {
      whileServing: serving,
      command: kill,
      killStatus: stopped.status,
      startExit:
        closed === undefined
          ? "still running after 60 s"
          : { status: closed.status, signal: closed.signal },
      afterMs: Date.now() - stopBegan,
      left,
      port,
      stoppedLine: /^requestport start: stopped:.*$/mu.exec(stderr)?.[0],
      problems: stopProblems({ stderr, left, port }),
    };
    summary.problems.push(...summary.steps.stop.problems);

    const stderrHolds = held.filter(({ value }) => stderr.includes(value));

    if (stderrHolds.length > 0) {
      for (const { what } of stderrHolds) {
        summary.problems.push(
          `start's standard error holds ${what}; it is not written`,
        );
      }
    } else {
      writeFileSync(join(out, "start.stderr"), stderr);
    }
    if (onPg) sessionsAt("sessionsAfterStop", "after the stop", true);
    summary.steps.start.handoffRefusalLines = (
      stderr.match(/HostHandoffRefusalError:/gu) ?? []
    ).length;
    summary.problems.push(...startStderrProblems(stderr));

    // The in-process worker: its ready line, and its log on start's standard
    // output, read by event name and count only (that output holds the
    // credential, so it is never written).
    const startStdout = closed?.stdout ?? start.output();

    summary.steps.start.events = startEvents(startStdout);
    summary.steps.start.failures = startFailures(startStdout);
    summary.steps.start.workerProblems = workerProblems({
      storage: options.storage,
      url,
      stderr,
      events: summary.steps.start.events,
    });
    summary.problems.push(...summary.steps.start.workerProblems);
    summary.steps.start.fetches = fetchCounts(stderr);
    summary.problems.push(...summary.steps.start.fetches.problems);

    const sizeArgs = ["exec", clean, "sh", "-c", 'du -sm "$HOME" | cut -f1'];

    summary.homeMiB = Number(inContainer("home size", sizeArgs).stdout.trim());

    return finish(0);
  } catch (error) {
    summary.problems.push(
      `the run stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return finish(1);
  } finally {
    for (const signal of Object.keys(SIGNAL_EXIT))
      process.off(signal, onSignal);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
