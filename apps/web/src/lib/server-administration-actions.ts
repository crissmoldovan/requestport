import { requireHumanSession } from "@requestport/auth/server";
import {
  createFoundationQueryRepository,
  createFoundationRepository,
} from "@requestport/db";
import {
  inviteOrganizationMemberCommandName,
  OrganizationService,
  ProjectService,
} from "@requestport/domain";
import { isUnauthorizedAPIError } from "@requestport/server/better-auth-errors";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdministrationActions } from "./administration-actions.js";
import type { HumanSession } from "./application-context.js";
import { writeCurrentOrganizationCookie } from "./organization-cookie.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "./security/rate-limit.js";
import {
  getCurrentOrganizationForUser,
  raiseScenarioConflict,
} from "./server-application-context.js";
import { coreCommandBus, humanCommandContext } from "./server-core-commands.js";
import { webStorage } from "./server-request-port.js";
import { readE2EScenarioRequest } from "./server-scenario-boundary.js";
import { dispatchCommittedCorrelation } from "./trigger-client.js";

// The organisation switch's read, and the organisation and project creation,
// build their repositories over the web root's storage each time they run
// (Plan 13, G.3), not as this module loads.
export const administrationActions = createAdministrationActions({
  createCorrelationId: () => crypto.randomUUID(),
  dispatchCommittedCorrelation,
  enforceMutationRate: (userId) =>
    enforceRateLimit({
      endpointClass: "mutation",
      fingerprint: rateLimitFingerprint("administration", userId),
    }).then(() => undefined),
  findActiveOrganizationForUser: (userId, organizationId) => {
    const storage = webStorage();

    return createFoundationQueryRepository(
      storage.db,
    ).findActiveOrganizationForUser(userId, organizationId);
  },
  // The one administration command path that resolves its own session rather
  // than reading the shared context adapter, so it is where a guarded local run
  // reaches this surface's conflicting-write state. The raise is once per
  // request and only on a Server Action dispatch; on every deployed build there
  // is no run to be inside, so this is an extra `null`.
  getCurrentOrganization: async (userId) => {
    raiseScenarioConflict((await readE2EScenarioRequest()).fault);

    return getCurrentOrganizationForUser(userId);
  },
  // The invitation form carries no idempotency key: it never had one, and a
  // repeated invitation is answered by the invitation itself (an active one to
  // the same address and role is returned, not duplicated). So each
  // submission mints its own key, and a resubmitted form is a new command that
  // meets that rule, as before. A machine caller sends its own key, and a
  // replay of it is answered from the bus's receipt. `session` is the object
  // `requireHumanSession` returned, Better Auth's session; `humanCommandContext`
  // reads only its user's id and its session's id, which the action checked.
  inviteMember: async ({ session, organizationId, email, role }) =>
    coreCommandBus.execute<unknown, { created: boolean }>({
      name: inviteOrganizationMemberCommandName,
      context: humanCommandContext(session as HumanSession, organizationId),
      input: { organizationId, email, role },
      meta: { expectedVersion: 0, idempotencyKey: crypto.randomUUID() },
    }),
  isUnauthenticatedError: isUnauthorizedAPIError,
  organizationService: {
    create: async (context, input) => {
      const storage = webStorage();

      return new OrganizationService({
        repository: createFoundationRepository(storage.db),
      }).create(context, input);
    },
  },
  projectService: {
    create: async (context, input) => {
      const storage = webStorage();

      return new ProjectService(createFoundationRepository(storage.db)).create(
        context,
        input,
      );
    },
  },
  redirect,
  requireSession: async () => requireHumanSession(await headers()),
  revalidatePath,
  setOrganizationCookie: async (organizationId) => {
    writeCurrentOrganizationCookie(await cookies(), organizationId);
  },
});
