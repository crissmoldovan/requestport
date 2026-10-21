import {
  createSignupEligibilityRepository,
  type Database,
} from "@requestport/db";

import { createSignupPolicy, type SignupDecision } from "./signup-policy.js";

/**
 * The signup policy over the database (manifest-g.md §2.12): built on its
 * first call, over `createSignupEligibilityRepository(database())`, and kept.
 * So composing Better Auth, which takes this function, asks for no database.
 */
export function createDatabaseSignupPolicy(
  database: () => Database,
): (email: string) => Promise<SignupDecision> {
  let policy: ReturnType<typeof createSignupPolicy> | undefined;

  return async (email) => {
    policy ??= createSignupPolicy({
      repository: createSignupEligibilityRepository(database()),
      now: () => new Date(),
    });
    return policy.assertSignupAllowed(email);
  };
}
