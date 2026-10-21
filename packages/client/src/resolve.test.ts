import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  Audience,
  CredentialStore,
  StoredCredential,
} from "./credentials.js";
import { ProjectBindingError } from "./project.js";
import type { ResolvedConnection } from "./resolve.js";
import { resolveConnection, verifyConnection } from "./resolve.js";

/**
 * Narrow to the ready case, loudly.
 *
 * `status` is a discriminant precisely so that `source` cannot be read when
 * authorization is still required — the type is doing its job, and a test that
 * wants the ready branch has to say so.
 */
function ready(resolved: ResolvedConnection) {
  if (resolved.status !== "ready") {
    throw new Error(`expected a ready connection, got ${resolved.status}`);
  }
  return resolved;
}

const directories: string[] = [];
const PROJECT = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-3333-4444-555555555555";
const SERVER = "https://requestport.com";

function checkout(projectId = PROJECT): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-resolve-"));
  directories.push(root);
  mkdirSync(join(root, ".requestport"), { recursive: true });
  writeFileSync(
    join(root, ".requestport", "project.json"),
    JSON.stringify({
      organizationId: "c533d303-b467-421d-bb76-bef05608d496",
      projectId,
      projectSlug: "orchard",
      server: SERVER,
    }),
  );
  return root;
}

/** A store holding at most one record, answering only for its audience. */
function emptyStore(
  seed?: StoredCredential,
  reads: Array<[string, string, Audience]> = [],
): CredentialStore {
  let held = seed;
  return {
    clear() {
      held = undefined;
    },
    hasLegacyRecord() {
      return false;
    },
    read(server, projectId, audience) {
      reads.push([server, projectId, audience]);
      return held?.audience === audience ? held : undefined;
    },
    write(_server, _projectId, _audience, credential) {
      held = credential;
    },
  };
}

function storedFor(audience: Audience): StoredCredential {
  return {
    audience,
    clientId: "client-123",
    obtained: "2026-09-06T10:00:00.000Z",
    refreshToken: "refresh-token-must-not-leak",
    resource: `${SERVER}${audience === "mcp" ? "/mcp" : "/api/v1"}`,
    version: 2,
  };
}

const stored = storedFor("mcp");

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { force: true, recursive: true });
  }
});

/**
 * What an agent does before it can do anything else.
 *
 * The checkout says which project; the store or the environment says whether
 * this machine may act on it. Neither is asked to know the other's business,
 * which is why the two can live in different places with different lifetimes.
 */
describe("resolving a connection", () => {
  test("asks for authorization when nothing is stored", () => {
    const resolved = resolveConnection({
      environment: {},
      from: checkout(),
      store: emptyStore(),
    });

    expect(resolved.status).toBe("authorization-required");
    expect(resolved.server).toBe(SERVER);
    expect(resolved.projectId).toBe(PROJECT);
  });

  test("is ready when the store holds this project's mcp credential", () => {
    const reads: Array<[string, string, Audience]> = [];
    const resolved = resolveConnection({
      environment: {},
      from: checkout(),
      store: emptyStore(stored, reads),
    });

    expect(ready(resolved).source).toBe("store");
    expect(reads).toEqual([[SERVER, PROJECT, "mcp"]]);
  });

  /**
   * The resolver exists to connect an agent to `/mcp`, and a token for the
   * `api` audience is refused there, so an `api` credential is not one it
   * can use (manifest-h.md §2.8.2).
   */
  test("asks for authorization when only an api credential is stored", () => {
    const resolved = resolveConnection({
      environment: {},
      from: checkout(),
      store: emptyStore(storedFor("api")),
    });

    expect(resolved.status).toBe("authorization-required");
  });

  /**
   * CI is the one place a shared credential belongs, and it must win — a
   * runner that also happened to have a stale developer credential in its
   * image should still use the secret it was given.
   */
  test("prefers the CI credential over anything stored", () => {
    const resolved = resolveConnection({
      environment: { REQUESTPORT_AGENT_TOKEN: "ci-token" },
      from: checkout(),
      store: emptyStore(stored),
    });

    expect(ready(resolved).source).toBe("environment");
  });

  test("refuses a checkout with no binding, naming the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "requestport-bare-"));
    directories.push(root);

    expect(() =>
      resolveConnection({ environment: {}, from: root, store: emptyStore() }),
    ).toThrow(ProjectBindingError);
  });

  test("never puts a credential in what it returns", () => {
    const resolved = resolveConnection({
      environment: { REQUESTPORT_AGENT_TOKEN: "ci-token-must-not-leak" },
      from: checkout(),
      store: emptyStore(stored),
    });

    const rendered = JSON.stringify(resolved);
    expect(rendered).not.toContain("ci-token-must-not-leak");
    expect(rendered).not.toContain("refresh-token-must-not-leak");
  });
});

/**
 * The moment the two halves check each other.
 *
 * A credential names one project and the checkout names another only when
 * something is wrong — a credential for the wrong project, a `.requestport`
 * copied between checkouts, a session that outlived a developer switching
 * work. Filing against the wrong project is silent; refusing is not.
 */
describe("verifying the connection against whoami", () => {
  test("accepts an identity that names the bound project", () => {
    const root = checkout();

    expect(() =>
      verifyConnection({ from: root, identity: { projectId: PROJECT } }),
    ).not.toThrow();
  });

  test("refuses an identity for another project, naming both", () => {
    const root = checkout();

    expect(() =>
      verifyConnection({ from: root, identity: { projectId: OTHER } }),
    ).toThrow(new RegExp(`${PROJECT}[\\s\\S]*${OTHER}`, "u"));
  });
});
