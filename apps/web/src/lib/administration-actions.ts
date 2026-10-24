import {
  DomainError,
  type DomainErrorCode,
  type OrganizationAccess,
  type OrganizationService,
  type ProjectService,
  utf16Max,
} from "@requestport/domain";
import { z } from "zod";

import { ORGANIZATION_CREATE_DESTINATION } from "./organization-create.js";
import { sameOriginDestination } from "./organization-switch.js";

type ActionField =
  | "email"
  | "keyPrefix"
  | "name"
  | "organizationId"
  | "repositoryUrl"
  | "role"
  | "slug";

export type AdministrationActionState =
  | {
      status: "success";
      message: string;
      /**
       * Where the client should send the whole document next. Present only on
       * the actions that change which tenant the next document resolves — an
       * organization switch — and never on an ordinary in-place mutation.
       */
      destination?: string;
    }
  | {
      status: "error";
      code: DomainErrorCode | "unexpected_error";
      field?: ActionField;
      message: string;
    };

type ActionSession = { user: { id: string } };

/**
 * The session `requireSession` returned, narrowed to the two identifiers a
 * command on the tenant bus takes from it: the person, and the session the
 * bus's `assertCurrent` re-checks.
 */
export type CommandSession = {
  user: { id: string };
  session: { id: string };
};

type OrganizationRole = "owner" | "admin" | "member";

type AdministrationActionDependencies = {
  createCorrelationId: () => string;
  dispatchCommittedCorrelation?: (
    correlationId: string,
    organizationId: string,
  ) => Promise<void>;
  enforceMutationRate?: (userId: string) => Promise<void>;
  findActiveOrganizationForUser: (
    userId: string,
    organizationId: string,
  ) => Promise<OrganizationAccess | null>;
  getCurrentOrganization: (
    userId: string,
  ) => Promise<OrganizationAccess | null>;
  isUnauthenticatedError: (error: unknown) => boolean;
  /**
   * Runs `invite_organization_member` on the tenant bus as the signed-in person
   * (Plan 13, F.2.7), answering whether it created the invitation. The bus
   * dispatches the invitation's outbox row after it commits, which is what
   * sends the email.
   */
  inviteMember: (input: {
    session: CommandSession;
    organizationId: string;
    email: string;
    role: OrganizationRole;
  }) => Promise<{ created: boolean }>;
  organizationService: Pick<OrganizationService, "create">;
  projectService: Pick<ProjectService, "create">;
  /** The one server redirect left: a project registration stays in-tenant. */
  redirect: (path: "/settings/projects") => void;
  requireSession: () => Promise<unknown>;
  revalidatePath: (path: string, type?: "layout") => void;
  setOrganizationCookie: (organizationId: string) => Promise<void> | void;
};

const organizationSchema = z.object({
  name: z.string().check(utf16Max(160)),
  slug: z.string().check(utf16Max(63)),
});
const projectSchema = z.object({
  name: z.string().check(utf16Max(160)),
  slug: z.string().check(utf16Max(63)),
  keyPrefix: z.string().check(utf16Max(10)),
  description: z.string().check(utf16Max(2_000)).optional(),
  repositoryUrl: z.string().check(utf16Max(500)).optional(),
});
const invitationSchema = z.object({
  email: z.string().check(utf16Max(320)),
  role: z.enum(["owner", "admin", "member"]),
});
const switchSchema = z.object({ organizationId: z.uuid() });
const SAFE_FIELDS = new Set<ActionField>([
  "email",
  "keyPrefix",
  "name",
  "organizationId",
  "repositoryUrl",
  "role",
  "slug",
]);

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function sessionUserId(session: unknown): string | null {
  if (typeof session !== "object" || session === null) return null;
  const user = (session as ActionSession).user;
  return user && typeof user.id === "string" && user.id.length > 0
    ? user.id
    : null;
}

function commandSession(session: unknown): CommandSession | null {
  if (sessionUserId(session) === null) return null;
  const inner = (session as { session?: unknown }).session;
  return typeof inner === "object" &&
    inner !== null &&
    typeof (inner as { id?: unknown }).id === "string" &&
    (inner as { id: string }).id.length > 0
    ? (session as CommandSession)
    : null;
}

function inputError(field?: string): AdministrationActionState {
  return {
    status: "error",
    code: "validation_failed",
    field:
      field && SAFE_FIELDS.has(field as ActionField)
        ? (field as ActionField)
        : undefined,
    message: "Check the highlighted field and try again.",
  };
}

function mapActionError(error: unknown): AdministrationActionState {
  if (error instanceof DomainError) {
    const field = error.details.field;
    const messages: Record<DomainErrorCode, string> = {
      unauthenticated: "Sign in to continue.",
      forbidden: "You do not have permission to complete that action.",
      not_found: "The requested record is unavailable.",
      conflict: "That canonical value is already in use.",
      configuration_error:
        "This feature is not configured for this environment.",
      validation_failed: "Check the highlighted field and try again.",
      already_answered: "This question already has a canonical answer.",
      idempotency_conflict:
        "This action key was already used for different input.",
      invalid_state: "This record is not available from its current state.",
      invalid_transition:
        "This action is not available from the current state.",
      rate_limited: "Too many requests. Try again shortly.",
      route_denied: "The current routing policy denies this request.",
      version_conflict: "This record changed. Refresh and try again.",
    };
    return {
      status: "error",
      code: error.code,
      field:
        typeof field === "string" && SAFE_FIELDS.has(field as ActionField)
          ? (field as ActionField)
          : undefined,
      message: messages[error.code],
    };
  }
  return {
    status: "error",
    code: "unexpected_error",
    message: "RequestPort could not complete that action.",
  };
}

function commandContext(userId: string, createCorrelationId: () => string) {
  return {
    actor: { type: "user" as const, userId },
    correlationId: createCorrelationId(),
  };
}

export function createAdministrationActions(
  dependencies: AdministrationActionDependencies,
) {
  async function dispatchCommittedCorrelation(
    correlationId: string,
    organizationId: string,
  ) {
    try {
      await dependencies.dispatchCommittedCorrelation?.(
        correlationId,
        organizationId,
      );
    } catch {
      // Canonical state and outbox are already committed. The repair schedule is
      // the durable fallback when the best-effort Trigger submission is unknown.
    }
  }

  function sessionFailure(error: unknown): AdministrationActionState {
    return dependencies.isUnauthenticatedError(error)
      ? {
          status: "error",
          code: "unauthenticated",
          message: "Sign in to continue.",
        }
      : {
          status: "error",
          code: "unexpected_error",
          message: "RequestPort could not complete that action.",
        };
  }

  async function requireActor(): Promise<string | AdministrationActionState> {
    try {
      const userId = sessionUserId(await dependencies.requireSession());
      if (userId) await dependencies.enforceMutationRate?.(userId);
      return (
        userId ?? {
          status: "error",
          code: "unauthenticated",
          message: "Sign in to continue.",
        }
      );
    } catch (error) {
      return dependencies.isUnauthenticatedError(error)
        ? {
            status: "error",
            code: "unauthenticated",
            message: "Sign in to continue.",
          }
        : {
            status: "error",
            code: "unexpected_error",
            message: "RequestPort could not complete that action.",
          };
    }
  }

  /**
   * `requireActor`, for an action that runs a command on the tenant bus: the
   * session is kept, because the command context takes the session's id as
   * well as the person's, and the bus re-checks that session. A session
   * without an id is answered as unauthenticated.
   */
  async function requireCommandSession(): Promise<
    CommandSession | AdministrationActionState
  > {
    try {
      const session = commandSession(await dependencies.requireSession());
      if (session) await dependencies.enforceMutationRate?.(session.user.id);
      return (
        session ?? {
          status: "error",
          code: "unauthenticated",
          message: "Sign in to continue.",
        }
      );
    } catch (error) {
      return sessionFailure(error);
    }
  }

  return {
    async createOrganization(
      formData: FormData,
    ): Promise<AdministrationActionState> {
      const userId = await requireActor();
      if (typeof userId !== "string") return userId;
      const parsed = organizationSchema.safeParse({
        name: readString(formData, "name"),
        slug: readString(formData, "slug"),
      });
      if (!parsed.success)
        return inputError(parsed.error.issues[0]?.path[0]?.toString());
      let organization: { id: string };
      let correlationId: string;
      try {
        correlationId = dependencies.createCorrelationId();
        organization = await dependencies.organizationService.create(
          commandContext(userId, () => correlationId),
          parsed.data,
        );
      } catch (error) {
        return mapActionError(error);
      }
      await dispatchCommittedCorrelation(correlationId, organization.id);
      try {
        await dependencies.setOrganizationCookie(organization.id);
      } catch (error) {
        return mapActionError(error);
      }
      // No server redirect and no revalidation, for the reason the switch below
      // records: the cookie written above makes the new organization the
      // current tenant, so the appearance triple the next document resolves
      // changes with it. A revalidating action ships the refreshed tree for the
      // current route back in the same response and the router adopts the new
      // tenant's theme during a client transition — while `<html>` still
      // carries the outgoing document's stamp — and `redirect()` from an action
      // is that same client navigation. This runs behind a Route Handler
      // instead, where no such header is produced; the client navigates the
      // whole document to the destination below, and that fresh request is what
      // resolves the new tenant's appearance.
      return {
        destination: ORGANIZATION_CREATE_DESTINATION,
        message: "Organization created.",
        status: "success",
      };
    },

    async createProject(
      formData: FormData,
    ): Promise<AdministrationActionState> {
      const userId = await requireActor();
      if (typeof userId !== "string") return userId;
      const parsed = projectSchema.safeParse({
        name: readString(formData, "name"),
        slug: readString(formData, "slug"),
        keyPrefix: readString(formData, "keyPrefix"),
        description: readString(formData, "description") || undefined,
        repositoryUrl: readString(formData, "repositoryUrl") || undefined,
      });
      if (!parsed.success)
        return inputError(parsed.error.issues[0]?.path[0]?.toString());
      let currentOrganization: OrganizationAccess | null;
      try {
        currentOrganization = await dependencies.getCurrentOrganization(userId);
      } catch (error) {
        return mapActionError(error);
      }
      if (!currentOrganization)
        return {
          status: "error",
          code: "forbidden",
          message: "Choose an active organization before creating a project.",
        };
      let correlationId: string;
      try {
        correlationId = dependencies.createCorrelationId();
        await dependencies.projectService.create(
          commandContext(userId, () => correlationId),
          {
            organizationId: currentOrganization.id,
            ...parsed.data,
          },
        );
      } catch (error) {
        return mapActionError(error);
      }
      await dispatchCommittedCorrelation(correlationId, currentOrganization.id);
      try {
        dependencies.revalidatePath("/settings/projects");
      } catch (error) {
        return mapActionError(error);
      }
      dependencies.redirect("/settings/projects");
      return { status: "success", message: "Project created." };
    },

    async inviteMember(formData: FormData): Promise<AdministrationActionState> {
      const session = await requireCommandSession();
      if (!("user" in session)) return session;
      const parsed = invitationSchema.safeParse({
        email: readString(formData, "email"),
        role: readString(formData, "role"),
      });
      if (!parsed.success)
        return inputError(parsed.error.issues[0]?.path[0]?.toString());
      let currentOrganization: OrganizationAccess | null;
      try {
        currentOrganization = await dependencies.getCurrentOrganization(
          session.user.id,
        );
      } catch (error) {
        return mapActionError(error);
      }
      if (!currentOrganization)
        return {
          status: "error",
          code: "forbidden",
          message: "Choose an active organization before inviting a member.",
        };
      let created: boolean;
      try {
        const result = await dependencies.inviteMember({
          session,
          organizationId: currentOrganization.id,
          ...parsed.data,
        });
        created = result.created;
      } catch (error) {
        // The generic conflict sentence would not say why: the address's
        // person already has an account, and nothing yet accepts an
        // invitation for an existing account.
        if (
          error instanceof DomainError &&
          error.code === "conflict" &&
          error.details.reason === "existing_account"
        ) {
          return {
            status: "error",
            code: "conflict",
            field: "email",
            message:
              "This person already has a RequestPort account. Inviting an existing account is not supported yet, so no invitation was sent.",
          };
        }
        return mapActionError(error);
      }
      try {
        dependencies.revalidatePath("/settings/members");
      } catch (error) {
        return mapActionError(error);
      }
      return {
        status: "success",
        message: created
          ? "Invitation created and queued for email."
          : "An active matching invitation already exists.",
      };
    },

    async switchOrganization(
      formData: FormData,
    ): Promise<AdministrationActionState> {
      const userId = await requireActor();
      if (typeof userId !== "string") return userId;
      const parsed = switchSchema.safeParse({
        organizationId: readString(formData, "organizationId"),
      });
      if (!parsed.success) return inputError("organizationId");
      let organization: OrganizationAccess | null;
      try {
        organization = await dependencies.findActiveOrganizationForUser(
          userId,
          parsed.data.organizationId,
        );
      } catch (error) {
        return mapActionError(error);
      }
      if (!organization) {
        return {
          status: "error",
          code: "forbidden",
          message: "That organization is unavailable.",
        };
      }
      try {
        await dependencies.setOrganizationCookie(organization.id);
      } catch (error) {
        return mapActionError(error);
      }
      // No server redirect and no revalidation, and — the part neither of those
      // could have delivered on its own — this runs behind a Route Handler
      // rather than a Server Action. The cookie write above is what forces the
      // question: Next stamps `x-action-revalidated` on any action response
      // whose mutable cookies changed, and the client reducer answers it by
      // refetching the current route tree into the open document, which is the
      // transition the appearance contract forbids. Off the action path there
      // is no such header, no route refetch, and nothing served from a cache a
      // revalidation would clear — every route here is dynamic. The client
      // navigates the whole document to the destination validated below, and
      // that fresh request is what resolves the new tenant's appearance.
      return {
        destination: sameOriginDestination(readString(formData, "returnTo")),
        message: "Organization switched.",
        status: "success",
      };
    },
  };
}
