/**
 * The lease each repair claims under: as long as the repair's own run may
 * last (`maxDuration: 300` in trigger.config.ts), because the rows are
 * started one at a time and an acceptance after the lease has run out is
 * refused (functions 2 and 5). Within both functions' bounds (1: 10-600 s;
 * 4: 60-1 800 s). A row a run leaves unaccepted is claimed again when this
 * lease runs out.
 */
export const REPAIR_LEASE_SECONDS = 300;
