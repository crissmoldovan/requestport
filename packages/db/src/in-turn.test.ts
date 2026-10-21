import { describe, expect, test } from "vitest";

import { inTurn } from "./in-turn.js";

/** A read whose settling the test controls, recording when it starts. */
function controlledRead<T>(name: string, log: string[]) {
  let settle: (value: T) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const read = () => {
    log.push(`start ${name}`);
    return new Promise<T>((resolve, reject) => {
      settle = (value) => {
        log.push(`settle ${name}`);
        resolve(value);
      };
      fail = (error) => {
        log.push(`fail ${name}`);
        reject(error);
      };
    });
  };
  return {
    read,
    settle: (value: T) => settle(value),
    fail: (error: Error) => fail(error),
  };
}

async function turns() {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

describe("inTurn (X24)", () => {
  test("starts each read only once the one before it has settled, and resolves to their results in order", async () => {
    const log: string[] = [];
    const first = controlledRead<number>("first", log);
    const second = controlledRead<string>("second", log);
    const third = controlledRead<boolean>("third", log);

    const all = inTurn([first.read, second.read, third.read]);
    await turns();
    expect(log).toEqual(["start first"]);

    first.settle(1);
    await turns();
    expect(log).toEqual(["start first", "settle first", "start second"]);

    second.settle("two");
    await turns();
    third.settle(true);

    const results: [number, string, boolean] = await all;
    expect(results).toEqual([1, "two", true]);
    expect(log).toEqual([
      "start first",
      "settle first",
      "start second",
      "settle second",
      "start third",
      "settle third",
    ]);
  });

  test("rejects with the first read's failure, and starts none after it", async () => {
    const log: string[] = [];
    const first = controlledRead<number>("first", log);
    const second = controlledRead<number>("second", log);
    const failure = new Error("the first read failed");

    const all = inTurn([first.read, second.read]);
    await turns();
    first.fail(failure);

    await expect(all).rejects.toBe(failure);
    expect(log).toEqual(["start first", "fail first"]);
  });

  test("resolves an empty list to an empty list", async () => {
    await expect(inTurn([])).resolves.toEqual([]);
  });
});
