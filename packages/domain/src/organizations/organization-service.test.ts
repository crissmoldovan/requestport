import { describe, expect, test } from "vitest";

import { DomainError } from "../shared/errors.js";
import { InMemoryFoundationRepository } from "../test-support/foundation-repository.js";
import { verifyLocalCredential } from "./local-credential.js";
import {
  BOOTSTRAP_OWNER_ACTOR,
  type BootstrapOwnerTransaction,
  bootstrapOwner,
  OrganizationService,
} from "./organization-service.js";

const userContext = (userId = "user_owner") => ({
  actor: { type: "user" as const, userId },
  correlationId: "corr_test",
});
const unauthenticatedContext = {
  actor: { type: "unauthenticated" as const },
  correlationId: "corr_test",
};
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";

function service(repository: InMemoryFoundationRepository) {
  return new OrganizationService({
    repository,
    invitationTokenHash: () => "sha256:test-only-random-token-hash",
  });
}

describe("OrganizationService.create", () => {
  test("creates a normalized organization, active owner membership, and one atomic audit", async () => {
    const repository = new InMemoryFoundationRepository();

    const result = await service(repository).create(userContext(), {
      name: "  CUE++  ",
      slug: "  Example-Org  ",
    });

    expect(result).toMatchObject({ name: "CUE++", slug: "example-org" });
    expect(repository.state.memberships).toEqual([
      expect.objectContaining({
        organizationId: result.id,
        userId: "user_owner",
        role: "owner",
        status: "active",
      }),
    ]);
    expect(repository.state.audits).toEqual([
      {
        organizationId: result.id,
        actor: { type: "user", userId: "user_owner" },
        action: "organization.created",
        targetType: "organization",
        targetId: result.id,
        reason: "Organization created",
        fieldNames: ["name", "slug"],
        correlationId: "corr_test",
      },
    ]);
  });

  test("denies unauthenticated and system actors", async () => {
    const repository = new InMemoryFoundationRepository();

    await expect(
      service(repository).create(unauthenticatedContext, {
        name: "Denied",
        slug: "denied",
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      service(repository).create(
        { actor: BOOTSTRAP_OWNER_ACTOR, correlationId: "corr_system" },
        { name: "Denied", slug: "denied" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.state.organizations).toEqual([]);
  });

  test.each([
    [{ name: "", slug: "valid" }, "name"],
    [{ name: "x".repeat(121), slug: "valid" }, "name"],
    [{ name: "Valid", slug: "" }, "slug"],
    [{ name: "Valid", slug: "settings" }, "slug"],
    [{ name: "Valid", slug: "two words" }, "slug"],
    [{ name: "Valid", slug: "double--dash" }, "slug"],
    [{ name: "Unsafe\u0000name", slug: "valid" }, "name"],
  ])("rejects invalid organization input %j", async (input, field) => {
    const repository = new InMemoryFoundationRepository();
    await expect(
      service(repository).create(userContext(), input),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field },
    });
  });

  test("rolls back state when audit persistence fails", async () => {
    const repository = new InMemoryFoundationRepository();
    repository.failOn = "appendAuditRecord";

    await expect(
      service(repository).create(userContext(), {
        name: "Atomic",
        slug: "atomic",
      }),
    ).rejects.toThrow("failed:appendAuditRecord");
    expect(repository.state.organizations).toEqual([]);
    expect(repository.state.memberships).toEqual([]);
    expect(repository.state.audits).toEqual([]);
  });

  test.each([
    [
      { actor: { type: "user" as const, userId: "" }, correlationId: "corr" },
      "userId",
    ],
    [
      { actor: { type: "user" as const, userId: "user_1" }, correlationId: "" },
      "correlationId",
    ],
    [
      {
        actor: { type: "user" as const, userId: "user with spaces" },
        correlationId: "corr",
      },
      "userId",
    ],
  ])("rejects malformed trusted command context", async (context, field) => {
    await expect(
      service(new InMemoryFoundationRepository()).create(context, {
        name: "Context",
        slug: "context",
      }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field } });
  });

  test.each([
    [null, "context"],
    [undefined, "context"],
    [{ actor: null, correlationId: "corr" }, "actor"],
    [
      {
        actor: { type: "user", userId: null },
        correlationId: "corr",
      },
      "userId",
    ],
  ])(
    "rejects malformed nested command context %j safely",
    async (context, field) => {
      await expect(
        service(new InMemoryFoundationRepository()).create(context as never, {
          name: "Context",
          slug: "context",
        }),
      ).rejects.toMatchObject({
        code: "validation_failed",
        details: { field },
      });
    },
  );

  test.each([
    [null, "input"],
    [undefined, "input"],
    [42, "input"],
    [{ name: null, slug: "valid" }, "name"],
    [{ name: "Valid", slug: undefined }, "slug"],
  ])("rejects malformed organization input %j safely", async (input, field) => {
    await expect(
      service(new InMemoryFoundationRepository()).create(
        userContext(),
        input as never,
      ),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field } });
  });
});

describe("OrganizationService.inviteUser", () => {
  const seeded = (
    role: "owner" | "admin" | "member",
    status: "active" | "revoked" = "active",
    organizationStatus: "active" | "suspended" | "archived" = "active",
  ) =>
    new InMemoryFoundationRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "CUE++",
            slug: "cue",
            status: organizationStatus,
          },
        ],
        memberships: [
          {
            id: "membership_1",
            organizationId: ORGANIZATION_ID,
            userId: "user_actor",
            role,
            status,
          },
        ],
      },
    });

  test.each([
    ["owner", "owner"],
    ["owner", "admin"],
    ["owner", "member"],
    ["admin", "admin"],
    ["admin", "member"],
  ] as const)("allows %s to invite %s", async (actorRole, invitedRole) => {
    const repository = seeded(actorRole);
    const result = await service(repository).inviteUser(
      userContext("user_actor"),
      {
        organizationId: ORGANIZATION_ID,
        email: "  INVITÉ@Example.COM  ",
        role: invitedRole,
      },
    );

    expect(result).toMatchObject({
      created: true,
      invitation: {
        normalizedEmail: "invité@example.com",
        role: invitedRole,
      },
    });
    expect(result.invitation).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(result)).not.toContain("sha256:test-only");
    expect(repository.state.audits).toHaveLength(1);
    expect(repository.state.audits[0]?.action).toBe(
      "organization.invitation_created",
    );
  });

  test.each([
    ["admin", "owner", "forbidden"],
    ["member", "member", "forbidden"],
    ["admin", "member", "wrong_tenant"],
    ["admin", "member", "revoked"],
  ] as const)(
    "denies %s inviting %s for %s",
    async (role, invitedRole, reason) => {
      const repository = seeded(
        role,
        reason === "revoked" ? "revoked" : "active",
      );
      if (reason === "wrong_tenant") {
        const membership = repository.state.memberships[0];
        if (!membership) throw new Error("Missing test membership");
        membership.organizationId = OTHER_ORGANIZATION_ID;
      }
      await expect(
        service(repository).inviteUser(userContext("user_actor"), {
          organizationId: ORGANIZATION_ID,
          email: "person@example.com",
          role: invitedRole,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(repository.state.invitations).toEqual([]);
      expect(repository.state.audits).toEqual([]);
    },
  );

  test("denies unauthenticated invitation creation", async () => {
    const repository = seeded("owner");
    await expect(
      service(repository).inviteUser(unauthenticatedContext, {
        organizationId: ORGANIZATION_ID,
        email: "person@example.com",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test.each([
    [null, "input"],
    [undefined, "input"],
    [42, "input"],
    [
      {
        organizationId: "org_1",
        email: "person@example.com",
        role: "member",
      },
      "organizationId",
    ],
    [
      {
        organizationId: ORGANIZATION_ID,
        email: null,
        role: "member",
      },
      "email",
    ],
    [
      {
        organizationId: ORGANIZATION_ID,
        email: "person@example.com",
        role: null,
      },
      "role",
    ],
  ])("rejects malformed invitation input %j safely", async (input, field) => {
    await expect(
      service(seeded("owner")).inviteUser(
        userContext("user_actor"),
        input as never,
      ),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field } });
  });

  test.each(["suspended", "archived"] as const)(
    "denies invitation creation in a %s organization",
    async (organizationStatus) => {
      const repository = seeded("owner", "active", organizationStatus);
      await expect(
        service(repository).inviteUser(userContext("user_actor"), {
          organizationId: ORGANIZATION_ID,
          email: "person@example.com",
          role: "member",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(repository.state.invitations).toEqual([]);
    },
  );

  test.each([
    ["not-an-email", 86_400, "email"],
    ["person\u0000@example.com", 86_400, "email"],
    ["person@example.com", 59, "expiresInSeconds"],
    ["person@example.com", 2_592_001, "expiresInSeconds"],
  ])(
    "rejects invalid invitation input",
    async (email, expiresInSeconds, field) => {
      const repository = seeded("owner");
      await expect(
        service(repository).inviteUser(userContext("user_actor"), {
          organizationId: ORGANIZATION_ID,
          email,
          role: "member",
          expiresInSeconds,
        }),
      ).rejects.toMatchObject({
        code: "validation_failed",
        details: { field },
      });
    },
  );

  test("makes an exact active invitation retry a no-op and rejects a conflicting retry", async () => {
    const repository = seeded("owner");
    const organizationService = service(repository);
    const first = await organizationService.inviteUser(
      userContext("user_actor"),
      {
        organizationId: ORGANIZATION_ID,
        email: "Person@Example.com",
        role: "member",
      },
    );
    const retry = await organizationService.inviteUser(
      userContext("user_actor"),
      {
        organizationId: ORGANIZATION_ID,
        email: " person@example.com ",
        role: "member",
      },
    );

    expect(first.created).toBe(true);
    expect(retry).toMatchObject({
      created: false,
      invitation: first.invitation,
    });
    expect(repository.state.invitations).toHaveLength(1);
    expect(repository.state.audits).toHaveLength(1);

    await expect(
      organizationService.inviteUser(userContext("user_actor"), {
        organizationId: ORGANIZATION_ID,
        email: "person@example.com",
        role: "member",
        expiresInSeconds: 86_400,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { field: "email", reason: "already_invited" },
    });

    await expect(
      organizationService.inviteUser(userContext("user_actor"), {
        organizationId: ORGANIZATION_ID,
        email: "person@example.com",
        role: "admin",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { field: "email", reason: "already_invited" },
    });
    expect(repository.state.invitations).toHaveLength(1);
    expect(repository.state.audits).toHaveLength(1);
  });

  test.each([
    ["revoked", "Organization invitation renewed after it was revoked"],
    ["expired", "Organization invitation renewed after it expired"],
    [
      "accepted",
      "Organization invitation renewed after its member's access ended",
    ],
  ] as const)(
    "renews an invitation that was %s instead of refusing the address",
    async (previous, reason) => {
      const repository = seeded("owner");
      let hashes = 0;
      const organizationService = new OrganizationService({
        repository,
        invitationTokenHash: () => {
          hashes += 1;
          return `sha256:test-only-${hashes}`;
        },
      });
      const first = await organizationService.inviteUser(
        userContext("user_actor"),
        {
          organizationId: ORGANIZATION_ID,
          email: "person@example.com",
          role: "member",
        },
      );
      const stored = repository.state.invitations[0];
      if (!stored) throw new Error("Missing test invitation");
      if (previous === "revoked") stored.revokedAt = repository.now();
      if (previous === "accepted") stored.acceptedAt = repository.now();
      if (previous === "expired") stored.expiresAt = repository.now();

      const renewed = await organizationService.inviteUser(
        userContext("user_actor"),
        {
          organizationId: ORGANIZATION_ID,
          email: "PERSON@example.com",
          role: "admin",
        },
      );

      expect(renewed).toMatchObject({
        created: true,
        outcome: "renewed",
        renewedFrom: previous,
        invitation: { id: first.invitation.id, role: "admin" },
      });
      expect(repository.state.invitations).toEqual([
        expect.objectContaining({
          role: "admin",
          tokenHash: "sha256:test-only-2",
          acceptedAt: null,
          revokedAt: null,
          version: 2,
        }),
      ]);
      expect(repository.state.audits.map((audit) => audit.action)).toEqual([
        "organization.invitation_created",
        "organization.invitation_renewed",
      ]);
      expect(repository.state.audits[1]?.reason).toBe(reason);
      expect(
        repository.state.events.map((event) => [
          event.type,
          event.aggregateVersion,
          event.data,
        ]),
      ).toEqual([
        [
          "organization.invitation_created.v1",
          1,
          expect.not.objectContaining({ renewedFrom: expect.anything() }),
        ],
        [
          "organization.invitation_created.v1",
          2,
          expect.objectContaining({ role: "admin", renewedFrom: previous }),
        ],
      ]);
    },
  );

  test("refuses on email an address whose person is an active member", async () => {
    const repository = seeded("owner");
    const organizationService = service(repository);
    await organizationService.inviteUser(userContext("user_actor"), {
      organizationId: ORGANIZATION_ID,
      email: "member@example.com",
      role: "member",
    });
    const stored = repository.state.invitations[0];
    if (!stored) throw new Error("Missing test invitation");
    // Accepted: the person signed up, and joined as an active member.
    stored.acceptedAt = repository.now();
    repository.state.users.push({
      id: "user_member",
      normalizedEmail: "member@example.com",
    });
    repository.state.memberships.push({
      id: "membership_2",
      organizationId: ORGANIZATION_ID,
      userId: "user_member",
      role: "member",
      status: "active",
    });

    await expect(
      organizationService.inviteUser(userContext("user_actor"), {
        organizationId: ORGANIZATION_ID,
        email: "member@example.com",
        role: "member",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { field: "email", reason: "already_member" },
    });
    expect(repository.state.invitations[0]?.version).toBe(1);
    expect(repository.state.audits).toHaveLength(1);
    expect(repository.state.events).toHaveLength(1);
  });

  test.each(["revoked", "expired", "accepted"] as const)(
    "refuses, as existing_account, an invitation that was %s when the address already has an account",
    async (previous) => {
      const repository = seeded("owner");
      const organizationService = service(repository);
      await organizationService.inviteUser(userContext("user_actor"), {
        organizationId: ORGANIZATION_ID,
        email: "person@example.com",
        role: "member",
      });
      const stored = repository.state.invitations[0];
      if (!stored) throw new Error("Missing test invitation");
      if (previous === "revoked") stored.revokedAt = repository.now();
      if (previous === "accepted") stored.acceptedAt = repository.now();
      if (previous === "expired") stored.expiresAt = repository.now();
      // Signed up since — through another organisation, or as a member since
      // removed — so a renewed invitation would never be accepted: only the
      // insert of this person's user row accepts one.
      repository.state.users.push({
        id: "user_elsewhere",
        normalizedEmail: "Person@Example.com",
      });
      const before = { ...stored };

      await expect(
        organizationService.inviteUser(userContext("user_actor"), {
          organizationId: ORGANIZATION_ID,
          email: "person@example.com",
          role: "admin",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "existing_account" },
      });
      expect(repository.state.invitations).toEqual([before]);
      expect(repository.state.audits).toHaveLength(1);
      expect(repository.state.events).toHaveLength(1);
    },
  );

  test("refuses a first invitation, as existing_account, when the address already has an account", async () => {
    const repository = seeded("owner");
    repository.state.users.push({
      id: "user_elsewhere",
      normalizedEmail: "Person@Example.com",
    });

    await expect(
      service(repository).inviteUser(userContext("user_actor"), {
        organizationId: ORGANIZATION_ID,
        email: "person@example.com",
        role: "member",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { field: "email", reason: "existing_account" },
    });
    expect(repository.state.invitations).toEqual([]);
    expect(repository.state.audits).toEqual([]);
    expect(repository.state.events).toEqual([]);
  });

  test("refuses a first invitation, as already_member, when the address belongs to an active member", async () => {
    const repository = seeded("owner");
    repository.state.users.push({
      id: "user_member",
      normalizedEmail: "member@example.com",
    });
    repository.state.memberships.push({
      id: "membership_2",
      organizationId: ORGANIZATION_ID,
      userId: "user_member",
      role: "member",
      status: "active",
    });

    await expect(
      service(repository).inviteUser(userContext("user_actor"), {
        organizationId: ORGANIZATION_ID,
        email: "MEMBER@example.com",
        role: "admin",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { field: "email", reason: "already_member" },
    });
    expect(repository.state.invitations).toEqual([]);
    expect(repository.state.audits).toEqual([]);
    expect(repository.state.events).toEqual([]);
  });
});

describe("bootstrapOwner", () => {
  const context = {
    actor: BOOTSTRAP_OWNER_ACTOR,
    correlationId: "corr_bootstrap",
  };

  test("creates the missing-user allowlist stage without fabricating identity or membership", async () => {
    const repository = new InMemoryFoundationRepository();
    const result = await bootstrapOwner(repository, context, {
      email: "  OPÉRATOR@Example.COM ",
      organizationSlug: " RequestPort ",
      organizationName: " RequestPort ",
    });

    expect(result).toEqual({
      status: "awaiting_authentication",
      organizationId: ORGANIZATION_ID,
      organizationSlug: "requestport",
      normalizedEmail: "opérator@example.com",
    });
    expect(repository.state.users).toEqual([]);
    expect(repository.state.memberships).toEqual([]);
    expect(repository.state.allowlist).toEqual([
      {
        normalizedEmail: "opérator@example.com",
        status: "active",
        expiresAt: null,
      },
    ]);
    expect(repository.state.audits.map((audit) => audit.action)).toEqual([
      "organization.bootstrap_requested",
    ]);
  });

  test("finalizes against the real authenticated user and then becomes a no-op", async () => {
    const repository = new InMemoryFoundationRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "RequestPort",
            slug: "requestport",
            status: "active",
          },
        ],
        users: [{ id: "user_real", normalizedEmail: "owner@example.com" }],
        allowlist: [
          {
            normalizedEmail: "owner@example.com",
            status: "revoked",
            expiresAt: new Date("2026-08-15T00:00:00.000Z"),
          },
        ],
      },
    });
    const input = {
      email: "OWNER@example.com",
      organizationSlug: "REQUESTPORT",
      organizationName: "RequestPort",
    };

    const first = await bootstrapOwner(repository, context, input);
    const retry = await bootstrapOwner(repository, context, input);

    expect(first).toMatchObject({
      status: "owner_active",
      userId: "user_real",
    });
    expect(retry).toEqual(first);
    expect(repository.state.memberships).toEqual([
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        userId: "user_real",
        role: "owner",
        status: "active",
      }),
    ]);
    expect(repository.state.audits.map((audit) => audit.action)).toEqual([
      "organization.owner_bootstrapped",
    ]);
  });

  test("rejects a different active owner without changing allowlist or audit", async () => {
    const repository = new InMemoryFoundationRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "RequestPort",
            slug: "requestport",
            status: "active",
          },
        ],
        memberships: [
          {
            id: "membership_1",
            organizationId: ORGANIZATION_ID,
            userId: "user_existing",
            role: "owner",
            status: "active",
          },
        ],
        users: [{ id: "user_other", normalizedEmail: "other@example.com" }],
      },
    });

    await expect(
      bootstrapOwner(repository, context, {
        email: "other@example.com",
        organizationSlug: "requestport",
        organizationName: "RequestPort",
      }),
    ).rejects.toMatchObject({ code: "conflict", details: { field: "owner" } });
    expect(repository.state.allowlist).toEqual([]);
    expect(repository.state.audits).toEqual([]);
  });

  test("requires the fixed bootstrap system actor and matching organization name", async () => {
    const repository = new InMemoryFoundationRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "Existing",
            slug: "requestport",
            status: "active",
          },
        ],
      },
    });
    await expect(
      bootstrapOwner(repository, userContext(), {
        email: "owner@example.com",
        organizationSlug: "requestport",
        organizationName: "Existing",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      bootstrapOwner(repository, context, {
        email: "owner@example.com",
        organizationSlug: "requestport",
        organizationName: "Different",
      }),
    ).rejects.toMatchObject({ code: "conflict", details: { field: "name" } });
  });

  test("rejects malformed bootstrap context and identifiers", async () => {
    const repository = new InMemoryFoundationRepository();
    await expect(
      bootstrapOwner(
        repository,
        { actor: BOOTSTRAP_OWNER_ACTOR, correlationId: "" },
        {
          email: "owner@example.com",
          organizationSlug: "requestport",
          organizationName: "RequestPort",
        },
      ),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "correlationId" },
    });
  });

  test.each([
    [null, "input"],
    [undefined, "input"],
    [42, "input"],
    [
      {
        email: null,
        organizationSlug: "requestport",
        organizationName: "RequestPort",
      },
      "email",
    ],
    [
      {
        email: "owner@example.com",
        organizationSlug: null,
        organizationName: "RequestPort",
      },
      "slug",
    ],
    [
      {
        email: "owner@example.com",
        organizationSlug: "requestport",
        organizationName: null,
      },
      "name",
    ],
  ])("rejects malformed bootstrap input %j safely", async (input, field) => {
    await expect(
      bootstrapOwner(
        new InMemoryFoundationRepository(),
        context,
        input as never,
      ),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field } });
  });

  test.each(["suspended", "archived"] as const)(
    "does not bootstrap into a %s organization",
    async (status) => {
      const repository = new InMemoryFoundationRepository({
        state: {
          organizations: [
            {
              id: ORGANIZATION_ID,
              name: "RequestPort",
              slug: "requestport",
              status,
            },
          ],
        },
      });
      await expect(
        bootstrapOwner(repository, context, {
          email: "owner@example.com",
          organizationSlug: "requestport",
          organizationName: "RequestPort",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(repository.state.allowlist).toEqual([]);
      expect(repository.state.audits).toEqual([]);
    },
  );

  test("uses only safe DomainError details", () => {
    const error = new DomainError("conflict", "Conflict", { field: "slug" });
    expect(error).toMatchObject({
      code: "conflict",
      details: { field: "slug" },
    });
  });
});

type CredentialState = {
  credentials: Record<string, string>;
  sessions: Record<string, number>;
  /**
   * F3-13: the operator credentials each person issued, by user id, as the
   * number still live; and the order the rotation's writes ran in.
   */
  operatorCredentials: Record<string, number>;
  operatorRevocations: Array<{
    userId: string;
    actor: { type: "system"; system: string };
    correlationId: string;
  }>;
  writes: string[];
};

/**
 * The in-memory repository, given what a local credential needs: a user it
 * can create, a credential row it can write, sessions it can revoke, and the
 * operator credentials a rotation revokes (F3-13). Kept in the staged state
 * so a failed transaction rolls them back like the rest.
 * `withoutOperatorRevocation` builds one that cannot revoke operator
 * credentials, which must be refused a local credential altogether.
 */
class InMemoryBootstrapOwnerRepository extends InMemoryFoundationRepository {
  withoutOperatorRevocation = false;

  credentialState(): CredentialState {
    return this.state as unknown as CredentialState;
  }

  override async transaction<T>(
    run: (tx: BootstrapOwnerTransaction) => Promise<T>,
  ): Promise<T> {
    const repository = this;
    return super.transaction(async (tx) => {
      const staged = (
        tx as unknown as { state: FoundationStateWithCredentials }
      ).state;
      staged.credentials ??= {};
      staged.sessions ??= {};
      staged.operatorCredentials ??= {};
      staged.operatorRevocations ??= [];
      staged.writes ??= [];
      const credentials = staged.credentials;
      const sessions = staged.sessions;
      const operatorCredentials = staged.operatorCredentials;
      const operatorRevocations = staged.operatorRevocations;
      const writes = staged.writes;
      const operatorExtras = {
        async revokeOperatorCredentialsIssuedBy(input: {
          userId: string;
          actor: { type: "system"; system: string };
          correlationId: string;
        }) {
          if (repository.failOn === "revokeOperatorCredentialsIssuedBy") {
            throw new Error("failed:revokeOperatorCredentialsIssuedBy");
          }
          writes.push("revokeOperatorCredentialsIssuedBy");
          operatorRevocations.push({
            userId: input.userId,
            actor: input.actor,
            correlationId: input.correlationId,
          });
          const revoked = operatorCredentials[input.userId] ?? 0;
          operatorCredentials[input.userId] = 0;
          return revoked;
        },
      };
      const extras = {
        ...(repository.withoutOperatorRevocation ? {} : operatorExtras),
        async createLocalUser(input: {
          normalizedEmail: string;
          name: string;
        }) {
          const created = {
            id: `user_local_${staged.users.length + 1}`,
            normalizedEmail: input.normalizedEmail,
          };
          staged.users.push(created);
          return created;
        },
        async hasLocalCredential(userId: string) {
          return credentials[userId] !== undefined;
        },
        async setLocalCredential(input: {
          userId: string;
          credentialHash: string;
        }) {
          writes.push("setLocalCredential");
          credentials[input.userId] = input.credentialHash;
        },
        async revokeUserSessions(userId: string) {
          writes.push("revokeUserSessions");
          const revoked = sessions[userId] ?? 0;
          sessions[userId] = 0;
          return revoked;
        },
      };
      const extended = new Proxy(tx, {
        get(target, key, receiver) {
          if (Object.hasOwn(extras, key)) {
            return extras[key as keyof typeof extras];
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as BootstrapOwnerTransaction;
      return run(extended);
    });
  }
}

type FoundationStateWithCredentials = InMemoryFoundationRepository["state"] &
  Partial<CredentialState>;

describe("bootstrapOwner with a local credential", () => {
  const context = {
    actor: BOOTSTRAP_OWNER_ACTOR,
    correlationId: "corr_bootstrap",
  };
  const input = {
    email: "Owner@Example.com",
    organizationSlug: "requestport",
    organizationName: "RequestPort",
  };

  async function storedHashVerifies(
    repository: InMemoryBootstrapOwnerRepository,
    userId: string,
    credential: string,
  ) {
    const hash = repository.credentialState().credentials[userId];
    if (!hash) return false;
    return verifyLocalCredential({ hash, password: credential });
  }

  test("ends in owner_active in one run, with no external provider", async () => {
    const repository = new InMemoryBootstrapOwnerRepository();

    const result = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });

    expect(result).toMatchObject({
      status: "owner_active",
      organizationSlug: "requestport",
      normalizedEmail: "owner@example.com",
      localCredential: "issued",
    });
    if (result.status !== "owner_active" || !result.credential) {
      throw new Error("expected an issued credential");
    }
    expect(repository.state.users).toEqual([
      { id: result.userId, normalizedEmail: "owner@example.com" },
    ]);
    expect(repository.state.allowlist).toEqual([
      {
        normalizedEmail: "owner@example.com",
        status: "active",
        expiresAt: null,
      },
    ]);
    expect(repository.state.memberships).toEqual([
      expect.objectContaining({
        userId: result.userId,
        role: "owner",
        status: "active",
      }),
    ]);
    expect(
      await storedHashVerifies(repository, result.userId, result.credential),
    ).toBe(true);
    expect(repository.state.audits).toEqual([
      expect.objectContaining({
        action: "organization.owner_bootstrapped",
        reason: "First organization owner activated with a local credential",
        fieldNames: [
          "membershipRole",
          "membershipStatus",
          "allowlistStatus",
          "localCredential",
        ],
      }),
    ]);
  });

  // Three scrypt derivations: the first issue, the retry (which derives a
  // hash before it finds the credential already issued) and a verification.
  // It has the rotation case's budget, for the reason given there (below).
  // It did not overrun in the gate that case overran, but it does three
  // quarters of that case's work, and measured 189–200ms to its 250–349ms.
  test("never re-issues on a retry, so a repeated command cannot lock the owner out", async () => {
    const repository = new InMemoryBootstrapOwnerRepository();
    const first = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });
    const retry = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });

    if (first.status !== "owner_active" || !first.credential) {
      throw new Error("expected an issued credential");
    }
    expect(retry).toMatchObject({
      status: "owner_active",
      userId: first.userId,
      localCredential: "unchanged",
    });
    expect(retry).not.toHaveProperty("credential");
    expect(
      await storedHashVerifies(repository, first.userId, first.credential),
    ).toBe(true);
    expect(repository.state.audits).toHaveLength(1);
  }, 30_000);

  test("gives an existing user a credential without creating another", async () => {
    const repository = new InMemoryBootstrapOwnerRepository({
      state: {
        users: [{ id: "user_github", normalizedEmail: "owner@example.com" }],
      },
    });

    const result = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });

    expect(result).toMatchObject({
      status: "owner_active",
      userId: "user_github",
      localCredential: "issued",
    });
    expect(repository.state.users).toHaveLength(1);
  });

  /*
   * Its own budget, because it is slow without touching a database: the
   * repository is in memory, and the time is four scrypt derivations (the
   * issue, the rotation, and a verification of each credential) at the
   * parameters `local-credential.ts` fixes, Better Auth's own: N 16384, r 16,
   * p 1, a 64-byte key, 32 MiB of memory each. Measured on 2026-09-28 it took
   * 250–349ms, alone or with its file, at a load average of 26–31; in the full
   * gate of the same day, at a load average of 19.9 at its start and 39.9 at
   * its end, it overran Vitest's default of 5 seconds. 30 seconds is six
   * times the budget it overran.
   */
  test("rotation replaces the credential and ends every session it had", async () => {
    const repository = new InMemoryBootstrapOwnerRepository();
    const first = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });
    if (first.status !== "owner_active" || !first.credential) {
      throw new Error("expected an issued credential");
    }
    repository.credentialState().sessions[first.userId] = 3;

    const rotated = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "rotate",
    });

    if (rotated.status !== "owner_active" || !rotated.credential) {
      throw new Error("expected a rotated credential");
    }
    expect(rotated.localCredential).toBe("rotated");
    expect(rotated.credential).not.toBe(first.credential);
    expect(
      await storedHashVerifies(repository, first.userId, first.credential),
    ).toBe(false);
    expect(
      await storedHashVerifies(repository, first.userId, rotated.credential),
    ).toBe(true);
    expect(repository.credentialState().sessions[first.userId]).toBe(0);
    expect(repository.state.audits.map((audit) => audit.reason)).toEqual([
      "First organization owner activated with a local credential",
      "Local owner credential rotated and sessions revoked",
    ]);
  }, 30_000);

  test("recovers a lost credential by rotating it, which needs no old one", async () => {
    const repository = new InMemoryBootstrapOwnerRepository();
    await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });

    const recovered = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "rotate",
    });

    expect(recovered).toMatchObject({
      status: "owner_active",
      localCredential: "rotated",
      credential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
  });

  test("will not rotate a credential in an organization that does not exist", async () => {
    const repository = new InMemoryBootstrapOwnerRepository({
      state: {
        users: [{ id: "user_github", normalizedEmail: "owner@example.com" }],
      },
    });

    await expect(
      bootstrapOwner(repository, context, {
        ...input,
        localCredential: "rotate",
      }),
    ).rejects.toMatchObject({ code: "not_found", details: { field: "slug" } });
    expect(repository.state.organizations).toEqual([]);
    expect(repository.state.allowlist).toEqual([]);
  });

  test("will not rotate a credential for a person who does not exist", async () => {
    const repository = new InMemoryBootstrapOwnerRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "RequestPort",
            slug: "requestport",
            status: "active",
          },
        ],
      },
    });

    await expect(
      bootstrapOwner(repository, context, {
        ...input,
        localCredential: "rotate",
      }),
    ).rejects.toMatchObject({ code: "not_found", details: { field: "email" } });
    expect(repository.state.users).toEqual([]);
    expect(repository.state.allowlist).toEqual([]);
  });

  test("will not issue or rotate for anyone but the organization's owner", async () => {
    const repository = new InMemoryBootstrapOwnerRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "RequestPort",
            slug: "requestport",
            status: "active",
          },
        ],
        memberships: [
          {
            id: "membership_1",
            organizationId: ORGANIZATION_ID,
            userId: "user_existing",
            role: "owner",
            status: "active",
          },
        ],
        users: [{ id: "user_other", normalizedEmail: "other@example.com" }],
      },
    });

    for (const localCredential of ["issue", "rotate"] as const) {
      await expect(
        bootstrapOwner(repository, context, {
          ...input,
          email: "other@example.com",
          localCredential,
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "owner" },
      });
    }
    expect(repository.credentialState().credentials ?? {}).toEqual({});
  });

  function organizationWithTwoOwners() {
    return new InMemoryBootstrapOwnerRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "RequestPort",
            slug: "requestport",
            status: "active",
          },
        ],
        memberships: [
          {
            id: "membership_original",
            organizationId: ORGANIZATION_ID,
            userId: "user_original",
            role: "owner",
            status: "active",
          },
          {
            id: "membership_invited",
            organizationId: ORGANIZATION_ID,
            userId: "user_invited",
            role: "owner",
            status: "active",
          },
        ],
        users: [
          { id: "user_original", normalizedEmail: "owner@example.com" },
          { id: "user_invited", normalizedEmail: "second@example.com" },
        ],
      },
    });
  }

  test("rotates the original owner's credential after a second owner was invited", async () => {
    const repository = organizationWithTwoOwners();
    repository.credentialState().credentials = { user_original: "old" };
    repository.credentialState().sessions = { user_original: 2 };

    const rotated = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "rotate",
    });

    if (rotated.status !== "owner_active" || !rotated.credential) {
      throw new Error("expected a rotated credential");
    }
    expect(rotated).toMatchObject({
      userId: "user_original",
      localCredential: "rotated",
    });
    expect(
      await storedHashVerifies(repository, "user_original", rotated.credential),
    ).toBe(true);
    expect(repository.credentialState().sessions.user_original).toBe(0);
    expect(repository.state.memberships).toHaveLength(2);
  });

  test("issues a credential to an owner who is not the only one", async () => {
    const repository = organizationWithTwoOwners();

    const issued = await bootstrapOwner(repository, context, {
      ...input,
      email: "second@example.com",
      localCredential: "issue",
    });

    if (issued.status !== "owner_active" || !issued.credential) {
      throw new Error("expected an issued credential");
    }
    expect(issued).toMatchObject({
      userId: "user_invited",
      localCredential: "issued",
    });
    expect(
      await storedHashVerifies(repository, "user_invited", issued.credential),
    ).toBe(true);
    expect(repository.state.users).toHaveLength(2);
    expect(repository.state.memberships).toHaveLength(2);
  });

  test("will not rotate for a person who is not already an active owner", async () => {
    const repository = new InMemoryBootstrapOwnerRepository({
      state: {
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "RequestPort",
            slug: "requestport",
            status: "active",
          },
        ],
        memberships: [
          {
            id: "membership_member",
            organizationId: ORGANIZATION_ID,
            userId: "user_member",
            role: "member",
            status: "active",
          },
        ],
        users: [{ id: "user_member", normalizedEmail: "owner@example.com" }],
      },
    });

    await expect(
      bootstrapOwner(repository, context, {
        ...input,
        localCredential: "rotate",
      }),
    ).rejects.toMatchObject({ code: "conflict", details: { field: "owner" } });
    expect(repository.state.memberships).toEqual([
      expect.objectContaining({ userId: "user_member", role: "member" }),
    ]);
    expect(repository.credentialState().credentials ?? {}).toEqual({});
  });

  test("still refuses a bootstrap that would add an owner beside an existing one", async () => {
    const repository = organizationWithTwoOwners();
    repository.state.users.push({
      id: "user_third",
      normalizedEmail: "third@example.com",
    });

    for (const localCredential of [undefined, "issue"] as const) {
      await expect(
        bootstrapOwner(repository, context, {
          ...input,
          email: "third@example.com",
          ...(localCredential ? { localCredential } : {}),
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "owner" },
      });
    }
    expect(repository.state.memberships).toHaveLength(2);
  });

  test("refuses a repository that cannot hold a credential, before writing anything", async () => {
    const repository = new InMemoryFoundationRepository();

    await expect(
      bootstrapOwner(repository, context, {
        ...input,
        localCredential: "issue",
      }),
    ).rejects.toThrow(/local credential/u);
    expect(repository.state.organizations).toEqual([]);
    expect(repository.state.allowlist).toEqual([]);
  });

  test("rejects a credential mode it does not know", async () => {
    await expect(
      bootstrapOwner(new InMemoryBootstrapOwnerRepository(), context, {
        ...input,
        localCredential: "reset" as never,
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "localCredential" },
    });
  });

  test("rolls back the user, credential and membership together", async () => {
    const repository = new InMemoryBootstrapOwnerRepository();
    repository.failOn = "appendAuditRecord";

    await expect(
      bootstrapOwner(repository, context, {
        ...input,
        localCredential: "issue",
      }),
    ).rejects.toThrow("failed:appendAuditRecord");
    expect(repository.state.users).toEqual([]);
    expect(repository.state.memberships).toEqual([]);
    expect(repository.credentialState().credentials ?? {}).toEqual({});
  });
});

describe("bootstrapOwner revokes the owner's operator credentials (F3-13)", () => {
  const context = {
    actor: BOOTSTRAP_OWNER_ACTOR,
    correlationId: "corr_operator_rotation",
  };
  const input = {
    email: "Owner@Example.com",
    organizationSlug: "requestport",
    organizationName: "RequestPort",
  };

  async function ownerWithOperatorCredentials() {
    const repository = new InMemoryBootstrapOwnerRepository();
    const first = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });
    if (first.status !== "owner_active" || !first.credential) {
      throw new Error("expected an issued credential");
    }
    repository.credentialState().operatorCredentials[first.userId] = 2;
    repository.credentialState().sessions[first.userId] = 1;
    repository.credentialState().writes = [];
    return { repository, first, credential: first.credential };
  }

  test("a rotation revokes them in its transaction, right after the sessions, as the bootstrap's actor", async () => {
    const { repository, first } = await ownerWithOperatorCredentials();

    const rotated = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "rotate",
    });

    expect(rotated).toMatchObject({ localCredential: "rotated" });
    expect(repository.credentialState().writes).toEqual([
      "setLocalCredential",
      "revokeUserSessions",
      "revokeOperatorCredentialsIssuedBy",
    ]);
    expect(repository.credentialState().operatorRevocations).toEqual([
      {
        userId: first.userId,
        actor: BOOTSTRAP_OWNER_ACTOR,
        correlationId: "corr_operator_rotation",
      },
    ]);
    expect(repository.credentialState().operatorCredentials[first.userId]).toBe(
      0,
    );
    // The bootstrap's own audit row is as it was before F.3.
    expect(repository.state.audits.at(-1)).toMatchObject({
      action: "organization.owner_bootstrapped",
      reason: "Local owner credential rotated and sessions revoked",
      fieldNames: ["localCredential", "sessions"],
    });
  });

  test("an issue, and an issue that finds a credential already there, revoke nothing", async () => {
    const repository = new InMemoryBootstrapOwnerRepository();
    await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });
    const retry = await bootstrapOwner(repository, context, {
      ...input,
      localCredential: "issue",
    });

    expect(retry).toMatchObject({ localCredential: "unchanged" });
    expect(repository.credentialState().operatorRevocations).toEqual([]);
  });

  test("a failed revocation rolls the rotation back, and the old credential still verifies", async () => {
    const { repository, first, credential } =
      await ownerWithOperatorCredentials();
    repository.failOn = "revokeOperatorCredentialsIssuedBy";

    await expect(
      bootstrapOwner(repository, context, {
        ...input,
        localCredential: "rotate",
      }),
    ).rejects.toThrow("failed:revokeOperatorCredentialsIssuedBy");

    const hash = repository.credentialState().credentials[first.userId] ?? "";
    expect(await verifyLocalCredential({ hash, password: credential })).toBe(
      true,
    );
    expect(repository.credentialState().sessions[first.userId]).toBe(1);
    expect(repository.credentialState().operatorCredentials[first.userId]).toBe(
      2,
    );
    expect(repository.state.audits).toHaveLength(1);
  });

  test("a repository that cannot revoke them is refused a local credential, before writing anything", async () => {
    for (const localCredential of ["issue", "rotate"] as const) {
      const repository = new InMemoryBootstrapOwnerRepository();
      repository.withoutOperatorRevocation = true;

      await expect(
        bootstrapOwner(repository, context, { ...input, localCredential }),
      ).rejects.toThrow(/local credential/u);
      expect(repository.state.organizations).toEqual([]);
      expect(repository.state.allowlist).toEqual([]);
    }
  });
});
