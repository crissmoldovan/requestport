import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import {
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  requests,
} from "../schema/index.js";
import { inTenantTransaction } from "../tenant-context.js";

function authorization(userId: string, organizationId: string) {
  return sql`exists (
    select 1 from ${organizationMembers} sm
    inner join ${organizations} so on so.id = sm.organization_id
    where sm.organization_id = ${organizationId}
      and sm.user_id = ${userId}
      and sm.status = 'active'
      and so.status = 'active'
  )`;
}

export function createSearchRepository(database: Database) {
  return {
    async search(userId: string, organizationId: string, rawQuery: string) {
      const query = rawQuery.normalize("NFC").trim().slice(0, 200);
      if (query.length < 2) return { query, projects: [], requests: [] };
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          const [access] = await transaction
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
          if (!access) return { query, projects: [], requests: [] };
          const pattern = `%${query}%`;
          const [projectRows, requestRows] = await inTurn([
            () =>
              transaction
                .select({
                  id: projects.id,
                  name: projects.name,
                  slug: projects.slug,
                  keyPrefix: projects.keyPrefix,
                  status: projects.status,
                })
                .from(projects)
                .where(
                  and(
                    eq(projects.organizationId, organizationId),
                    authorization(userId, organizationId),
                    or(
                      ilike(projects.name, pattern),
                      ilike(projects.slug, pattern),
                      ilike(projects.keyPrefix, pattern),
                    ),
                  ),
                )
                .orderBy(projects.name)
                .limit(25),
            () =>
              transaction
                .select({
                  id: requests.id,
                  displayKey: requests.displayKey,
                  title: requests.title,
                  state: requests.state,
                  priority: requests.priority,
                  updatedAt: requests.updatedAt,
                  targetProjectName: projects.name,
                })
                .from(requests)
                .innerJoin(
                  projects,
                  and(
                    eq(projects.id, requests.targetProjectId),
                    eq(projects.organizationId, requests.organizationId),
                  ),
                )
                .where(
                  and(
                    eq(requests.organizationId, organizationId),
                    authorization(userId, organizationId),
                    sql`(
                ${requests.visibility} = 'organization'
                or exists (
                  select 1 from ${organizationMembers} owner_membership
                  where owner_membership.organization_id = ${organizationId}
                    and owner_membership.user_id = ${userId}
                    and owner_membership.status = 'active'
                    and owner_membership.role in ('owner', 'admin')
                )
                or (${requests.reporterType} = 'user' and ${requests.reporterId} = ${userId})
                or (${requests.assigneeType} = 'user' and ${requests.assigneeId} = ${userId})
                or exists (
                  select 1 from ${projectMembers} search_project_membership
                  where search_project_membership.organization_id = ${organizationId}
                    and search_project_membership.project_id in (
                      ${requests.sourceProjectId},
                      ${requests.targetProjectId}
                    )
                    and search_project_membership.user_id = ${userId}
                    and search_project_membership.status = 'active'
                )
              )`,
                    or(
                      ilike(requests.title, pattern),
                      ilike(requests.displayKey, pattern),
                      ilike(requests.descriptionMd, pattern),
                    ),
                  ),
                )
                .orderBy(desc(requests.updatedAt))
                .limit(50),
          ]);
          return { query, projects: projectRows, requests: requestRows };
        },
      );
    },
  };
}
