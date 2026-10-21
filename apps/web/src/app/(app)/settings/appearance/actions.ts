"use server";

import { appearanceActions } from "../../../../lib/server-appearance-actions.js";
import type { AppearanceActionState } from "./action-state.js";

export async function updatePersonalAppearanceAction(
  _previousState: AppearanceActionState,
  formData: FormData,
) {
  return appearanceActions.updatePersonalPreferences(formData);
}

export async function updateOrganizationAppearanceAction(
  _previousState: AppearanceActionState,
  formData: FormData,
) {
  return appearanceActions.updateOrganizationDefaults(formData);
}
