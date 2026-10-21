import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CommandResult,
  StoredCredential,
} from "@requestport/client/credentials";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  CREDENTIAL_STORE_VARIABLE,
  CredentialStoreChoiceError,
  commandCredentialStore,
  commandLockDirectory,
  credentialStoreChoice,
  homeDirectory,
} from "./credential-store.js";

const server = "https://rp.example";
const projectId = "018f0000-0000-7000-8000-000000000001";
const record: StoredCredential = {
  audience: "mcp",
  clientId: "client-1",
  obtained: "2026-10-06T00:00:00.000Z",
  refreshToken: "refresh-token-sentinel",
  resource: `${server}/mcp`,
  version: 2,
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "requestport-credential-store-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A `security` that records each call and answers as `answer` says. */
function fakeSecurity(answer: (args: readonly string[]) => CommandResult) {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    run: (command: string, args: readonly string[]): CommandResult => {
      calls.push([command, ...args]);
      return answer(args);
    },
  };
}

const refuseEverything = () =>
  fakeSecurity(() => {
    throw new Error("no keychain may be reached in this case");
  });

describe("the variable", () => {
  test("unset or empty is the automatic choice", () => {
    expect(credentialStoreChoice({})).toBe("auto");
    expect(credentialStoreChoice({ [CREDENTIAL_STORE_VARIABLE]: "" })).toBe(
      "auto",
    );
  });

  test("file and keychain are taken as they are", () => {
    expect(credentialStoreChoice({ [CREDENTIAL_STORE_VARIABLE]: "file" })).toBe(
      "file",
    );
    expect(
      credentialStoreChoice({ [CREDENTIAL_STORE_VARIABLE]: "keychain" }),
    ).toBe("keychain");
  });

  test("anything else is refused without repeating it", () => {
    const value = "postgres://owner:SENTINEL_PASSWORD@db.example/requestport";

    expect(() =>
      credentialStoreChoice({ [CREDENTIAL_STORE_VARIABLE]: value }),
    ).toThrow(CredentialStoreChoiceError);
    try {
      credentialStoreChoice({ [CREDENTIAL_STORE_VARIABLE]: value });
    } catch (error) {
      expect((error as Error).message).not.toContain("SENTINEL_PASSWORD");
      expect((error as Error).message).toContain(CREDENTIAL_STORE_VARIABLE);
    }
  });
});

describe("the home directory", () => {
  test("is HOME, or USERPROFILE on Windows, and the process's own when unset or empty", () => {
    expect(homeDirectory({ HOME: "/home/someone" }, "linux")).toBe(
      "/home/someone",
    );
    expect(
      homeDirectory(
        { HOME: "/ignored", USERPROFILE: "C:\\Users\\someone" },
        "win32",
      ),
    ).toBe("C:\\Users\\someone");
    expect(homeDirectory({ HOME: "" }, "darwin")).toBe(homedir());
    expect(homeDirectory({}, "linux")).toBe(homedir());
  });

  test("the token sources' locks are under it, where a token source given none keeps them", () => {
    expect(commandLockDirectory({ HOME: "/home/someone" }, "linux")).toBe(
      join("/home/someone", ".requestport", "locks"),
    );
    // With the process's own environment, the path a token source given no
    // lock directory uses (`token-source.ts`: `join(homedir(),
    // CREDENTIAL_DIRECTORY, "locks")`).
    expect(commandLockDirectory(process.env)).toBe(
      join(homedir(), ".requestport", "locks"),
    );
  });
});

describe("the store", () => {
  test("file: the file under the environment's home, and no keychain is asked", () => {
    const security = refuseEverything();
    const store = commandCredentialStore(
      { HOME: home, [CREDENTIAL_STORE_VARIABLE]: "file" },
      { platform: "darwin", run: security.run },
    );

    store.write(server, projectId, "mcp", record);

    const file = join(home, ".requestport", "credentials.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      [server]: { [projectId]: { mcp: record } },
    });
    expect(store.read(server, projectId, "mcp")).toEqual(record);
    expect(security.calls).toEqual([]);
  });

  test("keychain: the keychain store, whatever the platform says, and nothing under the home", () => {
    const security = fakeSecurity(() => ({
      status: 44,
      stderr: "",
      stdout: "",
    }));
    const store = commandCredentialStore(
      { HOME: home, [CREDENTIAL_STORE_VARIABLE]: "keychain" },
      { platform: "linux", run: security.run },
    );

    expect(store.read(server, projectId, "mcp")).toBeUndefined();
    expect(security.calls.length).toBeGreaterThan(0);
    expect(security.calls.every(([command]) => command === "security")).toBe(
      true,
    );
    expect(existsSync(join(home, ".requestport"))).toBe(false);
  });

  test("automatic: the file where there is no keychain", () => {
    const security = refuseEverything();
    const store = commandCredentialStore(
      { HOME: home },
      { platform: "linux", run: security.run },
    );

    store.write(server, projectId, "mcp", record);

    expect(existsSync(join(home, ".requestport", "credentials.json"))).toBe(
      true,
    );
    expect(security.calls).toEqual([]);
  });

  test("automatic: the keychain where `security list-keychains` answers", () => {
    const security = fakeSecurity((args) => ({
      status: args[0] === "list-keychains" ? 0 : 44,
      stderr: "",
      stdout: "",
    }));
    const store = commandCredentialStore(
      { HOME: home },
      { platform: "darwin", run: security.run },
    );

    expect(store.read(server, projectId, "mcp")).toBeUndefined();
    expect(security.calls[0]).toEqual([
      "security",
      "list-keychains",
      "-d",
      "user",
    ]);
    expect(security.calls.length).toBeGreaterThan(1);
    expect(existsSync(join(home, ".requestport"))).toBe(false);
  });

  test("a value it refuses is refused before any store is made", () => {
    const security = refuseEverything();

    expect(() =>
      commandCredentialStore(
        { HOME: home, [CREDENTIAL_STORE_VARIABLE]: "both" },
        { platform: "darwin", run: security.run },
      ),
    ).toThrow(CredentialStoreChoiceError);
    expect(security.calls).toEqual([]);
  });
});
