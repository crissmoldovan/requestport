"use server";

import type { AdministrationActionState } from "../../lib/administration-actions.js";
import { administrationActions } from "../../lib/server-administration-actions.js";

export async function inviteMemberAction(
  _previousState: AdministrationActionState,
  formData: FormData,
) {
  return administrationActions.inviteMember(formData);
}
