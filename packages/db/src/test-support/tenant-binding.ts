import type { TransactionManager } from "@requestport/domain";
import { sql } from "drizzle-orm";

import type { Tx } from "../transaction.js";

/*
 * For suites that run several transactions' worth of work inside one test
 * transaction they roll back (manifest-i2.md §2.3, D10).
 *
 * A command, or a repository method that opens its own transaction, binds
 * that transaction to one organisation, and handed a transaction it binds a
 * savepoint instead. A transaction-local setting outlives a released
 * savepoint, so the next piece of work, for another organisation or user, is
 * refused the binding its own transaction would have taken. In production
 * each of them runs in a transaction of its own on the pool, and the binding
 * ends with it; these end it where a suite needs the same.
 *
 * Test support only: the trusted-boundary sweep (tenant-context.test.ts)
 * admits `set_config` here because this directory is a test directory, and
 * nothing outside tests may import it.
 */

/** Ends whatever binding the work before left on `tx`. */
export async function endTenantBinding(tx: Tx) {
  await tx.execute(
    sql`select pg_catalog.set_config('requestport.organization_id', '', true),
               pg_catalog.set_config('requestport.user_id', '', true)`,
  );
}

/**
 * `manager`, with each command's binding ended when the command does, as a
 * command's own top-level transaction ends it in production.
 */
export function endingEachCommandBinding(
  manager: TransactionManager,
  tx: Tx,
): TransactionManager {
  return {
    async run(work, binding) {
      try {
        return await manager.run(work, binding);
      } finally {
        await endTenantBinding(tx);
      }
    },
  };
}

/**
 * `repository`, with the binding each of its methods leaves on `tx` ended
 * when the method settles, as each call's own transaction ends it in
 * production. For suites that call a repository for several organisations
 * on one transaction and never rely on a binding outliving the call.
 */
export function endingEachMethodBinding<T extends object>(
  repository: T,
  tx: Tx,
): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } finally {
          await endTenantBinding(tx);
        }
      };
    },
  });
}
