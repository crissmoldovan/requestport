import { z } from "zod";

import { memberAuthority } from "../operators/operator-types.js";
import {
  type ActorRef,
  type AuthorizedCommandContext,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition, CommandMeta } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";

/*
  Reviewing a legacy import's entries (Plan 13, F.2.6). The review form
  dispatches `review_legacy_import_entry` on the tenant bus, and so does
  `/api/v1`, for an operator credential only: its capability registry entry
  names `credentialKinds: ["operator"]` and no MCP tool. The command checks
  `import:write`, the organisation, and the member whose authority it runs
  with (`memberAuthority`: the signed-in person, or an operator's issuing
  member), then asks the import review port whether that member is an active
  owner or admin of the active organisation — the rule the write applies
  again — before the bus answers a replay or runs the write. The write
  records no audit row and no event, as the form's write never did, so the
  command returns no events. It records who acted as the entry's reviewer:
  the person, or the operator's own actor id, never its member.

  Splitting an entry stays off the bus: its segments come from the legacy
  parser in `@requestport/importer`, which depends on this package, so this
  package cannot call it. Its handler is core's `splitImportEntry`
  (`packages/core/src/import-split.ts`), which runs the same checks through
  `importReviewTarget` below, and parses its input with
  `splitImportEntryInputSchema`; `apps/web/src/lib/server-import-actions.ts`
  hands it to the split form, and `/api/v1` reaches it through an entry
  dispatched to `import-split`, also for an operator credential only.

  `import:write` is also an agent scope: an agent key or grant may hold it,
  for the MCP import tools. So the scope does not keep agents out of review;
  `memberAuthority` does, answering nobody for an agent, and so does each
  registry entry, which admits the operator credential alone — ruling 6 gives
  review to the operator credential, not to the agent that analysed the
  import.
*/
/** The scope reviewing and splitting an import entry require. */
export const importReviewScope = "import:write";

/** The unit-of-work port review writes through. */
export const importReviewPortName = "importReviewCommands";

/** The decisions a reviewer may record on an entry. */
export const importReviewDecisions = [
  "create",
  "map_existing",
  "message",
  "skip",
  "blocked",
] as const;

/** The relationships a created or mapped request may be given. */
export const importRelationshipTypes = [
  "blocks",
  "depends_on",
  "duplicates",
  "supersedes",
  "related_to",
  "derived_from",
] as const;

const entry = z.object({
  organizationId: z.uuid(),
  runId: z.uuid(),
  entryId: z.uuid(),
});

const reviewInput = entry.extend({
  decision: z.enum(importReviewDecisions),
  proposedCanonicalId: z.uuid().nullable().default(null),
  targetProjectId: z.uuid().nullable().default(null),
  relationships: z
    .array(
      z.object({
        type: z.enum(importRelationshipTypes),
        targetRequestId: z.uuid(),
      }),
    )
    .max(20)
    .default([]),
});

/**
 * The input schema of the one import review command, by command name. It is
 * the object the definition below calls `parse` on. The review form parses
 * its submission into the same fields (`(app)/imports/actions.ts`).
 */
export const importReviewCommandInputSchemas = {
  review_legacy_import_entry: reviewInput,
} as const;

export type ReviewImportEntryInput = z.output<typeof reviewInput>;

/**
 * What a split asks for: the entry, and the lines (1-based, each after the
 * first) its preserved record is cut before. The split handler parses with
 * this; it is not a command's schema, because the split is not on the bus.
 */
export const splitImportEntryInputSchema = entry.extend({
  splitLines: z.array(z.number().int().min(2)).min(1).max(19),
});

export type SplitImportEntryInput = z.output<
  typeof splitImportEntryInputSchema
>;

/** Whose authority a review or split runs under, in which organisation. */
export interface ImportReviewTarget {
  userId: string;
  organizationId: string;
}

/**
 * A review or split's target, with who acts and where they are confined.
 * `userId` is the member whose role the repository checks; `actor` is who
 * acts — that person, or the `service` actor `operator:<lineage>` for an
 * operator — and is what the write records as reviewer and receipt holder.
 * `credentialProjectId` is the project an operator credential is bound to,
 * or null for an organisation-wide operator and for a person: the repository
 * confines a bound operator to the runs whose source is that project, and to
 * that project's requests and itself as a decision's targets.
 */
export interface ImportReviewActing extends ImportReviewTarget {
  actor: ActorRef;
  credentialProjectId: string | null;
}

/** A write: who acts, and the entry version the caller expects. */
export interface ImportReviewMutation extends ImportReviewActing {
  expectedVersion: number;
}

/**
 * The import repository, as review reaches it through the unit of work.
 * `authorize` throws unless `userId` is an active owner or admin of the
 * active organisation, and `reviewEntry` checks the same again, then the
 * run's organisation and state — and, for a bound operator, its source's
 * project — and the entry's version, before it writes.
 */
export interface ImportReviewPort {
  authorize(target: ImportReviewTarget): Promise<void>;
  reviewEntry(
    mutation: ImportReviewMutation,
    input: Omit<ReviewImportEntryInput, "organizationId">,
  ): Promise<{ id: string; version: number }>;
}

/**
 * The member an import review or split acts for: the one whose role
 * authorises it. It is `memberAuthority(context)` (Plan 13, F.3, F3-2): the
 * person for a `user` actor, the issuing member for a well-formed operator
 * context, and nobody — so `forbidden` before any repository runs — for an
 * agent, for any other service actor, and for a context that claims to be an
 * operator's without being one.
 *
 * A `user` actor is taken as the person it names. That includes the MCP
 * route's provisioning delegation, which presents the delegating person as a
 * `user` actor holding `humanScopes` (so `import:write`); it cannot reach
 * review or split because no MCP tool names them (each registry entry's
 * `mcpTool` is null), and `/api/v1` authenticates no `user` actor.
 */
function reviewingMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Import review requires a person or an operator credential",
    );
  return member;
}

/**
 * The checks review and split both run after the credential's re-check and
 * before the port is asked anything: the scope, the organisation the input
 * names, and the member acting. It answers whose authority the port then
 * checks, who acts, and — for an operator bound to a project — that project.
 */
export function importReviewTarget(
  context: AuthorizedCommandContext,
  input: { organizationId: string },
): ImportReviewActing {
  requireScope(context, importReviewScope);
  requireOrganization(context, input.organizationId);
  const member = reviewingMember(context);
  return {
    userId: member.userId,
    organizationId: input.organizationId,
    actor: context.actor,
    credentialProjectId:
      member.via === "operator" ? (context.projectId ?? null) : null,
  };
}

function port(uow: UnitOfWork) {
  return uow.port<ImportReviewPort>(importReviewPortName);
}

export function createImportReviewCommandDefinitions(): Array<
  CommandDefinition<unknown, JsonObject>
> {
  return [
    {
      name: "review_legacy_import_entry",
      parse: (input) => reviewInput.parse(input),
      async authorize(context, rawInput, uow) {
        // The target first: a context it refuses never opens the port.
        const { userId, organizationId } = importReviewTarget(
          context,
          reviewInput.parse(rawInput),
        );
        await port(uow).authorize({ userId, organizationId });
      },
      async execute(uow, context, rawInput, meta: CommandMeta) {
        const { organizationId, ...review } = reviewInput.parse(rawInput);
        const target = importReviewTarget(context, { organizationId });
        const result = await port(uow).reviewEntry(
          { ...target, expectedVersion: meta.expectedVersion },
          review,
        );
        return {
          result: { id: result.id, version: result.version },
          aggregateId: result.id,
          events: [],
        };
      },
    },
  ];
}
