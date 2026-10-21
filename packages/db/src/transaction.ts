import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";

import type { RowsResultHKT, Schema } from "./client.js";

/**
 * A transaction handle that names no driver (contract §3.1). That it is one
 * session — one backend, rolled back as a whole — is proved per driver by
 * `transaction.test.ts`, not by the type.
 */
export type Tx = PgTransaction<
  RowsResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
