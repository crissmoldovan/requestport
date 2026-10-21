import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CredentialStoreError,
  createFileStore,
  type StoredCredential,
} from "@requestport/client/credentials";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createHoldingStore,
  HOLDING_PROJECT_ID,
  rekey,
} from "./holding-store.js";

const server = "https://rp.example";
const projectId = "018f0000-0000-7000-8000-00000000a001";

const record = (
  overrides: Partial<StoredCredential> = {},
): StoredCredential => ({
  audience: "mcp",
  clientId: "client-1",
  obtained: "2026-10-06T00:00:00.000Z",
  refreshToken: "refresh-1",
  resource: `${server}/mcp`,
  version: 2,
  ...overrides,
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "requestport-holding-store-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the holding store", () => {
  test("holds one record, under the placeholder, for its server and audience", () => {
    const holding = createHoldingStore(server, "mcp");

    expect(holding.read(server, HOLDING_PROJECT_ID, "mcp")).toBeUndefined();
    holding.write(server, HOLDING_PROJECT_ID, "mcp", record());
    expect(holding.read(`${server}/`, HOLDING_PROJECT_ID, "mcp")).toEqual(
      record(),
    );

    // A refresh's write replaces it, as the token source writes.
    holding.write(
      server,
      HOLDING_PROJECT_ID,
      "mcp",
      record({ refreshToken: "refresh-2" }),
    );
    expect(holding.held()?.refreshToken).toBe("refresh-2");

    holding.clear(server, HOLDING_PROJECT_ID, "mcp");
    expect(holding.held()).toBeUndefined();
  });

  test("refuses every other key, for every call", () => {
    const holding = createHoldingStore(server, "mcp");
    const others = [
      ["https://other.example", HOLDING_PROJECT_ID, "mcp"],
      ["http://rp.example", HOLDING_PROJECT_ID, "mcp"],
      [server, projectId, "mcp"],
      [server, HOLDING_PROJECT_ID, "api"],
    ] as const;

    for (const [keyServer, keyProject, keyAudience] of others) {
      expect(() =>
        holding.write(keyServer, keyProject, keyAudience, record()),
      ).toThrow(CredentialStoreError);
      expect(() => holding.read(keyServer, keyProject, keyAudience)).toThrow(
        CredentialStoreError,
      );
      expect(() => holding.clear(keyServer, keyProject, keyAudience)).toThrow(
        CredentialStoreError,
      );
    }
    expect(() => holding.hasLegacyRecord(server, projectId)).toThrow(
      CredentialStoreError,
    );
    expect(holding.held()).toBeUndefined();
  });

  test("refuses a record that is not its audience's on its server", () => {
    const holding = createHoldingStore(server, "mcp");

    for (const wrong of [
      record({ audience: "api" }),
      record({ resource: `${server}/api/v1` }),
      record({ resource: "https://other.example/mcp" }),
    ]) {
      expect(() =>
        holding.write(server, HOLDING_PROJECT_ID, "mcp", wrong),
      ).toThrow(CredentialStoreError);
    }
    expect(holding.held()).toBeUndefined();
  });

  test("holds no earlier client's record (ruling 103)", () => {
    expect(
      createHoldingStore(server, "api").hasLegacyRecord(
        server,
        HOLDING_PROJECT_ID,
      ),
    ).toBe(false);
  });
});

describe("the re-key", () => {
  test("writes the held record to the real store under the project named, and forgets it", () => {
    const holding = createHoldingStore(server, "mcp");
    const store = createFileStore({ home });
    holding.write(
      server,
      HOLDING_PROJECT_ID,
      "mcp",
      record({ refreshToken: "refresh-after-the-login-refresh" }),
    );

    rekey(holding, store, server, projectId);

    expect(store.read(server, projectId, "mcp")).toEqual(
      record({ refreshToken: "refresh-after-the-login-refresh" }),
    );
    expect(holding.held()).toBeUndefined();
    const file = readFileSync(
      join(home, ".requestport", "credentials.json"),
      "utf8",
    );
    expect(Object.keys(JSON.parse(file)[server])).toEqual([projectId]);
    expect(file).not.toContain(HOLDING_PROJECT_ID);
  });

  test("with nothing held, refuses and writes nothing", () => {
    const store = createFileStore({ home });

    expect(() =>
      rekey(createHoldingStore(server, "api"), store, server, projectId),
    ).toThrow(CredentialStoreError);
    expect(store.read(server, projectId, "api")).toBeUndefined();
  });
});
