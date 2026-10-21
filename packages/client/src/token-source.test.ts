import { createHash } from "node:crypto";
import {
  existsSync,
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
  type Audience,
  type CredentialStore,
  createFileStore,
  createKeychainStore,
  KEYCHAIN_COMMAND_TIMEOUT_MS,
  resourceFor,
  type StoredCredential,
} from "./credentials.js";
import type { FetchLike } from "./oauth.js";
import { fakeKeychain, itemKey } from "./test-support/fake-keychain.js";
import {
  createFakeProvider,
  type FakeProvider,
  never,
} from "./test-support/fake-provider.js";
import {
  AuthorizationRequiredError,
  createTokenSource,
  EXPIRY_MARGIN_MS,
  LOCK_STALE_AFTER_MS,
  LOCK_WAIT_MS,
  LockTimeoutError,
  REFRESH_TIMEOUT_MS,
  TokenRefreshError,
  type TokenSource,
  type TokenSourceOptions,
} from "./token-source.js";

const SERVER = "https://requestport.com";
const PROJECT = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const CLIENT_ID = "client-from-registration";
const OBTAINED = "2026-09-30T10:00:00.000Z";

/**
 * A pid no process can have: above the largest Linux hands out (2^22) and
 * macOS's (99999), so asking whether it runs always answers no, and this
 * suite starts no process to get one. `lock.test.ts` asks the same question
 * about the pid of a process that really ran and exited.
 */
const NO_SUCH_PID = 2 ** 22 + 7;

const directories: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-token-source-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { force: true, recursive: true });
  }
});

/** Message, stack, cause and any field an author might add later. */
function exposureOf(error: unknown): string {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    chain.push(
      current instanceof Error
        ? JSON.stringify(current, Object.getOwnPropertyNames(current))
        : String(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain.join(" ");
}

async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("the call was expected to throw, and did not");
}

type Setup = {
  readonly fetchCalls: string[];
  readonly first: string;
  readonly lockDirectory: string;
  readonly provider: FakeProvider;
  readonly record: StoredCredential;
  readonly resource: string;
  source(overrides?: Partial<TokenSourceOptions>): TokenSource;
  readonly store: CredentialStore;
};

function storeOf(kind: "file" | "keychain"): CredentialStore {
  return kind === "file"
    ? createFileStore({ home: scratch() })
    : createKeychainStore({ run: fakeKeychain().run });
}

/**
 * A stored credential as `authorize` writes it, a provider that issued its
 * refresh token to `CLIENT_ID`, and token sources over one store and one lock
 * directory, as two processes in one checkout would have.
 */
function setup(
  kind: "file" | "keychain",
  options: { audience?: Audience; seed?: boolean } = {},
): Setup {
  const audience = options.audience ?? "mcp";
  const provider = createFakeProvider(SERVER);
  const store = storeOf(kind);
  const lockDirectory = join(scratch(), "locks");
  const resource = resourceFor(SERVER, audience);
  const first = provider.authorize({
    clientId: CLIENT_ID,
    projectId: PROJECT,
    resource,
  });
  const record: StoredCredential = {
    audience,
    clientId: CLIENT_ID,
    obtained: OBTAINED,
    refreshToken: first,
    resource,
    version: 2,
  };
  if (options.seed !== false) store.write(SERVER, PROJECT, audience, record);

  const fetchCalls: string[] = [];
  const fetch: FetchLike = (url, init) => {
    fetchCalls.push(url);
    return provider.fetch(url, init);
  };

  return {
    fetchCalls,
    first,
    lockDirectory,
    provider,
    record,
    resource,
    source: (overrides = {}) =>
      createTokenSource({
        audience,
        fetch,
        lockDirectory,
        projectId: PROJECT,
        server: SERVER,
        store,
        ...overrides,
      }),
    store,
  };
}

/** Every token the provider issued or was shown, none of which may leak. */
function secretsOf(run: Setup, extra: readonly string[] = []): string[] {
  return [
    run.first,
    ...run.provider.refreshes.map((exchange) => exchange.refreshToken ?? ""),
    run.store.read(SERVER, PROJECT, run.record.audience)?.refreshToken ?? "",
    ...extra,
  ].filter((secret) => secret !== "");
}

function expectNoSecretIn(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("the token source's bounds", () => {
  /**
   * manifest-h.md §2.8.2. The refresh is aborted at a third of the age at
   * which a lock is taken over, so a running holder's request has ended, by
   * answer or by abort, long before another process may take its lock; and a
   * waiter waits longer than one holder's bounded refresh.
   */
  test("abort a refresh at 20 s, a third of the 60 s takeover age, and wait 30 s for a lock", () => {
    expect(REFRESH_TIMEOUT_MS).toBe(20_000);
    expect(LOCK_STALE_AFTER_MS).toBe(60_000);
    expect(LOCK_WAIT_MS).toBe(30_000);
    expect(REFRESH_TIMEOUT_MS * 3).toBeLessThanOrEqual(LOCK_STALE_AFTER_MS);
    expect(LOCK_WAIT_MS).toBeGreaterThan(REFRESH_TIMEOUT_MS);
    expect(EXPIRY_MARGIN_MS).toBe(60_000);
  });

  test("answers accessToken() and forgetAccessToken(), and nothing that carries the refresh token", () => {
    const run = setup("file");

    expect(Object.keys(run.source())).toEqual([
      "accessToken",
      "forgetAccessToken",
    ]);
  });

  /**
   * The lock is held for one read of the store, the refresh and one write.
   * On the keychain store each is bounded: the refresh at 20 s, and each
   * `security` call at `KEYCHAIN_COMMAND_TIMEOUT_MS`, of which a refresh
   * makes three under the lock. Their sum is under the age at which the
   * lock may be taken over. It counts this source's own steps only: other
   * synchronous work in the same process, such as another source's
   * `security` calls, can lengthen the hold (token-source.ts says so). (The
   * file store's write waits at most 15 s for its own writers' lock.)
   */
  test("holds its lock for the bounded refresh and three bounded security calls, whose sum is under the 60 s takeover age", async () => {
    const run = setup("keychain", { seed: false });
    const keychain = fakeKeychain();
    const underLock: string[] = [];
    const store = createKeychainStore({
      run: (command, args) => {
        if (
          existsSync(run.lockDirectory) &&
          readdirSync(run.lockDirectory).length > 0
        ) {
          underLock.push(String(args[0]));
        }
        return keychain.run(command, args);
      },
    });
    store.write(SERVER, PROJECT, "mcp", run.record);

    await run.source({ store }).accessToken();

    expect(run.provider.refreshes).toHaveLength(1);
    expect(underLock).toEqual([
      "find-generic-password",
      "delete-generic-password",
      "add-generic-password",
    ]);
    expect(
      underLock.length * KEYCHAIN_COMMAND_TIMEOUT_MS + REFRESH_TIMEOUT_MS,
    ).toBeLessThan(LOCK_STALE_AFTER_MS);
  });
});

describe.each(["file", "keychain"] as const)(
  "a token source over the %s store",
  (kind) => {
    test("refreshes with the stored client id, and stores the rotated token before accessToken() resolves", async () => {
      const run = setup(kind);
      const events: string[] = [];
      const watched: CredentialStore = {
        ...run.store,
        write: (...args) => {
          events.push("write");
          run.store.write(...args);
        },
      };

      const token = await run
        .source({ store: watched })
        .accessToken()
        .then((value) => {
          events.push("resolved");
          return value;
        });

      expect(run.provider.refreshes).toEqual([
        {
          clientId: CLIENT_ID,
          refreshToken: run.first,
          resource: run.resource,
        },
      ]);
      expect(events).toEqual(["write", "resolved"]);
      const stored = run.store.read(SERVER, PROJECT, "mcp");
      expect(stored?.refreshToken).not.toBe(run.first);
      expect({ ...stored, refreshToken: run.first }).toEqual(run.record);
      expect(run.provider.accepts(token, run.resource)).toBe(true);
      expect(readdirSync(run.lockDirectory)).toEqual([]);
    });

    test("refreshes the api audience's credential with the api resource", async () => {
      const run = setup(kind, { audience: "api" });

      const token = await run.source().accessToken();

      expect(run.provider.refreshes[0]?.resource).toBe(`${SERVER}/api/v1`);
      expect(run.provider.accepts(token, `${SERVER}/api/v1`)).toBe(true);
    });

    test("answers from memory until 60 s before the token expires, then refreshes", async () => {
      const run = setup(kind);
      let now = 1_000_000;
      const source = run.source({ now: () => now });

      const first = await source.accessToken();
      now += 900_000 - EXPIRY_MARGIN_MS - 1;
      const same = await source.accessToken();
      now += 1;
      const next = await source.accessToken();

      expect(same).toBe(first);
      expect(next).not.toBe(first);
      expect(run.provider.refreshes).toHaveLength(2);
    });

    /**
     * Ruling 102: the server refused the kept access token (an HTTP 401)
     * before it expired. Forgotten, the next call refreshes, under the lock,
     * with the refresh token then stored.
     */
    test("after forgetAccessToken(), the next call refreshes though the kept token has not expired, and calls made meanwhile share that refresh", async () => {
      const run = setup(kind);
      const now = 1_000_000;
      const source = run.source({ now: () => now });

      const first = await source.accessToken();
      expect(await source.accessToken()).toBe(first);
      const stored = run.store.read(SERVER, PROJECT, "mcp")?.refreshToken;
      source.forgetAccessToken?.();
      const [next, alongside] = await Promise.all([
        source.accessToken(),
        source.accessToken(),
      ]);

      expect(next).not.toBe(first);
      expect(alongside).toBe(next);
      expect(run.provider.refreshes).toHaveLength(2);
      expect(run.provider.refreshes[1]?.refreshToken).toBe(stored);
      expect(run.provider.accepts(next, run.resource)).toBe(true);
      expect(await source.accessToken()).toBe(next);
      expect(run.provider.refreshes).toHaveLength(2);
      expect(readdirSync(run.lockDirectory)).toEqual([]);
    });

    test("forgetAccessToken() while a refresh is under way: calls made meanwhile share it, and the token it issues is kept", async () => {
      const run = setup(kind);
      const now = 1_000_000;
      const source = run.source({ now: () => now });

      const pending = source.accessToken();
      source.forgetAccessToken?.();
      const alongside = source.accessToken();
      const [issued, shared] = await Promise.all([pending, alongside]);

      expect(shared).toBe(issued);
      expect(run.provider.refreshes).toHaveLength(1);
      expect(await source.accessToken()).toBe(issued);
      expect(run.provider.refreshes).toHaveLength(1);
    });

    test("makes one refresh for calls made while one is under way", async () => {
      const run = setup(kind);
      const source = run.source();

      const [one, two] = await Promise.all([
        source.accessToken(),
        source.accessToken(),
      ]);

      expect(one).toBe(two);
      expect(run.provider.refreshes).toHaveLength(1);
    });

    /**
     * Two sources over one store, both with no access token: what two
     * processes in one checkout are when both need a token at once. Each holds
     * the lock in turn and presents the refresh token current when it reads
     * under the lock, so the provider never sees one token twice, never
     * revokes the authorization, and both tokens work.
     */
    test("two sources take turns, each refreshing with the token then current", async () => {
      const run = setup(kind);

      const [one, two] = await Promise.all([
        run.source().accessToken(),
        run.source().accessToken(),
      ]);

      const presented = run.provider.refreshes.map((each) => each.refreshToken);
      expect(presented[0]).toBe(run.first);
      expect(new Set(presented).size).toBe(presented.length);
      expect(run.provider.mostInFlight()).toBe(1);
      expect(run.provider.familiesRevoked()).toBe(0);
      expect(run.provider.accepts(one, run.resource)).toBe(true);
      expect(run.provider.accepts(two, run.resource)).toBe(true);
    });

    test("takes the lock named for the origin, project and audience, 0600, holding its pid", async () => {
      const run = setup(kind);
      const expected = `${createHash("sha256")
        .update(JSON.stringify([SERVER, PROJECT, "mcp"]))
        .digest("hex")}.lock`;
      let seen: { mode: number; name: string[]; pid: unknown } | undefined;
      run.provider.hold = async () => {
        const name = readdirSync(run.lockDirectory);
        const path = join(run.lockDirectory, name[0] ?? "");
        seen = {
          mode: statSync(path).mode & 0o777,
          name,
          pid: JSON.parse(readFileSync(path, "utf8")).pid,
        };
      };

      await run.source().accessToken();

      expect(seen).toEqual({ mode: 0o600, name: [expected], pid: process.pid });
    });

    /**
     * Only the bounded refresh is ever made while holding the lock. Discovery
     * is made before it, so a slow discovery delays one process and never
     * holds the others.
     */
    test("discovers the token endpoint before it takes the lock", async () => {
      const run = setup(kind);
      let lockedDuringDiscovery: boolean | undefined;
      const fetch: FetchLike = (url, init) => {
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          lockedDuringDiscovery =
            existsSync(run.lockDirectory) &&
            readdirSync(run.lockDirectory).length > 0;
        }
        return run.provider.fetch(url, init);
      };

      await run.source({ fetch }).accessToken();

      expect(lockedDuringDiscovery).toBe(false);
    });

    test("with nothing stored, answers authorization required, naming the command, and asks nothing of the server", async () => {
      const run = setup(kind, { audience: "api", seed: false });

      const error = await thrownBy(() => run.source().accessToken());

      expect(error).toBeInstanceOf(AuthorizationRequiredError);
      expect((error as AuthorizationRequiredError).reason).toBe("missing");
      expect(String(error)).toMatch(/authorization required/iu);
      expect(String(error)).toContain("requestport login --for api");
      expect(String(error)).toContain(PROJECT);
      expect(String(error)).toContain(SERVER);
      expect(run.fetchCalls).toEqual([]);
    });

    /**
     * manifest-h.md §2.8.2, step 4: the provider will never honour it again,
     * so it is removed, and the person is told how to authorize again. No
     * retry: a second presentation of a refused token is the reuse that
     * revokes a whole authorization.
     */
    test("on invalid_grant clears the record, names the command, and does not retry", async () => {
      const run = setup(kind);
      run.store.write(SERVER, PROJECT, "mcp", {
        ...run.record,
        clientId: "client-the-token-was-not-issued-to",
      });

      const error = await thrownBy(() => run.source().accessToken());

      expect(error).toBeInstanceOf(AuthorizationRequiredError);
      expect((error as AuthorizationRequiredError).reason).toBe("refused");
      for (const named of [
        SERVER,
        PROJECT,
        "mcp",
        "requestport login --for mcp",
      ]) {
        expect(String(error)).toContain(named);
      }
      expect(run.provider.refreshes).toHaveLength(1);
      expect(run.store.read(SERVER, PROJECT, "mcp")).toBeUndefined();
      expect(readdirSync(run.lockDirectory)).toEqual([]);
      expectNoSecretIn(exposureOf(error), secretsOf(run));
    });

    test("keeps the record, and releases the lock, when the endpoint cannot be reached", async () => {
      const run = setup(kind);
      run.provider.hold = () =>
        Promise.reject(
          Object.assign(new TypeError(`fetch failed, holding ${run.first}`), {
            cause: { code: "ECONNREFUSED" },
          }),
        );

      const error = await thrownBy(() => run.source().accessToken());

      expect(error).toBeInstanceOf(TokenRefreshError);
      expect(String(error)).toContain(SERVER);
      expect(String(error)).toContain("ECONNREFUSED");
      expect(run.store.read(SERVER, PROJECT, "mcp")).toEqual(run.record);
      expect(readdirSync(run.lockDirectory)).toEqual([]);
      expectNoSecretIn(exposureOf(error), secretsOf(run));
    });

    test("keeps the record when the endpoint refuses for a reason other than invalid_grant", async () => {
      const run = setup(kind);
      const refusing: FetchLike = async (url, init) =>
        url.endsWith("/api/auth/oauth2/token")
          ? new Response(JSON.stringify({ error: "invalid_client" }), {
              status: 401,
            })
          : run.provider.fetch(url, init);

      const error = await thrownBy(() =>
        run.source({ fetch: refusing }).accessToken(),
      );

      expect(error).toBeInstanceOf(TokenRefreshError);
      expect(String(error)).toContain("invalid_client");
      expect(run.store.read(SERVER, PROJECT, "mcp")).toEqual(run.record);
    });

    /**
     * The refresh request is bounded (manifest-h.md §2.8.2, Revision 3). The
     * clock is faked, so the test does not wait 20 s; what is faked is only
     * when time passes. The abort is the same `setTimeout` production runs:
     * at 19,999 ms of the source's clock nothing has been given up, and at
     * 20,000 ms the request is aborted.
     */
    test("aborts a refresh the endpoint has not answered at 20 s, keeping the record and releasing the lock", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const run = setup(kind);
      let arrived = false;
      run.provider.hold = (_exchange, signal) => {
        arrived = true;
        return never(signal);
      };
      let settled = false;
      const outcome = run
        .source()
        .accessToken()
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS - 1);
      expect(arrived).toBe(true);
      expect(settled).toBe(false);
      expect(readdirSync(run.lockDirectory)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;

      expect(error).toBeInstanceOf(TokenRefreshError);
      expect(String(error)).toContain(SERVER);
      expect(String(error)).toMatch(/20 ?s/u);
      expect(run.store.read(SERVER, PROJECT, "mcp")).toEqual(run.record);
      expect(readdirSync(run.lockDirectory)).toEqual([]);
      expectNoSecretIn(exposureOf(error), secretsOf(run));
    });

    /**
     * The same, with a second source waiting on the lock meanwhile, as a
     * second process would. It never takes the lock over while the holder
     * runs (the lock is 20 s old when given up, its stale age 60 s), so the
     * endpoint never has two refreshes of one token in flight; once the
     * holder gives up, the waiter takes the lock and presents the token the
     * holder's aborted request never had answered.
     */
    test("a second source waiting meanwhile neither takes the lock over nor sends a refresh while the holder runs", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const run = setup(kind);
      let holding = true;
      let arrived!: () => void;
      const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      run.provider.hold = (_exchange, signal) => {
        if (!holding) return Promise.resolve();
        holding = false;
        arrived();
        return never(signal);
      };

      const held = run
        .source()
        .accessToken()
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await arrival;
      const [lockName] = readdirSync(run.lockDirectory);
      const lockFile = join(run.lockDirectory, lockName ?? "");
      const holder = JSON.parse(readFileSync(lockFile, "utf8")).nonce;
      const waited = run.source().accessToken();

      await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS - 1);
      expect(run.provider.refreshes).toHaveLength(1);
      expect(JSON.parse(readFileSync(lockFile, "utf8")).nonce).toBe(holder);

      await vi.advanceTimersByTimeAsync(1);
      expect(await held).toBeInstanceOf(TokenRefreshError);

      await vi.advanceTimersByTimeAsync(1_000);
      const token = await waited;

      expect(run.provider.refreshes.map((each) => each.refreshToken)).toEqual([
        run.first,
        run.first,
      ]);
      expect(run.provider.mostInFlightForOneToken()).toBe(1);
      expect(run.provider.familiesRevoked()).toBe(0);
      expect(run.provider.accepts(token, run.resource)).toBe(true);
    });

    /**
     * A waiter outlasts one holder's bounded refresh (30 s against 20 s), so
     * only a lock kept past the wait times a waiter out: here one written by
     * hand, naming this running process, as a holder suspended under the lock
     * would leave it.
     */
    test("waits 30 s for a lock a running holder keeps, then fails naming the lock, having sent no refresh", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const run = setup(kind);
      const lockFile = join(
        run.lockDirectory,
        `${createHash("sha256")
          .update(JSON.stringify([SERVER, PROJECT, "mcp"]))
          .digest("hex")}.lock`,
      );
      mkdirSync(run.lockDirectory, { recursive: true });
      writeFileSync(
        lockFile,
        `${JSON.stringify({ acquiredAt: new Date().toISOString(), nonce: "kept", pid: process.pid })}\n`,
      );

      const waiting = thrownBy(() => run.source().accessToken());
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);
      const error = await waiting;

      expect(error).toBeInstanceOf(LockTimeoutError);
      expect(String(error)).toContain(lockFile);
      expect(String(error)).toContain(String(process.pid));
      expect(run.provider.refreshes).toEqual([]);
      expect(run.store.read(SERVER, PROJECT, "mcp")).toEqual(run.record);
    });

    /**
     * A lock left behind by a holder that has exited (Done when 12b) is
     * taken over, where a running holder's is waited for until the wait
     * runs out (above): the source refreshes with the stored token, stores
     * the rotated one and gives the lock up.
     */
    test("takes over a lock whose holder is no longer running, and refreshes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const run = setup(kind);
      const lockFile = join(
        run.lockDirectory,
        `${createHash("sha256")
          .update(JSON.stringify([SERVER, PROJECT, "mcp"]))
          .digest("hex")}.lock`,
      );
      mkdirSync(run.lockDirectory, { recursive: true });
      writeFileSync(
        lockFile,
        `${JSON.stringify({ acquiredAt: new Date().toISOString(), nonce: "left-by-a-holder-that-exited", pid: NO_SUCH_PID })}\n`,
      );

      const outcome = run
        .source()
        .accessToken()
        .then(
          (token) => ({ token }),
          (error: unknown) => ({ error }),
        );
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);
      const result = await outcome;

      expect(result).toEqual({ token: expect.any(String) });
      const { token } = result as { token: string };
      expect(run.provider.accepts(token, run.resource)).toBe(true);
      expect(run.provider.refreshes.map((each) => each.refreshToken)).toEqual([
        run.first,
      ]);
      expect(run.store.read(SERVER, PROJECT, "mcp")?.refreshToken).not.toBe(
        run.first,
      );
      expect(readdirSync(run.lockDirectory)).toEqual([]);
    });
  },
);

/**
 * A record the client before version 2 stored can never be refreshed: it has
 * no client id. It is never presented; the person is told why they must
 * authorize again.
 */
describe("a credential stored by the client before version 2", () => {
  test("is never presented, from the file", async () => {
    const run = setup("file", { seed: false });
    const home = scratch();
    const store = createFileStore({ home });
    mkdirSync(join(home, ".requestport"), { recursive: true });
    writeFileSync(
      join(home, ".requestport", "credentials.json"),
      JSON.stringify({
        [SERVER]: {
          [PROJECT]: { obtained: OBTAINED, refreshToken: run.first },
        },
      }),
    );

    const error = await thrownBy(() => run.source({ store }).accessToken());

    expect(error).toBeInstanceOf(AuthorizationRequiredError);
    expect((error as AuthorizationRequiredError).reason).toBe("earlier-client");
    expect(String(error)).toMatch(/earlier client/u);
    expect(String(error)).toContain("requestport login --for mcp");
    expect(run.fetchCalls).toEqual([]);
    expectNoSecretIn(exposureOf(error), [run.first]);
  });

  test("is never presented, from the keychain", async () => {
    const run = setup("keychain", { seed: false });
    const keychain = fakeKeychain();
    keychain.entries.set(
      itemKey(`requestport:${SERVER}:${PROJECT}`, PROJECT),
      JSON.stringify({ obtained: OBTAINED, refreshToken: run.first }),
    );
    const store = createKeychainStore({ run: keychain.run });

    const error = await thrownBy(() => run.source({ store }).accessToken());

    expect((error as AuthorizationRequiredError).reason).toBe("earlier-client");
    expect(run.fetchCalls).toEqual([]);
  });
});
