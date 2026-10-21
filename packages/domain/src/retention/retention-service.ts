export const retentionCategories = [
  "verification",
  "session",
  "oauth_access_token",
  "oauth_refresh_token",
  "command_receipt",
  "slack_oauth_state",
  "slack_action_token",
  "provider_callback_receipt",
  "rate_limit_bucket",
] as const;

export type RetentionCategory = (typeof retentionCategories)[number];

export const retentionHoldCategories = [
  "all",
  "slack_oauth_state",
  "slack_action_token",
] as const;

export type RetentionHoldCategory = (typeof retentionHoldCategories)[number];

const retentionAgeMs: Record<RetentionCategory, number> = {
  verification: 24 * 60 * 60_000,
  session: 7 * 24 * 60 * 60_000,
  oauth_access_token: 7 * 24 * 60 * 60_000,
  oauth_refresh_token: 30 * 24 * 60 * 60_000,
  command_receipt: 0,
  slack_oauth_state: 24 * 60 * 60_000,
  slack_action_token: 7 * 24 * 60 * 60_000,
  provider_callback_receipt: 90 * 24 * 60 * 60_000,
  rate_limit_bucket: 0,
};

export function retentionCutoff(category: RetentionCategory, now = new Date()) {
  return new Date(now.getTime() - retentionAgeMs[category]);
}

export function retentionPolicy(now = new Date()) {
  return retentionCategories.map((category) => ({
    category,
    cutoffAt: retentionCutoff(category, now),
  }));
}
