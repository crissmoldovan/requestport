"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../lib/server-application-context.js";
import {
  SETUP_CARD_HIDDEN_COOKIE,
  withSetupCardHidden,
  writeSetupCardCookie,
} from "../../lib/setup-card-cookie.js";

/*
  The overview setup card's Hide and Show (ruling 261). Neither reads what the
  browser sends: the person and the organization are the session's, so a
  request can hide or show the card only for whoever signed it in, in the
  organization they are in, and the choice is that browser's cookie
  (`setup-card-cookie.ts`).
*/

/** Hides the setup card for the signed-in person in their organization. */
export async function hideSetupCardAction() {
  await setSetupCardHidden(true);
}

/** Shows the setup card again for the signed-in person in their organization. */
export async function showSetupCardAction() {
  await setSetupCardHidden(false);
}

async function setSetupCardHidden(hidden: boolean) {
  const context = await getApplicationContext();
  const organization = context.currentOrganization;
  if (!organization) return;
  const userId = context.session.user.id;
  await enforceRateLimit({
    endpointClass: "mutation",
    fingerprint: rateLimitFingerprint("overview-setup-card", userId),
  });
  const cookieStore = await cookies();
  writeSetupCardCookie(
    cookieStore,
    withSetupCardHidden(
      cookieStore.get(SETUP_CARD_HIDDEN_COOKIE)?.value,
      userId,
      organization.id,
      hidden,
    ),
  );
  revalidatePath("/");
}
