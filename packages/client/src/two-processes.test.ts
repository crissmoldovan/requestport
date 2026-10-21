import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createFileStore, resourceFor } from "./credentials.js";
import { type ChildResult, startChild } from "./test-support/children.js";
import {
  delay,
  never,
  serveFakeProvider,
} from "./test-support/fake-provider.js";

/**
 * What only more than one process can show: that a lock between processes is
 * taken. Each child is a real Node process running this package's sources
 * (`test-support/child.mjs`). Generous timeouts, because a child's start is
 * slow on a loaded machine and nothing here asserts a duration.
 */
const PROCESS_TIMEOUT_MS = 60_000;

const SERVER = "http://127.0.0.1:3000";
const PROJECT = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const directories: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-processes-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { force: true, recursive: true });
  }
});

/**
 * Every credential on the machine is in one file, and each write reads it,
 * changes one entry and writes the whole file back. Two processes doing that
 * at once, for two audiences, would each write back a copy that lacks the
 * other's latest record; a rotation lost that way leaves a rotated, dead
 * refresh token on disk.
 */
describe("two processes writing the credential file", () => {
  test(
    "lose neither one's records, writing two audiences at once",
    async () => {
      const home = scratch();
      const go = join(scratch(), "go");
      const input = {
        count: 150,
        go,
        home,
        projectId: PROJECT,
        server: SERVER,
      };
      const mcp = startChild("write-many", { ...input, audience: "mcp" });
      const api = startChild("write-many", { ...input, audience: "api" });

      await mcp.line((line) => line.ready === true);
      await api.line((line) => line.ready === true);
      writeFileSync(go, "");
      const [first, second] = await Promise.all([mcp.exited, api.exited]);

      expect([first.code, second.code], first.stderr + second.stderr).toEqual([
        0, 0,
      ]);
      expect(first.lines.at(-1)).toEqual({ lost: 0 });
      expect(second.lines.at(-1)).toEqual({ lost: 0 });

      const store = createFileStore({ home });
      expect(store.read(SERVER, PROJECT, "mcp")?.refreshToken).toBe("mcp-149");
      expect(store.read(SERVER, PROJECT, "api")?.refreshToken).toBe("api-149");
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "a write waits for the process holding the writers' lock",
    async () => {
      const home = scratch();
      const holder = startChild("hold-file-lock", { holdMs: 400, home });
      await holder.line((line) => line.held === true);

      createFileStore({ home }).write(SERVER, PROJECT, "mcp", {
        audience: "mcp",
        clientId: "client-mcp",
        obtained: "2026-10-01T00:00:00.000Z",
        refreshToken: "written-after-the-holder",
        resource: resourceFor(SERVER, "mcp"),
        version: 2,
      });
      const written = Date.now();
      const { code, lines } = await holder.exited;

      expect(code).toBe(0);
      const releasedAt = lines.find((line) => "releasedAt" in line)?.releasedAt;
      expect(written).toBeGreaterThanOrEqual(releasedAt as number);
      expect(
        createFileStore({ home }).read(SERVER, PROJECT, "mcp")?.refreshToken,
      ).toBe("written-after-the-holder");
    },
    PROCESS_TIMEOUT_MS,
  );
});

/**
 * manifest-h.md §2.8.2 and Done when 12b: two token sources in two processes
 * over one file store, both needing an access token at once (each starts
 * with none, which is the state an expired one leaves). The server is the
 * fake provider on a loopback socket, and it revokes the whole authorization
 * when a spent refresh token is presented, as the real one does.
 *
 * Each process refreshes once: an access token is kept only in memory, so
 * the second cannot use the first's. What the lock decides is which token
 * each presents. Under it, the second reads the credential after the first
 * has written the rotated token, so the token both started with reaches the
 * server once, no token reaches it twice, and both end holding a token the
 * server honours. Without it (the control, below), both present the token
 * they started with and the server revokes the authorization.
 */
describe("two processes refreshing one stored credential", () => {
  async function race(options: { shareLock: boolean }): Promise<{
    first: string;
    results: ChildResult[];
    served: Awaited<ReturnType<typeof serveFakeProvider>>;
    home: string;
  }> {
    const served = await serveFakeProvider();
    const { provider } = served;
    const server = provider.issuer;
    const resource = resourceFor(server, "api");
    const home = scratch();
    const go = join(scratch(), "go");
    const first = provider.authorize({
      clientId: "client-api",
      projectId: PROJECT,
      resource,
    });
    createFileStore({ home }).write(server, PROJECT, "api", {
      audience: "api",
      clientId: "client-api",
      obtained: "2026-10-01T00:00:00.000Z",
      refreshToken: first,
      resource,
      version: 2,
    });

    if (options.shareLock) {
      // Slow, so that two refreshes the lock failed to separate would
      // overlap at the server.
      provider.hold = (_exchange, signal) => delay(300, signal);
    } else {
      // The first presentation of the starting token is held until the
      // second arrives, so the control does not depend on timing.
      let arrivals = 0;
      let bothArrived!: () => void;
      const together = new Promise<void>((resolve) => {
        bothArrived = resolve;
      });
      provider.hold = async (exchange, signal) => {
        if (exchange.refreshToken !== first) return;
        arrivals += 1;
        if (arrivals === 2) bothArrived();
        await Promise.race([together, never(signal)]);
      };
    }

    const lockFor = (index: number) =>
      join(scratch(), options.shareLock ? "shared" : `own-${index}`);
    const shared = lockFor(0);
    const children = [0, 1].map((index) =>
      startChild("access-token", {
        audience: "api",
        go,
        home,
        lockDirectory: options.shareLock ? shared : lockFor(index),
        projectId: PROJECT,
        server,
      }),
    );
    for (const child of children)
      await child.line((line) => line.ready === true);
    writeFileSync(go, "");
    const results = await Promise.all(children.map((child) => child.exited));

    return { first, home, results, served };
  }

  test(
    "under the lock, present the stored token once and never one twice, and both end with a token the server honours",
    async () => {
      const { first, home, results, served } = await race({ shareLock: true });
      const { provider } = served;
      try {
        const reports = results.map((result) => result.lines.at(-1));
        expect(
          results.map((result) => result.code),
          results.map((result) => result.stderr).join(""),
        ).toEqual([0, 0]);
        expect(reports.map((report) => report?.whoami)).toEqual([200, 200]);

        const presented = provider.refreshes.map((each) => each.refreshToken);
        expect(presented).toHaveLength(2);
        expect(presented.filter((token) => token === first)).toHaveLength(1);
        expect(new Set(presented).size).toBe(2);
        expect(provider.mostInFlight()).toBe(1);
        expect(provider.familiesRevoked()).toBe(0);

        for (const report of reports) {
          expect(
            provider.accepts(
              String(report?.accessToken),
              `${provider.issuer}/api/v1`,
            ),
          ).toBe(true);
        }
        const stored = createFileStore({ home }).read(
          provider.issuer,
          PROJECT,
          "api",
        );
        expect(presented).not.toContain(stored?.refreshToken);
      } finally {
        await served.close();
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "without a shared lock (the control), present the stored token twice, and the server revokes the authorization",
    async () => {
      const { first, results, served } = await race({ shareLock: false });
      const { provider } = served;
      try {
        expect(results.map((result) => result.code)).toEqual([0, 0]);
        const presented = provider.refreshes.map((each) => each.refreshToken);
        expect(presented.filter((token) => token === first)).toHaveLength(2);
        expect(provider.familiesRevoked()).toBe(1);

        const reports = results.map((result) => result.lines.at(-1));
        expect(reports.filter((report) => report?.whoami === 200)).toEqual([]);
        expect(
          reports.some(
            (report) => report?.error === "AuthorizationRequiredError",
          ),
        ).toBe(true);
      } finally {
        await served.close();
      }
    },
    PROCESS_TIMEOUT_MS,
  );
});
