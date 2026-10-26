import {
  appearanceOrganizationCommandName,
  DomainError,
  inviteOrganizationMemberCommandName,
  operatorActor,
  resendOrganizationInvitationCommandName,
  revokeOrganizationInvitationCommandName,
  setOrganizationMemberCommandName,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

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
  Plan 13, F.2.7's registry half: each members-page form and `/api/v1` reach
  the same handler. Both run here for real — the form's action, the REST
  route, the real `server-core-commands.ts` bus and
  `createCoreCommandRegistry()` — over B1's faked `@requestport/db`, so each
  ends at the same port methods, which record what they were handed. The form
  arrives as the signed-in person; REST as an operator credential, whose
  issuing member the ports are asked about, and whose own actor the writes
  record.

  What the fake cannot show — the role rules, the version checks, the
  credential's re-check against its row — is proven on PostgreSQL in
  `packages/db/src/repositories/organization-management-repository.integration.test.ts`
  and `queries/administration/member-reads.integration.test.ts`.

  Each read's one transaction is bound to the credential's organisation
  before its first statement (`withAdministrationReadTransaction`;
  manifest-i2.md §4 Owns, ruling 50). The fake records the organisation each
  was bound to, as `server-administration-reads.test.ts` reads it; that the
  helper binds, and what a binding admits, is held in `packages/db`
  (`tenant-context.test.ts`, `row-security.integration.test.ts`).
*/

vi.mock("@requestport/db", async () => ({
  ...(await import("../../../../test/api-v1/fake-database.js"))
    .fakeDatabaseModule,
  // The repository the invitation form's wiring
  // (`lib/server-administration-actions.ts`) builds beside the bus for its
  // organisation switch, which nothing in this file runs. Its organisation
  // and project creation build theirs with the harness's
  // `createFoundationRepository`.
  createFoundationQueryRepository: () => ({}),
}));
vi.mock("@requestport/auth/server", async () => ({
  ...(await import("../../../../test/api-v1/fake-database.js"))
    .fakeAuthServerModule,
  requireHumanSession: async () => session,
}));
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
vi.mock("../../../../lib/trigger-client.js", async () => ({
  ...(await import("../../../../test/api-v1/fake-database.js"))
    .fakeTriggerClientModule,
  // The members page's composition (`server-administration-actions.ts`)
  // takes the correlation dispatch when it loads; organisation and project
  // creation use it, and nothing this file runs does.
  dispatchCommittedCorrelation: vi.fn(async () => undefined),
}));
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js")).fakeWiringModule,
);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn() }),
  headers: async () => new Headers(),
}));
vi.mock("../../../../lib/server-scenario-boundary.js", () => ({
  readE2EScenarioRequest: async () => ({ fault: null }),
}));

const session = vi.hoisted(() => ({
  user: { id: "user_f27_person" },
  session: { id: "session_f27" },
}));
const organization = vi.hoisted(() => ({
  id: "018f0000-0000-7000-8000-00000000b101",
  name: "B1",
  role: "owner",
  slug: "b1",
}));
vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: organization,
    session,
  }),
  getCurrentOrganizationForUser: async () => organization,
  raiseScenarioConflict: () => undefined,
}));

const route = await import("../../../api/v1/[[...path]]/route.js");
const memberActions = await import("./actions.js");
const { inviteMemberAction } = await import("../../actions.js");
const { updateOrganizationAppearanceAction } = await import(
  "../appearance/actions.js"
);
const { createOrganizationAppearanceRenderContext } = await import(
  "../../../../lib/server-appearance-actions.js"
);
const api = restClient(route);

const lineageId = "018f0000-0000-7000-8000-0000000f2701";
const credentialId = "018f0000-0000-7000-8000-0000000f2702";
const invitationId = "018f0000-0000-7000-8000-0000000f2703";
const membershipId = "018f0000-0000-7000-8000-0000000f2704";
const appearanceAggregateId = "018f0000-0000-7000-8000-0000000f2705";
const boundProjectId = "018f0000-0000-7000-8000-0000000f2706";
const memberUserId = "user_f27_operator_member";

function operatorContext(
  options: { projectId?: string | null; scopes?: readonly string[] } = {},
) {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator" as const,
    organizationId: ids.organization,
    projectId: options.projectId ?? null,
    laneIds: new Set<string>(),
    scopes: new Set(options.scopes ?? ["members:manage"]),
    credentialId,
    credentialFingerprint: "f27-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2707",
    authorizationId: credentialId,
  };
}

function signInAsOperator(options?: Parameters<typeof operatorContext>[0]) {
  const context = operatorContext(options);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

type Call = { method: string; args: unknown[] };

/**
 * The three ports these commands reach, each method recording what it was
 * handed and answering as the repository would for a person allowed to act.
 */
function recordPorts() {
  const calls: Call[] = [];
  const record =
    (method: string, answer: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answer(...args);
    };
  const foundationTransaction = {
    findOrganizationAuthorization: record(
      "findOrganizationAuthorization",
      () => ({
        organization: { id: ids.organization, status: "active" },
        membership: { role: "owner", status: "active" },
      }),
    ),
    lockInvitation: record("lockInvitation", () => undefined),
    findInvitation: record("findInvitation", () => null),
    // X15's two checks before an invitation is made (`main`): no active
    // member and no account holds the address, as for a new one.
    findActiveMembershipByEmail: record(
      "findActiveMembershipByEmail",
      () => null,
    ),
    findUserByNormalizedEmail: record("findUserByNormalizedEmail", () => null),
    createInvitation: record("createInvitation", () => ({
      id: invitationId,
      organizationId: ids.organization,
      normalizedEmail: "invited@example.com",
      role: "member",
      tokenHash: "token-hash",
      expiresAt: new Date("2026-10-06T00:00:00.000Z"),
      acceptedAt: null,
      revokedAt: null,
      expiresInSeconds: 604_800,
      version: 1,
    })),
    appendAuditRecord: record("appendAuditRecord", () => undefined),
  };
  apiV1.ports.foundation = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run(foundationTransaction),
  } as never;
  apiV1.ports.organizationManagement = {
    authorizeMemberChange: record("authorizeMemberChange", () => undefined),
    authorizeInvitationRevocation: record(
      "authorizeInvitationRevocation",
      () => undefined,
    ),
    setMember: record("setMember", () => ({
      id: membershipId,
      role: "admin",
      status: "active",
      version: 4,
    })),
    revokeInvitation: record("revokeInvitation", () => ({
      id: invitationId,
      version: 2,
    })),
    authorizeInvitationResend: record(
      "authorizeInvitationResend",
      () => undefined,
    ),
    resendInvitation: record("resendInvitation", () => ({
      id: invitationId,
      role: "member",
      expiresAt: new Date("2026-11-01T00:00:00.000Z"),
      version: 2,
    })),
  } as never;
  const defaults = {
    organizationId: ids.organization,
    aggregateId: appearanceAggregateId,
    theme: "cue",
    density: "normal",
    mode: "system",
    lastUpdatedByUserId: null,
    version: 3,
  };
  apiV1.ports.appearance = {
    lockOrganizationAuthorization: record(
      "lockOrganizationAuthorization",
      () => ({
        organization: { id: ids.organization, status: "active" },
        membership: { id: membershipId, role: "owner", status: "active" },
      }),
    ),
    lockOrganizationDefaults: record("lockOrganizationDefaults", () => ({
      ...defaults,
    })),
    updateOrganizationDefaults: record(
      "updateOrganizationDefaults",
      (input) => ({
        ...defaults,
        ...(input as object),
        version: defaults.version + 1,
      }),
    ),
    appendAuditRecord: record("appendAuditRecord", () => undefined),
  } as never;
  return calls;
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** Each command, how its form is submitted, and the REST input for the same change. */
const cases: Array<{
  command: string;
  submit: () => Promise<{ status: string }>;
  input: Record<string, unknown>;
  expectedVersion: number;
}> = [
  {
    command: setOrganizationMemberCommandName,
    submit: () =>
      memberActions.setOrganizationMemberAction(
        { status: "idle" } as never,
        form({
          userId: "user_f27_target",
          role: "admin",
          status: "active",
          expectedVersion: "3",
          idempotencyKey: "f27-form-idempotency-0001",
        }),
      ),
    input: { userId: "user_f27_target", role: "admin", status: "active" },
    expectedVersion: 3,
  },
  {
    command: revokeOrganizationInvitationCommandName,
    submit: () =>
      memberActions.revokeInvitationAction(
        { status: "idle" } as never,
        form({
          invitationId,
          expectedVersion: "1",
          idempotencyKey: "f27-form-idempotency-0002",
        }),
      ),
    input: { invitationId },
    expectedVersion: 1,
  },
  {
    command: resendOrganizationInvitationCommandName,
    submit: () =>
      memberActions.resendInvitationAction(
        { status: "idle" } as never,
        form({
          invitationId,
          expectedVersion: "1",
          idempotencyKey: "f27-form-idempotency-0005",
        }),
      ),
    input: { invitationId },
    expectedVersion: 1,
  },
  {
    command: inviteOrganizationMemberCommandName,
    submit: () =>
      inviteMemberAction(
        { status: "idle" } as never,
        form({ email: "Invited@Example.com", role: "member" }),
      ),
    input: { email: "Invited@Example.com", role: "member" },
    expectedVersion: 0,
  },
  {
    command: appearanceOrganizationCommandName,
    submit: () =>
      updateOrganizationAppearanceAction(
        { status: "idle" } as never,
        form({
          theme: "terminal",
          density: "large",
          mode: "dark",
          expectedVersion: "3",
          idempotencyKey: "f27-form-idempotency-0004",
          renderContext: createOrganizationAppearanceRenderContext({
            actorId: session.user.id,
            organizationId: organization.id,
          }),
        }),
      ),
    input: { theme: "terminal", density: "large", mode: "dark" },
    expectedVersion: 3,
  },
];

/**
 * A call with who acted taken out: the person's id, or the operator's member,
 * becomes `<member>`, and the actor handed to a write becomes `<actor>`. The
 * correlation id and a new invitation's token hash are drawn afresh for every
 * command, so they are taken out too. What is left is what the two paths must
 * agree on.
 */
function withoutWho(call: Call, member: string) {
  return JSON.parse(
    JSON.stringify(call.args, (key, value) => {
      if (key === "actor") return "<actor>";
      if (key === "correlationId") return "<correlation>";
      if (key === "tokenHash") return "<token>";
      return value === member ? "<member>" : value;
    }),
  ) as unknown;
}

function nothingReached(calls: Call[]) {
  expect(calls).toEqual([]);
  expect(
    apiV1.portCalls.filter(
      (call) =>
        call.startsWith("organizationManagement.") ||
        call.startsWith("foundation.") ||
        call.startsWith("appearance."),
    ),
  ).toEqual([]);
}

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

describe("the form and REST reach the same handler", () => {
  test("the cases are F.2.7's four commands and ruling 263's resend, each once", () => {
    expect(cases.map((entry) => entry.command)).toEqual([
      "set_organization_member",
      "revoke_organization_invitation",
      "resend_organization_invitation",
      "invite_organization_member",
      "appearance.update_organization_defaults.v1",
    ]);
  });

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s: the form and an operator's POST end at the same port methods, each for its own member",
    async (_, entry) => {
      const calls = recordPorts();
      const state = await entry.submit();
      expect(state.status).toBe("success");
      const fromForm = [...calls];
      calls.length = 0;

      const context = signInAsOperator();
      const response = await api.command(entry.command, {
        input: entry.input,
        idempotencyKey: "f27-rest-idempotency-0001",
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(200);
      const fromRest = [...calls];

      expect(fromForm.length).toBeGreaterThan(0);
      expect(fromRest.map((call) => call.method)).toEqual(
        fromForm.map((call) => call.method),
      );
      // Apart from who acts, each method is handed the same thing.
      expect(fromRest.map((call) => withoutWho(call, memberUserId))).toEqual(
        fromForm.map((call) => withoutWho(call, session.user.id)),
      );
      // The member each path acts for is the one its credential names: the
      // signed-in person, and the operator's issuing member.
      expect(JSON.stringify(fromForm)).toContain(session.user.id);
      expect(JSON.stringify(fromForm)).not.toContain(memberUserId);
      expect(JSON.stringify(fromRest)).toContain(memberUserId);
      expect(JSON.stringify(fromRest)).not.toContain(session.user.id);
      // Where a write is handed who acted, REST hands it the operator.
      for (const call of fromRest)
        for (const argument of call.args)
          if (
            argument &&
            typeof argument === "object" &&
            "actor" in argument &&
            call.method !== "appendAuditRecord"
          )
            expect((argument as { actor: unknown }).actor).toEqual(
              context.actor,
            );
      const audit = fromRest.find(
        (call) => call.method === "appendAuditRecord",
      );
      if (audit)
        expect((audit.args[0] as { actor: unknown }).actor).toEqual({
          type: "service",
          id: context.actor.id,
        });
    },
  );
});

/*
  Ruling 263: resending an invitation is on REST beside revoking one, under
  the same rule. Whether an owner invitation is the actor's to touch is the
  port's to say (`authorizeInvitationResend`, as `authorizeInvitationRevocation`
  for revoke; their rule is proven on PostgreSQL in
  `organization-management-repository.integration.test.ts`, an admin's
  operator among the refused). Here the port refuses as it would an admin's
  operator on an owner invitation: REST answers 403 and the write is never
  asked.
*/
describe("REST resends an invitation under revoke's authority", () => {
  test.each([
    [
      revokeOrganizationInvitationCommandName,
      "authorizeInvitationRevocation",
      "Only an owner may revoke an owner invitation",
    ],
    [
      resendOrganizationInvitationCommandName,
      "authorizeInvitationResend",
      "Only an owner may resend an owner invitation",
    ],
  ] as const)(
    "%s: the port's refusal is 403, asked about the operator's member, and nothing is written",
    async (command, authorize, message) => {
      const calls = recordPorts();
      const management = apiV1.ports
        .organizationManagement as unknown as Record<string, unknown>;
      management[authorize] = async (...args: unknown[]) => {
        calls.push({ method: authorize, args });
        throw new DomainError("forbidden", message);
      };
      signInAsOperator();
      const response = await api.command(command, {
        input: { invitationId },
        idempotencyKey: "f27-rest-idempotency-0006",
        expectedVersion: 1,
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "forbidden",
      });
      expect(calls.map((call) => call.method)).toEqual([authorize]);
      expect(calls[0]?.args).toEqual([
        { organizationId: ids.organization, userId: memberUserId },
        invitationId,
      ]);
    },
  );
});

describe("REST refuses what the handler must never see", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an agent credential 403 before anything runs, even holding members:manage",
    async (_, entry) => {
      const calls = recordPorts();
      signInAs(agentContext({ scopes: ["members:manage", "org:read"] }));
      const response = await api.command(entry.command, {
        input: entry.input,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      expect(apiV1.transactionsRun).toBe(0);
      nothingReached(calls);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator bound to a project 403 before any port is asked",
    async (_, entry) => {
      const calls = recordPorts();
      signInAsOperator({ projectId: boundProjectId });
      const response = await api.command(entry.command, {
        input: entry.input,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      nothingReached(calls);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s writes the credential's organisation over the one the caller names",
    async (_, entry) => {
      const calls = recordPorts();
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: { ...entry.input, organizationId: ids.otherOrganization },
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(calls)).toContain(ids.organization);
      expect(JSON.stringify(calls)).not.toContain(ids.otherOrganization);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator without members:manage 403, before any port is asked",
    async (_, entry) => {
      const calls = recordPorts();
      signInAsOperator({ scopes: ["project:manage", "operator:revoke"] });
      const response = await api.command(entry.command, {
        input: entry.input,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      nothingReached(calls);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator whose credential is no longer current 403, before any port is asked",
    async (_, entry) => {
      const calls = recordPorts();
      apiV1.ports.commandAuthorization = {
        assertCurrent: async () => {
          throw new DomainError(
            "forbidden",
            "Current operator authorization is no longer active",
          );
        },
      };
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: entry.input,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
      nothingReached(calls);
    },
  );
});

describe.each([
  [
    "invitations",
    "invitations",
    [{ id: invitationId, role: "member", version: 1 }],
  ],
  [
    "appearance",
    "organizationAppearance",
    { version: 3, theme: "cue", density: "normal", mode: "system" },
  ],
] as const)("GET /api/v1/administration/%s", (segment, read, answer) => {
  const path = ["administration", segment];
  const fake = () =>
    apiV1.administrationReads[read as keyof typeof apiV1.administrationReads];

  test("reads for an operator holding members:manage, in one transaction bound to its organisation, with its context", async () => {
    const context = signInAsOperator();
    fake().mockResolvedValue(answer);
    const response = await api.get(path);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(answer);
    expect(fake()).toHaveBeenCalledOnce();
    expect(fake()).toHaveBeenCalledWith(
      { fake: "transaction" },
      { context, operatorCredentials: undefined },
    );
    expect(apiV1.transactionsRun).toBe(1);
    // The one transaction is bound to the credential's organisation.
    expect(apiV1.readTransactionOrganizations).toEqual([
      context.organizationId,
    ]);
  });

  test("binds the read's transaction to the credential's organisation, never one the request names", async () => {
    const context = signInAsOperator();
    fake().mockResolvedValue(answer);
    const response = await api.get(
      path,
      `?organizationId=${ids.otherOrganization}`,
    );
    expect(response.status).toBe(200);
    expect(apiV1.readTransactionOrganizations).toEqual([
      context.organizationId,
    ]);
    expect(apiV1.readTransactionOrganizations).not.toContain(
      ids.otherOrganization,
    );
  });

  test("refuses an agent credential 403, even holding members:manage, reading nothing", async () => {
    signInAs(agentContext({ scopes: ["members:manage", "org:read"] }));
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(fake()).not.toHaveBeenCalled();
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test("refuses an operator without members:manage 403, reading nothing", async () => {
    signInAsOperator({ scopes: ["org:read", "project:manage"] });
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(fake()).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test.each([
    ["forbidden", 403],
    ["not_found", 404],
  ] as const)("answers the read's %s as %i", async (code, status) => {
    signInAsOperator();
    fake().mockRejectedValue(new DomainError(code, "refused by the read"));
    const response = await api.get(path);
    expect(response.status).toBe(status);
  });

  test("a path beside the read's is refused 403, reading nothing", async () => {
    for (const parts of [
      [...path, "extra"],
      [...path, invitationId],
    ]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(403);
    }
    expect(fake()).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });
});
