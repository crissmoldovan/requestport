import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeOwnerCapableVariables } from "./owner-capable-variables.mjs";
import { refuseUnapprovedProductionDatabase } from "./production-database-guard.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_START_FAILURE = "RequestPort child command failed to start.";

function parseEnvFile(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u,
    );

    if (!match || line.trimStart().startsWith("#")) {
      continue;
    }

    const [, key, rawValue] = match;
    const quote = rawValue.at(0);
    const value =
      (quote === '"' || quote === "'") && rawValue.endsWith(quote)
        ? rawValue.slice(1, -1)
        : rawValue.replace(/\s+#.*$/u, "");

    values[key] = value;
  }

  return values;
}

export function loadRootEnv({
  env = process.env,
  rootDirectory = repositoryRoot,
} = {}) {
  const envPath = resolve(rootDirectory, ".env.local");

  if (!existsSync(envPath)) {
    return env;
  }

  for (const [key, value] of Object.entries(
    parseEnvFile(readFileSync(envPath, "utf8")),
  )) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * The flag two scripts pass, each wrapping a process that is refused beside
 * an owner-capable name: `DATABASE_URL`, any `DATABASE_URL_*`, `PG*` or
 * `POSTGRES_*`.
 * - `pnpm dev` (Plan 13, I.2 step 7; ruling 224 item 3) starts the web
 *   application, an application process, whose storage the role guard has
 *   refused at its first query beside one since step 7.
 * - `pnpm --filter @requestport/jobs worker` (ruling 225 item 3) starts
 *   `requestport-jobs`, which exits 2 before starting beside one (I.2b's b6,
 *   ruling 218).
 *
 * With it, every such name is removed after `.env.local` has filled the
 * environment, one line each on standard error naming the variable and never
 * its value. Migrations and the suites run without it and keep
 * `DATABASE_URL`, the owner.
 */
export const WITHOUT_OWNER_VARIABLES_FLAG = "--without-owner-variables";

async function run(command, args, { withoutOwnerVariables = false } = {}) {
  const environment = loadRootEnv();
  /**
   * Checked here because here is where it went wrong: this function fills unset
   * variables from `.env.local`, so a checkout whose `.env.local` named
   * production silently pointed every command it wrapped at production.
   */
  refuseUnapprovedProductionDatabase(environment);
  if (withoutOwnerVariables) {
    removeOwnerCapableVariables(environment, (name) => {
      console.error(
        `with-root-env: removed ${name} from this command's environment (${WITHOUT_OWNER_VARIABLES_FLAG}): the process it starts connects through a login of its own, and is refused beside a variable that can reach the database as its owner.`,
      );
    });
  }
  const child = spawn(command, args, { env: environment, stdio: "inherit" });

  await new Promise((resolveProcess) => {
    let settled = false;

    const finish = (exitCode, message) => {
      if (settled) return;
      settled = true;
      if (message) console.error(message);
      process.exitCode = exitCode;
      resolveProcess();
    };

    child.once("error", () => {
      finish(1, CHILD_START_FAILURE);
    });
    child.once("close", (code, signal) => {
      finish(code ?? (signal ? 1 : 0));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const withoutOwnerVariables = given[0] === WITHOUT_OWNER_VARIABLES_FLAG;
  const [command, ...args] = withoutOwnerVariables ? given.slice(1) : given;

  if (!command) {
    console.error(
      "Usage: node scripts/with-root-env.mjs [--without-owner-variables] <command> [...args]",
    );
    process.exitCode = 1;
  } else {
    run(command, args, { withoutOwnerVariables }).catch((error) => {
      /**
       * The refusal's own words, not the generic one.
       *
       * This catch existed to turn a spawn failure into one fixed line, and it
       * swallowed the production-database refusal into "child command failed to
       * start" — a message that tells a person nothing about what actually
       * stopped them or how to proceed deliberately.
       */
      console.error(
        error instanceof Error && error.message
          ? error.message
          : CHILD_START_FAILURE,
      );
      process.exitCode = 1;
    });
  }
}
