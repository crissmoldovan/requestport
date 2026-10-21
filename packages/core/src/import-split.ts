import {
  createCommandAuthorizationRepository,
  createImportReviewCommandRepository,
  type Storage,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  type CommandMeta,
  DomainError,
  importReviewTarget,
  splitImportEntryInputSchema,
} from "@requestport/domain";
import { parseLegacyArtifact } from "@requestport/importer";

import type { RequestPortSecrets } from "./options.js";

/*
  The import split (Plan 13, F.2.6; `manifest-f2.md`, F.2.6 **Owns**), whose
  segments come from the legacy parser in `@requestport/importer` — which
  depends on `@requestport/domain`, so the domain cannot call it. It lives here
  since Plan 13, G.6 (manifest-g.md §2.5's `import-split` row). Reviewing an
  entry is the bus command `review_legacy_import_entry`; splitting one is
  `splitImportEntry` below, which the web's split form calls as the signed-in
  person, and which `execute` reaches for an operator credential: the registry
  entry `split_legacy_import_entry` is dispatched to `import-split` and admits
  operators only (Plan 13, F.2.6's registry half; ruling 25).

  The split keeps the repository's receipt, `split_legacy_import_entry`, keyed
  with the raw `commandFingerprintKey` (`BETTER_AUTH_SECRET` in the web) under
  the acting actor: a person as the `user` actor the form always keyed it by,
  an operator as its own `service` actor, so an operator's receipt never
  answers its member. What the bus would have given it, the handler does
  itself (§2.3): one transaction, which `transaction` opens with every
  repository opened on it, and the bus's own `assertCurrent` run there before
  anything else — for an operator, under the deployment's operator switch, as
  the bus's port is built, so it refuses every operator unless that is
  `enabled`. `importSplitTransaction` opens that transaction on a storage, for
  `createRequestPort`. The web's RequestPort opens it on the web root's
  storage, and the web's split form runs the handler through it (`handlers`;
  `apps/web/src/lib/server-import-actions.ts`).
*/

/**
 * The repositories the split opens on its transaction, each opened when the
 * split asks for it.
 */
export interface ImportSplitRepositories {
  /** The bus's own re-check, under the deployment's operator switch. */
  authorization(): Pick<
    ReturnType<typeof createCommandAuthorizationRepository>,
    "assertCurrent"
  >;
  imports(): Pick<
    ReturnType<typeof createImportReviewCommandRepository>,
    "authorize" | "splitEntry"
  >;
}

/**
 * Opens one transaction, unbound, and runs `work` in it with the repositories
 * opened on that transaction.
 */
export type ImportSplitTransaction = <T>(
  work: (repositories: ImportSplitRepositories) => Promise<T>,
) => Promise<T>;

export interface ImportSplitOptions {
  transaction: ImportSplitTransaction;
  /** `commandFingerprintKey` is read when each split runs. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
}

/**
 * The preserved record `body`, cut before each of `splitLines` (1-based, in
 * order) and parsed segment by segment. Each segment must parse as exactly
 * one legacy record.
 *
 * The repository calls this inside its transaction, on the entry's record as
 * it locked it. It never calls it for a retry of a split that already ran:
 * that is answered from the split's receipt first.
 */
export function legacySegments(body: string, splitLines: readonly number[]) {
  const lineStarts = [0];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\n" && index + 1 < body.length) {
      lineStarts.push(index + 1);
    }
  }
  const offsets = splitLines.map((line) => lineStarts[line - 1]);
  if (offsets.some((offset) => offset === undefined)) {
    throw new DomainError(
      "validation_failed",
      "A split line is outside the preserved record",
    );
  }
  const boundaries = [0, ...(offsets as number[]), body.length];
  return boundaries.slice(0, -1).map((start, index) => {
    const segmentBody = body.slice(start, boundaries[index + 1]);
    const parsed = parseLegacyArtifact(segmentBody);
    if (parsed.length !== 1 || !parsed[0]) {
      throw new DomainError(
        "validation_failed",
        "Each manual segment must parse as one record",
      );
    }
    return {
      proposedKind: parsed[0].kind,
      parsedJson: { ...parsed[0], recordIndex: index },
      confidenceJson: parsed[0].confidence,
    };
  });
}

export function createImportSplit(options: ImportSplitOptions) {
  /**
   * Split an import entry: its preserved record is cut before each line the
   * input names and each segment becomes an entry of its own, for review.
   *
   * The input names the organisation, the run, the entry and the lines;
   * `meta` carries the entry's expected version and the idempotency key. In
   * one transaction: the credential is re-checked, then the scope, the
   * organisation and the member acting — a person, or an operator's issuing
   * member (`importReviewTarget`, as review checks them) — then that the
   * member is an active owner or admin, then the split, which records who
   * acted and holds an operator bound to a project to that project's runs.
   */
  async function splitImportEntry(
    context: AuthorizedCommandContext,
    rawInput: unknown,
    meta: CommandMeta,
  ) {
    const input = splitImportEntryInputSchema.parse(rawInput);
    const splitLines = [...new Set(input.splitLines)].sort(
      (left, right) => left - right,
    );
    return options.transaction(async (repositories) => {
      await repositories.authorization().assertCurrent(context);
      const target = importReviewTarget(context, input);
      const imports = repositories.imports();
      await imports.authorize({
        userId: target.userId,
        organizationId: target.organizationId,
      });
      return imports.splitEntry({
        organizationId: target.organizationId,
        runId: input.runId,
        entryId: input.entryId,
        splitLines,
        segment: (body) => legacySegments(body, splitLines),
        userId: target.userId,
        actor: target.actor,
        credentialProjectId: target.credentialProjectId,
        expectedVersion: meta.expectedVersion,
        idempotencyKey: meta.idempotencyKey,
        fingerprintSecret: options.secrets.commandFingerprintKey,
      });
    });
  }

  return { splitImportEntry };
}

/**
 * The split's transaction on `storage`: one transaction, and each repository
 * opened on it when the split asks, the re-check's under
 * `secrets.operatorCredentials`, read as that repository opens.
 */
export function importSplitTransaction(
  storage: Pick<Storage, "transaction">,
  secrets: Pick<RequestPortSecrets, "operatorCredentials">,
): ImportSplitTransaction {
  return <T>(work: (repositories: ImportSplitRepositories) => Promise<T>) =>
    storage.transaction((tx) =>
      work({
        authorization: () =>
          createCommandAuthorizationRepository(tx, {
            operatorCredentials: secrets.operatorCredentials,
          }),
        imports: () => createImportReviewCommandRepository(tx),
      }),
    );
}
