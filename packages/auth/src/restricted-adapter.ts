import {
  APIError,
  type DBAdapter,
  type DBAdapterInstance,
  type DBTransactionAdapter,
} from "better-auth";

type DatabaseMarker = {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
};

function isSignupGuardMarker(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const marker = current as DatabaseMarker;
    if (
      marker.code === "P0001" &&
      marker.constraint === "requestport_user_signup_eligibility_guard" &&
      marker.message === "requestport_signup_disabled"
    ) {
      return true;
    }
    current = marker.cause;
  }
  return false;
}

export function wrapSignupGuardAdapter(
  factory: DBAdapterInstance,
): DBAdapterInstance {
  return (options) => {
    const adapter = factory(options);

    const guardCreate =
      (createRecord: DBAdapter["create"]): DBAdapter["create"] =>
      async (input) => {
        try {
          return await createRecord(input);
        } catch (error) {
          if (input.model === "user" && isSignupGuardMarker(error)) {
            throw new APIError("FORBIDDEN", {
              code: "signup_disabled",
              message: "signup_disabled",
            });
          }
          throw error;
        }
      };
    const wrapTransaction = (
      transactionAdapter: DBTransactionAdapter,
    ): DBTransactionAdapter => ({
      ...transactionAdapter,
      create: guardCreate(transactionAdapter.create),
    });
    const transaction: DBAdapter["transaction"] = (callback) =>
      adapter.transaction((transactionAdapter) =>
        callback(wrapTransaction(transactionAdapter)),
      );

    return {
      ...adapter,
      create: guardCreate(adapter.create),
      transaction,
    };
  };
}

type AdapterWhere = { field?: unknown; value?: unknown }[] | undefined;

/**
 * Whether a write would store a Client ID Metadata Document client that is
 * not public.
 *
 * `@better-auth/cimd` admits documents declaring `none` and `private_key_jwt`,
 * and neither it nor the provider can be told to narrow that. But after K.2
 * both RequestPort consent gates admit only `none` clients, so a
 * `private_key_jwt` client could register and never be consented; refusing it
 * also leaves the provider no reason to fetch a CIMD client's `jwks_uri`.
 * Every CIMD client row is written here, with `clientDiscoveryId` "cimd", in
 * the registration's transaction, so a refusal writes nothing.
 *
 * A create must name `none`. An update that names a method must name `none`;
 * one that names none leaves the stored method as it was.
 */
function isNonPublicCimdClientWrite(
  model: string,
  values: Record<string, unknown> | undefined,
  where: AdapterWhere,
  requireMethod: boolean,
) {
  if (model !== "oauthClient" || !values) return false;
  const discovery =
    values.clientDiscoveryId ??
    where?.find((clause) => clause.field === "clientDiscoveryId")?.value;
  if (discovery !== "cimd") return false;
  const method = values.tokenEndpointAuthMethod;
  if (method === undefined) return requireMethod;
  return method !== "none";
}

function refuseNonPublicCimdClient(): never {
  throw new APIError("BAD_REQUEST", {
    error: "invalid_client_metadata",
    error_description:
      'client metadata documents must declare token_endpoint_auth_method "none"',
  });
}

/**
 * Refuses a Client ID Metadata Document client whose token endpoint method is
 * not `none`, wherever the provider writes one: directly or inside a
 * transaction, on create and on update. Every other write, and every other
 * adapter method (1.7's `consumeOne` and `incrementOne` included), reaches the
 * wrapped adapter unchanged.
 */
export function wrapCimdClientGuardAdapter(
  factory: DBAdapterInstance,
): DBAdapterInstance {
  return (options) => {
    const adapter = factory(options);

    const guardCreate =
      (createRecord: DBAdapter["create"]): DBAdapter["create"] =>
      async (input) => {
        if (
          isNonPublicCimdClientWrite(
            input.model,
            input.data as Record<string, unknown>,
            undefined,
            true,
          )
        ) {
          refuseNonPublicCimdClient();
        }
        return await createRecord(input);
      };
    const guardUpdate =
      (updateRecord: DBAdapter["update"]): DBAdapter["update"] =>
      async (input) => {
        if (
          isNonPublicCimdClientWrite(
            input.model,
            input.update as Record<string, unknown>,
            input.where as AdapterWhere,
            false,
          )
        ) {
          refuseNonPublicCimdClient();
        }
        return await updateRecord(input);
      };
    const wrapTransaction = (
      transactionAdapter: DBTransactionAdapter,
    ): DBTransactionAdapter => ({
      ...transactionAdapter,
      create: guardCreate(transactionAdapter.create),
      update: guardUpdate(transactionAdapter.update),
    });
    const transaction: DBAdapter["transaction"] = (callback) =>
      adapter.transaction((transactionAdapter) =>
        callback(wrapTransaction(transactionAdapter)),
      );

    return {
      ...adapter,
      create: guardCreate(adapter.create),
      update: guardUpdate(adapter.update),
      transaction,
    };
  };
}

const RESOURCE_IDENTIFIER_CONSTRAINT = "oauth_resource_identifier_unique";

/**
 * The error Postgres raised under a Drizzle failure, when that error is a
 * duplicate `oauth_resource` identifier (`23505` on
 * `oauth_resource_identifier_unique`). pg, the hosted driver's WebSocket
 * client and PGlite each parse a server error into a `DatabaseError` whose `message`,
 * `code` and `constraint` are the server's own fields, and Drizzle puts that
 * error on its `DrizzleQueryError`'s `cause`. Only that one level is read.
 */
function duplicateResourceIdentifier(
  error: unknown,
): { message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = (error as DatabaseMarker).cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const marker = cause as DatabaseMarker;
  if (
    marker.code !== "23505" ||
    marker.constraint !== RESOURCE_IDENTIFIER_CONSTRAINT ||
    typeof marker.message !== "string"
  ) {
    return undefined;
  }
  return { message: marker.message };
}

/**
 * Lets Better Auth's OAuth provider recognise a resource row another instance
 * inserted first.
 *
 * When an instance initialises, the provider seeds its `resources`: it looks
 * each identifier up and inserts it when the lookup finds nothing. Two
 * instances starting together can both miss, and the second insert fails on
 * `oauth_resource_identifier_unique`. The seed means to skip that row, and it
 * recognises the case by `/unique|duplicate|UNIQUE/i` on the error's message
 * (`@better-auth/oauth-provider@1.7.6` `introspect-CbYi2MJT.mjs:848`). Through
 * Drizzle that message is "Failed query: insert into …", so the check never
 * matches and the losing instance's initialisation rejects. This rethrows that
 * one error as an `Error` carrying Postgres's own message, with the Drizzle
 * error as its `cause`, and the seed then skips the row. Under the default
 * `resourceSeedMode`, "insertOnly", that is what the seed does with a row its
 * lookup found, so it is correct: the row exists.
 *
 * Only `create` of the `oauthResource` model outside a transaction is wrapped.
 * The seed writes there. Inside a transaction a duplicate has already aborted
 * it, so presenting it as skippable would only move the failure. The
 * provider's `SERVER_ONLY` resource endpoint, which RequestPort does not call,
 * applies the same message check and so answers its own "already exists" 400
 * rather than an unrecognised error. Any other model, constraint, code or
 * error reaches the caller as it was thrown.
 */
export function wrapResourceSeedDuplicateAdapter(
  factory: DBAdapterInstance,
): DBAdapterInstance {
  return (options) => {
    const adapter = factory(options);
    const create: DBAdapter["create"] = async (input) => {
      try {
        return await adapter.create(input);
      } catch (error) {
        if (input.model === "oauthResource") {
          const duplicate = duplicateResourceIdentifier(error);
          if (duplicate) throw new Error(duplicate.message, { cause: error });
        }
        throw error;
      }
    };
    return { ...adapter, create };
  };
}

/**
 * The database production hands Better Auth: the signup guard around the
 * adapter, ruling 38's CIMD guard around that, and the resource seed's
 * duplicate translation outermost. `create-auth.ts` composes exactly this,
 * `server.ts` installs it, and `server.test.ts` checks both.
 */
export function composeAuthDatabase(
  factory: DBAdapterInstance,
): DBAdapterInstance {
  return wrapResourceSeedDuplicateAdapter(
    wrapCimdClientGuardAdapter(wrapSignupGuardAdapter(factory)),
  );
}
