import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

import { OPERATOR_ENTRY, operatorChildCommand } from "./command.js";

/** `apps/requestport`, from this test's own place. */
const workspace = fileURLToPath(new URL("../../", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "requestport-operator-command-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the operator child's command (manifest-h.md §2.4; H.7)", () => {
  test("in the repository: node --import bin/tsx-loader.mjs src/operator/entry.ts <data directory>, and nothing else", () => {
    expect(OPERATOR_ENTRY).toBe(join(workspace, "src/operator/entry.ts"));
    expect(existsSync(OPERATOR_ENTRY)).toBe(true);

    const { command, args } = operatorChildCommand("/data/directory");

    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(4);
    const [flag, loader, entry, dataDirectory] = args as [
      string,
      string,
      string,
      string,
    ];
    expect(flag).toBe("--import");
    expect(loader).toMatch(/^file:\/\//u);
    expect(fileURLToPath(loader)).toBe(join(workspace, "bin/tsx-loader.mjs"));
    expect(existsSync(fileURLToPath(loader))).toBe(true);
    expect(entry).toBe(OPERATOR_ENTRY);
    expect(dataDirectory).toBe("/data/directory");
  });

  test("in the repository, a test's entry takes the operator entry's place, with the same loader", () => {
    const { args } = operatorChildCommand("/data/directory", "/tests/entry.ts");

    expect(args.slice(2)).toEqual(["/tests/entry.ts", "/data/directory"]);
    expect(args.slice(0, 2)).toEqual(
      operatorChildCommand("/data/directory").args.slice(0, 2),
    );
  });

  test("packed: node <dist>/operator.js <data directory>, the operator entry beside the bundled module, with no loader: the tarball carries no tsx", () => {
    expect(
      operatorChildCommand(
        "/data/directory",
        undefined,
        "file:///opt/requestport/dist/chunk-ABCDEF12.js",
      ),
    ).toEqual({
      command: process.execPath,
      args: ["/opt/requestport/dist/operator.js", "/data/directory"],
    });
  });

  test("the repository's child loads TypeScript through the loader, an enum that Node's own type stripping refuses, and receives the data directory as its one argument", () => {
    const entry = join(scratch, "entry.ts");
    writeFileSync(
      entry,
      [
        "enum Argument { First = 2 }",
        "process.stdout.write(JSON.stringify(process.argv.slice(Argument.First)));",
        "",
      ].join("\n"),
    );
    // Without a loader Node refuses this entry: an enum is TypeScript that
    // stripping types cannot run (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). So the
    // child below runs it only if bin/tsx-loader.mjs registers tsx.
    const bare = spawnSync(process.execPath, [entry, "/data/directory"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");

    const { command, args } = operatorChildCommand("/data/directory", entry);

    const run = spawnSync(command, args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(["/data/directory"]);
  });
});
