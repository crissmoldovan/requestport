import { createRetentionRepository } from "@requestport/db";
import { retentionCategories } from "@requestport/domain";

import { observeTaskResult, workerLogger } from "../observability.js";
import { workerStorages } from "../worker-storages.js";

const logger = workerLogger("trigger-retention");

/**
 * One batch of each of the nine categories, in `retentionCategories`' order,
 * through function 17 on the maintenance storage (track-i2.md, "I.2b design"
 * §3). The function computes each cutoff from its own clock and the
 * category's age; this job passes none.
 */
export const cleanUpRetention = () =>
  observeTaskResult("retention-cleanup", async () => {
    const retention = createRetentionRepository(workerStorages().maintenance);
    const results = [];
    for (const category of retentionCategories) {
      const result = await retention.cleanup({ category, batchSize: 500 });
      results.push(result);
      logger.info("retention.category_completed", {
        status: result.deleted > 0 ? "deleted" : "empty",
        count: result.deleted,
      });
    }
    return { categories: results };
  });
