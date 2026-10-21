import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, test } from "node:test";

import { PACKAGES, packedManifest, repositoryRoot } from "./pack-packages.mjs";

/*
 * The package contract (Plan 13, manifest-g.md §3.7; G). It holds the licence
 * mapping in `scripts/pack-packages.mjs` against the texts in the tree, and
 * the package set against the packages that script packs, and packs
 * nothing: each tarball's `LICENSE` and `license` field are read back in
 * `pack-packages.test.mjs` (Done when 9).
 *
 * The owner answered D3 (ruling 175): Apache-2.0 on everything, and the
 * package set S8. The owner's answer to H question 8, the manifest's
 * alternative, has `requestport` depend on `@requestport/auth`, `mcp` and
 * `server` as published packages, which ruling 190 has the same script
 * build, pack and check. The set and the licence below are those answers.
 */

/**
 * The packages the pack script packs, eleven: D3's set, S8 (ruling 175),
 * then `auth`, `mcp` and `server` (ruling 190). None is test-only.
 */
const PACKAGE_SET = [
  "@requestport/domain",
  "@requestport/notifications",
  "@requestport/webhooks",
  "@requestport/importer",
  "@requestport/config",
  "@requestport/db",
  "@requestport/jobs",
  "@requestport/core",
  "@requestport/auth",
  "@requestport/mcp",
  "@requestport/server",
];

/**
 * The sha256 of each licence's text as its steward publishes it, by the SPDX
 * expression of the `license` field it goes with. Apache-2.0's is
 * https://www.apache.org/licenses/LICENSE-2.0.txt, 11,358 bytes, fetched on
 * 2026-10-06.
 */
const PUBLISHED_TEXT_SHA256 = {
  "Apache-2.0":
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
};

/**
 * Where the licence texts are kept, to be copied into each staged directory:
 * a `LICENSE` at the repository's root is the owner's (ruling 150).
 */
const TEXTS = "licenses";

function readJson(path) {
  return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
}

/** Each package the pack script packs, by the name its source manifest gives. */
function packs() {
  return Object.values(PACKAGES).map((pack) => ({
    name: readJson(`${pack.source}/package.json`).name,
    pack,
  }));
}

function sha256(path) {
  return createHash("sha256")
    .update(readFileSync(join(repositoryRoot, path)))
    .digest("hex");
}

describe("the licence mapping (manifest-g.md §3.7)", () => {
  test("every package of the set, S8's eight and auth, mcp and server, is packed, nothing else is, and every package the pack script packs has a mapping entry: the SPDX expression of its license field, and a text under licenses/ that exists", () => {
    const names = packs().map(({ name }) => name);
    assert.deepEqual(
      PACKAGE_SET.filter((name) => !names.includes(name)),
      [],
    );
    assert.deepEqual(
      names.filter((name) => !PACKAGE_SET.includes(name)),
      [],
    );
    for (const { name, pack } of packs()) {
      assert.equal(typeof pack.license, "string", name);
      assert.ok(
        Object.hasOwn(PUBLISHED_TEXT_SHA256, pack.license),
        `${name}: ${pack.license} has no published text recorded here`,
      );
      assert.equal(typeof pack.licenseText, "string", name);
      assert.ok(
        !isAbsolute(pack.licenseText) &&
          !pack.licenseText.split("/").includes("..") &&
          pack.licenseText.startsWith(`${TEXTS}/`),
        `${name}: ${pack.licenseText} is not a path under ${TEXTS}/`,
      );
      assert.ok(
        existsSync(join(repositoryRoot, pack.licenseText)) &&
          statSync(join(repositoryRoot, pack.licenseText)).isFile(),
        `${name}: ${pack.licenseText} is not a file`,
      );
    }
  });

  test("each text is its licence's, verbatim: its sha256 is that of the text the licence's steward publishes", () => {
    for (const { name, pack } of packs()) {
      assert.equal(
        sha256(pack.licenseText),
        PUBLISHED_TEXT_SHA256[pack.license],
        `${name}: ${pack.licenseText}`,
      );
    }
  });

  test("the license field each packed manifest is written with equals the mapping, and no source manifest of a packed package declares another", () => {
    for (const { name, pack } of packs()) {
      const written = packedManifest(pack, {
        version: "0.0.0",
        dependencies: {},
        peerDependencies: {},
      });
      assert.equal(written.license, pack.license, name);
      const declared = readJson(`${pack.source}/package.json`).license;
      assert.ok(
        declared === undefined || declared === pack.license,
        `${name}: its source manifest declares ${declared}`,
      );
    }
  });

  test("one text per licence, and no package carries another licence's text: Apache-2.0 alone, with every file under licenses/ one package's text", () => {
    const textsOf = new Map();
    const licencesOf = new Map();
    for (const { pack } of packs()) {
      textsOf.set(
        pack.license,
        new Set([...(textsOf.get(pack.license) ?? []), pack.licenseText]),
      );
      licencesOf.set(
        pack.licenseText,
        new Set([...(licencesOf.get(pack.licenseText) ?? []), pack.license]),
      );
    }

    assert.deepEqual([...textsOf.keys()].sort(), ["Apache-2.0"]);
    for (const [licence, texts] of textsOf) {
      assert.equal(texts.size, 1, `${licence}: ${[...texts]}`);
    }
    for (const [text, licences] of licencesOf) {
      assert.equal(licences.size, 1, `${text}: ${[...licences]}`);
    }
    assert.deepEqual(
      readdirSync(join(repositoryRoot, TEXTS))
        .map((file) => `${TEXTS}/${file}`)
        .sort(),
      [...licencesOf.keys()].sort(),
    );
  });
});
