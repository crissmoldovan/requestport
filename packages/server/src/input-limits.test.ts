import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  assertJsonDepth,
  RequestTooLargeError,
  readBoundedRequestBody,
  readBoundedRequestText,
} from "./input-limits.js";

/** A POST whose body streams `chunks`, recording how many were pulled. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const pulled = { count: 0, cancelled: undefined as unknown };
  // No high-water mark, so a chunk is pulled only when a reader asks for one.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[pulled.count];
        pulled.count += 1;
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel(reason) {
        pulled.cancelled = reason;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("https://requestport.test/bounded", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, pulled };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("readBoundedRequestBody", () => {
  test("reads a body within the bound, byte for byte, across chunks", async () => {
    const { request } = streamed([bytes("hello, "), bytes("world")]);

    const body = await readBoundedRequestBody(request, 12);

    expect(new TextDecoder().decode(body)).toBe("hello, world");
  });

  test("answers an empty body for a request without one", async () => {
    const body = await readBoundedRequestBody(
      new Request("https://requestport.test/bounded"),
      1,
    );

    expect(body).toEqual(new Uint8Array());
  });

  test("refuses a declared length over the bound before reading anything", async () => {
    const { request, pulled } = streamed([bytes("x")], {
      "content-length": "13",
    });

    await expect(readBoundedRequestBody(request, 12)).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );
    expect(pulled.count).toBe(0);
  });

  test.each(["-1", "1.5", "twelve", "9007199254740993"])(
    "refuses a content-length of %s as invalid input, not as too large",
    async (declared) => {
      const { request } = streamed([bytes("x")], {
        "content-length": declared,
      });

      const refusal = await readBoundedRequestBody(request, 12).catch(
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(DomainError);
      expect(refusal).toMatchObject({
        code: "validation_failed",
        message: "Request content length is invalid",
      });
    },
  );

  test("refuses a body that grows past the bound without declaring it, and cancels the stream", async () => {
    const { request, pulled } = streamed([
      bytes("1234567890"),
      bytes("123"),
      bytes("never read"),
    ]);

    await expect(readBoundedRequestBody(request, 12)).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );
    expect(pulled.count).toBe(2);
    expect(pulled.cancelled).toBe("request_too_large");
  });

  test("accepts a body exactly at the bound", async () => {
    const { request } = streamed([bytes("123456789012")], {
      "content-length": "12",
    });

    expect((await readBoundedRequestBody(request, 12)).byteLength).toBe(12);
  });
});

describe("readBoundedRequestText", () => {
  test("decodes UTF-8", async () => {
    const { request } = streamed([bytes("café")]);

    expect(await readBoundedRequestText(request, 16)).toBe("café");
  });

  test("refuses bytes that are not UTF-8 as invalid input", async () => {
    const { request } = streamed([new Uint8Array([0xc3, 0x28])]);

    await expect(readBoundedRequestText(request, 16)).rejects.toMatchObject({
      code: "validation_failed",
      message: "Request body is not valid UTF-8",
    });
  });
});

describe("assertJsonDepth", () => {
  const nested = (depth: number): unknown =>
    depth === 0 ? "leaf" : { child: nested(depth - 1) };

  test("admits nesting up to the bound, 20 by default", () => {
    expect(() => assertJsonDepth(nested(20))).not.toThrow();
    expect(() => assertJsonDepth([[["leaf"]]], 3)).not.toThrow();
  });

  test("refuses nesting past the bound", () => {
    expect(() => assertJsonDepth(nested(21))).toThrow(
      "JSON nesting is too deep",
    );
    expect(() => assertJsonDepth([[["leaf"]]], 2)).toThrow(
      "JSON nesting is too deep",
    );
  });

  test("refuses more than 100,000 values however shallow", () => {
    const wide = Array.from({ length: 100_000 }, () => 0);

    expect(() => assertJsonDepth(wide)).toThrow("JSON input is too complex");
    expect(() => assertJsonDepth(wide.slice(1))).not.toThrow();
  });
});

test("RequestTooLargeError names itself, and is an Error", () => {
  const error = new RequestTooLargeError();

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("RequestTooLargeError");
  expect(error.message).toBe("Request body is too large");
});

/*
  RequestTooLargeError's brand (Plan 13, H.5; manifest-h.md §2.7.1; ruling
  143). Under the self-host its throws and catches are each in one copy, but
  the class is in both the host's copy and Next's, so it is branded as
  DomainError is. A second copy is this module evaluated again:
  `vi.resetModules()`, then a fresh import.
*/
describe("instanceof RequestTooLargeError", () => {
  test("holds for an error a second copy of the module built, both ways", async () => {
    vi.resetModules();
    const copy = await import("./input-limits.js");

    expect(copy.RequestTooLargeError).not.toBe(RequestTooLargeError);
    expect(
      new copy.RequestTooLargeError() instanceof RequestTooLargeError,
    ).toBe(true);
    expect(
      new RequestTooLargeError() instanceof copy.RequestTooLargeError,
    ).toBe(true);
  });

  test("does not hold for an unbranded Error named RequestTooLargeError", () => {
    const named = Object.assign(new Error("Request body is too large"), {
      name: "RequestTooLargeError",
    });

    expect(named instanceof RequestTooLargeError).toBe(false);
  });

  test("does not hold for a value that carries the brand but is not an Error", () => {
    const forged = {
      [Symbol.for("requestport.request-too-large-error")]: true,
      name: "RequestTooLargeError",
    };

    expect(forged instanceof RequestTooLargeError).toBe(false);
  });

  test("does not hold for a branded DomainError, nor a DomainError for it", () => {
    const tooLarge = new RequestTooLargeError();
    const invalid = new DomainError("validation_failed", "Invalid");

    expect(tooLarge instanceof DomainError).toBe(false);
    expect(invalid instanceof RequestTooLargeError).toBe(false);
  });

  test("a subclass answers by its own identity, not by the brand", () => {
    class NarrowerError extends RequestTooLargeError {}

    expect(new NarrowerError() instanceof NarrowerError).toBe(true);
    expect(new NarrowerError() instanceof RequestTooLargeError).toBe(true);
    expect(new RequestTooLargeError() instanceof NarrowerError).toBe(false);
  });

  test("its brand is an own property that is not enumerable", () => {
    const error = new RequestTooLargeError();

    expect(
      Object.getOwnPropertyDescriptor(
        error,
        Symbol.for("requestport.request-too-large-error"),
      ),
    ).toEqual({
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(Object.getOwnPropertySymbols({ ...error })).toEqual([]);
  });
});
