import { DomainError, operatorActor } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
} from "../test/api-v1/agent-client.js";
import {
  apiV1,
  fakeServerEnv,
  resetApiV1Fakes,
} from "../test/api-v1/fake-database.js";

/*
  F.2.0b's three shared administration reads through REST (Plan 13;
  `manifest-f2.md` §4.1): `GET /api/v1/administration/projects`, `/lanes` and
  `/members`, each a registry entry plus one line in `administrationReads`.

  The route runs for real over B1's faked `@requestport/db`, so what is held
  here is the dispatch: who is admitted, what the read is handed, and that
  F.3's re-check runs first, in the read's own transaction. What the
  repository reads, and whom `assertCurrent` refuses on PostgreSQL, is held by
  `packages/db/src/queries/administration/organization-reads.integration.test.ts`,
  which runs each read the way the lines below run it.

  That transaction is bound to the credential's organisation before its first
  statement (`withAdministrationReadTransaction`; manifest-i2.md §4 Owns,
  ruling 50). The fake records the organisation each one was bound to; that
  the binding is applied, and what it admits, is held in `packages/db`
  (`tenant-context.test.ts`, `row-security.integration.test.ts`).
*/

const authorizationOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("@requestport/db", async () => {
  const { fakeDatabaseModule } = await import(
    "../test/api-v1/fake-database.js"
  );
  return {
    ...fakeDatabaseModule,
    createCommandAuthorizationRepository: (
      database: unknown,
      options: unknown,
    ) => {
      authorizationOptions.push({ database, options });
      return fakeDatabaseModule.createCommandAuthorizationRepository();
    },
  };
});
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../test/api-v1/fake-database.js")).fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../test/api-v1/fake-database.js")).fakeServerConfigModule,
);
vi.mock(
  "./observability.js",
  async () =>
    (await import("../test/api-v1/fake-database.js")).fakeObservabilityModule,
);
vi.mock(
  "./trigger-client.js",
  async () =>
    (await import("../test/api-v1/fake-database.js")).fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../test/api-v1/fake-database.js")).fakeWiringModule,
);

const route = await import("../app/api/v1/[[...path]]/route.js");
const { administrationReads } = await import(
  "./server-administration-reads.js"
);
const api = restClient(route);

const lineageId = "018f0000-0000-7000-8000-0000000f2b01";
const credentialId = "018f0000-0000-7000-8000-0000000f2b02";
const memberUserId = "user_f2_0b_member";
const otherProject = "018f0000-0000-7000-8000-0000000f2b03";

function signInAsOperator(
  projectId: string | null = null,
  scopes: readonly string[] = ["project:read", "org:read"],
) {
  const context = {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator" as const,
    organizationId: ids.organization,
    projectId,
    laneIds: new Set<string>(),
    scopes: new Set(scopes),
    credentialId,
    credentialFingerprint: "f2-0b-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2b04",
    authorizationId: credentialId,
  };
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** Each shared read: its path, its scope and the repository function it calls. */
const reads = [
  {
    name: "list_administration_projects",
    parts: ["administration", "projects"],
    scope: "project:read",
    method: "listAdministrationProjects",
  },
  {
    name: "list_administration_lanes",
    parts: ["administration", "lanes"],
    scope: "project:read",
    method: "listAdministrationLanes",
  },
  {
    name: "list_administration_members",
    parts: ["administration", "members"],
    scope: "org:read",
    method: "listAdministrationMembers",
  },
] as const;

/** The calls each repository read received, in order. */
let received: Record<string, unknown[][]>;

function answering(method: string, answer: () => unknown) {
  apiV1.ports.administrationReads = {
    ...apiV1.ports.administrationReads,
    [method]: async (...args: never[]) => {
      received[method] = [...(received[method] ?? []), args];
      return answer();
    },
  };
}

function nothingRan() {
  expect(apiV1.portCalls).toEqual([]);
  expect(apiV1.transactionsRun).toBe(0);
  expect(apiV1.readTransactionOrganizations).toEqual([]);
  expect(authorizationOptions).toEqual([]);
}

beforeEach(() => {
  resetApiV1Fakes();
  authorizationOptions.length = 0;
  received = {};
  delete (fakeServerEnv as Record<string, unknown>)
    .REQUESTPORT_OPERATOR_CREDENTIALS;
  for (const read of reads)
    answering(read.method, () => [{ answeredBy: read.method }]);
});

describe("the dispatch map", () => {
  test("holds one line for each of the three shared reads", () => {
    for (const read of reads)
      expect(Object.hasOwn(administrationReads, read.name), read.name).toBe(
        true,
      );
  });
});

describe.each(reads)("$name", (read) => {
  test("answers an organisation-wide operator holding its scope, after F.3's re-check, in one transaction", async () => {
    signInAsOperator(null, [read.scope]);
    const response = await api.get(read.parts);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { answeredBy: read.method },
    ]);
    expect(apiV1.transactionsRun).toBe(1);
    // The one transaction is bound to the credential's organisation.
    expect(apiV1.readTransactionOrganizations).toEqual([ids.organization]);
    expect(apiV1.portCalls).toEqual([
      "commandAuthorization.assertCurrent",
      `administrationReads.${read.method}`,
    ]);
    const [transaction, input] = received[read.method]?.[0] ?? [];
    // The re-check and the read share the transaction.
    expect(authorizationOptions).toEqual([
      { database: transaction, options: { operatorCredentials: undefined } },
    ]);
    expect(input).toEqual({
      memberUserId,
      organizationId: ids.organization,
      credentialProjectId: null,
      ...(read.method === "listAdministrationLanes" ? { projectId: null } : {}),
    });
  });

  test("hands the re-check the deployment's switch as it is set", async () => {
    (
      fakeServerEnv as Record<string, unknown>
    ).REQUESTPORT_OPERATOR_CREDENTIALS = "enabled";
    signInAsOperator();
    expect((await api.get(read.parts)).status).toBe(200);
    expect(authorizationOptions).toMatchObject([
      { options: { operatorCredentials: "enabled" } },
    ]);
  });

  test("hands a project-bound operator's project to the read as the credential's", async () => {
    signInAsOperator(ids.project);
    expect((await api.get(read.parts)).status).toBe(200);
    expect(received[read.method]?.[0]?.[1]).toMatchObject({
      credentialProjectId: ids.project,
    });
  });

  test("hands the read the credential's organisation and the operator's member, never an id the request names or the operator's actor id", async () => {
    signInAsOperator();
    const response = await api.get(
      read.parts,
      `?organizationId=${ids.otherOrganization}&memberUserId=someone-else&credentialProjectId=${otherProject}`,
    );
    expect(response.status).toBe(200);
    const input = received[read.method]?.[0]?.[1];
    expect(input).toMatchObject({
      memberUserId,
      organizationId: ids.organization,
      credentialProjectId: null,
    });
    expect(JSON.stringify(input)).not.toContain("operator:");
    expect(JSON.stringify(input)).not.toContain(ids.otherOrganization);
    // And the transaction is bound to the credential's organisation, never
    // to one the request names.
    expect(apiV1.readTransactionOrganizations).toEqual([ids.organization]);
  });

  test.each([
    ["a project-bound", ids.project],
    ["a projectless", null],
  ] as const)(
    "refuses %s agent credential holding its scope with 403, having read nothing",
    async (_kind, projectId) => {
      signInAs(agentContext({ projectId, scopes: [read.scope] }));
      const response = await api.get(read.parts);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "forbidden",
      });
      nothingRan();
    },
  );

  test("refuses an operator without its scope with 403, having read nothing", async () => {
    signInAsOperator(null, ["operator:revoke"]);
    const response = await api.get(read.parts);
    expect(response.status).toBe(403);
    nothingRan();
  });

  test("refuses an operator revoked or expired after authentication with 403: the re-check refuses, and the read never runs", async () => {
    signInAsOperator();
    apiV1.ports.commandAuthorization = {
      assertCurrent: async () => {
        throw new DomainError(
          "forbidden",
          "Current operator authorization is no longer active",
        );
      },
    };
    const response = await api.get(read.parts);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
    });
    expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
    expect(received[read.method]).toBeUndefined();
  });

  test("answers the repository's refusal as it is: forbidden 403, not_found 404", async () => {
    for (const [code, status] of [
      ["forbidden", 403],
      ["not_found", 404],
    ] as const) {
      resetApiV1Fakes();
      answering(read.method, () => {
        throw new DomainError(code, "refused by the repository");
      });
      signInAsOperator();
      const response = await api.get(read.parts);
      expect(response.status, code).toBe(status);
    }
  });

  test("an extra segment is no entry's path, and is refused 403 having read nothing", async () => {
    signInAsOperator();
    const response = await api.get([...read.parts, otherProject]);
    expect(response.status).toBe(403);
    nothingRan();
  });
});

describe("list_administration_lanes and its projectId", () => {
  test("hands the query's projectId to the read, which decides whether it is the organisation's", async () => {
    signInAsOperator();
    const response = await api.get(
      ["administration", "lanes"],
      `?projectId=${otherProject}`,
    );
    expect(response.status).toBe(200);
    expect(received.listAdministrationLanes?.[0]?.[1]).toEqual({
      memberUserId,
      organizationId: ids.organization,
      credentialProjectId: null,
      projectId: otherProject,
    });
  });

  test("another organisation's project is refused: the read's not_found is a 404", async () => {
    answering("listAdministrationLanes", () => {
      throw new DomainError("not_found", "Project was not found");
    });
    signInAsOperator();
    const response = await api.get(
      ["administration", "lanes"],
      `?projectId=${otherProject}`,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });
});

describe("get_administration_project_settings", () => {
  test("reads in one transaction bound to the credential's organisation, never one the request names", async () => {
    const context = signInAsOperator(ids.project, ["project:manage"]);
    apiV1.administrationReads.projectSettings.mockResolvedValue({
      id: ids.project,
      version: 1,
    });
    const response = await api.get(
      ["administration", "projects", ids.project, "settings"],
      `?organizationId=${ids.otherOrganization}`,
    );
    expect(response.status).toBe(200);
    expect(apiV1.transactionsRun).toBe(1);
    expect(apiV1.readTransactionOrganizations).toEqual([
      context.organizationId,
    ]);
    expect(apiV1.readTransactionOrganizations).not.toContain(
      ids.otherOrganization,
    );
  });
});
