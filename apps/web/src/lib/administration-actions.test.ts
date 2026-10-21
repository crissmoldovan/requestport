import {
  AtomicCommandBus,
  type CommandReceiptRecord,
  createCoreCommandRegistry,
  DomainError,
  type FoundationRepository,
  OrganizationService,
  ProjectService,
  type TransactionManager,
} from "@requestport/domain";
import { APIError } from "better-auth";
import { describe, expect, test, vi } from "vitest";
import { InMemoryFoundationRepository } from "../../../../packages/domain/src/test-support/foundation-repository.js";

import { createAdministrationActions } from "./administration-actions.js";
import {
  ORGANIZATION_SWITCH_DESTINATION,
  sameOriginDestination,
} from "./organization-switch.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";

function form(entries: Record<string, string>) {
  const value = new FormData();
  for (const [key, entry] of Object.entries(entries)) value.set(key, entry);
  return value;
}

function seededRepository(role: "owner" | "admin" | "member" = "owner") {
  return new InMemoryFoundationRepository({
    state: {
      organizations: [
        {
          id: ORGANIZATION_ID,
          name: "CUE++",
          slug: "example-org",
          status: "active",
        },
        {
          id: OTHER_ORGANIZATION_ID,
          name: "Other",
          slug: "other",
          status: "active",
        },
      ],
      memberships: [
        {
          id: "membership_1",
          organizationId: ORGANIZATION_ID,
          userId: "user_actor",
          role,
          status: "active",
        },
      ],
    },
  });
}

/**
 * The invitation command on a bus whose one port is `repository`, keeping
 * receipts in memory: what `server-administration-actions.ts` wires, minus
 * the database. Invitations get UUIDs, as the database gives them, because
 * the invitation event's schema requires one.
 */
function invitationBus(repository: InMemoryFoundationRepository) {
  const foundation: FoundationRepository = {
    transaction: (run) =>
      repository.transaction((tx) =>
        run(
          Object.assign(Object.create(tx) as typeof tx, {
            async createInvitation(
              input: Parameters<typeof tx.createInvitation>[0],
            ) {
              const invitation = await tx.createInvitation(input);
              invitation.id = crypto.randomUUID();
              return invitation;
            },
          }),
        ),
      ),
  };
  const receipts = new Map<string, CommandReceiptRecord>();
  const transactions: TransactionManager = {
    run: (work) =>
      work({
        commandReceipts: {
          lock: async () => {},
          find: async (key) => receipts.get(JSON.stringify(key)) ?? null,
          save: async (record) => {
            receipts.set(
              JSON.stringify({
                actorFingerprint: record.actorFingerprint,
                commandName: record.commandName,
                idempotencyFingerprint: record.idempotencyFingerprint,
              }),
              record,
            );
          },
        },
        domainEvents: { append: async () => {} },
        port: <T>(name: string) => {
          if (name !== "foundation") throw new Error(`no port ${name}`);
          return foundation as T;
        },
      }),
  };
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions,
    fingerprintSecret: "administration-actions-test-secret",
  });
}

function harness({
  repository = seededRepository(),
  redirect = vi.fn<(path: "/" | "/settings/projects") => void>(),
  requireSession = vi.fn(async () => ({
    session: { id: "session_1", userId: "user_actor" },
    user: {
      id: "user_actor",
      email: "owner@example.com",
      name: "Owner",
      image: null,
    },
  })),
  dispatchCommittedCorrelation,
}: {
  repository?: InMemoryFoundationRepository;
  redirect?: (path: "/" | "/settings/projects") => void;
  requireSession?: () => Promise<unknown>;
  dispatchCommittedCorrelation?: (
    correlationId: string,
    organizationId: string,
  ) => Promise<void>;
} = {}) {
  const revalidatePath = vi.fn();
  const setOrganizationCookie = vi.fn();
  const currentOrganization = {
    id: ORGANIZATION_ID,
    name: "CUE++",
    slug: "example-org",
    role:
      repository.state.memberships.find(
        (membership) => membership.userId === "user_actor",
      )?.role ?? "member",
  } as const;
  const findActiveOrganizationForUser = vi.fn(
    async (userId: string, organizationId: string) =>
      userId === "user_actor" && organizationId === ORGANIZATION_ID
        ? currentOrganization
        : null,
  );
  const createCorrelationId = vi.fn(
    () => "00000000-0000-4000-8000-000000000010",
  );
  const getCurrentOrganization = vi.fn(async () => currentOrganization);
  const invitations = invitationBus(repository);
  const inviteMember = vi.fn(
    async (input: {
      session: { user: { id: string }; session: { id: string } };
      organizationId: string;
      email: string;
      role: string;
    }) =>
      invitations.execute<unknown, { created: boolean }>({
        name: "invite_organization_member",
        context: {
          actor: { type: "user", id: input.session.user.id },
          organizationId: input.organizationId,
          scopes: new Set(["members:manage"]),
          credentialId: input.session.session.id,
          correlationId: "00000000-0000-4000-8000-000000000011",
        },
        input: {
          organizationId: input.organizationId,
          email: input.email,
          role: input.role,
        },
        meta: { expectedVersion: 0, idempotencyKey: crypto.randomUUID() },
      }),
  );
  const actions = createAdministrationActions({
    createCorrelationId,
    ...(dispatchCommittedCorrelation ? { dispatchCommittedCorrelation } : {}),
    findActiveOrganizationForUser,
    getCurrentOrganization,
    inviteMember,
    isUnauthenticatedError: (error) =>
      error instanceof APIError && error.status === "UNAUTHORIZED",
    organizationService: new OrganizationService({
      repository,
      invitationTokenHash: () => "sha256:test-only-token-hash",
    }),
    projectService: new ProjectService(repository),
    redirect,
    requireSession,
    revalidatePath,
    setOrganizationCookie,
  });
  return {
    actions,
    createCorrelationId,
    findActiveOrganizationForUser,
    getCurrentOrganization,
    inviteMember,
    redirect,
    repository,
    revalidatePath,
    setOrganizationCookie,
  };
}

describe("administration action composition", () => {
  test("hands each committed correlation to dispatch with the organisation it committed in (D5)", async () => {
    // Dispatch reads the correlation's outbox rows bound to this
    // organisation. The wrong one would find no rows under the application
    // role, and the failure would be swallowed: the rows would wait for the
    // repair sweep. So the organisation is asserted, not only the call.
    // Seeded, so the new organisation's id is not the current one's.
    const repository = seededRepository();
    const created = vi.fn(async (_c: string, _o: string) => undefined);
    const creating = harness({
      repository,
      dispatchCommittedCorrelation: created,
    });

    await expect(
      creating.actions.createOrganization(
        form({
          name: "New organization",
          organizationId: OTHER_ORGANIZATION_ID,
          slug: "new-organization",
        }),
      ),
    ).resolves.toMatchObject({ status: "success" });
    const newOrganizationId = repository.state.organizations.find(
      (organization) => organization.slug === "new-organization",
    )?.id;

    expect(newOrganizationId).toBeDefined();
    expect(newOrganizationId).not.toBe(ORGANIZATION_ID);
    expect(created.mock.calls).toEqual([
      ["00000000-0000-4000-8000-000000000010", newOrganizationId],
    ]);

    const dispatched = vi.fn(async (_c: string, _o: string) => undefined);
    const h = harness({ dispatchCommittedCorrelation: dispatched });

    await expect(
      h.actions.createProject(
        form({
          keyPrefix: "RQP",
          name: "RequestPort",
          organizationId: OTHER_ORGANIZATION_ID,
          repositoryUrl: "https://github.com/example-org/requestport",
          slug: "requestport",
        }),
      ),
    ).resolves.toMatchObject({ status: "success" });
    expect(dispatched.mock.calls).toEqual([
      ["00000000-0000-4000-8000-000000000010", ORGANIZATION_ID],
    ]);

    // An invitation runs on the tenant bus (F.2.7), whose own afterCommit
    // dispatches its events bound to their organisation
    // (`server-core-commands.test.ts`), so it adds no correlation dispatch.
    await expect(
      h.actions.inviteMember(
        form({
          email: "invite-dispatch@example.invalid",
          organizationId: OTHER_ORGANIZATION_ID,
          role: "member",
        }),
      ),
    ).resolves.toMatchObject({ status: "success" });
    expect(dispatched.mock.calls).toHaveLength(1);
  });

  test("redacts an unauthenticated mutation and produces no side effect", async () => {
    const h = harness({
      requireSession: vi.fn(async () => {
        throw new APIError("UNAUTHORIZED", {
          code: "unauthorized",
          message: "provider session detail",
        });
      }),
    });

    await expect(
      h.actions.createOrganization(
        form({ name: "Spoofed", slug: "spoofed", userId: "user_attacker" }),
      ),
    ).resolves.toMatchObject({ status: "error", code: "unauthenticated" });
    expect(
      JSON.stringify(await h.actions.createOrganization(form({}))),
    ).not.toContain("provider session detail");
    expect(h.repository.state.organizations).toHaveLength(2);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("redacts an unknown session dependency failure without misclassifying it as unauthenticated", async () => {
    const h = harness({
      requireSession: vi.fn(async () => {
        throw new Error("postgres://secret@host/session lookup failed");
      }),
    });

    const result = await h.actions.createOrganization(
      form({ name: "Unavailable", slug: "unavailable" }),
    );

    expect(result).toEqual({
      status: "error",
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(h.repository.state.organizations).toHaveLength(2);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("creates the first organization for the authenticated actor and ignores client actor or tenant spoofing", async () => {
    const repository = new InMemoryFoundationRepository();
    const h = harness({ repository });

    await expect(
      h.actions.createOrganization(
        form({
          name: "New organization",
          organizationId: OTHER_ORGANIZATION_ID,
          slug: "new-organization",
          userId: "user_attacker",
        }),
      ),
    ).resolves.toMatchObject({ status: "success" });
    expect(repository.state.memberships).toEqual([
      expect.objectContaining({
        organizationId: repository.state.organizations[0]?.id,
        role: "owner",
        userId: "user_actor",
      }),
    ]);
    expect(h.setOrganizationCookie).toHaveBeenCalledWith(
      repository.state.organizations[0]?.id,
    );
    // A creation makes the new organization the current tenant, so it changes
    // the appearance triple the next document resolves. Revalidating or
    // redirecting from the action would hand that change to the router, which
    // would adopt it during a client transition in the open document — the
    // boundary 646f693 moved the switch off. The destination travels back
    // instead, and the client navigates the whole document to it.
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("creates successfully even when revalidation would throw, because it never revalidates", async () => {
    const h = harness({ repository: new InMemoryFoundationRepository() });
    h.revalidatePath.mockImplementation(() => {
      throw new Error("revalidation secret detail");
    });

    await expect(
      h.actions.createOrganization(
        form({ name: "New organization", slug: "new-organization" }),
      ),
    ).resolves.toEqual({
      destination: "/",
      message: "Organization created.",
      status: "success",
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test.each(["owner", "admin"] as const)(
    "allows an active %s to create a project and ignores a submitted foreign organization",
    async (role) => {
      const h = harness({ repository: seededRepository(role) });

      await expect(
        h.actions.createProject(
          form({
            keyPrefix: "RQP",
            name: "RequestPort",
            organizationId: OTHER_ORGANIZATION_ID,
            repositoryUrl: "https://github.com/example-org/requestport",
            slug: "requestport",
          }),
        ),
      ).resolves.toMatchObject({ status: "success" });
      expect(h.repository.state.projects[0]?.organizationId).toBe(
        ORGANIZATION_ID,
      );
      expect(h.revalidatePath).toHaveBeenCalledWith("/settings/projects");
      expect(h.redirect).toHaveBeenCalledWith("/settings/projects");
    },
  );

  test("denies a member project mutation without redirect or revalidation", async () => {
    const h = harness({ repository: seededRepository("member") });

    await expect(
      h.actions.createProject(
        form({
          keyPrefix: "DEN",
          name: "Denied",
          slug: "denied",
        }),
      ),
    ).resolves.toMatchObject({ status: "error", code: "forbidden" });
    expect(h.repository.state.projects).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test.each([
    [
      new DomainError("conflict", "raw duplicate detail", { field: "slug" }),
      "conflict",
      "slug",
    ],
    [
      new DomainError("conflict", "raw duplicate detail", {
        field: "keyPrefix",
      }),
      "conflict",
      "keyPrefix",
    ],
  ])(
    "maps duplicate project fields without leaking raw errors",
    async (error, code, field) => {
      const h = harness();
      const create = vi
        .spyOn(ProjectService.prototype, "create")
        .mockRejectedValueOnce(error);

      const result = await h.actions.createProject(
        form({ keyPrefix: "DUP", name: "Duplicate", slug: "duplicate" }),
      );

      expect(result).toMatchObject({ status: "error", code, field });
      expect(JSON.stringify(result)).not.toContain("raw duplicate detail");
      expect(h.revalidatePath).not.toHaveBeenCalled();
      expect(h.redirect).not.toHaveBeenCalled();
      create.mockRestore();
    },
  );

  test.each([
    "https://github.com.evil.example/example-org/requestport",
    "https://user:secret@github.com/example-org/requestport",
    "https://github.com/example-org/requestport?token=secret",
  ])("maps adversarial GitHub URL validation safely", async (repositoryUrl) => {
    const h = harness();
    const result = await h.actions.createProject(
      form({
        keyPrefix: "BAD",
        name: "Bad URL",
        repositoryUrl,
        slug: "bad-url",
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      code: "validation_failed",
      field: "repositoryUrl",
    });
    expect(JSON.stringify(result)).not.toContain(repositoryUrl);
  });

  test.each([
    ["owner", "owner", "success"],
    ["owner", "admin", "success"],
    ["admin", "member", "success"],
    ["admin", "owner", "error"],
    ["member", "member", "error"],
  ] as const)(
    "applies invitation policy for %s inviting %s",
    async (actorRole, role, expectedStatus) => {
      const h = harness({ repository: seededRepository(actorRole) });
      const result = await h.actions.inviteMember(
        form({
          email: `invite-${actorRole}-${role}@example.invalid`,
          organizationId: OTHER_ORGANIZATION_ID,
          role,
        }),
      );

      expect(result.status).toBe(expectedStatus);
      expect(h.repository.state.invitations).toHaveLength(
        expectedStatus === "success" ? 1 : 0,
      );
    },
  );

  test("says plainly, on the email field, that an address with an account cannot be invited back", async () => {
    const h = harness();
    await expect(
      h.actions.inviteMember(
        form({ email: "person@example.invalid", role: "member" }),
      ),
    ).resolves.toMatchObject({ status: "success" });
    const stored = h.repository.state.invitations[0];
    if (!stored) throw new Error("Missing test invitation");
    stored.revokedAt = h.repository.now();
    h.repository.state.users.push({
      id: "user_person",
      normalizedEmail: "person@example.invalid",
    });
    const before = { ...stored };

    const result = await h.actions.inviteMember(
      form({ email: "person@example.invalid", role: "member" }),
    );

    expect(result).toEqual({
      status: "error",
      code: "conflict",
      field: "email",
      message:
        "This person already has a RequestPort account. Inviting an existing account is not supported yet, so no invitation was sent.",
    });
    expect(h.repository.state.invitations).toEqual([before]);
    expect(h.repository.state.audits).toHaveLength(1);
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
  });

  test("says the same on a first invitation to an address with an account, and reports a renewal as a new invitation", async () => {
    const h = harness();
    h.repository.state.users.push({
      id: "user_known",
      normalizedEmail: "known@example.invalid",
    });
    await expect(
      h.actions.inviteMember(
        form({ email: "known@example.invalid", role: "member" }),
      ),
    ).resolves.toEqual({
      status: "error",
      code: "conflict",
      field: "email",
      message:
        "This person already has a RequestPort account. Inviting an existing account is not supported yet, so no invitation was sent.",
    });
    expect(h.repository.state.invitations).toEqual([]);
    expect(h.repository.state.audits).toEqual([]);

    await h.actions.inviteMember(
      form({ email: "new@example.invalid", role: "member" }),
    );
    const stored = h.repository.state.invitations[0];
    if (!stored) throw new Error("Missing test invitation");
    stored.revokedAt = h.repository.now();
    await expect(
      h.actions.inviteMember(
        form({ email: "new@example.invalid", role: "admin" }),
      ),
    ).resolves.toEqual({
      status: "success",
      message: "Invitation created and queued for email.",
    });
    expect(h.repository.state.invitations).toEqual([
      expect.objectContaining({ role: "admin", revokedAt: null, version: 2 }),
    ]);
    expect(h.repository.state.audits.map((audit) => audit.action)).toEqual([
      "organization.invitation_created",
      "organization.invitation_renewed",
    ]);
  });

  test("refuses malformed and unjoined organization switches without writing a cookie", async () => {
    const h = harness();

    await expect(
      h.actions.switchOrganization(form({ organizationId: "bad-id" })),
    ).resolves.toMatchObject({ status: "error", code: "validation_failed" });
    await expect(
      h.actions.switchOrganization(
        form({ organizationId: OTHER_ORGANIZATION_ID }),
      ),
    ).resolves.toMatchObject({ status: "error", code: "forbidden" });
    expect(h.setOrganizationCookie).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("sets the hardened tenant preference only after a successful organization switch", async () => {
    const h = harness();

    await expect(
      h.actions.switchOrganization(
        form({
          organizationId: ORGANIZATION_ID,
          redirectTo: "https://evil.example",
          returnTo: "https://evil.example/steal",
        }),
      ),
    ).resolves.toEqual({
      destination: ORGANIZATION_SWITCH_DESTINATION,
      message: "Organization switched.",
      status: "success",
    });
    expect(h.setOrganizationCookie).toHaveBeenCalledWith(ORGANIZATION_ID);
    // The switch neither redirects nor revalidates from the server, and it is
    // served from a Route Handler rather than a Server Action — see
    // `organization-switch.test.ts`, which pins that boundary. The client owns
    // the full-document navigation, so the new document resolves appearance for
    // the organization it is switching to before it paints.
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test.each([
    ["https://evil.example/steal", ORGANIZATION_SWITCH_DESTINATION],
    ["//evil.example/steal", ORGANIZATION_SWITCH_DESTINATION],
    ["/\\evil.example", ORGANIZATION_SWITCH_DESTINATION],
    ["javascript:alert(1)", ORGANIZATION_SWITCH_DESTINATION],
    ["requests", ORGANIZATION_SWITCH_DESTINATION],
    ["", ORGANIZATION_SWITCH_DESTINATION],
    [`/${"x".repeat(600)}`, ORGANIZATION_SWITCH_DESTINATION],
    ["/requests?view=inbox", "/requests?view=inbox"],
    ["/", "/"],
  ])(
    "resolves the post-switch destination %s to a same-origin path",
    (candidate, expected) => {
      expect(sameOriginDestination(candidate)).toBe(expected);
    },
  );

  test("redacts unknown mutation failures and only revalidates or redirects successful commits", async () => {
    const h = harness();
    const create = vi
      .spyOn(ProjectService.prototype, "create")
      .mockRejectedValueOnce(new Error("postgres://secret@host/internal sql"));

    const result = await h.actions.createProject(
      form({ keyPrefix: "ERR", name: "Failure", slug: "failure" }),
    );

    expect(result).toEqual({
      status: "error",
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
    create.mockRestore();
  });

  test.each([
    [
      "project",
      (h: ReturnType<typeof harness>) =>
        h.actions.createProject(
          form({ keyPrefix: "DEP", name: "Dependency", slug: "dependency" }),
        ),
    ],
    [
      "invitation",
      (h: ReturnType<typeof harness>) =>
        h.actions.inviteMember(
          form({ email: "dependency@example.invalid", role: "member" }),
        ),
    ],
  ] as const)(
    "redacts an unknown current-organization dependency failure for %s actions",
    async (_name, run) => {
      const h = harness();
      h.getCurrentOrganization.mockRejectedValueOnce(
        new Error("postgres://secret@host/tenant lookup"),
      );

      const result = await run(h);

      expect(result).toEqual({
        status: "error",
        code: "unexpected_error",
        message: "RequestPort could not complete that action.",
      });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(h.repository.state.projects).toEqual([]);
      expect(h.repository.state.invitations).toEqual([]);
      expect(h.revalidatePath).not.toHaveBeenCalled();
      expect(h.redirect).not.toHaveBeenCalled();
    },
  );

  test("redacts organization cookie failures without claiming post-commit navigation success", async () => {
    const createHarness = harness({
      repository: new InMemoryFoundationRepository(),
    });
    createHarness.setOrganizationCookie.mockRejectedValueOnce(
      new Error("cookie secret detail"),
    );

    const createResult = await createHarness.actions.createOrganization(
      form({ name: "Committed organization", slug: "committed-organization" }),
    );

    expect(createResult).toEqual({
      status: "error",
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
    });
    expect(JSON.stringify(createResult)).not.toContain("secret");
    expect(createHarness.repository.state.organizations).toHaveLength(1);
    expect(createHarness.revalidatePath).not.toHaveBeenCalled();
    expect(createHarness.redirect).not.toHaveBeenCalled();

    const switchHarness = harness();
    switchHarness.setOrganizationCookie.mockRejectedValueOnce(
      new Error("cookie secret detail"),
    );
    const switchResult = await switchHarness.actions.switchOrganization(
      form({ organizationId: ORGANIZATION_ID }),
    );

    expect(switchResult).toEqual({
      status: "error",
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
    });
    expect(JSON.stringify(switchResult)).not.toContain("secret");
    expect(switchHarness.revalidatePath).not.toHaveBeenCalled();
    expect(switchHarness.redirect).not.toHaveBeenCalled();
  });

  test.each([
    [
      "project",
      () => {
        const h = harness();
        return {
          h,
          run: () =>
            h.actions.createProject(
              form({
                keyPrefix: "REV",
                name: "Revalidate",
                slug: "revalidate",
              }),
            ),
        };
      },
    ],
    [
      "invitation",
      () => {
        const h = harness();
        return {
          h,
          run: () =>
            h.actions.inviteMember(
              form({ email: "revalidate@example.invalid", role: "member" }),
            ),
        };
      },
    ],
  ] as const)(
    "redacts %s revalidation failures and never enters redirect control flow",
    async (_name, setup) => {
      const { h, run } = setup();
      h.revalidatePath.mockImplementationOnce(() => {
        throw new Error("revalidation secret detail");
      });

      const result = await run();

      expect(result).toEqual({
        status: "error",
        code: "unexpected_error",
        message: "RequestPort could not complete that action.",
      });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(h.redirect).not.toHaveBeenCalled();
    },
  );

  test("switches successfully even when revalidation would throw, because it never revalidates", async () => {
    const h = harness();
    h.revalidatePath.mockImplementation(() => {
      throw new Error("revalidation secret detail");
    });

    await expect(
      h.actions.switchOrganization(form({ organizationId: ORGANIZATION_ID })),
    ).resolves.toEqual({
      destination: ORGANIZATION_SWITCH_DESTINATION,
      message: "Organization switched.",
      status: "success",
    });
    expect(h.setOrganizationCookie).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("redacts correlation-id generation failures before a command begins", async () => {
    const h = harness();
    h.createCorrelationId.mockImplementationOnce(() => {
      throw new Error("correlation secret detail");
    });

    const result = await h.actions.createProject(
      form({ keyPrefix: "CID", name: "Correlation", slug: "correlation" }),
    );

    expect(result).toEqual({
      status: "error",
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(h.repository.state.projects).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("lets the framework redirect control-flow escape after a committed mutation", async () => {
    const redirect = vi.fn(() => {
      throw new Error("NEXT_REDIRECT");
    });
    const h = harness({ redirect });

    await expect(
      h.actions.createProject(
        form({ keyPrefix: "NAV", name: "Navigation", slug: "navigation" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(h.repository.state.projects).toHaveLength(1);
    expect(h.revalidatePath).toHaveBeenCalledWith("/settings/projects");
  });

  /*
    Plan 13, F.2.7: the invitation form runs `invite_organization_member`
    through the injected `inviteMember`, which `server-administration-actions.ts`
    wires to the tenant bus. The bus, not this module, dispatches the
    invitation's outbox row after it commits.
  */
  test("hands inviteMember the session it resolved, the current organisation and the parsed invitation, once", async () => {
    const dispatchCommittedCorrelation = vi.fn(async () => {});
    const h = harness();
    const actions = createAdministrationActions({
      createCorrelationId: h.createCorrelationId,
      dispatchCommittedCorrelation,
      findActiveOrganizationForUser: h.findActiveOrganizationForUser,
      getCurrentOrganization: h.getCurrentOrganization,
      inviteMember: h.inviteMember,
      isUnauthenticatedError: () => false,
      organizationService: new OrganizationService({
        repository: h.repository,
      }),
      projectService: new ProjectService(h.repository),
      redirect: h.redirect,
      requireSession: async () => session,
      revalidatePath: h.revalidatePath,
      setOrganizationCookie: h.setOrganizationCookie,
    });
    const session = {
      session: { id: "session_1", userId: "user_actor" },
      user: {
        id: "user_actor",
        email: "owner@example.com",
        name: "Owner",
        image: null,
      },
    };

    await expect(
      actions.inviteMember(
        form({
          email: "invited@example.invalid",
          role: "admin",
          organizationId: OTHER_ORGANIZATION_ID,
        }),
      ),
    ).resolves.toEqual({
      status: "success",
      message: "Invitation created and queued for email.",
    });
    expect(h.inviteMember).toHaveBeenCalledOnce();
    expect(h.inviteMember.mock.calls[0]?.[0]).toStrictEqual({
      session,
      organizationId: ORGANIZATION_ID,
      email: "invited@example.invalid",
      role: "admin",
    });
    expect(h.inviteMember.mock.calls[0]?.[0].session).toBe(session);
    expect(dispatchCommittedCorrelation).not.toHaveBeenCalled();
    expect(h.revalidatePath).toHaveBeenCalledWith("/settings/members");
  });

  test("answers an active matching invitation as it always has, writing no second one", async () => {
    const h = harness();
    const submit = () =>
      h.actions.inviteMember(
        form({ email: "again@example.invalid", role: "member" }),
      );

    await expect(submit()).resolves.toMatchObject({
      message: "Invitation created and queued for email.",
    });
    await expect(submit()).resolves.toEqual({
      status: "success",
      message: "An active matching invitation already exists.",
    });
    expect(h.repository.state.invitations).toHaveLength(1);
  });

  // Until X15 the command named `role` here; a pending address is now
  // refused on `email`, reason `already_invited`, with the generic sentence.
  test("addresses the command's conflict on a pending address to the email control", async () => {
    const h = harness();
    await h.actions.inviteMember(
      form({ email: "role@example.invalid", role: "member" }),
    );

    await expect(
      h.actions.inviteMember(
        form({ email: "role@example.invalid", role: "admin" }),
      ),
    ).resolves.toEqual({
      status: "error",
      code: "conflict",
      field: "email",
      message: "That canonical value is already in use.",
    });
  });

  test("answers a session with no session id as unauthenticated, without reaching the command", async () => {
    const h = harness({
      requireSession: async () => ({ user: { id: "user_actor" } }),
    });

    await expect(
      h.actions.inviteMember(
        form({ email: "nosession@example.invalid", role: "member" }),
      ),
    ).resolves.toEqual({
      status: "error",
      code: "unauthenticated",
      message: "Sign in to continue.",
    });
    expect(h.inviteMember).not.toHaveBeenCalled();
    expect(h.getCurrentOrganization).not.toHaveBeenCalled();
  });
});
