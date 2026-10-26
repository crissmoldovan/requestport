import {
  createOverviewQueryRepository,
  createRequestQueryRepository,
} from "@requestport/db";
import { cookies } from "next/headers";

import {
  NoOrganizationSetup,
  OverviewView,
} from "../../components/administration-views.js";
import { getApplicationContext } from "../../lib/server-application-context.js";
import { webStorage } from "../../lib/server-request-port.js";
import {
  isSetupCardHidden,
  SETUP_CARD_HIDDEN_COOKIE,
} from "../../lib/setup-card-cookie.js";
import {
  hideSetupCardAction,
  showSetupCardAction,
} from "./overview-actions.js";

/** Rows of each kind "Needs you" draws, and events "Recent activity" draws. */
const attentionRowsPerKind = 5;
const recentActivityEvents = 6;

export default async function OverviewPage() {
  const context = await getApplicationContext();
  if (!context.currentOrganization) {
    return <NoOrganizationSetup />;
  }
  const storage = webStorage();
  const userId = context.session.user.id;
  const organizationId = context.currentOrganization.id;
  const overview = createOverviewQueryRepository(storage.db);
  const requestQueries = createRequestQueryRepository(storage.db);
  const [figures, questions, triage, failedDeliveries, activity, health] =
    await Promise.all([
      overview.summary(userId, organizationId),
      requestQueries.listOpenQuestions({
        userId,
        organizationId,
        limit: attentionRowsPerKind,
      }),
      overview.listTriageRequests(userId, organizationId, attentionRowsPerKind),
      overview.listFailedDeliveries(
        userId,
        organizationId,
        attentionRowsPerKind,
      ),
      overview.listRecentActivity(userId, organizationId, recentActivityEvents),
      overview.health(userId, organizationId),
    ]);
  // Read before the page renders, so a card this person hid is never drawn.
  const setupHidden = isSetupCardHidden(
    (await cookies()).get(SETUP_CARD_HIDDEN_COOKIE)?.value,
    userId,
    organizationId,
  );
  return (
    <OverviewView
      activity={activity}
      attention={{ failedDeliveries, questions: questions.items, triage }}
      figures={figures}
      health={health}
      now={new Date()}
      organization={context.currentOrganization}
      setupCard={{
        hidden: setupHidden,
        hide: hideSetupCardAction,
        show: showSetupCardAction,
      }}
    />
  );
}
