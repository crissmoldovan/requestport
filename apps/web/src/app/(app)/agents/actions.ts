"use server";

import { agentApiKeyService } from "@requestport/auth/server";
import { serverEnv } from "@requestport/config/server";
import {
  createAgentAuthRepository,
  createWorkspaceRepository,
} from "@requestport/db";
import {
  DomainError,
  privateTelemetryFields,
  WorkspaceService,
} from "@requestport/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { namedValidationFailure } from "../../../lib/action-field-issues.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../lib/security/rate-limit.js";
import {
  revokeAgentCredential,
  revokeAgentOauthGrant,
} from "../../../lib/server-agent-actions.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import {
  coreCommandBus,
  humanCommandContext,
  workspaceEncryption,
} from "../../../lib/server-core-commands.js";
import { webStorage } from "../../../lib/server-request-port.js";
import type { AgentActionState } from "./agent-action-state.js";

const createSchema = z.object({
  projectId: z.union([z.literal(""), z.uuid()]),
  displayName: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
  softwareName: z.string().trim().max(160),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const issueSchema = z.object({
  agentPrincipalId: z.uuid(),
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  audience: z.enum(["mcp", "api"]),
  laneIds: z.array(z.uuid()).max(100),
  scopes: z.array(z.string()).min(1).max(30),
  expiresInDays: z.coerce.number().int().min(1).max(365),
  expectedVersion: z.coerce.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const credentialSchema = z.object({
  agentPrincipalId: z.uuid(),
  credentialId: z.uuid(),
  overlapMinutes: z.coerce.number().int().min(0).max(60).optional(),
  expectedVersion: z.coerce.number().int().positive(),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const oauthGrantSchema = z.object({
  agentPrincipalId: z.uuid(),
  grantId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
  expectedVersion: z.coerce.number().int().positive(),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const revealSchema = z.object({
  workspaceId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
  fields: z
    .array(z.enum(privateTelemetryFields))
    .min(1)
    .max(privateTelemetryFields.length),
  expectedVersion: z.coerce.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const statusSchema = z.object({
  agentPrincipalId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  status: z.enum(["active", "suspended", "revoked"]),
  reason: z.string().trim().min(10).max(500),
  idempotencyKey: z.string().trim().min(16).max(200),
});

function errorState(error: unknown): AgentActionState {
  if (error instanceof DomainError) {
    const messages: Record<string, string> = {
      configuration_error:
        "Encrypted workspace telemetry is not configured in this environment.",
      conflict:
        "That agent change conflicts with current state. If credential issuance already completed, its plaintext cannot be shown again; create or rotate a replacement.",
      idempotency_conflict:
        "This action key was already used for different values.",
      forbidden: "You do not have permission to manage this agent.",
      not_found: "That agent resource is no longer available.",
      validation_failed: "Check the values and try again.",
      version_conflict: "This record changed. Refresh and try again.",
    };
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message:
        messages[error.code] ?? "The agent action could not be completed.",
    };
  }
  // A schema's own message travels with the field name it belongs to, because
  // that is the line the reader sees: a malformed slug and an out-of-range
  // expiry used to arrive as the same five words.
  if (error instanceof z.ZodError) {
    return { status: "error", ...namedValidationFailure(error.issues) };
  }
  return {
    status: "error",
    message: "The agent action could not be completed.",
  };
}

/**
 * The session, the organization and the `mutation` limiter.
 *
 * Every action here resolves this before it reads a value out of its
 * submission. Parsing first answered an anonymous caller a question about the
 * body they sent — a schema rejection in this module travels with the name of
 * the field it belongs to, so the answer was distinguishable per control — and
 * because the limiter is resolved by the very call the action had skipped,
 * there was no bound on how often they could ask again.
 */
async function actionContext() {
  const application = await getApplicationContext();
  if (!application.currentOrganization) {
    throw new DomainError("forbidden", "An active organization is required");
  }
  await enforceRateLimit({
    endpointClass: "mutation",
    fingerprint: rateLimitFingerprint(
      application.currentOrganization.id,
      application.session.user.id,
    ),
  });
  return {
    application,
    organization: application.currentOrganization,
    command: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
  };
}

async function credentialForAction(
  organizationId: string,
  agentPrincipalId: string,
  credentialId: string,
) {
  const storage = webStorage();
  const credentials = await createAgentAuthRepository(
    storage.db,
  ).listCredentials(organizationId, agentPrincipalId);
  const credential = credentials.find((item) => item.id === credentialId);
  if (!credential)
    throw new DomainError("not_found", "Credential was not found");
  return credential;
}

export async function createAgentAction(
  _previous: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  try {
    const current = await actionContext();
    const input = createSchema.parse(Object.fromEntries(formData));
    await coreCommandBus.execute({
      name: "create_agent_principal",
      context: current.command,
      meta: { expectedVersion: 0, idempotencyKey: input.idempotencyKey },
      input: {
        organizationId: current.organization.id,
        projectId: input.projectId || null,
        displayName: input.displayName,
        slug: input.slug,
        softwareName: input.softwareName || null,
      },
    });
    revalidatePath("/agents");
    return { status: "success", message: "Agent principal created." };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function setAgentStatusAction(
  _previous: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  try {
    const current = await actionContext();
    const input = statusSchema.parse(Object.fromEntries(formData));
    await coreCommandBus.execute({
      name: "set_agent_principal_status",
      context: current.command,
      meta: {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
      input: {
        organizationId: current.organization.id,
        agentPrincipalId: input.agentPrincipalId,
        status: input.status,
        reason: input.reason,
      },
    });
    revalidatePath(`/agents/${input.agentPrincipalId}`);
    revalidatePath("/agents");
    return { status: "success", message: `Agent ${input.status}.` };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function issueAgentKeyAction(
  _previous: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  try {
    const current = await actionContext();
    const input = issueSchema.parse({
      ...Object.fromEntries(formData),
      laneIds: formData.getAll("laneIds"),
      scopes: formData.getAll("scopes"),
    });
    const result = await agentApiKeyService.issue(
      current.command,
      {
        organizationId: current.organization.id,
        ...input,
        laneIds: input.laneIds,
      },
      {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    );
    revalidatePath(`/agents/${input.agentPrincipalId}`);
    return {
      status: "success",
      message:
        "Credential created. Copy it now; RequestPort never stores or reveals the plaintext again.",
      plaintextKey: result.plaintextKey,
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function revokeAgentKeyAction(
  _previous: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  try {
    const current = await actionContext();
    const input = credentialSchema.parse(Object.fromEntries(formData));
    await revokeAgentCredential(
      current.command,
      {
        organizationId: current.organization.id,
        agentPrincipalId: input.agentPrincipalId,
        credentialId: input.credentialId,
      },
      {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    );
    revalidatePath(`/agents/${input.agentPrincipalId}`);
    return { status: "success", message: "Credential revoked." };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function rotateAgentKeyAction(
  _previous: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  try {
    const current = await actionContext();
    const input = credentialSchema.parse(Object.fromEntries(formData));
    const credential = await credentialForAction(
      current.organization.id,
      input.agentPrincipalId,
      input.credentialId,
    );
    const result = await agentApiKeyService.rotate(current.command, {
      organizationId: current.organization.id,
      credential,
      overlapMinutes: input.overlapMinutes,
      meta: {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    });
    revalidatePath(`/agents/${input.agentPrincipalId}`);
    return {
      status: "success",
      message:
        "Replacement created. Copy it now; the old credential remains valid only for the selected overlap.",
      plaintextKey: result.plaintextKey,
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function revokeAgentOauthGrantAction(
  _previous: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  try {
    const current = await actionContext();
    const input = oauthGrantSchema.parse(Object.fromEntries(formData));
    const result = await revokeAgentOauthGrant(
      current.command,
      {
        organizationId: current.organization.id,
        agentPrincipalId: input.agentPrincipalId,
        grantId: input.grantId,
        reason: input.reason,
      },
      {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    );
    revalidatePath(`/agents/${input.agentPrincipalId}`);
    return {
      status: "success",
      message: result.revoked
        ? "OAuth grant revoked. Existing and refreshed tokens are now denied."
        : "OAuth grant was already revoked.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function revealWorkspaceTelemetryAction(
  _previous: AgentActionState,
  formData: FormData,
): Promise<AgentActionState> {
  try {
    const current = await actionContext();
    const input = revealSchema.parse({
      ...Object.fromEntries(formData),
      fields: formData.getAll("fields"),
    });
    if (!workspaceEncryption) {
      throw new DomainError(
        "configuration_error",
        "Workspace encryption is unavailable",
      );
    }
    const storage = webStorage();
    const result = await new WorkspaceService({
      repository: createWorkspaceRepository(storage.db),
      encryption: workspaceEncryption,
      fingerprintSecret: serverEnv.BETTER_AUTH_SECRET,
    }).revealPrivateProjection(current.command, {
      organizationId: current.organization.id,
      ...input,
    });
    return {
      status: "success",
      message: "Private telemetry revealed and recorded in the security audit.",
      telemetryJson: JSON.stringify(result.data, null, 2),
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}
