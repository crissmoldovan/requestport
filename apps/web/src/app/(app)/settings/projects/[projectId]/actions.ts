"use server";

import {
  projectSettingsCommandInputSchemas as commands,
  DomainError,
  type ProjectSettingsCommandName,
} from "@requestport/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { namedValidationFailure } from "../../../../../lib/action-field-issues.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../../../lib/server-application-context.js";
import {
  coreCommandBus,
  humanCommandContext,
} from "../../../../../lib/server-core-commands.js";
import type { ProjectSettingsActionState } from "./action-state.js";

/**
 * What every settings form submits besides its own fields: the project, the
 * version the page showed, and the key that makes a resubmission a replay.
 */
const envelope = z.object({
  projectId: z.uuid(),
  idempotencyKey: z.string().min(16).max(200),
  expectedVersion: z.coerce.number().int().positive(),
});

/**
 * A form's schema: the envelope, then the fields of the command it
 * dispatches, parsed by that command's own schema (Plan 13, F.2.3). The
 * organisation is the session's, written in when the command is dispatched,
 * never read from the form.
 */
function formSchema<TName extends ProjectSettingsCommandName>(name: TName) {
  const command = commands[name] as unknown as z.ZodObject<z.ZodRawShape>;
  return envelope.extend(
    command.omit({ organizationId: true, projectId: true }).shape,
  ) as unknown as z.ZodType<
    z.output<typeof envelope> &
      Omit<z.output<(typeof commands)[TName]>, "organizationId" | "projectId">
  >;
}

const aliasSchema = formSchema("add_project_alias");
const repositorySchema = formSchema("add_project_repository");
const repositoryDefaultSchema = formSchema("set_default_project_repository");
const repositoryStatusSchema = formSchema("set_project_repository_status");
const laneSchema = formSchema("add_project_lane");
const laneDefaultSchema = formSchema("set_default_project_lane");
const laneStatusSchema = formSchema("set_project_lane_status");
const memberSchema = formSchema("set_project_member");
const workPolicySchema = formSchema("set_project_work_policy");
const metadataSchema = formSchema("update_project_metadata");
const projectStatusSchema = formSchema("set_project_status");

function mapError(error: unknown): ProjectSettingsActionState {
  if (error instanceof DomainError) {
    const messages = {
      conflict: "That value is already registered in this organization.",
      forbidden: "Project maintenance access is required.",
      idempotency_conflict:
        "This action key was already used for different input.",
      not_found: "The project setting is no longer available.",
      validation_failed: "Check the values and try again.",
      version_conflict: "The project changed. Refresh and try again.",
    } as const;
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message:
        messages[error.code as keyof typeof messages] ??
        "The project setting could not be saved.",
    };
  }
  // A schema's own message travels with the field name it belongs to, because
  // that is the line the reader sees: a lane slug failing its pattern and a
  // malformed repository URL used to arrive as the same five words.
  if (error instanceof z.ZodError)
    return { status: "error", ...namedValidationFailure(error.issues) };
  return {
    status: "error",
    message: "The project setting could not be saved.",
  };
}

/**
 * The session, the organization and the `mutation` limiter.
 *
 * It takes nothing from the submission any more. It used to be handed the
 * project the caller named and the metadata they sent, which meant every one
 * of the eleven actions here parsed its form before anything had resolved a
 * session — and a schema rejection in this module travels with the name of the
 * field it belongs to, so what an anonymous caller got back was an answer per
 * control, from an endpoint whose limiter sits behind this very call.
 */
async function context() {
  const application = await getApplicationContext();
  if (!application.currentOrganization)
    throw new DomainError("forbidden", "An active organization is required");
  await enforceRateLimit({
    endpointClass: "mutation",
    fingerprint: rateLimitFingerprint(
      application.currentOrganization.id,
      application.session.user.id,
    ),
  });
  return {
    organizationId: application.currentOrganization.id,
    command: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
  };
}

/**
 * Runs the project settings command `name` on the tenant bus, as the
 * signed-in person, on the project and at the version the form names. The
 * command checks `project:manage`, the organisation and the person's role
 * before it answers a replay or writes, and the bus keeps the one receipt
 * (Plan 13, F.2.3).
 */
async function dispatch(
  current: Awaited<ReturnType<typeof context>>,
  name: ProjectSettingsCommandName,
  form: z.output<typeof envelope>,
  fields: Record<string, unknown>,
) {
  await coreCommandBus.execute({
    name,
    context: current.command,
    input: {
      organizationId: current.organizationId,
      projectId: form.projectId,
      ...fields,
    },
    meta: {
      expectedVersion: form.expectedVersion,
      idempotencyKey: form.idempotencyKey,
    },
  });
}

function refresh(projectId: string) {
  revalidatePath("/settings/projects");
  revalidatePath(`/settings/projects/${projectId}`);
}

export async function addAliasAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = aliasSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "add_project_alias", input, {
      alias: input.alias,
    });
    refresh(input.projectId);
    return { status: "success", message: "Alias added." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function addRepositoryAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = repositorySchema.parse(Object.fromEntries(formData));
    await dispatch(current, "add_project_repository", input, {
      repositoryUrl: input.repositoryUrl,
    });
    refresh(input.projectId);
    return { status: "success", message: "Repository added." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function setDefaultRepositoryAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = repositoryDefaultSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "set_default_project_repository", input, {
      repositoryId: input.repositoryId,
    });
    refresh(input.projectId);
    return { status: "success", message: "Default repository updated." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function setRepositoryStatusAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = repositoryStatusSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "set_project_repository_status", input, {
      repositoryId: input.repositoryId,
      status: input.status,
    });
    refresh(input.projectId);
    return {
      status: "success",
      message:
        input.status === "archived"
          ? "Repository archived."
          : "Repository reactivated.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function addLaneAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = laneSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "add_project_lane", input, {
      name: input.name,
      slug: input.slug,
    });
    refresh(input.projectId);
    return { status: "success", message: "Lane added." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function setDefaultLaneAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = laneDefaultSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "set_default_project_lane", input, {
      laneId: input.laneId,
    });
    refresh(input.projectId);
    return { status: "success", message: "Default lane updated." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function setLaneStatusAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = laneStatusSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "set_project_lane_status", input, {
      laneId: input.laneId,
      status: input.status,
    });
    refresh(input.projectId);
    return {
      status: "success",
      message:
        input.status === "archived" ? "Lane archived." : "Lane reactivated.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function setProjectMemberAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = memberSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "set_project_member", input, {
      userId: input.userId,
      role: input.role,
      status: input.status,
    });
    refresh(input.projectId);
    return {
      status: "success",
      message:
        input.status === "active"
          ? "Project role saved."
          : "Project access revoked.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function setProjectWorkPolicyAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const submitted = Object.fromEntries(formData);
    // A form sends numbers as text. `Number` is the conversion the command's
    // own schema does not do, and the one `z.coerce.number()` applies.
    const input = workPolicySchema.parse({
      ...submitted,
      heartbeatIntervalSeconds: Number(submitted.heartbeatIntervalSeconds),
      leaseMultiplier: Number(submitted.leaseMultiplier),
      graceSeconds: Number(submitted.graceSeconds),
      requiredWorkspaceFields: formData.getAll("requiredWorkspaceFields"),
    });
    await dispatch(current, "set_project_work_policy", input, {
      heartbeatIntervalSeconds: input.heartbeatIntervalSeconds,
      leaseMultiplier: input.leaseMultiplier,
      graceSeconds: input.graceSeconds,
      requiredWorkspaceFields: [...new Set(input.requiredWorkspaceFields)],
    });
    refresh(input.projectId);
    return { status: "success", message: "Agent work policy updated." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function updateProjectMetadataAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = metadataSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "update_project_metadata", input, {
      name: input.name,
      description: input.description,
    });
    refresh(input.projectId);
    return { status: "success", message: "Project details updated." };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}

export async function setProjectStatusAction(
  _state: ProjectSettingsActionState,
  formData: FormData,
): Promise<ProjectSettingsActionState> {
  try {
    const current = await context();
    const input = projectStatusSchema.parse(Object.fromEntries(formData));
    await dispatch(current, "set_project_status", input, {
      status: input.status,
    });
    refresh(input.projectId);
    return {
      status: "success",
      message:
        input.status === "archived"
          ? "Project archived."
          : "Project reactivated.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return mapError(error);
  }
}
