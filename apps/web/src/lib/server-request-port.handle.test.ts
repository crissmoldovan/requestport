import { afterEach, describe, expect, test, vi } from "vitest";

/*
 * The web root's two ways to the database, as the modules G.2 moved onto it
 * use them (Plan 13, G.2): a call opens its transaction on `webStorage()`,
 * and a transaction manager built as its module loads holds `webDatabase`.
 * Both reach the root's storage's own `db.transaction`, with what they are
 * given: since G.5 that storage is the one the wiring builds for the web
 * process, no longer the default storage (ruling 118). That `transaction` is
 * replaced in each case that reaches it, so nothing here connects.
 */

/** Where role-guard.ts keeps this process's declaration. */
const DECLARATION = Symbol.for("requestport.database-surface");

type DeclarationHolder = Record<symbol, unknown>;

/*
 * Loaded once, before any case runs, so the cold import of `@requestport/db`'s
 * module graph is not spent from the first case's budget. The case that
 * replaces the wiring imports the root afresh, after `vi.resetModules()`.
 */
const { webDatabase, webStorage } = await import("./server-request-port.js");
const { DatabaseSurfaceError } = await import("@requestport/db");

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@requestport/db/wiring");
  vi.resetModules();
});

describe("the web root's storage, as the moved modules use it", () => {
  test("webStorage().transaction is the root storage's db.transaction, with the work and the configuration it is given", async () => {
    const { db } = webStorage();
    const reached = vi
      .spyOn(db, "transaction")
      .mockImplementation(async () => "committed" as never);
    const work = async () => "the work's result";
    const configuration = { accessMode: "read only" } as const;

    await expect(webStorage().transaction(work, configuration)).resolves.toBe(
      "committed",
    );
    expect(reached).toHaveBeenCalledOnce();
    expect(reached).toHaveBeenCalledWith(work, configuration);
  });

  test("webDatabase.transaction is the root storage's db.transaction, called on that db, with what it is given", async () => {
    const { db } = webStorage();
    const calledOn: unknown[] = [];
    const reached = vi
      .spyOn(db, "transaction")
      .mockImplementation(async function (this: unknown) {
        calledOn.push(this);
        return "committed" as never;
      });
    const work = async () => "the work's result";

    await expect(webDatabase.transaction(work)).resolves.toBe("committed");
    expect(reached).toHaveBeenCalledOnce();
    expect(reached).toHaveBeenCalledWith(work);
    expect(calledOn).toEqual([db]);
  });

  test("webDatabase asks for nothing as the root is imported, and asks the root's storage at each read", async () => {
    const handle = { transaction: vi.fn(), driver: "a handle" };
    const askedFor = vi.fn(() => ({ db: handle }));
    vi.doMock("@requestport/db/wiring", () => ({
      applicationStorageFromEnv: askedFor,
    }));

    const root = await import("./server-request-port.js");

    expect(askedFor).not.toHaveBeenCalled();
    root.webDatabase.transaction(async () => undefined);
    expect(askedFor).toHaveBeenCalledTimes(1);
    expect(handle.transaction).toHaveBeenCalledOnce();
    expect(Reflect.get(root.webDatabase, "driver")).toBe("a handle");
    expect(askedFor).toHaveBeenCalledTimes(2);
    expect("transaction" in root.webDatabase).toBe(true);
    expect(askedFor).toHaveBeenCalledTimes(3);
  });

  test("webDatabase, read in a process that has declared nothing, throws the root's refusal", () => {
    const holder = globalThis as DeclarationHolder;
    const declared = holder[DECLARATION];

    delete holder[DECLARATION];
    try {
      expect(() => webDatabase.transaction).toThrow(DatabaseSurfaceError);
    } finally {
      holder[DECLARATION] = declared;
    }
    expect(typeof webDatabase.transaction).toBe("function");
  });
});
