import { describe, expect, test } from "vitest";

import {
  generateLocalCredential,
  hashLocalCredential,
  verifyLocalCredential,
} from "./local-credential.js";

/*
  Its own budget, because every case that hashes is slow without touching a
  database: each derives at most four scrypt keys at the parameters
  `local-credential.ts` fixes, Better Auth's own (N 16384, r 16, p 1, a 64-byte
  key, 32 MiB of memory each). In the forced gates of 2026-09-28 and
  2026-09-29, "verifies the credential it was hashed from and nothing else"
  took 0.42–4.8s where it passed, and overran Vitest's default of 5 seconds
  once, at 5.09s. 30 seconds is six times the budget it overran.
*/
describe("the local owner credential", { timeout: 30_000 }, () => {
  test("verifies the credential it was hashed from and nothing else", async () => {
    const credential = generateLocalCredential();
    const hash = await hashLocalCredential(credential);

    expect(await verifyLocalCredential({ hash, password: credential })).toBe(
      true,
    );
    expect(
      await verifyLocalCredential({ hash, password: `${credential}x` }),
    ).toBe(false);
    expect(await verifyLocalCredential({ hash, password: "" })).toBe(false);
  });

  test("never stores the credential, and salts every hash", async () => {
    const credential = generateLocalCredential();
    const first = await hashLocalCredential(credential);
    const second = await hashLocalCredential(credential);

    expect(first).not.toContain(credential);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$v1\$/u);
  });

  test.each([
    "",
    "not-a-hash",
    "scrypt$v1$16384$16$1$",
    "scrypt$v2$16384$16$1$AAAA$AAAA",
    "scrypt$v1$1$16$1$AAAA$AAAA",
    "bcrypt$2b$10$abcdefghijklmnopqrstuv",
  ])("refuses a stored value it did not write: %j", async (hash) => {
    expect(await verifyLocalCredential({ hash, password: "anything" })).toBe(
      false,
    );
  });

  /*
    A well-formed row from this module, with only one parameter changed. The
    key is the right length and matches the password at the module's own
    parameters, so nothing but the parameter comparison can refuse it.
  */
  test.each([
    ["N", 2, "1"],
    ["r", 3, "8"],
    ["p", 4, "2"],
  ] as const)(
    "refuses a row that claims another %s",
    async (_name, index, value) => {
      const credential = generateLocalCredential();
      const parts = (await hashLocalCredential(credential)).split("$");
      parts[index] = value;

      expect(
        await verifyLocalCredential({
          hash: parts.join("$"),
          password: credential,
        }),
      ).toBe(false);
    },
  );

  test("issues long, unguessable, printable credentials", () => {
    const issued = new Set(
      Array.from({ length: 32 }, () => generateLocalCredential()),
    );

    expect(issued.size).toBe(32);
    for (const credential of issued) {
      expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
  });
});
