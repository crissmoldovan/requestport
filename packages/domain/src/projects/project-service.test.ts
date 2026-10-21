import { describe, expect, test } from "vitest";

import { InMemoryFoundationRepository } from "../test-support/foundation-repository.js";
import {
  canonicalizeGitHubRepository,
  ProjectService,
} from "./project-service.js";

const context = (userId = "user_actor") => ({
  actor: { type: "user" as const, userId },
  correlationId: "corr_project",
});

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";

function seeded(
  role: "owner" | "admin" | "member" = "owner",
  status: "active" | "revoked" = "active",
  membershipOrganizationId = ORGANIZATION_ID,
  organizationStatus: "active" | "suspended" | "archived" = "active",
) {
  return new InMemoryFoundationRepository({
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
          organizationId: membershipOrganizationId,
          userId: "user_actor",
          role,
          status,
        },
      ],
    },
  });
}

describe("ProjectService.create", () => {
  test.each(["owner", "admin"] as const)(
    "allows an active %s",
    async (role) => {
      const repository = seeded(role);
      const result = await new ProjectService(repository).create(context(), {
        organizationId: ORGANIZATION_ID,
        name: "  Field Notes  ",
        slug: " Field-Notes ",
        keyPrefix: " ASW ",
        description: "  Canonical requests  ",
        repositoryUrl: "https://github.com/example-org/field-notes.git",
      });

      expect(result).toEqual({
        project: expect.objectContaining({
          organizationId: ORGANIZATION_ID,
          name: "Field Notes",
          slug: "field-notes",
          keyPrefix: "ASW",
          description: "Canonical requests",
        }),
        repository: expect.objectContaining({
          browseUrl: "https://github.com/example-org/field-notes",
          cloneUrl: "https://github.com/example-org/field-notes.git",
          repositorySlug: "example-org/field-notes",
          isDefault: true,
        }),
      });
      expect(repository.state.audits).toHaveLength(1);
      expect(repository.state.audits[0]?.action).toBe("project.created");
    },
  );

  test.each([
    ["member", "active", ORGANIZATION_ID],
    ["admin", "revoked", ORGANIZATION_ID],
    ["admin", "active", OTHER_ORGANIZATION_ID],
  ] as const)(
    "denies role=%s status=%s membership=%s",
    async (role, status, membershipOrg) => {
      const repository = seeded(role, status, membershipOrg);
      await expect(
        new ProjectService(repository).create(context(), {
          organizationId: ORGANIZATION_ID,
          name: "Denied",
          slug: "denied",
          keyPrefix: "DEN",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    },
  );

  test("denies unauthenticated actors and ignores project-only roles", async () => {
    const repository = seeded("member");
    await expect(
      new ProjectService(repository).create(
        { actor: { type: "unauthenticated" }, correlationId: "corr_none" },
        {
          organizationId: ORGANIZATION_ID,
          name: "Denied",
          slug: "denied",
          keyPrefix: "DEN",
        },
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      new ProjectService(repository).create(context(), {
        organizationId: ORGANIZATION_ID,
        name: "Denied",
        slug: "denied",
        keyPrefix: "DEN",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test.each(["suspended", "archived"] as const)(
    "denies project creation in a %s organization",
    async (organizationStatus) => {
      const repository = seeded(
        "owner",
        "active",
        ORGANIZATION_ID,
        organizationStatus,
      );
      await expect(
        new ProjectService(repository).create(context(), {
          organizationId: ORGANIZATION_ID,
          name: "Denied",
          slug: "denied",
          keyPrefix: "DEN",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    },
  );

  test.each([
    [context(""), ORGANIZATION_ID, "userId"],
    [
      {
        actor: { type: "user" as const, userId: "user_actor" },
        correlationId: "",
      },
      ORGANIZATION_ID,
      "correlationId",
    ],
    [context(), " organization ", "organizationId"],
    [context(), "org_1", "organizationId"],
    [context(), "123E4567-E89B-42D3-A456-426614174000", "organizationId"],
    [context(), "00000000-0000-0000-0000-000000000000", "organizationId"],
  ])(
    "rejects malformed context or tenant identifier",
    async (commandContext, organizationId, field) => {
      await expect(
        new ProjectService(seeded()).create(commandContext, {
          organizationId,
          name: "Denied",
          slug: "denied",
          keyPrefix: "DEN",
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
    [{ organizationId: ORGANIZATION_ID }, "name"],
    [
      {
        organizationId: ORGANIZATION_ID,
        name: "Project",
        slug: "project",
        keyPrefix: "PRO",
        description: {},
      },
      "description",
    ],
    [
      {
        organizationId: ORGANIZATION_ID,
        name: "Project",
        slug: "project",
        keyPrefix: "PRO",
        repositoryUrl: 123,
      },
      "repositoryUrl",
    ],
  ])("rejects malformed service input %j safely", async (input, field) => {
    await expect(
      new ProjectService(seeded()).create(context(), input as never),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field },
    });
  });

  test("creates a project without a repository", async () => {
    const repository = seeded();
    const result = await new ProjectService(repository).create(context(), {
      organizationId: ORGANIZATION_ID,
      name: "Parts Catalog",
      slug: "parts-catalog",
      keyPrefix: "EQL",
      description: null,
    });
    expect(result.repository).toBeNull();
    expect(repository.state.repositories).toEqual([]);
    expect(repository.state.audits).toHaveLength(1);
  });

  test.each([
    [{ name: "", slug: "project", keyPrefix: "PRO" }, "name"],
    [{ name: "Project", slug: "settings", keyPrefix: "PRO" }, "slug"],
    [{ name: "Project", slug: "project", keyPrefix: "pro" }, "keyPrefix"],
    [{ name: "Project", slug: "project", keyPrefix: "A" }, "keyPrefix"],
    [
      { name: "Project", slug: "project", keyPrefix: "A2345678901" },
      "keyPrefix",
    ],
    [
      {
        name: "Project",
        slug: "project",
        keyPrefix: "PRO",
        description: "x".repeat(2_001),
      },
      "description",
    ],
    [
      {
        name: "Project",
        slug: "project",
        keyPrefix: "PRO",
        description: "unsafe\u0000text",
      },
      "description",
    ],
    [
      { name: "Project", slug: "project", keyPrefix: "PRO", repositoryUrl: "" },
      "repositoryUrl",
    ],
  ])("rejects invalid project boundary input", async (input, field) => {
    await expect(
      new ProjectService(seeded()).create(context(), {
        organizationId: ORGANIZATION_ID,
        ...input,
      }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field } });
  });

  test.each(["createProjectRepository", "appendAuditRecord"])(
    "rolls back project and repository when %s fails",
    async (operation) => {
      const repository = seeded();
      repository.failOn = operation;
      await expect(
        new ProjectService(repository).create(context(), {
          organizationId: ORGANIZATION_ID,
          name: "Atomic",
          slug: "atomic",
          keyPrefix: "ATM",
          repositoryUrl: "https://github.com/example-org/atomic",
        }),
      ).rejects.toThrow(`failed:${operation}`);
      expect(repository.state.projects).toEqual([]);
      expect(repository.state.repositories).toEqual([]);
      expect(repository.state.audits).toEqual([]);
    },
  );
});

describe("canonicalizeGitHubRepository", () => {
  test.each([
    [
      "https://github.com/example-org/requestport",
      {
        browseUrl: "https://github.com/example-org/requestport",
        cloneUrl: "https://github.com/example-org/requestport.git",
        repositorySlug: "example-org/requestport",
      },
    ],
    [
      "https://github.com/Example-Org/RequestPort.git",
      {
        browseUrl: "https://github.com/Example-Org/RequestPort",
        cloneUrl: "https://github.com/Example-Org/RequestPort.git",
        repositorySlug: "Example-Org/RequestPort",
      },
    ],
    [
      "https://github.com:443/example-org/requestport",
      {
        browseUrl: "https://github.com/example-org/requestport",
        cloneUrl: "https://github.com/example-org/requestport.git",
        repositorySlug: "example-org/requestport",
      },
    ],
  ])("canonicalizes %s", (input, expected) => {
    expect(canonicalizeGitHubRepository(input)).toEqual(expected);
  });

  test.each([
    "",
    "http://github.com/example-org/requestport",
    "https://github.com.evil.example/example-org/requestport",
    "https://user:secret@github.com/example-org/requestport",
    "https://github.com:444/example-org/requestport",
    "https://github.com/example-org/requestport?token=secret",
    "https://github.com/example-org/requestport#fragment",
    "https://github.com/example-org/requestport/extra",
    "https://github.com/example-org",
    "https://github.com/example-org/requestport/",
    "https://github.com/example-org%2Frequestport/other",
    "https://github.com/example-org/%2e%2e",
    "https://github.com/../requestport",
    "https://github.com/example-org/request%2fport",
    "https://github.com/example-org/repo.git.git",
    "https://github.com/cue--plusplus/requestport",
    "https://@github.com/foo/repo",
    "https://github.com/foo/repo?",
    "https://github.com/foo/repo#",
    "https://github.com:/foo/repo",
    "https://github.com\\foo\\repo",
    "\nhttps://github.com/example-org/requestport",
  ])("rejects adversarial GitHub URL %s", (input) => {
    expect(() => canonicalizeGitHubRepository(input)).toThrowError(
      expect.objectContaining({
        code: "validation_failed",
        details: { field: "repositoryUrl" },
      }),
    );
  });

  test.each([null, undefined, 42, {}, []])(
    "rejects malformed non-string repository URL input %j safely",
    (input) => {
      expect(() => canonicalizeGitHubRepository(input as never)).toThrowError(
        expect.objectContaining({
          code: "validation_failed",
          details: { field: "repositoryUrl" },
        }),
      );
    },
  );
});
