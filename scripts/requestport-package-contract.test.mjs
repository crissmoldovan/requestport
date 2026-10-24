import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { after, before, describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { TEST_SEAMS } from "../apps/requestport/src/web/test-seams.ts";
import { parseServerEnv } from "../packages/config/src/server-schema.ts";
import {
  isForbiddenAddress,
  resolveWebhookEndpoint,
} from "../packages/webhooks/src/endpoint-policy.ts";
import * as hostedDeployment from "./hosted-deployment.mjs";
import {
  inventory,
  licenceFiles,
  workspaceProjects,
} from "./licence-inventory.mjs";
import { PACKAGES, readTarball, repositoryRoot } from "./pack-packages.mjs";
import {
  CLIENT,
  containedClosure,
  LOCKSTEP,
  main,
  NOTICES,
  noticesEntries,
  noticesProblems,
  productionClosure,
  REQUESTPORT,
  thirdPartyNotices,
  VENDORED_COPIES,
  VERBATIM,
  WEB,
} from "./pack-requestport.mjs";
import { AGENT_COMMANDS } from "./requestport-clean-machine/agent.mjs";
import {
  BROWSERS,
  COMMANDS as PERSON_COMMANDS,
} from "./requestport-clean-machine/person.mjs";
import {
  AGENT_IN_CONTAINER,
  CHECKOUTS,
  CONTAINER_HOME,
  CONTAINER_TARBALLS,
  cleanContainerArguments,
  DATABASE_IMAGE,
  DATABASE_READINESS_WORDS,
  DATABASE_SQL,
  DRIVER_INSPECT_SCRIPT,
  databaseContainerArguments,
  driverContainerArguments,
  HARNESS_COMMANDS,
  INSPECT_SCRIPT,
  MCP_CONFIGURATION_FILE,
  mcpConfiguration,
  nodeImage,
  PERSON_IN_CONTAINER,
  PORT_SCRIPT,
  PROCESSES_SCRIPT,
  psqlWords,
  READINESS_SCRIPT,
  README_STEPS,
  RUN_FILES,
  readmeCommand,
  START_STDERR,
} from "./requestport-clean-machine.mjs";
import { PLAYWRIGHT_IMAGE } from "./run-webkit-lanes.mjs";

/*
 * The package contract of `requestport`, `@requestport/web` and
 * `@requestport/client` (Plan 13, H.7; manifest-h.md §2.7.3, §4's "What
 * follows from an owner's answer", §5's Owns and Done when 17; ruling 193
 * items 4 and 10). Begun in H.7's slice d, finished in slice e.
 *
 * It holds:
 * - `apps/requestport/README.md`, which the pack ships as `README.md` and
 *   which is the done-when's README, against each owner answer it depends on
 *   (`OWNER`, below; the owner gave each, ruling 175), against the code its
 *   egress section describes (`packages/webhooks`' endpoint policy and
 *   `packages/config`'s refusals of its switch), and against the program's
 *   own help, which the repository's `bin/requestport.mjs` prints;
 * - H's licence mapping entries (`REQUESTPORT`'s, `WEB`'s and `CLIENT`'s
 *   `license` and `licenseText`) against D3's answer (ruling 175) and the
 *   text under `licenses/`;
 * - `THIRD-PARTY-NOTICES`, which must cover every third-party package
 *   whose code a tarball contains, and may cover more (ruling 198 item 1,
 *   which restates ruling 197 item 4): `requestport`'s compiles in none and
 *   carries none, and its
 *   README says where each dependency's licence is; `@requestport/web`'s,
 *   as `pack-requestport.mjs` writes it for what its build contains
 *   (`containedClosure`), bounded by the production closure of `apps/web`
 *   as G.A's licence inventory lists it (view (b));
 * - Done when 17 over H's three tarballs, read by its own checks
 *   (`doneWhen17Problems`), not by the pack's: each `license` field and
 *   `LICENSE` text the mapping's, the text byte for byte the file under
 *   `licenses/`; no `THIRD-PARTY-NOTICES` in `requestport`'s, whose
 *   `dist/` names no module but `apps/requestport`'s, or in the client's;
 *   `@requestport/web`'s with an entry for no package outside `apps/web`'s
 *   production closure but those `WEB.beyondClosure` names and those
 *   vendored or bundled in such a package, a vendored one by its own
 *   `package.json` or by the reviewed list of vendored copies, and none
 *   twice (which packages its
 *   build holds, a tarball does not say: the pack's own check holds its
 *   notices to what the stage found); no tarball holding a `*.test.*` file or an `.env*`
 *   file;
 *   `workspace:` nowhere in the client's tarball and in no `package.json`,
 *   and no `workspace:` specifier in any file of `requestport`'s or
 *   `@requestport/web`'s, whose own code holds the word; every source
 *   manifest private; and nothing H adds that publishes.
 *
 * - no E2E owner storage, no test route and no test seam in any tarball of
 *   the run (rulings 170 and 174), each read by its own copy of the words;
 * - Done when 14's contract (H.8): every operator command the clean-machine
 *   run issues is a line of the README's `sh` blocks, verbatim but for the
 *   one substitution and README 148's one named slot, read over the run's
 *   table, the MCP configuration the agent is given and a run's transcript
 *   (at the end of this file).
 *
 * The tarballs are the ones `pack-requestport.mjs`'s `main` packs, in this
 * file's `before`, into a temporary directory outside the repository, with a
 * fixture tree of the self-host build's shape in place of `next build` (as
 * `pack-requestport.test.mjs` does): the run's fourteen, G.7's eleven and
 * H's three (H.7, round 4, slice d). With `PACK_REQUESTPORT_OUT` naming a
 * directory a run of `node scripts/pack-requestport.mjs` packed into, they
 * are that run's fourteen instead, read as its `build-record.json` names
 * them: Done when 17 over the real build's tarballs, which only a hand run
 * makes.
 */

/**
 * The owner's answers the README depends on (manifest-h.md §4, "What follows
 * from an owner's answer"; §5, owner questions 2, 3, 4, 5 and 9), and the
 * platforms it names. The owner gave each on 2026-10-08 and 2026-10-09
 * (ruling 175); `answer` names the rulings that record it, and the README
 * follows the value.
 */
const OWNER = Object.freeze({
  /**
   * Question 2, the names: the published name, which the pack writes
   * (`REQUESTPORT.published`, ruling 86) and the README's `npx` commands
   * name: `requestport`, which the owner claims on npm, with the
   * `@requestport` scope, before J publishes. The command is `requestport`.
   */
  name: Object.freeze({
    answer: "ruling 175, H question 2",
    published: "requestport",
  }),
  /**
   * Question 3, the storage the README offers first: PGlite, then
   * PostgreSQL, `start`'s default.
   */
  firstStorage: Object.freeze({
    answer: "ruling 175, H question 3",
    storage: "pglite",
  }),
  /**
   * Question 4, the managed PostgreSQL providers the README names: none. It
   * states the owner role's requirement instead.
   */
  providers: Object.freeze({
    answer: "ruling 175, H question 4",
    named: Object.freeze([]),
  }),
  /**
   * Question 5, the honesty list (ruling 97): PGlite's single user without
   * row-level security (manifest-h.md §2.6 item 5), and what the hosted
   * service adds (the open-core spec's list, `:51-62`), each as a sentence the
   * README says: the list as proposed.
   */
  honesty: Object.freeze({
    answer: "ruling 175, H question 5",
    items: Object.freeze([
      Object.freeze({
        item: "PGlite: one user on this machine, without row-level security",
        sentences: Object.freeze([
          "PGlite serves one user on this machine: it binds a loopback address only, and row-level security does not apply to it, because PGlite connects as its superuser.",
        ]),
      }),
      Object.freeze({
        item: "a stable public HTTPS issuer for agent credentials",
        sentences: Object.freeze([
          "Agents' credentials are bound to this instance's public URL, the issuer they authenticate against.",
          "The hosted service's issuer is a stable public HTTPS URL that does not move.",
        ]),
      }),
      Object.freeze({
        item: "managed TLS",
        sentences: Object.freeze([
          "requestport serves plain HTTP and terminates no TLS. The hosted service manages TLS.",
        ]),
      }),
      Object.freeze({
        item: "public webhook ingress",
        sentences: Object.freeze([
          "An instance on a loopback address can be reached from this machine only, so nothing on the internet can call it. The hosted service has public webhook ingress.",
        ]),
      }),
      Object.freeze({
        item: "e-mail deliverability",
        sentences: Object.freeze([
          "requestport start sends no e-mail and offers no sign-in by e-mailed link. The hosted service sends e-mail, and keeps its deliverability.",
        ]),
      }),
      Object.freeze({
        item: "the Slack and GitHub apps",
        sentences: Object.freeze([
          "requestport start offers no GitHub sign-in. The hosted service's Slack and GitHub apps are its own, registered to its URLs, and install in one click.",
        ]),
      }),
      Object.freeze({
        item: "upgrades, backups and support",
        sentences: Object.freeze([
          "You upgrade, back up and support a self-hosted instance yourself.",
          "The hosted service upgrades, backs up and supports its instances.",
        ]),
      }),
    ]),
  }),
  /**
   * Question 9, webhook egress: the operator's explicit opt-in for private
   * and loopback receivers, `packages/webhooks`' own change (H.10, merged),
   * whose switch is `variable` set to `value`, refused wherever `VERCEL_ENV`
   * is set and unless `REQUESTPORT_JOB_RUNNER` is `postgres` (rulings 176
   * and 179). The README describes it in the section `heading` names, in
   * these `sentences`; the ranges it admits are read from the endpoint
   * policy's own constants (`admittedRanges`), and `neverAdmitted` are the
   * link-local ranges it names as never admitted.
   */
  egress: Object.freeze({
    answer: "rulings 175, 176, 179 and 190, H question 9",
    heading: "Webhook receivers on your own network",
    variable: "REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS",
    value: "enabled",
    runner: "REQUESTPORT_JOB_RUNNER",
    neverAdmitted: Object.freeze(["169.254.0.0/16", "fe80::/10"]),
    sentences: Object.freeze([
      "It refuses a webhook endpoint whose address is a loopback, private, link-local or otherwise non-public one, when the webhook is registered and again at each delivery, and it requires https, on the default port or 443.",
      "A receiver whose every address is in them may use plain http and any port, such as http://192.168.1.5:8080/.",
      "Every other receiver keeps https, on its default port or 443.",
      "Link-local addresses (169.254.0.0/16 and fe80::/10) are never admitted, nor are a few known cloud metadata endpoints inside the admitted ranges, nor unspecified, multicast, broadcast or other reserved addresses.",
      "start does not record the variable: give it to each start that should admit them.",
      "It takes exactly enabled; any other value, empty included, is refused.",
      "It is refused wherever VERCEL_ENV is set, and unless REQUESTPORT_JOB_RUNNER is postgres, which start always sets.",
    ]),
  }),
  /**
   * The platforms the README names as supported: the licence policy's
   * (`release/licence-policy.json`'s `scope.platforms.list`, which the seed
   * does not carry), linux-x64 and linux-arm64 with glibc, and darwin-arm64.
   * Ruling 182, on ruling 175's answer to J question 1: "H.7's README names
   * the same three".
   */
  platforms: Object.freeze({
    answer: "ruling 182, on ruling 175's answer to J question 1",
    list: Object.freeze(["darwin-arm64", "linux-arm64", "linux-x64"]),
    sentences: Object.freeze([
      "It supports three platforms: Linux on x64 and on arm64, with glibc (linux-x64 and linux-arm64), and macOS on arm64 (darwin-arm64).",
      "Windows, Linux with musl, such as Alpine, and macOS on x64 are not among them.",
    ]),
  }),
});

/**
 * D3, the licence: Apache-2.0 on everything (ruling 175), its text under
 * `licenses/`, where G.7's mapping points (ruling 150).
 */
const D3 = Object.freeze({
  answer: "ruling 175, D3",
  license: "Apache-2.0",
  licenseText: "licenses/Apache-2.0.txt",
});

/**
 * The sha256 of each licence's text as its steward publishes it, by SPDX
 * expression: the value G.7's `package-contract.test.mjs` records for
 * Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0.txt, 11,358 bytes,
 * fetched on 2026-10-06).
 */
const PUBLISHED_TEXT_SHA256 = Object.freeze({
  "Apache-2.0":
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
});

/**
 * Managed PostgreSQL providers a README might name: three of the open-core
 * spec's four (Supabase, RDS and Fly, `:20-22`) and others of their kind. A
 * name is matched as a whole word, case and all. The spec's first is not
 * listed: ruling 175 (J question 3) puts its name on J's denylist
 * (`release/denylist.json`), whose case over the files the seed keeps at
 * HEAD (`scripts/denylist-gate.test.mjs`) fails on a kept file that holds
 * the name unless an allow entry names that file and that spelling. This
 * file is kept and no such entry names it, so it cannot list the name;
 * `apps/requestport/README.md`, which the pack copies as the tarball's
 * README byte for byte, is kept and no such entry names it either (H.7,
 * round 4, slice a).
 */
const PROVIDER_NAMES = Object.freeze([
  "Supabase",
  "RDS",
  "Aurora",
  "Fly",
  "Fly.io",
  "Render",
  "Heroku",
  "Railway",
  "Crunchy",
  "Aiven",
  "DigitalOcean",
  "Azure",
  "Cloud SQL",
  "AlloyDB",
  "Timescale",
  "Tembo",
  "Xata",
  "Nile",
  "PlanetScale",
  "Prisma",
  "Scaleway",
  "OVHcloud",
  "Vercel",
]);

/** The line above each entry of `THIRD-PARTY-NOTICES`. */
const RULE = "=".repeat(80);

/** The README's own placeholder for the version, which Done when 14 substitutes. */
const VERSION_PLACEHOLDER = "<version>";

const README = readFileSync(join(repositoryRoot, REQUESTPORT.readme), "utf8");

/**
 * The README's fenced blocks: their language, their text, and the number of
 * their first line of text (`from`), counting the file's lines from 1.
 */
function fencedBlocks(text) {
  return [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gmu)].map(
    ({ index, 1: language, 2: body }) => ({
      language,
      body,
      from: text.slice(0, index).split("\n").length + 1,
    }),
  );
}

/** The README's prose: no fenced block, no backtick, white space as one space. */
function prose(text) {
  return text
    .replace(/^```[\s\S]*?^```$/gmu, " ")
    .replaceAll("`", "")
    .replace(/\s+/gu, " ");
}

/**
 * Each line of the README's `sh` blocks that runs `npx`, after any variable
 * assignments before it (`NAME=value npx …`): the line, its assignments
 * (`environment`), and the words from `npx` on.
 */
function npxCommands(text) {
  return fencedBlocks(text)
    .filter(({ language }) => language === "sh")
    .flatMap(({ body }) => body.split("\n"))
    .map((line) => /^((?:[A-Z][A-Z0-9_]*=\S*\s+)*)(npx\s.*)$/u.exec(line))
    .filter((match) => match !== null)
    .map(([line, assignments, command]) => ({
      line,
      environment: assignments.split(/\s+/u).filter(Boolean),
      words: [...command.matchAll(/"[^"]*"|\S+/gu)].map(([word]) => word),
    }));
}

/** The text of the README's `## <heading>` section, up to the next `## `. */
function sectionOf(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the README has a section "${heading}"`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/**
 * The ranges `packages/webhooks`' endpoint policy admits with the operator's
 * opt-in on, read from its own constants, `privateReceiverV4` and
 * `privateReceiverV6`, which the module does not export: each as CIDR text,
 * a full-length prefix as the bare address (`::1`).
 */
function admittedRanges() {
  const source = readFileSync(
    join(repositoryRoot, "packages/webhooks/src/endpoint-policy.ts"),
    "utf8",
  );
  return [
    ["privateReceiverV4", 32],
    ["privateReceiverV6", 128],
  ].flatMap(([name, full]) => {
    const body = new RegExp(
      `\\bconst ${name}\\b[^=]*= \\[([\\s\\S]*?)\\];`,
      "u",
    ).exec(source)?.[1];
    assert.ok(body, `endpoint-policy.ts declares ${name}`);
    const ranges = [...body.matchAll(/\["([0-9a-f.:]+)", (\d+)\]/gu)].map(
      ([, base, prefix]) =>
        Number(prefix) === full ? base : `${base}/${prefix}`,
    );
    assert.ok(ranges.length > 0, `${name} holds a range`);
    return ranges;
  });
}

/** The first address of a CIDR range, or the address itself. */
function firstAddress(range) {
  return range.split("/")[0];
}

/** The package spec every published command names: `requestport@<version>`. */
const SPEC = `${REQUESTPORT.published}@${VERSION_PLACEHOLDER}`;

/** A platform as Node names it, `<process.platform>-<process.arch>`. */
const NODE_PLATFORM =
  /\b(?:aix|android|cygwin|darwin|freebsd|haiku|linux|netbsd|openbsd|sunos|win32)-(?:arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)\b/gu;

/** Whether `help` names `option` as an option, as a whole word. */
function namesOption(help, option) {
  return new RegExp(
    `(^|[\\s(,])${option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`,
    "mu",
  ).test(help);
}

const scratch = mkdtempSync(join(tmpdir(), "requestport-package-contract-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * What the program prints for `--help`, and for each command's `--help`, run
 * through the repository's `apps/requestport/bin/requestport.mjs` from a
 * directory outside the repository, with `PATH`, `TMPDIR` when it is set,
 * and a `HOME` of its own: stdout and stderr together (`mcp` prints its help
 * on stderr).
 */
const help = {};

before(() => {
  const bin = join(repositoryRoot, "apps/requestport/bin/requestport.mjs");
  const inherited = process.env;
  for (const [name, args] of [
    ["top", ["--help"]],
    ["start", ["start", "--help"]],
    ["login", ["login", "--help"]],
    ["link", ["link", "--help"]],
    ["mcp", ["mcp", "--help"]],
    ["owner", ["owner", "--help"]],
    ["worker", ["worker", "--help"]],
  ]) {
    const run = spawnSync(process.execPath, [bin, ...args], {
      cwd: scratch,
      encoding: "utf8",
      env: {
        PATH: inherited.PATH,
        HOME: scratch,
        ...(inherited.TMPDIR === undefined ? {} : { TMPDIR: inherited.TMPDIR }),
      },
    });
    assert.equal(run.status, 0, `requestport ${args.join(" ")}: ${run.stderr}`);
    help[name] = `${run.stdout}${run.stderr}`;
  }
});

describe("the README against the owner's answers (manifest-h.md §4; ruling 175)", () => {
  test("question 2, in the published form (ruling 193 item 8): every npx command names requestport@<version>, the name the pack writes; none names a tarball (file:) or a path, whose form before publishing is the runbook's", () => {
    assert.equal(REQUESTPORT.published, OWNER.name.published);
    assert.deepEqual(Object.keys(REQUESTPORT.bin), ["requestport"]);
    const commands = npxCommands(README);
    assert.ok(commands.length > 0);
    for (const { line, words } of commands) {
      assert.equal(words[1], SPEC, `${line} names ${SPEC}`);
    }
    assert.doesNotMatch(README, /\bfile:/u);
    assert.doesNotMatch(README, /\.tgz\b/u);
    assert.doesNotMatch(README, /\bnpx\s+[-/.~]/u);
    const [configuration] = fencedBlocks(README).filter(
      ({ language }) => language === "json",
    );
    assert.deepEqual(JSON.parse(configuration.body).mcpServers.requestport, {
      command: "npx",
      args: [SPEC, "mcp"],
    });
  });

  test("question 3: a first start on the storage the owner offers first comes before one on the other storage", () => {
    assert.match(
      help.start,
      /--storage <pg\|pglite>\s+PostgreSQL, through the owner URL \(the default\)/u,
    );
    const storages = npxCommands(README)
      .filter(({ words }) => words[2] === "start" && words.includes("--email"))
      .map(({ words }) => {
        const at = words.indexOf("--storage");
        return at === -1 ? "pg" : words[at + 1];
      });
    assert.deepEqual(
      [...new Set(storages)],
      [
        OWNER.firstStorage.storage,
        OWNER.firstStorage.storage === "pg" ? "pglite" : "pg",
      ],
    );
  });

  test("question 4: names exactly the providers the owner's answer names, which is none, and states the requirement start's preflight checks: a superuser, or BYPASSRLS with CREATEROLE, and ADMIN OPTION on groups another role created", () => {
    const named = PROVIDER_NAMES.filter((name) =>
      new RegExp(
        `(^|[^\\w.])${name.replaceAll(".", "\\.")}(?![\\w])`,
        "u",
      ).test(README),
    );
    assert.deepEqual(named, [...OWNER.providers.named]);
    const text = prose(README);
    for (const sentence of [
      "The owner URL's role must be a superuser, or have both BYPASSRLS and CREATEROLE.",
      "If the instance's group roles already exist in the cluster, created by another role, it must also hold ADMIN OPTION on each of them.",
      "start checks this before it creates or migrates anything, and its refusal says what to run.",
    ]) {
      assert.ok(text.includes(sentence), sentence);
    }
    const preflight = readFileSync(
      join(repositoryRoot, "packages/db/src/operator-session.ts"),
      "utf8",
    );
    assert.match(
      preflight,
      /the owner must be a superuser, or have both BYPASSRLS and CREATEROLE/u,
    );
    assert.match(preflight, /MEMBER WITH ADMIN OPTION/u);
  });

  test("question 5: every item of the honesty list is there, in the words recorded", () => {
    const text = prose(README);
    for (const { item, sentences } of OWNER.honesty.items) {
      for (const sentence of sentences) {
        assert.ok(text.includes(sentence), `${item}: ${sentence}`);
      }
    }
  });

  test("question 9: the egress section describes H.10's opt-in in the words recorded, and shows a start with REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS=enabled in its environment", () => {
    const { heading, variable, value, sentences } = OWNER.egress;
    const section = sectionOf(README, heading);
    const text = prose(section);
    for (const sentence of sentences) {
      assert.ok(text.includes(sentence), sentence);
    }
    assert.ok(text.includes(`${variable}=${value}`));
    assert.deepEqual(
      npxCommands(section).map(({ environment, words }) => [
        environment,
        words.slice(2),
      ]),
      [[[`${variable}=${value}`], ["start"]]],
    );
  });

  test("question 9: as admitted, it names every range the endpoint policy's own constants admit with the switch on, and no other; each is refused with the switch off and admitted with it on; the link-local ranges it names, and a known metadata endpoint inside an admitted range, are refused either way", () => {
    const admitted = admittedRanges();
    const { neverAdmitted } = OWNER.egress;
    assert.deepEqual(
      admitted.filter((range) => neverAdmitted.includes(range)),
      [],
    );
    const named = [
      ...sectionOf(README, OWNER.egress.heading).matchAll(
        /`([0-9a-f.:]+(?:\/\d{1,3})?)`/gu,
      ),
    ]
      .map(([, token]) => token)
      .filter((token) => isIP(firstAddress(token)) !== 0);
    assert.deepEqual(
      [...new Set(named)].sort(),
      [...admitted, ...neverAdmitted].sort(),
    );
    for (const range of admitted) {
      const address = firstAddress(range);
      assert.equal(isForbiddenAddress(address), true, `${range}, off`);
      assert.equal(
        isForbiddenAddress(address, { privateReceivers: true }),
        false,
        `${range}, on`,
      );
    }
    for (const address of [
      ...neverAdmitted.map(firstAddress),
      "169.254.169.254",
      "100.100.100.200",
      "fd00:ec2::254",
    ]) {
      assert.equal(
        isForbiddenAddress(address, { privateReceivers: true }),
        true,
        address,
      );
    }
    assert.equal(isForbiddenAddress("93.184.215.14"), false);
  });

  test("question 9: with the switch on, a receiver whose every address is admitted may use plain http and any port, under the production policy start runs; with it off it may not; and any other receiver keeps https on its default port or 443", async () => {
    const at = (address) => async () => [{ address, family: isIP(address) }];
    const local = "http://192.168.1.5:8080/";
    const admitted = await resolveWebhookEndpoint(local, {
      privateReceivers: true,
      resolver: at("192.168.1.5"),
    });
    assert.equal(admitted.url.href, local);
    await assert.rejects(
      resolveWebhookEndpoint(local, { resolver: at("192.168.1.5") }),
      /https_required/u,
    );
    await assert.rejects(
      resolveWebhookEndpoint("https://192.168.1.5/", {
        resolver: at("192.168.1.5"),
      }),
      /unsafe_endpoint_address/u,
    );
    for (const [url, refusal] of [
      ["http://receiver.example/", /https_required/u],
      ["https://receiver.example:8443/", /unsafe_endpoint_port/u],
    ]) {
      await assert.rejects(
        resolveWebhookEndpoint(url, {
          privateReceivers: true,
          resolver: at("93.184.215.14"),
        }),
        refusal,
        url,
      );
    }
    for (const url of [
      "https://receiver.example/",
      "https://receiver.example:443/",
    ]) {
      await resolveWebhookEndpoint(url, {
        privateReceivers: true,
        resolver: at("93.184.215.14"),
      });
    }
  });

  test("question 9: packages/config refuses the switch wherever VERCEL_ENV is set, unless REQUESTPORT_JOB_RUNNER is postgres, and at any value but enabled; start's canonical environment always names the postgres runner (configuration.test.ts runs it)", () => {
    const { variable, value, runner } = OWNER.egress;
    /** The issues `parseServerEnv` raises for `env` that name `variable`. */
    const issuesFor = (env) => {
      try {
        parseServerEnv(env);
        return [];
      } catch (error) {
        assert.ok(Array.isArray(error.issues), String(error));
        return error.issues.filter((issue) => issue.path[0] === variable);
      }
    };
    assert.throws(
      () =>
        parseServerEnv({
          [variable]: value,
          [runner]: "postgres",
          VERCEL_ENV: "",
        }),
      /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused wherever VERCEL_ENV is set/u,
    );
    for (const job of [undefined, "", "trigger"]) {
      assert.throws(
        () => parseServerEnv({ [variable]: value, [runner]: job }),
        /REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS is refused unless REQUESTPORT_JOB_RUNNER is postgres/u,
        String(job),
      );
    }
    for (const other of ["", "yes", "Enabled", "enabled "]) {
      assert.notDeepEqual(
        issuesFor({ [variable]: other, [runner]: "postgres" }),
        [],
        JSON.stringify(other),
      );
    }
    assert.deepEqual(
      issuesFor({ [variable]: value, [runner]: "postgres" }),
      [],
    );
    const configuration = readFileSync(
      join(repositoryRoot, "apps/requestport/src/configuration.ts"),
      "utf8",
    );
    const canonical = configuration.slice(
      configuration.indexOf("export function canonicalEnvironment("),
    );
    assert.match(
      canonical.slice(0, canonical.indexOf("\n}\n")),
      /^ {4}REQUESTPORT_JOB_RUNNER: "postgres",$/mu,
    );
  });

  test("the platforms: it names exactly the three ruling 182 lists, linux-x64 and linux-arm64 with glibc and darwin-arm64, in the words recorded", () => {
    const named = [
      ...new Set([...README.matchAll(NODE_PLATFORM)].map(([id]) => id)),
    ].sort();
    assert.deepEqual(named, [...OWNER.platforms.list]);
    const text = prose(README);
    for (const sentence of OWNER.platforms.sentences) {
      assert.ok(text.includes(sentence), sentence);
    }
  });

  test("every answer is recorded: each names the rulings that record it, and none is pending", () => {
    const answers = Object.entries({ ...OWNER, d3: D3 });
    assert.deepEqual(
      answers.map(([question]) => question),
      [
        "name",
        "firstStorage",
        "providers",
        "honesty",
        "egress",
        "platforms",
        "d3",
      ],
    );
    for (const [question, answer] of answers) {
      assert.equal(Object.hasOwn(answer, "pending"), false, question);
      assert.match(answer.answer, /^rulings? \d+/u, question);
    }
  });
});

describe("the README's licence section (ruling 197 item 4)", () => {
  test("it says requestport compiles in no third-party code and so carries no THIRD-PARTY-NOTICES, says where each dependency's licence is (in its own directory under node_modules: the licence its package.json declares and the licence files it ships), and that @requestport/web carries the notices for the third-party code its build compiles in", () => {
    const section = prose(sectionOf(README, "Licence"));
    for (const words of [
      "LICENSE holds this package's licence.",
      "compiles in no third-party code, so it carries no THIRD-PARTY-NOTICES.",
      "each in its own directory under node_modules",
      "the licence its package.json declares",
      "the licence files it ships",
      "@requestport/web",
      "carries a THIRD-PARTY-NOTICES for the third-party code its build compiles in",
    ]) {
      assert.ok(section.includes(words), words);
    }
    assert.equal(
      section.includes("THIRD-PARTY-NOTICES holds the licence notices"),
      false,
    );
  });
});

describe("the README against the program's own help", () => {
  test("every command it runs is one the program lists, with options that command's --help names", () => {
    const commands = new Map([
      ["start", help.start],
      ["login", help.login],
      ["link", help.link],
      ["mcp", help.mcp],
      ["owner", help.owner],
      ["worker", help.worker],
    ]);
    for (const { line, words } of npxCommands(README)) {
      const [command, ...rest] = words.slice(2);
      if (command.startsWith("--")) {
        assert.ok(namesOption(help.top, command), `${line}: ${command}`);
        continue;
      }
      assert.ok(commands.has(command), `${line}: ${command} is no command`);
      assert.match(help.top, new RegExp(`^ {2}${command}\\b`, "mu"), line);
      if (command === "owner") {
        assert.equal(rest[0], "rotate-credential", line);
      }
      const options = command === "owner" ? rest.slice(1) : rest;
      for (const option of options.filter((word) => word.startsWith("--"))) {
        assert.ok(
          namesOption(commands.get(command), option.split("=")[0]),
          `${line}: requestport ${command} --help does not name ${option}`,
        );
      }
    }
  });

  test("the variables it names are the ones the agent commands read, REQUESTPORT_CREDENTIAL_STORE, file or keychain, and REQUESTPORT_NO_BROWSER, for every command, mcp included, with --no-browser on login and link; and, in the egress section alone, question 9's switch and job runner", () => {
    const named = (text) =>
      [
        ...new Set([...text.matchAll(/REQUESTPORT_[A-Z_]+/gu)].map(([v]) => v)),
      ].sort();
    const egress = sectionOf(README, OWNER.egress.heading);
    assert.deepEqual(named(egress), [
      OWNER.egress.runner,
      OWNER.egress.variable,
    ]);
    const variables = named(README.replace(egress, ""));
    assert.deepEqual(variables, [
      "REQUESTPORT_CREDENTIAL_STORE",
      "REQUESTPORT_NO_BROWSER",
    ]);
    for (const command of ["login", "link", "mcp"]) {
      for (const variable of variables) {
        assert.match(
          help[command],
          new RegExp(`(?<![A-Z_])${variable}(?![A-Z_])`, "u"),
          `${command}: ${variable}`,
        );
      }
      assert.ok(namesOption(help[command], "--no-browser"), command);
      assert.match(help[command], /file or keychain/u, command);
    }
    const text = prose(README);
    for (const sentence of [
      "REQUESTPORT_CREDENTIAL_STORE=file or REQUESTPORT_CREDENTIAL_STORE=keychain chooses one for every command.",
      "--no-browser, on login and link, prints the URL and opens nothing.",
      "REQUESTPORT_NO_BROWSER=1 does the same for every command, mcp included.",
    ]) {
      assert.ok(text.includes(sentence), sentence);
    }
  });

  test("the public URL it names, http://127.0.0.1:3200, is start's default: port 3200 on 127.0.0.1", () => {
    assert.match(help.start, /--port <port>\s+Its port \(default: 3200\)/u);
    assert.match(help.start, /\(default: 127\.0\.0\.1;/u);
    assert.match(help.start, /\(default: http:\/\/<host>:<port>\)/u);
    assert.ok(
      prose(README).includes(
        "serves the instance at its public URL, http://127.0.0.1:3200 unless you choose another,",
      ),
    );
  });

  test("the owner URL is never a value on the command line: a file only you can read, one line of standard input, or the prompt at a terminal, as start says", () => {
    const startText = prose(help.start);
    assert.ok(
      startText.includes(
        "The owner URL is never accepted as a value on the command line.",
      ),
    );
    for (const option of ["--owner-url-file", "--owner-url-stdin"]) {
      assert.ok(namesOption(help.start, option), option);
    }
    const text = prose(README);
    for (const sentence of [
      "The owner URL is never accepted as a value on the command line.",
      "Or give it as one line of standard input, with --owner-url-stdin.",
      "At a terminal, start asks for it, without echoing it, when neither is given.",
    ]) {
      assert.ok(text.includes(sentence), sentence);
    }
    assert.ok(
      npxCommands(README).some(({ words }) =>
        words.includes("--owner-url-file"),
      ),
    );
  });

  test("the recovery path for a lost owner credential is requestport owner rotate-credential, which the program lists", () => {
    assert.match(help.top, /^ {2}owner rotate-credential$/mu);
    assert.ok(
      npxCommands(README).some(
        ({ line }) => line === `npx ${SPEC} owner rotate-credential`,
      ),
    );
  });

  test("PGlite's sentence is start's own", () => {
    assert.ok(prose(help.start).includes(OWNER.honesty.items[0].sentences[0]));
  });

  test("login comes before mcp: the README says to run it first, and its first login command is before the agent's MCP configuration (ruling 161, 12)", () => {
    assert.ok(
      prose(README).includes(
        "Run requestport login first, before the agent starts mcp:",
      ),
    );
    const login = README.indexOf(`npx ${SPEC} login `);
    const configuration = README.indexOf("```json\n");
    assert.ok(login !== -1 && configuration !== -1);
    assert.ok(login < configuration);
  });
});

function sha256(path) {
  return createHash("sha256")
    .update(readFileSync(join(repositoryRoot, path)))
    .digest("hex");
}

describe("H's licence mapping entries (Done when 17)", () => {
  test("requestport's, @requestport/web's and @requestport/client's are D3's answer, Apache-2.0 and licenses/Apache-2.0.txt, as G.7's core entry is (ruling 175)", () => {
    for (const pack of [REQUESTPORT, WEB, CLIENT]) {
      assert.equal(pack.license, D3.license);
      assert.equal(pack.licenseText, D3.licenseText);
      assert.equal(pack.license, PACKAGES.core.license);
      assert.equal(pack.licenseText, PACKAGES.core.licenseText);
    }
  });

  test("each text is its licence's, verbatim: its sha256 is that of the text the licence's steward publishes", () => {
    for (const pack of [REQUESTPORT, WEB, CLIENT]) {
      assert.equal(
        sha256(pack.licenseText),
        PUBLISHED_TEXT_SHA256[pack.license],
        pack.licenseText,
      );
    }
  });
});

/**
 * The packages whose `THIRD-PARTY-NOTICES` `pack-requestport.mjs` writes
 * from a production closure, each by its packed name, with its `notices`
 * (members and header, that script's): `@requestport/web` (ruling 197 item
 * 4). `@requestport/db`'s, which G.7's pack writes from the repository's
 * notices for the esbuild runtime helpers its chunk binds (ruling 209), is
 * not one of them.
 */
const NOTICED = Object.freeze([
  Object.freeze({ name: WEB.published, notices: WEB.notices }),
]);

/** Each of `NOTICED`'s production closures (`productionClosure`), by packed name. */
function noticedClosures() {
  return new Map(
    NOTICED.map(({ name, notices }) => [
      name,
      productionClosure({ members: notices.members }),
    ]),
  );
}

/** A package of `apps/web`'s, by the real directory this tree installs it in. */
function installedForWeb(name) {
  return realpathSync(join(repositoryRoot, "apps/web/node_modules", name));
}

/**
 * Each package `WEB.beyondClosure` names, by name, as this tree installs it
 * where Next's webpack configuration finds it: resolved from `next`'s own
 * directory, as `next` 16.4.2's `dist/build/webpack-config.js` resolves
 * `process` there, which reaches the copy pnpm's store hoists. Each with its
 * `name@version` key and its directory, so that an entry of
 * `@requestport/web`'s notices for it, or for a package vendored in it, is
 * read against that directory, as the pack's `containedClosure` accepts a
 * package whose holder `WEB.beyondClosure` names.
 */
function beyondPackages() {
  const fromNext = createRequire(join(installedForWeb("next"), "package.json"));
  return new Map(
    WEB.beyondClosure.map((name) => {
      const directory = dirname(
        realpathSync(fromNext.resolve(`${name}/package.json`)),
      );
      const { version } = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      return [name, { key: `${name}@${version}`, directory }];
    }),
  );
}

/**
 * What a self-host build that sealed a compilation of each of Next's three
 * compilers (`WEB.compilers`) and compiled in a module of `next`'s, one of
 * the `cookie` Next keeps in its `dist/compiled` (a package vendored in
 * `next`), one of `react-dom`'s, `process/browser.js` (which Next's webpack
 * configuration provides from pnpm's hoisted store, `WEB.beyondClosure`),
 * and one of `apps/web`'s own, records (`buildWeb`'s `contained`): the
 * fixture build's, here and in `selfHostFixture`.
 */
const CONTAINED = Object.freeze({
  compilers: Object.freeze(["client", "edge-server", "server"]),
  files: Object.freeze([
    join(installedForWeb("next"), "dist/client/app-index.js"),
    join(installedForWeb("next"), "dist/compiled/cookie/index.js"),
    join(installedForWeb("react-dom"), "cjs/react-dom-client.production.js"),
    join(
      realpathSync(
        join(repositoryRoot, "node_modules/.pnpm/node_modules/process"),
      ),
      "browser.js",
    ),
    join(repositoryRoot, "apps/web/src/app/page.tsx"),
  ]),
});

describe("THIRD-PARTY-NOTICES (manifest-h.md §2.7.3; Done when 17; ruling 197 item 4)", () => {
  const closures = noticedClosures();

  test("requestport carries none: its packed manifest's files is LICENSE and dist, and REQUESTPORT names no notices; @requestport/web's are bounded by the production closure of apps/web, as G.A's licence inventory lists it (view (b)), through every workspace it reaches, with nothing unresolved, which does not reach apps/requestport", () => {
    assert.deepEqual(REQUESTPORT.files, ["LICENSE", "dist"]);
    assert.equal(Object.hasOwn(REQUESTPORT, "notices"), false);
    assert.deepEqual(WEB.notices.members, ["@requestport/web"]);
    for (const { name, notices } of NOTICED) {
      const closure = closures.get(name);
      const [listed] = inventory(repositoryRoot, {
        definitions: [{ id: name, kind: "package", members: notices.members }],
        pnpm: false,
      }).candidates;
      assert.ok(listed.viewB.packages.length > 0, name);
      assert.deepEqual([...closure.packages.keys()], listed.viewB.packages);
      assert.deepEqual(closure.workspaces, listed.members);
      assert.deepEqual(closure.unresolved, []);
    }
    assert.equal(
      closures
        .get(WEB.published)
        .workspaces.includes("@requestport/requestport"),
      false,
    );
  });

  test("@requestport/web's has an entry for each package its build contains and for no other, with the licence its package.json declares and the text of each licence or notice file it ships: for a build that compiled in a module of next's, one of the cookie next vendors, one of react-dom's and process's, which WEB.beyondClosure names, those four, cookie by itself as vendored in next", () => {
    const production = closures.get(WEB.published);
    const { closure, problems } = containedClosure(production, CONTAINED);
    assert.deepEqual(problems, []);
    const notices = thirdPartyNotices(closure, WEB.notices);
    assert.deepEqual(noticesProblems(closure, notices), []);
    const keys = noticesEntries(notices).map(({ key }) => key);
    assert.deepEqual(keys, [...closure.packages.keys()]);
    const next = [...production.packages.keys()].find((key) =>
      key.startsWith("next@"),
    );
    assert.deepEqual(
      keys.map((key) => key.replace(/@[^@ ]+$/u, "")),
      [
        `cookie (vendored in ${next} at dist/compiled/cookie)`,
        "next",
        "process",
        "react-dom",
      ],
    );
    assert.ok(production.packages.size > keys.length);
    for (const key of keys) {
      const entry = closure.packages.get(key);
      const at = notices.indexOf(`\n${RULE}\nPackage: ${key}\n`);
      const next = notices.indexOf(`\n${RULE}\n`, at + 1);
      const body = notices.slice(at, next === -1 ? undefined : next);
      const files = licenceFiles(entry.directory).filter(({ file }) =>
        statSync(join(entry.directory, file)).isFile(),
      );
      assert.ok(files.length > 0, key);
      for (const { file } of files) {
        const text = readFileSync(join(entry.directory, file), "utf8")
          .replaceAll("\r\n", "\n")
          .trimEnd();
        assert.ok(
          body.includes(`--- ${file} ---\n\n${text}`),
          `${key}: ${file}`,
        );
      }
    }
  });

  test("fails on a missing entry, and on an entry for a package the build does not contain; and refuses a build that recorded no compilation, or contains a package outside the production closure", () => {
    const production = closures.get(WEB.published);
    const { closure } = containedClosure(production, CONTAINED);
    const notices = thirdPartyNotices(closure, WEB.notices);
    const [dropped] = [...closure.packages.keys()];
    const start = notices.indexOf(`\n${RULE}\nPackage: ${dropped}\n`);
    const end = notices.indexOf(`\n${RULE}\n`, start + 1);
    assert.deepEqual(
      noticesProblems(
        closure,
        `${notices.slice(0, start)}${notices.slice(end)}`,
      ),
      [
        `THIRD-PARTY-NOTICES has no entry for ${dropped}, which is in the third-party code @requestport/web's self-host build contains`,
      ],
    );
    const [outside] = [...production.packages.keys()].filter(
      (key) => !closure.packages.has(key),
    );
    assert.deepEqual(
      noticesProblems(
        closure,
        `${notices}\n${RULE}\nPackage: ${outside}\nLicense: MIT\n`,
      ),
      [
        `THIRD-PARTY-NOTICES has an entry for ${outside}, which is outside the third-party code @requestport/web's self-host build contains`,
      ],
    );
    assert.deepEqual(
      containedClosure(production, { compilers: [], files: [] }, []).problems,
      [
        "the self-host build recorded no sealed compilation, so nothing says what code it contains",
      ],
    );
    const strange = join(scratch, "strange", "node_modules", "left-pad");
    mkdirSync(strange, { recursive: true });
    writeFileSync(
      join(strange, "package.json"),
      '{"name":"left-pad","version":"1.3.0"}\n',
    );
    assert.deepEqual(
      containedClosure(
        production,
        { compilers: WEB.compilers, files: [join(strange, "index.js")] },
        [],
      ).problems,
      [
        "the self-host build contains left-pad@1.3.0, which is not in the production closure of @requestport/web",
      ],
    );
  });
});

/** `@requestport/client`'s packed name, its workspace's own. */
const CLIENT_NAME = JSON.parse(
  readFileSync(join(repositoryRoot, CLIENT.source, "package.json"), "utf8"),
).name;

/**
 * The tarballs Done when 17 covers: each one's packed name, H's licence
 * mapping entry for it, and whether any file of it may hold the word
 * `workspace:` outside a `package.json` (`wordAllowed`):
 * `@requestport/web`'s chunks hold the word (`doneWhen17Problems`), and
 * `requestport`'s `dist/`, RequestPort's own code, is held to a `workspace:`
 * specifier as its pack's check holds it (`fileProblems`); the client's
 * holds the word nowhere, so the client is held to the clause as written,
 * as Done when 12c holds it.
 */
const TARBALLS = Object.freeze([
  Object.freeze({
    name: REQUESTPORT.published,
    mapping: REQUESTPORT,
    wordAllowed: true,
  }),
  Object.freeze({ name: WEB.published, mapping: WEB, wordAllowed: true }),
  Object.freeze({ name: CLIENT_NAME, mapping: CLIENT, wordAllowed: false }),
]);

/**
 * A `workspace:` specifier, as pnpm's workspace protocol writes one:
 * `workspace:` and then `*`, `^`, `~`, a version or a relative path, or, in
 * pnpm's alias form, a package name and `@` before the range
 * (`workspace:<name>@<range>`; ruling 170). This reader keeps its own copy
 * rather than the pack's.
 */
const WORKSPACE_SPECIFIER =
  /workspace:(?:(?:@[\w.-]+\/)?[\w.-]+@)?(?:[*^~]|\d|\.{1,2}\/)/u;

/**
 * A notices entry for a package another package vendors, as the pack keys
 * one (`containedPackages`): its name, and its version where its manifest
 * gives one; the installed package that holds it, by `name@version`; and
 * its directory under that package's.
 */
const VENDORED = /^(.+) \(vendored in (\S+) at (\S+)\)$/u;

/**
 * A notices entry for a package whose code a file of another package
 * bundles, as the pack keys one (`verbatimPackages`, `bundledPackages`): its
 * name, and its version where one is recorded; and the key of the entry of
 * the package whose file bundles it. Read before `VENDORED`, which would
 * match a bundled entry whose holder is vendored.
 */
const BUNDLED = /^(.+?) \(bundled in (.+)\)$/u;

/**
 * A notices entry for a package a vendored copy that carries no
 * `package.json` of its own bundles, as the pack keys one from the reviewed
 * list of such copies (`listedVendoredPackages`): its name and version, and
 * the installed package that holds the copy, by `name@version`. No path, so
 * no key `VENDORED` reads matches it, nor it one of those.
 */
const LISTED = /^(.+) \(vendored in (\S+)\)$/u;

/**
 * The `sources` of the source map of the JavaScript file `file`, read as
 * the pack reads one (its `sourceMapOf`), in this reader's own code: the
 * map its last `sourceMappingURL` comment names, a `data:` URL's (base64 or
 * percent-encoded) or a file's beside it, or `<file>.map` where it names
 * none; an index map's sources are its sections'. None where there is no
 * map, or it cannot be read.
 */
function mapSources(file) {
  const text = readFileSync(file, "utf8");
  const url = [
    ...text.matchAll(
      /^\s*(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*]+)\s*(?:\*\/)?\s*$/gmu,
    ),
  ].at(-1)?.[1];
  try {
    let raw;
    if (url?.startsWith("data:")) {
      const comma = url.indexOf(",");
      raw = url.slice(0, comma).endsWith(";base64")
        ? Buffer.from(url.slice(comma + 1), "base64").toString("utf8")
        : decodeURIComponent(url.slice(comma + 1));
    } else {
      const path =
        url === undefined
          ? `${file}.map`
          : join(dirname(file), decodeURIComponent(url));
      if (!existsSync(path)) return [];
      raw = readFileSync(path, "utf8");
    }
    const map = JSON.parse(raw);
    const sources = Array.isArray(map.sections)
      ? map.sections.flatMap((section) => section?.map?.sources ?? [])
      : map.sources;
    return Array.isArray(sources)
      ? sources.filter((source) => typeof source === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * The package a source map's source is code of, as the pack reads one (its
 * `bundledSource`), in this reader's own code: the package directly under
 * the last `node_modules` in its path, and its version where the pnpm store
 * directory just above that records one (`.pnpm/<name, its / as
 * +>@<version>`, then nothing, `_` or `(`); none for a source under no
 * `node_modules`, or a declaration (`.d.ts`, `.d.mts`, `.d.cts`).
 */
function mappedPackage(source) {
  if (/\.d\.[cm]?ts$/u.test(source)) return undefined;
  const at = source.lastIndexOf("node_modules/");
  if (at === -1) return undefined;
  const segments = source.slice(at + "node_modules/".length).split("/");
  const depth = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length <= depth) return undefined;
  const name = segments.slice(0, depth).join("/");
  const store = /(?:^|\/)\.pnpm\/([^/]+)\/$/u.exec(source.slice(0, at))?.[1];
  const prefix = `${name.replace("/", "+")}@`;
  const version = store?.startsWith(prefix)
    ? /^\d+\.\d+\.\d+[^_()]*/u.exec(store.slice(prefix.length))?.[0]
    : undefined;
  return { name, version };
}

/**
 * Whether the source map of a JavaScript file under `directory` (but under
 * a `node_modules` directory below it) names the package `name` at
 * `version`, or with no version where `version` is none, as the pack
 * enters a package a map names (`mapSources`, `mappedPackage`).
 */
function mapsName(directory, name, version) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:c|m)?js$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !file.slice(directory.length).includes("/node_modules/"));
  for (const file of files) {
    for (const source of mapSources(file)) {
      const named = mappedPackage(source);
      if (named?.name === name && named.version === version) return true;
    }
  }
  return false;
}

/**
 * What `doneWhen17Problems` reads of the key of an entry of `name`'s notices
 * against `closure`, its production closure, and `beyond`: the package it
 * names, by its name and directory (`found`), or why it names none the
 * notices may cover (`problem`, the end of a sentence about the entry). A
 * key of the closure or of `beyond`, by `name@version`; one vendored in
 * such a package, whose `package.json` at its path under that package's
 * directory names it; one vendored in such a package by the reviewed list of
 * vendored copies (`LISTED`), whose entry for that holder at that version
 * says a copy bundles it, the copy at the entry's path in the holder's
 * directory at the entry's SHA-256; or one bundled in the package another
 * such key names, whose code the reviewed list (`VERBATIM`) gives to a file
 * of that package's, or the source map of a JavaScript file under that
 * package's directory names at that version (`mapsName`).
 */
function readEntry(key, name, closure, beyond) {
  const among = (wanted) =>
    closure.packages.get(wanted) ??
    [...beyond.values()].find((found) => found.key === wanted);
  const bundled = BUNDLED.exec(key);
  if (bundled !== null) {
    const [, id, holderKey] = bundled;
    const holder = readEntry(holderKey, name, closure, beyond);
    if (holder.found === undefined) {
      return {
        problem: `and ${holderKey}, which it names as bundling it, is no package of the production closure of ${name} or of WEB.beyondClosure, nor one vendored in such a package`,
      };
    }
    const at = id.lastIndexOf("@");
    const [bundledName, version] =
      at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, undefined];
    const listed = VERBATIM.files.some(
      ({ holder: shipper, bundles }) =>
        shipper === holder.found.name &&
        bundles.some((each) => `${each.name}@${each.version}` === id),
    );
    if (!listed && !mapsName(holder.found.directory, bundledName, version)) {
      return {
        problem: `and neither ${VERBATIM.file} nor a source map of ${holderKey} names ${id}`,
      };
    }
    return { found: { name: bundledName } };
  }
  const listed = LISTED.exec(key);
  if (listed !== null) {
    const [, id, holderKey] = listed;
    const holder = among(holderKey);
    const at = id.lastIndexOf("@");
    const listedName = at > 0 ? id.slice(0, at) : id;
    const copies = VENDORED_COPIES.copies.filter(
      ({ holder: name, version, bundles }) =>
        `${name}@${version}` === holderKey &&
        bundles.some((each) => `${each.name}@${each.version}` === id),
    );
    const held =
      holder !== undefined &&
      copies.some(({ path, sha256 }) => {
        const file = join(holder.directory, path);
        return (
          existsSync(file) &&
          createHash("sha256").update(readFileSync(file)).digest("hex") ===
            sha256
        );
      });
    if (!held) {
      return {
        problem: `and ${VENDORED_COPIES.file} lists no copy that ${holderKey}, of the production closure of ${name} or of WEB.beyondClosure, holds at its SHA-256 and that bundles ${id}`,
      };
    }
    return { found: { name: listedName } };
  }
  const vendored = VENDORED.exec(key);
  if (vendored !== null) {
    const holder = among(vendored[2]);
    const directory =
      holder === undefined ? undefined : join(holder.directory, vendored[3]);
    const manifest =
      directory === undefined ? undefined : join(directory, "package.json");
    const named =
      manifest !== undefined && existsSync(manifest)
        ? JSON.parse(readFileSync(manifest, "utf8"))
        : undefined;
    if (
      named === undefined ||
      `${named.name}${typeof named.version === "string" ? `@${named.version}` : ""}` !==
        vendored[1]
    ) {
      return {
        problem: `and no package.json at ${vendored[3]} in ${vendored[2]}, of the production closure of ${name} or of WEB.beyondClosure, names it`,
      };
    }
    return { found: { name: named.name, directory } };
  }
  const installed = among(key);
  if (installed === undefined) {
    return {
      problem: `which is outside the production closure of ${name} and not one of WEB.beyondClosure`,
    };
  }
  return {
    found: {
      name: key.replace(/@[^@]+$/u, ""),
      directory: installed.directory,
    },
  };
}

/**
 * Done when 17's problems with the three tarballs (manifest-h.md §5, its
 * notices as rulings 197 item 4 and 198 item 1 read them), each naming its
 * tarball:
 * an empty list is three tarballs that meet it. `tarballs` maps each packed
 * name to its regular files by path, as G.7's `readTarball` reads them;
 * `closures` maps `@requestport/web` to the production closure that bounds
 * its `THIRD-PARTY-NOTICES` (`noticedClosures`); `beyond` is each package
 * `WEB.beyondClosure` names, as this tree installs it (`beyondPackages`).
 *
 * `requestport` must carry no `THIRD-PARTY-NOTICES`, and its `dist/` must
 * name no module but `apps/requestport`'s (the first problems). Each of
 * `@requestport/web`'s notices' entries must be a package of that closure
 * or of `beyond`, by its `name@version`; one vendored in such a package
 * (`<name> (vendored in <holder> at <path>)`), whose `package.json` at that
 * path under the holder's directory names it, whether the holder is a
 * package of the closure or of `beyond`, as the pack accepts either; one
 * vendored in such a package by the reviewed list of vendored copies
 * (`<name>@<version> (vendored in <holder>)`), whose entry for that holder
 * says a copy bundles it, the copy there at the entry's SHA-256; or one
 * bundled in a package another such entry names (`<name>[@<version>]
 * (bundled in <holder>)`), whose code the reviewed list gives to a file of
 * that package's, or the source map of a JavaScript file under its
 * directory names (`readEntry`); and none twice.
 *
 * No file of `@requestport/client`, and no `package.json` of any, may hold
 * `workspace:` at all; any other file of `requestport` or
 * `@requestport/web` may not hold a `workspace:` specifier. RequestPort's
 * own code holds the word in other senses, none of them pnpm's protocol:
 * the operator scope `workspace:telemetry:reveal`, keys that end in it
 * (`slack_workspace:`) and keys built from it (`requestport:workspace:${…}`),
 * in `@requestport/web`'s chunks.
 */
function doneWhen17Problems(tarballs, closures, beyond = beyondPackages()) {
  const problems0 = [];
  const requestport = tarballs.get(REQUESTPORT.published);
  if (requestport !== undefined) {
    if (requestport.has(`package/${NOTICES.file}`)) {
      problems0.push(
        `${REQUESTPORT.published}: it carries a ${NOTICES.file}, and its dist/ compiles in no third-party code`,
      );
    }
    for (const [path, body] of requestport) {
      if (!/^package\/dist\/.*\.js$/u.test(path)) continue;
      for (const [, module] of body
        .toString("utf8")
        .matchAll(/^\/\/ (\S+\.(?:ts|tsx|js|mjs|cjs))$/gmu)) {
        if (!module.startsWith("apps/requestport/")) {
          problems0.push(
            `${REQUESTPORT.published}: ${path} compiles in ${module}, which is not apps/requestport's`,
          );
        }
      }
    }
  }
  const problems = [];
  for (const { name, mapping, wordAllowed } of TARBALLS) {
    const entries = tarballs.get(name);
    if (entries === undefined) {
      problems.push(`${name}: there is no tarball`);
      continue;
    }
    const manifest = entries.get("package/package.json");
    const license =
      manifest === undefined
        ? undefined
        : JSON.parse(manifest.toString("utf8")).license;
    if (license !== mapping.license) {
      problems.push(
        `${name}: its license field is ${JSON.stringify(license)}, not the mapping's ${mapping.license}`,
      );
    }
    const text = entries.get("package/LICENSE");
    if (text === undefined) {
      problems.push(`${name}: it carries no LICENSE`);
    } else if (
      !text.equals(readFileSync(join(repositoryRoot, mapping.licenseText)))
    ) {
      problems.push(
        `${name}: its LICENSE is not ${mapping.licenseText}, byte for byte`,
      );
    }
    for (const [path, body] of entries) {
      const file = basename(path);
      if (/\.test\./u.test(file)) problems.push(`${name}: ${path} is a test`);
      if (file.startsWith(".env")) {
        problems.push(`${name}: ${path} is an .env file`);
      }
      if (
        file === "package.json" || !wordAllowed
          ? body.includes("workspace:")
          : WORKSPACE_SPECIFIER.test(body.toString("latin1"))
      ) {
        problems.push(`${name}: ${path} holds workspace:`);
      }
    }
  }
  for (const { name } of NOTICED) {
    const entries = tarballs.get(name);
    if (entries === undefined) continue;
    const notices = entries.get(`package/${NOTICES.file}`);
    if (notices === undefined) {
      problems.push(`${name}: it carries no ${NOTICES.file}`);
      continue;
    }
    const entered = [
      ...notices
        .toString("utf8")
        .matchAll(new RegExp(`^${RULE}\\nPackage: (.+)$`, "gmu")),
    ].map(([, key]) => key);
    if (entered.length === 0) {
      problems.push(`${name}: ${NOTICES.file} lists no package`);
    }
    const seen = new Set();
    for (const key of entered) {
      const { problem } = readEntry(key, name, closures.get(name), beyond);
      if (problem !== undefined) {
        problems.push(
          `${name}: ${NOTICES.file} has an entry for ${key}, ${problem}`,
        );
      }
      if (seen.has(key)) {
        problems.push(`${name}: ${NOTICES.file} has two entries for ${key}`);
      }
      seen.add(key);
    }
  }
  return [...problems0, ...problems];
}

/**
 * A tree of the self-host build's shape, in place of `next build` (`main`'s
 * `build`): the three packages the stage requires the trace to hold, and
 * `apps/web` with its manifest, whose `workspace:` specifier the stage
 * replaces.
 */
function selfHostFixture(root) {
  for (const [path, body] of Object.entries({
    "node_modules/next/package.json": '{"name":"next"}\n',
    "node_modules/react/package.json": '{"name":"react"}\n',
    "node_modules/react-dom/package.json": '{"name":"react-dom"}\n',
    "apps/web/package.json": `${JSON.stringify({
      name: "@requestport/web",
      private: true,
      type: "module",
      dependencies: { "@requestport/core": "workspace:*" },
    })}\n`,
    "apps/web/server.js": "export {};\n",
    "apps/web/.next-self-host/server/chunks/1.js": "export const page = 1;\n",
    // The files the reviewed list names, which the build copies as they are
    // from next, as this tree installs it (VERBATIM).
    ...Object.fromEntries(
      VERBATIM.files.map(({ holder, path, emitted }) => [
        join(
          "apps/web/.next-self-host",
          emitted
            .replace("<hash>", "0123456789abcdef")
            .replace("<build id>", "fixture-build"),
        ),
        readFileSync(join(installedForWeb(holder), path)),
      ]),
    ),
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return {
    standaloneDirectory: root,
    serverDirectory: join(root, "apps/web"),
    contained: CONTAINED,
  };
}

/**
 * The run's tarballs, by packed name, and where they came from: the hand-run
 * pack's that `PACK_REQUESTPORT_OUT` names, or `main`'s, run here.
 */
async function packedTarballs() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: a hand run's input. The gate runs this file with node --test, not as a Turbo task, and sets no such variable.
  const out = process.env.PACK_REQUESTPORT_OUT;
  if (out !== undefined && out !== "") {
    const record = JSON.parse(
      readFileSync(join(out, "build-record.json"), "utf8"),
    );
    return {
      from: `the tarballs a run of pack-requestport.mjs at ${record.commit} packed into ${resolve(out)}`,
      tarballs: new Map(
        record.tarballs.map(({ name, file }) => [
          name,
          readTarball(join(out, file)),
        ]),
      ),
    };
  }
  const run = await main(
    ["--version", "0.0.0-package-contract", "--out", join(scratch, "packed")],
    {
      treeStatus: () => "",
      log: () => {},
      build: async () => selfHostFixture(join(scratch, "self-host")),
    },
  );
  return {
    from: "the tarballs pack-requestport.mjs's main packed here, from a fixture self-host build",
    tarballs: new Map(
      Object.values(run.packs).map(({ staged, entries }) => [
        staged.manifest.name,
        entries,
      ]),
    ),
  };
}

/** `packedTarballs()`'s answer, packed or read once for every suite here. */
let packing;
function tarballsOnce() {
  packing ??= packedTarballs();
  return packing;
}

/**
 * The E2E owner storage, by the words G.7's check refuses in core's tarball
 * (`scripts/pack-packages.mjs`): its factory's name, its refusals' names, and
 * their wording. This reader keeps its own copy, as it does of the
 * `workspace:` specifier, so that it does not lean on the pack's.
 */
const E2E_OWNER_STORAGE =
  /createE2EOwnerStorage|E2E_OWNER_STORAGE_REFUSED|E2E owner storage/u;

/** `apps/web`'s test routes, the directories under `src/app/api/test`. */
const TEST_ROUTES = Object.freeze([
  "/api/test/scenarios",
  "/api/test/email-outbox",
]);

/**
 * The E2E owner storage and the test routes in any tarball of `tarballs`
 * (every tarball of the run), which ruling 170 refuses, each naming its
 * tarball and file: a file that holds the storage, a file under one of
 * `TEST_ROUTES`' directories, and a file that names one of them. It looks
 * for nothing else: the three test seams ruling 174 leaves out (auth's E2E
 * magic-link outbox, apps/web's scenario-fault register, and the E2E fence
 * on the CSP's `upgrade-insecure-requests`) are `seamProblems`' (below).
 */
function storageAndRouteProblems(tarballs) {
  const problems = [];
  for (const [name, entries] of tarballs) {
    for (const [path, body] of entries) {
      const text = body.toString("latin1");
      if (E2E_OWNER_STORAGE.test(text)) {
        problems.push(`${name}: ${path} holds the E2E owner storage`);
      }
      for (const route of TEST_ROUTES) {
        if (path.includes(`/app${route}/`)) {
          problems.push(`${name}: ${path} is under the test route ${route}`);
        }
        if (text.includes(route)) {
          problems.push(`${name}: ${path} names the test route ${route}`);
        }
      }
    }
  }
  return problems;
}

/** The repository's files under `paths` (all of it with none), tracked or not ignored. */
function repositoryFiles(...paths) {
  const run = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...paths,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split("\0").filter((path) => path !== "");
}

/** `entries` with `path` set to `body`, or removed when `body` is undefined. */
function planted(entries, path, body) {
  const copy = new Map(entries);
  if (body === undefined) copy.delete(path);
  else copy.set(path, Buffer.from(body));
  return copy;
}

/**
 * `tarballs` with `name`'s entries replaced by `entries`, or removed when
 * `entries` is undefined; every other tarball as it was.
 */
function replacing(tarballs, name, entries) {
  const copy = new Map(tarballs);
  if (entries === undefined) copy.delete(name);
  else copy.set(name, entries);
  return copy;
}

describe("Done when 17 over H's three tarballs (manifest-h.md §5)", () => {
  const closures = noticedClosures();
  let packed;

  before(async () => {
    packed = await tarballsOnce();
  });

  test("the run packs fourteen, G.7's eleven and H's three, and H's three meet it: each license field and LICENSE the mapping's, LICENSE byte for byte its file under licenses/; a THIRD-PARTY-NOTICES in @requestport/web's, with entries only for packages of its production closure or of WEB.beyondClosure, or vendored or bundled in one, and of the run's other tarballs in @requestport/db's alone, which G.7's pack writes (ruling 209), requestport's dist/ naming no module but its own; no workspace:, *.test.* or .env* in any", (t) => {
    t.diagnostic(packed.from);
    assert.deepEqual(
      [...packed.tarballs.keys()].sort(),
      [
        ...Object.values(PACKAGES).map(({ bundle }) => bundle.package),
        ...TARBALLS.map(({ name }) => name),
      ].sort(),
    );
    assert.deepEqual(doneWhen17Problems(packed.tarballs, closures), []);
    for (const { name, mapping } of TARBALLS) {
      const entries = packed.tarballs.get(name);
      assert.deepEqual(
        entries.get("package/LICENSE"),
        readFileSync(join(repositoryRoot, mapping.licenseText)),
        name,
      );
      assert.equal(
        JSON.parse(entries.get("package/package.json").toString("utf8"))
          .license,
        D3.license,
        name,
      );
    }
    for (const { name } of NOTICED) {
      assert.ok(
        noticesEntries(
          packed.tarballs
            .get(name)
            .get(`package/${NOTICES.file}`)
            .toString("utf8"),
        ).length > 0,
        name,
      );
    }
    for (const [name, entries] of packed.tarballs) {
      assert.equal(
        entries.has(`package/${NOTICES.file}`),
        name === WEB.published || name === "@requestport/db",
        name,
      );
    }
  });

  test("each clause fails on a planted violation, naming the tarball and the file", () => {
    const requestport = packed.tarballs.get(REQUESTPORT.published);
    const web = packed.tarballs.get(WEB.published);
    const client = packed.tarballs.get(CLIENT_NAME);
    const notices = web.get(`package/${NOTICES.file}`).toString("utf8");
    const [first] = noticesEntries(notices).map(({ key }) => key);
    const manifest = JSON.parse(
      requestport.get("package/package.json").toString("utf8"),
    );
    const all = packed.tarballs;
    for (const [what, tarballs, expected] of [
      [
        "a LICENSE one byte off",
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            "package/LICENSE",
            `${requestport.get("package/LICENSE")} `,
          ),
        ),
        [
          `${REQUESTPORT.published}: its LICENSE is not ${REQUESTPORT.licenseText}, byte for byte`,
        ],
      ],
      [
        "no LICENSE",
        replacing(all, CLIENT_NAME, planted(client, "package/LICENSE")),
        [`${CLIENT_NAME}: it carries no LICENSE`],
      ],
      [
        "no LICENSE in @requestport/web",
        replacing(all, WEB.published, planted(web, "package/LICENSE")),
        [`${WEB.published}: it carries no LICENSE`],
      ],
      [
        "another license field",
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            "package/package.json",
            JSON.stringify({ ...manifest, license: "MIT" }),
          ),
        ),
        [
          `${REQUESTPORT.published}: its license field is "MIT", not the mapping's ${REQUESTPORT.license}`,
        ],
      ],
      [
        "a test",
        replacing(
          all,
          REQUESTPORT.published,
          planted(requestport, "package/dist/cli.test.js", "export {};\n"),
        ),
        [`${REQUESTPORT.published}: package/dist/cli.test.js is a test`],
      ],
      [
        "an .env file",
        replacing(
          all,
          CLIENT_NAME,
          planted(client, "package/.env.local", "A=1\n"),
        ),
        [`${CLIENT_NAME}: package/.env.local is an .env file`],
      ],
      [
        "workspace: in a package.json of @requestport/web's",
        replacing(
          all,
          WEB.published,
          planted(
            web,
            "package/.next-self-host/package.json",
            '{"dependencies":{"@requestport/core":"workspace:*"}}\n',
          ),
        ),
        [
          `${WEB.published}: package/.next-self-host/package.json holds workspace:`,
        ],
      ],
      [
        "a workspace: specifier in a module",
        replacing(
          all,
          CLIENT_NAME,
          planted(
            client,
            "package/dist/index.js",
            'export const version = "workspace:^";\n',
          ),
        ),
        [`${CLIENT_NAME}: package/dist/index.js holds workspace:`],
      ],
      [
        "a workspace: specifier in pnpm's alias form, workspace:<name>@<range>, in a module of @requestport/web's",
        replacing(
          all,
          WEB.published,
          planted(
            web,
            "package/server.js",
            'const core = "workspace:@requestport/core@^";\n',
          ),
        ),
        [`${WEB.published}: package/server.js holds workspace:`],
      ],
      [
        "the word workspace: in the client, which holds it nowhere",
        replacing(
          all,
          CLIENT_NAME,
          planted(
            client,
            "package/dist/index.js",
            "// workspace: the word alone\nexport {};\n",
          ),
        ),
        [`${CLIENT_NAME}: package/dist/index.js holds workspace:`],
      ],
      [
        "a notices entry in @requestport/web's for a package outside its production closure, and a second entry for one package",
        replacing(
          all,
          WEB.published,
          planted(
            web,
            `package/${NOTICES.file}`,
            `${notices}\n${RULE}\nPackage: left-pad@1.3.0\nLicense: MIT\n\n${RULE}\nPackage: ${first}\nLicense: MIT\n`,
          ),
        ),
        [
          `${WEB.published}: ${NOTICES.file} has an entry for left-pad@1.3.0, which is outside the production closure of ${WEB.published} and not one of WEB.beyondClosure`,
          `${WEB.published}: ${NOTICES.file} has two entries for ${first}`,
        ],
      ],
      [
        "notices entries in @requestport/web's for code bundled in a package outside its production closure, and for a package the bundling package's maps and the reviewed list do not name",
        replacing(
          all,
          WEB.published,
          planted(
            web,
            `package/${NOTICES.file}`,
            `${notices}\n${RULE}\nPackage: ajv@8.18.0 (bundled in left-pad@1.3.0)\nLicense: MIT\n\n${RULE}\nPackage: left-pad@1.3.0 (bundled in ${first})\nLicense: MIT\n`,
          ),
        ),
        [
          `${WEB.published}: ${NOTICES.file} has an entry for ajv@8.18.0 (bundled in left-pad@1.3.0), and left-pad@1.3.0, which it names as bundling it, is no package of the production closure of ${WEB.published} or of WEB.beyondClosure, nor one vendored in such a package`,
          `${WEB.published}: ${NOTICES.file} has an entry for left-pad@1.3.0 (bundled in ${first}), and neither ${VERBATIM.file} nor a source map of ${first} names left-pad@1.3.0`,
        ],
      ],
      [
        "no notices in @requestport/web's",
        replacing(all, WEB.published, planted(web, `package/${NOTICES.file}`)),
        [`${WEB.published}: it carries no ${NOTICES.file}`],
      ],
      [
        "notices in requestport's",
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            `package/${NOTICES.file}`,
            "Third-party notices\n",
          ),
        ),
        [
          `${REQUESTPORT.published}: it carries a ${NOTICES.file}, and its dist/ compiles in no third-party code`,
        ],
      ],
      [
        "a third-party module compiled into requestport's dist/",
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            "package/dist/chunk-PLANTED.js",
            "// node_modules/left-pad/index.js\nexport {};\n",
          ),
        ),
        [
          `${REQUESTPORT.published}: package/dist/chunk-PLANTED.js compiles in node_modules/left-pad/index.js, which is not apps/requestport's`,
        ],
      ],
      [
        "no tarball",
        replacing(all, CLIENT_NAME, undefined),
        [`${CLIENT_NAME}: there is no tarball`],
      ],
      [
        "no @requestport/web tarball",
        replacing(all, WEB.published, undefined),
        [`${WEB.published}: there is no tarball`],
      ],
    ]) {
      assert.deepEqual(doneWhen17Problems(tarballs, closures), expected, what);
    }
    assert.deepEqual(
      doneWhen17Problems(
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            "package/dist/scopes.js",
            'export const scope = "workspace:telemetry:reveal";\nexport const to = "workspace:owner@example.com";\n',
          ),
        ),
        closures,
      ),
      [],
      "a scope named workspace:telemetry:reveal, and an address after workspace:, are not workspace: specifiers",
    );
  });

  test("an entry vendored in a package WEB.beyondClosure names is read as the pack reads it (ruling 198 item 3): containedClosure accepts the package, and Done when 17 accepts its entry, read against that package's directory; an entry vendored in a package of neither the closure nor WEB.beyondClosure is refused", () => {
    const all = packed.tarballs;
    const web = all.get(WEB.published);
    const notices = web.get(`package/${NOTICES.file}`).toString("utf8");
    const holder = join(scratch, "beyond-holder", "node_modules", "process");
    mkdirSync(join(holder, "vendor", "inner"), { recursive: true });
    writeFileSync(
      join(holder, "package.json"),
      '{"name":"process","version":"0.11.10"}\n',
    );
    writeFileSync(join(holder, "browser.js"), "module.exports = {};\n");
    writeFileSync(
      join(holder, "vendor/inner/package.json"),
      '{"name":"inner","version":"1.0.0"}\n',
    );
    writeFileSync(
      join(holder, "vendor/inner/index.js"),
      "module.exports = 1;\n",
    );
    const key = "inner@1.0.0 (vendored in process@0.11.10 at vendor/inner)";
    const { closure, problems } = containedClosure(
      closures.get(WEB.published),
      {
        compilers: WEB.compilers,
        files: [
          join(holder, "browser.js"),
          join(holder, "vendor/inner/index.js"),
        ],
      },
      ["process"],
    );
    assert.deepEqual(problems, []);
    assert.deepEqual([...closure.packages.keys()], [key, "process@0.11.10"]);
    const beyond = new Map([
      ["process", { key: "process@0.11.10", directory: holder }],
    ]);
    const plant = (entry) =>
      replacing(
        all,
        WEB.published,
        planted(
          web,
          `package/${NOTICES.file}`,
          `${notices}\n${RULE}\nPackage: ${entry}\nLicense: MIT\n`,
        ),
      );
    assert.deepEqual(doneWhen17Problems(plant(key), closures, beyond), []);
    const stray = "inner@1.0.0 (vendored in left-pad@1.3.0 at vendor/inner)";
    assert.deepEqual(doneWhen17Problems(plant(stray), closures, beyond), [
      `${WEB.published}: ${NOTICES.file} has an entry for ${stray}, and no package.json at vendor/inner in left-pad@1.3.0, of the production closure of ${WEB.published} or of WEB.beyondClosure, names it`,
    ]);
    // The real WEB.beyondClosure package, as Next's webpack configuration
    // finds it: the copy pnpm's store hoists.
    assert.deepEqual(
      [...beyondPackages()].map(([found, { directory }]) => [found, directory]),
      [
        [
          "process",
          realpathSync(
            join(repositoryRoot, "node_modules/.pnpm/node_modules/process"),
          ),
        ],
      ],
    );
  });

  test("an entry vendored by the reviewed list of vendored copies (ruling 199 item 1) is read against that list and the copy's bytes: each package the list says @trigger.dev/core's superjson bundle bundles, as vendored in the @trigger.dev/core this tree installs, is accepted; one the list does not give to that holder, one in a holder at another version, and one whose holder's copies are not at the list's SHA-256 are refused", () => {
    const all = packed.tarballs;
    const web = all.get(WEB.published);
    const production = closures.get(WEB.published);
    const [core] = [...production.packages.keys()].filter((key) =>
      key.startsWith("@trigger.dev/core@"),
    );
    // The list's @trigger.dev/core entries; its others, for a bundler's
    // runtime in other holders (ruling 210 item 2), are not this case's.
    const copies = VENDORED_COPIES.copies.filter(
      ({ holder }) => holder === "@trigger.dev/core",
    );
    const listed = [
      ...new Set(
        copies.flatMap(({ holder, version, bundles }) =>
          bundles.map(
            (each) =>
              `${each.name}@${each.version} (vendored in ${holder}@${version})`,
          ),
        ),
      ),
    ].sort();
    assert.deepEqual(listed, [
      `copy-anything@3.0.5 (vendored in ${core})`,
      `is-what@4.1.16 (vendored in ${core})`,
      `superjson@2.2.1 (vendored in ${core})`,
    ]);
    // Notices of these entries alone, in place of the packed ones.
    const plant = (entries) =>
      replacing(
        all,
        WEB.published,
        planted(
          web,
          `package/${NOTICES.file}`,
          `${WEB.notices.header}${entries
            .map((entry) => `\n${RULE}\nPackage: ${entry}\nLicense: MIT\n`)
            .join("")}`,
        ),
      );
    assert.deepEqual(doneWhen17Problems(plant(listed), closures), []);
    const unlisted = `left-pad@1.3.0 (vendored in ${core})`;
    const elsewhere = "superjson@2.2.1 (vendored in @trigger.dev/core@0.0.1)";
    const refusal = (key, holder) =>
      `${WEB.published}: ${NOTICES.file} has an entry for ${key}, and ${VENDORED_COPIES.file} lists no copy that ${holder}, of the production closure of ${WEB.published} or of WEB.beyondClosure, holds at its SHA-256 and that bundles ${key.split(" ")[0]}`;
    assert.deepEqual(
      doneWhen17Problems(plant([unlisted, elsewhere]), closures),
      [refusal(unlisted, core), refusal(elsewhere, "@trigger.dev/core@0.0.1")],
    );
    // The holder's copies changed: the list's SHA-256 no longer holds.
    const changed = join(scratch, "changed-core");
    for (const { path } of copies) {
      mkdirSync(dirname(join(changed, path)), { recursive: true });
      writeFileSync(join(changed, path), "export {};\n");
    }
    const moved = new Map([
      [
        WEB.published,
        {
          ...production,
          packages: new Map([
            ...production.packages,
            [core, { ...production.packages.get(core), directory: changed }],
          ]),
        },
      ],
    ]);
    assert.deepEqual(doneWhen17Problems(plant([listed[2]]), moved), [
      refusal(listed[2], core),
    ]);
  });

  test("an entry bundled in a package is read as the pack reads its maps (H.7 round 6's review): a source a data: URL map names, one an index map's sections name, and one under a store directory that records no version, each at the version recorded, are accepted; a declaration, a version the maps do not record, and a version-less entry for a source that records one are refused; the real @modelcontextprotocol/server's maps name ajv@8.18.0, and not ajv@0.0.1", () => {
    const all = packed.tarballs;
    const web = all.get(WEB.published);
    const notices = web.get(`package/${NOTICES.file}`).toString("utf8");
    const holder = join(scratch, "bundling-holder", "node_modules", "process");
    const inline = {
      version: 3,
      sources: [
        "../../node_modules/.pnpm/exact@1.2.3/node_modules/exact/index.js",
        "../../node_modules/.pnpm/decl@1.0.0/node_modules/decl/index.d.ts",
      ],
      mappings: "",
    };
    const sectioned = {
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: {
            version: 3,
            sources: [
              "../node_modules/.pnpm/@scope+sect@2.0.0_peer@1.0.0/node_modules/@scope/sect/index.js",
            ],
            mappings: "",
          },
        },
      ],
    };
    const loose = {
      version: 3,
      sources: [
        "../node_modules/.pnpm/unversioned/node_modules/loose/index.js",
      ],
      mappings: "",
    };
    mkdirSync(join(holder, "dist"), { recursive: true });
    writeFileSync(
      join(holder, "package.json"),
      '{"name":"process","version":"0.11.10"}\n',
    );
    writeFileSync(
      join(holder, "dist/inline.js"),
      `export {};\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(inline)).toString("base64")}\n`,
    );
    writeFileSync(
      join(holder, "dist/sectioned.js"),
      "export {};\n//# sourceMappingURL=sectioned.js.map\n",
    );
    writeFileSync(
      join(holder, "dist/sectioned.js.map"),
      JSON.stringify(sectioned),
    );
    writeFileSync(join(holder, "dist/loose.js"), "export {};\n");
    writeFileSync(join(holder, "dist/loose.js.map"), JSON.stringify(loose));
    const beyond = new Map([
      ["process", { key: "process@0.11.10", directory: holder }],
    ]);
    const plant = (...keys) =>
      replacing(
        all,
        WEB.published,
        planted(
          web,
          `package/${NOTICES.file}`,
          `${notices}${keys.map((key) => `\n${RULE}\nPackage: ${key}\nLicense: MIT\n`).join("")}`,
        ),
      );
    const within = (id) => `${id} (bundled in process@0.11.10)`;
    assert.deepEqual(
      doneWhen17Problems(
        plant(
          within("exact@1.2.3"),
          within("@scope/sect@2.0.0"),
          within("loose"),
        ),
        closures,
        beyond,
      ),
      [],
    );
    const refused = (id) =>
      `${WEB.published}: ${NOTICES.file} has an entry for ${within(id)}, and neither ${VERBATIM.file} nor a source map of process@0.11.10 names ${id}`;
    assert.deepEqual(
      doneWhen17Problems(
        plant(
          within("decl@1.0.0"),
          within("exact@1.2.4"),
          within("exact"),
          within("loose@1.0.0"),
        ),
        closures,
        beyond,
      ),
      [
        refused("decl@1.0.0"),
        refused("exact@1.2.4"),
        refused("exact"),
        refused("loose@1.0.0"),
      ],
    );
    // The real holder, whose dist's maps record ajv at 8.18.0.
    const [server] = [...closures.get(WEB.published).packages.keys()].filter(
      (key) => key.startsWith("@modelcontextprotocol/server@"),
    );
    const real = (id) => `${id} (bundled in ${server})`;
    // A real pack's notices hold this entry already (PACK_REQUESTPORT_OUT):
    // the second one planted is counted twice, and is not refused otherwise.
    assert.deepEqual(
      doneWhen17Problems(plant(real("ajv@8.18.0")), closures).filter(
        (problem) =>
          !problem.endsWith(`has two entries for ${real("ajv@8.18.0")}`),
      ),
      [],
    );
    assert.deepEqual(doneWhen17Problems(plant(real("ajv@0.0.1")), closures), [
      `${WEB.published}: ${NOTICES.file} has an entry for ${real("ajv@0.0.1")}, and neither ${VERBATIM.file} nor a source map of ${server} names ajv@0.0.1`,
    ]);
  });

  test("nothing is published: every packed manifest of the run, the fourteen, says private: false, which the owner's publish of the checked tarball needs (J question 14's option (B), ruling 175), names the public repository with its workspace as directory (ruling 207 item 3) and LICENSE in files, and has no scripts; every source manifest stays private, and nothing H adds names a publish command", () => {
    assert.equal(packed.tarballs.size, 14);
    const workspaces = {
      requestport: REQUESTPORT.source,
      [WEB.published]: WEB.source,
      "@requestport/client": CLIENT.source,
    };
    for (const [name, entries] of packed.tarballs) {
      const manifest = JSON.parse(
        entries.get("package/package.json").toString("utf8"),
      );
      assert.equal(manifest.private, false, name);
      assert.deepEqual(
        manifest.repository,
        {
          type: "git",
          url: "git+https://github.com/crissmoldovan/requestport.git",
          directory:
            workspaces[name] ??
            `packages/${name.slice("@requestport/".length)}`,
        },
        name,
      );
      assert.ok(manifest.files.includes("LICENSE"), name);
      assert.equal(manifest.scripts, undefined, name);
    }

    const manifests = repositoryFiles().filter(
      (path) => basename(path) === "package.json",
    );
    // How many is the tree's own count, not a constant (ruling 208 item 2):
    // the manifest of the root and of each project pnpm-workspace.yaml makes
    // a workspace is among those read, in the private tree and in the
    // public seed, which carries fewer workspaces.
    const projects = [...workspaceProjects(repositoryRoot).values()].map(
      (directory) =>
        relative(realpathSync(repositoryRoot), join(directory, "package.json")),
    );
    assert.ok(projects.length > 1, `${projects.length} workspace projects`);
    for (const path of projects) {
      assert.ok(manifests.includes(path), path);
    }
    for (const path of [
      "package.json",
      `${REQUESTPORT.source}/package.json`,
      `${WEB.source}/package.json`,
      `${CLIENT.source}/package.json`,
    ]) {
      assert.ok(manifests.includes(path), path);
    }
    assert.deepEqual(
      manifests.filter(
        (path) =>
          JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"))
            .private !== true,
      ),
      [],
    );

    for (const source of [REQUESTPORT.source, WEB.source, CLIENT.source]) {
      const { scripts = {} } = JSON.parse(
        readFileSync(join(repositoryRoot, source, "package.json"), "utf8"),
      );
      assert.deepEqual(
        Object.keys(scripts).filter((script) => /publish/u.test(script)),
        [],
        source,
      );
    }
    // What H adds: the pack, the bundle's configuration, the program and its
    // client, and H.0's probe scripts. G.7's two patterns
    // (`pack-packages.test.mjs`, "built, not published").
    const added = repositoryFiles(
      "scripts/pack-requestport.mjs",
      `${REQUESTPORT.source}/bundle.mjs`,
      `${REQUESTPORT.source}/bin`,
      `${REQUESTPORT.source}/src`,
      `${CLIENT.source}/src`,
      "spikes/h0-probe",
    );
    assert.ok(added.length > 100, `${added.length} files`);
    for (const path of added) {
      const text = readFileSync(join(repositoryRoot, path), "utf8");
      assert.doesNotMatch(text, /(["'`])publish\1/u, path);
      assert.doesNotMatch(
        text,
        /\b(?:npm|pnpm|yarn|bun)\b[\s"',[\]]*publish\b/u,
        path,
      );
    }
  });
});

describe("no E2E owner storage and no test route in any tarball (ruling 170)", () => {
  let packed;

  before(async () => {
    packed = await tarballsOnce();
  });

  test("none carries the storage or a test route: no file holds the E2E owner storage, and none is under or names /api/test/scenarios or /api/test/email-outbox, the routes apps/web serves under src/app/api/test", (t) => {
    t.diagnostic(packed.from);
    assert.deepEqual(
      [...TEST_ROUTES].sort(),
      repositoryFiles("apps/web/src/app/api/test")
        .filter((path) => /\/route\.ts$/u.test(path))
        .map((path) =>
          path.replace(/^apps\/web\/src\/app(.+)\/route\.ts$/u, "$1"),
        )
        .sort(),
    );
    assert.deepEqual(storageAndRouteProblems(packed.tarballs), []);
  });

  test("each fails on a planted storage or route, naming the tarball and the file", () => {
    const requestport = packed.tarballs.get(REQUESTPORT.published);
    const web = packed.tarballs.get(WEB.published);
    const client = packed.tarballs.get(CLIENT_NAME);
    const all = packed.tarballs;
    const chunk = [...requestport.keys()].find((path) =>
      /^package\/dist\/chunk-[^/]+\.js$/u.test(path),
    );
    const route =
      "package/.next-self-host/server/app/api/test/scenarios/route.js";
    const manifest = "package/.next-self-host/routes-manifest.json";
    for (const [what, tarballs, expected] of [
      [
        "the E2E owner storage's factory in a chunk of requestport's",
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            chunk,
            `${requestport.get(chunk)}\nfunction createE2EOwnerStorage() {}\n`,
          ),
        ),
        [`${REQUESTPORT.published}: ${chunk} holds the E2E owner storage`],
      ],
      [
        "a refusal's words in the client",
        replacing(
          all,
          CLIENT_NAME,
          planted(
            client,
            "package/dist/index.js",
            'throw new Error("The E2E owner storage is never built on Vercel.");\n',
          ),
        ),
        [`${CLIENT_NAME}: package/dist/index.js holds the E2E owner storage`],
      ],
      [
        "a test route's file in @requestport/web",
        replacing(all, WEB.published, planted(web, route, "export {};\n")),
        [
          `${WEB.published}: ${route} is under the test route /api/test/scenarios`,
        ],
      ],
      [
        "a test route named in a manifest of @requestport/web's",
        replacing(
          all,
          WEB.published,
          planted(
            web,
            manifest,
            '{"staticRoutes":[{"page":"/api/test/email-outbox"}]}\n',
          ),
        ),
        [
          `${WEB.published}: ${manifest} names the test route /api/test/email-outbox`,
        ],
      ],
    ]) {
      assert.deepEqual(storageAndRouteProblems(tarballs), expected, what);
    }
  });
});

/**
 * The three test seams ruling 174 leaves out of every tarball, by
 * the text that shows their real modules in a build: auth's E2E magic-link
 * outbox (`packages/auth/src/e2e-email-outbox.ts`: its path, its key, its
 * token header, its refusal's words, and the two variables its E2E
 * predicate reads, which are E2E mode's own and other E2E modules hold too),
 * apps/web's scenario-fault register
 * (`apps/web/src/lib/e2e-scenario-fault.ts`: its path, its key and its
 * cookie) and the CSP's E2E fence (`packages/server/src/e2e-csp-fence.ts`:
 * its path; its condition is the outbox's predicate). Of the repository's
 * source outside tests and test support, the seams' table aside, each but
 * those two variables is held by its real module alone, and a path by no
 * module (`apps/requestport/src/web/test-seams.test.ts` lists each one's
 * holders).
 * This reader keeps its own copy, as it does of the E2E owner storage, and
 * holds it equal to the pack's (`apps/requestport/src/web/test-seams.ts`'s
 * `TEST_SEAMS`).
 */
const TEST_SEAM_MARKERS = Object.freeze({
  "auth's E2E magic-link outbox": Object.freeze([
    "packages/auth/src/e2e-email-outbox.ts",
    "requestport.e2e.magic-link-outbox",
    "x-requestport-e2e-token",
    "E2E email outbox is unavailable",
    "REQUESTPORT_E2E_MODE",
    "REQUESTPORT_E2E_TOKEN",
  ]),
  "apps/web's scenario-fault register": Object.freeze([
    "apps/web/src/lib/e2e-scenario-fault.ts",
    "requestport.e2e.scenario-runs",
    "requestport.e2e_scenario",
  ]),
  "the CSP's E2E fence": Object.freeze([
    "packages/server/src/e2e-csp-fence.ts",
  ]),
});

/** Each file of any tarball of `tarballs` (every tarball of the run) holding a seam's marker, naming the tarball, the file, the seam and the marker. */
function seamProblems(tarballs) {
  const problems = [];
  for (const [name, entries] of tarballs) {
    for (const [path, body] of entries) {
      const text = body.toString("latin1");
      for (const [seam, markers] of Object.entries(TEST_SEAM_MARKERS)) {
        for (const marker of markers) {
          if (text.includes(marker)) {
            problems.push(`${name}: ${path} holds ${seam} (${marker})`);
          }
        }
      }
    }
  }
  return problems;
}

describe("no test seam in any tarball (ruling 174)", () => {
  let packed;

  before(async () => {
    packed = await tarballsOnce();
  });

  test("none carries one: no file holds a marker of auth's E2E magic-link outbox, apps/web's scenario-fault register or the CSP's E2E fence; and this list is the pack's", (t) => {
    t.diagnostic(packed.from);
    assert.deepEqual(
      Object.fromEntries(
        TEST_SEAMS.map(({ name, markers }) => [name, [...markers]]),
      ),
      Object.fromEntries(
        Object.entries(TEST_SEAM_MARKERS).map(([name, markers]) => [
          name,
          [...markers],
        ]),
      ),
    );
    assert.deepEqual(seamProblems(packed.tarballs), []);
  });

  test("each fails on a planted marker, naming the tarball, the file, the seam and the marker", () => {
    const requestport = packed.tarballs.get(REQUESTPORT.published);
    const web = packed.tarballs.get(WEB.published);
    const client = packed.tarballs.get(CLIENT_NAME);
    const all = packed.tarballs;
    const chunk = [...requestport.keys()].find((path) =>
      /^package\/dist\/chunk-[^/]+\.js$/u.test(path),
    );
    const middleware = "package/.next-self-host/server/middleware.js";
    for (const [what, tarballs, expected] of [
      [
        "the outbox's key in @requestport/web's middleware",
        replacing(
          all,
          WEB.published,
          planted(
            web,
            middleware,
            'Symbol.for("requestport.e2e.magic-link-outbox");\n',
          ),
        ),
        [
          `${WEB.published}: ${middleware} holds auth's E2E magic-link outbox (requestport.e2e.magic-link-outbox)`,
        ],
      ],
      [
        "E2E mode's variables in a chunk of requestport's",
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            chunk,
            `${requestport.get(chunk)}\nconst open = env.REQUESTPORT_E2E_MODE === "1" && env.REQUESTPORT_E2E_TOKEN;\n`,
          ),
        ),
        [
          `${REQUESTPORT.published}: ${chunk} holds auth's E2E magic-link outbox (REQUESTPORT_E2E_MODE)`,
          `${REQUESTPORT.published}: ${chunk} holds auth's E2E magic-link outbox (REQUESTPORT_E2E_TOKEN)`,
        ],
      ],
      [
        "the register's cookie in the client",
        replacing(
          all,
          CLIENT_NAME,
          planted(
            client,
            "package/dist/index.js",
            'export const cookie = "requestport.e2e_scenario";\n',
          ),
        ),
        [
          `${CLIENT_NAME}: package/dist/index.js holds apps/web's scenario-fault register (requestport.e2e_scenario)`,
        ],
      ],
      [
        "the fence's real module, by the comment esbuild writes above it",
        replacing(
          all,
          REQUESTPORT.published,
          planted(
            requestport,
            chunk,
            `${requestport.get(chunk)}\n// packages/server/src/e2e-csp-fence.ts\n`,
          ),
        ),
        [
          `${REQUESTPORT.published}: ${chunk} holds the CSP's E2E fence (packages/server/src/e2e-csp-fence.ts)`,
        ],
      ],
    ]) {
      assert.deepEqual(seamProblems(tarballs), expected, what);
    }
  });
});

/*
 * Done when 14's contract (manifest-h.md §5, as rulings 109, 193 item 8, 197
 * item 1 and 198 amend it): every operator command H.8's clean-machine run
 * (`requestport-clean-machine.mjs`) issues in the clean container is the
 * README's, verbatim but for the one substitution and the one named slot.
 *
 * - The one substitution: where the README says `requestport@<version>`, the
 *   run says the runbook's pre-publish form (`package-build.md`): its option
 *   for the scope's registry, then `-p file:<path>` for each tarball of the
 *   run, in the build record's order with `requestport`'s last, the path
 *   being the tarball's in the clean container (`CONTAINER_TARBALLS`), then
 *   the command the runbook names after them.
 * - The one named slot: README 148's `<project id>`, filled with the one
 *   project the `login` before it, in the same checkout, printed that it
 *   stored the `mcp` credential for.
 *
 * It is read three ways: the run's table of operator commands
 * (`README_STEPS`), each issued as the run issues it (`readmeCommand`); the
 * MCP configuration the agent is given (`mcpConfiguration`), which is the
 * README's `json` block with the substitution in its `args`; and a run's
 * transcript (`RUN_FILES`), in which every command run in the clean
 * container is a README line, the substitution reversed, or one of the
 * harness's own, excluded by name and admitted only in the one form that
 * name takes (`HARNESS_FORMS`), and every agent command that starts bridges
 * names a configuration a `configuration` entry wrote before it.
 *
 * The transcripts read are those of the recorded runs
 * `REQUESTPORT_CLEAN_MACHINE_RUNS` names (run directories, separated by
 * `path.delimiter`), which only a hand run of the harness makes; without it,
 * one for each storage built from the harness's own exports
 * (`builtTranscript`).
 */

/** README 148's one named slot (the harness's `README_SLOTS`). */
const SLOT = "<project id>";

/** A project id as `login` prints it. */
const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The runbook that gives the pre-publish form (`runbookForm`). The public
 * seed excludes `docs/`, so the file is read only inside the cases that need
 * it, through `prePublishForm`, and each of those skips in the public tree
 * with a reason naming it (`skipInPublicTree`; ruling 208 item 2).
 */
const RUNBOOK = "docs/implementation/runbooks/package-build.md";

/**
 * The skip option of a case that reads a path the public seed does not carry
 * (manifest-j.md §2.4 item 6, Appendix A.3; ruling 92): a reason naming
 * `paths` when `scripts/hosted-deployment.mjs` declares the tree public, as
 * the seed's substitution makes it, and `false` otherwise. So in the private
 * tree the case never skips, a missing path still fails it, and
 * `private-paths.test.mjs` fails if a path named here is gone.
 */
function skipInPublicTree(...paths) {
  return hostedDeployment.kind === "public"
    ? `the public tree does not carry ${paths.join(", ")} (scripts/hosted-deployment.mjs declares kind "public")`
    : false;
}

/**
 * The runbook's pre-publish form (ruling 193 item 8; ruling 197 item 1): of
 * its one `npx <option> $P <command> …` line, the option and the command.
 * `$P` is `-p file:<path>` for each tarball of the run, as its `P=` line
 * writes it.
 */
function runbookForm(text) {
  const lines = fencedBlocks(text)
    .filter(({ language }) => language === "sh")
    .flatMap(({ body }) => body.split("\n"));
  const forms = lines
    .map((line) => /^npx (\S+) \$P (\S+) /u.exec(line))
    .filter((match) => match !== null);

  assert.equal(forms.length, 1, "the runbook gives one pre-publish npx line");
  assert.ok(
    lines.some(
      (line) => line.startsWith("P=$(") && line.includes("`-p file:${"),
    ),
    "the runbook's P names each tarball as -p file:<path>",
  );

  return { option: forms[0][1], command: forms[0][2] };
}

/**
 * What stands where the README says `requestport@<version>` for a run's
 * tarballs: the runbook's form, each tarball named by its path in the clean
 * container. The tarballs must be the lockstep thirteen and `requestport`,
 * `requestport`'s last.
 */
function prePublishForm(tarballs) {
  const { option, command } = runbookForm(
    readFileSync(join(repositoryRoot, RUNBOOK), "utf8"),
  );
  const names = tarballs.map(({ name }) => name);

  assert.deepEqual(
    [...names].sort(),
    [...LOCKSTEP, REQUESTPORT.published].sort(),
    "the run's tarballs are the lockstep thirteen and requestport",
  );
  assert.equal(names.at(-1), REQUESTPORT.published, "requestport's is last");

  return [
    option,
    ...tarballs.flatMap(({ file }) => [
      "-p",
      `file:${CONTAINER_TARBALLS}/${file}`,
    ]),
    command,
  ].join(" ");
}

/** Each non-blank line of the README's `sh` blocks, with its number. */
function shellLines(text) {
  return fencedBlocks(text)
    .filter(({ language }) => language === "sh")
    .flatMap(({ body, from }) =>
      body.split("\n").map((line, offset) => ({ line, number: from + offset })),
    )
    .filter(({ line }) => line.trim() !== "");
}

/**
 * Which operator command a README line is, by its words (`npxCommands`):
 * npx's command after `requestport@<version>`, with `--for`'s audience and
 * `start`'s storage or owner URL option; for a line that does not run
 * npx, its first word (`chmod`, README 58's).
 */
function commandKind(line, readme) {
  const command = npxCommands(readme).find(
    (candidate) => candidate.line === line,
  );

  if (command === undefined) return line.split(/\s+/u)[0];

  const [, spec, verb, ...rest] = command.words;
  const after = (option) => rest[rest.indexOf(option) + 1];

  if (spec !== SPEC) return undefined;
  if (verb === "login" && rest.includes("--for")) {
    return `login --for ${after("--for")}`;
  }
  if (verb === "start" && rest.includes("--owner-url-file")) {
    return "start --owner-url-file";
  }
  if (verb === "start" && rest.includes("--storage")) {
    return `start --storage ${after("--storage")}`;
  }
  return verb;
}

/**
 * The operator commands, by `commandKind`, the run issues with their standard
 * error sent to a file (`readmeCommand`'s `capture`): `start`'s, on each
 * storage, whose standard error the harness reads until it serves.
 */
const CAPTURED = Object.freeze([
  "start --storage pglite",
  "start --owner-url-file",
]);

/**
 * What is wrong with a transcript's `readme` entry, as Done when 14 reads
 * it, or nothing:
 * - `readme` is a line of the README's `sh` blocks, at `readmeLine`;
 * - `issued` does not name `requestport@<version>`, and with the one
 *   substitution reversed (`form` back to `requestport@<version>`) and the
 *   slot's value back to `<project id>`, it is that line;
 * - the slot is filled where the line names it, and only there, with a
 *   project id;
 * - `argv` is `docker exec -w <cwd> <clean> sh -c <script>`, the script the
 *   issued command with nothing before it but, on `start`'s line alone
 *   (`CAPTURED`), `exec 2>><file>;`, which sends the shell's standard error
 *   to the file `stderrTo` names.
 */
function readmeEntryProblems(entry, { readme, form, clean }) {
  const at = `README ${entry.readmeLine}`;
  const found = shellLines(readme).filter(({ line }) => line === entry.readme);

  if (found.length !== 1 || found[0].number !== entry.readmeLine) {
    return [
      `${at}: ${JSON.stringify(entry.readme)} is not that line of the README's sh blocks`,
    ];
  }

  const problems = [];
  const slots = entry.slots ?? {};
  const named = entry.readme.includes(SLOT);

  if (!isDeepStrictEqual(Object.keys(slots), named ? [SLOT] : [])) {
    problems.push(
      `${at}: fills ${JSON.stringify(Object.keys(slots))}, where the line names ${named ? SLOT : "no slot"}`,
    );
  } else if (named && !PROJECT_ID.test(slots[SLOT])) {
    problems.push(
      `${at}: ${SLOT} is filled with ${JSON.stringify(slots[SLOT])}, not a project id`,
    );
  }

  if (typeof entry.issued !== "string" || entry.issued.includes(SPEC)) {
    problems.push(
      `${at}: issued ${JSON.stringify(entry.issued)}, which names ${SPEC}: the one substitution was not made`,
    );
  } else {
    let reversed = entry.issued.split(form).join(SPEC);

    if (named && PROJECT_ID.test(slots[SLOT] ?? "")) {
      reversed = reversed.split(slots[SLOT]).join(SLOT);
    }
    if (reversed !== entry.readme) {
      problems.push(
        `${at}: issued ${JSON.stringify(entry.issued)}, which with the one substitution reversed is not the README's line`,
      );
    }
  }

  const capture = entry.stderrTo;

  if (
    capture !== undefined &&
    !CAPTURED.includes(commandKind(entry.readme, readme))
  ) {
    problems.push(
      `${at}: sends its standard error to ${JSON.stringify(capture)}, which only start's line is issued with`,
    );
  }
  if (capture !== undefined && !/^\/[A-Za-z0-9._/-]+$/u.test(capture)) {
    problems.push(`${at}: stderrTo ${JSON.stringify(capture)} is not a file`);
  }

  const script =
    capture === undefined
      ? entry.issued
      : `exec 2>>${capture}; ${entry.issued}`;

  if (
    !isDeepStrictEqual(entry.argv, [
      "docker",
      "exec",
      "-w",
      entry.cwd,
      clean,
      "sh",
      "-c",
      script,
    ])
  ) {
    problems.push(
      `${at}: ran ${JSON.stringify(entry.argv)}, which is not the issued command alone, in the clean container`,
    );
  }

  return problems;
}

/** The README's one `json` block that names `mcpServers`. */
function configurationBlock(readme) {
  const blocks = fencedBlocks(readme).filter(({ language, body }) => {
    try {
      return language === "json" && JSON.parse(body)?.mcpServers !== undefined;
    } catch {
      return false;
    }
  });

  assert.equal(blocks.length, 1, "the README has one MCP configuration");

  const [block] = blocks;

  return {
    from: block.from,
    to: block.from + block.body.split("\n").length - 2,
    text: block.body.replace(/\n$/u, ""),
    configuration: JSON.parse(block.body),
  };
}

/**
 * What is wrong with a transcript's `configuration` entry, or nothing:
 * `readme` and `readmeLines` are the README's MCP configuration block;
 * `written`, read as JSON, is that block's configuration with the one
 * substitution in its `args`, where the README's element
 * `requestport@<version>` becomes `form`'s words, an element each, and
 * nothing else changed; and it is written to a checkout's
 * `MCP_CONFIGURATION_FILE`.
 */
function configurationProblems(entry, { readme, form }) {
  const block = configurationBlock(readme);
  const at = `README ${block.from}-${block.to}`;
  const problems = [];

  if (
    entry.readme !== block.text ||
    !isDeepStrictEqual(entry.readmeLines, { from: block.from, to: block.to })
  ) {
    problems.push(`${at}: the entry does not quote the README's block`);
  }

  let written;

  try {
    written = JSON.parse(entry.written);
  } catch {
    return [...problems, `${at}: what was written is not JSON`];
  }

  const words = form.split(" ");
  const reversed = structuredClone(written);

  for (const server of Object.values(reversed?.mcpServers ?? {})) {
    if (!Array.isArray(server?.args)) continue;

    const args = [];

    for (let index = 0; index < server.args.length; ) {
      if (
        isDeepStrictEqual(server.args.slice(index, index + words.length), words)
      ) {
        args.push(SPEC);
        index += words.length;
      } else {
        args.push(server.args[index]);
        index += 1;
      }
    }
    server.args = args;
  }

  if (JSON.stringify(written).includes(SPEC)) {
    problems.push(
      `${at}: the configuration written names ${SPEC}: the one substitution was not made`,
    );
  } else if (!isDeepStrictEqual(reversed, block.configuration)) {
    problems.push(
      `${at}: the configuration written to ${entry.path}, its substitution reversed, is not the README's: ${JSON.stringify(reversed)}`,
    );
  }
  if (!inCheckout(entry.path, `/${MCP_CONFIGURATION_FILE}`)) {
    problems.push(`${at}: written to ${entry.path}, not to a checkout`);
  }

  return problems;
}

/** Whether `path` is `file` in one browser's checkout under `CHECKOUTS`. */
function inCheckout(path, file) {
  return BROWSERS.some((browser) => path === `${CHECKOUTS}/${browser}${file}`);
}

/** The directory npx installs into, under the clean container's `HOME`. */
function isNpxDirectory(path) {
  return /^[0-9a-f]+$/u.test(
    String(path).replace(`${CONTAINER_HOME}/.npm/_npx/`, ""),
  );
}

/** A file name with no directory, such as the owner URL's. */
const PLAIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * The harness's own commands, which Done when 14 excludes by name ("the
 * harness's commands (docker, Playwright, the agent script) are not the
 * README's"): every name `HARNESS_COMMANDS` holds, each with the container it
 * runs in and its one form there. A `docker exec`'s options are `-i` and
 * `-w <directory>` alone (`execOf`), and the words it runs are fixed but for
 * what each run makes its own: a file name, a checkout, the npx directory,
 * the server's address, a port, `start`'s process group, and which of
 * `DATABASE_SQL`'s reads `psql` runs. A `docker run` is held whole to what
 * `cleanContainerArguments`, `driverContainerArguments` or
 * `databaseContainerArguments` builds for that run and name, the staged
 * mount sources aside (`createdProblems`). No form runs `npx` or
 * `requestport`; the agent's bridges run the MCP configuration a
 * `configuration` entry holds. In the clean container the harness reads
 * (`cat`, `stat`, `ls`, `du`, `npm ls`, and two `node -e` scripts that read
 * files), writes the owner URL and the MCP configuration from standard
 * input, makes a checkout, runs the agent (`node /harness/agent.mjs`), and
 * stops `start` (`kill`). In the driver it runs the person (`node
 * /harness/person.mjs`, Playwright) and reads what the driver holds,
 * readiness and the port; in the database, `pg_isready` and `psql`.
 */
const HARNESS_FORMS = Object.freeze({
  "docker run": { role: undefined },
  inspect: {
    role: "clean",
    form: (words) => isDeepStrictEqual(words, ["node", "-e", INSPECT_SCRIPT]),
  },
  "npx directory": {
    role: "clean",
    form: (words) =>
      isDeepStrictEqual(words, ["sh", "-c", 'ls -d "$HOME"/.npm/_npx/*/']),
  },
  "npm ls": {
    role: "clean",
    form: (words, { workdir }) =>
      isNpxDirectory(workdir) &&
      isDeepStrictEqual(words, ["npm", "ls", "--all"]),
  },
  "npx lockfile": {
    role: "clean",
    form: (words) =>
      words.length === 2 &&
      words[0] === "cat" &&
      words[1].endsWith("/package-lock.json") &&
      isNpxDirectory(words[1].slice(0, -"/package-lock.json".length)),
  },
  "database readiness": {
    role: "database",
    form: (words) => isDeepStrictEqual(words, DATABASE_READINESS_WORDS),
  },
  "owner url": {
    role: "clean",
    form: (words) =>
      words.length === 5 &&
      isDeepStrictEqual(words.slice(0, 4), [
        "sh",
        "-c",
        'cat > "$1" && stat -c "%a %u" "$1"',
        "sh",
      ]) &&
      PLAIN_FILE.test(words[4]),
  },
  "owner url mode": {
    role: "clean",
    form: (words) =>
      words.length === 4 &&
      isDeepStrictEqual(words.slice(0, 3), ["stat", "-c", "%a %u"]) &&
      PLAIN_FILE.test(words[3]),
  },
  psql: {
    role: "database",
    form: (words) =>
      Object.values(DATABASE_SQL).some((sql) =>
        isDeepStrictEqual(words, psqlWords(sql)),
      ),
  },
  "start stderr": {
    role: "clean",
    form: (words) => isDeepStrictEqual(words, ["cat", START_STDERR]),
  },
  "driver inspect": {
    role: "driver",
    form: (words) =>
      isDeepStrictEqual(words, ["node", "-e", DRIVER_INSPECT_SCRIPT]),
  },
  readiness: {
    role: "driver",
    form: (words) =>
      words.length === 4 &&
      isDeepStrictEqual(words.slice(0, 3), ["node", "-e", READINESS_SCRIPT]) &&
      /^http:\/\/127\.0\.0\.1:[0-9]+$/u.test(words[3]),
  },
  person: {
    role: "driver",
    form: (words) => isDeepStrictEqual(words, ["node", PERSON_IN_CONTAINER]),
  },
  checkout: {
    role: "clean",
    form: (words) =>
      words.length === 3 &&
      words[0] === "mkdir" &&
      words[1] === "-p" &&
      inCheckout(words[2], ""),
  },
  binding: {
    role: "clean",
    form: (words) =>
      words.length === 2 &&
      words[0] === "cat" &&
      inCheckout(words[1], "/.requestport/project.json"),
  },
  "mcp configuration": {
    role: "clean",
    form: (words) =>
      words.length === 5 &&
      isDeepStrictEqual(words.slice(0, 4), ["sh", "-c", 'cat > "$1"', "sh"]) &&
      inCheckout(words[4], `/${MCP_CONFIGURATION_FILE}`),
  },
  agent: {
    role: "clean",
    form: (words) => isDeepStrictEqual(words, ["node", AGENT_IN_CONTAINER]),
  },
  processes: {
    role: "clean",
    form: (words) => isDeepStrictEqual(words, ["node", "-e", PROCESSES_SCRIPT]),
  },
  stop: {
    role: "clean",
    form: (words) =>
      words.length === 3 &&
      words[0] === "sh" &&
      words[1] === "-c" &&
      /^kill -TERM -[0-9]+$/u.test(words[2]),
  },
  port: {
    role: "driver",
    form: (words) =>
      words.length === 4 &&
      isDeepStrictEqual(words.slice(0, 3), ["node", "-e", PORT_SCRIPT]) &&
      /^[0-9]+$/u.test(words[3]),
  },
  "home size": {
    role: "clean",
    form: (words) =>
      isDeepStrictEqual(words, ["sh", "-c", 'du -sm "$HOME" | cut -f1']),
  },
});

/** The `node -e` scripts `HARNESS_FORMS` admits. */
const HARNESS_SCRIPTS = Object.freeze({
  INSPECT_SCRIPT,
  PROCESSES_SCRIPT,
  DRIVER_INSPECT_SCRIPT,
  READINESS_SCRIPT,
  PORT_SCRIPT,
});

/** A `docker exec`'s options, its container, and the words it runs there. */
function execOf(argv) {
  if (!Array.isArray(argv) || argv[0] !== "docker" || argv[1] !== "exec") {
    return undefined;
  }

  let index = 2;
  let workdir;

  for (;;) {
    if (argv[index] === "-i") {
      index += 1;
    } else if (argv[index] === "-w") {
      workdir = argv[index + 1];
      index += 2;
    } else {
      break;
    }
  }

  return { workdir, container: argv[index], words: argv.slice(index + 1) };
}

/** What stands for a staged mount source when a `docker run` is compared. */
const STAGED = "/staged";

/**
 * What is wrong with a `docker run` the harness wrote, or nothing: it names
 * its container `<run>-clean`, `<run>-driver` or `<run>-database`, the first
 * of its role, the driver and the database after `<run>-clean`, whose
 * network namespace they join; and its arguments are, whole and in order,
 * what `cleanContainerArguments`, `driverContainerArguments` or
 * `databaseContainerArguments` builds for that run and name, with the Node
 * image (`nodeImage`), the WebKit lanes' image or `DATABASE_IMAGE`. Only a
 * mount's source may differ, an absolute path (the run's staging); its target
 * and `:ro` may not. So an option added (a published port, a health command,
 * an entrypoint), one left out (`--network container:<clean>`) or a writable
 * mount is a problem. Records the container's role in `containers` once its
 * name is a run's first of that role, so that a wrong `docker run` is one
 * problem, not one for every command run in its container after it.
 */
function createdProblems(argv, containers) {
  const named = Array.isArray(argv) ? argv.indexOf("--name") : -1;
  const found = /^(.+)-(clean|driver|database)$/u.exec(
    String(named === -1 ? "" : argv[named + 1]),
  );

  if (argv?.[0] !== "docker" || argv?.[1] !== "run" || found === null) {
    return [
      `docker run: ${JSON.stringify(argv)} names no container of a run (<run>-clean, <run>-driver or <run>-database)`,
    ];
  }

  const [name, run, role] = found;
  const clean = `${run}-clean`;

  if ([...containers.values()].includes(role)) {
    return [`docker run: ${name} is a second ${role} container`];
  }
  if (role !== "clean" && containers.get(clean) !== "clean") {
    return [
      `docker run: ${name} is created before ${clean}, whose network namespace it joins`,
    ];
  }

  const [builder, built] = {
    clean: () => [
      "cleanContainerArguments",
      cleanContainerArguments({
        run,
        name,
        image: nodeImage(),
        tarballs: STAGED,
        readme: STAGED,
        harness: STAGED,
      }),
    ],
    driver: () => [
      "driverContainerArguments",
      driverContainerArguments({
        run,
        name,
        clean,
        image: PLAYWRIGHT_IMAGE,
        harness: STAGED,
      }),
    ],
    database: () => [
      "databaseContainerArguments",
      databaseContainerArguments({ run, name, clean, image: DATABASE_IMAGE }),
    ],
  }[role]();
  const staged = argv.map((word, index) =>
    argv[index - 1] === "-v" ? word.replace(/^\/[^:]*:/u, `${STAGED}:`) : word,
  );

  containers.set(name, role);

  return isDeepStrictEqual(staged, ["docker", "run", ...built])
    ? []
    : [
        `docker run: ${JSON.stringify(argv)} is not what ${builder} builds for ${name}, the staged mount sources aside`,
      ];
}

/**
 * What is wrong with a transcript's `harness` entry, or nothing: its name is
 * one `HARNESS_FORMS` holds, and its `argv` is that name's one form, in that
 * name's container.
 */
function harnessProblems(entry, containers) {
  if (!Object.hasOwn(HARNESS_FORMS, entry.name)) {
    return [
      `the harness command ${JSON.stringify(entry.name)} is not one Done when 14 excludes by name`,
    ];
  }
  if (entry.name === "docker run") {
    return createdProblems(entry.argv, containers);
  }

  const { role, form } = HARNESS_FORMS[entry.name];
  const exec = execOf(entry.argv);

  if (
    exec === undefined ||
    containers.get(exec.container) !== role ||
    !form(exec.words, exec)
  ) {
    return [
      `${entry.name}: ${JSON.stringify(entry.argv)} is not the form ${entry.name} takes, in the ${role} container`,
    ];
  }

  return [];
}

/**
 * Done when 14 over a run's transcript, its entries in order: every
 * `readme` entry is a README line issued as `readmeEntryProblems` reads it,
 * its slot, where it has one, filled with the one project the `login`
 * before it in the same checkout printed it stored the `mcp` credential for
 * (`stored`, checkout to the project ids `login` printed); every
 * `configuration` entry is the README's, as `configurationProblems` reads
 * it; every `harness` entry is excluded by name in its form
 * (`harnessProblems`); every `agent` entry is a command of the agent's, and
 * one that starts bridges names a configuration an entry before it wrote;
 * every `person` entry is a command of the person's. No other kind is
 * admitted.
 */
function transcriptProblems(entries, { readme, tarballs, stored }) {
  const form = prePublishForm(tarballs);
  const containers = new Map();
  const configurations = new Set();
  const loggedIn = new Set();
  const problems = [];
  const clean = () => [...containers].find(([, role]) => role === "clean")?.[0];

  for (const [index, entry] of entries.entries()) {
    const said = (problem) =>
      problems.push(`transcript entry ${index + 1}: ${problem}`);

    if (entry.kind === "readme") {
      const found = readmeEntryProblems(entry, {
        readme,
        form,
        clean: clean(),
      });

      found.forEach(said);
      // A login the README gives counts for the slot below whatever else is
      // wrong with its entry, which is a problem of its own.
      if (commandKind(entry.readme, readme) === "login") {
        loggedIn.add(entry.cwd);
      }
      if (found.length > 0) continue;
      if (entry.readme.includes(SLOT)) {
        const ids = stored.get(entry.cwd) ?? [];

        if (
          !loggedIn.has(entry.cwd) ||
          ids.length !== 1 ||
          ids[0] !== entry.slots[SLOT]
        ) {
          said(
            `README ${entry.readmeLine}: ${SLOT} is ${entry.slots[SLOT]}, not the one project the login before it printed it stored in ${entry.cwd}`,
          );
        }
      }
    } else if (entry.kind === "configuration") {
      configurationProblems(entry, { readme, form }).forEach(said);
      configurations.add(entry.path);
    } else if (entry.kind === "harness") {
      harnessProblems(entry, containers).forEach(said);
    } else if (entry.kind === "agent") {
      if (!Object.hasOwn(AGENT_COMMANDS, entry.command)) {
        said(`the agent was given ${JSON.stringify(entry.command)}`);
      } else if (
        AGENT_COMMANDS[entry.command].includes("configuration") &&
        !configurations.has(entry.configuration)
      ) {
        said(
          `the agent's ${entry.command} names a configuration no entry before it wrote: ${JSON.stringify(entry.configuration)}`,
        );
      }
    } else if (entry.kind === "person") {
      if (!Object.hasOwn(PERSON_COMMANDS, entry.command)) {
        said(`the person was given ${JSON.stringify(entry.command)}`);
      }
    } else {
      said(
        `an entry of kind ${JSON.stringify(entry.kind)}, which Done when 14 does not know`,
      );
    }
  }

  return problems;
}

/**
 * The operator commands Done when 14 has a run on `storage` issue, by
 * `commandKind`, against those its transcript's entries issued: `--version`
 * once; the README's start for that storage once (`start --storage
 * pglite`, or on pg README 58's `chmod` and README 59's `start
 * --owner-url-file`, once each); and for each browser,
 * `login`, `link` and `login --for api` once each, and the MCP configuration
 * once.
 */
function issuedProblems(entries, { readme, storage }) {
  const counts = {};
  const count = (kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  for (const entry of entries) {
    if (entry.kind === "readme") count(commandKind(entry.readme, readme));
    if (entry.kind === "configuration") count("configuration");
  }

  const each = BROWSERS.length;
  const expected = {
    "--version": 1,
    ...(storage === "pg"
      ? { chmod: 1, "start --owner-url-file": 1 }
      : { "start --storage pglite": 1 }),
    login: each,
    link: each,
    "login --for api": each,
    configuration: each,
  };

  return isDeepStrictEqual(counts, expected)
    ? []
    : [
        `a run on ${storage} issued ${JSON.stringify(counts)}, not ${JSON.stringify(expected)}`,
      ];
}

/** The project ids `login` printed it stored, by checkout, of a summary. */
function storedOf(summary) {
  return new Map(
    Object.values(summary.steps?.person ?? {})
      .filter((steps) => typeof steps?.checkout === "string")
      .map((steps) => [
        steps.checkout,
        (steps.login?.stored ?? [])
          .filter(({ audience }) => audience === "mcp")
          .map(({ projectId }) => projectId),
      ]),
  );
}

/** A run's tarballs for what this file builds: the lockstep thirteen, then requestport. */
const BUILT_TARBALLS = Object.freeze(
  [...LOCKSTEP, REQUESTPORT.published].map((name) => ({
    name,
    file: `${name.replace(/^@/u, "").replace("/", "-")}-0.0.0-contract.tgz`,
  })),
);

/**
 * A transcript of a run on `storage`, in the order a run writes its entries
 * though with fewer of them, built
 * from the harness's own exports where it has them: each container by its
 * `*ContainerArguments`, each README line by `readmeCommand` and each MCP
 * configuration by `mcpConfiguration`, as the run builds them; each of the
 * harness's other commands in its form; and `stored`, the project `login`
 * printed for each checkout.
 */
function builtTranscript(storage) {
  const run = "h8-contract";
  const clean = `${run}-clean`;
  const driver = `${run}-driver`;
  const database = `${run}-database`;
  const npx = `${CONTAINER_HOME}/.npm/_npx/c73769c64dd1ce6c`;
  const entries = [];
  const stored = new Map();
  const harness = (name, args) =>
    entries.push({ kind: "harness", name, argv: ["docker", ...args] });
  const issue = (line, options = {}) =>
    entries.push(
      readmeCommand(line, {
        readme: README,
        tarballs: BUILT_TARBALLS,
        clean,
        ...options,
      }).entry,
    );

  harness("docker run", [
    "run",
    ...cleanContainerArguments({
      run,
      name: clean,
      image: nodeImage(),
      tarballs: "/staging/tarballs",
      readme: "/staging/readme/README.md",
      harness: "/staging/harness-clean",
    }),
  ]);
  harness("inspect", ["exec", clean, "node", "-e", INSPECT_SCRIPT]);
  if (storage === "pg") {
    harness("docker run", [
      "run",
      ...databaseContainerArguments({
        run,
        name: database,
        clean,
        image: DATABASE_IMAGE,
      }),
    ]);
  }
  harness("agent", [
    "exec",
    "-i",
    "-w",
    CONTAINER_HOME,
    clean,
    "node",
    AGENT_IN_CONTAINER,
  ]);
  entries.push({ kind: "agent", cwd: CONTAINER_HOME, command: "load" });
  issue(README_STEPS.version);
  harness("npx directory", [
    "exec",
    clean,
    "sh",
    "-c",
    'ls -d "$HOME"/.npm/_npx/*/',
  ]);
  harness("npm ls", ["exec", "-w", npx, clean, "npm", "ls", "--all"]);
  harness("npx lockfile", ["exec", clean, "cat", `${npx}/package-lock.json`]);
  if (storage === "pg") {
    harness("database readiness", [
      "exec",
      database,
      ...DATABASE_READINESS_WORDS,
    ]);
    harness("psql", ["exec", database, ...psqlWords(DATABASE_SQL.hba)]);
    harness("owner url", [
      "exec",
      "-i",
      "-w",
      CONTAINER_HOME,
      clean,
      "sh",
      "-c",
      'cat > "$1" && stat -c "%a %u" "$1"',
      "sh",
      "owner-url.txt",
    ]);
    issue(README_STEPS.ownerUrlMode);
    harness("owner url mode", [
      "exec",
      "-w",
      CONTAINER_HOME,
      clean,
      "stat",
      "-c",
      "%a %u",
      "owner-url.txt",
    ]);
    issue(README_STEPS.startPg, { capture: START_STDERR });
  } else {
    issue(README_STEPS.startPglite, { capture: START_STDERR });
  }
  harness("start stderr", ["exec", clean, "cat", START_STDERR]);
  harness("docker run", [
    "run",
    ...driverContainerArguments({
      run,
      name: driver,
      clean,
      image: PLAYWRIGHT_IMAGE,
      harness: "/staging/harness-driver",
    }),
  ]);
  harness("driver inspect", [
    "exec",
    driver,
    "node",
    "-e",
    DRIVER_INSPECT_SCRIPT,
  ]);
  harness("readiness", [
    "exec",
    driver,
    "node",
    "-e",
    READINESS_SCRIPT,
    "http://127.0.0.1:3200",
  ]);
  harness("person", ["exec", "-i", driver, "node", PERSON_IN_CONTAINER]);
  harness("processes", ["exec", clean, "node", "-e", PROCESSES_SCRIPT]);
  for (const [index, browser] of BROWSERS.entries()) {
    const checkout = `${CHECKOUTS}/${browser}`;
    const projectId = `00000000-0000-4000-8000-00000000000${index}`;
    const configuration = mcpConfiguration({
      readme: README,
      tarballs: BUILT_TARBALLS,
    });
    const path = `${checkout}/${MCP_CONFIGURATION_FILE}`;

    stored.set(checkout, [projectId]);
    entries.push({ kind: "person", command: "signIn", browser });
    entries.push({ kind: "person", command: "createProject", browser });
    harness("checkout", ["exec", clean, "mkdir", "-p", checkout]);
    issue(README_STEPS.login, { cwd: checkout });
    entries.push({ kind: "person", command: "consent", browser });
    issue(README_STEPS.link, { cwd: checkout, slots: { [SLOT]: projectId } });
    harness("binding", [
      "exec",
      clean,
      "cat",
      `${checkout}/.requestport/project.json`,
    ]);
    issue(README_STEPS.loginApi, { cwd: checkout });
    entries.push({ kind: "person", command: "consent", browser });
    entries.push({
      kind: "configuration",
      readmeLines: { from: configuration.from, to: configuration.to },
      readme: configuration.readme,
      written: configuration.text,
      path,
    });
    harness("mcp configuration", [
      "exec",
      "-i",
      clean,
      "sh",
      "-c",
      'cat > "$1"',
      "sh",
      path,
    ]);
    harness("agent", [
      "exec",
      "-i",
      "-w",
      checkout,
      clean,
      "node",
      AGENT_IN_CONTAINER,
    ]);
    entries.push({
      kind: "agent",
      cwd: checkout,
      command: "file",
      configuration: path,
    });
    entries.push({
      kind: "agent",
      cwd: checkout,
      command: "whoami",
      configuration: path,
      bridges: 2,
    });
    entries.push({ kind: "agent", cwd: checkout, command: "http" });
    entries.push({ kind: "person", command: "seeRequest", browser });
  }
  entries.push({ kind: "person", command: "close" });
  harness("stop", ["exec", clean, "sh", "-c", "kill -TERM -77"]);
  harness("port", ["exec", driver, "node", "-e", PORT_SCRIPT, "3200"]);
  harness("home size", ["exec", clean, "sh", "-c", 'du -sm "$HOME" | cut -f1']);

  return { entries, stored };
}

/**
 * Done when 14 over a table of operator commands: each is one line of the
 * README's `sh` blocks, and issued as the run issues it (`readmeCommand`,
 * with a project id in the slot where the line names it) it is that line
 * but for the one substitution and the slot (`readmeEntryProblems`).
 */
function tableProblems(table, readme) {
  const clean = "h8-contract-clean";
  const form = prePublishForm(BUILT_TARBALLS);
  const problems = [];

  for (const [step, line] of Object.entries(table)) {
    const found = shellLines(readme).filter(
      (candidate) => candidate.line === line,
    );

    if (found.length !== 1) {
      problems.push(
        `README_STEPS.${step} is ${found.length} line(s) of the README's sh blocks, not one: ${String(line)}`,
      );
      continue;
    }

    const slots = line.includes(SLOT)
      ? { [SLOT]: "00000000-0000-4000-8000-000000000000" }
      : undefined;
    let entry;

    try {
      ({ entry } = readmeCommand(line, {
        readme,
        tarballs: BUILT_TARBALLS,
        slots,
        clean,
      }));
    } catch (error) {
      problems.push(
        `README_STEPS.${step}: the run refuses it: ${error.message}`,
      );
      continue;
    }
    for (const problem of readmeEntryProblems(entry, { readme, form, clean })) {
      problems.push(`README_STEPS.${step}: ${problem}`);
    }
  }

  return problems;
}

/** The operator commands the table must name, by `commandKind`. */
const TABLE_KINDS = Object.freeze([
  "--version",
  "start --storage pglite",
  "chmod",
  "start --owner-url-file",
  "login",
  "link",
  "login --for api",
]);

describe("Done when 14: the README contract over the clean-machine run (manifest-h.md §5; rulings 109, 193 item 8, 197 item 1, 198)", () => {
  test("Done when 14: every operator command in the run's table (README_STEPS) is one line of the README's sh blocks and, issued as the run issues it, is that line but for the one substitution, the runbook's pre-publish form, and on the line naming <project id> alone, that slot; the table names --version, start on each storage (README 58's chmod with the pg one), login, link and login --for api", {
    skip: skipInPublicTree("docs/implementation/runbooks/package-build.md"),
  }, () => {
    assert.deepEqual(tableProblems(README_STEPS, README), []);
    assert.deepEqual(
      Object.values(README_STEPS)
        .map((line) => commandKind(line, README))
        .sort(),
      [...TABLE_KINDS].sort(),
    );
  });

  test("Done when 14: the MCP configuration the agent is given is the README's json block, npx with the one substitution in its args, the published form's element becoming the pre-publish form's words, and nothing else changed", {
    skip: skipInPublicTree("docs/implementation/runbooks/package-build.md"),
  }, () => {
    const configuration = mcpConfiguration({
      readme: README,
      tarballs: BUILT_TARBALLS,
    });
    const block = configurationBlock(README);

    assert.deepEqual(
      configurationProblems(
        {
          kind: "configuration",
          readmeLines: { from: configuration.from, to: configuration.to },
          readme: configuration.readme,
          written: configuration.text,
          path: `${CHECKOUTS}/${BROWSERS[0]}/${MCP_CONFIGURATION_FILE}`,
        },
        { readme: README, form: prePublishForm(BUILT_TARBALLS) },
      ),
      [],
    );
    assert.deepEqual(
      Object.values(block.configuration.mcpServers).map(({ command, args }) => [
        command,
        args,
      ]),
      [["npx", [SPEC, "mcp"]]],
    );
  });

  test("Done when 14 excludes the harness's commands by name: each name the harness writes and no other, each admitted in its one form (a docker run whole, as its builder makes it for the run and the name, the staged mount sources aside); no node -e script of theirs loads a module but node:fs, node:path or node:net", () => {
    assert.deepEqual(
      Object.keys(HARNESS_FORMS).sort(),
      [...HARNESS_COMMANDS].sort(),
    );
    for (const [name, script] of Object.entries(HARNESS_SCRIPTS)) {
      const loaded = [...script.matchAll(/require\("([^"]+)"\)/gu)].map(
        ([, module]) => module,
      );

      assert.ok(
        loaded.every((module) =>
          ["node:fs", "node:path", "node:net"].includes(module),
        ),
        `${name} loads ${JSON.stringify(loaded)}`,
      );
      assert.doesNotMatch(script, /\bimport\s*\(|child_process|\bnpx\b/u, name);
    }
  });

  test("Done when 14 over each recorded run REQUESTPORT_CLEAN_MACHINE_RUNS names, or, when it names none, over a run on each storage built from the harness's own exports: every command in the clean container is a README line, the substitution reversed, or the harness's own in its form; README 148's slot is the project login printed; and the run issued each operator command Done when 14 names", {
    skip: skipInPublicTree("docs/implementation/runbooks/package-build.md"),
  }, (t) => {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: a hand run's input. The gate runs this file with node --test, not as a Turbo task, and sets no such variable.
    const named = process.env.REQUESTPORT_CLEAN_MACHINE_RUNS;

    if (named === undefined || named === "") {
      for (const storage of ["pglite", "pg"]) {
        const { entries, stored } = builtTranscript(storage);

        assert.deepEqual(
          transcriptProblems(entries, {
            readme: README,
            tarballs: BUILT_TARBALLS,
            stored,
          }),
          [],
          storage,
        );
        assert.deepEqual(
          issuedProblems(entries, { readme: README, storage }),
          [],
          storage,
        );
      }
      t.diagnostic(
        "no recorded run named: read over a run on each storage built from the harness's own exports",
      );
      return;
    }

    for (const directory of named.split(delimiter)) {
      const summary = JSON.parse(
        readFileSync(join(directory, RUN_FILES.summary), "utf8"),
      );
      const entries = readFileSync(
        join(directory, RUN_FILES.transcript),
        "utf8",
      )
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));

      assert.equal(
        summary.readme?.sha256,
        createHash("sha256").update(README).digest("hex"),
        `${directory}: the README the run read is this one`,
      );
      assert.deepEqual(
        transcriptProblems(entries, {
          readme: README,
          tarballs: summary.tarballs,
          stored: storedOf(summary),
        }),
        [],
        directory,
      );
      assert.deepEqual(
        issuedProblems(entries, { readme: README, storage: summary.storage }),
        [],
        directory,
      );
      t.diagnostic(
        `${directory}: ${summary.run} on ${summary.storage}, ${entries.length} entries, ${entries.filter(({ kind }) => kind === "readme").length} README lines, exit ${summary.exitCode}`,
      );
    }
  });

  test("Done when 14 fails on a planted README word, naming the step and the README line", {
    skip: skipInPublicTree("docs/implementation/runbooks/package-build.md"),
  }, () => {
    const line = README_STEPS.startPglite;
    const sh = README.replace(
      line,
      line.replace("--organization acme", "--organization acme --verbose"),
    );
    const block = configurationBlock(README).text;
    const json = README.replace(
      block,
      block.replace(`"${SPEC}", "mcp"`, `"${SPEC}", "mcp", "--verbose"`),
    );

    assert.notEqual(sh, README);
    assert.notEqual(json, README);
    assert.deepEqual(tableProblems(README_STEPS, sh), [
      `README_STEPS.startPglite is 0 line(s) of the README's sh blocks, not one: ${line}`,
    ]);

    const { entries, stored } = builtTranscript("pglite");
    const number = README.split("\n").indexOf(line) + 1;

    assert.deepEqual(
      transcriptProblems(entries, {
        readme: sh,
        tarballs: BUILT_TARBALLS,
        stored,
      }),
      [
        `transcript entry ${entries.findIndex(({ readme }) => readme === line) + 1}: README ${number}: ${JSON.stringify(line)} is not that line of the README's sh blocks`,
      ],
    );

    const { from, to } = configurationBlock(json);
    const written = entries.flatMap(({ kind, path }, index) =>
      kind === "configuration" ? [{ index, path }] : [],
    );

    assert.equal(written.length, BROWSERS.length);
    assert.deepEqual(
      transcriptProblems(entries, {
        readme: json,
        tarballs: BUILT_TARBALLS,
        stored,
      }),
      written.flatMap(({ index, path }) => [
        `transcript entry ${index + 1}: README ${from}-${to}: the entry does not quote the README's block`,
        `transcript entry ${index + 1}: README ${from}-${to}: the configuration written to ${path}, its substitution reversed, is not the README's: ${JSON.stringify({ mcpServers: { requestport: { command: "npx", args: [SPEC, "mcp"] } } })}`,
      ]),
    );
  });

  test("Done when 14 fails on a planted table entry, naming the step", {
    skip: skipInPublicTree("docs/implementation/runbooks/package-build.md"),
  }, () => {
    for (const [what, table, expected] of [
      [
        "a command the README does not give",
        {
          ...README_STEPS,
          rotate: `npx ${SPEC} owner rotate-credential --force`,
        },
        `README_STEPS.rotate is 0 line(s) of the README's sh blocks, not one: npx ${SPEC} owner rotate-credential --force`,
      ],
      [
        "a word added to one the README gives",
        {
          ...README_STEPS,
          startPg: `${README_STEPS.startPg} --public-url http://127.0.0.1:3200`,
        },
        `README_STEPS.startPg is 0 line(s) of the README's sh blocks, not one: ${README_STEPS.startPg} --public-url http://127.0.0.1:3200`,
      ],
      [
        "a step that is a test, not a line",
        { ...README_STEPS, version: (line) => line.endsWith("--version") },
        /^README_STEPS\.version is 0 line\(s\) of the README's sh blocks, not one: /u,
      ],
    ]) {
      const problems = tableProblems(table, README);

      assert.equal(problems.length, 1, `${what}: ${problems.join("\n")}`);
      if (typeof expected === "string") {
        assert.equal(problems[0], expected, what);
      } else {
        assert.match(problems[0], expected, what);
      }
    }
    assert.throws(
      () =>
        readmeCommand(`npx ${SPEC} owner rotate-credential --force`, {
          readme: README,
          tarballs: BUILT_TARBALLS,
          clean: "h8-contract-clean",
        }),
      /not a line of the README's sh blocks/u,
    );
  });

  test("Done when 14 fails on a planted transcript line, naming the entry", {
    skip: skipInPublicTree("docs/implementation/runbooks/package-build.md"),
  }, async (t) => {
    const { entries, stored } = builtTranscript("pg");
    const form = prePublishForm(BUILT_TARBALLS);
    const clean = "h8-contract-clean";
    const at = (predicate) => entries.findIndex(predicate);
    const startAt = at(({ readme }) => readme === README_STEPS.startPg);
    const linkAt = at(({ readme }) => readme === README_STEPS.link);
    const configurationAt = at(({ kind }) => kind === "configuration");
    const stopAt = at(({ name }) => name === "stop");
    const fileAt = at(({ command }) => command === "file");
    const readyAt = at(({ name }) => name === "database readiness");
    const psqlAt = at(({ name }) => name === "psql");
    const readinessAt = at(({ name }) => name === "readiness");
    const replaced = (index, entry) =>
      entries.map((candidate, place) => (place === index ? entry : candidate));
    const inserted = (index, entry) => [
      ...entries.slice(0, index),
      entry,
      ...entries.slice(index),
    ];
    const swapped = (index, from, to) => {
      const argv = entries[index].argv.map((word) =>
        word === from ? to : word,
      );

      assert.notDeepEqual(argv, entries[index].argv);
      return { planted: replaced(index, { ...entries[index], argv }), argv };
    };
    const issuedAs = (entry, issued) => ({
      ...entry,
      issued,
      argv: [
        ...entry.argv.slice(0, -1),
        `exec 2>>${entry.stderrTo}; ${issued}`,
      ],
    });
    const start = entries[startAt];
    const link = entries[linkAt];
    const otherProject = "00000000-0000-4000-8000-0000000000ff";
    const lineOf = (line) => README.split("\n").indexOf(line) + 1;
    const startLine = `README ${lineOf(README_STEPS.startPg)}`;
    const configuration = configurationBlock(README);
    const createdAt = (role) =>
      at(
        ({ name, argv }) =>
          name === "docker run" && argv.includes(`h8-contract-${role}`),
      );
    const cleanAt = createdAt("clean");
    const driverAt = createdAt("driver");
    const created = (index, argv) =>
      replaced(index, { ...entries[index], argv });
    const beforeImage = (argv, words) => [
      ...argv.slice(0, -3),
      ...words,
      ...argv.slice(-3),
    ];
    const healthCheck = beforeImage(entries[cleanAt].argv, [
      "--health-cmd",
      `npx ${form} owner rotate-credential --force`,
    ]);
    const published = beforeImage(entries[cleanAt].argv, ["-p", "3100:3200"]);
    const network = entries[driverAt].argv.indexOf("--network");
    const ownNetwork = entries[driverAt].argv.filter(
      (_, place) => place !== network && place !== network + 1,
    );
    const writable = entries[cleanAt].argv.map((word) =>
      word.endsWith(`:${CONTAINER_TARBALLS}:ro`) ? word.slice(0, -3) : word,
    );
    const loginAt = at(({ readme }) => readme === README_STEPS.login);
    const login = entries[loginAt];
    const capturedLogin = {
      ...login,
      stderrTo: "/tmp/planted",
      argv: [
        ...login.argv.slice(0, -1),
        `exec 2>>/tmp/planted; ${login.issued}`,
      ],
    };
    const notBuilt = (argv, builder, name) =>
      `docker run: ${JSON.stringify(argv)} is not what ${builder} builds for ${name}, the staged mount sources aside`;

    for (const [what, planted, index, says] of [
      [
        "an option added to the clean container's docker run",
        created(cleanAt, healthCheck),
        cleanAt,
        notBuilt(healthCheck, "cleanContainerArguments", "h8-contract-clean"),
      ],
      [
        "a port the clean container publishes",
        created(cleanAt, published),
        cleanAt,
        notBuilt(published, "cleanContainerArguments", "h8-contract-clean"),
      ],
      [
        "the driver outside the clean container's network namespace",
        created(driverAt, ownNetwork),
        driverAt,
        notBuilt(ownNetwork, "driverContainerArguments", "h8-contract-driver"),
      ],
      [
        "a mount the clean container may write",
        created(cleanAt, writable),
        cleanAt,
        notBuilt(writable, "cleanContainerArguments", "h8-contract-clean"),
      ],
      [
        "a README line other than start's issued with a capture",
        replaced(loginAt, capturedLogin),
        loginAt,
        `README ${lineOf(README_STEPS.login)}: sends its standard error to "/tmp/planted", which only start's line is issued with`,
      ],
      [
        "a word added to an issued command",
        replaced(
          startAt,
          issuedAs(start, `${start.issued} --public-url http://127.0.0.1:3200`),
        ),
        startAt,
        `${startLine}: issued ${JSON.stringify(`${start.issued} --public-url http://127.0.0.1:3200`)}, which with the one substitution reversed is not the README's line`,
      ],
      [
        "the published form issued as it is, no substitution made",
        replaced(startAt, issuedAs(start, start.readme)),
        startAt,
        `${startLine}: issued ${JSON.stringify(start.readme)}, which names ${SPEC}: the one substitution was not made`,
      ],
      [
        "a line the README does not give",
        inserted(startAt, {
          ...start,
          readme: `npx ${SPEC} worker`,
          issued: `npx ${form} worker`,
        }),
        startAt,
        `${startLine}: "npx ${SPEC} worker" is not that line of the README's sh blocks`,
      ],
      [
        "a command run beside the issued one",
        replaced(startAt, {
          ...start,
          argv: [...start.argv.slice(0, -1), `${start.argv.at(-1)}; touch x`],
        }),
        startAt,
        `${startLine}: ran ${JSON.stringify([...start.argv.slice(0, -1), `${start.argv.at(-1)}; touch x`])}, which is not the issued command alone, in the clean container`,
      ],
      [
        "README 148's slot filled with a project login did not print",
        replaced(linkAt, {
          ...link,
          slots: { [SLOT]: otherProject },
          issued: link.issued.replace(link.slots[SLOT], otherProject),
          argv: [
            ...link.argv.slice(0, -1),
            link.argv.at(-1).replace(link.slots[SLOT], otherProject),
          ],
        }),
        linkAt,
        `README ${lineOf(README_STEPS.link)}: ${SLOT} is ${otherProject}, not the one project the login before it printed it stored in ${link.cwd}`,
      ],
      [
        "an operator command under a harness name",
        replaced(stopAt, {
          ...entries[stopAt],
          argv: [
            "docker",
            "exec",
            clean,
            "sh",
            "-c",
            `npx ${form} owner rotate-credential`,
          ],
        }),
        stopAt,
        `stop: ${JSON.stringify(["docker", "exec", clean, "sh", "-c", `npx ${form} owner rotate-credential`])} is not the form stop takes, in the clean container`,
      ],
      [
        "a harness command Done when 14 does not exclude",
        inserted(stopAt, {
          kind: "harness",
          name: "cleanup",
          argv: ["docker", "exec", clean, "rm", "-rf", CONTAINER_HOME],
        }),
        stopAt,
        `the harness command "cleanup" is not one Done when 14 excludes by name`,
      ],
      [
        "an argument added to the MCP configuration",
        replaced(configurationAt, {
          ...entries[configurationAt],
          written: entries[configurationAt].written.replace(
            '"mcp"',
            '"mcp",\n        "--verbose"',
          ),
        }),
        configurationAt,
        `README ${configuration.from}-${configuration.to}: the configuration written to ${entries[configurationAt].path}, its substitution reversed, is not the README's: ${JSON.stringify({ mcpServers: { requestport: { command: "npx", args: [SPEC, "mcp", "--verbose"] } } })}`,
      ],
      [
        "a bridge started from a configuration no entry wrote",
        replaced(fileAt, {
          ...entries[fileAt],
          configuration: `${CONTAINER_HOME}/elsewhere/.mcp.json`,
        }),
        fileAt,
        `the agent's file names a configuration no entry before it wrote: "${CONTAINER_HOME}/elsewhere/.mcp.json"`,
      ],
      ...[
        [
          "pg_isready aimed at a host other than 127.0.0.1",
          readyAt,
          "127.0.0.1",
          "192.0.2.1",
          "database",
        ],
        [
          "psql running SQL other than DATABASE_SQL's reads",
          psqlAt,
          DATABASE_SQL.hba,
          "drop table public.oauth_client",
          "database",
        ],
        [
          "readiness aimed at an address other than loopback",
          readinessAt,
          "http://127.0.0.1:3200",
          "http://192.0.2.1:3200",
          "driver",
        ],
      ].map(([what, index, from, to, role]) => {
        const { planted, argv } = swapped(index, from, to);
        const { name } = entries[index];

        return [
          what,
          planted,
          index,
          `${name}: ${JSON.stringify(argv)} is not the form ${name} takes, in the ${role} container`,
        ];
      }),
      [
        "an entry of a kind Done when 14 does not know",
        inserted(stopAt, {
          kind: "shell",
          argv: ["docker", "exec", clean, "sh", "-c", `npx ${form} start`],
        }),
        stopAt,
        `an entry of kind "shell", which Done when 14 does not know`,
      ],
    ]) {
      await t.test(what, () => {
        assert.deepEqual(
          transcriptProblems(planted, {
            readme: README,
            tarballs: BUILT_TARBALLS,
            stored,
          }),
          [`transcript entry ${index + 1}: ${says}`],
        );
      });
    }
  });
});
