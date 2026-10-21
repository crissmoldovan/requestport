import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { E2EOwnerStorage } from "@requestport/db/e2e";
import { describe, expect, test, vi } from "vitest";

import {
  E2E_OWNER_STORAGE_REFUSED_ON_VERCEL_ENV,
  E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E_MODE,
  openE2EOwnerStorage,
} from "./e2e-owner-storage.js";

const token = "owner-storage-token-that-is-at-least-thirty-two-characters";
const e2eEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  REQUESTPORT_E2E_MODE: "1",
  REQUESTPORT_E2E_TOKEN: token,
  // Never dialled: every case here either refuses or hands the env to a fake.
  // The owner's URL under the name the owner storage reads (I.2 step 7).
  REQUESTPORT_E2E_OWNER_DATABASE_URL:
    "postgresql://owner:secret@127.0.0.1:5432/never_dialled",
};

function fakeStorage(): E2EOwnerStorage {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    close: vi.fn(async () => undefined),
  };
}

describe("the scenario hook's owner storage (D20)", () => {
  test("is built in E2E mode, from the environment it was handed", () => {
    const built = fakeStorage();
    const create = vi.fn((_env: NodeJS.ProcessEnv) => built);

    expect(openE2EOwnerStorage({ ...e2eEnv }, create)).toBe(built);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject(e2eEnv);
  });

  test.each([
    ["production", "production"],
    ["preview", "preview"],
    ["development", "development"],
    ["empty", ""],
  ])(
    "is refused where VERCEL_ENV is set (%s), in E2E mode, before anything is built",
    (_, value) => {
      const create = vi.fn(fakeStorage);

      expect(() =>
        openE2EOwnerStorage({ ...e2eEnv, VERCEL_ENV: value }, create),
      ).toThrow(E2E_OWNER_STORAGE_REFUSED_ON_VERCEL_ENV);
      expect(create).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["a production runtime", { NODE_ENV: "production" }],
    ["no E2E mode", { REQUESTPORT_E2E_MODE: undefined }],
    ["E2E mode other than 1", { REQUESTPORT_E2E_MODE: "true" }],
    ["no token", { REQUESTPORT_E2E_TOKEN: undefined }],
    ["a short token", { REQUESTPORT_E2E_TOKEN: "short" }],
  ])("is never built outside E2E mode: %s", (_, change) => {
    const create = vi.fn(fakeStorage);

    expect(() =>
      openE2EOwnerStorage(
        { ...e2eEnv, ...change } as NodeJS.ProcessEnv,
        create,
      ),
    ).toThrow(E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E_MODE);
    expect(create).not.toHaveBeenCalled();
  });

  test("the scenario route builds it on use, not at import, and seeds through nothing else", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../app/api/test/scenarios/route.ts"),
      "utf8",
    );

    // The only call is inside the accessor the executor calls, so importing
    // the route module (which `next build` does) builds no storage.
    const calls = source.match(/openE2EOwnerStorage\(/gu) ?? [];
    expect(calls).toHaveLength(1);
    expect(source).toMatch(
      /function ownerStorage\(\)[^{]*\{[^}]*openE2EOwnerStorage\(\)/u,
    );
    // The default storage's pool is not how the hook writes any more.
    expect(source).not.toMatch(/\bdb\.\$client\b/u);
  });
});
