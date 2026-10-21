/**
 * What this pass does not yet drive.
 *
 * Its own module because two readers need it and only one of them can reach
 * the surface table. The runner asks it, case by case, which cases it may not
 * start; `playwright.config.ts` asks it the same question to budget a shard
 * for the cases its project will actually run, and the config is loaded by a
 * plain Node process that resolves a specifier to the file it names. Nothing
 * here imports anything, so both readers get the same answer from the same
 * list, and a rule added to it is charged and skipped in one edit.
 */

/**
 * The states this pass declines to claim, and why.
 *
 * A skip is a statement, not an omission: each rule says which cases it covers
 * and what stands in the way, and `acceptance-runner-contract.test.ts` fails
 * both on a rule that matches no case — a rule kept past its reason — and on a
 * case the runner skips without a rule. Nothing can be quietly dropped, and the
 * list can only shrink by a deliberate edit.
 */
export type AcceptanceSkipRule = Readonly<{
  /**
   * The fixture owners the rule declines, when it declines only some of them.
   *
   * A surface and a state can be reached by two aspects — the appearance
   * surface's `success` is both the persistence aspect's whole subject and an
   * incidental cell of the generic record driver — and a rule that had to take
   * both would either decline the aspect that owns it or claim the one that
   * does not. Omitted where the rule is about the surface rather than about who
   * drives it.
   */
  owners?: readonly string[];
  reason: string;
  states: readonly string[];
  /**
   * Required, and required to be non-empty.
   *
   * A rule stated by state alone declines that state on every surface in the
   * table, including surfaces nobody wrote it about: the first rule here once
   * declined `success` everywhere, which silently swallowed all three
   * preference-persistence cases and left the only driver that writes a
   * preference through the product's own control executed by nothing.
   */
  surfaces: readonly string[];
}>;

/** The surfaces addressed by a record the closed catalogue cannot create. */
const recordAddressed = [
  "route:/agents/[agentId]",
  "route:/imports/[runId]",
  "route:/oauth/agent-consent",
  "route:/questions/[questionId]/deliveries",
  "route:/webhooks/[subscriptionId]",
];

export const acceptanceSkipRules: readonly AcceptanceSkipRule[] = [
  {
    reason:
      "A successful or destructive control on these surfaces writes or removes a row through the product itself, which the run ledger never recorded and therefore cannot remove in its reverse foreign-key sweep; the appearance surface is deliberately absent from this list, because its success writes the tenant's own preference row and the driver restores it.",
    states: ["destructive", "success"],
    surfaces: [
      "route:/agents/[agentId]",
      "route:/imports/[runId]",
      "route:/oauth/agent-consent",
      "route:/requests/[requestId]",
      "route:/requests/new",
      "route:/settings/members",
      "route:/settings/organization",
      "route:/settings/projects/[projectId]",
      "route:/settings/projects/new",
      "route:/settings/routing",
      "route:/sign-in",
      "route:/webhooks/[subscriptionId]",
    ],
  },
  {
    reason:
      'The imports surface draws its only submit inside a captured snapshot\'s row, and a run cannot leave one behind: "source_snapshots" carries a trigger declared BEFORE UPDATE OR DELETE whose first statement raises on every delete, so a snapshot the ledger seeded could never be swept and the release would fail for every case in the lane. It is append-only by design — a capture is meant to outlive the run that made it — so this is the schema being right rather than the surface being untestable, and the state is left undriven until the surface offers an action that writes nothing permanent.',
    states: ["pending"],
    surfaces: ["route:/imports"],
  },
  {
    reason:
      "The new-request surface refuses its submit control while the routing preview answers denied, and a denial requires an enabled deny rule in the organization's routing policy: with no rule at all the evaluation allows by default, and the closed scenario catalogue declares no routing-rule table, so the state is a projection of data the run cannot create rather than of a role or a submission it can.",
    states: ["disabled"],
    surfaces: ["route:/requests/new"],
  },
  {
    reason:
      "The appearance surface's success is the persistence aspect's whole subject: it writes the preference through the product's own control and proves the server still holds it after a reload and in a second browser context. A second success case driven by the generic record driver would land on the same page and assert nothing about the write.",
    owners: ["seeded-project-data"],
    states: ["success"],
    surfaces: ["route:/settings/appearance"],
  },
  {
    reason:
      "The surface is addressed by an agent, import run, question, webhook subscription, or OAuth client, and no catalogued case declares those tables; an address with no record reaches the not-found boundary rather than the state under test.",
    states: [
      "conflict",
      "default",
      "empty",
      "member_denied",
      "pending",
      "provider_unavailable",
    ],
    surfaces: recordAddressed,
  },
  {
    reason:
      "Sign-in is a synchronous server component whose static render is pinned by its own suite, and provider availability there is decided by deployment settings a local run cannot set; making it asynchronous to accept an injected condition would change the surface under test rather than exercise it.",
    states: ["error", "provider_unavailable"],
    surfaces: ["route:/sign-in"],
  },
  {
    reason:
      "The operations surface projects provider status from delivery records rather than from a provider check, and the closed catalogue declares no table for those records.",
    states: ["provider_unavailable"],
    surfaces: ["route:/settings/operations"],
  },
  {
    reason:
      "The organization surface is a read-only identity list: it draws no form, so there is no submission to hold or to conflict with, and its only role-dependent output is the membership role it prints, which its own component suite pins.",
    states: ["conflict", "member_denied", "pending"],
    surfaces: ["route:/settings/organization"],
  },
  {
    reason:
      "The search surface submits a GET form, so a held request has no action state to report and no control to disable; the pending affordance a submitted write draws is exercised on the surfaces that dispatch one.",
    states: ["pending"],
    surfaces: ["route:/search"],
  },
  {
    reason:
      "The appearance write is dispatched through an action that mints and checks its own render context rather than reading the shared context adapter, so an injected conflict cannot reach it; the optimistic-version conflict that surface really draws is proven against the command itself.",
    states: ["conflict"],
    surfaces: ["route:/settings/appearance"],
  },
  {
    reason:
      "The surface decides what a viewer may manage from a repository query rather than from the organization role the shared context adapter resolves, so reducing that role changes nothing it renders; its denial is reachable only with a genuinely less privileged identity, which the checked-in member journey drives.",
    states: ["member_denied"],
    surfaces: [
      "route:/imports",
      "route:/settings/projects/[projectId]",
      "route:/settings/routing",
    ],
  },
  {
    reason:
      "Every write on the Slack surface is behind a connected workspace. The guarded server is given placeholder provider settings so the provider-unavailable case can tell an injected failure from an absent configuration, but installing a workspace ends at Slack itself, so the surface still draws no form to hold in flight.",
    states: ["pending"],
    surfaces: ["route:/slack"],
  },
];

export function acceptanceSkipReason(
  surface: string,
  state: string,
  fixtureOwner?: string,
): string | null {
  for (const rule of acceptanceSkipRules) {
    if (!rule.states.includes(state)) continue;
    if (!rule.surfaces.includes(surface)) continue;
    if (rule.owners && !rule.owners.includes(fixtureOwner ?? "")) continue;

    return rule.reason;
  }

  return null;
}
