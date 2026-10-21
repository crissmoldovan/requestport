import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  type CredentialStore,
  createFileStore,
} from "@requestport/client/credentials";
import { AGENT_SCOPES } from "@requestport/client/oauth";
import { readProjectBinding } from "@requestport/client/project";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  LINK_USAGE,
  type LinkDependencies,
  parseLinkArguments,
  runLink,
} from "./link.js";
import {
  createFakeAuthorizationServer,
  FAKE_ORGANIZATION_ID,
  type FakeAuthorizationServer,
  fakeProjectSlug,
} from "./test-support/fake-authorization-server.js";

const projectA = "018f0000-0000-7000-8000-00000000a001";
const projectB = "018f0000-0000-7000-8000-00000000b001";
const SENTINEL = "SENTINEL_d41d8cd98f00b204";

let home: string;
let checkout: string;
let scratch: string;
let store: CredentialStore;
let server: FakeAuthorizationServer;
let opened: string[];

const realHomeHadStore = existsSync(join(homedir(), ".requestport"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "requestport-link-home-"));
  checkout = mkdtempSync(join(tmpdir(), "requestport-link-checkout-"));
  scratch = mkdtempSync(join(tmpdir(), "requestport-link-tmp-"));
  store = createFileStore({ home });
  server = createFakeAuthorizationServer();
  opened = [];
});

afterEach(() => {
  for (const directory of [home, checkout, scratch]) {
    rmSync(directory, { recursive: true, force: true });
  }
  // Nothing here reached this machine's own credential directory.
  expect(existsSync(join(homedir(), ".requestport"))).toBe(realHomeHadStore);
});

/**
 * A link run in this process, against the fake, with `HOME` the test's own.
 * The person consents to each URL the command prints on stderr, choosing
 * the next of `server.grants`.
 */
async function link(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    dependencies?: Partial<LinkDependencies>;
  } = {},
) {
  const output = { stderr: "", stdout: "" };
  const dependencies: LinkDependencies = {
    authorization: {
      fetch: server.fetch,
      startCallbackReceiver: () => server.startCallbackReceiver(),
      temporaryDirectory: scratch,
    },
    cwd: options.cwd ?? checkout,
    openBrowser: (url) => {
      opened.push(url);
    },
    output: {
      stderr: (text) => {
        output.stderr += text;
        const url = /\n {2}(\S+)\n/u.exec(text)?.[1];
        if (url !== undefined) server.consent(url);
      },
      stdout: (text) => {
        output.stdout += text;
      },
    },
    store,
    ...options.dependencies,
  };
  const status = await runLink(
    argv,
    { HOME: home, ...options.env },
    dependencies,
  );
  return { status, ...output };
}

const bindingPath = (at = checkout) => join(at, ".requestport", "project.json");
const credentialsPath = () => join(home, ".requestport", "credentials.json");
const urlsIn = (text: string) =>
  [...text.matchAll(/\n {2}(\S+)\n/gu)].map((match) => match[1]);

/** A binding written by hand, compact, so a rewrite would show. */
function bind(projectId: string, bound = server.origin, at = checkout): string {
  mkdirSync(join(at, ".requestport"));
  const text = JSON.stringify({
    organizationId: FAKE_ORGANIZATION_ID,
    projectId,
    projectSlug: "the-bound-project",
    server: bound,
  });
  writeFileSync(bindingPath(at), text);
  return text;
}

function expectedFile(projectId: string): string {
  return `${JSON.stringify(
    {
      organizationId: FAKE_ORGANIZATION_ID,
      projectId,
      projectSlug: fakeProjectSlug(projectId),
      server: server.origin,
    },
    null,
    2,
  )}\n`;
}

describe("the arguments", () => {
  test("--help prints the usage on stdout", async () => {
    const run = await link(["--help"]);

    expect(run).toEqual({ status: 0, stderr: "", stdout: `${LINK_USAGE}\n` });
  });

  test("--server is kept as its origin, --project lowercased", () => {
    expect(parseLinkArguments(["--server", "https://rp.example/"])).toEqual({
      noBrowser: false,
      server: "https://rp.example",
    });
    expect(
      parseLinkArguments([
        "--server=http://127.0.0.1:4100",
        "--project",
        projectA.toUpperCase(),
        "--no-browser",
      ]),
    ).toEqual({
      noBrowser: true,
      project: projectA,
      server: "http://127.0.0.1:4100",
    });
  });

  test.each([
    ["no --server", [], "--server is required."],
    [
      "an unknown option",
      ["--server", "https://rp.example", `--${SENTINEL}`],
      "unknown option.",
    ],
    [
      "an unknown option with a value",
      ["--server", "https://rp.example", `--token=${SENTINEL}`],
      "unknown option.",
    ],
    [
      "an argument",
      ["--server", "https://rp.example", SENTINEL],
      "link takes options only, and no argument.",
    ],
    [
      "a server with a password",
      ["--server", `https://u:${SENTINEL}@rp.example`],
      "--server must be an https URL",
    ],
    [
      "an http server on another machine",
      ["--server", `http://${SENTINEL}.example`],
      "--server must be an https URL",
    ],
    [
      "a server with a path",
      ["--server", `https://rp.example/${SENTINEL}`],
      "--server must be an https URL",
    ],
    [
      "a server with a query",
      ["--server", `https://rp.example?${SENTINEL}`],
      "--server must be an https URL",
    ],
    [
      "a project that is not a UUID",
      ["--server", "https://rp.example", "--project", SENTINEL],
      "--project must be a project id, which is a UUID.",
    ],
    [
      "--server twice",
      [
        "--server",
        "https://rp.example",
        `--server=https://${SENTINEL}.example`,
      ],
      "--server is given more than once.",
    ],
    ["--server with no value", ["--server"], "--server needs a value."],
  ])(
    "%s: a usage error that repeats nothing typed, and does nothing",
    async (_name, argv, message) => {
      const run = await link(argv);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain(`requestport link: ${message}`);
      expect(run.stderr).toContain(LINK_USAGE);
      expect(run.stderr).not.toContain(SENTINEL);
      expect(run.stdout).toBe("");
      expect(server.registrations).toEqual([]);
      expect(readdirSync(checkout)).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
    },
  );

  test("a credential store it does not know is a usage error that does not repeat it", async () => {
    const run = await link(["--server", server.origin], {
      dependencies: { store: undefined },
      env: { REQUESTPORT_CREDENTIAL_STORE: SENTINEL },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      'requestport link: REQUESTPORT_CREDENTIAL_STORE must be "file" or "keychain"',
    );
    expect(run.stderr).not.toContain(SENTINEL);
  });
});

describe("link, against the fake", () => {
  test("no binding, no --project: authorizes for mcp, stores the credential under the project granted, and writes the binding with its slug", async () => {
    server.grants.push(projectB);

    const run = await link(["--server", server.origin]);

    expect(run.status).toBe(0);
    const urls = urlsIn(run.stderr);
    expect(urls).toHaveLength(1);
    expect(opened).toEqual(urls);
    expect(run.stdout).not.toContain("oauth2/authorize");
    expect(run.stdout).toBe(
      [
        `Stored the mcp credential for project ${projectB} (organization ${FAKE_ORGANIZATION_ID}) on ${server.origin}.`,
        `Wrote ${bindingPath()}: this checkout is bound to project ${projectB} (${fakeProjectSlug(projectB)}) of organization ${FAKE_ORGANIZATION_ID} on ${server.origin}.`,
        "",
      ].join("\n"),
    );
    expect(store.read(server.origin, projectB, "mcp")?.resource).toBe(
      `${server.origin}/mcp`,
    );
    expect(readFileSync(bindingPath(), "utf8")).toBe(expectedFile(projectB));
    expect(readProjectBinding(checkout)).toEqual({
      organizationId: FAKE_ORGANIZATION_ID,
      projectId: projectB,
      projectSlug: fakeProjectSlug(projectB),
      server: server.origin,
    });
    expect(readdirSync(join(checkout, ".requestport"))).toEqual([
      "project.json",
    ]);
    expect(server.mcpCalls).toEqual(["whoami", "list_projects"]);
  });

  test("the binding is written to a temporary file beside it, then renamed over it", async () => {
    server.grants.push(projectA);
    const seen: { name: string; target: boolean; text: string }[] = [];

    const run = await link(["--server", server.origin], {
      dependencies: {
        beforeRename: (temporary) => {
          seen.push({
            name: basename(temporary),
            target: existsSync(bindingPath()),
            text: readFileSync(temporary, "utf8"),
          });
          expect(readdirSync(join(checkout, ".requestport"))).toEqual([
            basename(temporary),
          ]);
        },
      },
    });

    expect(run.status).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name.startsWith("project.json.tmp-")).toBe(true);
    expect(seen[0]?.target).toBe(false);
    expect(seen[0]?.text).toBe(expectedFile(projectA));
    expect(readdirSync(join(checkout, ".requestport"))).toEqual([
      "project.json",
    ]);
  });

  test("a write that fails leaves no file and no directory behind; the credential stays stored", async () => {
    server.grants.push(projectA);

    const run = await link(["--server", server.origin], {
      dependencies: {
        beforeRename: () => {
          throw new Error("stopped before the rename");
        },
      },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `requestport link: Could not write ${bindingPath()}. The binding was not written.`,
    );
    expect(readdirSync(checkout)).toEqual([]);
    expect(run.stdout).toBe(
      `Stored the mcp credential for project ${projectA} (organization ${FAKE_ORGANIZATION_ID}) on ${server.origin}.\n`,
    );
    expect(store.read(server.origin, projectA, "mcp")).toBeDefined();
  });

  test("read back: a binding readProjectBinding refuses is removed, and link fails", async () => {
    server.grants.push(projectA);
    server.slugOf = () => "s".repeat(121);

    const run = await link(["--server", server.origin]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `requestport link: ${bindingPath()} is not a valid binding — projectSlug:`,
    );
    expect(run.stderr).toContain(
      "It was removed; the binding was not written.",
    );
    expect(run.stdout).not.toContain("Wrote");
    expect(readdirSync(checkout)).toEqual([]);
  });

  test("an mcp credential stored for the project: no consent; it is spent, its lock under the environment's home", async () => {
    server.grants.push(projectA);
    const first = mkdtempSync(join(scratch, "first-"));
    expect(
      (
        await link(["--server", server.origin, "--project", projectA], {
          cwd: first,
        })
      ).status,
    ).toBe(0);
    const registrations = server.registrations.length;
    const refreshes = server.refreshes.length;
    const stored = store.read(server.origin, projectA, "mcp");

    const run = await link(["--server", server.origin, "--project", projectA]);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(opened).toHaveLength(1);
    expect(server.registrations).toHaveLength(registrations);
    expect(run.stdout).toBe(
      [
        `Using the mcp credential stored for project ${projectA} (organization ${FAKE_ORGANIZATION_ID}) on ${server.origin}.`,
        `Wrote ${bindingPath()}: this checkout is bound to project ${projectA} (${fakeProjectSlug(projectA)}) of organization ${FAKE_ORGANIZATION_ID} on ${server.origin}.`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(bindingPath(), "utf8")).toBe(expectedFile(projectA));
    // Spent: refreshed once, with its own client, and the rotated token stored.
    expect(server.refreshes.slice(refreshes)).toEqual([
      {
        clientId: stored?.clientId,
        refreshToken: stored?.refreshToken,
      },
    ]);
    expect(store.read(server.origin, projectA, "mcp")?.refreshToken).not.toBe(
      stored?.refreshToken,
    );
    expect(existsSync(join(home, ".requestport", "locks"))).toBe(true);
  });

  test("a stored credential whoami says is for another project is refused, naming both, and nothing is written", async () => {
    server.grants.push(projectB);
    const first = mkdtempSync(join(scratch, "first-"));
    expect(
      (
        await link(["--server", server.origin, "--project", projectB], {
          cwd: first,
        })
      ).status,
    ).toBe(0);
    const file = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const forServer = file[server.origin] as Record<string, unknown>;
    forServer[projectA] = forServer[projectB];
    delete forServer[projectB];
    writeFileSync(credentialsPath(), JSON.stringify(file), { mode: 0o600 });

    const run = await link(["--server", server.origin, "--project", projectA]);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `requestport link: The mcp credential stored for project ${projectA} on ${server.origin} is for project ${projectB}, by whoami, but --project names project ${projectA}. Nothing was written.\n`,
    );
    expect(readdirSync(checkout)).toEqual([]);
  });

  test("a binding naming another server is refused, naming both, before anything is done", async () => {
    const text = bind(projectA, "https://other.example");

    const run = await link(["--server", server.origin]);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `requestport link: ${bindingPath()} binds this checkout to project ${projectA} on https://other.example, but --server names ${server.origin}. Nothing was stored, and nothing was written.\n`,
    );
    expect(run.stdout).toBe("");
    expect(readFileSync(bindingPath(), "utf8")).toBe(text);
    expect(server.registrations).toEqual([]);
    expect(opened).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test("a binding naming another project than --project is refused, naming both, before anything is done", async () => {
    const text = bind(projectA);

    const run = await link(["--server", server.origin, "--project", projectB]);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `requestport link: ${bindingPath()} binds this checkout to project ${projectA}, but --project names project ${projectB}. Nothing was stored, and nothing was written.\n`,
    );
    expect(readFileSync(bindingPath(), "utf8")).toBe(text);
    expect(server.registrations).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test("a binding for this server and project, found here or above, is left as it is", async () => {
    const text = bind(projectA);
    const below = join(checkout, "src");
    mkdirSync(below);
    server.grants.push(projectA);

    const authorized = await link(["--server", server.origin], { cwd: below });

    expect(authorized.status).toBe(0);
    expect(urlsIn(authorized.stderr)).toHaveLength(1);
    expect(authorized.stdout).toBe(
      [
        `Stored the mcp credential for project ${projectA} (organization ${FAKE_ORGANIZATION_ID}) on ${server.origin}.`,
        `${bindingPath()} already binds this checkout to project ${projectA} (the-bound-project) on ${server.origin}; it is left as it is.`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(bindingPath(), "utf8")).toBe(text);
    expect(readdirSync(below)).toEqual([]);

    // Again, with the credential stored: no consent, and still untouched.
    const again = await link(["--server", server.origin]);
    expect(again.status).toBe(0);
    expect(again.stderr).toBe("");
    expect(readFileSync(bindingPath(), "utf8")).toBe(text);
  });

  test("with a binding and no --project, a grant for another project is refused, naming both, and nothing is stored", async () => {
    const text = bind(projectA);
    server.grants.push(projectB);

    const run = await link(["--server", server.origin]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `requestport link: The mcp grant is for project ${projectB}, but this checkout's binding (${bindingPath()}) names project ${projectA}. Nothing was stored.`,
    );
    expect(readFileSync(bindingPath(), "utf8")).toBe(text);
    expect(existsSync(credentialsPath())).toBe(false);
  });

  test("--project A with a grant for B: refused, naming both; nothing stored or written", async () => {
    server.grants.push(projectB);

    const run = await link(["--server", server.origin, "--project", projectA]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `The mcp grant is for project ${projectB}, but --project names project ${projectA}. Nothing was stored.`,
    );
    expect(run.stdout).toBe("");
    expect(readdirSync(checkout)).toEqual([]);
    expect(existsSync(credentialsPath())).toBe(false);
  });

  test("a grant without project:read is refused, naming the scope; nothing stored or written", async () => {
    server.grants.push(projectA);
    server.mcpScopes = AGENT_SCOPES.filter((scope) => scope !== "project:read");

    const run = await link(["--server", server.origin]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "requestport link: The mcp grant does not carry the project:read scope, which link needs to read the project's slug (list_projects). Nothing was stored, and nothing was written.",
    );
    expect(server.mcpCalls).toEqual(["whoami"]);
    expect(run.stdout).toBe("");
    expect(readdirSync(checkout)).toEqual([]);
    expect(existsSync(credentialsPath())).toBe(false);
  });

  test("a record an earlier client stored is named, and replaced", async () => {
    mkdirSync(join(home, ".requestport"), { mode: 0o700 });
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        [server.origin]: {
          [projectA]: {
            obtained: "2026-01-01T00:00:00.000Z",
            refreshToken: "an-earlier-clients-token",
          },
        },
      }),
      { mode: 0o600 },
    );
    server.grants.push(projectA);

    const run = await link(["--server", server.origin, "--project", projectA]);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(
      `requestport link: the credential stored for project ${projectA} on ${server.origin} was stored by an earlier client without its registration; authorizing again.`,
    );
    expect(readFileSync(credentialsPath(), "utf8")).not.toContain(
      "an-earlier-clients-token",
    );
    expect(store.hasLegacyRecord(server.origin, projectA)).toBe(false);
  });
});
