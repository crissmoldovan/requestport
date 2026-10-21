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
  Plan 13, F.2.6's registry half: the review and split forms and `/api/v1`
  reach the same handler. Both run here for real — the form's action, the
  REST route, the real `server-core-commands.ts` bus and
  `createCoreCommandRegistry()` for review, the real `splitImportEntry` for
  the split — over B1's faked `@requestport/db`, so each ends at the same
  import review port method, which records what it was handed. The form
  arrives as the signed-in person; REST as an operator credential, whose
  issuing member the port is asked about, and whose own actor the write
  records.

  What the fake cannot show — the role rule, the version check, a bound
  operator's confinement to its project, the credential's re-check against
  its row — is proven on PostgreSQL in
  `packages/db/src/repositories/import-repository.integration.test.ts` and
  `packages/db/src/queries/administration/import-reads.integration.test.ts`.

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
  user: { id: "user_f26_person" },
  session: { id: "session_f26" },
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
const { legacySegments } = await import(
  "../../../lib/server-import-actions.js"
);
const api = restClient(route);

const runId = "018f0000-0000-7000-8000-0000000f2611";
const entryId = "018f0000-0000-7000-8000-0000000f2612";
const projectId = "018f0000-0000-7000-8000-0000000f2613";
const requestId = "018f0000-0000-7000-8000-0000000f2614";
const lineageId = "018f0000-0000-7000-8000-0000000f2615";
const credentialId = "018f0000-0000-7000-8000-0000000f2616";
const memberUserId = "user_f26_operator_member";
const idle = { status: "idle" as const };

/** Each command, its form action, its port method, its REST input and its form. */
const cases = [
  {
    command: "review_legacy_import_entry",
    action: "reviewImportEntryAction",
    method: "reviewEntry",
    fields: {
      decision: "map_existing",
      proposedCanonicalId: requestId,
      relationships: [{ type: "related_to", targetRequestId: requestId }],
    },
    form: {
      decision: "map_existing",
      proposedCanonicalId: requestId,
      relationships: `related_to:${requestId}`,
    },
  },
  {
    command: "split_legacy_import_entry",
    action: "splitImportEntryAction",
    method: "splitEntry",
    fields: { splitLines: [2, 3] },
    form: { splitLines: "3, 2" },
  },
] as const;

function operatorContext(
  options: { projectId?: string | null; scopes?: readonly string[] } = {},
) {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator" as const,
    organizationId: ids.organization,
    projectId: options.projectId ?? null,
    laneIds: new Set<string>(),
    scopes: new Set(options.scopes ?? ["import:write"]),
    credentialId,
    credentialFingerprint: "f26-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2617",
    authorizationId: credentialId,
  };
}

function signInAsOperator(options?: Parameters<typeof operatorContext>[0]) {
  const context = operatorContext(options);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** What the import review port was handed, per method. */
function recordPort() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  apiV1.ports.importReviewCommands = {
    authorize: async (...args: unknown[]) => {
      calls.push({ method: "authorize", args });
    },
    reviewEntry: async (...args: unknown[]) => {
      calls.push({ method: "reviewEntry", args });
      return { id: entryId, version: 5 };
    },
    splitEntry: async (...args: unknown[]) => {
      calls.push({ method: "splitEntry", args });
      return { entryIds: [entryId, requestId, projectId] };
    },
  } as never;
  return calls;
}

function formData(fields: Record<string, string>) {
  const data = new FormData();
  data.set("runId", runId);
  data.set("entryId", entryId);
  data.set("expectedVersion", "4");
  data.set("idempotencyKey", "f26-form-idempotency-0001");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function nothingReached() {
  expect(
    apiV1.portCalls.filter((call) => call.startsWith("importReviewCommands.")),
  ).toEqual([]);
}

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

describe("the forms and REST reach the same handler", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s: the form and an operator's POST end at the same port method, each for its own member",
    async (_, entry) => {
      const calls = recordPort();
      const action = actions[entry.action] as (
        state: unknown,
        data: FormData,
      ) => Promise<{ status: string }>;
      const state = await action(idle, formData(entry.form));
      expect(state.status).toBe("success");
      const fromForm = [...calls];
      calls.length = 0;

      const context = signInAsOperator();
      const response = await api.command(entry.command, {
        input: { runId, entryId, ...entry.fields },
        idempotencyKey: "f26-rest-idempotency-0001",
        expectedVersion: 4,
      });
      expect(response.status).toBe(200);
      const fromRest = [...calls];

      // One authorisation, then the one write, by the same method on each
      // path.
      expect(fromForm.map((call) => call.method)).toEqual([
        "authorize",
        entry.method,
      ]);
      expect(fromRest.map((call) => call.method)).toEqual(
        fromForm.map((call) => call.method),
      );
      const target = (userId: string) => ({
        userId,
        organizationId: ids.organization,
      });
      expect(fromForm[0]?.args).toEqual([target(session.user.id)]);
      expect(fromRest[0]?.args).toEqual([target(memberUserId)]);
      const person = { type: "user", id: session.user.id };
      const [formWrite, ...formRest] = fromForm[1]?.args ?? [];
      const [restWrite, ...restRest] = fromRest[1]?.args ?? [];
      expect(formWrite).toMatchObject({
        ...target(session.user.id),
        actor: person,
        credentialProjectId: null,
        expectedVersion: 4,
      });
      expect(restWrite).toMatchObject({
        ...target(memberUserId),
        actor: context.actor,
        credentialProjectId: null,
        expectedVersion: 4,
      });
      if (entry.command === "review_legacy_import_entry") {
        await expect(response.json()).resolves.toEqual({
          result: { id: entryId, version: 5 },
        });
        // What the write is told to do, beyond who and where, is the same.
        expect(restRest).toEqual(formRest);
        return;
      }
      await expect(response.json()).resolves.toEqual({
        result: { entryIds: [entryId, requestId, projectId] },
      });
      // The split's write carries its cut as a function; beyond who acts,
      // each path hands the same fields and the same cut.
      const { segment: formCut, ...formFields } = formWrite as {
        segment: (body: string) => unknown;
      } & Record<string, unknown>;
      const { segment: restCut, ...restFields } = restWrite as {
        segment: (body: string) => unknown;
      } & Record<string, unknown>;
      const who = ["userId", "actor", "idempotencyKey"];
      const strip = (fields: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(fields).filter(([name]) => !who.includes(name)),
        );
      expect(strip(restFields)).toEqual(strip(formFields));
      expect(restFields.splitLines).toEqual([2, 3]);
      const body = "# First\n\nOne.\n# Second\n";
      expect(restCut(body)).toEqual(formCut(body));
      expect(restCut(body)).toEqual(legacySegments(body, [2, 3]));
    },
  );

  test("a project-bound operator's project is handed to each write", async () => {
    for (const entry of cases) {
      const calls = recordPort();
      signInAsOperator({ projectId });
      const response = await api.command(entry.command, {
        input: { runId, entryId, ...entry.fields },
        idempotencyKey: "f26-rest-idempotency-0002",
        expectedVersion: 4,
      });
      expect(response.status, entry.command).toBe(200);
      expect(calls[1]?.args[0], entry.command).toMatchObject({
        userId: memberUserId,
        credentialProjectId: projectId,
      });
    }
  });
});

describe("REST refuses what the handler must never see", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an agent credential 403 before anything runs, even holding import:write",
    async (_, entry) => {
      recordPort();
      signInAs(agentContext({ scopes: ["import:write", "project:read"] }));
      const response = await api.command(entry.command, {
        input: { runId, entryId, ...entry.fields },
        expectedVersion: 4,
      });
      expect(response.status).toBe(403);
      expect(apiV1.transactionsRun).toBe(0);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s writes the credential's organisation over the one the caller names",
    async (_, entry) => {
      const calls = recordPort();
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: {
          organizationId: ids.otherOrganization,
          runId,
          entryId,
          ...entry.fields,
        },
        expectedVersion: 4,
      });
      expect(response.status).toBe(200);
      expect(calls[0]?.args[0]).toEqual({
        userId: memberUserId,
        organizationId: ids.organization,
      });
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator without import:write 403, reaching no write",
    async (_, entry) => {
      recordPort();
      signInAsOperator({ scopes: ["project:read"] });
      const response = await api.command(entry.command, {
        input: { runId, entryId, ...entry.fields },
        expectedVersion: 4,
      });
      expect(response.status).toBe(403);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator whose credential is no longer current 403, before the port is asked",
    async (_, entry) => {
      recordPort();
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
      const response = await api.command(entry.command, {
        input: { runId, entryId, ...entry.fields },
        expectedVersion: 4,
      });
      expect(response.status).toBe(403);
      expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
    },
  );

  test("a malformed split is refused 422 before a transaction opens", async () => {
    recordPort();
    signInAsOperator();
    const response = await api.command("split_legacy_import_entry", {
      input: { runId, entryId, splitLines: [1] },
      expectedVersion: 4,
    });
    expect(response.status).toBe(422);
    expect(apiV1.transactionsRun).toBe(0);
    nothingReached();
  });
});

describe("GET /api/v1/administration/import-runs and /import-runs/{runId}", () => {
  const reads = [
    {
      name: "list",
      path: ["administration", "import-runs"],
      fake: () => apiV1.administrationReads.importRuns,
      handed: (context: unknown) => ({
        context,
        operatorCredentials: undefined,
      }),
    },
    {
      name: "get",
      path: ["administration", "import-runs", runId],
      fake: () => apiV1.administrationReads.importRun,
      handed: (context: unknown) => ({
        context,
        runId,
        operatorCredentials: undefined,
      }),
    },
  ] as const;

  test.each(reads.map((read) => [read.name, read] as const))(
    "%s reads for an operator holding import:write, in one transaction bound to its organisation, with its context",
    async (_, read) => {
      const context = signInAsOperator({ projectId });
      read.fake().mockResolvedValue({ id: runId, version: 3 });
      const response = await api.get([...read.path]);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ id: runId, version: 3 });
      expect(read.fake()).toHaveBeenCalledExactlyOnceWith(
        { fake: "transaction" },
        read.handed(context),
      );
      expect(apiV1.transactionsRun).toBe(1);
      // The one transaction is bound to the credential's organisation.
      expect(apiV1.readTransactionOrganizations).toEqual([
        context.organizationId,
      ]);
    },
  );

  test.each(reads.map((read) => [read.name, read] as const))(
    "%s binds the read's transaction to the credential's organisation, never one the request names",
    async (_, read) => {
      const context = signInAsOperator();
      read.fake().mockResolvedValue({ id: runId, version: 3 });
      const response = await api.get(
        [...read.path],
        `?organizationId=${ids.otherOrganization}`,
      );
      expect(response.status).toBe(200);
      expect(apiV1.readTransactionOrganizations).toEqual([
        context.organizationId,
      ]);
      expect(apiV1.readTransactionOrganizations).not.toContain(
        ids.otherOrganization,
      );
    },
  );

  test.each(reads.map((read) => [read.name, read] as const))(
    "%s refuses an agent credential 403, even holding import:write, reading nothing",
    async (_, read) => {
      signInAs(agentContext({ scopes: ["import:write", "project:read"] }));
      const response = await api.get([...read.path]);
      expect(response.status).toBe(403);
      expect(read.fake()).not.toHaveBeenCalled();
      expect(apiV1.transactionsRun).toBe(0);
      expect(apiV1.readTransactionOrganizations).toEqual([]);
    },
  );

  test.each(reads.map((read) => [read.name, read] as const))(
    "%s refuses an operator without import:write 403, reading nothing",
    async (_, read) => {
      signInAsOperator({ scopes: ["project:read"] });
      const response = await api.get([...read.path]);
      expect(response.status).toBe(403);
      expect(read.fake()).not.toHaveBeenCalled();
      expect(apiV1.readTransactionOrganizations).toEqual([]);
    },
  );

  test.each(
    reads.flatMap((read) =>
      (
        [
          ["forbidden", 403],
          ["not_found", 404],
        ] as const
      ).map(([code, status]) => [read.name, code, status, read] as const),
    ),
  )("%s answers the read's %s as %i", async (_, code, status, read) => {
    signInAsOperator();
    const { DomainError } = await import("@requestport/domain");
    read.fake().mockRejectedValue(new DomainError(code, "refused by the read"));
    const response = await api.get([...read.path]);
    expect(response.status).toBe(status);
  });

  test("a path beside the reads' is refused 403, reading nothing", async () => {
    for (const parts of [
      ["administration", "import-runs", runId, "entries"],
      ["administration", "import-runs", ""],
      ["administration", "import-run"],
    ]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(403);
    }
    expect(apiV1.administrationReads.importRuns).not.toHaveBeenCalled();
    expect(apiV1.administrationReads.importRun).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });
});
