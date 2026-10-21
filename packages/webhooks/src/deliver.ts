import {
  type EndpointResolver,
  resolveWebhookEndpoint,
} from "./endpoint-policy.js";
import { type DeliveryResponse, postPinned } from "./pinned-post.js";
import { createWebhookHeaders } from "./signature.js";

function retryAfterMs(headers: DeliveryResponse["headers"], now: number) {
  const raw = headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = /^\d+$/u.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1_000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(3_600_000, seconds * 1_000);
}

async function withinDeliveryDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("delivery_timeout")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function deliverWebhook(input: {
  endpointUrl: string;
  eventId: string;
  deliveryId: string;
  attempt: number;
  schemaVersion: number;
  keyId: string;
  secret: string;
  payload: Record<string, unknown>;
  production?: boolean;
  /**
   * The operator's opt-in for private and loopback receivers
   * (`EndpointPolicyOptions`), applied to the endpoint and to every
   * redirect, each resolved again here. Off when absent.
   */
  privateReceivers?: boolean;
  resolver?: EndpointResolver;
  now?: () => number;
  onResolved?: (input: {
    addresses: string[];
    timestamp: number;
  }) => Promise<void>;
}) {
  const rawBody = new TextEncoder().encode(JSON.stringify(input.payload));
  const started = Date.now();
  let endpoint = input.endpointUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const remaining = Math.max(1, 10_000 - (Date.now() - started));
    const resolved = await withinDeliveryDeadline(
      resolveWebhookEndpoint(endpoint, {
        production: input.production,
        privateReceivers: input.privateReceivers,
        resolver: input.resolver,
      }),
      remaining,
    );
    const timestamp = input.now?.() ?? Math.floor(Date.now() / 1_000);
    await input.onResolved?.({
      addresses: resolved.addresses.map((row) => row.address),
      timestamp,
    });
    const requestTimeoutMs = 10_000 - (Date.now() - started);
    if (requestTimeoutMs <= 0) throw new Error("delivery_timeout");
    const headers = createWebhookHeaders({ ...input, timestamp, rawBody });
    const response = await postPinned({
      url: resolved.url,
      address: resolved.addresses[0]?.address ?? "",
      family: resolved.addresses[0]?.family ?? 4,
      body: rawBody,
      headers,
      timeoutMs: requestTimeoutMs,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (redirect === 3 || typeof location !== "string")
        throw new Error("unsafe_redirect");
      endpoint = new URL(location, resolved.url).toString();
      continue;
    }
    // Remote response bodies regularly contain provider diagnostics, request
    // identifiers, and reflected credentials. The body is useful while
    // debugging a receiver, but retaining it would make RequestPort a secret
    // sink. Preserve only the fact that a body existed.
    const excerpt =
      response.body.byteLength > 0 ? "[response body omitted]" : undefined;
    return {
      status: response.status,
      excerpt,
      rawBody,
      resolvedIps: resolved.addresses.map((row) => row.address),
      timestamp,
      retryAfterMs: retryAfterMs(response.headers, Date.now()),
    };
  }
  throw new Error("redirect_limit");
}

export function classifyWebhookResult(status: number) {
  if (status >= 200 && status < 300) return "delivered" as const;
  if ([408, 425, 429].includes(status) || status >= 500)
    return "retry" as const;
  return "dead_letter" as const;
}
