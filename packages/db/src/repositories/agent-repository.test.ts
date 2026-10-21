import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createAgentRepository } from "./agent-repository.js";

const organizationId = "018f0000-0000-7000-8000-000000000001";
const projectId = "018f0000-0000-7000-8000-000000000002";

/**
 * A database that never reaches PostgreSQL: the project binding check finds its
 * project and the insert raises whatever the case under test hands it. The
 * driver detail travels on `cause` because that is where drizzle puts it, and
 * the same sentinel appears in `detail` and `query` so a case can prove the
 * mapped error carries neither.
 */
function stubDatabase(insertFailure: unknown): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: projectId }]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.reject(insertFailure),
      }),
    }),
  } as unknown as Database;
}

function uniqueViolation(constraint: string, detail: string) {
  return Object.assign(new Error("insert failed"), {
    cause: { code: "23505", constraint, detail, query: `SELECT '${detail}'` },
  });
}

function createPrincipal(database: Database) {
  return createAgentRepository(database).createPrincipal({
    id: "018f0000-0000-7000-8000-000000000003",
    organizationId,
    projectId,
    displayName: "deploy-bot",
    slug: "deploy-bot",
    softwareName: null,
    createdByUserId: "user_1",
  });
}

describe("creating an agent principal", () => {
  /**
   * The slug is unique per organization while the tool that reaches here offers
   * to provision an agent "in a project", so the second project asking for
   * `deploy-bot` is the ordinary case. It has to arrive as something the caller
   * can act on rather than as an outage.
   */
  test("reports an organization-wide slug collision as a conflict on the slug", async () => {
    const sentinel = "postgres://user:password@db.invalid/private";
    const failure = createPrincipal(
      stubDatabase(
        uniqueViolation(
          "agent_principals_organization_slug_ci_unique",
          sentinel,
        ),
      ),
    );

    await expect(failure).rejects.toBeInstanceOf(DomainError);
    await expect(failure).rejects.toMatchObject({
      code: "conflict",
      details: { field: "slug" },
    });
    await failure.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect((error as Error).message).not.toContain(sentinel);
    });
  });

  /**
   * Only that one index means "the name is taken". Any other unique violation
   * is still an unexplained failure, and answering "change the slug" to one of
   * those would send the caller to edit a field that was never the problem.
   */
  test("leaves any other unique violation alone", async () => {
    const failure = uniqueViolation(
      "agent_principals_organization_slug_ci_unique_lookalike",
      "irrelevant",
    );

    await expect(createPrincipal(stubDatabase(failure))).rejects.toBe(failure);
  });

  test("leaves a failure that is not a database error alone", async () => {
    const failure = new Error("connection terminated unexpectedly");

    await expect(createPrincipal(stubDatabase(failure))).rejects.toBe(failure);
  });
});
