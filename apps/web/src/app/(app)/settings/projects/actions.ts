"use server";

import type { AdministrationActionState } from "../../../../lib/administration-actions.js";
import { administrationActions } from "../../../../lib/server-administration-actions.js";

export async function createProjectAction(
  _previousState: AdministrationActionState,
  formData: FormData,
) {
  return administrationActions.createProject(formData);
}
