import {
  type AuthorizedCommandContext,
  actorFingerprint,
  type CommandMeta,
  canonicalizeGitHubRepository,
  DomainError,
  type JsonValue,
  keyedFingerprint,
  normalizedInputHash,
  normalizeName,
  validateCommandMeta,
} from "@requestport/domain";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import {
  agentPrincipals,
  commandReceipts,
  domainEvents,
  organizations,
  outbox,
  projectAliases,
  projectRepositories,
  projects,
  securityAuditRecords,
} from "../schema/index.js";
import {
  boundOrganizationIdSql,
  inTenantTransaction,
} from "../tenant-context.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";

export function createProjectRegistrationRepository(database: Database) {
  return {
    async register(
      context: AuthorizedCommandContext & {
        actor: { type: "agent"; id: string };
        projectId: string;
      },
      rawInput: { alias?: unknown; repositoryUrl?: unknown },
      meta: CommandMeta,
      fingerprintSecret: string,
    ) {
      validateCommandMeta(meta);
      if (!context.scopes.has("agent:register")) {
        throw new DomainError("forbidden", "Required capability is missing");
      }
      const alias =
        rawInput.alias === undefined ? null : normalizeName(rawInput.alias);
      const repository =
        rawInput.repositoryUrl === undefined
          ? null
          : canonicalizeGitHubRepository(rawInput.repositoryUrl);
      if (!alias && !repository) {
        throw new DomainError(
          "validation_failed",
          "An alias or GitHub repository URL is required",
        );
      }

      const receiptKey = {
        actorFingerprint: actorFingerprint(context.actor),
        commandName: "register_project",
        idempotencyFingerprint: keyedFingerprint(
          fingerprintSecret,
          meta.idempotencyKey,
        ),
      };
      const inputHash = normalizedInputHash({
        organizationId: context.organizationId,
        projectId: context.projectId,
        alias,
        repositoryUrl: repository?.browseUrl ?? null,
      });

      return inTenantTransaction(
        database,
        context.organizationId,
        async (tx) => {
          const receiptLock = `${receiptKey.actorFingerprint}:${receiptKey.commandName}:${receiptKey.idempotencyFingerprint}`;
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('requestport:command:' || ${receiptLock}, 0))`,
          );
          const [existingReceipt] = await tx
            .select({
              normalizedInputHash: commandReceipts.normalizedInputHash,
              result: commandReceipts.resultJson,
            })
            .from(commandReceipts)
            .where(
              and(
                eq(
                  commandReceipts.actorFingerprint,
                  receiptKey.actorFingerprint,
                ),
                eq(commandReceipts.commandName, receiptKey.commandName),
                eq(
                  commandReceipts.idempotencyFingerprint,
                  receiptKey.idempotencyFingerprint,
                ),
              ),
            )
            .limit(1);
          const [organization] = await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(
              and(
                eq(organizations.id, context.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .for("share")
            .limit(1);
          if (!organization) {
            throw new DomainError(
              "forbidden",
              "Agent authorization is inactive",
            );
          }
          const [principal] = await tx
            .select({ id: agentPrincipals.id })
            .from(agentPrincipals)
            .where(
              and(
                eq(agentPrincipals.organizationId, context.organizationId),
                eq(agentPrincipals.id, context.actor.id),
                eq(agentPrincipals.status, "active"),
                or(
                  isNull(agentPrincipals.projectId),
                  eq(agentPrincipals.projectId, context.projectId),
                ),
              ),
            )
            .for("share")
            .limit(1);
          if (!principal) {
            throw new DomainError(
              "forbidden",
              "Agent authorization is inactive",
            );
          }
          const delegatedByUserId = context.actor.delegatedBy?.id ?? null;
          const credential = !delegatedByUserId
            ? await lockActiveApiKeyAuthorization(tx, {
                organizationId: context.organizationId,
                agentPrincipalId: context.actor.id,
                authorizationId: context.credentialId,
                projectId: context.projectId,
              })
            : null;
          const grant = delegatedByUserId
            ? await lockActiveOAuthAuthorization(tx, {
                organizationId: context.organizationId,
                agentPrincipalId: context.actor.id,
                authorizationId: context.credentialId,
                delegatedByUserId,
                projectId: context.projectId,
              })
            : null;
          if (!credential && !grant) {
            throw new DomainError(
              "forbidden",
              "Agent authorization is inactive",
            );
          }
          if (existingReceipt) {
            if (existingReceipt.normalizedInputHash !== inputHash) {
              throw new DomainError(
                "idempotency_conflict",
                "Idempotency key was used with different input",
              );
            }
            return existingReceipt.result as {
              projectId: string;
              version: number;
              alias: { id: string; alias: string } | null;
              repository: {
                id: string;
                browseUrl: string;
                repositorySlug: string;
                isDefault: boolean;
              } | null;
            };
          }
          const locked = await tx.execute<{ id: string; version: number }>(sql`
          select ${projects.id} as id, ${projects.version} as version
          from ${projects}
          where ${projects.organizationId} = ${context.organizationId}
            and ${projects.id} = ${context.projectId}
            and ${projects.status} = 'active'
          for update
        `);
          if (!locked.rows[0]) {
            throw new DomainError("not_found", "Project was not found");
          }
          if (locked.rows[0].version !== meta.expectedVersion) {
            throw new DomainError(
              "version_conflict",
              "Project version changed",
              {
                currentVersion: locked.rows[0].version,
                expectedVersion: meta.expectedVersion,
              },
            );
          }
          let projectVersion = locked.rows[0].version;

          let aliasRecord: typeof projectAliases.$inferSelect | null = null;
          let changed = false;
          if (alias) {
            const [existing] = await tx
              .select()
              .from(projectAliases)
              .where(
                and(
                  eq(projectAliases.organizationId, context.organizationId),
                  sql`lower(${projectAliases.alias}) = lower(${alias})`,
                ),
              )
              .limit(1);
            if (existing && existing.projectId !== context.projectId) {
              throw new DomainError(
                "conflict",
                "Project alias is already registered",
                { field: "alias" },
              );
            }
            if (existing) {
              aliasRecord = existing;
            } else {
              const [created] = await tx
                .insert(projectAliases)
                .values({
                  organizationId: context.organizationId,
                  projectId: context.projectId,
                  alias,
                  source: "agent",
                })
                .returning();
              aliasRecord = created ?? null;
              changed = true;
            }
          }

          let repositoryRecord: typeof projectRepositories.$inferSelect | null =
            null;
          if (repository) {
            const [existing] = await tx
              .select()
              .from(projectRepositories)
              .where(
                and(
                  eq(
                    projectRepositories.organizationId,
                    context.organizationId,
                  ),
                  eq(projectRepositories.provider, "github"),
                  sql`lower(${projectRepositories.repositorySlug}) = lower(${repository.repositorySlug})`,
                ),
              )
              .limit(1);
            if (existing && existing.projectId !== context.projectId) {
              throw new DomainError(
                "conflict",
                "GitHub repository is already registered",
                { field: "repositoryUrl" },
              );
            }
            if (existing) {
              if (existing.status !== "active") {
                throw new DomainError(
                  "conflict",
                  "GitHub repository registration is inactive",
                  { field: "repositoryUrl" },
                );
              }
              repositoryRecord = existing;
            } else {
              const [currentDefault] = await tx
                .select({ id: projectRepositories.id })
                .from(projectRepositories)
                .where(
                  and(
                    eq(
                      projectRepositories.organizationId,
                      context.organizationId,
                    ),
                    eq(projectRepositories.projectId, context.projectId),
                    eq(projectRepositories.isDefault, true),
                  ),
                )
                .limit(1);
              const [created] = await tx
                .insert(projectRepositories)
                .values({
                  organizationId: context.organizationId,
                  projectId: context.projectId,
                  provider: "github",
                  ...repository,
                  isDefault: !currentDefault,
                  status: "active",
                })
                .returning();
              repositoryRecord = created ?? null;
              changed = true;
            }
          }

          if (changed) {
            await tx.insert(securityAuditRecords).values({
              organizationId: context.organizationId,
              actorType: "agent",
              actorId: context.actor.id,
              action: "project.metadata_registered",
              targetType: "project",
              targetId: context.projectId,
              reason:
                "Authenticated project agent registered canonical metadata",
              fieldNames: [
                ...(alias ? ["alias"] : []),
                ...(repository ? ["repositoryUrl"] : []),
              ],
              correlationId: context.correlationId,
            });
            const [project] = await tx
              .update(projects)
              .set({
                version: sql`${projects.version} + 1`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(projects.organizationId, context.organizationId),
                  eq(projects.id, context.projectId),
                ),
              )
              .returning({ version: projects.version });
            if (!project) {
              throw new DomainError("not_found", "Project was not found");
            }
            projectVersion = project.version;
            const eventId = uuidv7();
            await tx.insert(domainEvents).values({
              id: eventId,
              organizationId: context.organizationId,
              aggregateType: "project",
              aggregateId: context.projectId,
              aggregateVersion: project.version,
              type: "project.updated.v1",
              schemaVersion: 1,
              projectId: context.projectId,
              actor: context.actor,
              correlationId: context.correlationId,
              causationId: context.correlationId,
              data: {
                projectId: context.projectId,
                changeType: "agent_metadata_registered",
                fieldNames: [
                  ...(alias ? ["alias"] : []),
                  ...(repository ? ["repositoryUrl"] : []),
                ],
              },
              links: {},
            });
            await tx.insert(outbox).values({ eventId, state: "pending" });
          }

          const result = {
            projectId: context.projectId,
            version: projectVersion,
            alias: aliasRecord
              ? { id: aliasRecord.id, alias: aliasRecord.alias }
              : null,
            repository: repositoryRecord
              ? {
                  id: repositoryRecord.id,
                  browseUrl: repositoryRecord.browseUrl,
                  repositorySlug: repositoryRecord.repositorySlug,
                  isDefault: repositoryRecord.isDefault,
                }
              : null,
          };
          await tx.insert(commandReceipts).values({
            organizationId: boundOrganizationIdSql,
            ...receiptKey,
            normalizedInputHash: inputHash,
            aggregateId: context.projectId,
            resultJson: result as JsonValue,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
          });
          return result;
        },
      );
    },
  };
}
