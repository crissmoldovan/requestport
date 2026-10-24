/**
 * Bounded request bodies (Plan 13, H.1; manifest-h.md §2.2).
 *
 * Moved here from `apps/web/src/lib/security/input-limits.ts`, which
 * re-exports each of these under its own name. `RequestTooLargeError` is one
 * class, so an `instanceof` holds whichever of the two paths a module
 * imported it by. Across copies of this module (the host's and Next's,
 * §2.7.1) it holds by its brand (H.5, ruling 143).
 */
import { DomainError } from "@requestport/domain";

/*
  The brand that lets `instanceof RequestTooLargeError` hold across copies of
  this module, as `DomainError`'s does (manifest-h.md §2.7.1). Under the
  self-host its throws and catches are each in one copy: the host's families
  in the host's, and the Resend and Slack routes in Next's. The brand keeps
  that from mattering if one ever moves. `Symbol.for` gives every copy the
  same key.
*/
const REQUEST_TOO_LARGE_ERROR_BRAND = Symbol.for(
  "requestport.request-too-large-error",
);

export class RequestTooLargeError extends Error {
  /**
   * True for this class's own instances, and for an Error another copy of
   * this module built, which carries the brand. Only `RequestTooLargeError`
   * itself accepts the brand: a subclass, which inherits this method, answers
   * by its own identity alone.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    // `this` is the class `instanceof` was asked about, as in DomainError's.
    // biome-ignore lint/complexity/noThisInStatic: the receiver is the point.
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return (
      // biome-ignore lint/complexity/noThisInStatic: as above.
      this === RequestTooLargeError &&
      value instanceof Error &&
      (value as { [REQUEST_TOO_LARGE_ERROR_BRAND]?: unknown })[
        REQUEST_TOO_LARGE_ERROR_BRAND
      ] === true
    );
  }

  constructor() {
    super("Request body is too large");
    this.name = "RequestTooLargeError";
    // Not enumerable, so what spreads, copies or serialises an error is as it was.
    Object.defineProperty(this, REQUEST_TOO_LARGE_ERROR_BRAND, { value: true });
  }
}

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new DomainError(
        "validation_failed",
        "Request content length is invalid",
      );
    }
    if (bytes > maxBytes) {
      throw new RequestTooLargeError();
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request_too_large");
        throw new RequestTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
) {
  const body = await readBoundedRequestBody(request, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new DomainError(
      "validation_failed",
      "Request body is not valid UTF-8",
    );
  }
}

/*
  The most JSON values `assertJsonDepth` lets one body hold (ruling 237
  item 3): the largest input a legitimate call carries, rounded up to the
  next 1,000. That call is `post_work_update`'s on MCP's 2026-07-28 leg, with
  the 10,000 elements the domain lets its evidence's free-form values hold
  and the six-value `_meta` packages/mcp's tests send: 16,520 values.

  packages/mcp's `server.tool-input-limit.test.ts` works that out from the
  tools' schemas, and this package's `rest.input-limit.test.ts` does the
  same for the REST commands' published schemas, whose largest body holds
  16,509; each fails when a schema change moves its figure. `McpServer`'s
  `maxToolInputElements` in packages/mcp is the same number, which
  `mcp.tool-input-limit.test.ts` holds it to.
*/
const MAX_JSON_VALUES = 17_000;

/**
 * Refuses JSON that nests deeper than `maxDepth`, 20 unless given, or holds
 * more than 17,000 values, counting every value the walk visits: the root,
 * each array element and each object member's value, at every level.
 *
 * Four routes walk a JSON body here, all of it, before they read any of
 * it: a REST command's body (`rest.ts`), an MCP message (`mcp.ts`), an
 * artifact import's body (`artifact-import.ts`) and apps/web's Slack
 * interaction payload. The bound is per body. An MCP message that is a
 * legacy JSON-RPC batch is one body, so the calls in it share the 17,000.
 * The import and Slack carry far fewer: the import's largest body holds 55
 * values, and Slack's payload for RequestPort's largest question message
 * about 170 (track J's record, after the independent review of ruling 237
 * item 3).
 */
export function assertJsonDepth(value: unknown, maxDepth = 20) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;
    if (visited > MAX_JSON_VALUES) {
      throw new DomainError("validation_failed", "JSON input is too complex");
    }
    if (current.depth > maxDepth) {
      throw new DomainError("validation_failed", "JSON nesting is too deep");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}
