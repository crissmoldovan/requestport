/**
 * F.2.3 — project settings. Each action dispatches its command on the tenant
 * bus, and `/api/v1` reaches the same command for an operator credential
 * through its registry entry (`credentialKinds: ["operator"]`, ruling 25).
 */
const module = "app/(app)/settings/projects/[projectId]/actions.ts";

export const rows = [
  {
    module,
    action: "addAliasAction",
    status: "ported",
    surfaces: [{ registry: "add_project_alias" }],
  },
  {
    module,
    action: "addRepositoryAction",
    status: "ported",
    surfaces: [{ registry: "add_project_repository" }],
  },
  {
    module,
    action: "setDefaultRepositoryAction",
    status: "ported",
    surfaces: [{ registry: "set_default_project_repository" }],
  },
  {
    module,
    action: "setRepositoryStatusAction",
    status: "ported",
    surfaces: [{ registry: "set_project_repository_status" }],
  },
  {
    module,
    action: "addLaneAction",
    status: "ported",
    surfaces: [{ registry: "add_project_lane" }],
  },
  {
    module,
    action: "setDefaultLaneAction",
    status: "ported",
    surfaces: [{ registry: "set_default_project_lane" }],
  },
  {
    module,
    action: "setLaneStatusAction",
    status: "ported",
    surfaces: [{ registry: "set_project_lane_status" }],
  },
  {
    module,
    action: "setProjectMemberAction",
    status: "ported",
    surfaces: [{ registry: "set_project_member" }],
  },
  {
    module,
    action: "setProjectWorkPolicyAction",
    status: "ported",
    surfaces: [{ registry: "set_project_work_policy" }],
  },
  {
    module,
    action: "updateProjectMetadataAction",
    status: "ported",
    surfaces: [{ registry: "update_project_metadata" }],
  },
  {
    module,
    action: "setProjectStatusAction",
    status: "ported",
    surfaces: [{ registry: "set_project_status" }],
  },
];
