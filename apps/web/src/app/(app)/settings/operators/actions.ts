"use server";

import {
  operatorCredentialAvailability,
  operatorCredentialService,
} from "@requestport/auth/server";
import { DomainError } from "@requestport/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import {
  coreCommandBus,
  humanCommandContext,
} from "../../../../lib/server-core-commands.js";
import {
  createOperatorActions,
  operatorActionError,
} from "../../../../lib/server-operator-actions.js";
import type { OperatorActionState } from "./action-state.js";

/*
  Operator credentials on the web (Plan 13, F.3): a person issues, rotates and
  revokes them here. Each action resolves the session, the organisation and
  the `mutation` limiter before it reads its submission, and answers the
  unavailable state while F3-14's answer is off. Navigation to this page is
  F.3.1's; until then it is reachable by its URL only.
*/

const operatorActions = createOperatorActions({
  availability: operatorCredentialAvailability,
  service: operatorCredentialService,
  executeCommand: (command) => coreCommandBus.execute(command),
  revalidatePath: (path) => revalidatePath(path),
});

/** The session, the organisation and the `mutation` limiter. */
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
    organizationId: application.currentOrganization.id,
    command: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
  };
}

export async function issueOperatorCredentialAction(
  _previous: OperatorActionState,
  formData: FormData,
): Promise<OperatorActionState> {
  try {
    const current = await actionContext();
    return await operatorActions.issue(current, formData);
  } catch (error) {
    unstable_rethrow(error);
    return operatorActionError(error);
  }
}

export async function rotateOperatorCredentialAction(
  _previous: OperatorActionState,
  formData: FormData,
): Promise<OperatorActionState> {
  try {
    const current = await actionContext();
    return await operatorActions.rotate(current, formData);
  } catch (error) {
    unstable_rethrow(error);
    return operatorActionError(error);
  }
}

export async function revokeOperatorCredentialAction(
  _previous: OperatorActionState,
  formData: FormData,
): Promise<OperatorActionState> {
  try {
    const current = await actionContext();
    return await operatorActions.revoke(current, formData);
  } catch (error) {
    unstable_rethrow(error);
    return operatorActionError(error);
  }
}
