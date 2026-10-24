import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AUDIENCES,
  type Audience,
  type CommandRunner,
  CREDENTIAL_DIRECTORY,
  CREDENTIAL_FILE,
  type CredentialStore,
  CredentialStoreError,
  createCredentialStore,
  createFileStore,
  createKeychainStore,
  isKeychainAvailable,
  KEYCHAIN_COMMAND_TIMEOUT_MS,
  resourceFor,
  type StoredCredential,
} from "./credentials.js";
import {
  fakeKeychain,
  itemKey as keyOf,
  notFound,
  ok,
} from "./test-support/fake-keychain.js";

/**
 * `spawnSync` as the keychain store's own runner reaches it, answered by
 * `security.answer` in place of the real `security`. With no answer set it
 * throws, so no test here can run the real one: every other test hands the
 * store a runner of its own.
 */
const security = vi.hoisted(() => ({
  answer: undefined as
    | ((command: string, args: readonly string[]) => unknown)
    | undefined,
  calls: [] as { args: readonly string[]; command: string; options: unknown }[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[], options: unknown) => {
      if (security.answer === undefined) {
        throw new Error("spawnSync was reached with no answer for security");
      }
      security.calls.push({ args, command, options });
      return security.answer(command, args);
    },
  };
});

/**
 * The one string this whole file exists to keep out of everything else.
 *
 * It is distinctive on purpose: a leak anywhere — an error, a stderr echo, a
 * JSON parser quoting what it choked on — surfaces as some run of this string,
 * and nothing else in the package can produce one by accident.
 */
const SECRET = "rt_9c1f-do-not-print-me";

/**
 * A leak is not only the whole token.
 *
 * `JSON.parse` quotes the first ten characters of whatever it choked on, and
 * ten characters of a refresh token is ten an attacker no longer has to guess.
 * So the check is for any run of the secret long enough to be recognised, not
 * for the string entire — an assertion that only catches a total disclosure is
 * one that lets every partial one through, which is exactly how this file's
 * first draft passed while quoting a third of the token.
 */
const RECOGNISABLE = 6;

/**
 * What a person would actually see, which includes the cause chain.
 *
 * Node prints causes by default, so an error that merely *carries* the failure
 * it wrapped discloses precisely as much as one that quotes it. Attaching the
 * original as `cause` is the tidy-looking refactor this guards against.
 */
function thrownText(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    const chain: string[] = [];
    let current: unknown = error;

    for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
      chain.push(String(current));
      current = current instanceof Error ? current.cause : undefined;
    }

    return chain.join(" ");
  }

  throw new Error("the call was expected to throw, and did not");
}

function expectNoTraceOfTheSecret(act: () => unknown): void {
  const text = thrownText(act);

  for (let at = 0; at + RECOGNISABLE <= SECRET.length; at += 1) {
    expect(text).not.toContain(SECRET.slice(at, at + RECOGNISABLE));
  }
}

const SERVER = "https://requestport.com";
const OTHER_SERVER = "https://staging.requestport.dev";
const PROJECT = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER_PROJECT = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "client-7Hq2xV";

/**
 * A pid no process can have: above the largest Linux hands out (2^22) and
 * macOS's (99999), so asking whether it runs always answers no.
 */
const NO_SUCH_PID = 2 ** 22 + 7;

/** The record `authorize` writes: version 2, for one audience of one server. */
function recordFor(
  audience: Audience,
  overrides: Partial<StoredCredential> = {},
  server = SERVER,
): StoredCredential {
  return {
    audience,
    clientId: CLIENT_ID,
    obtained: "2026-09-06T10:00:00.000Z",
    refreshToken: SECRET,
    resource: `${server}${audience === "mcp" ? "/mcp" : "/api/v1"}`,
    version: 2,
    ...overrides,
  };
}

const credential = recordFor("mcp");

/** What the client before version 2 stored: no client id, no audience. */
const legacy = { obtained: "2026-09-01T10:00:00.000Z", refreshToken: SECRET };

const directories: string[] = [];

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-credentials-"));
  directories.push(root);
  return root;
}

function credentialsPath(root: string): string {
  return join(root, CREDENTIAL_DIRECTORY, CREDENTIAL_FILE);
}

function contentsOf(root: string): string {
  return readFileSync(credentialsPath(root), "utf8");
}

function seedFile(root: string, contents: unknown): void {
  mkdirSync(join(root, CREDENTIAL_DIRECTORY), { recursive: true });
  writeFileSync(credentialsPath(root), JSON.stringify(contents));
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { force: true, recursive: true });
  }
});

/** The key the fake keychain files an item under, for this file's project. */
function itemKey(service: string, account = PROJECT): string {
  return keyOf(service, account);
}

const LEGACY_SERVICE = `requestport:${SERVER}:${PROJECT}`;

function keychainStore(): CredentialStore {
  return createKeychainStore({ run: fakeKeychain().run });
}

function fileStore(): CredentialStore {
  return createFileStore({ home: home() });
}

describe("the audience a credential is for", () => {
  test("is mcp or api, the two agent resources of a server", () => {
    expect([...AUDIENCES].sort()).toEqual(["api", "mcp"]);
  });

  test("names its resource as the server's origin plus the audience's path", () => {
    expect(resourceFor(SERVER, "mcp")).toBe(`${SERVER}/mcp`);
    expect(resourceFor(SERVER, "api")).toBe(`${SERVER}/api/v1`);
    expect(resourceFor(`${SERVER}/`, "api")).toBe(`${SERVER}/api/v1`);
    expect(resourceFor("http://127.0.0.1:3000", "mcp")).toBe(
      "http://127.0.0.1:3000/mcp",
    );
  });
});

/**
 * Everything in these blocks holds for both custody mechanisms.
 *
 * The design turns on the resolver never learning which store it got, and that
 * promise is only worth making if the two behave the same. Running one suite
 * against both is how it stays kept rather than merely claimed.
 */
describe.each([
  ["keychain", keychainStore],
  ["file", fileStore],
])("the %s store", (_label, make) => {
  test("returns nothing when it holds nothing", () => {
    expect(make().read(SERVER, PROJECT, "mcp")).toBeUndefined();
  });

  /**
   * The scheme, not merely the presence of an origin.
   *
   * A `blob:` URL carries the origin of the thing it wraps — `new
   * URL("blob:https://host/x").origin` is `https://host` — so keying on the
   * origin alone let a `blob:` server read the https server's refresh token,
   * which is the one collision this key exists to prevent. `ws:`, `wss:` and
   * `ftp:` carry origins of their own and were simply stored, though the
   * docstring said they could not be.
   */
  test.each([
    "ws://requestport.com",
    "wss://requestport.com",
    "ftp://requestport.com",
    "blob:https://requestport.com/1234",
    "file:///tmp/requestport",
  ])("refuses to key a credential by %s", (server) => {
    const store = make();

    expect(() => store.write(server, PROJECT, "mcp", credential)).toThrow(
      /http or https/iu,
    );
    expect(() => store.read(server, PROJECT, "mcp")).toThrow(/http or https/iu);
  });

  test("does not hand a blob: server the credential of the origin it wraps", () => {
    const store = make();
    store.write(SERVER, PROJECT, "mcp", credential);

    expect(() => store.read(`blob:${SERVER}/1234`, PROJECT, "mcp")).toThrow(
      /http or https/iu,
    );
  });

  test("round-trips a credential", () => {
    const store = make();
    store.write(SERVER, PROJECT, "mcp", credential);

    expect(store.read(SERVER, PROJECT, "mcp")).toEqual(credential);
  });

  test("round-trips a credential obtained to the minute, as zod 4.4.3 read one", () => {
    const store = make();
    const toTheMinute = { ...credential, obtained: "2026-09-06T10:00Z" };
    store.write(SERVER, PROJECT, "mcp", toTheMinute);

    expect(store.read(SERVER, PROJECT, "mcp")).toEqual(toTheMinute);
  });

  test("replaces a credential rather than duplicating it", () => {
    const store = make();
    store.write(SERVER, PROJECT, "mcp", credential);
    const replacement = { ...credential, refreshToken: "rt_rotated-once" };
    store.write(SERVER, PROJECT, "mcp", replacement);

    expect(store.read(SERVER, PROJECT, "mcp")).toEqual(replacement);
  });

  test("forgets a credential when it is cleared", () => {
    const store = make();
    store.write(SERVER, PROJECT, "mcp", credential);
    store.clear(SERVER, PROJECT, "mcp");

    expect(store.read(SERVER, PROJECT, "mcp")).toBeUndefined();
  });

  test("clearing what was never stored is not an error", () => {
    const store = make();

    expect(() => store.clear(SERVER, PROJECT, "mcp")).not.toThrow();
  });

  test("treats a trailing slash as the same server", () => {
    const store = make();
    store.write(SERVER, PROJECT, "mcp", credential);

    expect(store.read(`${SERVER}/`, PROJECT, "mcp")).toEqual(credential);
  });

  test("refuses a server that is not a URL", () => {
    const store = make();

    expect(() =>
      store.write("requestport.com", PROJECT, "mcp", credential),
    ).toThrow(CredentialStoreError);
    expect(() => store.read("requestport.com", PROJECT, "mcp")).toThrow(
      CredentialStoreError,
    );
  });

  /**
   * The record is strict, and every field is one a refresh needs: without
   * the client id the provider refuses the refresh (`invalid_grant`), and
   * without the resource it mints a token no endpoint accepts.
   */
  test.each([
    ["an empty refresh token", { ...credential, refreshToken: "" }],
    ["an obtained that is not a timestamp", { ...credential, obtained: "y" }],
    ["a missing refresh token", { ...credential, refreshToken: undefined }],
    ["a missing client id", { ...credential, clientId: undefined }],
    ["an empty client id", { ...credential, clientId: "" }],
    ["a missing resource", { ...credential, resource: undefined }],
    ["version 1", { ...credential, version: 1 }],
    ["a version this client does not know", { ...credential, version: 3 }],
    ["a field the record does not have", { ...credential, accessToken: "x" }],
    ["the earlier shape, with no client id", legacy],
  ])("refuses to store %s", (_case, value) => {
    const store = make();

    expect(() =>
      store.write(SERVER, PROJECT, "mcp", value as StoredCredential),
    ).toThrow(CredentialStoreError);
    expect(store.read(SERVER, PROJECT, "mcp")).toBeUndefined();
  });

  /**
   * manifest-h.md §2.8.2: both stores refuse a record whose resource is not
   * the server's origin plus its audience's path. A token minted for one
   * resource is refused by the other endpoint, so such a record could only
   * ever produce tokens that fail.
   */
  test.each([
    ["the other audience's resource", `${SERVER}/api/v1`],
    ["another server's resource", `${OTHER_SERVER}/mcp`],
    ["a resource with a trailing slash", `${SERVER}/mcp/`],
    ["the bare origin", SERVER],
  ])("refuses a record whose resource is %s", (_case, resource) => {
    const store = make();

    expect(() =>
      store.write(SERVER, PROJECT, "mcp", { ...credential, resource }),
    ).toThrow(/resource/u);
  });

  test("refuses a record stored under one audience that names the other", () => {
    const store = make();

    expect(() => store.write(SERVER, PROJECT, "api", recordFor("mcp"))).toThrow(
      /audience/u,
    );
  });

  test("refuses an audience that is neither mcp nor api", () => {
    const store = make();
    const web = "web" as Audience;

    expect(() => store.read(SERVER, PROJECT, web)).toThrow(
      CredentialStoreError,
    );
    expect(() => store.write(SERVER, PROJECT, web, credential)).toThrow(
      CredentialStoreError,
    );
    expect(() => store.clear(SERVER, PROJECT, web)).toThrow(
      CredentialStoreError,
    );
  });
});

/**
 * The rule the store exists for: one project's secret stays its own, and so
 * does each of its two audiences'.
 *
 * A store that answers with the nearest credential rather than the asked-for
 * one hands an agent authority over a project nobody granted it, and the
 * `whoami` mismatch in `project.ts` is the only thing downstream that would
 * notice. Catching it here is earlier and cheaper.
 */
describe.each([
  ["keychain", keychainStore],
  ["file", fileStore],
])(
  "the %s store keeps projects, servers and audiences apart",
  (_label, make) => {
    test("does not answer for another project on the same server", () => {
      const store = make();
      store.write(SERVER, PROJECT, "mcp", credential);

      expect(store.read(SERVER, OTHER_PROJECT, "mcp")).toBeUndefined();
    });

    test("does not answer for the same project on another server", () => {
      const store = make();
      store.write(SERVER, PROJECT, "mcp", credential);

      expect(store.read(OTHER_SERVER, PROJECT, "mcp")).toBeUndefined();
    });

    test("does not answer for the other audience of the same project", () => {
      const store = make();
      store.write(SERVER, PROJECT, "mcp", credential);

      expect(store.read(SERVER, PROJECT, "api")).toBeUndefined();
    });

    test("keeps both audiences of one project", () => {
      const store = make();
      const api = recordFor("api", {
        clientId: "client-api",
        refreshToken: "rt_api",
      });
      store.write(SERVER, PROJECT, "mcp", credential);
      store.write(SERVER, PROJECT, "api", api);

      expect(store.read(SERVER, PROJECT, "mcp")).toEqual(credential);
      expect(store.read(SERVER, PROJECT, "api")).toEqual(api);
    });

    test("clearing one audience leaves the other alone", () => {
      const store = make();
      const api = recordFor("api", { refreshToken: "rt_api" });
      store.write(SERVER, PROJECT, "mcp", credential);
      store.write(SERVER, PROJECT, "api", api);
      store.clear(SERVER, PROJECT, "mcp");

      expect(store.read(SERVER, PROJECT, "mcp")).toBeUndefined();
      expect(store.read(SERVER, PROJECT, "api")).toEqual(api);
    });

    test("keeps both when two projects on one server are stored", () => {
      const store = make();
      const other = { ...credential, refreshToken: "rt_other-project" };
      store.write(SERVER, PROJECT, "mcp", credential);
      store.write(SERVER, OTHER_PROJECT, "mcp", other);

      expect(store.read(SERVER, PROJECT, "mcp")).toEqual(credential);
      expect(store.read(SERVER, OTHER_PROJECT, "mcp")).toEqual(other);
    });

    test("clearing one project leaves the other alone", () => {
      const store = make();
      const other = { ...credential, refreshToken: "rt_other-project" };
      store.write(SERVER, PROJECT, "mcp", credential);
      store.write(SERVER, OTHER_PROJECT, "mcp", other);
      store.clear(SERVER, PROJECT, "mcp");

      expect(store.read(SERVER, PROJECT, "mcp")).toBeUndefined();
      expect(store.read(SERVER, OTHER_PROJECT, "mcp")).toEqual(other);
    });

    test("clearing on one server leaves the other server alone", () => {
      const store = make();
      const elsewhere = recordFor("mcp", {}, OTHER_SERVER);
      store.write(SERVER, PROJECT, "mcp", credential);
      store.write(OTHER_SERVER, PROJECT, "mcp", elsewhere);
      store.clear(SERVER, PROJECT, "mcp");

      expect(store.read(OTHER_SERVER, PROJECT, "mcp")).toEqual(elsewhere);
    });
  },
);

/**
 * A record the client before version 2 stored: `{ obtained, refreshToken }`,
 * directly under the project id in the file, or in the keychain item named
 * without an audience. It lacks the client id, and a refresh token is bound
 * to the client it was issued to, so it can never be refreshed.
 * manifest-h.md §2.8.2: it is never read as a credential; a write for that
 * server and project removes it; a clear removes it with the new records. It
 * is never turned into a version 2 record, because it has nothing to fill the
 * client id with. `hasLegacyRecord` is how `requestport login` finds one to
 * name.
 */
describe("a record stored by the client before version 2", () => {
  function legacyFile(): { root: string; store: CredentialStore } {
    const root = home();
    seedFile(root, {
      [OTHER_SERVER]: { [PROJECT]: legacy },
      [SERVER]: { [PROJECT]: legacy },
    });
    return { root, store: createFileStore({ home: root }) };
  }

  function legacyKeychain() {
    const keychain = fakeKeychain();
    keychain.entries.set(itemKey(LEGACY_SERVICE), JSON.stringify(legacy));
    return { keychain, store: createKeychainStore({ run: keychain.run }) };
  }

  test.each(AUDIENCES)(
    "is never read as the %s credential, from the file",
    (audience) => {
      const { store } = legacyFile();

      expect(store.read(SERVER, PROJECT, audience)).toBeUndefined();
      expect(store.hasLegacyRecord(SERVER, PROJECT)).toBe(true);
    },
  );

  test.each(AUDIENCES)(
    "is never read as the %s credential, from the keychain",
    (audience) => {
      const { store } = legacyKeychain();

      expect(store.read(SERVER, PROJECT, audience)).toBeUndefined();
      expect(store.hasLegacyRecord(SERVER, PROJECT)).toBe(true);
    },
  );

  test("is not reported where there is none", () => {
    expect(fileStore().hasLegacyRecord(SERVER, PROJECT)).toBe(false);
    expect(keychainStore().hasLegacyRecord(SERVER, PROJECT)).toBe(false);

    const store = fileStore();
    store.write(SERVER, PROJECT, "mcp", credential);
    expect(store.hasLegacyRecord(SERVER, PROJECT)).toBe(false);
  });

  test("is replaced, not migrated, by a write for that server and project in the file", () => {
    const { root, store } = legacyFile();
    store.write(SERVER, PROJECT, "api", recordFor("api"));

    expect(JSON.parse(contentsOf(root))).toEqual({
      [OTHER_SERVER]: { [PROJECT]: legacy },
      [SERVER]: { [PROJECT]: { api: recordFor("api") } },
    });
    expect(store.hasLegacyRecord(SERVER, PROJECT)).toBe(false);
    expect(store.read(SERVER, PROJECT, "mcp")).toBeUndefined();
  });

  test("is replaced, not migrated, by a write for that server and project in the keychain", () => {
    const { keychain, store } = legacyKeychain();
    store.write(SERVER, PROJECT, "mcp", credential);

    expect([...keychain.entries.keys()]).toEqual([
      itemKey(`${LEGACY_SERVICE}:mcp`),
    ]);
    expect(store.hasLegacyRecord(SERVER, PROJECT)).toBe(false);
    expect(store.read(SERVER, PROJECT, "mcp")).toEqual(credential);
  });

  /**
   * The removal comes first. A keychain that will not remove the old item
   * leaves the write undone, rather than leaving two items of which one can
   * never work.
   */
  test("fails the keychain write, storing nothing new, when the old item cannot be removed", () => {
    const keychain = fakeKeychain();
    keychain.entries.set(itemKey(LEGACY_SERVICE), JSON.stringify(legacy));
    const run: CommandRunner = (command, args) =>
      args[0] === "delete-generic-password"
        ? {
            status: 51,
            stderr: "security: User interaction is not allowed.\n",
            stdout: "",
          }
        : keychain.run(command, args);
    const store = createKeychainStore({ run });

    expect(() => store.write(SERVER, PROJECT, "mcp", credential)).toThrow(
      CredentialStoreError,
    );
    expect(keychain.entries.has(itemKey(`${LEGACY_SERVICE}:mcp`))).toBe(false);
  });

  test("is removed by a clear in the file, with the new records", () => {
    const { root, store } = legacyFile();
    store.clear(SERVER, PROJECT, "mcp");

    expect(JSON.parse(contentsOf(root))).toEqual({
      [OTHER_SERVER]: { [PROJECT]: legacy },
    });
  });

  test("is removed by a clear in the keychain, with the new record", () => {
    const { keychain, store } = legacyKeychain();
    keychain.entries.set(
      itemKey(`${LEGACY_SERVICE}:mcp`),
      JSON.stringify(credential),
    );
    store.clear(SERVER, PROJECT, "mcp");

    expect(keychain.entries.size).toBe(0);
  });
});

/**
 * Custody of the file, which is the whole of its security.
 *
 * A keychain item is protected by the keychain. A file is protected by its
 * mode and by nothing else, so the mode is not an implementation detail here —
 * it is the implementation.
 */
describe("the file store's custody", () => {
  test("writes the credential file 0600 inside a 0700 directory", () => {
    const root = home();
    createFileStore({ home: root }).write(SERVER, PROJECT, "mcp", credential);

    expect(statSync(credentialsPath(root)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, CREDENTIAL_DIRECTORY)).mode & 0o777).toBe(0o700);
  });

  test("tightens a file that was already there with a looser mode", () => {
    const root = home();
    mkdirSync(join(root, CREDENTIAL_DIRECTORY), { recursive: true });
    writeFileSync(credentialsPath(root), "{}\n");
    chmodSync(credentialsPath(root), 0o644);
    chmodSync(join(root, CREDENTIAL_DIRECTORY), 0o755);

    createFileStore({ home: root }).write(SERVER, PROJECT, "mcp", credential);

    expect(statSync(credentialsPath(root)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, CREDENTIAL_DIRECTORY)).mode & 0o777).toBe(0o700);
  });

  /** manifest-h.md §2.8.2: origin, then project id, then audience. */
  test("keeps the layout the file format promises", () => {
    const root = home();
    const store = createFileStore({ home: root });
    store.write(SERVER, PROJECT, "mcp", credential);
    store.write(SERVER, PROJECT, "api", recordFor("api"));

    expect(JSON.parse(contentsOf(root)) as unknown).toEqual({
      [SERVER]: { [PROJECT]: { api: recordFor("api"), mcp: credential } },
    });
  });

  test("clearing with nothing stored creates nothing", () => {
    const root = home();
    createFileStore({ home: root }).clear(SERVER, PROJECT, "mcp");

    expect(readdirSync(root)).toEqual([]);
  });

  test("removes a project, then a server, left with no credentials", () => {
    const root = home();
    const store = createFileStore({ home: root });
    store.write(SERVER, PROJECT, "mcp", credential);
    store.write(SERVER, PROJECT, "api", recordFor("api"));
    store.clear(SERVER, PROJECT, "api");

    expect(JSON.parse(contentsOf(root))).toEqual({
      [SERVER]: { [PROJECT]: { mcp: credential } },
    });

    store.clear(SERVER, PROJECT, "mcp");
    expect(JSON.parse(contentsOf(root))).toEqual({});
  });

  test("leaves another server's credentials in place when writing", () => {
    const root = home();
    const store = createFileStore({ home: root });
    const elsewhere = recordFor("mcp", {}, OTHER_SERVER);
    store.write(OTHER_SERVER, OTHER_PROJECT, "mcp", elsewhere);
    store.write(SERVER, PROJECT, "mcp", credential);

    expect(JSON.parse(contentsOf(root)) as unknown).toEqual({
      [OTHER_SERVER]: { [OTHER_PROJECT]: { mcp: elsewhere } },
      [SERVER]: { [PROJECT]: { mcp: credential } },
    });
  });

  /**
   * The file is replaced by a rename, so a reader in another process sees
   * the whole of the old file or the whole of the new one and never a
   * truncated one; and the writer's lock, beside the file, is gone once the
   * write is done.
   */
  test("leaves nothing but the credential file behind a write", () => {
    const root = home();
    const store = createFileStore({ home: root });
    store.write(SERVER, PROJECT, "mcp", credential);
    store.clear(SERVER, PROJECT, "mcp");
    store.write(SERVER, PROJECT, "api", recordFor("api"));

    expect(readdirSync(join(root, CREDENTIAL_DIRECTORY))).toEqual([
      CREDENTIAL_FILE,
    ]);
  });

  test("takes over the writers' lock when the process holding it has exited", () => {
    const root = home();
    mkdirSync(join(root, CREDENTIAL_DIRECTORY), { recursive: true });
    writeFileSync(
      join(root, CREDENTIAL_DIRECTORY, `${CREDENTIAL_FILE}.lock`),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), nonce: "left-behind", pid: NO_SUCH_PID })}\n`,
    );
    const store = createFileStore({ home: root });

    store.write(SERVER, PROJECT, "mcp", credential);

    expect(store.read(SERVER, PROJECT, "mcp")).toEqual(credential);
  });

  test("refuses a malformed file rather than echoing what it holds", () => {
    const root = home();
    mkdirSync(join(root, CREDENTIAL_DIRECTORY), { recursive: true });
    writeFileSync(credentialsPath(root), `not json at all ${SECRET}`);
    const store = createFileStore({ home: root });

    expect(() => store.read(SERVER, PROJECT, "mcp")).toThrow(
      CredentialStoreError,
    );
    expectNoTraceOfTheSecret(() => store.read(SERVER, PROJECT, "mcp"));
  });

  test("refuses to write over a malformed file rather than destroying it", () => {
    const root = home();
    mkdirSync(join(root, CREDENTIAL_DIRECTORY), { recursive: true });
    writeFileSync(credentialsPath(root), "{ broken");
    const store = createFileStore({ home: root });

    expect(() => store.write(SERVER, PROJECT, "mcp", credential)).toThrow(
      CredentialStoreError,
    );
    expect(contentsOf(root)).toBe("{ broken");
  });

  /**
   * Neither a version 2 entry nor the earlier shape: it may be a later
   * client's, and replacing it would destroy that client's credential.
   */
  test("refuses, and will not replace, a project entry that is neither form", () => {
    const root = home();
    seedFile(root, { [SERVER]: { [PROJECT]: { refreshToken: 42 } } });
    const store = createFileStore({ home: root });

    expect(() => store.read(SERVER, PROJECT, "mcp")).toThrow(
      CredentialStoreError,
    );
    expect(() => store.write(SERVER, PROJECT, "mcp", credential)).toThrow(
      CredentialStoreError,
    );
    expect(JSON.parse(contentsOf(root))).toEqual({
      [SERVER]: { [PROJECT]: { refreshToken: 42 } },
    });
  });

  test("refuses a stored record whose resource does not belong to it", () => {
    const root = home();
    seedFile(root, {
      [SERVER]: {
        [PROJECT]: { mcp: { ...credential, resource: `${OTHER_SERVER}/mcp` } },
      },
    });

    expect(() =>
      createFileStore({ home: root }).read(SERVER, PROJECT, "mcp"),
    ).toThrow(/resource/u);
  });

  test("refuses a stored record filed under the audience it does not name", () => {
    const root = home();
    seedFile(root, { [SERVER]: { [PROJECT]: { api: credential } } });

    expect(() =>
      createFileStore({ home: root }).read(SERVER, PROJECT, "api"),
    ).toThrow(/audience/u);
  });
});

/**
 * How the store talks to `security`, which is the part a fake cannot infer.
 *
 * The namespacing is asserted literally because it *is* the contract: the
 * prefix keeps RequestPort out of every other application's items, the whole
 * origin — not the bare host — keeps two RequestPort servers, a production
 * one and a local one, out of each other's, and the audience keeps the
 * bridge's credential and the HTTP client's apart.
 */
describe("the keychain store's use of security", () => {
  test("namespaces the item by server origin, project and audience", () => {
    const keychain = fakeKeychain();
    const store = createKeychainStore({ run: keychain.run });
    store.write(SERVER, PROJECT, "mcp", credential);
    store.write(SERVER, PROJECT, "api", recordFor("api"));

    expect([...keychain.entries.keys()].sort()).toEqual([
      itemKey(`requestport:${SERVER}:${PROJECT}:api`),
      itemKey(`requestport:${SERVER}:${PROJECT}:mcp`),
    ]);
  });

  test("updates in place rather than failing on a duplicate item", () => {
    const keychain = fakeKeychain();
    const store = createKeychainStore({ run: keychain.run });
    store.write(SERVER, PROJECT, "mcp", credential);
    store.write(SERVER, PROJECT, "mcp", {
      ...credential,
      refreshToken: "rt_second",
    });

    expect(keychain.entries.size).toBe(1);
    expect(store.read(SERVER, PROJECT, "mcp")?.refreshToken).toBe("rt_second");
  });

  test("reads an absent item as absent, not as a failure", () => {
    const keychain = fakeKeychain();

    expect(
      createKeychainStore({ run: keychain.run }).read(SERVER, PROJECT, "mcp"),
    ).toBeUndefined();
  });

  test("refuses to read a locked keychain as an absent credential", () => {
    // 51 is what `security` returns when it may not prompt — a locked keychain
    // over ssh. Reading that as "no credential" sends the caller through a
    // fresh authorization it does not need and, in that session, cannot finish.
    const run: CommandRunner = () => ({
      status: 51,
      stderr: "security: User interaction is not allowed.\n",
      stdout: "",
    });
    const store = createKeychainStore({ run });

    expect(() => store.read(SERVER, PROJECT, "mcp")).toThrow(
      CredentialStoreError,
    );
    expect(() => store.hasLegacyRecord(SERVER, PROJECT)).toThrow(
      CredentialStoreError,
    );
  });

  test("asks whether the earlier item exists without asking for its secret", () => {
    const keychain = fakeKeychain();
    createKeychainStore({ run: keychain.run }).hasLegacyRecord(SERVER, PROJECT);

    expect(keychain.calls).toHaveLength(1);
    expect(keychain.calls[0]?.args).toEqual([
      "find-generic-password",
      "-a",
      PROJECT,
      "-s",
      LEGACY_SERVICE,
    ]);
  });

  test("refuses a stored item whose resource does not belong to it", () => {
    const keychain = fakeKeychain();
    keychain.entries.set(
      itemKey(`${LEGACY_SERVICE}:mcp`),
      JSON.stringify({ ...credential, resource: `${SERVER}/api/v1` }),
    );

    expect(() =>
      createKeychainStore({ run: keychain.run }).read(SERVER, PROJECT, "mcp"),
    ).toThrow(/resource/u);
  });

  test("surfaces a failed write rather than reporting success", () => {
    const run: CommandRunner = (_command, args) =>
      args[0] === "add-generic-password"
        ? { status: 1, stderr: "security: write failed\n", stdout: "" }
        : args[0] === "delete-generic-password"
          ? notFound()
          : ok("");

    expect(() =>
      createKeychainStore({ run }).write(SERVER, PROJECT, "mcp", credential),
    ).toThrow(CredentialStoreError);
  });

  test("survives a runner that cannot launch the command at all", () => {
    const run: CommandRunner = () => {
      throw new Error(`spawn failed: add-generic-password -w ${SECRET}`);
    };
    const store = createKeychainStore({ run });

    expect(() => store.write(SERVER, PROJECT, "mcp", credential)).toThrow(
      CredentialStoreError,
    );
    expectNoTraceOfTheSecret(() =>
      store.write(SERVER, PROJECT, "mcp", credential),
    );
  });
});

/**
 * What `spawnSync` answers for a command that exited with `status`.
 */
function exited(status: number): unknown {
  return {
    output: [null, "", ""],
    pid: 4242,
    signal: null,
    status,
    stderr: "",
    stdout: "",
  };
}

/**
 * What `spawnSync` answers for a command it killed at its timeout. Measured
 * (Node 22.22.3): status null, the kill signal, and an error whose code is
 * ETIMEDOUT.
 */
function cutOff(): unknown {
  return {
    error: Object.assign(new Error("spawnSync security ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
    output: [null, "", ""],
    pid: 4242,
    signal: "SIGKILL",
    status: null,
    stderr: "",
    stdout: "",
  };
}

/**
 * The keychain store with no runner handed to it runs `security` itself,
 * and each call is bounded. `security` can otherwise block for as long as
 * an unlock prompt goes unanswered, and a token source holds its lock
 * across one read and one write of this store (`token-source.ts`): a
 * holder blocked past the lock's stale age would have its lock taken over,
 * and the taker would present the refresh token the holder was rotating.
 */
describe("the security command the keychain store runs itself", () => {
  afterEach(() => {
    security.answer = undefined;
    security.calls = [];
  });

  /**
   * Killed with SIGKILL, because the timeout's default signal, SIGTERM, can
   * be ignored: measured (Node 22.22.3), a child that ignored it kept
   * `spawnSync` waiting until it exited on its own, 3,034 ms against a
   * 300 ms timeout; with SIGKILL, 305 ms.
   */
  test("gives every call 10 s, and kills it outright when it has not answered by then", () => {
    security.answer = (_command, args) =>
      args[0] === "add-generic-password" || args[0] === "list-keychains"
        ? exited(0)
        : exited(44);
    const store = createKeychainStore();

    store.read(SERVER, PROJECT, "mcp");
    store.write(SERVER, PROJECT, "mcp", credential);
    store.clear(SERVER, PROJECT, "mcp");
    store.hasLegacyRecord(SERVER, PROJECT);
    isKeychainAvailable({ platform: "darwin" });

    expect(security.calls.map((call) => call.args[0])).toEqual([
      "find-generic-password",
      "delete-generic-password",
      "add-generic-password",
      "delete-generic-password",
      "delete-generic-password",
      "find-generic-password",
      "list-keychains",
    ]);
    expect(KEYCHAIN_COMMAND_TIMEOUT_MS).toBe(10_000);
    for (const call of security.calls) {
      expect(call.command).toBe("security");
      expect(call.options).toMatchObject({
        killSignal: "SIGKILL",
        timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
      });
    }
  });

  test("says a call cut off at 10 s did not answer in time, and repeats nothing it was given", () => {
    security.answer = () => cutOff();
    const store = createKeychainStore();

    for (const act of [
      () => store.read(SERVER, PROJECT, "mcp"),
      () => store.write(SERVER, PROJECT, "mcp", credential),
      () => store.clear(SERVER, PROJECT, "mcp"),
      () => store.hasLegacyRecord(SERVER, PROJECT),
    ]) {
      const text = thrownText(act);
      expect(text).toContain("security did not answer within 10s");
      expect(text).not.toMatch(/exited/u);
      expectNoTraceOfTheSecret(act);
    }
    expect(isKeychainAvailable({ platform: "darwin" })).toBe(false);
  });
});

/**
 * The rule with no acceptable exception.
 *
 * A refresh token in a log line, a stack trace or a CI transcript is a
 * disclosed credential, and every way one escapes has the same shape:
 * something else quoted its input back at us. Each test here is one of those.
 */
describe("errors never carry the secret", () => {
  test("not when security echoes the password in its own diagnostics", () => {
    // The earlier item is not there, so the write reaches `add`, whose argv
    // holds the token and whose failure echoes it.
    const run: CommandRunner = (_command, args) =>
      args[0] === "delete-generic-password"
        ? notFound()
        : {
            status: 1,
            stderr: `security: invalid argument: ${args.join(" ")}\n`,
            stdout: "",
          };
    const store = createKeychainStore({ run });

    expect(() => store.write(SERVER, PROJECT, "mcp", credential)).toThrow(
      CredentialStoreError,
    );
    expectNoTraceOfTheSecret(() =>
      store.write(SERVER, PROJECT, "mcp", credential),
    );
  });

  test("not when the stored keychain item cannot be parsed", () => {
    // A JSON parser quotes the text it choked on, and here that text is the
    // secret. This is the leak that looks like careful error handling.
    const keychain = fakeKeychain();
    keychain.entries.set(
      itemKey(`${LEGACY_SERVICE}:mcp`),
      `${SECRET} but not json`,
    );
    const store = createKeychainStore({ run: keychain.run });

    expect(() => store.read(SERVER, PROJECT, "mcp")).toThrow(
      CredentialStoreError,
    );
    expectNoTraceOfTheSecret(() => store.read(SERVER, PROJECT, "mcp"));
  });

  test("not when the credential itself is rejected as malformed", () => {
    const store = createFileStore({ home: home() });
    const malformed = { ...credential, obtained: "not a timestamp" };

    expect(() => store.write(SERVER, PROJECT, "mcp", malformed)).toThrow(
      CredentialStoreError,
    );
    expectNoTraceOfTheSecret(() =>
      store.write(SERVER, PROJECT, "mcp", malformed),
    );
  });

  test("not when a record is refused for its resource or its audience", () => {
    const store = createFileStore({ home: home() });
    const wrongResource = { ...credential, resource: `${SERVER}/api/v1` };

    expectNoTraceOfTheSecret(() =>
      store.write(SERVER, PROJECT, "mcp", wrongResource),
    );
    expectNoTraceOfTheSecret(() =>
      store.write(SERVER, PROJECT, "api", credential),
    );
  });

  test("not when the file cannot be written at all", () => {
    const root = home();
    // A file where the directory belongs: the write cannot succeed, and the
    // failure arrives from `node:fs` with the payload in scope.
    writeFileSync(join(root, CREDENTIAL_DIRECTORY), "in the way");
    const store = createFileStore({ home: root });

    expect(() => store.write(SERVER, PROJECT, "mcp", credential)).toThrow(
      CredentialStoreError,
    );
    expectNoTraceOfTheSecret(() =>
      store.write(SERVER, PROJECT, "mcp", credential),
    );
  });

  test("names the server, the project and the audience, which is what a person needs", () => {
    const run: CommandRunner = (_command, args) =>
      args[0] === "delete-generic-password"
        ? notFound()
        : { status: 1, stderr: "security: write failed\n", stdout: "" };
    const store = createKeychainStore({ run });

    const text = thrownText(() =>
      store.write(SERVER, PROJECT, "mcp", credential),
    );
    expect(text).toContain(PROJECT);
    expect(text).toContain(SERVER);
    expect(text).toContain("mcp");
  });
});

/**
 * Choosing between the two, an answer the caller is never given.
 *
 * A laptop has a keychain worth using and a container does not, so the choice
 * is per machine. It also has to be overridable, because availability is a
 * guess and the person running the thing knows better than the guess.
 */
describe("choosing a store", () => {
  test("uses the keychain when security answers", () => {
    const keychain = fakeKeychain();
    createCredentialStore({
      home: home(),
      platform: "darwin",
      run: keychain.run,
    }).write(SERVER, PROJECT, "mcp", credential);

    expect(keychain.entries.size).toBe(1);
  });

  test("uses the file when the platform has no keychain", () => {
    const keychain = fakeKeychain();
    const root = home();
    createCredentialStore({
      home: root,
      platform: "linux",
      run: keychain.run,
    }).write(SERVER, PROJECT, "mcp", credential);

    expect(keychain.entries.size).toBe(0);
    expect(statSync(credentialsPath(root)).mode & 0o777).toBe(0o600);
  });

  test("does not even ask about the keychain off macOS", () => {
    const keychain = fakeKeychain();

    expect(isKeychainAvailable({ platform: "linux", run: keychain.run })).toBe(
      false,
    );
    expect(keychain.calls).toEqual([]);
  });

  test("uses the file when security is installed but unusable", () => {
    const root = home();
    const run: CommandRunner = () => ({
      status: 1,
      stderr: "security: no keychain\n",
      stdout: "",
    });
    createCredentialStore({ home: root, platform: "darwin", run }).write(
      SERVER,
      PROJECT,
      "mcp",
      credential,
    );

    expect(statSync(credentialsPath(root)).mode & 0o777).toBe(0o600);
  });

  test("uses the file when security cannot be launched", () => {
    const root = home();
    const run: CommandRunner = () => {
      throw new Error("spawnSync security ENOENT");
    };

    expect(isKeychainAvailable({ platform: "darwin", run })).toBe(false);
    expect(() =>
      createCredentialStore({ home: root, platform: "darwin", run }).write(
        SERVER,
        PROJECT,
        "mcp",
        credential,
      ),
    ).not.toThrow();
  });

  test.each([
    ["file", 0],
    ["keychain", 1],
  ])("honours an explicit preference for the %s", (prefer, entries) => {
    const keychain = fakeKeychain();
    createCredentialStore({
      home: home(),
      platform: "darwin",
      prefer: prefer as "file" | "keychain",
      run: keychain.run,
    }).write(SERVER, PROJECT, "mcp", credential);

    expect(keychain.entries.size).toBe(entries);
  });

  test("tells the caller nothing about which one it got", () => {
    const keychain = fakeKeychain();
    const chosen = createCredentialStore({
      home: home(),
      platform: "darwin",
      run: keychain.run,
    });

    expect(Object.keys(chosen).sort()).toEqual([
      "clear",
      "hasLegacyRecord",
      "read",
      "write",
    ]);
    expect(Object.keys(chosen).sort()).toEqual(
      Object.keys(createFileStore({ home: home() })).sort(),
    );
  });
});
