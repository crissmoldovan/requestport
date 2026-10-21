import {
  type ActorRef,
  DomainError,
  type RoutingRepository,
  type RoutingRule,
  routingRuleSpecificity,
} from "@requestport/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentPrincipals,
  lanes,
  organizationMembers,
  organizations,
  projects,
  routingRules,
} from "../schema/index.js";
import { inTenantTransaction, withTenantRead } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

type RoutingDatabase = Database | Tx;

async function lockRoutingPolicy(
  database: RoutingDatabase,
  organizationId: string,
  mode: "read" | "write",
) {
  if (mode === "read") {
    await database.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended('requestport:routing-policy:' || ${organizationId}, 0))`,
    );
    return;
  }
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('requestport:routing-policy:' || ${organizationId}, 0))`,
  );
}

export interface RoutingDatabaseRepository extends RoutingRepository {
  listRulesForMember(
    userId: string,
    organizationId: string,
  ): Promise<RoutingRule[] | null>;
  listRulesForManager(
    userId: string,
    organizationId: string,
  ): Promise<RoutingRule[] | null>;
}

type RoutingRuleUpdate = Omit<RoutingRule, "id" | "organizationId" | "version">;

function routingRule(row: typeof routingRules.$inferSelect): RoutingRule {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sourceKind: row.sourceKind as RoutingRule["sourceKind"],
    sourceProjectId: row.sourceProjectId ?? undefined,
    targetProjectId: row.targetProjectId,
    decision: row.decision as RoutingRule["decision"],
    requestTypes: row.requestTypes as RoutingRule["requestTypes"],
    laneIds: row.laneIds,
    priorities: row.priorities as RoutingRule["priorities"],
    humanRoles: row.humanRoles as RoutingRule["humanRoles"],
    agentPrincipalIds: row.agentPrincipalIds,
    specificity: routingRuleSpecificity({
      organizationId: row.organizationId,
      sourceKind: row.sourceKind as RoutingRule["sourceKind"],
      sourceProjectId: row.sourceProjectId ?? undefined,
      targetProjectId: row.targetProjectId,
      decision: row.decision as RoutingRule["decision"],
      requestTypes: [...row.requestTypes] as Array<
        RoutingRule["requestTypes"][number]
      >,
      laneIds: [...row.laneIds],
      priorities: [...row.priorities] as Array<
        RoutingRule["priorities"][number]
      >,
      humanRoles: [...row.humanRoles] as Array<
        RoutingRule["humanRoles"][number]
      >,
      agentPrincipalIds: [...row.agentPrincipalIds],
      enabled: row.enabled,
    }),
    enabled: row.enabled,
    version: row.version,
  };
}

async function validateRuleReferences(
  database: RoutingDatabase,
  input: Pick<
    RoutingRule,
    | "agentPrincipalIds"
    | "laneIds"
    | "organizationId"
    | "sourceProjectId"
    | "targetProjectId"
  >,
) {
  const projectIds = [
    ...new Set([
      input.targetProjectId,
      ...(input.sourceProjectId ? [input.sourceProjectId] : []),
    ]),
  ];
  const projectRows = await database
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, input.organizationId),
        eq(projects.status, "active"),
        inArray(projects.id, projectIds),
      ),
    )
    .for("share");
  const laneRows = input.laneIds.length
    ? await database
        .select({ id: lanes.id })
        .from(lanes)
        .where(
          and(
            eq(lanes.organizationId, input.organizationId),
            eq(lanes.projectId, input.targetProjectId),
            eq(lanes.status, "active"),
            inArray(lanes.id, input.laneIds),
          ),
        )
        .for("share")
    : [];
  const agentRows = input.agentPrincipalIds.length
    ? await database
        .select({ id: agentPrincipals.id })
        .from(agentPrincipals)
        .where(
          and(
            eq(agentPrincipals.organizationId, input.organizationId),
            eq(agentPrincipals.status, "active"),
            inArray(agentPrincipals.id, input.agentPrincipalIds),
          ),
        )
        .for("share")
    : [];
  if (
    projectRows.length !== projectIds.length ||
    laneRows.length !== new Set(input.laneIds).size ||
    agentRows.length !== new Set(input.agentPrincipalIds).size
  ) {
    throw new DomainError(
      "validation_failed",
      "Routing rule contains an invalid project, lane, or agent reference",
    );
  }
}

async function updateRoutingRule(
  database: RoutingDatabase,
  id: string,
  organizationId: string,
  expectedVersion: number,
  input: RoutingRuleUpdate,
) {
  await validateRuleReferences(database, { ...input, organizationId });
  const [updated] = await database
    .update(routingRules)
    .set({
      ...input,
      sourceProjectId: input.sourceProjectId,
      requestTypes: [...input.requestTypes],
      laneIds: [...input.laneIds],
      priorities: [...input.priorities],
      humanRoles: [...input.humanRoles],
      agentPrincipalIds: [...input.agentPrincipalIds],
      version: expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(routingRules.id, id),
        eq(routingRules.organizationId, organizationId),
        eq(routingRules.version, expectedVersion),
      ),
    )
    .returning();
  if (updated) return routingRule(updated);
  const [existing] = await database
    .select({ version: routingRules.version })
    .from(routingRules)
    .where(
      and(
        eq(routingRules.id, id),
        eq(routingRules.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!existing)
    throw new DomainError("not_found", "Routing rule was not found");
  throw new DomainError("version_conflict", "Routing rule version is stale", {
    currentVersion: existing.version,
  });
}

export function createRoutingRepository(
  database: RoutingDatabase,
): RoutingDatabaseRepository {
  return {
    async canManage(organizationId: string, actor: ActorRef) {
      return withTenantRead(
        organizationId,
        async (database) => {
          if (actor.type !== "user") return false;
          const [membership] = await database
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, organizationMembers.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .where(
              and(
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.userId, actor.id),
                eq(organizationMembers.status, "active"),
                inArray(organizationMembers.role, ["owner", "admin"]),
              ),
            )
            .for("share")
            .limit(1);
          return Boolean(membership);
        },
        // Called on the pool by the web, and as a port inside a command
        // transaction (manifest-i2.md §2.3 item 3). It locks, so not
        // read-only.
        { database },
      );
    },
    async listRules(organizationId) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          await lockRoutingPolicy(transaction, organizationId, "read");
          const rows = await transaction
            .select()
            .from(routingRules)
            .where(eq(routingRules.organizationId, organizationId))
            .orderBy(asc(routingRules.id));
          return rows.map(routingRule);
        },
      );
    },

    async listRulesForMember(userId: string, organizationId: string) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          const [membership] = await transaction
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, organizationMembers.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .where(
              and(
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.status, "active"),
              ),
            )
            .for("share")
            .limit(1);
          if (!membership) return null;
          const rows = await transaction
            .select()
            .from(routingRules)
            .where(eq(routingRules.organizationId, organizationId))
            .orderBy(asc(routingRules.id));
          return rows.map(routingRule);
        },
      );
    },

    async listRulesForManager(userId: string, organizationId: string) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          const rows = await transaction
            .select({ rule: routingRules })
            .from(routingRules)
            .innerJoin(
              organizationMembers,
              and(
                eq(
                  organizationMembers.organizationId,
                  routingRules.organizationId,
                ),
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.status, "active"),
                inArray(organizationMembers.role, ["owner", "admin"]),
              ),
            )
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, routingRules.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .where(eq(routingRules.organizationId, organizationId))
            .orderBy(asc(routingRules.id));
          if (rows.length > 0) return rows.map(({ rule }) => routingRule(rule));
          const [membership] = await transaction
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, organizationMembers.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .where(
              and(
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.status, "active"),
                inArray(organizationMembers.role, ["owner", "admin"]),
              ),
            )
            .for("share")
            .limit(1);
          return membership ? [] : null;
        },
      );
    },

    async createRule(input) {
      return inTenantTransaction(
        database,
        input.organizationId,
        async (transaction) => {
          await lockRoutingPolicy(transaction, input.organizationId, "write");
          await validateRuleReferences(transaction, input);
          const [created] = await transaction
            .insert(routingRules)
            .values({
              ...input,
              sourceProjectId: input.sourceProjectId,
              requestTypes: [...input.requestTypes],
              laneIds: [...input.laneIds],
              priorities: [...input.priorities],
              humanRoles: [...input.humanRoles],
              agentPrincipalIds: [...input.agentPrincipalIds],
              version: 1,
            })
            .returning();
          if (!created) throw new Error("Routing persistence failed");
          return routingRule(created);
        },
      );
    },

    async updateRule(id, organizationId, expectedVersion, input) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          await lockRoutingPolicy(transaction, organizationId, "write");
          return updateRoutingRule(
            transaction,
            id,
            organizationId,
            expectedVersion,
            input,
          );
        },
      );
    },

    async disableRule(id, organizationId, expectedVersion) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          await lockRoutingPolicy(transaction, organizationId, "write");
          const [existing] = await transaction
            .select()
            .from(routingRules)
            .where(
              and(
                eq(routingRules.id, id),
                eq(routingRules.organizationId, organizationId),
              ),
            )
            .limit(1);
          if (!existing)
            throw new DomainError("not_found", "Routing rule was not found");
          return updateRoutingRule(
            transaction,
            id,
            organizationId,
            expectedVersion,
            {
              ...routingRule(existing),
              enabled: false,
            },
          );
        },
      );
    },
  };
}
