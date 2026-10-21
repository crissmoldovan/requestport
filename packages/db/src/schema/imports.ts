import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";
import { projectRepositories, projects } from "./projects.js";
import { requests } from "./requests.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const importSources = pgTable(
  "import_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    kind: text("kind").default("git").notNull(),
    repositoryUrl: text("repository_url"),
    repositoryId: uuid("repository_id"),
    createdBy: text("created_by").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("import_sources_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "import_sources_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.repositoryId],
      foreignColumns: [
        projectRepositories.organizationId,
        projectRepositories.id,
      ],
      name: "import_sources_repository_fk",
    }).onDelete("restrict"),
    index("import_sources_org_project_idx").on(
      table.organizationId,
      table.projectId,
    ),
  ],
);

export const sourceSnapshots = pgTable(
  "source_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importSourceId: uuid("import_source_id").notNull(),
    gitCommitSha: text("git_commit_sha"),
    dirty: boolean("dirty").default(false).notNull(),
    capturedAt: utcTimestamp("captured_at").defaultNow().notNull(),
    status: text("status").default("captured").notNull(),
    version: integer("version").default(1).notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "source_snapshots_status_check",
      sql`${table.status} in ('capturing', 'captured', 'blocked', 'analyzed')`,
    ),
    check("source_snapshots_version_check", sql`${table.version} > 0`),
    check(
      "source_snapshots_manifest_sha_check",
      sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    unique("source_snapshots_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("source_snapshots_source_id_id_unique").on(
      table.importSourceId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.importSourceId],
      foreignColumns: [importSources.organizationId, importSources.id],
      name: "source_snapshots_import_source_fk",
    }).onDelete("cascade"),
    index("source_snapshots_source_idx").on(
      table.importSourceId,
      table.capturedAt,
    ),
  ],
);

export const sourceArtifacts = pgTable(
  "source_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importSourceId: uuid("import_source_id").notNull(),
    sourceSnapshotId: uuid("source_snapshot_id").notNull(),
    relativePath: text("relative_path").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    exactBytes: bytea("exact_bytes").notNull(),
    secretScanStatus: text("secret_scan_status").default("clear").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "source_artifacts_byte_size_check",
      sql`${table.byteSize} between 0 and 1048576`,
    ),
    check(
      "source_artifacts_sha_check",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "source_artifacts_scan_check",
      sql`${table.secretScanStatus} in ('clear', 'blocked', 'reviewed')`,
    ),
    unique("source_artifacts_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.importSourceId],
      foreignColumns: [importSources.organizationId, importSources.id],
      name: "source_artifacts_import_source_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.sourceSnapshotId],
      foreignColumns: [sourceSnapshots.organizationId, sourceSnapshots.id],
      name: "source_artifacts_snapshot_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.importSourceId, table.sourceSnapshotId],
      foreignColumns: [sourceSnapshots.importSourceId, sourceSnapshots.id],
      name: "source_artifacts_source_snapshot_fk",
    }).onDelete("cascade"),
    uniqueIndex("source_artifacts_snapshot_path_unique").on(
      table.importSourceId,
      table.sourceSnapshotId,
      table.relativePath,
    ),
    index("source_artifacts_hash_idx").on(table.sha256),
  ],
);

export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importSourceId: uuid("import_source_id").notNull(),
    sourceSnapshotId: uuid("source_snapshot_id").notNull(),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    state: text("state").default("analyzing").notNull(),
    version: integer("version").default(1).notNull(),
    parserVersion: text("parser_version").notNull(),
    manifestSha256: text("manifest_sha256"),
    startedAt: utcTimestamp("started_at").defaultNow().notNull(),
    completedAt: utcTimestamp("completed_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "import_runs_state_check",
      sql`${table.state} in ('analyzing', 'reviewing', 'approved', 'applying', 'applied', 'failed', 'cancelled')`,
    ),
    check("import_runs_version_check", sql`${table.version} > 0`),
    unique("import_runs_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.importSourceId],
      foreignColumns: [importSources.organizationId, importSources.id],
      name: "import_runs_import_source_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.sourceSnapshotId],
      foreignColumns: [sourceSnapshots.organizationId, sourceSnapshots.id],
      name: "import_runs_snapshot_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.importSourceId, table.sourceSnapshotId],
      foreignColumns: [sourceSnapshots.importSourceId, sourceSnapshots.id],
      name: "import_runs_source_snapshot_fk",
    }).onDelete("cascade"),
    index("import_runs_org_state_idx").on(
      table.organizationId,
      table.state,
      table.createdAt,
    ),
  ],
);

export const importTaskDispatches = pgTable(
  "import_task_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importRunId: uuid("import_run_id").notNull(),
    taskKind: text("task_kind").notNull(),
    taskPayload: jsonb("task_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    state: text("state").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    triggerRunId: text("trigger_run_id"),
    lastErrorCode: text("last_error_code"),
    acceptedAt: utcTimestamp("accepted_at"),
    completedAt: utcTimestamp("completed_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "import_task_dispatches_kind_check",
      sql`${table.taskKind} in ('analyze', 'apply')`,
    ),
    check(
      "import_task_dispatches_state_check",
      sql`${table.state} in ('pending', 'leased', 'accepted', 'completed', 'dead_letter')`,
    ),
    check(
      "import_task_dispatches_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "import_task_dispatches_lease_check",
      sql`(${table.state} = 'leased' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'leased' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      "import_task_dispatches_acceptance_check",
      sql`${table.state} <> 'accepted' or (${table.triggerRunId} is not null and ${table.acceptedAt} is not null)`,
    ),
    check(
      "import_task_dispatches_completion_check",
      sql`(${table.state} = 'completed' and ${table.completedAt} is not null) or (${table.state} <> 'completed' and ${table.completedAt} is null)`,
    ),
    foreignKey({
      columns: [table.organizationId, table.importRunId],
      foreignColumns: [importRuns.organizationId, importRuns.id],
      name: "import_task_dispatches_run_fk",
    }).onDelete("cascade"),
    uniqueIndex("import_task_dispatches_run_kind_unique").on(
      table.importRunId,
      table.taskKind,
    ),
    index("import_task_dispatches_repair_idx").on(
      table.state,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const importManifestEntries = pgTable(
  "import_manifest_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importRunId: uuid("import_run_id").notNull(),
    sourceArtifactId: uuid("source_artifact_id").notNull(),
    recordIndex: integer("record_index").notNull(),
    proposedKind: text("proposed_kind").notNull(),
    parsedJson: jsonb("parsed_json").$type<Record<string, unknown>>().notNull(),
    confidenceJson: jsonb("confidence_json")
      .$type<Record<string, number>>()
      .default({})
      .notNull(),
    proposedCanonicalId: uuid("proposed_canonical_id"),
    decision: text("decision").default("pending").notNull(),
    version: integer("version").default(1).notNull(),
    reviewerId: text("reviewer_id"),
    reviewedAt: utcTimestamp("reviewed_at"),
  },
  (table) => [
    check(
      "import_manifest_entries_record_check",
      sql`${table.recordIndex} >= 0`,
    ),
    check(
      "import_manifest_entries_decision_check",
      sql`${table.decision} in ('pending', 'create', 'map_existing', 'message', 'skip', 'blocked')`,
    ),
    check("import_manifest_entries_version_check", sql`${table.version} > 0`),
    unique("import_manifest_entries_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("import_manifest_entries_run_id_id_unique").on(
      table.importRunId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.importRunId],
      foreignColumns: [importRuns.organizationId, importRuns.id],
      name: "import_manifest_entries_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.sourceArtifactId],
      foreignColumns: [sourceArtifacts.organizationId, sourceArtifacts.id],
      name: "import_manifest_entries_artifact_fk",
    }).onDelete("restrict"),
    uniqueIndex("import_manifest_entries_record_unique").on(
      table.importRunId,
      table.sourceArtifactId,
      table.recordIndex,
    ),
  ],
);

export const importConflicts = pgTable(
  "import_conflicts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importRunId: uuid("import_run_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    resolution: jsonb("resolution").$type<Record<string, unknown>>(),
    resolvedBy: text("resolved_by"),
    resolvedAt: utcTimestamp("resolved_at"),
  },
  (table) => [
    check(
      "import_conflicts_severity_check",
      sql`${table.severity} in ('warning', 'blocking')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.importRunId],
      foreignColumns: [importRuns.organizationId, importRuns.id],
      name: "import_conflicts_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.entryId],
      foreignColumns: [
        importManifestEntries.organizationId,
        importManifestEntries.id,
      ],
      name: "import_conflicts_entry_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.importRunId, table.entryId],
      foreignColumns: [
        importManifestEntries.importRunId,
        importManifestEntries.id,
      ],
      name: "import_conflicts_run_entry_fk",
    }).onDelete("cascade"),
    uniqueIndex("import_conflicts_entry_kind_unique").on(
      table.entryId,
      table.kind,
    ),
    index("import_conflicts_run_idx").on(table.importRunId, table.severity),
  ],
);

export const legacyAliases = pgTable(
  "legacy_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceProjectId: uuid("source_project_id").notNull(),
    namespace: text("namespace").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    sourceArtifactId: uuid("source_artifact_id").notNull(),
    recordIndex: integer("record_index").notNull(),
    canonicalRequestId: uuid("canonical_request_id").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.sourceProjectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "legacy_aliases_source_project_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.sourceArtifactId],
      foreignColumns: [sourceArtifacts.organizationId, sourceArtifacts.id],
      name: "legacy_aliases_source_artifact_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.canonicalRequestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "legacy_aliases_canonical_request_fk",
    }).onDelete("restrict"),
    uniqueIndex("legacy_aliases_identity_unique").on(
      table.sourceProjectId,
      table.namespace,
      table.normalizedKey,
      table.sourceArtifactId,
      table.recordIndex,
    ),
  ],
);

export const legacyMappings = pgTable(
  "legacy_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceArtifactId: uuid("source_artifact_id").notNull(),
    recordIndex: integer("record_index").notNull(),
    canonicalType: text("canonical_type").notNull(),
    canonicalId: uuid("canonical_id").notNull(),
    importRunId: uuid("import_run_id").notNull(),
    appliedAt: utcTimestamp("applied_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.sourceArtifactId],
      foreignColumns: [sourceArtifacts.organizationId, sourceArtifacts.id],
      name: "legacy_mappings_source_artifact_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.importRunId],
      foreignColumns: [importRuns.organizationId, importRuns.id],
      name: "legacy_mappings_import_run_fk",
    }).onDelete("restrict"),
    uniqueIndex("legacy_mappings_artifact_record_unique").on(
      table.sourceArtifactId,
      table.recordIndex,
    ),
  ],
);

export const importApplyReports = pgTable(
  "import_apply_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importRunId: uuid("import_run_id").notNull(),
    counts: jsonb("counts").$type<Record<string, number>>().notNull(),
    warnings: jsonb("warnings")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.importRunId],
      foreignColumns: [importRuns.organizationId, importRuns.id],
      name: "import_apply_reports_run_fk",
    }).onDelete("restrict"),
    uniqueIndex("import_apply_reports_run_unique").on(table.importRunId),
    check(
      "import_apply_reports_sha_check",
      sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const importEntryApplications = pgTable(
  "import_entry_applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importRunId: uuid("import_run_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    outcome: text("outcome").notNull(),
    canonicalType: text("canonical_type"),
    canonicalId: uuid("canonical_id"),
    warnings: jsonb("warnings")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "import_entry_applications_outcome_check",
      sql`${table.outcome} in ('created', 'mapped', 'message', 'skipped', 'existing', 'corrected_message')`,
    ),
    check(
      "import_entry_applications_canonical_check",
      sql`(${table.canonicalType} is null and ${table.canonicalId} is null) or (${table.canonicalType} is not null and ${table.canonicalId} is not null)`,
    ),
    foreignKey({
      columns: [table.organizationId, table.importRunId],
      foreignColumns: [importRuns.organizationId, importRuns.id],
      name: "import_entry_applications_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.entryId],
      foreignColumns: [
        importManifestEntries.organizationId,
        importManifestEntries.id,
      ],
      name: "import_entry_applications_entry_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.importRunId, table.entryId],
      foreignColumns: [
        importManifestEntries.importRunId,
        importManifestEntries.id,
      ],
      name: "import_entry_applications_run_entry_fk",
    }).onDelete("restrict"),
    uniqueIndex("import_entry_applications_run_entry_unique").on(
      table.importRunId,
      table.entryId,
    ),
    index("import_entry_applications_run_idx").on(
      table.importRunId,
      table.createdAt,
    ),
  ],
);
