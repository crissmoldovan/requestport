import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as licenceInventory from "./licence-inventory.mjs";
import {
  CANDIDATES,
  CLOSED_REGISTRY,
  classifyLicence,
  classifyReportedLicence,
  inventory,
  main,
  pnpmLicencesArgv,
  RECOGNISED_IDENTIFIERS,
  renderSummary,
  runPnpmLicences,
  unionPnpmReports,
} from "./licence-inventory.mjs";

/*
 * Every tree here is a fixture built in a temporary directory: the live
 * workspace is never read, and nothing spawns pnpm. A pnpm report, where a
 * test needs one, is handed in as `runPnpm`, and the one test of the spawn
 * itself hands in a `spawn` that records its call.
 */
const scratch = mkdtempSync(join(tmpdir(), "licence-inventory-test-"));
after(() => rmSync(scratch, { force: true, recursive: true }));

let fixtures = 0;

function fixtureRoot() {
  fixtures += 1;
  const root = join(scratch, `tree-${fixtures}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeManifest(directory, manifest, files = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

/** pnpm's layout: `node_modules/.pnpm/<name>@<version>/node_modules/<name>`. */
function storeDirectory(root, name, version) {
  return join(
    root,
    "node_modules/.pnpm",
    `${name.replace("/", "+")}@${version}`,
    "node_modules",
    name,
  );
}

/** The `node_modules` directory a store package's own dependencies sit in. */
function storeModules(root, name, version) {
  return join(
    root,
    "node_modules/.pnpm",
    `${name.replace("/", "+")}@${version}`,
    "node_modules",
  );
}

function storePackage(root, manifest, files) {
  return writeManifest(
    storeDirectory(root, manifest.name, manifest.version),
    manifest,
    files,
  );
}

/** A symlink at `<modules>/<name>`, the way pnpm links a dependency. */
function link(modules, name, target) {
  const path = join(modules, name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(relative(dirname(path), target), path);
}

/**
 * A two-package workspace in pnpm's layout:
 *
 *   @requestport/a ─ workspace ─▶ @requestport/b ─▶ right@2.0.0 ─▶ shared@1.0.0
 *         └─▶ left@1.0.0
 *
 * `extra` adds store packages and links before the tree is used.
 */
function workspaceFixture(extra = () => {}) {
  const root = fixtureRoot();
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  # the fixture's workspaces\n  - packages/*\n",
  );
  writeManifest(root, { name: "fixture-root", private: true });
  const a = writeManifest(join(root, "packages/a"), {
    dependencies: { "@requestport/b": "workspace:*", left: "1.0.0" },
    devDependencies: { tooling: "1.0.0" },
    name: "@requestport/a",
  });
  const b = writeManifest(join(root, "packages/b"), {
    dependencies: { right: "2.0.0" },
    name: "@requestport/b",
  });
  const left = storePackage(root, {
    license: "MIT",
    name: "left",
    version: "1.0.0",
  });
  const right = storePackage(root, {
    dependencies: { shared: "^1.0.0" },
    license: "ISC",
    name: "right",
    version: "2.0.0",
  });
  const shared = storePackage(root, {
    license: "MIT",
    name: "shared",
    version: "1.0.0",
  });
  const tooling = storePackage(root, {
    license: "Apache-2.0",
    name: "tooling",
    version: "1.0.0",
  });
  link(join(a, "node_modules"), "@requestport/b", b);
  link(join(a, "node_modules"), "left", left);
  link(join(a, "node_modules"), "tooling", tooling);
  link(join(b, "node_modules"), "right", right);
  link(storeModules(root, "right", "2.0.0"), "shared", shared);
  extra(root, { a, b, left, right, shared });
  return root;
}

function onlyCandidate(result) {
  assert.equal(result.candidates.length, 1);
  return result.candidates[0];
}

describe("the classifier", () => {
  test("flags every copyleft family the audit names", () => {
    const families = {
      "AGPL-3.0-only": "AGPL",
      "CDDL-1.1": "CDDL",
      "EPL-2.0": "EPL",
      "EUPL-1.2": "EUPL",
      "GPL-2.0+": "GPL",
      "LGPL-2.1-or-later": "LGPL",
      "MPL-2.0": "MPL",
      "OSL-3.0": "OSL",
    };

    for (const [identifier, family] of Object.entries(families)) {
      const licence = classifyLicence({ license: identifier });

      assert.deepEqual(licence.flags, ["copyleft"], identifier);
      assert.deepEqual(licence.families, [family], identifier);
      assert.equal(licence.flagged, true, identifier);
      assert.equal(licence.field, identifier);
    }
  });

  test("lists an OR expression with a copyleft alternative on its own", () => {
    // Never counted as permissive: a consumer may be able to choose MIT, but
    // whether it may is for counsel, so the expression is flagged as written.
    for (const expression of ["MIT OR GPL-3.0", "(MPL-2.0 OR Apache-2.0)"]) {
      const licence = classifyLicence({ license: expression });

      assert.deepEqual(licence.flags, ["copyleft-alternative"], expression);
      assert.equal(licence.flagged, true, expression);
      assert.equal(licence.field, expression);
    }
  });

  test("counts a conjunction of recognised licences as one unflagged expression", () => {
    const licence = classifyLicence({ license: "(MIT AND Zlib)" });

    assert.deepEqual(licence.flags, []);
    assert.equal(licence.flagged, false);
    assert.equal(licence.field, "(MIT AND Zlib)");
    assert.deepEqual(licence.identifiers, ["MIT", "Zlib"]);
  });

  test("flags a copyleft identifier joined by AND as copyleft, not as an alternative", () => {
    const licence = classifyLicence({ license: "MIT AND LGPL-3.0-only" });

    assert.deepEqual(licence.flags, ["copyleft"]);
    assert.deepEqual(licence.families, ["LGPL"]);
  });

  test("flags SEE LICENSE IN and UNLICENSED as custom: a licence of the package's own", () => {
    const pointer = classifyLicence({ license: "SEE LICENSE IN LICENSE.md" });

    assert.deepEqual(pointer.flags, ["custom"]);
    assert.equal(pointer.field, "SEE LICENSE IN LICENSE.md");
    assert.match(pointer.note, /points at a file/u);

    const none = classifyLicence({ license: "UNLICENSED" });

    assert.deepEqual(none.flags, ["custom"]);
    assert.match(none.note, /grants no licence/u);
  });

  test("flags a field the SPDX grammar does not accept as unknown (ruling 105: unparseable)", () => {
    for (const words of [
      "MIT License",
      "Public Domain",
      "SIL OPEN FONT LICENSE",
    ]) {
      const licence = classifyLicence({ license: words });

      assert.deepEqual(licence.flags, ["unknown"], words);
      assert.equal(licence.field, words);
      assert.match(licence.note, /^not an SPDX expression: /u, words);
    }
  });

  test("flags a missing, empty or unreadable licence field as unknown (ruling 105)", () => {
    const cases = [
      [{}, "(no licence field)", /declares no licence/u],
      [{ license: "" }, "(an empty licence field)", /is empty/u],
      [{ license: "   " }, "(an empty licence field)", /is empty/u],
      [
        { license: 42 },
        "(a licence field it cannot read)",
        /no form it reads/u,
      ],
      [
        { license: { url: "https://example.invalid/" } },
        "license object: no type",
        /names no licence/u,
      ],
    ];

    for (const [manifest, field, note] of cases) {
      const licence = classifyLicence(manifest);

      // A legacy form stays visible as one, even when it names no licence
      // (ruling 105; G.A's check).
      assert.deepEqual(
        licence.flags,
        field.startsWith("license object")
          ? ["unknown", "legacy-field"]
          : ["unknown"],
        field,
      );
      assert.equal(licence.field, field);
      assert.equal(licence.flagged, true, field);
      assert.match(licence.note, note, field);
    }
  });

  test("reads a legacy licenses array as pnpm does, classifies it by its entries and flags it legacy-field (ruling 105)", () => {
    const one = classifyLicence({
      licenses: [{ type: "MIT", url: "https://example.invalid/MIT" }],
    });

    assert.equal(one.expression, "MIT");
    assert.equal(one.field, "licenses array: MIT");
    assert.deepEqual(one.flags, ["legacy-field"]);

    const two = classifyLicence({
      licenses: [{ type: "MIT" }, { type: "GPL-2.0" }],
    });

    assert.equal(two.expression, "(MIT OR GPL-2.0)");
    assert.deepEqual(two.flags, ["copyleft-alternative", "legacy-field"]);

    // Entry by entry: one entry in words does not hide the copyleft choice
    // beside it, as reading pnpm's `(MIT License OR GPL-2.0)` whole would.
    const words = classifyLicence({
      licenses: [{ type: "MIT License" }, { type: "GPL-2.0" }],
    });

    assert.equal(words.expression, "(MIT License OR GPL-2.0)");
    assert.deepEqual(words.flags, [
      "copyleft-alternative",
      "unknown",
      "legacy-field",
    ]);
  });

  test("flags an identifier SPDX does not list as unknown, and pnpm's Unknown", () => {
    for (const identifier of ["BSD", "GPLv2"]) {
      const licence = classifyLicence({ license: identifier });

      assert.deepEqual(licence.flags, ["unknown"], identifier);
      assert.equal(
        licence.note,
        `not an identifier SPDX lists: ${identifier}`,
        identifier,
      );
    }
    // One of a copyleft family that SPDX does not list is copyleft as well:
    // the family is plain, the licence it names is not.
    for (const identifier of ["GPL-3", "LGPL"]) {
      const licence = classifyLicence({ license: identifier });

      assert.deepEqual(licence.flags, ["copyleft", "unknown"], identifier);
      assert.match(
        licence.note,
        new RegExp(`not an identifier SPDX lists: ${identifier}$`, "u"),
      );
    }
    assert.deepEqual(classifyReportedLicence("Unknown").flags, ["unknown"]);
    assert.deepEqual(classifyReportedLicence("Apache-2.0").flags, []);
  });

  test("flags an SPDX identifier outside its permissive list as unclassified, with the identifier (ruling 105)", () => {
    const cases = [
      ["(CC-BY-4.0 AND OFL-1.1 AND MIT)", ["OFL-1.1"]],
      ["Artistic-2.0", ["Artistic-2.0"]],
      // Deprecated by SPDX, and still an identifier it lists.
      ["GFDL-1.3", ["GFDL-1.3"]],
      // SPDX identifiers match whatever their case.
      ["ofl-1.1 OR MIT", ["ofl-1.1"]],
    ];

    for (const [expression, identifiers] of cases) {
      for (const licence of [
        classifyLicence({ license: expression }),
        classifyReportedLicence(expression),
      ]) {
        assert.deepEqual(licence.flags, ["unclassified"], expression);
        assert.deepEqual(licence.unclassified, identifiers, expression);
        assert.match(licence.note, new RegExp(identifiers[0], "u"));
      }
    }
  });

  test("classifies the exception after WITH, not only the licence before it (G.A's review, finding 1)", () => {
    const cases = [
      // Exceptions SPDX does not list: the expression is not valid SPDX.
      ["MIT WITH Commons-Clause", ["unknown"]],
      ["Apache-2.0 WITH Commons-Clause-1.0", ["unknown"]],
      // An addition the package defines itself.
      ["MIT WITH LicenseRef-no-commercial-use", ["custom"]],
      ["MIT WITH AdditionRef-no-commercial-use", ["custom"]],
      ["MIT WITH DocumentRef-terms:AdditionRef-no-resale", ["custom"]],
      // An exception the classifier recognises adds no flag of its own.
      ["GPL-2.0-only WITH Classpath-exception-2.0", ["copyleft"]],
      ["GPL-3.0-or-later WITH GCC-exception-3.1", ["copyleft"]],
      ["Apache-2.0 WITH LLVM-exception", []],
      // One SPDX lists and the classifier does not recognise.
      ["MIT WITH Bison-exception-1.24", ["unclassified"]],
    ];

    for (const [expression, flags] of cases) {
      assert.deepEqual(
        classifyLicence({ license: expression }).flags,
        flags,
        expression,
      );
    }
    assert.deepEqual(
      classifyLicence({ license: "MIT WITH Bison-exception-1.24" })
        .unclassified,
      ["Bison-exception-1.24"],
    );
    assert.match(
      classifyLicence({ license: "MIT WITH Commons-Clause" }).note,
      /Commons-Clause/u,
    );
  });

  test("holds SPDX's licence and exception lists, and recognises only identifiers in them", () => {
    const licences = licenceInventory.SPDX_LICENCE_IDENTIFIERS ?? [];
    const exceptions = licenceInventory.SPDX_EXCEPTION_IDENTIFIERS ?? [];
    const upper = (list) => new Set(list.map((id) => id.toUpperCase()));

    // spdx-license-ids@3.0.24: 708 current and 26 deprecated identifiers;
    // spdx-exceptions@2.5.0: 66 current and one deprecated.
    assert.equal(licences.length, 734);
    assert.equal(upper(licences).size, 734);
    assert.equal(exceptions.length, 67);
    assert.equal(upper(exceptions).size, 67);
    for (const identifier of RECOGNISED_IDENTIFIERS) {
      assert.ok(upper(licences).has(identifier.toUpperCase()), identifier);
    }
    for (const exception of licenceInventory.RECOGNISED_EXCEPTIONS ?? [
      "(none exported)",
    ]) {
      assert.ok(upper(exceptions).has(exception.toUpperCase()), exception);
    }
    assert.ok(licences.includes("OFL-1.1"));
    assert.ok(licences.includes("GPL-2.0"));
    assert.equal(licences.includes("BSD"), false);
    assert.equal(exceptions.includes("Commons-Clause"), false);
  });
});

describe("pnpm's report", () => {
  test("asks pnpm with the registry pointed at a closed port", () => {
    assert.equal(CLOSED_REGISTRY, "http://127.0.0.1:9/");
    assert.deepEqual(
      pnpmLicencesArgv("@requestport/db", { production: true }),
      [
        "--filter",
        "@requestport/db",
        "licenses",
        "list",
        "--json",
        "--prod",
        "--config.registry=http://127.0.0.1:9/",
        "--config.update-notifier=false",
      ],
    );
    assert.equal(
      pnpmLicencesArgv("@requestport/db", { production: false }).includes(
        "--prod",
      ),
      false,
    );
  });

  test("runs pnpm with corepack's network off, and reads its empty-report sentence as no packages", () => {
    const calls = [];
    const answers = [
      { status: 0, stderr: "", stdout: "No licenses in packages found\n" },
      {
        status: 0,
        stderr: "",
        stdout: '{"MIT":[{"name":"x","versions":["1.0.0"],"paths":[]}]}',
      },
      { status: 1, stderr: "ERR_PNPM_EXAMPLE it failed", stdout: "" },
    ];
    const spawn = (command, argv, options) => {
      calls.push({
        argv,
        command,
        cwd: options.cwd,
        network: options.env.COREPACK_ENABLE_NETWORK,
      });
      return answers[calls.length - 1];
    };
    const run = (production) =>
      runPnpmLicences("/fixture", "@requestport/a", { production, spawn });

    assert.deepEqual(run(true), {});
    assert.deepEqual(run(true), {
      MIT: [{ name: "x", paths: [], versions: ["1.0.0"] }],
    });
    assert.throws(() => run(false), /exited 1: ERR_PNPM_EXAMPLE it failed/u);
    assert.deepEqual(calls[0], {
      argv: [
        "--filter",
        "@requestport/a",
        "licenses",
        "list",
        "--json",
        "--prod",
        "--config.registry=http://127.0.0.1:9/",
        "--config.update-notifier=false",
      ],
      command: "pnpm",
      cwd: "/fixture",
      network: "0",
    });
  });

  test("takes the union of the workspace packages' reports by name@version", () => {
    const union = unionPnpmReports([
      {
        project: "@requestport/a",
        report: { MIT: [{ name: "x", paths: [], versions: ["1.0.0"] }] },
      },
      {
        project: "@requestport/b",
        report: {
          ISC: [{ name: "y", paths: [], versions: ["1.0.0"] }],
          MIT: [{ name: "x", paths: [], versions: ["1.0.0", "2.0.0"] }],
        },
      },
    ]);

    assert.deepEqual(
      [...union.values()].map(({ key, licence, projects }) => [
        key,
        licence,
        projects,
      ]),
      [
        ["x@1.0.0", "MIT", ["@requestport/a", "@requestport/b"]],
        ["y@1.0.0", "ISC", ["@requestport/b"]],
        ["x@2.0.0", "MIT", ["@requestport/b"]],
      ],
    );
  });
});

describe("the consumer's walk", () => {
  test("unions the third-party closures of every workspace package a candidate reaches", () => {
    const root = workspaceFixture();
    const candidate = onlyCandidate(
      inventory(root, { packages: ["@requestport/a"], pnpm: false }),
    );

    assert.deepEqual(candidate.members, ["@requestport/a", "@requestport/b"]);
    assert.deepEqual(candidate.viewB.packages, [
      "left@1.0.0",
      "right@2.0.0",
      "shared@1.0.0",
    ]);
    assert.equal(candidate.viewB.distinct, 3);
    assert.deepEqual(candidate.viewB.byLicence, { MIT: 2, ISC: 1 });
    assert.equal(candidate.viewA, undefined);
  });

  test("checks pnpm's union against the walk when a report is handed in", () => {
    const root = workspaceFixture();
    const reports = {
      "@requestport/a": {
        MIT: [{ name: "left", paths: [], versions: ["1.0.0"] }],
      },
      "@requestport/b": {
        ISC: [{ name: "right", paths: [], versions: ["2.0.0"] }],
        MIT: [{ name: "shared", paths: [], versions: ["1.0.0"] }],
      },
    };
    const candidate = onlyCandidate(
      inventory(root, {
        packages: ["@requestport/a"],
        runPnpm: (_root, project) => reports[project],
      }),
    );

    assert.equal(candidate.viewA.distinct, 3);
    assert.deepEqual(candidate.viewA.byLicence, { MIT: 2, ISC: 1 });
    assert.deepEqual(candidate.crossCheck.reportedNotWalked, []);
    assert.deepEqual(candidate.crossCheck.consumerNotReported, []);
  });

  test("names what pnpm reports and no walk reaches, and what view (b) holds and pnpm does not report (G.A's review, finding 2)", () => {
    // pnpm's report for a names ghost@1.0.0, which nothing installs here; and
    // it leaves out left's required peer, as pnpm's report for theme leaves
    // out theme's.
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        license: "MIT",
        name: "left",
        peerDependencies: { "req-peer": "*" },
        version: "1.0.0",
      });
      const required = storePackage(tree, {
        license: "MIT",
        name: "req-peer",
        version: "1.0.0",
      });
      link(storeModules(tree, "left", "1.0.0"), "req-peer", required);
    });
    const reports = {
      "@requestport/a": {
        MIT: [
          { name: "ghost", paths: [], versions: ["1.0.0"] },
          { name: "left", paths: [], versions: ["1.0.0"] },
        ],
      },
      "@requestport/b": {
        ISC: [{ name: "right", paths: [], versions: ["2.0.0"] }],
        MIT: [{ name: "shared", paths: [], versions: ["1.0.0"] }],
      },
    };
    const result = inventory(root, {
      packages: ["@requestport/a"],
      runPnpm: (_root, project) => reports[project],
    });

    assert.deepEqual(onlyCandidate(result).crossCheck, {
      consumerNotReported: ["req-peer@1.0.0"],
      onlyThroughOptionalPeers: [],
      reportedNotConsumer: ["ghost@1.0.0"],
      reportedNotWalked: ["ghost@1.0.0"],
      walkedNotReported: ["req-peer@1.0.0"],
    });
    assert.match(
      renderSummary(result),
      /^ {2}pnpm reported, not in \(b\): 1; reached only through installed optional peers: 0; reported and not walked: 1; in \(b\) and not reported: 1$/mu,
    );
  });

  test("counts development dependencies only in the whole-workspace row that asks for them", () => {
    const root = workspaceFixture();
    const result = inventory(root, {
      definitions: [
        { id: "production", kind: "workspace" },
        { development: true, id: "everything", kind: "workspace" },
      ],
      pnpm: false,
    });
    const [production, everything] = result.candidates;
    const projects = ["@requestport/a", "@requestport/b", "fixture-root"];

    assert.deepEqual(result.workspace, projects);
    assert.deepEqual(production.members, projects);
    assert.deepEqual(production.viewB.packages, [
      "left@1.0.0",
      "right@2.0.0",
      "shared@1.0.0",
    ]);
    assert.deepEqual(everything.viewB.packages, [
      "left@1.0.0",
      "right@2.0.0",
      "shared@1.0.0",
      "tooling@1.0.0",
    ]);
  });

  test("never walks a third party's devDependencies, even in the row that counts development dependencies (G.A's review, finding 3)", () => {
    // pnpm installs no third party's development dependencies; one is linked
    // beside left here only so that a walk that followed them would find it.
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        devDependencies: { "left-dev": "1.0.0" },
        license: "MIT",
        name: "left",
        version: "1.0.0",
      });
      const leftDev = storePackage(tree, {
        license: "MIT",
        name: "left-dev",
        version: "1.0.0",
      });
      link(storeModules(tree, "left", "1.0.0"), "left-dev", leftDev);
    });
    const candidate = onlyCandidate(
      inventory(root, {
        definitions: [
          { development: true, id: "everything", kind: "workspace" },
        ],
        pnpm: false,
      }),
    );

    assert.deepEqual(candidate.viewB.packages, [
      "left@1.0.0",
      "right@2.0.0",
      "shared@1.0.0",
      "tooling@1.0.0",
    ]);
  });

  test("asks pnpm for production dependencies only, except in the row that counts development dependencies (G.A's review, finding 3)", () => {
    const root = workspaceFixture();
    const calls = [];

    inventory(root, {
      definitions: [
        { id: "production", kind: "workspace" },
        { development: true, id: "everything", kind: "workspace" },
      ],
      runPnpm: (_root, project, { production }) => {
        calls.push(`${project} production:${production}`);
        return {};
      },
    });

    assert.deepEqual(calls.sort(), [
      "@requestport/a production:false",
      "@requestport/a production:true",
      "@requestport/b production:false",
      "@requestport/b production:true",
      "fixture-root production:false",
      "fixture-root production:true",
    ]);
  });

  test("reads a name in both dependencies and optionalDependencies as optional, so its absence is not unresolved (G.A's review, finding 3)", () => {
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        dependencies: { "opt-bin": "1.0.0" },
        license: "MIT",
        name: "left",
        optionalDependencies: { "opt-bin": "1.0.0" },
        version: "1.0.0",
      });
    });
    const candidate = onlyCandidate(
      inventory(root, {
        definitions: [
          { id: "only-a", kind: "set", members: ["@requestport/a"] },
        ],
        pnpm: false,
      }),
    );

    assert.deepEqual(candidate.viewB.unresolved, []);
    assert.deepEqual(
      candidate.optionalNotInstalled.map(({ dependent, name }) => [
        dependent,
        name,
      ]),
      [["left@1.0.0", "opt-bin"]],
    );
  });

  test("lists a platform package reached only through an optional peer, as not in view (b) (G.A's review, finding 3)", () => {
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        license: "MIT",
        name: "left",
        peerDependencies: { "peer-pkg": "*" },
        peerDependenciesMeta: { "peer-pkg": { optional: true } },
        version: "1.0.0",
      });
      const peer = storePackage(tree, {
        license: "MIT",
        name: "peer-pkg",
        optionalDependencies: { "bin-darwin": "1.0.0" },
        version: "1.0.0",
      });
      const binary = storePackage(tree, {
        cpu: ["arm64"],
        license: "MIT",
        name: "bin-darwin",
        os: ["darwin"],
        version: "1.0.0",
      });
      link(storeModules(tree, "left", "1.0.0"), "peer-pkg", peer);
      link(storeModules(tree, "peer-pkg", "1.0.0"), "bin-darwin", binary);
    });
    const candidate = onlyCandidate(
      inventory(root, {
        definitions: [
          { id: "only-a", kind: "set", members: ["@requestport/a"] },
        ],
        pnpm: false,
      }),
    );

    assert.deepEqual(
      candidate.platform.map(({ inViewB, key, path }) => [key, inViewB, path]),
      [
        [
          "bin-darwin@1.0.0",
          false,
          "@requestport/a > left@1.0.0 > peer-pkg@1.0.0 (optional peer) > bin-darwin@1.0.0 (optional)",
        ],
      ],
    );
    assert.deepEqual(candidate.viewB.packages, ["left@1.0.0"]);
  });

  test("does not name as left out an optional peer that view (b) reaches as a dependency (G.A's review, finding 3)", () => {
    // left declares shared as an optional peer; b reaches shared through
    // right, a dependency, so a consumer installs it either way.
    const root = workspaceFixture((tree, { shared }) => {
      storePackage(tree, {
        license: "MIT",
        name: "left",
        peerDependencies: { shared: "^1.0.0" },
        peerDependenciesMeta: { shared: { optional: true } },
        version: "1.0.0",
      });
      link(storeModules(tree, "left", "1.0.0"), "shared", shared);
    });
    const candidate = onlyCandidate(
      inventory(root, { packages: ["@requestport/a"], pnpm: false }),
    );

    assert.ok(candidate.viewB.packages.includes("shared@1.0.0"));
    assert.deepEqual(candidate.viewB.optionalPeersExcluded, []);
  });

  test("keeps a candidate set to its members and reports the edges that leave it", () => {
    const root = workspaceFixture();
    const candidate = onlyCandidate(
      inventory(root, {
        definitions: [
          { id: "only-a", kind: "set", members: ["@requestport/a"] },
        ],
        pnpm: false,
      }),
    );

    assert.deepEqual(candidate.members, ["@requestport/a"]);
    assert.deepEqual(candidate.outside, [
      { from: "@requestport/a", to: "@requestport/b" },
    ]);
    assert.deepEqual(candidate.viewB.packages, ["left@1.0.0"]);
  });

  test("leaves out the optional peers it finds installed, and names them", () => {
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        license: "MIT",
        name: "left",
        peerDependencies: { "opt-peer": "*", "req-peer": "*" },
        peerDependenciesMeta: { "opt-peer": { optional: true } },
        version: "1.0.0",
      });
      const required = storePackage(tree, {
        license: "MIT",
        name: "req-peer",
        version: "1.0.0",
      });
      const optional = storePackage(tree, {
        dependencies: { "behind-opt": "1.0.0" },
        license: "MPL-2.0",
        name: "opt-peer",
        version: "1.0.0",
      });
      const behind = storePackage(tree, {
        license: "MIT",
        name: "behind-opt",
        version: "1.0.0",
      });
      link(storeModules(tree, "left", "1.0.0"), "req-peer", required);
      link(storeModules(tree, "left", "1.0.0"), "opt-peer", optional);
      link(storeModules(tree, "opt-peer", "1.0.0"), "behind-opt", behind);
    });
    const reports = {
      "@requestport/a": {
        MIT: [
          { name: "left", paths: [], versions: ["1.0.0"] },
          { name: "req-peer", paths: [], versions: ["1.0.0"] },
          { name: "behind-opt", paths: [], versions: ["1.0.0"] },
        ],
        "MPL-2.0": [{ name: "opt-peer", paths: [], versions: ["1.0.0"] }],
      },
      "@requestport/b": {},
    };
    const candidate = onlyCandidate(
      inventory(root, {
        definitions: [
          { id: "only-a", kind: "set", members: ["@requestport/a"] },
        ],
        runPnpm: (_root, project) => reports[project],
      }),
    );

    assert.deepEqual(candidate.viewB.packages, [
      "left@1.0.0",
      "req-peer@1.0.0",
    ]);
    assert.deepEqual(candidate.viewB.optionalPeersExcluded, [
      "left@1.0.0 > opt-peer@1.0.0 (optional peer)",
    ]);
    assert.deepEqual(candidate.viewB.flagged, []);
    assert.deepEqual(
      candidate.viewA.flagged.map(({ key }) => key),
      ["opt-peer@1.0.0"],
    );
    assert.deepEqual(candidate.crossCheck.onlyThroughOptionalPeers, [
      "behind-opt@1.0.0",
      "opt-peer@1.0.0",
    ]);
    assert.deepEqual(candidate.crossCheck.reportedNotWalked, []);
  });

  test("reads an optional peer declared only in peerDependenciesMeta, as pnpm resolves it", () => {
    // `debug` 4.3.7 and 4.4.3 declare `supports-color` this way and nowhere
    // else, and pnpm links it beside them as a peer; a walk that read
    // `peerDependencies` alone would not see it.
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        license: "MIT",
        name: "left",
        peerDependenciesMeta: { "meta-only": { optional: true } },
        version: "1.0.0",
      });
      const metaOnly = storePackage(tree, {
        license: "MIT",
        name: "meta-only",
        version: "10.0.0",
      });
      link(storeModules(tree, "left", "1.0.0"), "meta-only", metaOnly);
    });
    const candidate = onlyCandidate(
      inventory(root, {
        definitions: [
          { id: "only-a", kind: "set", members: ["@requestport/a"] },
        ],
        pnpm: false,
      }),
    );

    assert.deepEqual(candidate.viewB.optionalPeersExcluded, [
      "left@1.0.0 > meta-only@10.0.0 (optional peer)",
    ]);
  });

  test("reports a flagged package with the workspace packages that pull it in and a path", () => {
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        dependencies: { "gpl-dep": "3.0.0" },
        license: "MIT",
        name: "shared",
        version: "1.0.0",
      });
      const gpl = storePackage(
        tree,
        { license: "GPL-3.0-only", name: "gpl-dep", version: "3.0.0" },
        { COPYING: "\n                    GNU GENERAL PUBLIC LICENSE\n" },
      );
      link(storeModules(tree, "shared", "1.0.0"), "gpl-dep", gpl);
    });
    const candidate = onlyCandidate(
      inventory(root, { packages: ["@requestport/a"], pnpm: false }),
    );

    assert.deepEqual(candidate.viewB.flagged, [
      {
        field: "GPL-3.0-only",
        flags: ["copyleft"],
        key: "gpl-dep@3.0.0",
        licenceFiles: [
          { file: "COPYING", firstLine: "GNU GENERAL PUBLIC LICENSE" },
        ],
        location: "node_modules/.pnpm/gpl-dep@3.0.0/node_modules/gpl-dep",
        note: undefined,
        path: "@requestport/b > right@2.0.0 > shared@1.0.0 > gpl-dep@3.0.0",
        pulledInBy: ["@requestport/b"],
      },
    ]);
  });

  test("shows view (b)'s path for a package view (b) holds, though an optional peer reaches it sooner", () => {
    // a > left ~> peer-pkg (an optional peer) > bin-darwin, and
    // b > right > shared > bin-darwin: the walk that follows optional peers
    // starts at a and reaches bin-darwin first, but a consumer installs it
    // through b, so b's route is the one to show.
    const root = workspaceFixture((tree) => {
      storePackage(tree, {
        license: "MIT",
        name: "left",
        peerDependencies: { "peer-pkg": "*" },
        peerDependenciesMeta: { "peer-pkg": { optional: true } },
        version: "1.0.0",
      });
      const peer = storePackage(tree, {
        license: "MIT",
        name: "peer-pkg",
        optionalDependencies: { "bin-darwin": "1.0.0" },
        version: "1.0.0",
      });
      const binary = storePackage(tree, {
        cpu: ["arm64"],
        license: "MPL-2.0",
        name: "bin-darwin",
        os: ["darwin"],
        version: "1.0.0",
      });
      storePackage(tree, {
        license: "MIT",
        name: "shared",
        optionalDependencies: { "bin-darwin": "1.0.0" },
        version: "1.0.0",
      });
      link(storeModules(tree, "left", "1.0.0"), "peer-pkg", peer);
      link(storeModules(tree, "peer-pkg", "1.0.0"), "bin-darwin", binary);
      link(storeModules(tree, "shared", "1.0.0"), "bin-darwin", binary);
    });
    const reports = {
      "@requestport/a": {
        MIT: [
          { name: "left", paths: [], versions: ["1.0.0"] },
          { name: "peer-pkg", paths: [], versions: ["1.0.0"] },
        ],
        "MPL-2.0": [{ name: "bin-darwin", paths: [], versions: ["1.0.0"] }],
      },
      "@requestport/b": {
        ISC: [{ name: "right", paths: [], versions: ["2.0.0"] }],
        MIT: [{ name: "shared", paths: [], versions: ["1.0.0"] }],
        "MPL-2.0": [{ name: "bin-darwin", paths: [], versions: ["1.0.0"] }],
      },
    };
    const candidate = onlyCandidate(
      inventory(root, {
        packages: ["@requestport/a"],
        runPnpm: (_root, project) => reports[project],
      }),
    );
    const consumerPath =
      "@requestport/b > right@2.0.0 > shared@1.0.0 > bin-darwin@1.0.0 (optional)";

    assert.deepEqual(
      candidate.viewB.flagged.map(({ key, path }) => [key, path]),
      [["bin-darwin@1.0.0", consumerPath]],
    );
    assert.deepEqual(
      candidate.viewA.flagged.map(({ key, path }) => [key, path]),
      [["bin-darwin@1.0.0", consumerPath]],
    );
    assert.deepEqual(
      candidate.platform.map(({ inViewB, key, path }) => [key, inViewB, path]),
      [["bin-darwin@1.0.0", true, consumerPath]],
    );
  });

  test("names the linux-x64 counterparts, gnu and musl, of optional binaries this tree skipped", () => {
    const root = workspaceFixture((tree, { a }) => {
      const binary = storePackage(tree, {
        license: "MIT",
        name: "binpkg",
        optionalDependencies: {
          "binpkg-darwin-arm64": "1.0.0",
          "binpkg-linux-arm64-gnu": "1.0.0",
          "binpkg-linux-x64-gnu": "1.0.0",
          "binpkg-linux-x64-musl": "1.0.0",
        },
        version: "1.0.0",
      });
      const darwin = storePackage(tree, {
        cpu: ["arm64"],
        license: "MPL-2.0",
        name: "binpkg-darwin-arm64",
        os: ["darwin"],
        version: "1.0.0",
      });
      writeManifest(a, {
        dependencies: { binpkg: "1.0.0" },
        name: "@requestport/a",
      });
      link(join(a, "node_modules"), "binpkg", binary);
      link(
        storeModules(tree, "binpkg", "1.0.0"),
        "binpkg-darwin-arm64",
        darwin,
      );
    });
    const candidate = onlyCandidate(
      inventory(root, {
        definitions: [
          { id: "only-a", kind: "set", members: ["@requestport/a"] },
        ],
        pnpm: false,
      }),
    );

    assert.deepEqual(
      candidate.platform.map(({ cpu, inViewB, key, os }) => ({
        cpu,
        inViewB,
        key,
        os,
      })),
      [
        {
          cpu: ["arm64"],
          inViewB: true,
          key: "binpkg-darwin-arm64@1.0.0",
          os: ["darwin"],
        },
      ],
    );
    assert.deepEqual(
      candidate.linuxX64.map(({ dependent, name, range }) => [
        dependent,
        name,
        range,
      ]),
      [
        ["binpkg@1.0.0", "binpkg-linux-x64-gnu", "1.0.0"],
        ["binpkg@1.0.0", "binpkg-linux-x64-musl", "1.0.0"],
      ],
    );
  });

  test("walks a plain installed tree with no pnpm workspace, as a tarball consumer holds it", () => {
    const root = fixtureRoot();
    writeManifest(root, {
      dependencies: { "@requestport/core": "1.0.0" },
      name: "consumer",
    });
    writeManifest(join(root, "node_modules/@requestport/core"), {
      dependencies: { "@requestport/db": "1.0.0", lib: "^1.0.0" },
      name: "@requestport/core",
      version: "1.0.0",
    });
    writeManifest(join(root, "node_modules/@requestport/db"), {
      dependencies: { "pg-like": "1.0.0" },
      name: "@requestport/db",
      version: "1.0.0",
    });
    writeManifest(join(root, "node_modules/lib"), {
      license: "MIT",
      name: "lib",
      version: "1.2.0",
    });
    writeManifest(join(root, "node_modules/pg-like"), {
      dependencies: { nested: "2.0.0" },
      license: "MIT",
      name: "pg-like",
      version: "1.0.0",
    });
    writeManifest(join(root, "node_modules/pg-like/node_modules/nested"), {
      license: "ISC",
      name: "nested",
      version: "2.0.0",
    });
    const result = inventory(root, { packages: ["@requestport/core"] });
    const candidate = onlyCandidate(result);

    assert.equal(result.workspace, undefined);
    assert.equal(candidate.viewA, undefined);
    assert.deepEqual(candidate.members, [
      "@requestport/core",
      "@requestport/db",
    ]);
    assert.deepEqual(candidate.viewB.packages, [
      "lib@1.2.0",
      "nested@2.0.0",
      "pg-like@1.0.0",
    ]);
  });

  test("reads a root whose pnpm-workspace.yaml has no packages: list as a plain installed tree, as G.8's tarball consumer holds its overrides there (ruling 153)", () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'overrides:\n  "@requestport/core": "file:/planted/requestport-core-1.0.0.tgz"\n',
    );
    writeManifest(root, {
      dependencies: { "@requestport/core": "1.0.0" },
      name: "consumer",
    });
    writeManifest(join(root, "node_modules/@requestport/core"), {
      dependencies: { lib: "^1.0.0" },
      name: "@requestport/core",
      version: "1.0.0",
    });
    writeManifest(join(root, "node_modules/lib"), {
      license: "MIT",
      name: "lib",
      version: "1.2.0",
    });
    const result = inventory(root, {
      packages: ["@requestport/core"],
      runPnpm: () => {
        throw new Error("a plain tree has no pnpm report");
      },
    });
    const candidate = onlyCandidate(result);

    assert.equal(result.workspace, undefined);
    assert.equal(candidate.viewA, undefined);
    assert.deepEqual(candidate.missingMembers, []);
    assert.deepEqual(candidate.members, ["@requestport/core"]);
    assert.deepEqual(candidate.viewB.packages, ["lib@1.2.0"]);

    // G.8's command line (ruling 139: core's closure only).
    const written = [];
    const status = main(
      [
        "--root",
        root,
        "--package",
        "@requestport/core",
        "--no-pnpm",
        "--json",
        "-",
      ],
      {
        stderr: { write: (text) => written.push(text) },
        stdout: { write: (text) => written.push(text) },
      },
    );

    assert.equal(status, 0, written.join(""));
    assert.deepEqual(
      JSON.parse(written.join("")).candidates[0].viewB.packages,
      ["lib@1.2.0"],
    );
  });

  test("never resolves a package above the root it was given", () => {
    // A worktree sits inside the main checkout, and Node's lookup climbs every
    // ancestor directory: a walk not bounded at its root could resolve a
    // dependency from a node_modules above it, and report a package this tree
    // does not hold.
    const outer = fixtureRoot();
    writeManifest(join(outer, "node_modules/escaped"), {
      license: "GPL-3.0-only",
      name: "escaped",
      version: "1.0.0",
    });
    const root = join(outer, "inner");
    writeManifest(root, { dependencies: { escaped: "1.0.0" }, name: "inner" });
    const candidate = onlyCandidate(inventory(root, {}));

    assert.deepEqual(candidate.viewB.packages, []);
    assert.deepEqual(
      candidate.viewB.unresolved.map(({ kind, name }) => [kind, name]),
      [["dependency", "escaped"]],
    );
  });
});

describe("the candidates", () => {
  test("defines the candidate sets of manifest-g.md §0.3 by their workspace packages", () => {
    const members = (id) =>
      CANDIDATES.find((candidate) => candidate.id === id)?.members;
    const six = [
      "@requestport/db",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/jobs",
      "@requestport/notifications",
      "@requestport/webhooks",
    ];

    assert.deepEqual(members("S8"), ["@requestport/config", ...six]);
    for (const id of ["S8-prime", "S7", "S1"]) {
      assert.deepEqual(members(id), six, id);
    }
    // The candidate's members are the three packages §3.1 says core imports.
    // Their closure holds every workspace and the one third-party package
    // packages/core declares (CORE_NOTE).
    assert.deepEqual(members("core"), [
      "@requestport/db",
      "@requestport/domain",
      "@requestport/jobs",
    ]);
  });

  test("covers every candidate package §3.1 names", () => {
    const packages = CANDIDATES.filter(({ kind }) => kind === "package").map(
      ({ id }) => id,
    );

    for (const id of [
      "auth",
      "client",
      "config",
      "core",
      "db",
      "domain",
      "importer",
      "jobs",
      "mcp",
      "notifications",
      "theme",
      "web",
      "webhooks",
    ]) {
      assert.ok(packages.includes(id), id);
    }
  });
});

describe("the command", () => {
  function consumerFixture() {
    const root = fixtureRoot();
    writeManifest(root, { dependencies: { lib: "1.0.0" }, name: "consumer" });
    writeManifest(join(root, "node_modules/lib"), {
      license: "MIT",
      name: "lib",
      version: "1.0.0",
    });
    return root;
  }

  function collector() {
    const written = [];
    return {
      text: () => written.join(""),
      write: (text) => written.push(text),
    };
  }

  test("writes the JSON document where --json says, and prints a short summary", () => {
    const root = consumerFixture();
    const output = join(scratch, `inventory-${fixtures}.json`);
    const stdout = collector();

    assert.equal(main(["--root", root, "--json", output], { stdout }), 0);
    assert.deepEqual(
      JSON.parse(readFileSync(output, "utf8")).candidates.map(
        ({ members, viewB }) => [members, viewB.packages],
      ),
      [[["consumer"], ["lib@1.0.0"]]],
    );
    assert.match(
      stdout.text(),
      /^ {2}\(b\) consumer: 1 distinct, 1 name@version; flagged 0$/mu,
    );
  });

  test("prints only the JSON document when --json is -", () => {
    const stdout = collector();

    assert.equal(
      main(["--root", consumerFixture(), "--json", "-"], { stdout }),
      0,
    );
    assert.deepEqual(JSON.parse(stdout.text()).candidates[0].viewB.packages, [
      "lib@1.0.0",
    ]);
  });

  test("prints view (b)'s entry for a package both views flag", () => {
    const flagged = (path) => ({
      field: "MPL-2.0",
      flags: ["copyleft"],
      key: "x@1.0.0",
      licenceFiles: [],
      location: undefined,
      note: undefined,
      path,
      pulledInBy: ["@requestport/a"],
    });
    const view = (path) => ({
      byLicence: { "MPL-2.0": 1 },
      distinct: 1,
      flagged: [flagged(path)],
      nameVersions: 1,
      optionalPeersExcluded: [],
      packages: ["x@1.0.0"],
      unresolved: [],
    });
    const summary = renderSummary({
      candidates: [
        {
          label: "a",
          linuxX64: [],
          members: ["@requestport/a"],
          outside: [],
          platform: [],
          viewA: view("@requestport/a > p@1.0.0 (optional peer) > x@1.0.0"),
          viewB: view("@requestport/a > x@1.0.0"),
        },
      ],
      linuxX64: [],
      pnpm: "view (a)",
      root: "/fixture",
    });

    assert.match(
      summary,
      /^ {2}flagged in \(a\) \(b\): x@1\.0\.0 \[copyleft\] MPL-2\.0\n {6}@requestport\/a > x@1\.0\.0$/mu,
    );
  });

  test("prints an unclassified identifier beside its flag, and keeps it in the JSON (ruling 105)", () => {
    const root = fixtureRoot();
    writeManifest(root, { dependencies: { icons: "7.0.0" }, name: "consumer" });
    writeManifest(join(root, "node_modules/icons"), {
      license: "(CC-BY-4.0 AND OFL-1.1 AND MIT)",
      name: "icons",
      version: "7.0.0",
    });
    const output = join(scratch, `inventory-${fixtures}-unclassified.json`);
    const stdout = collector();

    assert.equal(main(["--root", root, "--json", output], { stdout }), 0);
    assert.match(
      stdout.text(),
      /^ {2}flagged in \(b\): icons@7\.0\.0 \[unclassified \(OFL-1\.1\)\] \(CC-BY-4\.0 AND OFL-1\.1 AND MIT\)$/mu,
    );
    const [flagged] = JSON.parse(readFileSync(output, "utf8")).candidates[0]
      .viewB.flagged;

    assert.deepEqual(flagged.flags, ["unclassified"]);
    assert.deepEqual(flagged.unclassified, ["OFL-1.1"]);
  });

  test("prints a member it cannot find, and exits 1 (G.A's review, finding 5)", () => {
    const stdout = collector();
    const stderr = collector();

    assert.equal(
      main(["--root", consumerFixture(), "--package", "@requestport/coer"], {
        stderr,
        stdout,
      }),
      1,
    );
    assert.match(
      stdout.text(),
      /^ {2}not found in this tree: @requestport\/coer$/mu,
    );
    assert.match(stderr.text(), /not found .*@requestport\/coer/u);
  });

  test("exits 3, not 1, when the run fails with an error, and prints it (G.A's check)", () => {
    // 1 says a member was not found; a crash must not read as that.
    const root = fixtureRoot();
    writeFileSync(join(root, "package.json"), "{ not json");
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./licence-inventory.mjs", import.meta.url)),
        "--root",
        root,
        "--no-pnpm",
      ],
      { encoding: "utf8" },
    );

    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /^licence-inventory: /mu);
  });

  test("refuses a --candidate it does not define, and exits 2 (G.A's review, finding 5)", () => {
    const stdout = collector();
    const stderr = collector();

    assert.equal(
      main(["--root", workspaceFixture(), "--candidate", "S9", "--no-pnpm"], {
        stderr,
        stdout,
      }),
      2,
    );
    assert.equal(stdout.text(), "");
    assert.match(stderr.text(), /no built-in candidate is named S9/u);
  });

  test("refuses a --candidate the run would not audit, and exits 2", () => {
    // --package replaces the built-in candidates, and the script reads them
    // only in a pnpm workspace.
    const runs = [
      [
        "--root",
        workspaceFixture(),
        "--candidate",
        "core",
        "--package",
        "@requestport/a",
        "--no-pnpm",
      ],
      ["--root", consumerFixture(), "--candidate", "core"],
    ];

    for (const argv of runs) {
      const stdout = collector();
      const stderr = collector();

      assert.equal(main(argv, { stderr, stdout }), 2, argv.join(" "));
      assert.equal(stdout.text(), "");
      assert.match(stderr.text(), /^--candidate core: /u);
    }
  });

  test("refuses a --candidate over a root whose pnpm-workspace.yaml has no packages: list, which it reads as a plain tree, and exits 2", () => {
    // Read as a plain tree, the root has no built-in candidate to audit; the
    // run must not fall back to the root's own closure under that name.
    const root = consumerFixture();
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'overrides:\n  lib: "1.0.0"\n',
    );
    const stdout = collector();
    const stderr = collector();

    assert.equal(
      main(["--root", root, "--candidate", "core", "--no-pnpm"], {
        stderr,
        stdout,
      }),
      2,
    );
    assert.equal(stdout.text(), "");
    assert.match(stderr.text(), /^--candidate core: .*packages: list/u);
  });
});
