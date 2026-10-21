/**
 * A uuid shaped out of a digest, keeping both nibbles the format fixes.
 *
 * It lives outside `actions.ts` because a `"use server"` module may export
 * nothing but async functions — Next refuses the build otherwise, and the
 * action audit could not see a synchronous export to refuse it earlier.
 *
 * Exported so it can be proven on a digest chosen to break it rather than on
 * whichever value a fixture's HMAC happens to produce. That distinction is not
 * academic: an earlier attempt at this masked the version nibble and left the
 * variant alone, and every test stayed green — because the fixtures it ran on
 * happened to already hold a legal variant. Ten of the sixteen values do not,
 * so most real people would have been handed an id `z.uuid()` refuses.
 *
 * Version 4 and variant 8–b are what the format requires and what zod checks.
 * Neither is a claim about randomness; this value is derived, deliberately.
 */
export function uuidFromDigest(hex: string) {
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
