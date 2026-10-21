import {
  admitsCredentialKind,
  type Capability,
  capabilityRegistry,
  DomainError,
  operatorActor,
  restCommandTransports,
  restQueryTransports,
} from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
} from "../../../../test/api-v1/agent-client.js";
import {
  apiV1,
  resetApiV1Fakes,
} from "../../../../test/api-v1/fake-database.js";

/*
  Plan 13, F.3 (F3-12, ruling 25), Done when 2: REST admits an operator only
  where a capability's registry entry names "operator" in `credentialKinds`,
  for commands and reads alike, and answers 403 — never 500 — everywhere else,
  after authentication and before anything else runs. The cases iterate F.1's
  REST projections, not the bus's registry, so a new entry, or one an F.2
  group marks for operators, is covered without this file being edited.

  The route runs for real over B1's faked `@requestport/db`; authentication is
  replaced by the context `authenticateApiBearer` would build. Whether that
  context is still current is `assertCurrent`'s, proven on PostgreSQL in
  `command-authorization.operator.integration.test.ts`.
*/

vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock(
  "../../../../lib/observability.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../../../lib/trigger-client.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js")).fakeWiringModule,
);

const route = await import("./route.js");
const { administrationReads } = await import(
  "../../../../lib/server-administration-reads.js"
);
const { coreCommandBus } = await import(
  "../../../../lib/server-core-commands.js"
);
const api = restClient(route);

const lineageId = "018f0000-0000-7000-8000-0000000f3f01";
const credentialId = "018f0000-0000-7000-8000-0000000f3f02";
const targetId = "018f0000-0000-7000-8000-0000000f3f03";
const memberUserId = "user_f3_route_member";

function operatorContext(
  projectId: string | null = null,
  scopes: readonly string[] = ["operator:revoke"],
) {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator" as const,
    organizationId: ids.organization,
    projectId,
    laneIds: new Set<string>(),
    scopes: new Set(scopes),
    credentialId,
    credentialFingerprint: "f3-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f3f04",
    authorizationId: credentialId,
  };
}

function signInAsOperator(
  projectId: string | null = null,
  scopes?: readonly string[],
) {
  const context = operatorContext(projectId, scopes);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** A concrete path for a GET transport, with an id for each parameter. */
function partsOf(path: string) {
  return path
    .slice("/api/v1/".length)
    .split("/")
    .map((segment) =>
      segment.startsWith("{")
        ? "018f0000-0000-7000-8000-0000000f3f05"
        : segment,
    );
}

function nothingRan() {
  expect(apiV1.portCalls).toEqual([]);
  expect(apiV1.transactionsRun).toBe(0);
  for (const query of Object.values(apiV1.agentQueries))
    expect(query).not.toHaveBeenCalled();
  expect(apiV1.registerProject).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

describe("POST: an operator reaches only the commands whose entry admits it", () => {
  const refused = restCommandTransports.filter(
    (transport) => !admitsCredentialKind(transport, "operator"),
  );
  const admitted = restCommandTransports.filter((transport) =>
    admitsCredentialKind(transport, "operator"),
  );

  test("the registry admits operators to F.3's command, F.2.3's eleven, F.2.1's three, F.2.2's three, F.2.4's six, F.2.5's four, F.2.6's two and F.2.7's four", () => {
    expect(admitted.map((transport) => transport.name)).toEqual([
      "revoke_operator_credential",
      "add_project_alias",
      "add_project_repository",
      "set_default_project_repository",
      "set_project_repository_status",
      "add_project_lane",
      "set_default_project_lane",
      "set_project_lane_status",
      "set_project_member",
      "set_project_work_policy",
      "update_project_metadata",
      "set_project_status",
      "create_routing_rule",
      "update_routing_rule",
      "disable_routing_rule",
      "set_agent_principal_status",
      "revoke_agent_credential",
      "revoke_agent_oauth_grant",
      "requeue_outbox",
      "requeue_notification",
      "requeue_slack_operation",
      "requeue_import_dispatch",
      "create_retention_hold",
      "release_retention_hold",
      "set_slack_user_mapping",
      "set_slack_route",
      "set_slack_installation_status",
      "send_slack_connection_test",
      "review_legacy_import_entry",
      "split_legacy_import_entry",
      "invite_organization_member",
      "set_organization_member",
      "revoke_organization_invitation",
      "appearance.update_organization_defaults.v1",
    ]);
    expect(refused.length).toBeGreaterThan(30);
  });

  test.each(refused.map((transport) => [transport.name] as const))(
    "%s refuses an operator with 403 before anything runs",
    async (name) => {
      signInAsOperator();
      const execute = vi.spyOn(coreCommandBus, "execute");
      const response = await api.command(name, {
        input: { anything: "at all" },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "forbidden",
      });
      expect(execute).not.toHaveBeenCalled();
      nothingRan();
    },
  );

  test("revoke_operator_credential reaches the bus as the operator, bound to its own organisation", async () => {
    const context = signInAsOperator();
    const execute = vi
      .spyOn(coreCommandBus, "execute")
      .mockResolvedValue({ id: targetId, revoked: true, version: 2 });
    const response = await api.command("revoke_operator_credential", {
      input: {
        credentialId: targetId,
        organizationId: ids.otherOrganization,
      },
      idempotencyKey: "f3-route-revoke-idempotency-0001",
      expectedVersion: 1,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: { id: targetId, revoked: true, version: 2 },
    });
    expect(execute).toHaveBeenCalledWith({
      name: "revoke_operator_credential",
      input: { credentialId: targetId, organizationId: ids.organization },
      context,
      meta: {
        idempotencyKey: "f3-route-revoke-idempotency-0001",
        expectedVersion: 1,
      },
    });
  });

  test("revoke_operator_credential refuses an agent with 403 before anything runs", async () => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");
    const response = await api.command("revoke_operator_credential", {
      input: { credentialId: targetId },
      expectedVersion: 1,
    });
    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    nothingRan();
  });

  test("an unknown command is still 404 for an operator", async () => {
    signInAsOperator();
    const response = await api.command("not_a_command", { input: {} });
    expect(response.status).toBe(404);
    nothingRan();
  });
});

describe("GET: an operator reaches only the reads whose entry admits it", () => {
  const refused = restQueryTransports.filter(
    (transport) => !admitsCredentialKind(transport, "operator"),
  );

  test("the registry admits operators to whoami, F.2.0b's three administration reads, F.2.3's, F.2.1's three, F.2.2's two, F.2.4's two, F.2.5's, F.2.6's two and F.2.7's two", () => {
    expect(
      restQueryTransports
        .filter((transport) => admitsCredentialKind(transport, "operator"))
        .map((transport) => transport.path),
    ).toEqual([
      "/api/v1/whoami",
      "/api/v1/administration/projects",
      "/api/v1/administration/lanes",
      "/api/v1/administration/members",
      "/api/v1/administration/projects/{projectId}/settings",
      "/api/v1/administration/routing-rules",
      "/api/v1/administration/route-evaluations/test",
      "/api/v1/administration/route-evaluations/preview",
      "/api/v1/administration/agent-principals",
      "/api/v1/administration/agent-principals/{agentPrincipalId}",
      "/api/v1/administration/operations",
      "/api/v1/administration/retention-holds",
      "/api/v1/administration/slack",
      "/api/v1/administration/import-runs",
      "/api/v1/administration/import-runs/{runId}",
      "/api/v1/administration/invitations",
      "/api/v1/administration/appearance",
    ]);
  });

  /*
    The operator holds the read's own scope, so the entry's admission is the
    only thing that can refuse it: with the operator branch gone, a
    project-bound operator holding the scope would be read for by the agent
    path.
  */
  test.each(
    refused.map((transport) => [transport.path, transport.scope] as const),
  )(
    "%s refuses an operator with 403, never reading, even holding its scope",
    async (path, scope) => {
      for (const projectId of [null, ids.project]) {
        signInAsOperator(projectId, scope ? [scope] : []);
        const response = await api.get(partsOf(path));
        expect(response.status, String(projectId)).toBe(403);
        nothingRan();
      }
    },
  );

  test("whoami answers an organisation-wide operator from its own context, with no project and no work policy", async () => {
    signInAsOperator(null);
    const response = await api.get(["whoami"]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      actor: {
        type: "service",
        id: `operator:${lineageId}`,
        originatingActor: { type: "user", id: memberUserId },
      },
      credentialKind: "operator",
      organizationId: ids.organization,
      projectId: null,
      scopes: ["operator:revoke"],
      authorizationId: credentialId,
      serverSchemaVersion: 1,
    });
    nothingRan();
  });

  test("whoami names a project-bound operator's project", async () => {
    signInAsOperator(ids.project);
    const response = await api.get(["whoami"]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectId: ids.project,
    });
  });

  test("whoami still answers an agent from its work policy", async () => {
    signInAs(agentContext());
    apiV1.agentQueries.getAgentPolicy.mockResolvedValue({ policy: "b1" });
    const response = await api.get(["whoami"]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actor: { type: "agent" },
      workPolicy: { policy: "b1" },
    });
    expect(apiV1.agentQueries.getAgentPolicy).toHaveBeenCalledTimes(1);
  });

  test("a path no entry holds is 404 for an operator, having read nothing", async () => {
    for (const parts of [["nothing"], ["whoami", "extra"], []]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(404);
      nothingRan();
    }
  });
});

/*
  F.2.0a's administration branch decides every GET under
  `/api/v1/administration`, an operator's included: its admission is the
  entry's `credentialKinds` (ruling 25), and the operator branch never answers
  there. The cases below add a probe entry for their own duration,
  dispatched to a read they also add, and remove both afterwards, so the
  admission is shown on an entry whose `credentialKinds` each case chooses.
  F.2.0b's real reads' cases are in `lib/server-administration-reads.test.ts`,
  F.2.3's read's in its project settings `actions.transport.test.ts`,
  F.2.1's three in its routing settings `actions.transport.test.ts`,
  F.2.4's two in its operations `actions.transport.test.ts`, and
  F.2.5's in the Slack `actions.transport.test.ts`.
*/
describe("GET under the administration prefix: an operator is answered by the administration branch", () => {
  const probePath = "/api/v1/administration/f3-probes/{probeId}";
  const probeId = "018f0000-0000-7000-8000-0000000f3f06";
  const registry = capabilityRegistry as Capability[];
  const reads = administrationReads as Record<
    string,
    (input: unknown) => Promise<unknown>
  >;
  const probe = vi.fn(async (_input: unknown) => ({ probed: true }));

  function addProbe(credentialKinds?: readonly ("agent" | "operator")[]) {
    registry.push({
      kind: "query",
      name: "f3_probe_read",
      dispatch: {
        to: "administration-read",
        method: "f3_probe_read" as never,
      },
      binding: "organization-or-project",
      scope: "operator:revoke",
      rest: {
        method: "GET",
        path: probePath,
        pathParameters: ["probeId"],
        queryParameters: [],
        routeRequiresProject: false,
        rateLimitClass: "token",
      },
      mcpTool: null,
      ...(credentialKinds ? { credentialKinds } : {}),
    });
    reads.f3_probe_read = probe;
  }

  afterEach(() => {
    const at = registry.findIndex((entry) => entry.name === "f3_probe_read");
    if (at >= 0) registry.splice(at, 1);
    delete reads.f3_probe_read;
    probe.mockClear();
  });

  test("the prefix, and a path no entry holds, are refused 403 by the administration branch, not 404 by the operator branch", async () => {
    for (const parts of [
      ["administration"],
      ["administration", "nothing"],
      ["administration", "f3-probes", probeId],
    ]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(403);
      nothingRan();
    }
  });

  test("an entry whose credentialKinds names operator is read for an operator holding its scope", async () => {
    addProbe(["operator"]);
    const context = signInAsOperator();
    const response = await api.get(["administration", "f3-probes", probeId]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ probed: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toMatchObject({
      context,
      pathParameters: { probeId },
    });
  });

  test("an entry with no credentialKinds admits agents only, so an operator is refused 403 having read nothing", async () => {
    addProbe();
    signInAsOperator();
    const response = await api.get(["administration", "f3-probes", probeId]);
    expect(response.status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
  });

  test("an admitted entry still checks its scope", async () => {
    addProbe(["operator"]);
    signInAsOperator(null, []);
    const response = await api.get(["administration", "f3-probes", probeId]);
    expect(response.status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
  });

  test("an agent is refused 403 even at an entry that names agent", async () => {
    addProbe(["agent", "operator"]);
    signInAs(agentContext());
    const response = await api.get(["administration", "f3-probes", probeId]);
    expect(response.status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("authentication comes first", () => {
  test("a refused operator key is a 401 on either verb", async () => {
    apiV1.authenticate.mockRejectedValue(
      new DomainError("unauthenticated", "Operator credential is invalid"),
    );
    expect((await api.get(["whoami"])).status).toBe(401);
    expect(
      (await api.command("revoke_operator_credential", { input: {} })).status,
    ).toBe(401);
    nothingRan();
  });
});
