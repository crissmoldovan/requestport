import { describe, expect, test } from "vitest";

import { readDatabaseUrl } from "./database-url.js";
import {
  createE2EOwnerStorage,
  E2E_OWNER_DATABASE_URL_VARIABLE,
  E2E_OWNER_STORAGE_REFUSED_ON_PGLITE,
  E2E_OWNER_STORAGE_REFUSED_ON_VERCEL,
  E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E,
  E2E_OWNER_STORAGE_URL_UNSET,
} from "./e2e-owner-storage.js";
import { ownerCapableVariableNames } from "./role-guard.js";

/*
 * D20 (Plan 13, Track I.2): the second, owner storage the E2E scenario hook
 * seeds through. The refusals read nothing but the variables named, so the
 * refusal cases carry no database URL at all: a refusal that came from a
 * missing URL instead would show as a different message.
 */

const e2eMode = { NODE_ENV: "test", REQUESTPORT_E2E_MODE: "1" } as const;

describe("createE2EOwnerStorage", () => {
  test.each([
    ["production", "production"],
    ["preview", "preview"],
    ["development", "development"],
    ["empty", ""],
  ])(
    "is refused where VERCEL_ENV is set (%s), even in E2E mode",
    (_, value) => {
      expect(() =>
        createE2EOwnerStorage({ ...e2eMode, VERCEL_ENV: value }),
      ).toThrow(E2E_OWNER_STORAGE_REFUSED_ON_VERCEL);
    },
  );

  test.each([
    ["a production runtime", { NODE_ENV: "production" }],
    ["no NODE_ENV", { NODE_ENV: undefined }],
    ["no E2E mode", { REQUESTPORT_E2E_MODE: undefined }],
    ["E2E mode other than 1", { REQUESTPORT_E2E_MODE: "true" }],
  ])("is never built outside E2E mode: %s", (_, change) => {
    expect(() => createE2EOwnerStorage({ ...e2eMode, ...change })).toThrow(
      E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E,
    );
  });

  test("is refused on PGlite, whose one connection cannot be shared with a second storage", () => {
    expect(() =>
      createE2EOwnerStorage({
        ...e2eMode,
        REQUESTPORT_DATABASE_DRIVER: "pglite",
      }),
    ).toThrow(E2E_OWNER_STORAGE_REFUSED_ON_PGLITE);
  });

  /*
   * Since I.2 step 7 the acceptance server's process carries no owner-capable
   * name (ruling 224 item 3), so the owner's URL reaches this storage under a
   * name of its own, which the role guard's environment check does not
   * refuse, and nothing else reads.
   */
  test("reads the owner's URL under a name of its own, which is not owner-capable", () => {
    expect(E2E_OWNER_DATABASE_URL_VARIABLE).toBe(
      "REQUESTPORT_E2E_OWNER_DATABASE_URL",
    );
    expect(
      ownerCapableVariableNames({ [E2E_OWNER_DATABASE_URL_VARIABLE]: "x" }),
    ).toEqual([]);
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "  "],
  ])(
    "is refused in E2E mode with its variable %s, naming the variable, even beside DATABASE_URL",
    (_, value) => {
      expect(() =>
        createE2EOwnerStorage({
          ...e2eMode,
          REQUESTPORT_DATABASE_DRIVER: "pg",
          DATABASE_URL: readDatabaseUrl(process.env),
          [E2E_OWNER_DATABASE_URL_VARIABLE]: value,
        }),
      ).toThrow(E2E_OWNER_STORAGE_URL_UNSET);
    },
  );

  test.runIf(process.env.REQUESTPORT_DATABASE_DRIVER === "pg")(
    "in E2E mode, dials REQUESTPORT_E2E_OWNER_DATABASE_URL as the owner, never DATABASE_URL, whatever the application variable names",
    async () => {
      const owner = new URL(readDatabaseUrl(process.env));
      const unreachable =
        "postgresql://nobody:nothing@127.0.0.1:1/not_this_one";
      const storage = createE2EOwnerStorage({
        ...e2eMode,
        [E2E_OWNER_DATABASE_URL_VARIABLE]: owner.toString(),
        REQUESTPORT_DATABASE_DRIVER: "pg",
        // Unreachable on purpose: were either read, the query below would fail.
        DATABASE_URL: unreachable,
        REQUESTPORT_APPLICATION_DATABASE_URL: unreachable,
      });

      try {
        const { rows } = await storage.query<{ who: string; db: string }>(
          "select current_user as who, current_database() as db where $1::int = 1",
          [1],
        );

        expect(rows).toEqual([
          {
            who: decodeURIComponent(owner.username),
            db: decodeURIComponent(owner.pathname.slice(1)),
          },
        ]);
      } finally {
        await storage.close();
      }
    },
  );
});
