import {
  auditActor,
  canonicalizeGitHubRepository,
  containsSensitiveContent,
  DomainError,
  normalizeDescription,
  normalizeName,
  type ProjectSettingsMutation,
  type ProjectSettingsPort,
  type ProjectSettingsTarget,
  type ProjectSettingsWriteResult,
  sanitizeEventActor,
} from "@requestport/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import {
  domainEvents,
  lanes,
  organizationMembers,
  organizations,
  outbox,
  projectAliases,
  projectMembers,
  projectRepositories,
  projects,
  requests,
  securityAuditRecords,
  user,
  workSessions,
} from "../schema/index.js";
import {
  inTenantTransaction,
  withTenant,
  withTenantRead,
} from "../tenant-context.js";
import type { Tx } from "../transaction.js";

type ProjectSettingsDatabase = Database | Tx;

function databaseError(
  error: unknown,
): { code?: unknown; constraint?: unknown } | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Locks what a project settings decision rests on, in a fixed order, and
 * throws unless `target.userId` may manage the project: the organisation
 * (active, else `forbidden`), the project in it (else `not_found`), and the
 * member's standing — an active owner or admin of the organisation, or an
 * active maintainer of the project (else `forbidden`). Returns the project's
 * status, default lane and version as locked.
 *
 * The writes lock the project `FOR UPDATE`; the administration read takes it
 * `FOR SHARE` (`administration/project-settings-reads.ts`).
 */
export async function requireProjectManagement(
  database: ProjectSettingsDatabase,
  target: ProjectSettingsTarget,
  projectLock: "share" | "update" = "update",
) {
  const [organization] = await database
    .select({ status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, target.organizationId))
    .for("share")
    .limit(1);
  if (organization?.status !== "active") {
    throw new DomainError("forbidden", "An active organization is required");
  }
  const [project] = await database
    .select({
      id: projects.id,
      status: projects.status,
      defaultLaneId: projects.defaultLaneId,
      version: projects.version,
    })
    .from(projects)
    .where(
      and(
        eq(projects.id, target.projectId),
        eq(projects.organizationId, target.organizationId),
      ),
    )
    .for(projectLock)
    .limit(1);
  if (!project) throw new DomainError("not_found", "Project was not found");
  const [access] = await database
    .select({ organizationRole: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, target.organizationId),
        eq(organizationMembers.userId, target.userId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  const [projectAccess] =
    access &&
    access.organizationRole !== "owner" &&
    access.organizationRole !== "admin"
      ? await database
          .select({ projectRole: projectMembers.role })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.organizationId, target.organizationId),
              eq(projectMembers.projectId, target.projectId),
              eq(projectMembers.userId, target.userId),
              eq(projectMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1)
      : [];
  const canManage =
    access?.organizationRole === "owner" ||
    access?.organizationRole === "admin" ||
    projectAccess?.projectRole === "maintainer";
  if (!canManage) {
    throw new DomainError(
      "forbidden",
      "Project maintenance access is required",
    );
  }
  return project;
}

/**
 * The write's audit row, naming the mutation's actor as `auditActor` records
 * it: a person as `user` and their id, an operator as `service` and
 * `operator:<lineage>` (Plan 13, F.3, F3-2), never as its member.
 */
async function audit(
  database: ProjectSettingsDatabase,
  context: ProjectSettingsMutation,
  action: string,
  targetType: string,
  targetId: string,
  fieldNames: string[],
) {
  const { actorType, actorId } = auditActor(context);
  await database.insert(securityAuditRecords).values({
    organizationId: context.organizationId,
    actorType,
    actorId,
    action,
    targetType,
    targetId,
    reason: "Project settings updated",
    fieldNames,
    correlationId: context.correlationId,
  });
}

/**
 * Bumps the project's version from the one the write expected, and records
 * `project.updated.v1` and its outbox row. Answers the new version. The
 * event's actor is the mutation's, through the sanitiser the event factory
 * applies to every other event: a person as they are, an operator as its
 * `service` actor with the member as origin (F3-2: "domain events carry the
 * actor unchanged").
 */
async function projectUpdated(
  database: ProjectSettingsDatabase,
  context: ProjectSettingsMutation,
  changeType: string,
  fieldNames: string[],
  patch?: Partial<{
    name: string;
    description: string | null;
    status: "active" | "archived";
  }>,
) {
  const [project] = await database
    .update(projects)
    .set({
      ...patch,
      version: sql`${projects.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projects.id, context.projectId),
        eq(projects.organizationId, context.organizationId),
        eq(projects.version, context.expectedVersion),
      ),
    )
    .returning({ version: projects.version });
  if (!project) {
    throw new DomainError("version_conflict", "Project version changed");
  }
  const eventId = uuidv7();
  await database.insert(domainEvents).values({
    id: eventId,
    organizationId: context.organizationId,
    aggregateType: "project",
    aggregateId: context.projectId,
    aggregateVersion: project.version,
    type: "project.updated.v1",
    schemaVersion: 1,
    projectId: context.projectId,
    actor: sanitizeEventActor(context.actor),
    correlationId: context.correlationId,
    causationId: context.correlationId,
    data: { projectId: context.projectId, changeType, fieldNames },
    links: {},
  });
  await database.insert(outbox).values({ eventId, state: "pending" });
  return project.version;
}

/**
 * One write: in its own transaction — a savepoint when `database` is already
 * one, as the command bus's is — it checks management and the project's
 * version, then runs. A unique violation answers `conflict` and a missing
 * reference `not_found`, as the settings forms always showed them.
 *
 * It keeps no receipt. The command bus holds the one receipt a write has, and
 * answers a replay from it before the write runs (`manifest-f2.md` §2.4).
 */
async function mutate(
  database: Database,
  context: ProjectSettingsMutation,
  run: (
    tx: Tx,
    project: Awaited<ReturnType<typeof requireProjectManagement>>,
  ) => Promise<Omit<ProjectSettingsWriteResult, "projectId">>,
): Promise<ProjectSettingsWriteResult> {
  try {
    // Bound to the project's organisation at its start (manifest-i2.md
    // §2.3 item 2); on the bus, a savepoint whose binding repeats the bus's.
    return await inTenantTransaction(
      database,
      context.organizationId,
      async (tx) => {
        const project = await requireProjectManagement(tx, context);
        if (project.version !== context.expectedVersion) {
          throw new DomainError("version_conflict", "Project version changed", {
            currentVersion: project.version,
            expectedVersion: context.expectedVersion,
          });
        }
        return { projectId: context.projectId, ...(await run(tx, project)) };
      },
    );
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const cause = databaseError(error);
    if (cause?.code === "23505") {
      throw new DomainError("conflict", "That project setting already exists");
    }
    if (cause?.code === "23503") {
      throw new DomainError(
        "not_found",
        "A referenced project record was not found",
      );
    }
    throw new Error("Project settings persistence failed");
  }
}

/**
 * The project settings page reads. The writes are
 * `createProjectSettingsCommandRepository`'s, below.
 */

export function createProjectSettingsRepository(database: Database) {
  /** For the pool reads the application makes (manifest-i2.md §2.3 item 3). */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: Database) => Promise<T>,
    readOnly = false,
  ) => withTenantRead(organizationId, work, { database, readOnly });

  return {
    async listManageableProjects(userId: string, organizationId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          return database
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, projects.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.organizationId, projects.organizationId),
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.status, "active"),
              ),
            )
            .leftJoin(
              projectMembers,
              and(
                eq(projectMembers.organizationId, projects.organizationId),
                eq(projectMembers.projectId, projects.id),
                eq(projectMembers.userId, userId),
                eq(projectMembers.status, "active"),
              ),
            )
            .where(
              and(
                eq(projects.organizationId, organizationId),
                eq(projects.status, "active"),
                sql`(${organizationMembers.role} in ('owner', 'admin') or ${projectMembers.role} = 'maintainer')`,
              ),
            )
            .orderBy(asc(projects.name));
        },
        true,
      );
    },

    async getProject(
      userId: string,
      organizationId: string,
      projectId: string,
    ) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          const [activeMembership] = await transaction
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
          if (!activeMembership) return null;
          await transaction
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.organizationId, organizationId),
                eq(projectMembers.projectId, projectId),
                eq(projectMembers.userId, userId),
                eq(projectMembers.status, "active"),
              ),
            )
            .for("share");
          const [header] = await transaction
            .select({
              id: projects.id,
              name: projects.name,
              slug: projects.slug,
              keyPrefix: projects.keyPrefix,
              description: projects.description,
              status: projects.status,
              version: projects.version,
              heartbeatIntervalSeconds: projects.heartbeatIntervalSeconds,
              leaseMultiplier: projects.leaseMultiplier,
              graceSeconds: projects.graceSeconds,
              requiredWorkspaceFields: projects.requiredWorkspaceFields,
              defaultLaneId: projects.defaultLaneId,
              organizationRole: organizationMembers.role,
              projectRole: projectMembers.role,
            })
            .from(projects)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, projects.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.organizationId, projects.organizationId),
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.status, "active"),
              ),
            )
            .leftJoin(
              projectMembers,
              and(
                eq(projectMembers.organizationId, projects.organizationId),
                eq(projectMembers.projectId, projects.id),
                eq(projectMembers.userId, userId),
                eq(projectMembers.status, "active"),
              ),
            )
            .where(
              and(
                eq(projects.organizationId, organizationId),
                eq(projects.id, projectId),
              ),
            )
            .limit(1);
          if (!header) return null;
          const [aliases, repositories, laneRows, members, availableMembers] =
            await inTurn([
              () =>
                transaction
                  .select({
                    id: projectAliases.id,
                    alias: projectAliases.alias,
                    source: projectAliases.source,
                    createdAt: projectAliases.createdAt,
                  })
                  .from(projectAliases)
                  .where(
                    and(
                      eq(projectAliases.organizationId, organizationId),
                      eq(projectAliases.projectId, projectId),
                    ),
                  )
                  .orderBy(asc(projectAliases.alias)),
              () =>
                transaction
                  .select({
                    id: projectRepositories.id,
                    repositorySlug: projectRepositories.repositorySlug,
                    browseUrl: projectRepositories.browseUrl,
                    cloneUrl: projectRepositories.cloneUrl,
                    isDefault: projectRepositories.isDefault,
                    status: projectRepositories.status,
                  })
                  .from(projectRepositories)
                  .where(
                    and(
                      eq(projectRepositories.organizationId, organizationId),
                      eq(projectRepositories.projectId, projectId),
                    ),
                  )
                  .orderBy(
                    sql`${projectRepositories.isDefault} desc`,
                    asc(projectRepositories.repositorySlug),
                  ),
              () =>
                transaction
                  .select({
                    id: lanes.id,
                    name: lanes.name,
                    slug: lanes.slug,
                    status: lanes.status,
                  })
                  .from(lanes)
                  .where(
                    and(
                      eq(lanes.organizationId, organizationId),
                      eq(lanes.projectId, projectId),
                    ),
                  )
                  .orderBy(asc(lanes.name)),
              () =>
                transaction
                  .select({
                    id: projectMembers.id,
                    userId: projectMembers.userId,
                    name: user.name,
                    email: user.email,
                    role: projectMembers.role,
                    status: projectMembers.status,
                  })
                  .from(projectMembers)
                  .innerJoin(user, eq(user.id, projectMembers.userId))
                  .where(
                    and(
                      eq(projectMembers.organizationId, organizationId),
                      eq(projectMembers.projectId, projectId),
                    ),
                  )
                  .orderBy(asc(user.name)),
              () =>
                transaction
                  .select({
                    userId: organizationMembers.userId,
                    name: user.name,
                    email: user.email,
                  })
                  .from(organizationMembers)
                  .innerJoin(user, eq(user.id, organizationMembers.userId))
                  .where(
                    and(
                      eq(organizationMembers.organizationId, organizationId),
                      eq(organizationMembers.status, "active"),
                    ),
                  )
                  .orderBy(asc(user.name)),
            ]);
          return {
            project: header,
            aliases,
            repositories,
            lanes: laneRows,
            members,
            availableMembers,
            canManage:
              header.organizationRole === "owner" ||
              header.organizationRole === "admin" ||
              header.projectRole === "maintainer",
          };
        },
      );
    },
  };
}

/**
 * The project settings writes, as the command bus reaches them through its
 * unit of work (the `projectSettingsCommands` port; the commands are
 * `@requestport/domain`'s `project-settings-commands.ts`). Handed the bus's
 * transaction, each write runs in a savepoint inside it.
 */
export function createProjectSettingsCommandRepository(database: Database) {
  const repository = {
    async authorize(target: ProjectSettingsTarget) {
      await withTenant(
        target.organizationId,
        (database) => requireProjectManagement(database, target),
        { database },
      );
    },

    addAlias(context: ProjectSettingsMutation, alias: string) {
      const normalizedAlias = normalizeName(alias);
      if (
        normalizedAlias.length > 100 ||
        containsSensitiveContent(normalizedAlias)
      ) {
        throw new DomainError("validation_failed", "Project alias is invalid");
      }
      return mutate(database, context, async (tx) => {
        const [created] = await tx
          .insert(projectAliases)
          .values({
            organizationId: context.organizationId,
            projectId: context.projectId,
            alias: normalizedAlias,
            source: "manual",
          })
          .returning({ id: projectAliases.id });
        if (!created) throw new Error("Project alias persistence failed");
        await audit(
          tx,
          context,
          "project.alias_added",
          "project_alias",
          created.id,
          ["alias"],
        );
        const version = await projectUpdated(tx, context, "alias_added", [
          "alias",
        ]);
        return { id: created.id, version };
      });
    },

    addRepository(context: ProjectSettingsMutation, repositoryUrl: string) {
      const canonical = canonicalizeGitHubRepository(repositoryUrl);
      return mutate(database, context, async (tx) => {
        const [currentDefault] = await tx
          .select({ id: projectRepositories.id })
          .from(projectRepositories)
          .where(
            and(
              eq(projectRepositories.organizationId, context.organizationId),
              eq(projectRepositories.projectId, context.projectId),
              eq(projectRepositories.isDefault, true),
              eq(projectRepositories.status, "active"),
            ),
          )
          .limit(1);
        const [created] = await tx
          .insert(projectRepositories)
          .values({
            organizationId: context.organizationId,
            projectId: context.projectId,
            provider: "github",
            ...canonical,
            isDefault: !currentDefault,
            status: "active",
          })
          .returning({ id: projectRepositories.id });
        if (!created) throw new Error("Project repository persistence failed");
        await audit(
          tx,
          context,
          "project.repository_added",
          "project_repository",
          created.id,
          ["repositoryUrl", "isDefault"],
        );
        const version = await projectUpdated(tx, context, "repository_added", [
          "repositoryUrl",
          "isDefault",
        ]);
        return { id: created.id, version };
      });
    },

    setDefaultRepository(
      context: ProjectSettingsMutation,
      repositoryId: string,
    ) {
      return mutate(database, context, async (tx) => {
        const [target] = await tx
          .select({ id: projectRepositories.id })
          .from(projectRepositories)
          .where(
            and(
              eq(projectRepositories.id, repositoryId),
              eq(projectRepositories.organizationId, context.organizationId),
              eq(projectRepositories.projectId, context.projectId),
              eq(projectRepositories.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!target)
          throw new DomainError("not_found", "Repository was not found");
        await tx
          .update(projectRepositories)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(projectRepositories.organizationId, context.organizationId),
              eq(projectRepositories.projectId, context.projectId),
              eq(projectRepositories.isDefault, true),
            ),
          );
        await tx
          .update(projectRepositories)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(projectRepositories.id, repositoryId));
        await audit(
          tx,
          context,
          "project.repository_defaulted",
          "project_repository",
          repositoryId,
          ["isDefault"],
        );
        const version = await projectUpdated(
          tx,
          context,
          "default_repository_changed",
          ["defaultRepositoryId"],
        );
        return { version };
      });
    },

    setRepositoryStatus(
      context: ProjectSettingsMutation,
      repositoryId: string,
      status: "active" | "archived",
    ) {
      return mutate(database, context, async (tx) => {
        const [target] = await tx
          .select({
            id: projectRepositories.id,
            isDefault: projectRepositories.isDefault,
          })
          .from(projectRepositories)
          .where(
            and(
              eq(projectRepositories.id, repositoryId),
              eq(projectRepositories.organizationId, context.organizationId),
              eq(projectRepositories.projectId, context.projectId),
            ),
          )
          .for("update")
          .limit(1);
        if (!target)
          throw new DomainError("not_found", "Repository was not found");
        if (status === "archived" && target.isDefault) {
          throw new DomainError(
            "conflict",
            "Choose another default repository before archiving this one",
          );
        }
        await tx
          .update(projectRepositories)
          .set({ status, updatedAt: new Date() })
          .where(eq(projectRepositories.id, repositoryId));
        await audit(
          tx,
          context,
          "project.repository_status_changed",
          "project_repository",
          repositoryId,
          ["status"],
        );
        const version = await projectUpdated(
          tx,
          context,
          "repository_status_changed",
          ["repositoryId", "status"],
        );
        return { version };
      });
    },

    addLane(
      context: ProjectSettingsMutation,
      input: { name: string; slug: string },
    ) {
      const name = normalizeName(input.name);
      if (name.length > 100 || containsSensitiveContent(name)) {
        throw new DomainError("validation_failed", "Lane name is invalid");
      }
      return mutate(database, context, async (tx, project) => {
        const [created] = await tx
          .insert(lanes)
          .values({
            organizationId: context.organizationId,
            projectId: context.projectId,
            name,
            slug: input.slug,
            status: "active",
          })
          .returning({ id: lanes.id });
        if (!created) throw new Error("Lane persistence failed");
        if (!project.defaultLaneId) {
          await tx
            .update(projects)
            .set({ defaultLaneId: created.id, updatedAt: new Date() })
            .where(
              and(
                eq(projects.id, context.projectId),
                eq(projects.organizationId, context.organizationId),
              ),
            );
        }
        await audit(tx, context, "project.lane_added", "lane", created.id, [
          "name",
          "slug",
        ]);
        const version = await projectUpdated(tx, context, "lane_added", [
          "lane",
        ]);
        return { id: created.id, version };
      });
    },

    setDefaultLane(context: ProjectSettingsMutation, laneId: string) {
      return mutate(database, context, async (tx) => {
        const [target] = await tx
          .select({ id: lanes.id })
          .from(lanes)
          .where(
            and(
              eq(lanes.id, laneId),
              eq(lanes.organizationId, context.organizationId),
              eq(lanes.projectId, context.projectId),
              eq(lanes.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!target) throw new DomainError("not_found", "Lane was not found");
        await tx
          .update(projects)
          .set({ defaultLaneId: laneId, updatedAt: new Date() })
          .where(
            and(
              eq(projects.id, context.projectId),
              eq(projects.organizationId, context.organizationId),
            ),
          );
        await audit(
          tx,
          context,
          "project.lane_defaulted",
          "project",
          context.projectId,
          ["defaultLaneId"],
        );
        const version = await projectUpdated(
          tx,
          context,
          "default_lane_changed",
          ["defaultLaneId"],
        );
        return { version };
      });
    },

    setLaneStatus(
      context: ProjectSettingsMutation,
      laneId: string,
      status: "active" | "archived",
    ) {
      return mutate(database, context, async (tx, project) => {
        const [target] = await tx
          .select({ id: lanes.id })
          .from(lanes)
          .where(
            and(
              eq(lanes.id, laneId),
              eq(lanes.organizationId, context.organizationId),
              eq(lanes.projectId, context.projectId),
            ),
          )
          .for("update")
          .limit(1);
        if (!target) throw new DomainError("not_found", "Lane was not found");
        if (status === "archived" && project.defaultLaneId === laneId) {
          throw new DomainError(
            "conflict",
            "Choose another default lane before archiving this one",
          );
        }
        if (status === "archived") {
          const [used] = await tx
            .select({ id: requests.id })
            .from(requests)
            .where(
              and(
                eq(requests.organizationId, context.organizationId),
                eq(requests.targetProjectId, context.projectId),
                eq(requests.laneId, laneId),
                sql`${requests.state} not in ('declined', 'duplicate', 'superseded', 'cancelled', 'verified')`,
              ),
            )
            .limit(1);
          if (used) {
            throw new DomainError(
              "conflict",
              "Move or finish active requests before archiving this lane",
            );
          }
        }
        await tx.update(lanes).set({ status }).where(eq(lanes.id, laneId));
        await audit(
          tx,
          context,
          "project.lane_status_changed",
          "lane",
          laneId,
          ["status"],
        );
        const version = await projectUpdated(
          tx,
          context,
          "lane_status_changed",
          ["laneId", "status"],
        );
        return { version };
      });
    },

    setMember(
      context: ProjectSettingsMutation,
      input: {
        userId: string;
        role: "maintainer" | "contributor" | "viewer";
        status: "active" | "revoked";
      },
    ) {
      return mutate(database, context, async (tx) => {
        const [member] = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, context.organizationId),
              eq(organizationMembers.userId, input.userId),
              eq(organizationMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!member)
          throw new DomainError(
            "not_found",
            "Organization member was not found",
          );
        const [record] = await tx
          .insert(projectMembers)
          .values({
            organizationId: context.organizationId,
            projectId: context.projectId,
            userId: input.userId,
            role: input.role,
            status: input.status,
          })
          .onConflictDoUpdate({
            target: [
              projectMembers.organizationId,
              projectMembers.projectId,
              projectMembers.userId,
            ],
            set: {
              role: input.role,
              status: input.status,
              updatedAt: new Date(),
            },
          })
          .returning({ id: projectMembers.id });
        if (!record) throw new Error("Project membership persistence failed");
        await audit(
          tx,
          context,
          "project.member_updated",
          "project_member",
          record.id,
          ["userId", "role", "status"],
        );
        const version = await projectUpdated(
          tx,
          context,
          "membership_changed",
          ["memberId", "role", "status"],
        );
        return { id: record.id, version };
      });
    },

    setWorkPolicy(
      context: ProjectSettingsMutation,
      input: {
        heartbeatIntervalSeconds: number;
        leaseMultiplier: number;
        graceSeconds: number;
        requiredWorkspaceFields: string[];
      },
    ) {
      return mutate(database, context, async (tx) => {
        await tx
          .update(projects)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(projects.organizationId, context.organizationId),
              eq(projects.id, context.projectId),
            ),
          );
        await audit(
          tx,
          context,
          "project.work_policy_updated",
          "project",
          context.projectId,
          [
            "heartbeatIntervalSeconds",
            "leaseMultiplier",
            "graceSeconds",
            "requiredWorkspaceFields",
          ],
        );
        const version = await projectUpdated(
          tx,
          context,
          "work_policy_changed",
          [
            "heartbeatIntervalSeconds",
            "leaseMultiplier",
            "graceSeconds",
            "requiredWorkspaceFields",
          ],
        );
        return { version };
      });
    },

    updateMetadata(
      context: ProjectSettingsMutation,
      input: { name: unknown; description: unknown },
    ) {
      const name = normalizeName(input.name);
      const description = normalizeDescription(input.description);
      return mutate(database, context, async (tx) => {
        await audit(
          tx,
          context,
          "project.metadata_updated",
          "project",
          context.projectId,
          ["name", "description"],
        );
        const version = await projectUpdated(
          tx,
          context,
          "metadata_changed",
          ["name", "description"],
          { name, description },
        );
        return { version };
      });
    },

    setProjectStatus(
      context: ProjectSettingsMutation,
      status: "active" | "archived",
    ) {
      return mutate(database, context, async (tx, project) => {
        if (project.status === status) {
          return {
            status: project.status as "active" | "archived",
            version: project.version,
          };
        }
        if (status === "archived") {
          // One after another: both run on the transaction's one client.
          const activeRequests = await tx
            .select({ id: requests.id })
            .from(requests)
            .where(
              and(
                eq(requests.organizationId, context.organizationId),
                eq(requests.targetProjectId, context.projectId),
                inArray(requests.state, [
                  "draft",
                  "submitted",
                  "triage",
                  "accepted",
                  "planned",
                  "in_progress",
                  "blocked",
                  "waiting_human",
                  "waiting_requester",
                ]),
              ),
            )
            .limit(1);
          const liveSessions = await tx
            .select({ id: workSessions.id })
            .from(workSessions)
            .innerJoin(requests, eq(requests.id, workSessions.requestId))
            .where(
              and(
                eq(workSessions.organizationId, context.organizationId),
                eq(requests.targetProjectId, context.projectId),
                inArray(workSessions.state, [
                  "claimed",
                  "active",
                  "paused",
                  "blocked",
                  "stale",
                ]),
              ),
            )
            .limit(1);
          if (activeRequests[0] || liveSessions[0]) {
            throw new DomainError(
              "conflict",
              "Resolve active requests and work sessions before archiving",
            );
          }
        }
        await audit(
          tx,
          context,
          "project.status_changed",
          "project",
          context.projectId,
          ["status"],
        );
        const version = await projectUpdated(
          tx,
          context,
          status === "archived" ? "archived" : "reactivated",
          ["status"],
          { status },
        );
        return { status, version };
      });
    },
  };
  return repository satisfies ProjectSettingsPort;
}
