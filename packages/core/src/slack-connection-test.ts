import {
  createCommandAuthorizationRepository,
  createSlackRepository,
  type Storage,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  type CommandMeta,
  slackAdministrationTarget,
  slackConnectionTestInputSchema,
} from "@requestport/domain";

import type { RequestPortSecrets } from "./options.js";

/*
  The Slack connection test, the one Slack administration capability that
  stays off the command bus (Plan 13, F.2.5; `manifest-f2.md` §4, Scope 1).
  Its handler lives here since Plan 13, G.6 (manifest-g.md §2.5's
  `slack-connection-test` row). The web's connection test form calls it as
  the signed-in person, and `execute` reaches it for an operator credential:
  the registry entry `send_slack_connection_test` is dispatched to
  `slack-connection-test` and admits operators only (F.2.5's connection test
  follow-up; ruling 25).

  It stays off the bus because it starts a task after its commit. The bus's
  after-commit hook dispatches only the outbox rows of the events a command
  emits, and F.2 adds no other hook (ruling 7). Here the handler owns its
  transaction, so it starts the task once that transaction has committed, for
  every caller alike, through `startConnectionTest`: the background port's
  `triggerSlackConnectionTest`. When the start fails, or the background
  refuses it (a background of kind `none` refuses every direct start with
  `JobDeferredToWorkerError`), the operation stays pending, and a worker
  running the `slack-connection-test-repair` schedule starts it when it is
  due.

  What the bus would have given it, the handler does itself (§2.3). Before
  any query it runs the three Slack administration commands' own checks
  (`slackAdministrationTarget`): `slack:manage`, the context's own
  organisation, the member whose authority it acts with (`memberAuthority`:
  the signed-in person, or an operator's issuing member), and that an
  operator is bound to no project, since Slack configuration is the
  organisation's. It then runs in one transaction, which `transaction` opens
  with every repository it uses opened on it, and runs `assertCurrent` there
  before any other query: for a person, the bus's own lock on the session,
  the membership and the organisation; for an operator, under the
  deployment's operator switch, as the bus's port is built, so it refuses
  every operator unless that is `enabled`. `assertCurrent` binds the
  transaction to the context's organisation before its first read of a
  tenant table. The repository's write then runs in a savepoint inside the
  transaction. `slackConnectionTestTransaction` opens that transaction on a
  storage, for `createRequestPort`. The web's RequestPort opens it on the web
  root's storage, and the web's connection test form runs the handler through
  it (`handlers`; `apps/web/src/lib/server-slack-actions.ts`).

  Its idempotency is the repository's operation key, keyed with the raw
  `commandFingerprintKey` (`BETTER_AUTH_SECRET` in the web) from the
  context's own actor and the idempotency key. A person's actor is the `user`
  the form always keyed it by, so a form submitted before a deploy and
  retried after it finds the same operation; an operator's is its own
  `service` actor, so an operator's retry and its member's never share an
  operation. The audit row records the same actor.
*/

/**
 * The repositories the handler opens on its transaction, each opened when the
 * handler asks for it.
 */
export interface SlackConnectionTestRepositories {
  /** The bus's own re-check, under the deployment's operator switch. */
  authorization(): Pick<
    ReturnType<typeof createCommandAuthorizationRepository>,
    "assertCurrent"
  >;
  slack(): Pick<
    ReturnType<typeof createSlackRepository>,
    "queueConnectionTest"
  >;
}

/**
 * Opens one transaction, unbound, and runs `work` in it with the repositories
 * opened on that transaction.
 */
export type SlackConnectionTestTransaction = <T>(
  work: (repositories: SlackConnectionTestRepositories) => Promise<T>,
) => Promise<T>;

export interface SlackConnectionTestOptions {
  transaction: SlackConnectionTestTransaction;
  /** `commandFingerprintKey` is read when each call runs. */
  secrets: Pick<RequestPortSecrets, "commandFingerprintKey">;
  /**
   * Starts the queued operation's task, once its transaction has committed:
   * the background port's `triggerSlackConnectionTest`.
   */
  startConnectionTest(operationId: string): Promise<unknown>;
}

export function createSlackConnectionTest(options: SlackConnectionTestOptions) {
  /**
   * Queue a Slack connection test, then start it.
   *
   * The input names the organisation, the installation and the channel;
   * `meta` carries the idempotency key and an expected version, which must be
   * 0 (a test is always new). A person or an operator bound to no project,
   * holding `slack:manage`, may queue one in the context's own organisation;
   * the repository then requires that the member acted for is an active owner
   * or admin, and an active installation of that organisation. It answers the
   * operation's id, and whether the task was started; when it was not, the
   * operation stays pending for the repair run.
   */
  async function queueSlackConnectionTest(
    context: AuthorizedCommandContext,
    rawInput: unknown,
    meta: CommandMeta,
  ) {
    const input = slackConnectionTestInputSchema.parse(rawInput);
    const target = slackAdministrationTarget(context, input);
    const operation = await options.transaction(async (repositories) => {
      const authorization = repositories.authorization();
      const slack = repositories.slack();
      await authorization.assertCurrent(context);
      return slack.queueConnectionTest({
        organizationId: target.organizationId,
        installationId: input.installationId,
        channelId: input.channelId,
        userId: target.actorUserId,
        actor: context.actor,
        idempotencyKey: meta.idempotencyKey,
        expectedVersion: meta.expectedVersion,
        fingerprintSecret: options.secrets.commandFingerprintKey,
        correlationId: context.correlationId,
      });
    });
    try {
      await options.startConnectionTest(operation.id);
    } catch {
      return { operationId: operation.id, dispatched: false };
    }
    return { operationId: operation.id, dispatched: true };
  }

  return { queueSlackConnectionTest };
}

/**
 * The handler's transaction on `storage`: one transaction, and each
 * repository opened on it when the handler asks, the re-check's under
 * `secrets.operatorCredentials`, read as that repository opens.
 */
export function slackConnectionTestTransaction(
  storage: Pick<Storage, "transaction">,
  secrets: Pick<RequestPortSecrets, "operatorCredentials">,
): SlackConnectionTestTransaction {
  return <T>(
    work: (repositories: SlackConnectionTestRepositories) => Promise<T>,
  ) =>
    storage.transaction((tx) =>
      work({
        authorization: () =>
          createCommandAuthorizationRepository(tx, {
            operatorCredentials: secrets.operatorCredentials,
          }),
        slack: () => createSlackRepository(tx),
      }),
    );
}
