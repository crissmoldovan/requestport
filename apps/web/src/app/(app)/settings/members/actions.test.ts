import {
  createCoreCommandRegistry,
  DomainError,
  organizationAdministrationCommandInputSchemas,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const members = vi.hoisted(() => ({
  contextThrows: null as unknown,
  commandContext: {
    actor: { type: "user", id: "00000000-0000-4000-8000-0000000000aa" },
    organizationId: "00000000-0000-4000-8000-0000000000d1",
    credentialId: "session-under-test",
    correlationId: "correlation-under-test",
    scopes: new Set(["members:manage"]),
  },
  execute: vi.fn(),
  humanCommandContext: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  },
  session: {
    user: { id: "00000000-0000-4000-8000-0000000000aa" },
    session: { id: "session-under-test" },
  },
}));

vi.mock("../../../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: members.execute },
  humanCommandContext: members.humanCommandContext,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => {
    if (members.contextThrows) throw members.contextThrows;
    return {
      currentOrganization: members.organization,
      session: members.session,
    };
  },
}));

import { revalidatePath } from "next/cache";

import { initialMemberActionState } from "./action-state.js";
import {
  resendInvitationAction,
  revokeInvitationAction,
  setOrganizationMemberAction,
} from "./actions.js";

/**
 * Where a rejected access change is allowed to land.
 *
 * The access control sits in a table row whose column heading already names
 * it, so its rejection has a role control of its own to land on. Keeping the
 * last owner is about the organization rather than about any one control, so
 * that rejection stays the fixed banner.
 */

const key = "0123456789abcdef0123";

function accessForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("userId", "user_2");
  data.set("role", "admin");
  data.set("status", "active");
  data.set("expectedVersion", "3");
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

beforeEach(() => {
  members.contextThrows = null;
  members.execute.mockReset();
  members.execute.mockResolvedValue({});
  members.humanCommandContext.mockReset();
  members.humanCommandContext.mockReturnValue(members.commandContext);
});

describe("changing an organization member's access", () => {
  test("addresses a rejected role to the role control", async () => {
    const state = await setOrganizationMemberAction(
      initialMemberActionState,
      accessForm({ role: "superuser" }),
    );

    expect(state).toMatchObject({ field: "role", status: "error" });
    expect(state.message).not.toBe("");
  });

  test("carries the field a domain rejection already names", async () => {
    members.execute.mockRejectedValue(
      new DomainError("version_conflict", "stale", { field: "role" }),
    );

    expect(
      await setOrganizationMemberAction(initialMemberActionState, accessForm()),
    ).toEqual({
      field: "role",
      message: "The record changed. Refresh and try again.",
      status: "error",
    });
  });

  test("keeps the last-owner rule in the fixed banner", async () => {
    members.execute.mockRejectedValue(
      new DomainError("conflict", "an owner must remain"),
    );

    expect(
      await setOrganizationMemberAction(initialMemberActionState, accessForm()),
    ).toEqual({
      message: "The organization must retain an active owner.",
      status: "error",
    });
  });

  test("confirms an accepted change without naming any field", async () => {
    expect(
      await setOrganizationMemberAction(initialMemberActionState, accessForm()),
    ).toEqual({ message: "Member role updated.", status: "success" });
  });
});

/**
 * `getApplicationContext` signs an expired session out with `redirect()`, and
 * Next implements that by throwing. The action resolves it before it reads the
 * form now, so the throw arrives on the hot path of every call — and a catch
 * that mapped it would answer the reader with a permanent "could not be saved"
 * instead of sending them to sign in.
 */
describe("the framework's own control flow", () => {
  const controlFlow = [
    ["a redirect", "NEXT_REDIRECT;replace;/sign-in;307;"],
    ["a not-found", "NEXT_HTTP_ERROR_FALLBACK;404"],
  ] as const;

  for (const [name, digest] of controlFlow) {
    test(`lets ${name} thrown while resolving the session escape`, async () => {
      const thrown = Object.assign(new Error(digest.split(";")[0] as string), {
        digest,
      });
      members.contextThrows = thrown;

      await expect(
        setOrganizationMemberAction(initialMemberActionState, accessForm()),
      ).rejects.toBe(thrown);
    });
  }
});

/*
  Plan 13, F.2.7: each access form reaches the command the transport will
  reach — one command on the tenant bus per form, by name, with the signed-in
  person's command context, the organisation from the session, the fields
  from the form, and the version and key as the bus's meta.
*/
const invitationId = "00000000-0000-4000-8000-0000000000e1";

const cases = [
  {
    action: "setOrganizationMemberAction",
    run: setOrganizationMemberAction,
    command: "set_organization_member",
    form: {
      userId: "user_2",
      role: "member",
      status: "revoked",
      expectedVersion: "3",
    },
    input: { userId: "user_2", role: "member", status: "revoked" },
    expectedVersion: 3,
    message: "Access revoked.",
  },
  {
    action: "revokeInvitationAction",
    run: revokeInvitationAction,
    command: "revoke_organization_invitation",
    form: { invitationId, expectedVersion: "1" },
    input: { invitationId },
    expectedVersion: 1,
    message: "Invitation revoked.",
  },
  {
    action: "resendInvitationAction",
    run: resendInvitationAction,
    command: "resend_organization_invitation",
    form: { invitationId, expectedVersion: "1" },
    input: { invitationId },
    expectedVersion: 1,
    message: "Invitation resent.",
  },
] as const;

function submission(fields: Record<string, string>) {
  const data = new FormData();
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("each access form reaches its organisation administration command", () => {
  test("each access form names its own command, and the invitation form the one left", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(organizationAdministrationCommandInputSchemas)
        .filter((name) => name !== "invite_organization_member")
        .sort(),
    );
  });

  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s dispatches its command on the tenant bus, as the signed-in person",
    async (_, entry) => {
      const state = await entry.run(
        initialMemberActionState,
        submission(entry.form),
      );

      expect(state).toEqual({ status: "success", message: entry.message });
      expect(members.humanCommandContext).toHaveBeenCalledOnce();
      expect(members.humanCommandContext).toHaveBeenCalledWith(
        members.session,
        members.organization.id,
      );
      expect(members.execute).toHaveBeenCalledOnce();
      expect(members.execute.mock.calls[0]?.[0]).toStrictEqual({
        name: entry.command,
        context: members.commandContext,
        input: { organizationId: members.organization.id, ...entry.input },
        meta: { expectedVersion: entry.expectedVersion, idempotencyKey: key },
      });
      // The command the form names is one the bus holds, and it accepts what
      // the form sends.
      const definition = createCoreCommandRegistry().resolve(entry.command);
      expect(definition).toBeDefined();
      expect(() =>
        definition?.parse(members.execute.mock.calls[0]?.[0].input),
      ).not.toThrow();
    },
  );

  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s refuses a short key without reaching the bus",
    async (_, entry) => {
      const data = submission(entry.form);
      data.set("idempotencyKey", "short");
      const state = await entry.run(initialMemberActionState, data);

      expect(state).toMatchObject({
        status: "error",
        field: "idempotencyKey",
      });
      expect(members.execute).not.toHaveBeenCalled();
    },
  );
});

describe("resending an invitation (ruling 260)", () => {
  test("refreshes the members page after a resend, so the row carries its new version and fresh keys", async () => {
    vi.mocked(revalidatePath).mockClear();

    expect(
      await resendInvitationAction(
        initialMemberActionState,
        submission({ invitationId, expectedVersion: "1" }),
      ),
    ).toEqual({ message: "Invitation resent.", status: "success" });
    // Without the refresh the row keeps version 1 and its key, and a second
    // press would replay the first receipt: the toast, and no email.
    expect(revalidatePath).toHaveBeenCalledWith("/settings/members");
  });

  test("says an invitation that stopped being pending is no longer pending", async () => {
    members.execute.mockRejectedValue(
      new DomainError(
        "invalid_transition",
        "Only a pending invitation may be resent",
      ),
    );

    expect(
      await resendInvitationAction(
        initialMemberActionState,
        submission({ invitationId, expectedVersion: "1" }),
      ),
    ).toEqual({
      message: "That invitation is no longer pending.",
      status: "error",
    });
  });

  test("refuses an owner invitation to an admin with the access sentence, not the reason", async () => {
    members.execute.mockRejectedValue(
      new DomainError(
        "forbidden",
        "Only an owner may resend an owner invitation",
      ),
    );

    expect(
      await resendInvitationAction(
        initialMemberActionState,
        submission({ invitationId, expectedVersion: "1" }),
      ),
    ).toEqual({
      message: "You do not have permission to manage that access.",
      status: "error",
    });
  });
});

/*
  F.2.7, review round 1: a member change whose target is itself changing a
  member at the same moment can be ended by PostgreSQL as a deadlock victim
  (`40P01`), because the bus's `assertCurrent` holds each person's own
  membership `FOR SHARE` (organization-management-repository.ts,
  `lockOrganizationAccessChanges`). The victim's transaction is rolled back
  whole, receipt included, so the form sends the same command once more, with
  the same key; the rules then answer it against what the other change left.
  Nothing else is sent twice.
*/
function deadlockVictim() {
  // The shape the drivers throw: Drizzle's query error, the SQLSTATE on `cause`.
  return Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
  });
}

describe("a form whose command is ended as a deadlock victim", () => {
  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s sends the same command once more, with the same key, and answers the second attempt",
    async (_, entry) => {
      members.execute.mockRejectedValueOnce(deadlockVictim());

      const state = await entry.run(
        initialMemberActionState,
        submission(entry.form),
      );

      expect(state).toEqual({ status: "success", message: entry.message });
      expect(members.execute).toHaveBeenCalledTimes(2);
      expect(members.execute.mock.calls[1]?.[0]).toStrictEqual(
        members.execute.mock.calls[0]?.[0],
      );
      expect(members.execute.mock.calls[1]?.[0].meta).toStrictEqual({
        expectedVersion: entry.expectedVersion,
        idempotencyKey: key,
      });
    },
  );

  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s tries no third time, and answers the fixed failure",
    async (_, entry) => {
      members.execute
        .mockRejectedValueOnce(deadlockVictim())
        .mockRejectedValueOnce(deadlockVictim());

      expect(
        await entry.run(initialMemberActionState, submission(entry.form)),
      ).toEqual({
        status: "error",
        message: "The access change could not be saved.",
      });
      expect(members.execute).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    ["a refusal", new DomainError("forbidden", "no")],
    ["a conflict", new DomainError("version_conflict", "stale")],
    [
      "a serialization failure",
      Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("could not serialize"), {
          code: "40001",
        }),
      }),
    ],
    ["an unexplained failure", new Error("boom")],
  ])("sends nothing twice after %s", async (_, error) => {
    members.execute.mockRejectedValueOnce(error);

    await setOrganizationMemberAction(initialMemberActionState, accessForm());
    await revokeInvitationAction(
      initialMemberActionState,
      submission({ invitationId, expectedVersion: "1" }),
    );

    // The first call failed with `error`; the second, the revocation's, used
    // the default answer. Neither was repeated.
    expect(members.execute).toHaveBeenCalledTimes(2);
  });
});
