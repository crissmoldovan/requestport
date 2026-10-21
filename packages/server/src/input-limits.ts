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

export function assertJsonDepth(value: unknown, maxDepth = 20) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;
    if (visited > 100_000) {
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
