import {
  createCommandAuthorizationRepository,
  createFoundationQueryRepository,
  createRoutingRepository,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  evaluateRouteForMember,
  type RouteDecision,
  type RouteEvaluationRequest,
} from "@requestport/domain";
import { webStorage } from "./server-request-port.js";

/**
 * Route evaluation as the routing settings tester and the request form's
 * preview both reach it (Plan 13, F.2.1): one transaction, in which the
 * caller's credential is re-checked by the bus's own `assertCurrent` (for a
 * person: a live session, an active membership, an active organisation), and
 * then the domain's `evaluateRouteForMember` reads through repositories built
 * on that transaction. It writes nothing.
 */
export function evaluateRouteInTransaction(
  context: AuthorizedCommandContext,
  request: RouteEvaluationRequest,
): Promise<RouteDecision> {
  const storage = webStorage();
  return storage.transaction(async (tx) => {
    await createCommandAuthorizationRepository(tx).assertCurrent(context);
    return evaluateRouteForMember(
      {
        rules: createRoutingRepository(tx),
        members: createFoundationQueryRepository(tx),
      },
      context,
      request,
    );
  });
}
