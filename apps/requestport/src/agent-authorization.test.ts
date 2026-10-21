import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CredentialStore,
  createFileStore,
} from "@requestport/client/credentials";
import { AuthorizationRequiredError } from "@requestport/client/token-source";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  obtainAuthorization,
  ProjectMismatchError,
  storeAuthorization,
} from "./agent-authorization.js";
import { HOLDING_PROJECT_ID } from "./holding-store.js";
import {
  createFakeAuthorizationServer,
  FAKE_ORGANIZATION_ID,
  type FakeAuthorizationServer,
  fakeWhoami,
} from "./test-support/fake-authorization-server.js";

const projectA = "018f0000-0000-7000-8000-00000000a001";
const projectB = "018f0000-0000-7000-8000-00000000b001";

let home: string;
let scratch: string;
let store: CredentialStore;
let server: FakeAuthorizationServer;
let urls: string[];
let asked: ReturnType<typeof fakeWhoami>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "requestport-agent-authorization-home-"));
  scratch = mkdtempSync(join(tmpdir(), "requestport-agent-authorization-tmp-"));
  store = createFileStore({ home });
  server = createFakeAuthorizationServer();
  asked = fakeWhoami(server);
  urls = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const credentialFile = () =>
  JSON.parse(
    readFileSync(join(home, ".requestport", "credentials.json"), "utf8"),
  ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;

/** The person consents to the URL as soon as it is handed over. */
function consentingTo(projectId: string) {
  return (url: string) => {
    urls.push(url);
    server.consent(url, projectId);
  };
}

function options(audience: "mcp" | "api", projectId: string) {
  return {
    audience,
    fetch: server.fetch,
    onAuthorizationUrl: consentingTo(projectId),
    server: server.origin,
    startCallbackReceiver: () => server.startCallbackReceiver(),
    temporaryDirectory: scratch,
    whoami: asked.whoami,
  } as const;
}

describe("the holding-store flow", () => {
  test("api: whoami over REST names the project, and the record stored under it is the one after the refresh", async () => {
    const held = await obtainAuthorization(options("api", projectA));

    expect(held.identity).toEqual({
      organizationId: FAKE_ORGANIZATION_ID,
      projectId: projectA,
    });
    // Nothing reaches the real store until it is stored.
    expect(existsSync(join(home, ".requestport"))).toBe(false);

    storeAuthorization(held, store);

    const file = credentialFile();
    expect(Object.keys(file)).toEqual([server.origin]);
    expect(Object.keys(file[server.origin] ?? {})).toEqual([projectA]);
    const stored = store.read(server.origin, projectA, "api");
    expect(stored).toMatchObject({
      audience: "api",
      clientId: server.registrations[0],
      resource: `${server.origin}/api/v1`,
      version: 2,
    });
    // One refresh, by the login's own token source, with the code grant's
    // token; the stored one is the token that refresh issued, still live.
    expect(server.refreshes).toHaveLength(1);
    expect(stored?.refreshToken).not.toBe(server.refreshes[0]?.refreshToken);
    expect(server.grantOf(stored?.refreshToken ?? "")).toEqual({
      clientId: server.registrations[0],
      projectId: projectA,
      resource: `${server.origin}/api/v1`,
    });
    expect(JSON.stringify(file)).not.toContain(HOLDING_PROJECT_ID);
  });

  test("mcp: the record is stored for the mcp audience, under the project granted", async () => {
    const held = await obtainAuthorization(options("mcp", projectB));
    storeAuthorization(held, store);

    expect(store.read(server.origin, projectB, "mcp")).toMatchObject({
      audience: "mcp",
      clientId: server.registrations[0],
      resource: `${server.origin}/mcp`,
    });
    expect(store.read(server.origin, projectB, "api")).toBeUndefined();
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? "").searchParams.get("resource")).toBe(
      `${server.origin}/mcp`,
    );
  });

  test("the token source's lock directory is the call's own, and is gone when it returns", async () => {
    await obtainAuthorization(options("mcp", projectA));

    expect(asked.lockDirectories).toHaveLength(1);
    expect(asked.lockDirectories[0]?.startsWith(scratch)).toBe(true);
    expect(readdirSync(scratch)).toEqual([]);
    expect(existsSync(join(home, ".requestport"))).toBe(false);
  });

  test("a grant for another project than the one expected is refused, naming both, and the lock directory is still removed", async () => {
    const refusal = obtainAuthorization({
      ...options("api", projectB),
      expected: { namedBy: "--project", projectId: projectA },
    });

    await expect(refusal).rejects.toBeInstanceOf(ProjectMismatchError);
    await expect(refusal).rejects.toThrow(
      `The api grant is for project ${projectB}, but --project names project ${projectA}. Nothing was stored.`,
    );
    expect(readdirSync(scratch)).toEqual([]);
    expect(existsSync(join(home, ".requestport"))).toBe(false);
  });

  test("the expected project is accepted", async () => {
    const held = await obtainAuthorization({
      ...options("mcp", projectA),
      expected: { namedBy: "--project", projectId: projectA },
    });

    expect(held.identity.projectId).toBe(projectA);
  });

  test("the placeholder never reaches a message: a refused refresh names the project being granted", async () => {
    server.refuseRefreshes = true;
    const refusal = obtainAuthorization(options("api", projectA));

    await expect(refusal).rejects.toBeInstanceOf(AuthorizationRequiredError);
    const error = (await refusal.catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain(HOLDING_PROJECT_ID);
    expect(error.message).toContain("the project being granted");
    expect(error.message).toContain("requestport login --for api");
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("a grant that names no project is refused, with a project expected or without", async () => {
    const organizationWide = obtainAuthorization({
      ...options("mcp", projectA),
      whoami: async () => ({
        organizationId: FAKE_ORGANIZATION_ID,
        projectId: null,
      }),
    });
    await expect(organizationWide).rejects.toThrow(
      "The mcp grant names no project, and an agent credential is stored for a project. Nothing was stored.",
    );

    const expected = obtainAuthorization({
      ...options("mcp", projectA),
      expected: { namedBy: "--project", projectId: projectA },
      whoami: async () => ({
        organizationId: FAKE_ORGANIZATION_ID,
        projectId: null,
      }),
    });
    await expect(expected).rejects.toThrow(
      `The mcp grant names no project, but --project names project ${projectA}. Nothing was stored.`,
    );
    expect(readdirSync(scratch)).toEqual([]);
  });
});
