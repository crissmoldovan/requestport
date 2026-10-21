import { isE2EEmailMode } from "@requestport/auth/e2e";
import {
  createE2EOwnerStorage,
  type E2EOwnerStorage,
} from "@requestport/db/e2e";

/*
 * The owner storage the guarded scenario hook seeds and deletes through
 * (Plan 13, Track I.2, D20 option (a)).
 *
 * The acceptance server connects as a local application-role login, which
 * row security confines to the organisation a transaction is bound to. A
 * scenario seeds rows the product's own commands cannot put anywhere, across
 * organisations, so it cannot seed through the web root's storage. It seeds
 * through this one instead: a second storage over the owner's URL, which
 * `@requestport/db/e2e` reads from `REQUESTPORT_E2E_OWNER_DATABASE_URL` and
 * no other variable (I.2 step 7: the server carries no owner-capable name),
 * built on first use by the hook, never at import, so importing the route
 * module builds nothing.
 *
 * Refused, before `@requestport/db` is asked to build it:
 *
 * - wherever `VERCEL_ENV` is set, empty included — every Vercel deployment
 *   sets it;
 * - outside E2E mode (`isE2EEmailMode`: `NODE_ENV` development or test,
 *   `REQUESTPORT_E2E_MODE=1` and a token of at least 32 characters), so a
 *   production runtime never builds it.
 *
 * `createE2EOwnerStorage` refuses the first again, and the parts of the second
 * it can read, so neither refusal rests on this module alone.
 */

export const E2E_OWNER_STORAGE_REFUSED_ON_VERCEL_ENV =
  "The scenario hook's owner storage is never built where VERCEL_ENV is set.";

export const E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E_MODE =
  "The scenario hook's owner storage is built only in E2E mode.";

export function openE2EOwnerStorage(
  env: NodeJS.ProcessEnv = process.env,
  create: (env: NodeJS.ProcessEnv) => E2EOwnerStorage = createE2EOwnerStorage,
): E2EOwnerStorage {
  if (env.VERCEL_ENV !== undefined) {
    throw new Error(E2E_OWNER_STORAGE_REFUSED_ON_VERCEL_ENV);
  }
  if (!isE2EEmailMode(env)) {
    throw new Error(E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E_MODE);
  }

  return create(env);
}
