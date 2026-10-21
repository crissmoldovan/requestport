import {
  type Audience,
  type CredentialStore,
  CredentialStoreError,
  resourceFor,
  type StoredCredential,
} from "@requestport/client/credentials";

/**
 * The key a login's credential is held under until `whoami` names its
 * project. `authorize` stores what it obtains under a project id, and the
 * person chooses the project on the consent page, after the authorization has
 * started (manifest-h.md §2.8.2, "The holding store"). Not a UUID, so it
 * cannot be a project's id. It keys the holding store, in memory, and the
 * login's token-source lock, whose directory is removed before the login
 * returns (`agent-authorization.ts`); the command's messages replace it.
 */
export const HOLDING_PROJECT_ID = "project-chosen-at-consent";

export interface HoldingStore extends CredentialStore {
  readonly audience: Audience;
  readonly projectId: typeof HOLDING_PROJECT_ID;
  /** The record held now: `authorize`'s, or the one a refresh rotated. */
  held(): StoredCredential | undefined;
}

function originOf(server: string): string {
  try {
    return new URL(server).origin;
  } catch {
    throw new CredentialStoreError(
      "The login's holding store was given a server that is not a URL.",
    );
  }
}

/**
 * A `CredentialStore` for one login: one record, for one server and one
 * audience, under `HOLDING_PROJECT_ID`, in memory only. Any other key is
 * refused, so nothing meant for the real store can land here, and nothing
 * here can be read as another project's. It holds no record from an earlier
 * client, so `hasLegacyRecord` answers false (ruling 103).
 */
export function createHoldingStore(
  server: string,
  audience: Audience,
): HoldingStore {
  const origin = originOf(server);
  const resource = resourceFor(server, audience);
  let record: StoredCredential | undefined;

  function assertKey(
    keyServer: string,
    projectId: string,
    keyAudience: Audience,
  ): void {
    if (
      originOf(keyServer) !== origin ||
      projectId !== HOLDING_PROJECT_ID ||
      keyAudience !== audience
    ) {
      throw new CredentialStoreError(
        `The login's holding store keeps the ${audience} credential for ${origin} being authorized, and no other.`,
      );
    }
  }

  return {
    audience,
    projectId: HOLDING_PROJECT_ID,

    clear(keyServer, projectId, keyAudience) {
      assertKey(keyServer, projectId, keyAudience);
      record = undefined;
    },

    hasLegacyRecord(keyServer, projectId) {
      assertKey(keyServer, projectId, audience);
      return false;
    },

    held() {
      return record;
    },

    read(keyServer, projectId, keyAudience) {
      assertKey(keyServer, projectId, keyAudience);
      return record;
    },

    write(keyServer, projectId, keyAudience, credential) {
      assertKey(keyServer, projectId, keyAudience);
      if (
        credential.version !== 2 ||
        credential.audience !== audience ||
        credential.resource !== resource
      ) {
        throw new CredentialStoreError(
          `The login's holding store keeps a version 2 ${audience} credential for ${resource} only.`,
        );
      }
      record = { ...credential };
    },
  };
}

/**
 * Moves the held record to the real store under the project `whoami` named,
 * then forgets it. The record is the one current after the login's refresh,
 * client id and resource included, so the real store's first refresh
 * presents the refresh token the server last issued.
 */
export function rekey(
  holding: HoldingStore,
  store: CredentialStore,
  server: string,
  projectId: string,
): void {
  const record = holding.held();
  if (record === undefined) {
    throw new CredentialStoreError(
      `The login holds no ${holding.audience} credential to store.`,
    );
  }
  store.write(server, projectId, holding.audience, record);
  holding.clear(server, HOLDING_PROJECT_ID, holding.audience);
}
