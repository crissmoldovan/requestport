import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { instanceLoginNames } from "@requestport/db/wiring";
import { afterAll, describe, expect, test } from "vitest";

import { ConfigurationError } from "./configuration.js";
import {
  INIT_FILE,
  newInstanceId,
  parseInstanceMarker,
  readInstanceMarker,
  writeInstanceMarker,
} from "./instance-marker.js";

const scratch = mkdtempSync(join(tmpdir(), "requestport-marker-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("init.json, the instance marker (manifest-h.md §2.3.1)", () => {
  test("an instance id is one @requestport/db names the instance's logins with", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newInstanceId()));

    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{16}$/u);
      expect(() => instanceLoginNames(id)).not.toThrow();
    }
  });

  test("is written mode 0600 holding the instance id alone, then the bootstrap's details and completion", () => {
    const directory = mkdtempSync(join(scratch, "data-"));
    expect(readInstanceMarker(directory)).toBeUndefined();

    const first = writeInstanceMarker(directory, {
      version: 1,
      instanceId: "0123456789abcdef",
    });
    expect(statSync(join(directory, INIT_FILE)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(join(directory, INIT_FILE), "utf8")),
    ).toEqual({ version: 1, instanceId: "0123456789abcdef" });

    const bootstrap = {
      email: "owner@example.com",
      organizationSlug: "acme",
      organizationName: "Acme",
    };
    writeInstanceMarker(directory, { ...first, bootstrap, complete: true });
    expect(readInstanceMarker(directory)).toEqual({
      version: 1,
      instanceId: "0123456789abcdef",
      bootstrap,
      complete: true,
    });
  });

  test.each([
    [
      { version: 1, instanceId: "SHORT" },
      /instanceId must be 16 of 0-9 and a-f/u,
    ],
    [{ version: 2, instanceId: "0123456789abcdef" }, /version/u],
    [
      { version: 1, instanceId: "0123456789abcdef", complete: false },
      /complete/u,
    ],
    [
      { version: 1, instanceId: "0123456789abcdef", ownerUrl: "x" },
      /Unrecognized key/u,
    ],
  ])("refuses %j", (value, why) => {
    expect(() => parseInstanceMarker(value)).toThrow(ConfigurationError);
    expect(() => parseInstanceMarker(value)).toThrow(why);
  });

  test("refuses a file that is not JSON", () => {
    const directory = mkdtempSync(join(scratch, "data-"));
    writeFileSync(join(directory, INIT_FILE), "{");

    expect(() => readInstanceMarker(directory)).toThrow(/is not valid JSON/u);
  });
});
