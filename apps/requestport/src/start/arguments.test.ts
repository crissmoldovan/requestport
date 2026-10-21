import { describe, expect, test } from "vitest";

import { OwnerUrlError } from "../owner-url.js";
import {
  parseStartArguments,
  START_USAGE,
  StartUsageError,
} from "./arguments.js";

const SENTINEL = "S3NT1NEL_0wner_secret";

function refused(argv: string[]): Error {
  try {
    parseStartArguments(argv);
  } catch (error) {
    expect((error as Error).message).not.toContain(SENTINEL);
    return error as Error;
  }
  throw new Error("not refused");
}

describe("requestport start's arguments", () => {
  test("reads every option, with a value after it or after =", () => {
    expect(
      parseStartArguments([
        "--data-dir",
        "/data",
        "--owner-url-file=/secret/owner.url",
        "--public-url",
        "https://rp.example.com",
        "--port=3300",
        "--host",
        "0.0.0.0",
        "--trusted-proxy",
        "10.0.0.1",
        "--email",
        "owner@example.com",
        "--organization",
        "acme",
        "--organization-name=Acme Ltd",
      ]),
    ).toEqual({
      help: false,
      dataDirectory: "/data",
      ownerUrlForm: { kind: "file", path: "/secret/owner.url" },
      publicUrl: "https://rp.example.com",
      port: 3300,
      host: "0.0.0.0",
      trustedProxy: "10.0.0.1",
      email: "owner@example.com",
      organizationSlug: "acme",
      organizationName: "Acme Ltd",
    });
    expect(parseStartArguments(["--owner-url-stdin"])).toEqual({
      help: false,
      ownerUrlForm: { kind: "stdin" },
    });
    expect(parseStartArguments([])).toEqual({ help: false });
    expect(parseStartArguments(["--help"]).help).toBe(true);
  });

  test("refuses a value-bearing --owner-url first, whatever else is wrong", () => {
    for (const argv of [
      ["--unknown", "--owner-url", `postgres://o:${SENTINEL}@h/d`],
      [`--owner-url=postgres://o:${SENTINEL}@h/d`, "--port", "0"],
    ]) {
      const error = refused(argv);
      expect(error).toBeInstanceOf(OwnerUrlError);
      expect((error as OwnerUrlError).exitCode).toBe(2);
    }
  });

  test.each([
    [
      [`postgres://o:${SENTINEL}@h/d`],
      "an argument start does not take: it takes options only.",
    ],
    [[`--${SENTINEL}`], "an option start does not take."],
    [["--email", "a@b.c", "--email=x@y.z"], "--email is given twice."],
    [["--port"], "--port takes a value."],
    [["--port", "--host", "h"], "--port takes a value."],
    [["--data-dir="], "--data-dir takes a value."],
    [["--port", "0"], "--port takes a port number, 1 to 65535."],
    [["--port", "65536"], "--port takes a port number, 1 to 65535."],
    [["--port", "80a"], "--port takes a port number, 1 to 65535."],
    [
      ["--owner-url-file", "/f", "--owner-url-stdin"],
      "--owner-url-file and --owner-url-stdin are two forms of one value: give one.",
    ],
    [
      ["--owner-url-stdin", "--owner-url-stdin"],
      "--owner-url-stdin is given twice.",
    ],
  ])("refuses %j with a usage error that repeats no value", (argv, message) => {
    const error = refused(argv);

    expect(error).toBeInstanceOf(StartUsageError);
    expect((error as StartUsageError).exitCode).toBe(2);
    expect(error.message).toBe(message);
  });

  test("the usage names the three forms of the owner URL", () => {
    expect(START_USAGE).toContain("--owner-url-file <path>");
    expect(START_USAGE).toContain("--owner-url-stdin");
    expect(START_USAGE).toContain(
      "never accepted as a value on the command line",
    );
  });
});

describe("--storage (manifest-h.md §2.6)", () => {
  test("takes pg or pglite, and refuses anything else without repeating it", () => {
    expect(parseStartArguments(["--storage", "pglite"])).toEqual({
      help: false,
      storage: "pglite",
    });
    expect(parseStartArguments(["--storage=pg"])).toEqual({
      help: false,
      storage: "pg",
    });
    const error = refused(["--storage", `sqlite${SENTINEL}`]);
    expect(error).toBeInstanceOf(StartUsageError);
    expect(error.message).toBe("--storage takes pg or pglite.");
  });

  test("the usage says what PGlite is: one user, loopback only, no row-level security, no owner URL", () => {
    expect(START_USAGE).toContain("--storage <pg|pglite>");
    expect(START_USAGE).toContain(
      "PGlite serves one user on this machine: it binds a loopback address only,\nand row-level security does not apply to it",
    );
    expect(START_USAGE).toContain(
      "PGlite takes no owner URL: its database is inside the data directory.",
    );
  });
});
