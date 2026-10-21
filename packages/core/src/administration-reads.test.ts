import {
  type AuthorizedCommandContext,
  agentScopes,
  type Capability,
  capabilityRegistry,
  DomainError,
  operatorActor,
  operatorScopes,
} from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  type AdministrationReadInput,
  administrationReads,
  isAdministrationEntry,
} from "./administration-reads.js";

/*
 * `administrationReads` called directly, as a caller of `./adapters` can call
 * it without `query` (ruling 230, the survey's F5): each read admits its
 * context by `readAdministrationEntry`'s rule for the registry entry that
 * dispatches to it, before its transaction opens. An agent is refused first,
 * then a credential the entry does not admit, then one lacking the entry's
 * scope. `query.test.ts` holds `query`'s own admission, which runs before the
 * read; here `query` is not involved.
 *
 * `@requestport/db` is a stand-in that records each transaction it opens,
 * each re-check and each read, and checks nothing itself, so a context that
 * reaches it is answered and the refusals below are the reads' own.
 */

const db = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@requestport/db", () => {
  const read = (name: string) => async () => {
    db.calls.push(name);
    return { readBy: name };
  };
  return {
    withAdministrationReadTransaction: async (
      organizationId: string,
      run: (tx: unknown) => Promise<unknown>,
    ) => {
      db.calls.push(`transaction ${organizationId}`);
      return run({ tx: "the read's" });
    },
    createCommandAuthorizationRepository: () => ({
      assertCurrent: async () => {
        db.calls.push("assertCurrent");
      },
    }),
    evaluateRouteForOperator: read("evaluateRouteForOperator"),
    listAdministrationLanes: read("listAdministrationLanes"),
    listAdministrationMembers: read("listAdministrationMembers"),
    listAdministrationProjects: read("listAdministrationProjects"),
    readAgentPrincipalForOperator: read("readAgentPrincipalForOperator"),
    readAgentPrincipalsForOperator: read("readAgentPrincipalsForOperator"),
    readImportRunForOperator: read("readImportRunForOperator"),
    readImportRunsForOperator: read("readImportRunsForOperator"),
    readInvitationsForOperator: read("readInvitationsForOperator"),
    readOperationsForOperator: read("readOperationsForOperator"),
    readOrganizationAppearanceForOperator: read(
      "readOrganizationAppearanceForOperator",
    ),
    readProjectSettingsForOperator: read("readProjectSettingsForOperator"),
    readRetentionHoldsForOperator: read("readRetentionHoldsForOperator"),
    readRoutingRulesForOperator: read("readRoutingRulesForOperator"),
    readSlackConfigurationForOperator: read(
      "readSlackConfigurationForOperator",
    ),
  };
});

const organizationId = "018f0000-0000-7000-8000-0000000c5a01";
const memberUserId = "018f0000-0000-7000-8000-0000000c5a02";

const entries = capabilityRegistry.filter(isAdministrationEntry);
const cases = entries.map((entry) => [entry.name, entry] as const);

function operatorContext(scopes: Iterable<string>): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000c5a03",
      memberUserId,
    }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    scopes: new Set(scopes),
    credentialId: "administration-reads-test-operator",
    correlationId: "018f0000-0000-7000-8000-0000000c5a04",
  } as AuthorizedCommandContext;
}

function input(context: AuthorizedCommandContext): AdministrationReadInput {
  return {
    context,
    pathParameters: {
      projectId: "018f0000-0000-7000-8000-0000000c5a05",
      agentPrincipalId: "018f0000-0000-7000-8000-0000000c5a06",
      runId: "018f0000-0000-7000-8000-0000000c5a07",
    },
    searchParams: new URLSearchParams(),
    reading: {
      database: { handle: "the storage's" } as never,
      secrets: { operatorCredentials: "enabled" },
    },
  };
}

function readOf(name: string) {
  const read = (
    administrationReads as Readonly<
      Record<string, (input: AdministrationReadInput) => Promise<unknown>>
    >
  )[name];
  if (!read) throw new Error(`administrationReads has no read named ${name}`);
  return read;
}

beforeEach(() => {
  db.calls.length = 0;
});

describe("administrationReads, called directly (ruling 230, F5)", () => {
  test("every administration entry dispatches to a read of its own name, admits operators alone and names an operator scope", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(Object.keys(administrationReads).sort()).toEqual(
      entries.map((entry) => entry.dispatch.method).sort(),
    );
    for (const entry of entries) {
      expect(entry.dispatch.method, entry.name).toBe(entry.name);
      expect(entry.credentialKinds, entry.name).toEqual(["operator"]);
      expect(operatorScopes, entry.name).toContain(entry.scope);
    }
  });

  test.each(cases)(
    "%s refuses an operator holding every operator scope but its entry's, before its transaction opens",
    async (name, entry) => {
      const context = operatorContext(
        operatorScopes.filter((scope) => scope !== entry.scope),
      );

      const refusal = readOf(name)(input(context));

      await expect(refusal).rejects.toBeInstanceOf(DomainError);
      await expect(refusal).rejects.toMatchObject({
        code: "forbidden",
        message: "Credential scope is not sufficient",
      });
      expect(db.calls).toEqual([]);
    },
  );

  test.each(cases)(
    "%s is read for an operator holding its entry's scope alone, in one transaction bound to the credential's organisation",
    async (name, entry) => {
      const context = operatorContext([entry.scope as string]);

      await expect(readOf(name)(input(context))).resolves.toMatchObject({
        readBy: expect.any(String),
      });
      expect(db.calls[0]).toBe(`transaction ${organizationId}`);
      expect(
        db.calls.filter((call) => call.startsWith("transaction ")),
      ).toHaveLength(1);
    },
  );

  test.each(cases)(
    "%s refuses an agent first, holding every agent scope and its entry's, before its transaction opens",
    async (name, entry) => {
      const context = {
        actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c5a08" },
        organizationId,
        projectId: "018f0000-0000-7000-8000-0000000c5a05",
        laneIds: new Set<string>(),
        scopes: new Set<string>([...agentScopes, entry.scope as string]),
        credentialId: "administration-reads-test-agent",
        correlationId: "018f0000-0000-7000-8000-0000000c5a09",
      } as AuthorizedCommandContext;

      await expect(readOf(name)(input(context))).rejects.toMatchObject({
        code: "forbidden",
        message: "An agent credential cannot reach an administration read",
      });
      expect(db.calls).toEqual([]);
    },
  );

  test.each(cases)(
    "%s refuses a person's context, which its entry does not admit, holding its entry's scope, before its transaction opens",
    async (name, entry) => {
      const context = {
        actor: { type: "user", id: memberUserId },
        organizationId,
        scopes: new Set<string>([entry.scope as string]),
        credentialId: "administration-reads-test-session",
        correlationId: "018f0000-0000-7000-8000-0000000c5a0a",
      } as AuthorizedCommandContext;

      await expect(readOf(name)(input(context))).rejects.toMatchObject({
        code: "forbidden",
        message: "This credential is not admitted to this administration read",
      });
      expect(db.calls).toEqual([]);
    },
  );

  /*
   * The scope is checked last. An agent or a person lacking the entry's scope
   * is refused as an agent, or as a credential the entry does not admit, and
   * never in the scope's words, as `readAdministrationEntry` refuses them
   * (the review of J.10).
   */
  test.each(cases)(
    "%s refuses an agent lacking its entry's scope as an agent, not for the scope, before its transaction opens",
    async (name, entry) => {
      const context = {
        actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c5a08" },
        organizationId,
        projectId: "018f0000-0000-7000-8000-0000000c5a05",
        laneIds: new Set<string>(),
        scopes: new Set<string>(
          agentScopes.filter((scope) => scope !== entry.scope),
        ),
        credentialId: "administration-reads-test-agent",
        correlationId: "018f0000-0000-7000-8000-0000000c5a0b",
      } as AuthorizedCommandContext;

      await expect(readOf(name)(input(context))).rejects.toMatchObject({
        code: "forbidden",
        message: "An agent credential cannot reach an administration read",
      });
      expect(db.calls).toEqual([]);
    },
  );

  test.each(cases)(
    "%s refuses a person's context lacking its entry's scope as one its entry does not admit, not for the scope, before its transaction opens",
    async (name) => {
      const context = {
        actor: { type: "user", id: memberUserId },
        organizationId,
        scopes: new Set<string>(),
        credentialId: "administration-reads-test-session",
        correlationId: "018f0000-0000-7000-8000-0000000c5a0c",
      } as AuthorizedCommandContext;

      await expect(readOf(name)(input(context))).rejects.toMatchObject({
        code: "forbidden",
        message: "This credential is not admitted to this administration read",
      });
      expect(db.calls).toEqual([]);
    },
  );
});

describe("the entry a read admits by, read from the registry when the read runs", () => {
  const registry = capabilityRegistry as Capability[];
  const added = "administration_reads_test_second_entry";

  afterEach(() => {
    const at = registry.findIndex((entry) => entry.name === added);
    if (at >= 0) registry.splice(at, 1);
  });

  test("a read that a second registry entry also dispatches to is a fault, answered as one, never a refusal or a pass, and opens nothing", async () => {
    const members = entries.find(
      (entry) => entry.name === "list_administration_members",
    );
    if (!members) throw new Error("no list_administration_members entry");
    registry.push({ ...members, name: added, scope: "project:read" });

    const fault = readOf("list_administration_members")(
      input(operatorContext(operatorScopes)),
    );

    await expect(fault).rejects.toThrow(
      "No single capability registry administration entry dispatches to the read list_administration_members",
    );
    await expect(fault).rejects.not.toBeInstanceOf(DomainError);
    expect(db.calls).toEqual([]);
  });
});
