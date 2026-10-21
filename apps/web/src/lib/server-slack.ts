import { createHmac, randomUUID } from "node:crypto";

import { serverEnv } from "@requestport/config/server";
import {
  createCollaborationRepository,
  createCommandTransactionManager,
  createRequestRepository,
  createSlackRepository,
  slackInstallationAad,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  actorFingerprint,
  createCoreCommandRegistry,
  DomainError,
  type DomainEvent,
  type JsonObject,
  keyedFingerprint,
  normalizedInputHash,
  serializeEncryptedEnvelope,
} from "@requestport/domain";
import {
  buildSlackAuthorizationUrl,
  createOpaqueSlackToken,
  exchangeSlackOAuthCode,
  hashSlackToken,
} from "@requestport/notifications/slack";
import { WebClient } from "@slack/web-api";
import { workspaceEncryption } from "./server-core-commands.js";
import { webDatabase, webStorage } from "./server-request-port.js";
import { dispatchCommittedEvents } from "./trigger-client.js";

function requireSlackConfiguration() {
  if (
    !serverEnv.REQUESTPORT_SLACK_CLIENT_ID ||
    !serverEnv.REQUESTPORT_SLACK_CLIENT_SECRET ||
    !serverEnv.REQUESTPORT_SLACK_STATE_SECRET ||
    !workspaceEncryption
  ) {
    throw new DomainError(
      "configuration_error",
      "Slack is not configured in this environment",
    );
  }
  return {
    clientId: serverEnv.REQUESTPORT_SLACK_CLIENT_ID,
    clientSecret: serverEnv.REQUESTPORT_SLACK_CLIENT_SECRET,
    tokenSecret: serverEnv.REQUESTPORT_SLACK_STATE_SECRET,
    encryption: workspaceEncryption,
  };
}

function callbackUri() {
  return new URL(
    "/api/slack/oauth/callback",
    serverEnv.BETTER_AUTH_URL,
  ).toString();
}

export async function startSlackInstallation(
  context: AuthorizedCommandContext,
) {
  if (context.actor.type !== "user")
    throw new DomainError(
      "forbidden",
      "Slack installation requires a human user",
    );
  const configuration = requireSlackConfiguration();
  const state = createOpaqueSlackToken();
  const storage = webStorage();
  await createSlackRepository(storage.db).createOauthState({
    id: randomUUID(),
    organizationId: context.organizationId,
    userId: context.actor.id,
    stateHash: hashSlackToken(configuration.tokenSecret, state),
    redirectUri: callbackUri(),
    expiresAt: new Date(Date.now() + 10 * 60_000),
    correlationId: context.correlationId,
  });
  return buildSlackAuthorizationUrl({
    clientId: configuration.clientId,
    redirectUri: callbackUri(),
    state,
  });
}

export async function completeSlackInstallation(input: {
  code: string;
  state: string;
}) {
  const configuration = requireSlackConfiguration();
  const stateHash = hashSlackToken(configuration.tokenSecret, input.state);
  const storage = webStorage();
  const state = await storage.transaction(async (tx) =>
    createSlackRepository(tx).consumeOauthState(stateHash),
  );
  if (state.redirectUri !== callbackUri()) {
    throw new DomainError(
      "forbidden",
      "Slack OAuth state is invalid or expired",
    );
  }
  const oauth = await exchangeSlackOAuthCode({
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret,
    code: input.code,
    redirectUri: state.redirectUri,
  });
  try {
    await storage.transaction(async (tx) => {
      const transactional = createSlackRepository(tx);
      const installationId = await transactional.lockInstallationIdForWorkspace(
        state.organizationId,
        oauth.workspaceId,
        randomUUID(),
      );
      const encrypted = await configuration.encryption.encrypt(
        { token: oauth.accessToken },
        slackInstallationAad(state.organizationId, installationId),
      );
      await transactional.upsertInstallation({
        id: installationId,
        organizationId: state.organizationId,
        workspaceId: oauth.workspaceId,
        workspaceName: oauth.workspaceName,
        botToken: encrypted,
        botUserId: oauth.botUserId,
        scopes: oauth.scopes,
        userId: state.userId,
        correlationId: randomUUID(),
      });
    });
  } catch (error) {
    try {
      await new WebClient(oauth.accessToken, {
        rejectRateLimitedCalls: true,
        timeout: 5_000,
      }).auth.revoke();
    } catch {
      // The original persistence error remains authoritative. Never log or
      // serialize the provider token if Slack-side compensation also fails.
    }
    throw error;
  }
  return state.organizationId;
}

export async function decryptSlackBotToken(input: {
  organizationId: string;
  installationId: string;
  envelope: Parameters<NonNullable<typeof workspaceEncryption>["decrypt"]>[0];
}) {
  const configuration = requireSlackConfiguration();
  const value = await configuration.encryption.decrypt<{ token: string }>(
    input.envelope,
    slackInstallationAad(input.organizationId, input.installationId),
  );
  if (!value.token)
    throw new DomainError(
      "configuration_error",
      "Slack installation credential is unavailable",
    );
  return value.token;
}

function answerIdFromResult(result: JsonObject) {
  if (typeof result.answerId === "string") return result.answerId;
  const canonical = result.canonicalAnswer;
  if (
    canonical &&
    typeof canonical === "object" &&
    !Array.isArray(canonical) &&
    typeof canonical.id === "string"
  )
    return canonical.id;
  throw new Error("Canonical Slack answer result is missing an answer ID");
}

const interactionRegistry = createCoreCommandRegistry({ workspaceEncryption });
const interactionTransactions = createCommandTransactionManager(
  webDatabase,
  (name, database) => {
    if (name === "requests") return createRequestRepository(database);
    if (name === "collaboration")
      return createCollaborationRepository(database);
    if (name === "slack") return createSlackRepository(database);
    return undefined;
  },
);

export async function answerSlackQuestion(input: {
  rawToken: string;
  tokenType: "answer" | "modal_submit";
  workspaceId: string;
  slackUserId: string;
  bodyMd?: string;
  channelId?: string;
  messageTs?: string;
}) {
  const configuration = requireSlackConfiguration();
  const tokenHash = hashSlackToken(configuration.tokenSecret, input.rawToken);
  const definition = interactionRegistry.resolve("answer_question");
  if (!definition) throw new Error("Answer question command is unavailable");
  const committed = await interactionTransactions.run(async (uow) => {
    const slack = uow.port<ReturnType<typeof createSlackRepository>>("slack");
    const locked = await slack.lockActionToken({
      tokenHash,
      tokenType: input.tokenType,
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId,
    });
    if (locked.consumedAt) {
      if (!locked.answerId)
        throw new DomainError("conflict", "Slack action was already consumed");
      return {
        answerId: locked.answerId,
        duplicate: true,
        events: [] as DomainEvent[],
        operationId: null as string | null,
      };
    }
    const context: AuthorizedCommandContext = {
      actor: { type: "user", id: locked.userId },
      organizationId: locked.organizationId,
      scopes: new Set(["question:answer", "request:read"]),
      credentialId: `slack:${locked.installationId}:${input.slackUserId}`,
      correlationId: randomUUID(),
    };
    const answerBody =
      input.bodyMd ??
      (typeof locked.actionPayload.bodyMd === "string"
        ? locked.actionPayload.bodyMd
        : "");
    const commandInput = definition.parse({
      organizationId: locked.organizationId,
      questionId: locked.questionId,
      bodyMd: answerBody,
      sourceChannel: "slack",
    });
    const receiptKey = {
      actorFingerprint: actorFingerprint(context.actor),
      commandName: definition.name,
      idempotencyFingerprint: keyedFingerprint(
        configuration.tokenSecret,
        `slack-action:${tokenHash}`,
      ),
    };
    await uow.commandReceipts.lock(receiptKey);
    const existing = await uow.commandReceipts.find(receiptKey);
    if (existing) {
      const result = existing.result as JsonObject;
      const answerId = answerIdFromResult(result);
      await slack.consumeActionToken({
        id: locked.id,
        userId: locked.userId,
        slackUserId: input.slackUserId,
        answerId,
      });
      return {
        answerId,
        duplicate: true,
        events: [] as DomainEvent[],
        operationId: null as string | null,
      };
    }
    await definition.authorize(context, commandInput, uow);
    const execution = await definition.execute(uow, context, commandInput, {
      idempotencyKey: `slack-action:${locked.id}`,
      expectedVersion: locked.questionVersion,
    });
    await uow.domainEvents.append(execution.events);
    await execution.afterEventsPersisted?.(uow, execution.events);
    const result = execution.result as JsonObject;
    const answerId = answerIdFromResult(result);
    await slack.consumeActionToken({
      id: locked.id,
      userId: locked.userId,
      slackUserId: input.slackUserId,
      answerId,
    });
    await uow.commandReceipts.save({
      ...receiptKey,
      normalizedInputHash: normalizedInputHash(commandInput),
      aggregateId: execution.aggregateId,
      result,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    });
    const channelId =
      input.channelId ??
      (typeof locked.actionPayload.channelId === "string"
        ? locked.actionPayload.channelId
        : undefined);
    const messageTs =
      input.messageTs ??
      (typeof locked.actionPayload.messageTs === "string"
        ? locked.actionPayload.messageTs
        : undefined);
    const operationId =
      channelId && messageTs
        ? await slack.ensureMessageUpdateOperation({
            installationId: locked.installationId,
            operationKey: `answer:${answerId}:${channelId}:${messageTs}`,
            channelId,
            messageTs,
            answerId,
          })
        : null;
    return {
      answerId,
      duplicate: false,
      events: execution.events,
      operationId,
    };
  });
  await dispatchCommittedEvents(committed.events);
  return committed;
}

export async function prepareSlackAnswerModal(input: {
  rawToken: string;
  workspaceId: string;
  slackUserId: string;
  channelId?: string;
  messageTs?: string;
}) {
  const configuration = requireSlackConfiguration();
  const launchHash = hashSlackToken(configuration.tokenSecret, input.rawToken);
  const submitToken = createHmac("sha256", configuration.tokenSecret)
    .update(
      `modal-submit:${input.rawToken}:${input.workspaceId}:${input.slackUserId}`,
    )
    .digest("base64url");
  const submitHash = hashSlackToken(configuration.tokenSecret, submitToken);
  const storage = webStorage();
  return storage.transaction(async (tx) => {
    const slack = createSlackRepository(tx);
    const launch = await slack.lockActionToken({
      tokenHash: launchHash,
      tokenType: "modal_launch",
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId,
    });
    if (!launch.consumedAt) {
      await slack.createActionToken({
        id: randomUUID(),
        organizationId: launch.organizationId,
        questionId: launch.questionId,
        installationId: launch.installationId,
        slackUserId: input.slackUserId,
        tokenType: "modal_submit",
        tokenHash: submitHash,
        actionPayload: {
          ...(input.channelId ? { channelId: input.channelId } : {}),
          ...(input.messageTs ? { messageTs: input.messageTs } : {}),
        },
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      await slack.consumeActionToken({
        id: launch.id,
        userId: launch.userId,
        slackUserId: input.slackUserId,
      });
    } else if (
      launch.consumedByUserId !== launch.userId ||
      launch.slackUserId !== input.slackUserId
    ) {
      throw new DomainError(
        "conflict",
        "Slack modal launch was already consumed",
      );
    }
    return {
      submitToken,
      requestKey:
        typeof launch.actionPayload.requestKey === "string"
          ? launch.actionPayload.requestKey
          : "RequestPort question",
      organizationId: launch.organizationId,
      installationId: launch.installationId,
    };
  });
}

export async function issueSlackActionToken(input: {
  organizationId: string;
  questionId: string;
  installationId: string;
  slackUserId: string | null;
  tokenType: "answer" | "modal_launch";
  actionPayload: Record<string, string>;
  expiresAt: Date;
}) {
  const configuration = requireSlackConfiguration();
  const token = createOpaqueSlackToken();
  const storage = webStorage();
  await createSlackRepository(storage.db).createActionToken({
    id: randomUUID(),
    ...input,
    tokenHash: hashSlackToken(configuration.tokenSecret, token),
  });
  return token;
}

export function serializeSlackEnvelope(
  envelope: Parameters<typeof serializeEncryptedEnvelope>[0],
) {
  return serializeEncryptedEnvelope(envelope);
}
