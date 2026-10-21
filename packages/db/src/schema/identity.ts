import { relations } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: citext("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  updatedAt: utcTimestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: utcTimestamp("access_token_expires_at"),
    refreshTokenExpiresAt: utcTimestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/*
  The expand for Better Auth 1.7 (plan 13, K.2), and why five tables below are
  built from two maps.

  Each of these five tables keeps the columns it had before migration 0017 in
  a `…BeforeExpand` map, and the exported table spreads that map and adds
  1.7's columns. While 0017 waited for production, Better Auth 1.6.29 was
  handed a projection built from the first map alone, because its Drizzle
  adapter names every column a table declares in each read and write. Better
  Auth 1.7.6 is handed the exported tables themselves (`identitySchema`
  below), and runs only once production holds 0017 (R2). The maps stay as
  the record of which columns predate 0017, less the two that 0022 dropped
  from `oauth_client` (K.4): `public` and `type`, which 1.7.6 has no field
  for.
*/
const jwksBeforeExpand = {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  expiresAt: utcTimestamp("expires_at"),
};

export const jwks = pgTable("jwks", {
  ...jwksBeforeExpand,
  alg: text("alg"),
  crv: text("crv"),
});

export const apiKeys = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: utcTimestamp("last_refill_at"),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(60_000),
    rateLimitMax: integer("rate_limit_max").default(600),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: utcTimestamp("last_request"),
    expiresAt: utcTimestamp("expires_at"),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_key_idx").on(table.key),
  ],
);

const oauthClientsBeforeExpand = {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  disabled: boolean("disabled").default(false),
  skipConsent: boolean("skip_consent"),
  enableEndSession: boolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: text("scopes").array(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: utcTimestamp("created_at"),
  updatedAt: utcTimestamp("updated_at"),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts").array(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris").array().notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  grantTypes: text("grant_types").array(),
  responseTypes: text("response_types").array(),
  // Better Auth spells this field `requirePKCE`; the adapter reads the
  // column off the table by that exact name.
  //
  // Nullable, and dynamic client registration always leaves it null: the
  // public register endpoint strips `require_pkce` from the request body, so
  // the insert omits the column. Better Auth reads that absence as
  // `requirePKCE ?? true` and forces PKCE regardless, so null here means
  // required, not optional. Every reader must say so too.
  requirePKCE: boolean("require_pkce"),
  referenceId: text("reference_id"),
  metadata: jsonb("metadata"),
};

export const oauthClients = pgTable(
  "oauth_client",
  {
    ...oauthClientsBeforeExpand,
    clientDiscoveryId: text("client_discovery_id"),
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([]),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
  },
  (table) => [index("oauth_client_user_id_idx").on(table.userId)],
);

const oauthRefreshTokensBeforeExpand = {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, {
    onDelete: "set null",
  }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  expiresAt: utcTimestamp("expires_at"),
  createdAt: utcTimestamp("created_at"),
  revoked: utcTimestamp("revoked"),
  authTime: utcTimestamp("auth_time"),
  scopes: text("scopes").array().notNull(),
};

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_token",
  {
    ...oauthRefreshTokensBeforeExpand,
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    rotatedAt: utcTimestamp("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: utcTimestamp("rotation_replay_expires_at"),
    confirmation: jsonb("confirmation"),
  },
  (table) => [
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

const oauthAccessTokensBeforeExpand = {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, {
    onDelete: "set null",
  }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {
    onDelete: "cascade",
  }),
  expiresAt: utcTimestamp("expires_at"),
  createdAt: utcTimestamp("created_at"),
  scopes: text("scopes").array().notNull(),
};

export const oauthAccessTokens = pgTable(
  "oauth_access_token",
  {
    ...oauthAccessTokensBeforeExpand,
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    revoked: utcTimestamp("revoked"),
    confirmation: jsonb("confirmation"),
  },
  (table) => [
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
    index("oauth_access_token_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

const oauthConsentsBeforeExpand = {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  scopes: text("scopes").array().notNull(),
  createdAt: utcTimestamp("created_at"),
  updatedAt: utcTimestamp("updated_at"),
};

export const oauthConsents = pgTable(
  "oauth_consent",
  {
    ...oauthConsentsBeforeExpand,
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
  },
  (table) => [
    index("oauth_consent_client_id_idx").on(table.clientId),
    index("oauth_consent_user_id_idx").on(table.userId),
  ],
);

/*
  The three tables `@better-auth/oauth-provider` 1.7 adds, created by the
  expand migration (0017) before 1.7.6 was deployed (R2.1).

  Global, like every Better Auth table: none carries an organization, and
  Better Auth reaches them through its adapter before any organization is
  known.
*/
export const oauthResources = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean(
    "dpop_bound_access_tokens_required",
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: utcTimestamp("created_at"),
  updatedAt: utcTimestamp("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResources = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: utcTimestamp("created_at"),
  },
  (table) => [
    uniqueIndex("oauth_client_resource_client_id_resource_id_unique").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
  ],
);

export const oauthClientAssertions = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: utcTimestamp("expires_at").notNull(),
});

// Keyed by the model names Better Auth asks the Drizzle adapter for, which are
// singular and are not always the Drizzle export name. The adapter looks a
// model up as `schema[modelName]` and throws at request time when it is absent,
// so these keys are a contract with Better Auth rather than a naming choice.
//
// Every value is the exported table itself, never a second table object for
// the same SQL table: I.1's tenant sweep ("gives Better Auth's adapter no
// tenant table") recognises these values by identity among the schema's
// exports, and `identity-schema.test.ts` holds them to that.
export const identitySchema = {
  user,
  session,
  account,
  verification,
  jwks,
  apikey: apiKeys,
  oauthClient: oauthClients,
  oauthRefreshToken: oauthRefreshTokens,
  oauthAccessToken: oauthAccessTokens,
  oauthConsent: oauthConsents,
  oauthResource: oauthResources,
  oauthClientResource: oauthClientResources,
  oauthClientAssertion: oauthClientAssertions,
};

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  oauthClients: many(oauthClients),
  oauthRefreshTokens: many(oauthRefreshTokens),
  oauthAccessTokens: many(oauthAccessTokens),
  oauthConsents: many(oauthConsents),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const oauthClientRelations = relations(
  oauthClients,
  ({ one, many }) => ({
    user: one(user, { fields: [oauthClients.userId], references: [user.id] }),
    refreshTokens: many(oauthRefreshTokens),
    accessTokens: many(oauthAccessTokens),
    consents: many(oauthConsents),
  }),
);

export const oauthRefreshTokenRelations = relations(
  oauthRefreshTokens,
  ({ one, many }) => ({
    client: one(oauthClients, {
      fields: [oauthRefreshTokens.clientId],
      references: [oauthClients.clientId],
    }),
    session: one(session, {
      fields: [oauthRefreshTokens.sessionId],
      references: [session.id],
    }),
    user: one(user, {
      fields: [oauthRefreshTokens.userId],
      references: [user.id],
    }),
    accessTokens: many(oauthAccessTokens),
  }),
);

export const oauthAccessTokenRelations = relations(
  oauthAccessTokens,
  ({ one }) => ({
    client: one(oauthClients, {
      fields: [oauthAccessTokens.clientId],
      references: [oauthClients.clientId],
    }),
    session: one(session, {
      fields: [oauthAccessTokens.sessionId],
      references: [session.id],
    }),
    user: one(user, {
      fields: [oauthAccessTokens.userId],
      references: [user.id],
    }),
    refreshToken: one(oauthRefreshTokens, {
      fields: [oauthAccessTokens.refreshId],
      references: [oauthRefreshTokens.id],
    }),
  }),
);

export const oauthConsentRelations = relations(oauthConsents, ({ one }) => ({
  client: one(oauthClients, {
    fields: [oauthConsents.clientId],
    references: [oauthClients.clientId],
  }),
  user: one(user, {
    fields: [oauthConsents.userId],
    references: [user.id],
  }),
}));
