/**
 * F.2.1 — routing rules and route evaluation, with route preview folded in
 * (ruling 5). Mark-read is human-only (ruling 29, rows/human-only.ts). The
 * three rule forms dispatch their commands on the tenant bus, and `/api/v1`
 * reaches the same commands for an operator credential through their
 * registry entries (`credentialKinds: ["operator"]`, ruling 25). The tester
 * and the preview reach one evaluation entry (`evaluateRouteForMember`),
 * which `/api/v1` reaches for an operator through an administration entry
 * per purpose.
 */
const routing = "app/(app)/settings/routing/actions.ts";

export const rows = [
  {
    module: routing,
    action: "createRoutingRuleAction",
    status: "ported",
    surfaces: [{ registry: "create_routing_rule" }],
  },
  {
    module: routing,
    action: "disableRoutingRuleAction",
    status: "ported",
    surfaces: [{ registry: "disable_routing_rule" }],
  },
  {
    module: routing,
    action: "updateRoutingRuleAction",
    status: "ported",
    surfaces: [{ registry: "update_routing_rule" }],
  },
  {
    module: routing,
    action: "testRoutingRuleAction",
    status: "ported",
    surfaces: [{ registry: "test_administration_route" }],
  },
  {
    module: "app/(app)/requests/actions.ts",
    action: "previewRequestRouteAction",
    status: "ported",
    surfaces: [{ registry: "preview_administration_route" }],
  },
];
