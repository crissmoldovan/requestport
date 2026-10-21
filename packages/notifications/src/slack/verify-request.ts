import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackRequest(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  now?: number;
}) {
  const timestamp = Number(input.timestamp);
  if (
    !Number.isInteger(timestamp) ||
    Math.abs((input.now ?? Math.floor(Date.now() / 1_000)) - timestamp) > 300
  )
    return false;
  if (!/^v0=[0-9a-f]{64}$/u.test(input.signature)) return false;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:${input.rawBody}`).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(input.signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
