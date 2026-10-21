import { operatorActor } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
} from "../../../test/api-v1/agent-client.js";
import { apiV1, resetApiV1Fakes } from "../../../test/api-v1/fake-database.js";

/*
  Plan 13, F.2.2's registry half: each agent administration form and
  `/api/v1` reach the same handler. Both run here for real — the form's
  action, the REST route, the real `server-core-commands.ts` bus and
  `createCoreCommandRegistry()` for suspension, and for the two revocations
  the real handlers (`@requestport/core`'s, which `server-agent-actions.ts`
  hands the forms) and the real key and grant services (`@requestport/core`'s
  too) — over B1's faked `@requestport/db`, so
  each ends at the same repository method, which records what it was handed.
  The form arrives as the signed-in person; REST as an operator credential,
  whose issuing member the rule is asked about, and whose own actor the
  write records.

  What the fake cannot show — the role rule, the version checks, the audit
  rows and receipts, the credential's re-check against its row — is proven on
  PostgreSQL: suspension and the reads in `packages/db`
  (`agent-repository.integration.test.ts`, `agent-reads.integration.test.ts`),
  the revocations through the real services in `packages/auth`
  (`agent-revocation.integration.test.ts`).

  Each read's one transaction is bound to the credential's organisation
  before its first statement (`withAdministrationReadTransaction`;
  manifest-i2.md §4 Owns, ruling 50). The fake records the organisation each
  was bound to, as `server-administration-reads.test.ts` reads it; that the
  helper binds, and what a binding admits, is held in `packages/db`
  (`tenant-context.test.ts`, `row-security.integration.test.ts`).
*/

vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../../test/api-v1/fake-database.js")).fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock(
  "../../../lib/observability.js",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../../lib/trigger-client.js",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../test/api-v1/fake-database.js")).fakeWiringModule,
);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const session = vi.hoisted(() => ({
  user: { id: "user_f22_person" },
  session: { id: "session_f22" },
}));
vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: {
      id: "018f0000-0000-7000-8000-00000000b101",
      name: "B1",
      role: "owner",
      slug: "b1",
    },
    session,
  }),
}));

const route = await import("../../api/v1/[[...path]]/route.js");
const actions = await import("./actions.js");
const api = restClient(route);

const projectId = "018f0000-0000-7000-8000-0000000f2211";
const otherProjectId = "018f0000-0000-7000-8000-0000000f2212";
const agentPrincipalId = "018f0000-0000-7000-8000-0000000f2213";
const credentialId = "018f0000-0000-7000-8000-0000000f2214";
const grantId = "018f0000-0000-7000-8000-0000000f2215";
const lineageId = "018f0000-0000-7000-8000-0000000f2216";
const operatorCredentialId = "018f0000-0000-7000-8000-0000000f2217";
const memberUserId = "user_f22_operator_member";
const idempotencyKey = "f22-transport-idempotency-0001";
const reason = "Suspended by the on-call script";

function operatorContext(
  options: { projectId?: string | null; scopes?: readonly string[] } = {},
) {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator" as const,
    organizationId: ids.organization,
    projectId: options.projectId ?? null,
    laneIds: new Set<string>(),
    scopes: new Set(options.scopes ?? ["agent:revoke"]),
    credentialId: operatorCredentialId,
    credentialFingerprint: "f22-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2218",
    authorizationId: operatorCredentialId,
  };
}

function signInAsOperator(options?: Parameters<typeof operatorContext>[0]) {
  const context = operatorContext(options);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

type Call = { method: string; args: unknown[] };

/**
 * The `agents` and `agentAuth` ports, recording what each method is handed.
 * The principal, key and grant all sit in `where` (the project P unless a
 * case says otherwise), and every rule the fake is asked answers yes.
 */
function recordPorts(where: string | null = projectId) {
  const calls: Call[] = [];
  const record =
    (method: string, answer: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answer(...args);
    };
  const principal = {
    id: agentPrincipalId,
    organizationId: ids.organization,
    projectId: where,
    displayName: "Deploy bot",
    slug: "deploy-bot",
    softwareName: null,
    status: "active",
    version: 1,
    createdByUserId: memberUserId,
    createdAt: new Date("2026-09-29T00:00:00.000Z"),
    updatedAt: new Date("2026-09-29T00:00:00.000Z"),
  };
  apiV1.ports.agents = {
    findPrincipal: record("findPrincipal", () => principal),
    canManage: record("canManage", () => true),
    setPrincipalStatus: record("setPrincipalStatus", (input) => ({
      principal: {
        ...principal,
        status: (input as { status: string }).status,
        version: 2,
      },
      previousStatus: "active",
    })),
  };
  apiV1.ports.agentAuth = {
    listCredentials: record("listCredentials", () => [
      {
        id: credentialId,
        issuedByGrantId: null,
        agentPrincipalId,
        name: "Deploy key",
        prefix: "rp_live",
        fingerprint: "f22-credential-fingerprint",
        audience: "api",
        projectId: where ?? projectId,
        laneIds: [],
        scopes: ["request:read"],
        version: 1,
        expiresAt: new Date("2026-10-29T00:00:00.000Z"),
        revokedAt: null,
        overlapExpiresAt: null,
        lastUsedAt: null,
        createdByUserId: memberUserId,
        createdAt: new Date("2026-09-29T00:00:00.000Z"),
      },
    ]),
    revokeCredential: record("revokeCredential", () => ({
      id: credentialId,
      revoked: true,
      version: 2,
    })),
    // As the repository does once the grant is locked, before it writes: the
    // grant's project is handed to the confinement the service passed, which
    // may refuse. Recorded only when it does not.
    revokeOAuthGrant: async (input: {
      requireGrantProject?: (project: string | null) => void;
    }) => {
      input.requireGrantProject?.(where);
      calls.push({ method: "revokeOAuthGrant", args: [input] });
      return { id: grantId, revoked: true, version: 2 };
    },
  };
  return calls;
}

const writes = ["setPrincipalStatus", "revokeCredential", "revokeOAuthGrant"];

function nothingWritten(calls: Call[]) {
  expect(calls.filter((call) => writes.includes(call.method))).toEqual([]);
}

function formData(fields: Record<string, string>) {
  const data = new FormData();
  data.set("agentPrincipalId", agentPrincipalId);
  data.set("expectedVersion", "1");
  data.set("idempotencyKey", idempotencyKey);
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** Each command, its form, and the fields each path sends. */
const cases = [
  {
    command: "set_agent_principal_status",
    action: "setAgentStatusAction",
    write: "setPrincipalStatus",
    form: { status: "suspended", reason },
    input: { agentPrincipalId, status: "suspended", reason },
  },
  {
    command: "revoke_agent_credential",
    action: "revokeAgentKeyAction",
    write: "revokeCredential",
    form: { credentialId },
    input: { agentPrincipalId, credentialId },
  },
  {
    command: "revoke_agent_oauth_grant",
    action: "revokeAgentOauthGrantAction",
    write: "revokeOAuthGrant",
    form: { grantId, reason: "The laptop holding it was lost" },
    input: {
      agentPrincipalId,
      grantId,
      reason: "The laptop holding it was lost",
    },
  },
] as const;

function post(
  command: string,
  input: Record<string, unknown>,
  expectedVersion = 1,
) {
  return api.command(command, { input, idempotencyKey, expectedVersion });
}

/** A call's first argument without the fields that name who acts, or when. */
function withoutWho(call: Call | undefined) {
  const {
    actor: _actor,
    actorUserId: _actorUserId,
    correlationId: _correlationId,
    requireGrantProject: _requireGrantProject,
    ...rest
  } = (call?.args[0] ?? {}) as Record<string, unknown>;
  return rest;
}

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

describe("the form and REST reach the same handler", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s: the form and an operator's POST end at the same repository method, each for its own member and recorded as its own actor",
    async (_, entry) => {
      const calls = recordPorts();
      const action = actions[entry.action] as (
        state: unknown,
        data: FormData,
      ) => Promise<{ status: string }>;
      const state = await action({ status: "idle" }, formData(entry.form));
      expect(state.status).toBe("success");
      const fromForm = [...calls];
      calls.length = 0;

      const context = signInAsOperator();
      const response = await post(entry.command, entry.input);
      expect(response.status).toBe(200);
      const fromRest = [...calls];

      // The same rule asked, then the same write, on each path.
      expect(fromRest.map((call) => call.method)).toEqual(
        fromForm.map((call) => call.method),
      );
      expect(fromForm.at(-1)?.method).toBe(entry.write);
      const manage = (calls: Call[]) =>
        calls.find((call) => call.method === "canManage")?.args[0];
      if (entry.write !== "revokeOAuthGrant") {
        // The grant's rule is the repository's, asked of `actorUserId`.
        expect(manage(fromForm)).toMatchObject({
          actor: { type: "user", id: session.user.id },
        });
        expect(manage(fromRest)).toMatchObject({
          actor: { type: "user", id: memberUserId },
        });
      }
      const write = (calls: Call[]) => calls.at(-1);
      if (entry.write === "setPrincipalStatus") {
        expect(write(fromForm)?.args[0]).toMatchObject({
          actor: { type: "user", id: session.user.id },
        });
        expect(write(fromRest)?.args[0]).toMatchObject({
          actor: context.actor,
          correlationId: context.correlationId,
        });
      } else {
        expect(write(fromForm)?.args[0]).toMatchObject({
          actorUserId: session.user.id,
          actor: { type: "user", id: session.user.id },
        });
        expect(write(fromRest)?.args[0]).toMatchObject({
          actorUserId: memberUserId,
          actor: context.actor,
          correlationId: context.correlationId,
        });
      }
      // What the write is told to do, beyond who acts, is the same, down to
      // the receipt's secret for the two revocations.
      expect(withoutWho(write(fromRest))).toEqual(withoutWho(write(fromForm)));
    },
  );
});

describe("REST refuses what the handler must never see", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an agent credential 403 before anything runs, even holding agent:manage",
    async (_, entry) => {
      const calls = recordPorts();
      signInAs(
        agentContext({ scopes: ["agent:manage", "agent:revoke", "org:read"] }),
      );
      const response = await post(entry.command, entry.input);
      expect(response.status).toBe(403);
      expect(apiV1.transactionsRun).toBe(0);
      expect(calls).toEqual([]);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator without agent:revoke 403, and writes nothing",
    async (_, entry) => {
      const calls = recordPorts();
      signInAsOperator({ scopes: ["project:read", "project:manage"] });
      const response = await post(entry.command, entry.input);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "forbidden",
      });
      nothingWritten(calls);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator whose credential is no longer current 403, before anything is read",
    async (_, entry) => {
      const calls = recordPorts();
      apiV1.ports.commandAuthorization = {
        assertCurrent: async () => {
          const { DomainError } = await import("@requestport/domain");
          throw new DomainError(
            "forbidden",
            "Current operator authorization is no longer active",
          );
        },
      };
      signInAsOperator();
      const response = await post(entry.command, entry.input);
      expect(response.status).toBe(403);
      expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
      expect(calls).toEqual([]);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s writes the credential's organisation over the one the caller names",
    async (_, entry) => {
      const calls = recordPorts();
      signInAsOperator();
      const response = await post(entry.command, {
        ...entry.input,
        organizationId: ids.otherOrganization,
      });
      expect(response.status).toBe(200);
      expect(calls.at(-1)?.args[0]).toMatchObject({
        organizationId: ids.organization,
      });
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator bound to another project 403, and writes nothing",
    async (_, entry) => {
      const calls = recordPorts(projectId);
      signInAsOperator({ projectId: otherProjectId });
      const response = await post(entry.command, entry.input);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "forbidden",
      });
      nothingWritten(calls);
    },
  );

  test.each(["active", "revoked"])(
    "set_agent_principal_status refuses an operator setting %s 403, before any port is asked",
    async (status) => {
      const calls = recordPorts();
      signInAsOperator();
      const response = await post("set_agent_principal_status", {
        agentPrincipalId,
        status,
        reason,
      });
      expect(response.status).toBe(403);
      expect(calls).toEqual([]);
    },
  );
});

describe("GET /api/v1/administration/agent-principals", () => {
  const listPath = ["administration", "agent-principals"];
  const getPath = ["administration", "agent-principals", agentPrincipalId];

  test("lists for an operator holding agent:revoke, in one transaction bound to its organisation, with its context", async () => {
    const context = signInAsOperator({ projectId });
    apiV1.administrationReads.agentPrincipals.mockResolvedValue([
      { id: agentPrincipalId, projectId, status: "active", version: 1 },
    ]);
    const response = await api.get(listPath);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { id: agentPrincipalId, projectId, status: "active", version: 1 },
    ]);
    expect(apiV1.administrationReads.agentPrincipals).toHaveBeenCalledWith(
      { fake: "transaction" },
      { context, operatorCredentials: undefined },
    );
    expect(apiV1.transactionsRun).toBe(1);
    // The one transaction is bound to the credential's organisation.
    expect(apiV1.readTransactionOrganizations).toEqual([
      context.organizationId,
    ]);
  });

  test("reads one for an operator holding agent:revoke, in one transaction bound to its organisation, with its context and the path's principal", async () => {
    const context = signInAsOperator();
    apiV1.administrationReads.agentPrincipal.mockResolvedValue({
      id: agentPrincipalId,
      status: "active",
      version: 1,
      credentials: [],
      oauthGrants: [],
    });
    const response = await api.get(getPath);
    expect(response.status).toBe(200);
    expect(apiV1.administrationReads.agentPrincipal).toHaveBeenCalledWith(
      { fake: "transaction" },
      { context, agentPrincipalId, operatorCredentials: undefined },
    );
    expect(apiV1.transactionsRun).toBe(1);
    expect(apiV1.readTransactionOrganizations).toEqual([
      context.organizationId,
    ]);
  });

  test("binds each read's transaction to the credential's organisation, never one the request names", async () => {
    apiV1.administrationReads.agentPrincipals.mockResolvedValue([]);
    apiV1.administrationReads.agentPrincipal.mockResolvedValue({
      id: agentPrincipalId,
    });
    for (const path of [listPath, getPath]) {
      const context = signInAsOperator();
      apiV1.readTransactionOrganizations = [];
      const response = await api.get(
        path,
        `?organizationId=${ids.otherOrganization}`,
      );
      expect(response.status, path.join("/")).toBe(200);
      expect(apiV1.readTransactionOrganizations, path.join("/")).toEqual([
        context.organizationId,
      ]);
    }
  });

  test("refuses an agent credential 403, even holding agent:manage, reading nothing", async () => {
    for (const path of [listPath, getPath]) {
      signInAs(agentContext({ scopes: ["agent:manage", "agent:revoke"] }));
      const response = await api.get(path);
      expect(response.status, path.join("/")).toBe(403);
    }
    expect(apiV1.administrationReads.agentPrincipals).not.toHaveBeenCalled();
    expect(apiV1.administrationReads.agentPrincipal).not.toHaveBeenCalled();
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test("refuses an operator without agent:revoke 403, reading nothing", async () => {
    for (const path of [listPath, getPath]) {
      signInAsOperator({ scopes: ["project:read", "org:read"] });
      const response = await api.get(path);
      expect(response.status, path.join("/")).toBe(403);
    }
    expect(apiV1.administrationReads.agentPrincipals).not.toHaveBeenCalled();
    expect(apiV1.administrationReads.agentPrincipal).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test.each([
    ["forbidden", 403],
    ["not_found", 404],
  ] as const)("answers each read's %s as %i", async (code, status) => {
    const { DomainError } = await import("@requestport/domain");
    for (const [path, read] of [
      [listPath, apiV1.administrationReads.agentPrincipals],
      [getPath, apiV1.administrationReads.agentPrincipal],
    ] as const) {
      signInAsOperator();
      read.mockRejectedValue(new DomainError(code, "refused by the read"));
      const response = await api.get(path);
      expect(response.status, path.join("/")).toBe(status);
    }
  });

  test("a path beside the reads' is refused 403, reading nothing", async () => {
    for (const parts of [
      ["administration", "agent-principals", agentPrincipalId, "credentials"],
      ["administration", "agent-principals", ""],
      ["administration", "agent-principal"],
    ]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(403);
    }
    expect(apiV1.administrationReads.agentPrincipals).not.toHaveBeenCalled();
    expect(apiV1.administrationReads.agentPrincipal).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });
});
