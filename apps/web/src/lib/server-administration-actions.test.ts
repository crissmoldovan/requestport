import { createCoreCommandRegistry } from "@requestport/domain";
import { APIError } from "better-auth";
import { beforeEach, describe, expect, test, vi } from "vitest";

/*
  Plan 13, F.2.7: the invitation form's wiring. `administrationActions`
  reaches `invite_organization_member` on the tenant bus — the command the
  transport will reach — with the signed-in person's command context, the
  current organisation, the parsed address and role, and a key minted for the
  submission at version 0.
*/

const wiring = vi.hoisted(() => ({
  session: {
    session: { id: "session-under-test", userId: "user_actor" },
    user: {
      id: "user_actor",
      email: "owner@example.com",
      name: "Owner",
      image: null,
    },
  },
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  },
  commandContext: {
    actor: { type: "user", id: "user_actor" },
    organizationId: "00000000-0000-4000-8000-0000000000d1",
    credentialId: "session-under-test",
    correlationId: "correlation-under-test",
    scopes: new Set(["members:manage"]),
  },
  requireHumanSession: vi.fn(),
  execute: vi.fn(),
  humanCommandContext: vi.fn(),
  dispatchCommittedCorrelation: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@requestport/auth/server", () => ({
  requireHumanSession: (headers: Headers) =>
    wiring.requireHumanSession(headers),
}));

vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({}),
  createFoundationRepository: () => ({}),
}));
// The web root, whose storage the composition's repositories are built over
// when they run (Plan 13, G.3).
vi.mock("./server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: wiring.revalidatePath }));
vi.mock("next/headers", () => ({
  cookies: async () => ({}),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

vi.mock("./organization-cookie.js", () => ({
  writeCurrentOrganizationCookie: vi.fn(),
}));
vi.mock("./security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));
vi.mock("./server-application-context.js", () => ({
  getCurrentOrganizationForUser: async () => wiring.organization,
  raiseScenarioConflict: () => {},
}));
vi.mock("./server-scenario-boundary.js", () => ({
  readE2EScenarioRequest: async () => ({ fault: null }),
}));
vi.mock("./server-core-commands.js", () => ({
  coreCommandBus: { execute: wiring.execute },
  humanCommandContext: wiring.humanCommandContext,
}));
// The correlation dispatch the composition hands its other actions, which
// reads and dispatches bound to the organisation (manifest-i2.md D5).
vi.mock("./trigger-client.js", () => ({
  dispatchCommittedCorrelation: wiring.dispatchCommittedCorrelation,
}));

const { administrationActions } = await import(
  "./server-administration-actions.js"
);

function invitation(email: string, role: string) {
  const data = new FormData();
  data.set("email", email);
  data.set("role", role);
  return data;
}

beforeEach(() => {
  wiring.requireHumanSession.mockReset();
  wiring.requireHumanSession.mockImplementation(async () => wiring.session);
  wiring.execute.mockReset();
  wiring.execute.mockResolvedValue({ created: true });
  wiring.humanCommandContext.mockReset();
  wiring.humanCommandContext.mockReturnValue(wiring.commandContext);
  wiring.dispatchCommittedCorrelation.mockReset();
  wiring.revalidatePath.mockReset();
});

describe("the invitation form reaches invite_organization_member", () => {
  test("one command on the tenant bus, as the signed-in person, at version 0 with a minted key", async () => {
    await expect(
      administrationActions.inviteMember(
        invitation("invited@example.invalid", "admin"),
      ),
    ).resolves.toEqual({
      status: "success",
      message: "Invitation created and queued for email.",
    });

    expect(wiring.humanCommandContext).toHaveBeenCalledOnce();
    expect(wiring.humanCommandContext).toHaveBeenCalledWith(
      wiring.session,
      wiring.organization.id,
    );
    expect(wiring.execute).toHaveBeenCalledOnce();
    const call = wiring.execute.mock.calls[0]?.[0];
    expect(call).toStrictEqual({
      name: "invite_organization_member",
      context: wiring.commandContext,
      input: {
        organizationId: wiring.organization.id,
        email: "invited@example.invalid",
        role: "admin",
      },
      meta: { expectedVersion: 0, idempotencyKey: expect.any(String) },
    });
    expect(call.meta.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    // The command the form names is one the bus holds, and it accepts what
    // the form sends.
    const definition = createCoreCommandRegistry().resolve(call.name);
    expect(definition).toBeDefined();
    expect(() => definition?.parse(call.input)).not.toThrow();
    // The bus dispatches the invitation's outbox row after it commits; the
    // form no longer dispatches by correlation.
    expect(wiring.dispatchCommittedCorrelation).not.toHaveBeenCalled();
    expect(wiring.revalidatePath).toHaveBeenCalledWith("/settings/members");
  });

  test("mints a new key for every submission", async () => {
    await administrationActions.inviteMember(
      invitation("first@example.invalid", "member"),
    );
    await administrationActions.inviteMember(
      invitation("first@example.invalid", "member"),
    );

    const [first, second] = wiring.execute.mock.calls.map(
      (entry) => entry[0].meta.idempotencyKey,
    );
    expect(first).not.toBe(second);
  });

  test("answers the command's created false as an existing invitation", async () => {
    wiring.execute.mockResolvedValue({ created: false });

    await expect(
      administrationActions.inviteMember(
        invitation("again@example.invalid", "member"),
      ),
    ).resolves.toEqual({
      status: "success",
      message: "An active matching invitation already exists.",
    });
  });
});

/** Better Auth's APIError as another copy of `better-auth` builds it: another class, with the same name and status. */
class AnotherCopysAPIError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(status.toLowerCase());
    this.name = "APIError";
    this.status = status;
  }
}

/*
  Where the host's handoff is set, `requireHumanSession` is a member of the
  Better Auth the handoff carries (Plan 13, H.5; manifest-h.md §2.7.1), so the
  APIError it refuses with comes from the host's copy of `better-auth`, not
  the one Next bundles. `isUnauthenticatedError` reads its name and status.
*/
describe("a refused session is read by Better Auth's error name and status", () => {
  const unauthenticated = {
    status: "error",
    code: "unauthenticated",
    message: "Sign in to continue.",
  };

  test.each([
    [
      "Better Auth's own APIError",
      () =>
        new APIError("UNAUTHORIZED", {
          code: "unauthorized",
          message: "unauthorized",
        }),
    ],
    ["another copy's APIError", () => new AnotherCopysAPIError("UNAUTHORIZED")],
    [
      "a plain object named APIError",
      () => ({ name: "APIError", status: "UNAUTHORIZED" }),
    ],
  ])(
    "answers %s with the status UNAUTHORIZED as unauthenticated, and runs no command",
    async (_label, refusal) => {
      wiring.requireHumanSession.mockImplementation(async () => {
        throw refusal();
      });

      await expect(
        administrationActions.inviteMember(
          invitation("invited@example.invalid", "member"),
        ),
      ).resolves.toEqual(unauthenticated);
      expect(wiring.execute).not.toHaveBeenCalled();
    },
  );

  test("answers an APIError with another status as unexpected, as before", async () => {
    wiring.requireHumanSession.mockImplementation(async () => {
      throw new APIError("FORBIDDEN", { message: "forbidden" });
    });

    await expect(
      administrationActions.inviteMember(
        invitation("invited@example.invalid", "member"),
      ),
    ).resolves.toEqual({
      status: "error",
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
    });
    expect(wiring.execute).not.toHaveBeenCalled();
  });
});
