import { afterEach, describe, expect, test, vi } from "vitest";

import {
  livenessResponse,
  READINESS_TIMEOUT_MS,
  readinessResponse,
} from "./health.js";

afterEach(() => {
  vi.useRealTimers();
});

test("liveness answers 200 { ok: true }, not to be stored", async () => {
  const response = livenessResponse();

  expect(response.status).toBe(200);
  expect([...response.headers]).toEqual([
    ["cache-control", "no-store"],
    ["content-type", "application/json"],
  ]);
  expect(await response.text()).toBe('{"ok":true}');
});

describe("readiness", () => {
  test("waits 2,000 ms for the probe", () => {
    expect(READINESS_TIMEOUT_MS).toBe(2_000);
  });

  test("answers 200 { ready: true } once the probe resolves, running the check and the probe once each", async () => {
    const probe = vi.fn(async () => {});
    const check = vi.fn(async () => probe);

    const response = await readinessResponse(check);

    expect(response.status).toBe(200);
    expect([...response.headers]).toEqual([
      ["cache-control", "no-store"],
      ["content-type", "application/json"],
    ]);
    expect(await response.text()).toBe('{"ready":true}');
    expect(check).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
  });

  test("answers 503 { ready: false } when the check throws, and probes nothing", async () => {
    const probe = vi.fn(async () => {});

    const response = await readinessResponse(async () => {
      throw new Error("readiness_configuration_invalid");
    });

    expect(response.status).toBe(503);
    expect([...response.headers]).toEqual([
      ["cache-control", "no-store"],
      ["content-type", "application/json"],
    ]);
    expect(await response.text()).toBe('{"ready":false}');
    expect(probe).not.toHaveBeenCalled();
  });

  test("answers 503 { ready: false } when the probe rejects", async () => {
    const response = await readinessResponse(async () => async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ready":false}');
  });

  test("answers 503 { ready: false } when the probe is silent for 2,000 ms, and not before", async () => {
    vi.useFakeTimers();
    let settled = false;

    const answer = readinessResponse(
      async () => () => new Promise<void>(() => {}),
    ).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const response = await answer;
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ready":false}');
  });

  test("times the probe alone: a check that takes longer than 2,000 ms, then a probe that resolves, answers 200", async () => {
    vi.useFakeTimers();

    const answer = readinessResponse(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return async () => {};
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect((await answer).status).toBe(200);
  });
});

/*
 * Readiness's trace (Plan 13, H.5; ruling 145: "the readiness handler logs
 * what it catches"). A 503 writes one console line saying which step failed
 * and what it caught, by the error's name and code, never its message: a pg
 * error's message can carry connection details. A 200 writes nothing.
 */
describe("readiness's trace (ruling 145)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Captures console.error's lines, and prints none. */
  function consoleErrors() {
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  test("writes nothing when it answers 200", async () => {
    const logged = consoleErrors();

    expect((await readinessResponse(async () => async () => {})).status).toBe(
      200,
    );
    expect(logged).not.toHaveBeenCalled();
  });

  test("answers 200, as before, for a probe that answers a value that is not a promise", async () => {
    const logged = consoleErrors();
    const answersAValue = (() => true) as unknown as () => Promise<unknown>;

    expect((await readinessResponse(async () => answersAValue)).status).toBe(
      200,
    );
    expect(logged).not.toHaveBeenCalled();
  });

  test("names what the check threw, by its name, and never its message", async () => {
    const logged = consoleErrors();
    const thrown = new Error(
      "connect to postgres://requestport:secret@db.example/requestport",
    );
    thrown.name = "HostHandoffRefusalError";

    const response = await readinessResponse(async () => {
      throw thrown;
    });

    expect(response.status).toBe(503);
    expect(logged.mock.calls).toEqual([
      [
        "RequestPort readiness answered 503: the check threw HostHandoffRefusalError.",
      ],
    ]);
  });

  test("names what the probe rejected with, by its name and code, and never its message", async () => {
    const logged = consoleErrors();
    const rejected = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      { code: "ECONNREFUSED" },
    );

    const response = await readinessResponse(async () => async () => {
      throw rejected;
    });

    expect(response.status).toBe(503);
    expect(logged.mock.calls).toEqual([
      [
        "RequestPort readiness answered 503: the probe rejected with Error (code ECONNREFUSED).",
      ],
    ]);
  });

  test("says when the probe stayed silent for 2,000 ms", async () => {
    vi.useFakeTimers();
    const logged = consoleErrors();

    const answer = readinessResponse(
      async () => () => new Promise<void>(() => {}),
    );
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    expect((await answer).status).toBe(503);
    expect(logged.mock.calls).toEqual([
      [
        "RequestPort readiness answered 503: the probe did not answer within 2000 ms.",
      ],
    ]);
  });

  test("names a thrown value that is not an object by its type, and leaves out a name or a code that is not an identifier", async () => {
    const logged = consoleErrors();
    const oddlyNamed = Object.assign(new Error("x"), {
      name: "postgres://requestport:secret@db.example",
      code: "28P01 password authentication failed",
    });
    const numbered = Object.assign(new Error("x"), { code: 28 });

    await readinessResponse(async () => {
      throw "postgres://requestport:secret@db.example";
    });
    await readinessResponse(async () => {
      throw oddlyNamed;
    });
    await readinessResponse(async () => {
      throw numbered;
    });

    expect(logged.mock.calls).toEqual([
      ["RequestPort readiness answered 503: the check threw a string."],
      ["RequestPort readiness answered 503: the check threw an error."],
      ["RequestPort readiness answered 503: the check threw Error (code 28)."],
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret");
  });
});
