import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUCCESS_MESSAGE = "RequestPort Vercel dependency install completed.";
const FAILURE_MESSAGE = "RequestPort Vercel dependency install failed.";
const PACKAGE_REGISTRY_HOST = "npm.pkg.github.com";
const PACKAGE_TOKEN_VARIABLE = "REQUESTPORT_PACKAGE_READ_TOKEN";
const PACKAGE_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,512}$/u;
const PRODUCTION_INSTALL_APPROVAL_VARIABLE =
  "REQUESTPORT_PRODUCTION_PACKAGE_INSTALL";
const PRODUCTION_INSTALL_APPROVAL_VALUE = "approved";
/**
 * Why an install was refused, or how one failed — in words that cannot leak.
 *
 * Every one of these is a constant, and the only value ever interpolated into
 * them is an exit status, which is a number. That is the whole reason they can
 * be printed while the child's own output still cannot: a failing registry
 * install routinely repeats the request URL and the headers it was given, and
 * one fixed sentence for every outcome was the price of never echoing it.
 *
 * The price turned out to be too high. On 2026-09-17 the first production
 * build after the registry switch failed here, and "install failed" was
 * indistinguishable from a policy refusal decided in a millisecond, so nobody
 * could tell an outage from a decision and production stayed on the previous
 * commit.
 */
const PRODUCTION_APPROVAL_REASON = `refused before any install: VERCEL_ENV is production and ${PRODUCTION_INSTALL_APPROVAL_VARIABLE} did not read exactly "${PRODUCTION_INSTALL_APPROVAL_VALUE}". Note that a Vercel Sensitive variable is not exposed to the build, so one set that way reads as absent here.`;
const MALFORMED_CREDENTIAL_REASON = `refused before any install: ${PACKAGE_TOKEN_VARIABLE} is set to something that is not a well-formed token.`;
const DEVELOPMENT_CREDENTIAL_REASON = `refused before any install: VERCEL_ENV is development, which uses the documented user-level package configuration, so ${PACKAGE_TOKEN_VARIABLE} being attached to it is a misconfiguration.`;
const UNKNOWN_TARGET_REASON =
  "refused before any install: VERCEL_ENV named no target this launcher knows.";
/**
 * pnpm's own error codes, and nothing else the child said.
 *
 * `ERR_PNPM_OUTDATED_LOCKFILE` and `ERR_PNPM_UNSUPPORTED_ENGINE` are different
 * outages with different fixes, and on 2026-09-17 three builds in a row
 * reported them as the same sentence.
 *
 * Both streams are read: pnpm prints its error block on **stdout**, which the
 * first version of this missed, so the next Vercel build reported "no error
 * code" against an install that had named one.
 *
 * Only the matched token is kept — never the line it sat on. The pattern is
 * `ERR_PNPM_` followed by capitals, digits and underscores, so a credential
 * cannot be one: a value that happened to be shaped that way still would not
 * carry the prefix, and the URL and the headers a registry repeats back are
 * discarded with the remainder of every line.
 */
const PNPM_ERROR_CODE = /\bERR_PNPM_[A-Z0-9_]+\b/gu;

export function pnpmErrorCodes(...streams) {
  const text = streams.filter((s) => typeof s === "string").join("\n");

  return [...new Set(text.match(PNPM_ERROR_CODE) ?? [])];
}

const installFailureReason = (status, codes = []) => {
  if (status === null) {
    return "the install ran and could not be started or was killed by a signal.";
  }

  const named =
    codes.length > 0
      ? `pnpm named ${codes.join(", ")}.`
      : "pnpm named no error code.";

  return `the install ran and exited ${status}. ${named} The rest of its output is deliberately not echoed, because a failing registry install repeats the request URL and headers it was given.`;
};

const TEMPORARY_DIRECTORY_PREFIX = resolve(
  tmpdir(),
  "requestport-package-auth-",
);

/**
 * The Vercel Project Root Directory is `apps/web`, so neither the working
 * directory an install starts in nor the config location can be trusted to
 * name the workspace root. This launcher is checked in at
 * `<repository root>/scripts`, so its own location is the only stable anchor.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Decide whether this Vercel target may install workspace dependencies, and
 * whether it must carry its own ephemeral GitHub Packages credential.
 *
 * Since the `@cueplusplus` scope went public on npm, no
 * dependency of this workspace is fetched from GitHub Packages, so an install
 * no longer needs a package-read credential at all. The token stopped being
 * required on that day; it is still honoured where it is present, because a
 * registry-backed dependency could return, and writing auth for a scope nothing
 * fetches costs nothing.
 *
 * - Preview installs. It writes an ephemeral user-level config only when a
 *   well-formed token is there to write.
 * - Development uses the documented user-level package configuration, so a
 *   sensitive Vercel variable attached to it is a misconfiguration.
 * - Production installs only behind an explicit opt-in. The launcher refused
 *   Production outright until 2026-09-06, calling the change "a separately
 *   approved release prerequisite"; that approval was given for the first
 *   production release.
 *
 *   The opt-in is kept rather than dropped, because a token is a credential and
 *   not a decision. Vercel copies variables between environments readily — a
 *   marketplace integration wrote one to both environments unasked during this
 *   very release — so "install if a token is present" would be satisfied by
 *   accident. `REQUESTPORT_PRODUCTION_PACKAGE_INSTALL` means nothing except
 *   that a person decided, and must read exactly `approved`.
 *
 *   What the opt-in no longer implies is a credential. A malformed token is
 *   still refused everywhere: a value that was meant to be a credential and is
 *   not one is a misconfiguration, whether or not anything would have spent it.
 */
export function planVercelInstall(env) {
  const target = env.VERCEL_ENV;
  const token = env[PACKAGE_TOKEN_VARIABLE];

  const credential =
    token === undefined
      ? "absent"
      : PACKAGE_TOKEN_PATTERN.test(token)
        ? "valid"
        : "malformed";

  if (target === "preview") {
    return credential === "malformed"
      ? { ok: false, reason: MALFORMED_CREDENTIAL_REASON }
      : { ok: true, writeRegistryAuth: credential === "valid" };
  }

  if (target === "development") {
    return token === undefined
      ? { ok: true, writeRegistryAuth: false }
      : { ok: false, reason: DEVELOPMENT_CREDENTIAL_REASON };
  }

  if (target === "production") {
    if (
      env[PRODUCTION_INSTALL_APPROVAL_VARIABLE] !==
      PRODUCTION_INSTALL_APPROVAL_VALUE
    ) {
      return { ok: false, reason: PRODUCTION_APPROVAL_REASON };
    }

    return credential === "malformed"
      ? { ok: false, reason: MALFORMED_CREDENTIAL_REASON }
      : { ok: true, writeRegistryAuth: credential === "valid" };
  }

  return { ok: false, reason: UNKNOWN_TARGET_REASON };
}

function installDependencies(env) {
  const plan = planVercelInstall(env);

  if (!plan.ok) {
    return { ok: false, reason: plan.reason };
  }

  let credentialDirectory;

  try {
    const childEnvironment = { ...env };
    delete childEnvironment[PACKAGE_TOKEN_VARIABLE];

    if (plan.writeRegistryAuth) {
      credentialDirectory = mkdtempSync(TEMPORARY_DIRECTORY_PREFIX);
      const configPath = resolve(credentialDirectory, ".npmrc");

      writeFileSync(
        configPath,
        `//${PACKAGE_REGISTRY_HOST}/:_authToken=${env[PACKAGE_TOKEN_VARIABLE]}\n`,
        { mode: 0o600 },
      );
      childEnvironment.NPM_CONFIG_USERCONFIG = configPath;
    }

    const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: childEnvironment,
      maxBuffer: 32 * 1024 * 1024,
    });

    // Child output is discarded rather than echoed: a failing registry install
    // routinely repeats the request URL and headers it was given. Its exit
    // status is not output, and is the one thing carried out of here.
    if (!result.error && result.status === 0) return { ok: true };

    return {
      ok: false,
      reason: installFailureReason(
        result.error ? null : result.status,
        pnpmErrorCodes(result.stdout, result.stderr),
      ),
    };
  } catch {
    return { ok: false, reason: installFailureReason(null) };
  } finally {
    if (credentialDirectory !== undefined) {
      rmSync(credentialDirectory, { force: true, recursive: true });
    }
  }
}

const outcome = installDependencies(process.env);

if (outcome.ok) {
  console.log(SUCCESS_MESSAGE);
} else {
  console.error(`${FAILURE_MESSAGE}\n${outcome.reason}`);
  process.exitCode = 1;
}
