import { describe, expect, test } from "vitest";

import {
  type HeldWriteRoute,
  holdNextWrite,
} from "../../tests/fixtures/held-write.js";

/**
 * The pending-state hold, without a browser.
 *
 * `route-state-0128` failed at release with `500: E2E scenario cleanup failed:
 * projects` after every assertion it made had passed: the hold let its write
 * through when the case ended, the write appended an event against the
 * scenario's project, and `domain_events` is append-only. The claim proven here
 * is the one that closes it — a held write is aborted and never sent, on every
 * path out of the case, and so is any write the page makes afterwards.
 */

type FakeRoute = HeldWriteRoute & { outcome: () => string | null };

function fakeRoute(method: string): FakeRoute {
  let outcome: string | null = null;
  return {
    abort: async (code) => {
      outcome = `abort:${code ?? ""}`;
    },
    fallback: async () => {
      outcome = "fallback";
    },
    outcome: () => outcome,
    request: () => ({ method: () => method }),
  };
}

async function fakePage() {
  let handler: ((route: FakeRoute) => Promise<void>) | undefined;
  const page = {
    route: async (
      _url: string,
      registered: (route: FakeRoute) => Promise<void>,
    ) => {
      handler = registered;
    },
  };
  const write = await holdNextWrite(page);
  const send = (route: FakeRoute) => {
    if (handler === undefined) throw new Error("no handler registered");
    return handler(route);
  };

  return { send, write };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("holdNextWrite", () => {
  test("holds the first write, then aborts it rather than sending it", async () => {
    const { send, write } = await fakePage();
    const post = fakeRoute("POST");
    const handled = send(post);

    expect(await write.observed).toBe(post);
    await tick();
    // Held: nothing has decided the request yet.
    expect(post.outcome()).toBeNull();

    await write.abandon();
    await handled;
    expect(post.outcome()).toBe("abort:aborted");
  });

  test("abandon resolves only once the held write has been aborted", async () => {
    const { send, write } = await fakePage();
    const post = fakeRoute("POST");
    void send(post);
    await write.observed;

    await write.abandon();
    expect(post.outcome()).toBe("abort:aborted");
  });

  test("lets reads through untouched, before and during the hold", async () => {
    const { send, write } = await fakePage();
    const before = fakeRoute("GET");
    await send(before);
    expect(before.outcome()).toBe("fallback");

    void send(fakeRoute("POST"));
    await write.observed;
    const during = fakeRoute("GET");
    await send(during);
    expect(during.outcome()).toBe("fallback");
    await write.abandon();
  });

  test("counts a write made while the first is held, the only one it lets through", async () => {
    const { send, write } = await fakePage();
    const first = fakeRoute("POST");
    void send(first);
    await write.observed;
    expect(write.writesLetThrough()).toBe(0);

    const second = fakeRoute("POST");
    await send(second);
    expect(second.outcome()).toBe("fallback");
    await send(fakeRoute("GET"));
    expect(write.writesLetThrough()).toBe(1);

    await write.abandon();
    await send(fakeRoute("POST"));
    // Refused once the case is over, so never sent and not counted.
    expect(write.writesLetThrough()).toBe(1);
    expect(first.outcome()).toBe("abort:aborted");
  });

  test("refuses every write the page makes once the case has ended", async () => {
    const { send, write } = await fakePage();
    void send(fakeRoute("POST"));
    await write.observed;
    await write.abandon();

    const after = fakeRoute("POST");
    await send(after);
    expect(after.outcome()).toBe("abort:aborted");
  });

  test("a case that ends before its write still refuses the write", async () => {
    const { send, write } = await fakePage();
    // The `finally` of a case whose click never landed.
    await write.abandon();

    const late = fakeRoute("POST");
    await send(late);
    expect(late.outcome()).toBe("abort:aborted");
  });

  test("abandon is safe to call twice", async () => {
    const { send, write } = await fakePage();
    const post = fakeRoute("POST");
    void send(post);
    await write.observed;

    await write.abandon();
    await write.abandon();
    expect(post.outcome()).toBe("abort:aborted");
  });
});
