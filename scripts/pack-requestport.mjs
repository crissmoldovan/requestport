#!/usr/bin/env node
/*
  Packs RequestPort's fourteen packages into tarballs outside the
  repository, in one run, and checks each, and the fourteen together (Plan
  13, H.7; manifest-h.md §2.7.3 and §2.8.5; owner question 8's second
  branch, which rulings 190 and 193 choose): G.7's eleven, with G.7's own
  machinery; `@requestport/web`; `@requestport/client`; and `requestport`,
  which depends on the other thirteen at the version the run stamps. The
  tarballs are built and checked here. Nothing here sends them anywhere.
  Each packed manifest says `"private": false` while every source manifest
  stays private (J question 14's option (B), rulings 175 and 207), and
  publishing is the owner's. Nothing here writes into the repository but the
  self-host build, which `buildWeb` makes in `apps/web/.next-self-host` as
  H.5's integration tests do (H.5's `buildSelfHostWeb` puts
  `apps/web/next-env.d.ts` back as it was).

  Usage: node scripts/pack-requestport.mjs --version <version> [--out <directory>]

  It packs G.7's eleven with `scripts/pack-packages.mjs`'s `PACKAGES`,
  `stagePackage` and `checkTarball`, and imports that script's other
  helpers; `privateModuleProblems` it exports for this script too. The
  helpers that raise a refusal under G's name (`refuseVersion`,
  `refuseInsideRepository`, `refuseDirtyTree`, `refuseChangedTree` and
  `stagePackage`) are wrapped so that it names this script.

  `main`, the command:

  1. refuses a version G.7 would not stamp, then a dirty tree (`git status
     --porcelain` must print nothing), then an `--out` inside the repository
     or not empty, before it builds anything. Without `--out` it packs into
     a new directory under the temporary directory;
  2. stages `requestport` in `<out>/stage/requestport` (`stageRequestport`),
     so that its refusals come before any other build;
  3. for each of G.7's `PACKAGES`, in its order (the S8 set, then `auth`,
     `mcp` and `server`), stages it in `<out>/stage/<key>` with G.7's
     `stagePackage`, packs it with G.7's `packStaged` (`pnpm pack`) into
     `<out>`, reads the tarball back with G.7's `readTarball`, and refuses
     it on any problem G.7's `checkTarball` finds;
  4. stages `@requestport/web` in `<out>/stage/web` (`stageWeb`), which makes
     the self-host build, packs it into `<out>`, reads it back, and refuses
     it on any problem `checkWebTarball` finds;
  5. stages `@requestport/client` in `<out>/stage/client` (`stageClient`),
     packs it into `<out>`, reads it back, and refuses it on any problem
     `checkClientTarball` finds;
  6. packs `requestport` into `<out>`, reads it back, and refuses it on any
     problem `checkRequestportTarball` finds;
  7. refuses the run on any problem G.7's `checkRun` finds in the fourteen
     tarballs read together (an `@requestport/*` package a manifest depends
     on that the run packs after it or not at all, an `@requestport/*`
     specifier a tarball's JavaScript or declarations import that names no
     package of the run or a subpath its manifest does not export, and a
     tarball whose JavaScript binds one of esbuild's runtime helpers as
     `var __<name> = ` at the start of a line while its
     `THIRD-PARTY-NOTICES` has no entry for esbuild), or that
     `runConfinementProblems` finds in their JavaScript (`jobs`' index or
     its worker root reachable from `requestport`'s entries but through the
     `worker` command);
  8. refuses a tree whose status changed while it built and packed, and
     writes `<out>/build-record.json`, G.7's build record: the commit, the
     tree's status, the Node and pnpm versions, and each tarball's name,
     version, sha512 integrity, size and file count, in the order packed.

  The order: G.7's eleven, `@requestport/web`, `@requestport/client`, then
  `requestport`, which depends on all thirteen: `checkRun` refuses
  `requestport` packed before any of them.

  **H's licence mapping entries** are `REQUESTPORT`'s, `WEB`'s and
  `CLIENT`'s `license` and `licenseText`: Apache-2.0 and
  `licenses/Apache-2.0.txt`, D3's answer (ruling 175), as G.7's mapping is.
  They are kept here, not in G.7's `PACKAGES`, which is also the list G.7's
  command packs.

  `stageClient({ version, directory })`, for a directory outside the
  repository that is empty or absent:

  1. reads `packages/client`'s exports, each of which must be a module
     directly in `src/`, and emits them with the repository's `tsc -p
     packages/client/tsconfig.build.json` into `<directory>/dist`, refusing
     any output from `tsc`;
  2. refuses the emit when it holds a file that is neither an export's
     module nor one of `CLIENT.internal`'s (`lock`, which `token-source.ts`
     and `credentials.ts` import and no subpath exports), or lacks one of
     theirs, each as `.js` and `.d.ts`;
  3. refuses a package the emit imports by a bare specifier, in its
     JavaScript or its declarations, that `packages/client` does not declare
     in `dependencies`, or declares as a workspace package;
  4. copies the licence text as `LICENSE` and writes the packed manifest by
     G.7's `packedManifest` (manifest-h.md §2.8.5; ruling 100): the source's
     name, the stamped version, `private: false`, `type`, the mapping's
     `license`, the public repository with `packages/client` as `directory`,
     `exports` as `{ types, import }` on `dist/` for each export, `files`
     `LICENSE` and `dist`, `engines` as the repository's root declares, the
     dependencies of step 3, and empty peer fields. The source manifest is
     not edited.

  `checkClientTarball(entries, staged)` is two checks, every problem of
  each reported:
  - G.7's `checkTarball`, the check G's own tarballs pass (its step 7): among
    its refusals, a file off the exact allow-list or missing from it,
    `LICENSE` other than the mapping's text, a `license` field other than
    the mapping's, a written field changed, a test, `.env*` file, source map
    or test support, this machine's paths in every form `pathForms` lists,
    in every file (`machinePathProblems`, as `requestport`'s check reads
    them; ruling 197 item 3), a `workspace:` specifier in any file,
    `scripts` or `bin`, an `@requestport/*`, Better Auth or Trigger.dev
    dependency, and `exports` other than the entries or with a target the
    tarball does not hold;
  - Done when 12c by name: every export's `.js` and `.d.ts`, and no test,
    nothing under `src/`, no `onboard-live`, no `.env*` and no `workspace:`
    in any file.

  `stageRequestport({ version, directory })`, for a directory outside the
  repository that is empty or absent: `stageBundle`, then the dependency
  list (`requestportDependencies`), refused on any problem; then the
  licence text as `LICENSE`, `apps/requestport/README.md` as `README.md`,
  and the packed manifest (`requestportManifest`): the published name
  `requestport`, written by the pack while the workspace keeps
  `@requestport/requestport` (ruling 86; the owner claims `requestport` on
  npm, ruling 175), the stamped version, which `cli.ts`'s `--version` reads
  as `../package.json` from `dist/` (ruling 158, 19), `private: false`,
  `type: "module"`, the mapping's `license`, the public repository with
  `apps/requestport` as `directory`, `bin`
  `{ requestport: "dist/requestport.js" }`, `files` `LICENSE` and `dist`,
  `engines` as the root declares, and the dependencies: the third-party
  ones, and each of `LOCKSTEP`'s thirteen packages at the stamped version
  (ruling 190); no
  `scripts`. It builds no web UI: `requestport` finds the web UI in
  `@requestport/web`'s directory (`serve/web.ts`), and carries no
  migrations: `db`'s tarball does. It carries no `THIRD-PARTY-NOTICES`
  (below).

  `THIRD-PARTY-NOTICES` (`NOTICES.file`) must cover every third-party
  package whose code a tarball contains, and may cover more (ruling 198
  item 1, which restates ruling 197 item 4 as no under-inclusion).
  `requestport`'s `dist/` inlines none (`moduleCommentProblems` refuses a
  module comment naming any module but `apps/requestport`'s, and every
  package is left to the install), so it carries none; each dependency npm
  installs carries its own licence, as its README says. Of G.7's eleven,
  `@requestport/db`'s alone holds third-party code: esbuild's runtime
  helpers, which its chunk binds, and for which G.7's pack writes it a
  `THIRD-PARTY-NOTICES` from the repository's notices (ruling 209); the
  other ten inline none, and carry none. The client's emit is `tsc`'s of
  its own modules, and carries none. G.7's `checkRun`, which this script
  runs over all fourteen, refuses a tarball whose JavaScript binds one of
  esbuild's runtime helpers as `var __<name> = ` at the start of a line
  while its notices have no entry for esbuild. In `@requestport/web`'s
  chunks Next's minifier renames those bindings, which hides them from it;
  web's notices enter esbuild, by the reviewed list of vendored copies, as
  vendored in each of the three packages whose files ruling 209's scan
  found binding them as esbuild writes them, and rolldown, whose runtime
  binds some of the same names, as vendored in the two whose file is that
  runtime (ruling 210 item 2, below). `stageWeb` refuses a package of
  web's build with a file the build contains that binds them as esbuild
  writes them, when the notices enter neither esbuild nor rolldown as
  vendored in it (`helperHolderProblems`; X27, ruling 231): it reads the
  installed files the build contains, as they are installed, which the
  minifier does not rewrite: those whose modules webpack compiled in (the
  build's recorder's), those a file the build emits outside its chunks is
  or names (`emittedPackages`'), and those it copies as they are
  (`verbatimPackages`').
  `@requestport/web`'s covers the third-party work its self-host build is
  seen to hold:
  - each package whose `node_modules` directory holds a module webpack put
    in a chunk of the build, as the build's recorder wrote them
    (`buildWeb`; `contained-modules.ts`), or whose own directory inside such
    a package does (a package the other vendors, as Next keeps those it
    compiles under its `dist/compiled`, each with its own manifest and
    licence files: `containedPackages`; `containedClosure`);
  - each package that wrote a file the build emits outside its chunks: a
    file of `static/media` byte for byte one it ships, or a stylesheet's
    licence banner naming it (`emittedPackages`);
  - each package that ships a file the build copies as it is into its
    dist directory, byte for byte one of its files, and each package that
    file bundles, by the reviewed
    list of such files keyed by their SHA-256 (`VERBATIM`,
    `scripts/pack-requestport-verbatim.json`; `verbatimPackages`): Next's
    polyfills chunk, which bundles `core-js`, `whatwg-fetch` and
    `object-assign`;
  - each package whose code a contained JavaScript file bundles, as the
    file's source map names it, entered by itself as bundled in the file's
    package, at the version the map records (`bundledPackages`): the files
    of `@modelcontextprotocol/server`'s `dist` the build contains, which
    bundle `ajv` and five others;
  - the bundler Next's build runs, whose own runtime modules are in the
    build's runtime chunks, `static/chunks/webpack-<hash>.js` and
    `server/webpack-runtime.js` (measured at H.7 round 7; `WEB.bundler`),
    and in no module the recorder records, and whose bootstrap module
    loader the modules `next`'s `ncc` compiled carry into other chunks:
    `webpack`, which `next` vendors (`WEB.bundler`; `bundlerPackages`);
  - each package an installed package of those keeps anywhere inside its
    own directory with a `package.json` that names it, entered by itself
    as vendored in that package at that directory, whether or not the
    build compiles a file of it in (`nestedPackages`; ruling 199 item 1);
  - each package that a vendored copy inside an installed package of those
    bundles, where the copy carries no `package.json` of its own, by the
    reviewed list of such copies keyed by holder and path
    (`VENDORED_COPIES`, `scripts/pack-requestport-vendored.json`;
    `listedVendoredPackages`), entered by itself as vendored in that
    package: the two builds of `@trigger.dev/core` 4.6.4's superjson
    bundle, which bundle `superjson` 2.2.1, `copy-anything` 3.0.5 and
    `is-what` 4.1.16; and a bundler's runtime that a holder's own files
    carry (ruling 210 item 2): esbuild's helpers, which ruling 209's scan
    found bound in `drizzle-orm` 0.45.2's `.cjs` files, in
    `@electric-sql/client` 1.0.14's `dist/index.mjs` and in the
    `@edge-runtime/cookies` that `next` compiles into its
    `dist/compiled` (scanned at 16.3.8; 16.4.2's is byte for byte the
    same), and rolldown's, which is `@modelcontextprotocol/server`
    2.3.0's `dist/chunk-Br0eD_fh.mjs` and `@better-auth/oauth-provider`
    1.7.6's `dist/rolldown-runtime-wcPFST8Q.mjs`: one file of each holder,
    entered as esbuild 0.28.2 and rolldown 1.2.4, the versions
    `packages/core` installs, with their licence texts, because no
    holder's build records the version that wrote it;
  each in `apps/web`'s production closure by G.A's licence inventory, view
  (b) (`productionClosure`), named by `WEB.beyondClosure` (`process`, which
  Next's webpack configuration provides), or vendored or bundled in one of
  those. One entry per package, with the licence its manifest declares and
  the text of each licence or notice file it ships (for a package either
  list names, the licence and text the list gives; for one a map names at a
  version this tree does not install, those of the highest version it
  does, named), each bundler's licence comment that a file of it the
  build contains carries for code it bundles (`BUNDLED_LICENCES`), and
  each licence comment a file of it the build contains carries
  (`licenceComments`: a comment holding a copyright line or a licence
  grant, for the package's own code or for code it took from another work,
  as `next`'s `dist/shared/lib/mitt.js` carries Jason Miller's MIT licence
  for mitt), comments the build's minifier drops. A licence comment in a
  module of RequestPort's own that the build contains is refused
  (`ownLicenceCommentProblems`): no entry could carry it.

  The bound that remains, what the pack cannot see, is ruling 199 item
  1's: third-party code with no `package.json` of its own, no licence
  comment, no source map and no list entry, that is, code a file the
  build contains holds that no `package.json` around it, no licence
  comment of that file, no source map of it and no entry of either
  reviewed list (`VERBATIM`, `VENDORED_COPIES`) names. The ruling accepts
  it, and J.8's final verification records it again. One instance is
  known (H.7 round 6's review): the `p-queue` `next` vendors
  (`dist/compiled/p-queue/index.js`, entered as vendored in `next` by its
  own `package.json`) bundles `eventemitter3` and `p-timeout` with none of
  the four, and the notices enter both only because `apps/web`'s own
  `p-queue` 6.6.2, which depends on them, is compiled in too. A review
  that finds another such package reports it as a minor, which an entry
  of the reviewed list of vendored copies closes (ruling 199 item 1). The
  pack cannot see two more cases, which the rulings' words do not name: a
  file the build copies from a package in another form than its bytes,
  and a package whose only work in the build is stylesheet text under no
  banner of its own. Neither was found by H.7 round 6 or its review.

  The stage refuses its notices (`noticesProblems`) when a package it found
  has no entry, or one whose licence is not its manifest's; when an entry
  names a package it did not find, or two name one package; and when a
  dependency of the closure is not installed. So that nothing it can see
  goes uncovered unseen, it refuses them too when the build's record lacks
  a sealed compilation of any of Next's three compilers (`WEB.compilers`),
  when a file of `static/media` is, byte for byte, neither a file a package
  of the closure ships nor one of `apps/web`'s own sources
  (`WEB.ownSources`), when a stylesheet's licence banner names no package
  of the closure, when the build copies a file the reviewed list does not
  name as it is or the list names a file the build does not copy, when a
  module of RequestPort's own that the build contains carries a licence
  comment, when `WEB.bundler`'s file is not there, when a directory inside
  an installed package the notices cover, or a `package.json` there,
  cannot be read (`nestedPackages`; a directory that cannot be read inside
  a package of the production closure stops the stage before that, with
  the reader's error, from `verbatimPackages`' walk of those packages, or
  `emittedPackages`' before it), when an entry of the reviewed list of
  vendored copies names a package the notices cover at another version, or
  a file of it that is not there at the SHA-256 the entry gives, or names
  as its holder a package the notices cover only as vendored or bundled in
  another, or one neither they nor the production closure hold
  (`listedVendoredPackages`), when a contained file's source map names
  a package this tree does not install, or cannot be read, and when a
  contained JavaScript file of a package binds one of esbuild's runtime
  helpers at the start of a line while the notices enter neither esbuild
  nor rolldown as vendored in that package (`helperHolderProblems`; X27).

  `checkRequestportTarball(entries, staged)` refuses a tarball when:
  - a file is outside `package/`, off the allow-list derived from the stage
    (`package.json`, `LICENSE`, `README.md` and `dist/`'s JavaScript, so
    no `THIRD-PARTY-NOTICES`), or on it and missing;
  - a file has a problem `fileProblems` finds: it is a test, an `.env*`
    file, a source map, under `test-support/`, or the sweep's ledger; holds
    a machine path in any form (`machinePathProblems`), binary files
    included; holds `workspace:`, if it is a `package.json`, or a
    `workspace:` specifier (`WORKSPACE_SPECIFIER`) if it is not; holds the
    E2E owner storage (`E2E_OWNER_STORAGE`, G.7's pattern), or lies under
    the directory of one of `apps/web`'s test routes or names one
    (`TEST_ROUTES`), which are what ruling 170 refuses; holds a marker of
    one of the three test seams (ruling 174; `packages/core/bundle.mjs`'s
    `testSeams`, the one list, which `apps/requestport/src/web/test-seams.ts`
    gives as `TEST_SEAMS`: auth's E2E magic-link outbox, apps/web's
    scenario-fault register and the CSP's E2E fence), text that shows a
    seam's real module: its path or text of its own, or E2E mode's two
    variables, which the outbox's predicate reads and other E2E modules hold
    too; or holds what G.7's `privateModuleProblems` finds of `db`'s private
    modules: a digest `shared-databases.ts` names, a private module's
    `kind = "private"` marker, or a doc comment one holds that its public
    variant lacks (ruling 183 item 9; ruling 193 item 5; ruling 194 item 3);
  - a file is `dist/` JavaScript whose module comments name a path outside
    the repository, a test-only module, or a module of another workspace
    than `apps/requestport` (`moduleCommentProblems`);
  - `LICENSE` is not the mapping's text byte for byte, or the `license`
    field not the mapping's;
  - `README.md` is not `apps/requestport/README.md` byte for byte;
  - the manifest differs from the one the pack wrote in any field, either
    way; whatever the written manifest says, does not say `private: false`,
    has a `repository` other than the public repository with
    `apps/requestport` as `directory`, or a `files` that does not name
    `LICENSE` (G.7's `releaseFieldProblems`); has `scripts`; has a `bin`
    that is not exactly `requestport`, or a `bin` target the tarball does
    not hold or that does not start with `#!/usr/bin/env node`; names, in
    any dependency field,
    an `@trigger.dev/*` package, or an `@requestport/*` package but those of
    `LOCKSTEP` in `dependencies` at the manifest's own version; or lacks one
    of `LOCKSTEP` in `dependencies` at that version.

  `stageWeb({ version, directory, build, exists })`, for a directory outside
  the repository that is empty or absent, stages `@requestport/web`, the
  self-host build's `apps/web` as a package of its own (ruling 193 item 4).
  It is not a row of `packages/core/bundle.mjs`, whose rows are esbuild
  entries of `packages/*` workspaces; it is packed with G.7's `packStaged`
  and checked with G.7's `checkTarball` and `checkRun`, as the client is.

  1. refuses a version G.7 would not stamp, a version of `next`, `react` or
     `react-dom` that `apps/web` does not declare (`WEB.packages`), and a
     production closure of `apps/web` holding a dependency this tree does
     not install, before it builds anything;
  2. calls `build()` (the self-host build, `buildWeb` unless a test hands
     another), and refuses the build, before it copies anything, when
     Next's trace holds a package other than `next`, `react`, `react-dom`
     and the packages H.7's survey found it bring with them (`WEB.traced`,
     and `sharp`'s platform packages for any platform), or lacks any of the
     first three; when `NEUTRAL_ROOT` exists on this machine (its
     `exists`, `existsSync` unless a test hands another); when the build put
     one of `db`'s private modules in a chunk without building its public
     variant in its place (`privateModuleBuildProblems`, which sees what
     G.7's checks of a minified chunk do not); and when what the
     build contains (`contained`) records no sealed compilation of one of
     Next's three compilers (`WEB.compilers`), names a package outside the
     production closure that `WEB.beyondClosure` does not name, does not
     hold one it names, or gives notices a problem `noticesProblems` finds
     (`containedClosure`), or what it emits outside its chunks is a file of
     `static/media` no package of the closure ships and `apps/web`'s own
     sources do not hold, or a licence banner for no package of the closure
     (`emittedPackages`), or a file it copies as it is, byte for byte a
     package's, that the reviewed list (`VERBATIM`) does not name as that
     package's file at that SHA-256, or the list names a file it does not
     copy (`verbatimPackages`), or a contained file's source map names a
     package the store does not install, or cannot be read
     (`bundledPackages`), or a module of RequestPort's own that it contains
     carries a licence comment (`ownLicenceCommentProblems`), or `next`
     ships no file at `WEB.bundler`'s path (`bundlerPackages`), or an entry
     of the reviewed list of vendored copies names a package the notices
     cover at another version, or a file of it not there at the entry's
     SHA-256 (`listedVendoredPackages`), or a JavaScript file it contains of
     a package binds esbuild's runtime helpers as esbuild writes them while
     the notices enter neither esbuild nor rolldown as vendored in that
     package (`helperHolderProblems`; X27);
  3. copies the tree's `apps/web` into `directory`, without any
     `node_modules`, refusing a symbolic link, and replaces its
     `package.json`, `apps/web`'s manifest with its `workspace:` specifiers,
     with the packed manifest (`webManifest`): `@requestport/web`, the
     stamped version, `private: false`, the build's `type` (`module`), the
     mapping's `license`, the public repository with `apps/web` as
     `directory`, `files` (`LICENSE`, `THIRD-PARTY-NOTICES`, and every
     top-level entry the build leaves but `package.json`), `engines` as the
     root declares, and `next`, `react` and `react-dom` at `apps/web`'s
     versions;
     no `exports`, so that `requestport` resolves its `package.json`, and no
     `@requestport/*` dependency: webpack compiles every workspace module
     `apps/web` imports into its chunks;
  4. rewrites this checkout's path, in every form `pathForms` lists, to
     `NEUTRAL_ROOT` in the same form, in every copied file that holds no NUL
     byte: one replacement everywhere, so a client-reference manifest's
     module ids still match the chunks', and the `file://` URLs webpack
     inlined for `import.meta.url` (ruling 145) name no file of this
     machine;
  5. copies the licence text as `LICENSE` and writes its notices, for the
     packages step 2 found the build contains, and refuses the stage when
     any file of it, binary or not, still holds a machine path (ruling 110).

  `checkWebTarball(entries, staged)` is every problem of three checks, each
  once:
  - G.7's `checkTarball`, the check G's own tarballs pass (its step 7),
    which applies whole to a package with no `dist/` and no entries: the
    allow-list, `LICENSE` and the `license` field, tests, `.env*` files,
    source maps, test support, the sweep's ledger, the E2E owner storage,
    every test seam's marker, `db`'s private modules (ruling 183 item 9;
    ruling 194 item 3: their digests, their `kind = "private"` marker and
    their doc comments, which the self-host build leaves out by building
    each one's public variant), machine
    paths in every form, binary files included, module comments, the
    written manifest, `workspace:` in it and a `workspace:` specifier in
    any other file, an `@requestport/*`, Better Auth or Trigger.dev
    dependency, `scripts` or `bin`, and `exports`, of which it has none;
  - H's web checks, which G's does not make: a file under a `node_modules`
    directory, which Next traced and the package does not ship; a file
    under or naming one of `TEST_ROUTES`; and `fileProblems`' others, each
    problem the two checks share reported once;
  - its `THIRD-PARTY-NOTICES`: missing, a problem `noticesProblems` finds
    against the closure the stage found the build contains, or other bytes
    than the stage wrote.

  `stageBundle({ directory })`, for a directory outside the repository that
  is empty or absent:

  1. builds `apps/requestport`'s two entries, `requestport` and `operator`,
     into `<directory>/dist` with `apps/requestport/bundle.mjs` (esbuild,
     split, every package `requestport` depends on left external), which
     refuses a build that inlines a module of another workspace or imports
     a subpath no tarball of the run publishes;
  2. refuses the build when:
     - an input is a test, test support, a test's entry or global setup,
       `db`'s test pool module or the sweep's ledger, or is not one of
       `apps/requestport`'s modules;
     - a module of the bundle loads a package at run time, through a
       `createRequire` binding, a factory called in place, or
       `process.getBuiltinModule("node:module")` (G.7's `runtimeRequires`),
       or resolves one through `.resolve()` on either (`runtimeResolves`,
       here: G's scan does not read it), and that package is neither one
       of the bundle's externals nor on the run-time list; or one names a
       path, or something that is not a string literal; or the run-time
       list names a package nothing loads or resolves. esbuild follows
       none of these calls, so a dependency list drawn from its metafile
       alone would omit `next` and `@requestport/web`;
     - an output that imports `@requestport/jobs` (its `.`) is reachable
       from an entry other than through `cli.ts`'s dynamic import of the
       `worker` command's module (`apps/requestport/src/worker.ts`):
       `jobs`' index registers the worker root as it loads, and only
       `requestport worker` may load it (`confinementProblems`; across the
       run's tarballs, `runConfinementProblems`);
     - an output is not directly in `dist/`, or an entry is not
       `dist/<name>.js`: a bundled module resolves `./operator.js` and
       `../package.json` from its own place;
     - a module comment esbuild wrote names a path that is absolute or
       climbs out of the repository, a test-only module, or a module of
       another workspace; or any output holds a machine path
       (`machinePathProblems`, below).

  `buildWeb()` makes the self-host build of `apps/web` with H.5's
  `buildSelfHostWeb`, in an environment that holds `PATH`, `HOME`, `TMPDIR`
  when it is set, Next's telemetry switched off and a placeholder
  `DATABASE_URL`, and no other value of the packing machine's
  (`webBuildEnvironment`). That build leaves out `apps/web`'s test routes,
  and refuses a build that holds one or lacks any other route of the source
  (`apps/requestport/src/web/self-host-build.ts`; ruling 170). It builds
  each test seam's real module from its inert one, and refuses a build that
  holds a seam's marker (ruling 174). It builds each of `db`'s private
  modules from its public variant (ruling 193 item 5; ruling 194 item 3:
  `shared-databases.ts`, `hosted-driver.ts` and `hosted-migrator.ts`).
  `stageWeb` refuses, before it copies anything, a build that put one of
  them in a chunk and did not build it from its variant, by what the
  build's recorder notes (`privateModuleBuildProblems`); `checkWebTarball`
  refuses a tarball that holds a private module's digests, its `kind =
  "private"` marker or a doc comment of its, which is what G.7's checks
  find, and which a minified chunk of a module compiled as it is need not
  hold. Its environment also names a new
  temporary directory as `SELF_HOST_CONTAINED_VARIABLE`, into which the
  build's recorder writes what each of its processes put in a chunk; it
  answers the build with what they wrote (`contained`, `readContained`'s:
  the compiler of each compilation sealed, by name, each module's file, and
  `replaced`, each file the build built from its replacement wherever, and
  under whichever of its paths, it put it in a chunk, as the recorder keys
  each by its real path), and removes the directory.

  A machine path (`machinePaths`) is the repository's path, the home
  directory, the temporary directory or the staging directory, each as given
  and as resolved; `machinePathProblems` finds one in any form `pathForms`
  lists: as written, with JSON's `\/`, as a `file://` URL's path, and
  percent-encoded whole. The three, and `WORKSPACE_SPECIFIER`, are G.7's
  (`scripts/pack-packages.mjs`), whose `checkTarball` reads them in the
  thirteen tarballs it checks (ruling 197 item 3), and `fileProblems` in
  `requestport`'s; this module exports them too.

  `requestportDependencies({ inputs, external })` answers the third-party
  dependencies `requestport` declares and what is wrong with them, by G.7's
  one-version rule (`dependencyVersions`): the bundle's third-party
  externals, its run-time list and `REQUESTPORT.declared` at the versions
  `apps/requestport`, the one workspace it inlines, declares, but
  `REQUESTPORT.fromWeb`, which `requestport` loads from `@requestport/web`'s
  directory and does not declare (ruling 193 item 4); and an
  `@requestport/*` package the bundle imports that `LOCKSTEP` does not
  name. `requestportManifest` names all of `LOCKSTEP` at the stamped
  version.

  `runConfinementProblems(packs)` reads the run's tarballs together, as the
  dist chunk graph of the run: no file holding `jobs`' index or its worker
  root may be reachable from `requestport`'s entries but through the
  `worker` command's dynamic import, whichever package's chunk imports it.

  `scripts/pack-requestport.test.mjs` holds each of these.
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import {
  buildRequestPortBundle,
  entries,
} from "../apps/requestport/bundle.mjs";
import { SELF_HOST_CONTAINED_VARIABLE } from "../apps/requestport/src/web/contained-modules.ts";
import { buildSelfHostWeb } from "../apps/requestport/src/web/self-host-build.ts";
import { SELF_HOST_DIST_DIR } from "../apps/requestport/src/web/self-host-dist-dir.ts";
import { seamMarkersIn } from "../apps/requestport/src/web/test-seams.ts";
import {
  packageName,
  publicVariants,
  testOnlyModule,
} from "../packages/core/bundle.mjs";
import {
  classifyLicence,
  licenceFiles,
  openContext,
  walkFirstParty,
} from "./licence-inventory.mjs";
import {
  buildRecord,
  checkRun,
  checkTarball,
  copyLicence,
  dependencyVersions,
  esbuildHelpersIn,
  externalPackages,
  LICENCE_FILE,
  machinePathProblems,
  machinePaths,
  PACKAGES,
  PATH_FORMS,
  packedManifest,
  packedRepository,
  packStaged,
  privateModuleProblems,
  readTarball,
  readTreeStatus,
  readWorkspaceManifests,
  refuseChangedTree as refuseChangedTreeAsG,
  refuseDirtyTree as refuseDirtyTreeAsG,
  refuseInsideRepository as refuseInsideRepositoryAsG,
  refuseVersion as refuseVersionAsG,
  releaseFieldProblems,
  repositoryRoot,
  runtimeRequires,
  stagePackage as stagePackageAsG,
  tarballFacts,
  WORKSPACE_SPECIFIER,
} from "./pack-packages.mjs";

// G.7's, which its `checkTarball` reads for every tarball of the run (ruling
// 197 item 3), exported here too for this script's test and the contract.
export {
  machinePathProblems,
  machinePaths,
  pathForms,
  WORKSPACE_SPECIFIER,
} from "./pack-packages.mjs";

/**
 * G.7's helper `check`, raising its error under this script's name, whether
 * it throws or its promise rejects: G's helpers begin their messages with
 * `pack-packages`, which is not the command that ran.
 */
function underThisName(check) {
  const renamed = (error) =>
    error instanceof Error && error.message.startsWith("pack-packages")
      ? new Error(
          `pack-requestport${error.message.slice("pack-packages".length)}`,
        )
      : error;
  return (...args) => {
    try {
      const result = check(...args);
      return result instanceof Promise
        ? result.catch((error) => {
            throw renamed(error);
          })
        : result;
    } catch (error) {
      throw renamed(error);
    }
  };
}

const refuseChangedTree = underThisName(refuseChangedTreeAsG);
const refuseDirtyTree = underThisName(refuseDirtyTreeAsG);
const refuseInsideRepository = underThisName(refuseInsideRepositoryAsG);
const refuseVersion = underThisName(refuseVersionAsG);
const stagePackage = underThisName(stagePackageAsG);

/**
 * The third-party notices a tarball carries for the third-party code it
 * contains (manifest-h.md §2.7.3; Done when 17; ruling 197 item 4, which
 * ruling 198 item 1 restates: every third-party package whose code it
 * contains, and it may cover more):
 * `@requestport/web`'s alone, of the run, which `thirdPartyNotices` writes
 * from G.A's licence inventory (`scripts/licence-inventory.mjs`, view (b)).
 * `file` is the name the stage writes them under, at the package's root:
 * npm and pnpm pack a file so named only when `files` names it (measured
 * with pnpm 11.22.0's `pack` and npm 10.9.8's `pack --dry-run`, H.7 slice
 * d). `WEB.notices` names the workspace whose production closure bounds
 * them (`members`) and what they say before their entries (`header`).
 */
export const NOTICES = Object.freeze({
  file: "THIRD-PARTY-NOTICES",
});

/**
 * The reviewed list of the files `@requestport/web`'s self-host build copies
 * as they are (ruling 198 item 2), committed beside this script (`file`,
 * from the repository's root) and read as this module loads (`files`): each
 * file by its SHA-256, the package that ships it (`holder`, by name) and its
 * path there, what the build names it (`emitted`), what was read to review
 * it (`reviewed`), and what it bundles (`bundles`: each package's name,
 * version and declared licence, and the name and text of its licence file,
 * from that version's npm tarball). `verbatimPackages` reads it.
 */
export const VERBATIM = Object.freeze({
  file: "scripts/pack-requestport-verbatim.json",
  files: Object.freeze(
    JSON.parse(
      readFileSync(
        new URL("./pack-requestport-verbatim.json", import.meta.url),
        "utf8",
      ),
    ).files,
  ),
});

/**
 * The reviewed list of the vendored copies of third-party packages that
 * carry no `package.json` of their own (ruling 199 item 1), committed
 * beside this script (`file`, from the repository's root) and read as this
 * module loads (`copies`): each copy by the installed package that holds
 * it (`holder`, by name, and its `version`) and its `path` there, its
 * SHA-256, what was read to review it (`reviewed`), and what it bundles
 * (`bundles`: each package's name, version and declared licence, and the
 * name and text of its licence file, from that version's npm tarball).
 * For a bundler's runtime that a holder's own files carry (ruling 210 item
 * 2), an entry names one such file, and the bundler at the version
 * `packages/core` installs, whose licence text it gives: no holder's build
 * records the version of the bundler that wrote it.
 * `listedVendoredPackages` reads it.
 */
export const VENDORED_COPIES = Object.freeze({
  file: "scripts/pack-requestport-vendored.json",
  copies: Object.freeze(
    JSON.parse(
      readFileSync(
        new URL("./pack-requestport-vendored.json", import.meta.url),
        "utf8",
      ),
    ).copies,
  ),
});

/**
 * The `requestport` package.
 *
 * - `source`: its workspace, named `@requestport/requestport`;
 * - `published`: the name its packed manifest takes, which the pack writes
 *   (ruling 86): `requestport`, which the owner claims on npm, with the
 *   `@requestport` scope, before J publishes (owner question 2, ruling 175);
 * - `bin`: the command, `requestport` whatever the published name, and the
 *   program esbuild writes for it (`apps/requestport/bundle.mjs`'s
 *   `requestport` entry);
 * - `files`: what the packed manifest's `files` names: `LICENSE`, which
 *   every packed manifest names (G.7's `LICENCE_FILE`; manifest-j.md
 *   §2.10), and `dist`, which the stage holds. npm and pnpm pack
 *   `package.json`, `README.md` and `LICENSE` whatever `files` says. It
 *   names no `migrations`: the operator applies the migrations `db`'s
 *   tarball carries
 *   (`packages/db/src/operator-session.ts`'s `packagedMigrationsFolder`,
 *   from `db`'s own `dist/`), and no `THIRD-PARTY-NOTICES`: `dist/` inlines
 *   no third-party code (ruling 197 item 4);
 * - `readme`: the README the stage copies as `README.md`, byte for byte,
 *   which is the done-when's README (manifest-h.md §5, Owns);
 * - `license` and `licenseText`: H's licence mapping entry, the SPDX
 *   expression of the packed `license` field and the text copied as
 *   `LICENSE`: Apache-2.0, D3's answer (ruling 175), the text under
 *   `licenses/` that G.7's mapping names too (ruling 150);
 * - `runtime`: the run-time list, the packages only a run-time `require` or
 *   `.resolve()` of a module of the bundle reaches, which esbuild's metafile
 *   does not list: `next` (`apps/requestport/src/serve/web.ts`, through its
 *   bound `requireFromBuild`, which resolves from the web UI's directory),
 *   and `@requestport/web` (`serve/web.ts`, packed, through `.resolve()` of
 *   its `package.json` on a `createRequire` binding). `db`'s `client.ts`,
 *   which loads `pg` and PGlite that way, is `db`'s tarball's, whose run-time
 *   list names `pg` and whose optional peers PGlite;
 * - `fromWeb`: the names of the run-time list `requestport` does not
 *   declare, because `serve/web.ts` loads them from `@requestport/web`'s
 *   directory and `@requestport/web` declares them: `next` (ruling 193 item
 *   4);
 * - `declared`: names neither the metafile nor the run-time list holds,
 *   which `requestport` declares anyway, at the version `apps/requestport`
 *   declares: PGlite, which `start --storage pglite` opens through `db`'s
 *   `client.ts`, and which `db`'s packed manifest names only as an optional
 *   peer, so that npm installs it only beside a package that declares it;
 * - `confined`: what only the `worker` command may load: `@requestport/jobs`
 *   (`specifier`, its `.`), whose index registers the worker root as it
 *   loads, and the modules of `jobs`' that do so (`modules`); that command's
 *   module (`command`), and the one module that may import it, dynamically
 *   (`importer`).
 */
export const REQUESTPORT = Object.freeze({
  source: "apps/requestport",
  published: "requestport",
  bin: Object.freeze({ requestport: "dist/requestport.js" }),
  files: Object.freeze([LICENCE_FILE, "dist"]),
  readme: "apps/requestport/README.md",
  license: "Apache-2.0",
  licenseText: "licenses/Apache-2.0.txt",
  runtime: Object.freeze(["next", "@requestport/web"]),
  fromWeb: Object.freeze(["next"]),
  declared: Object.freeze(["@electric-sql/pglite"]),
  confined: Object.freeze({
    specifier: "@requestport/jobs",
    modules: Object.freeze([
      "packages/jobs/src/index.ts",
      "packages/jobs/src/worker-root.ts",
    ]),
    command: "apps/requestport/src/worker.ts",
    importer: "apps/requestport/src/cli.ts",
  }),
});

/**
 * The `@requestport/web` package (ruling 190; ruling 193 item 4): the web UI
 * `requestport start` serves, which is the self-host build's `apps/web`
 * (H.5), without the `node_modules` Next traced into it, as a package of its
 * own, staged by `stageWeb`.
 *
 * - `source`: the workspace it is built from, whose manifest gives
 *   `packages` their versions;
 * - `published`: the name its packed manifest takes, the workspace's own;
 * - `packages`: what it loads at run time and therefore declares, so that
 *   npm installs them for the installing platform: `next`, `react` and
 *   `react-dom` (§2.7.3, K3; ruling 155 for `react-dom`). `requestport`
 *   loads `next` from this package's directory, and does not declare it
 *   (`REQUESTPORT.fromWeb`);
 * - `traced`: what Next's standalone trace may hold, which the pack does not
 *   ship: those three, and the fifteen platform-independent packages H.7's
 *   survey found the trace bring with them (`next` 16.3.1; each is a
 *   dependency, an optional dependency or a peer of a package on this list),
 *   which still hold at the 16.4.2 `apps/web` pins (`stageWeb` accepted its
 *   trace in H.7, round 4, at 16.3.8, and again at 16.4.2).
 *   `sharp`'s platform packages are `SHARP_PLATFORM`'s;
 * - `license` and `licenseText`: H's licence mapping entry, as
 *   `REQUESTPORT`'s;
 * - `notices`: its `THIRD-PARTY-NOTICES` (`NOTICES`): the third-party
 *   packages its self-host build is seen to compile in or copy
 *   (`containedClosure`, `verbatimPackages`), those a file of them
 *   bundles (`verbatimPackages`, `bundledPackages`), and those an installed
 *   one of them vendors (`nestedPackages`, `listedVendoredPackages`), each
 *   of the production closure of `apps/web` (`members`), named by
 *   `beyondClosure`, or vendored (`containedPackages`, `nestedPackages`,
 *   `listedVendoredPackages`) or bundled in one of those;
 * - `beyondClosure`: the packages the build compiles in that `apps/web`'s
 *   production closure does not reach: `process`, which Next's webpack
 *   configuration provides to the client's code (`ProvidePlugin`, with
 *   `require.resolve('process')`, `next` 16.4.2's
 *   `dist/build/webpack-config.js:1661`) from Next's own directory, where
 *   pnpm's store hoists it (`node_modules/.pnpm/node_modules/process`, a
 *   dependency of `path`'s, 0.12.7); `next` does not declare it. Measured by
 *   H.7 round 5's first pack, which refused the build for it;
 * - `compilers`: the webpack compilers Next's build runs, by the name
 *   `next@16.4.2`'s `dist/build/webpack/config/blocks/base.js:27` gives
 *   each configuration (`client`, `server`, `edge-server`; H.7 round 5's
 *   packs sealed one compilation of each). The build's record must name a
 *   sealed compilation of each, or nothing says what that compilation put
 *   in its chunks;
 * - `ownSources`: `apps/web`'s own sources, from the repository's root, a
 *   file of which the build may copy into `static/media` (an image a module
 *   imports), which is RequestPort's work, not a third party's, and needs
 *   no entry;
 * - `bundler`: the bundler Next's build runs, by the package that vendors
 *   it (`holder`) and a file of it there (`path`): `webpack`, which `next`
 *   16.4.2 keeps in `dist/compiled/webpack` (its `package.json` names
 *   `webpack`, with no version, MIT, and `bundle5.js` as its main) and
 *   whose runtime, the code of its runtime modules (the module loader and
 *   the chunk loading code), is in the runtime chunk of each compilation
 *   that wrote a chunk: `static/chunks/webpack-<hash>.js`, the client's,
 *   and `server/webpack-runtime.js`, the server's; the edge-server
 *   compilation wrote none. Measured by webpack's chunk graph at H.7 round
 *   7 (`next` 16.3.8): the build's own runtime modules, 15 and 10, are in
 *   those two of its 236 JavaScript chunk files and in no other, and the
 *   build's middleware manifest names no edge function. Measured by each
 *   file's text at the same round: each other chunk file holds the chunk
 *   format webpack writes around its modules (the client's 102 push them
 *   onto `self.webpackChunk_N_E`, the server's 79 numbered chunks export
 *   them as `id`, `ids` and `modules`, and its 53 entry chunks, pages,
 *   routes, the proxy and the instrumentation, require
 *   `webpack-runtime.js`); and the modules `next`'s `ncc` compiled into
 *   its `dist/compiled` packages carry webpack's bootstrap module loader
 *   into other chunks (five server files of that round's pack,
 *   `server/middleware.js` among them), code this same entry covers. No
 *   module the recorder records is the build's own runtime, so the stage
 *   enters the package by this file (`bundlerPackages`), with no file of
 *   it as contained.
 */
export const WEB = Object.freeze({
  source: "apps/web",
  published: "@requestport/web",
  license: "Apache-2.0",
  licenseText: "licenses/Apache-2.0.txt",
  notices: Object.freeze({
    members: Object.freeze(["@requestport/web"]),
    header: `Third-party notices for @requestport/web

@requestport/web holds the Next.js build of RequestPort's web
application, which compiles code from third-party packages into its
chunks.

Below are the third-party packages whose work this build holds, as far
as the pack that wrote this file could see it: each package that holds a
module the build put in one of its chunks, that ships a file the build
copies as it is (a font, or Next's polyfills), or that wrote part of a
stylesheet under its own licence banner; and each package whose code a
file the build copies as it is bundles, by a reviewed list of those files,
or whose code a file the build compiles in bundles, by that file's source
map, at the version the map records.
Each package that a package listed here by its name and version alone
keeps anywhere inside its own directory with a package.json of its own,
as Next keeps the packages it compiles under its dist/compiled, is listed
by itself, as vendored in the package that holds it, at that directory,
whether or not this build compiles it in; and each package that a copy
named in a reviewed list of such copies (one inside one of those, with no
package.json of its own) bundles is listed by itself, as vendored in that
package. Where that copy is a bundler's runtime that the package's own
files carry, the bundler is listed at the version this repository's
packages/core installs, which the list's checks hold it to, with that
version's licence text, and not at the version that wrote those files,
which the package's build does not record.
A package whose code a file of another package bundles is listed by
itself, as bundled in that package. A package either reviewed list names
is listed with the licence and the licence text of that version's npm
package. Each
other is listed as it was installed where this package was packed, with
its version where its package.json gives one, the licence its package.json
declares, and the text of each licence or notice file it ships; for a
package a source map names at a version that was not installed there, the
licence and the texts are those of the version that was, which its entry
names. A package that ships none is listed with its declared licence
alone. Where a file of a package the build compiles in
bundles other packages' code and names them in a bundler's licence
comment, that comment follows the package's licence, under the file's
name. Each licence comment a file of a package the build compiles in
carries (a comment that holds a copyright line or a licence grant, for
that package's own code or for code it took from another work) follows
too, once, under the name of the first file that carries it. webpack,
the bundler Next's build runs, whose runtime is in this build's runtime
chunks (static/chunks/webpack-<hash>.js and server/webpack-runtime.js)
and whose chunk format wraps the modules of its other chunks, is listed
as vendored in next.
`,
  }),
  packages: Object.freeze(["next", "react", "react-dom"]),
  beyondClosure: Object.freeze(["process"]),
  compilers: Object.freeze(["client", "edge-server", "server"]),
  ownSources: Object.freeze(["apps/web/src", "apps/web/public"]),
  bundler: Object.freeze({
    holder: "next",
    path: "dist/compiled/webpack/bundle5.js",
  }),
  traced: Object.freeze([
    "next",
    "react",
    "react-dom",
    "@next/env",
    "@opentelemetry/api",
    "@swc/helpers",
    "baseline-browser-mapping",
    "caniuse-lite",
    "client-only",
    "nanoid",
    "picocolors",
    "postcss",
    "source-map-js",
    "styled-jsx",
    "sharp",
    "@img/colour",
    "detect-libc",
    "semver",
  ]),
});

/**
 * The `@requestport/client` package (manifest-h.md §2.8.5; ruling 100).
 *
 * - `source`: its workspace, whose manifest's `exports` (each `./src/<name>.ts`)
 *   gives the packed `exports`, and whose `dependencies` their versions;
 * - `build`: H.2's `tsconfig.build.json`, which lists the exported modules
 *   and excludes the tests; `tsc` emits what they import with them;
 * - `internal`: the modules the emit holds that no subpath exports: `lock`,
 *   which `token-source.ts` and `credentials.ts` import;
 * - `license` and `licenseText`: H's licence mapping entry, as
 *   `REQUESTPORT`'s.
 */
export const CLIENT = Object.freeze({
  source: "packages/client",
  build: "packages/client/tsconfig.build.json",
  internal: Object.freeze(["lock"]),
  license: "Apache-2.0",
  licenseText: "licenses/Apache-2.0.txt",
});

/**
 * The packages `requestport` depends on, at the one version this run stamps
 * (J question 10's lockstep; ruling 190; ruling 193 item 6), in the order
 * the run packs them: G.7's `PACKAGES` (the S8 set, then `auth`, `mcp` and
 * `server`), `@requestport/web` and `@requestport/client`, each by the name
 * its packed manifest takes. `requestport`'s bundle imports eight of them
 * (`auth`, `client`, `config`, `core`, `db`, `domain`, `jobs` and
 * `server`), resolves `@requestport/web` at run time (`REQUESTPORT.runtime`:
 * `serve/web.ts`, through `.resolve()` of its `package.json`), and reaches
 * the other four (`importer`, `mcp`, `notifications` and `webhooks`)
 * through those; its manifest names all thirteen.
 */
export const LOCKSTEP = Object.freeze([
  ...Object.values(PACKAGES).map(({ bundle }) => bundle.package),
  WEB.published,
  JSON.parse(
    readFileSync(join(repositoryRoot, CLIENT.source, "package.json"), "utf8"),
  ).name,
]);

/**
 * `sharp`'s optional platform packages, of any platform (the survey's trace
 * held `@img/sharp-darwin-arm64` and `@img/sharp-libvips-darwin-arm64`): npm
 * installs the installing platform's.
 */
export const SHARP_PLATFORM = /^@img\/sharp-(?:libvips-)?[a-z0-9]+-[a-z0-9]+$/u;

/**
 * The root this checkout's path becomes in `@requestport/web`, the same in
 * every file. `stageWeb` refuses to stage where it exists, so it names no directory of
 * the machine that packs; a read at run time that follows it fails unless
 * the running machine has one, where the checkout's path would find the
 * checkout on the machine that built it (ruling 145).
 */
export const NEUTRAL_ROOT = "/requestport-build";

/**
 * A module only a test reaches: G.7's test-only list (a test, test support,
 * the sweep's ledger), a test's entry, a global setup, or `db`'s test pool
 * module (`@requestport/db/testing`), which G.7's forbidden-module list
 * names as `db`'s `./testing`, test support that no tarball publishes
 * (`packages/core/bundle.mjs`; ruling 185).
 */
export function testOnlyInput(path) {
  return (
    testOnlyModule(path) ||
    /\.test-entry\.[cm]?[jt]sx?$/u.test(path) ||
    /\.global-setup\.[cm]?[jt]sx?$/u.test(path) ||
    path === "packages/db/src/testing.ts"
  );
}

/** A module path from the repository's root, inside it. */
function insideRepository(path) {
  return !isAbsolute(path) && !path.split("/").includes("..");
}

/**
 * The one workspace whose modules the bundle may inline, `apps/requestport`
 * (its `node_modules` aside): every other workspace's code is a package
 * `requestport` depends on (`apps/requestport/bundle.mjs`, which refuses
 * such a build first).
 */
const WORKSPACE_INPUT = /^apps\/requestport\/(?!node_modules\/)/u;

/** What is wrong with the bundle's inputs, paths from the repository's root. */
export function inputProblems(inputs) {
  const problems = [];
  for (const input of inputs) {
    if (insideRepository(input) && testOnlyInput(input)) {
      problems.push(`the bundle inlines ${input}, which only a test reaches`);
    } else if (!insideRepository(input) || !WORKSPACE_INPUT.test(input)) {
      problems.push(
        `the bundle inlines ${input}, which is not one of apps/requestport's modules`,
      );
    }
  }
  return problems;
}

let parse;
/** rolldown's parser, from core's own devDependencies, as G.7's scan loads it. */
async function parser() {
  if (parse === undefined) {
    const fromCore = createRequire(
      join(repositoryRoot, "packages/core/package.json"),
    );
    ({ parseAst: parse } = await import(
      pathToFileURL(fromCore.resolve("rolldown/parseAst")).href
    ));
  }
  return parse;
}

/* A loose view of the ESTree that rolldown's parser returns. */
function isNode(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.type === "string"
  );
}

function* descendants(node) {
  yield node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child)) yield* descendants(child);
    }
  }
}

function stringLiteral(node) {
  return isNode(node) &&
    node.type === "Literal" &&
    typeof node.value === "string"
    ? node.value
    : undefined;
}

/** An expression without the type assertions TypeScript wraps around it. */
function unwrap(node) {
  let current = node;
  while (
    isNode(current) &&
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
    ].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether `expression` calls a `createRequire`: the one `node:module` exports,
 * imported by name (`factories`) or through a namespace (`namespaces`), or
 * `process.getBuiltinModule("node:module").createRequire`. The forms G.7's
 * `runtimeRequires` reads.
 */
function callsFactory(expression, { factories, namespaces }) {
  const call = unwrap(expression);
  if (call?.type !== "CallExpression") return false;
  const callee = unwrap(call.callee);
  if (callee?.type === "Identifier") return factories.has(callee.name);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.name !== "createRequire"
  ) {
    return false;
  }
  const object = unwrap(callee.object);
  if (object?.type === "Identifier") return namespaces.has(object.name);
  if (object?.type !== "CallExpression") return false;
  const getter = unwrap(object.callee);
  return (
    getter?.type === "MemberExpression" &&
    !getter.computed &&
    unwrap(getter.object)?.type === "Identifier" &&
    unwrap(getter.object).name === "process" &&
    getter.property.name === "getBuiltinModule" &&
    ["node:module", "module"].includes(
      stringLiteral(unwrap(object.arguments[0])),
    )
  );
}

/**
 * Every package or path a module resolves at run time through `.resolve()`
 * on a `createRequire` binding, or on a factory called in place
 * (`createRequire(import.meta.url).resolve("tsx/esm")`), which G.7's
 * `runtimeRequires` does not read: the module then spawns or loads what it
 * resolved, so the package is as much a run-time dependency as one it
 * requires. A call whose first argument is not a string literal is returned
 * with `specifier: undefined`.
 *
 * `modules` are paths from the repository's root, or absolute.
 */
export async function runtimeResolves(modules) {
  const parseAst = await parser();
  const found = new Map();
  for (const module of modules) {
    const program = parseAst(
      readFileSync(resolve(repositoryRoot, module), "utf8"),
      { lang: module.endsWith(".tsx") ? "tsx" : "ts" },
    );
    const imports = { factories: new Set(), namespaces: new Set() };
    for (const node of program.body) {
      if (
        node.type !== "ImportDeclaration" ||
        !["node:module", "module"].includes(stringLiteral(node.source))
      ) {
        continue;
      }
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          const imported = specifier.imported.name ?? specifier.imported.value;
          if (imported === "createRequire") {
            imports.factories.add(specifier.local.name);
          }
        } else {
          imports.namespaces.add(specifier.local.name);
        }
      }
    }
    const bindings = new Set();
    for (const node of descendants(program)) {
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        callsFactory(node.init, imports)
      ) {
        bindings.add(node.id.name);
      }
    }
    for (const node of descendants(program)) {
      if (node.type !== "CallExpression") continue;
      const callee = unwrap(node.callee);
      if (
        callee?.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.name !== "resolve"
      ) {
        continue;
      }
      const object = unwrap(callee.object);
      if (
        (object?.type === "Identifier" && bindings.has(object.name)) ||
        callsFactory(object, imports)
      ) {
        const specifier = stringLiteral(unwrap(node.arguments[0]));
        found.set(`${module}\0${specifier}`, { module, specifier });
      }
    }
  }
  const key = ({ module, specifier }) => `${module}\0${specifier}`;
  return [...found.values()].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
}

/**
 * What the two scans found that the package would not provide: a package
 * that is neither one of the bundle's externals nor on the run-time list; a
 * path, which resolves from `dist/` to nothing the package carries; a call
 * the scan cannot read; and a run-time list entry that no call loads or
 * resolves.
 */
export function unaccountedLoads(
  { requires, resolves },
  { external, runtime },
) {
  const accepted = new Set([...external, ...runtime]);
  const problems = [];
  const loads = [
    ...requires.map((load) => ({ ...load, verb: "requires" })),
    ...resolves.map((load) => ({ ...load, verb: "resolves" })),
  ];
  for (const { module, specifier, verb } of loads) {
    if (specifier === undefined) {
      problems.push(`${module} ${verb} something that is not a string literal`);
    } else if (specifier.startsWith(".") || isAbsolute(specifier)) {
      problems.push(
        `${module} ${verb} the path ${specifier} at run time, which the package does not carry`,
      );
    } else if (!isBuiltin(specifier) && !accepted.has(packageName(specifier))) {
      problems.push(
        `${module} ${verb} ${specifier} at run time, and ${packageName(specifier)} is neither one of the bundle's externals nor on the run-time list`,
      );
    }
  }
  const loaded = new Set(
    loads
      .filter(({ specifier }) => specifier !== undefined)
      .map(({ specifier }) => packageName(specifier)),
  );
  for (const name of runtime) {
    if (!loaded.has(name)) {
      problems.push(
        `the run-time list names ${name}, which no module of the bundle requires or resolves at run time`,
      );
    }
  }
  return problems;
}

/**
 * esbuild's outputs, by their absolute paths: the inputs each holds, its
 * entry's source if it is one, the outputs it imports, statically or
 * dynamically, and the packages it leaves external that it imports, each
 * by its specifier (`externals`). `node:` builtins are left out.
 */
export function outputGraph(metafile) {
  const absolute = (path) => resolve(repositoryRoot, path);
  return new Map(
    Object.entries(metafile.outputs).map(([path, output]) => [
      absolute(path),
      {
        inputs: Object.keys(output.inputs),
        entryPoint: output.entryPoint,
        imports: output.imports
          .filter(({ external }) => external !== true)
          .map(({ path: imported, kind }) => ({
            path: absolute(imported),
            dynamic: kind === "dynamic-import",
          })),
        externals: output.imports
          .filter(({ external, path: imported }) => {
            return external === true && !isBuiltin(imported);
          })
          .map(({ path: specifier, kind }) => ({
            specifier,
            dynamic: kind === "dynamic-import",
          })),
      },
    ]),
  );
}

/**
 * The outputs `from` reaches by its imports, `from` included: its static
 * imports only, or every import, but an edge `skip` refuses.
 */
export function reachable(
  graph,
  from,
  { dynamic = true, skip = () => false } = {},
) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const edge of graph.get(path)?.imports ?? []) {
      if ((dynamic || !edge.dynamic) && !skip(path, edge)) visit(edge.path);
    }
  };
  visit(from);
  return seen;
}

/** The packages `output` and the outputs it imports statically import, `node:` builtins aside. */
export function staticExternals(metafile, output) {
  const graph = outputGraph(metafile);
  const linked = reachable(graph, resolve(repositoryRoot, output), {
    dynamic: false,
  });
  return [
    ...new Set(
      Object.entries(metafile.outputs)
        .filter(([path]) => linked.has(resolve(repositoryRoot, path)))
        .flatMap(([, { imports }]) =>
          imports
            .filter(({ external, path }) => external && !isBuiltin(path))
            .map(({ path }) => packageName(path)),
        ),
    ),
  ].sort();
}

/**
 * What is wrong with where the bundle's chunks import `confined.specifier`
 * (`@requestport/jobs`, whose index registers the worker root as it loads):
 * an output that imports it, statically or dynamically, and that one of the
 * bundle's two entries reaches by any path but `importer`'s dynamic import of
 * `command`'s output; and the check unable to fire: `command` or `importer`
 * in no output, `importer`'s output not importing `command`'s dynamically,
 * or `command`'s output not importing the specifier. The run's own check,
 * across every tarball's chunks, is `runConfinementProblems`.
 */
export function confinementProblems(metafile, confined) {
  const graph = outputGraph(metafile);
  const holding = (input) =>
    [...graph]
      .filter(([, { inputs }]) => inputs.includes(input))
      .map(([path]) => path);
  const imports = (output) =>
    graph
      .get(output)
      .externals.some(({ specifier }) => specifier === confined.specifier);
  const problems = [];
  for (const input of [confined.command, confined.importer]) {
    if (holding(input).length === 0) {
      problems.push(
        `${input} is in no output, so the worker's check cannot fire`,
      );
    }
  }
  if (problems.length > 0) return problems;
  const [command] = holding(confined.command);
  const [importer] = holding(confined.importer);
  if (
    !graph
      .get(importer)
      .imports.some(({ path, dynamic }) => dynamic && path === command)
  ) {
    problems.push(
      `${confined.importer}'s output does not import ${confined.command}'s dynamically`,
    );
  }
  if (!imports(command)) {
    problems.push(
      `${confined.command}'s output does not import ${confined.specifier}, so the worker's check cannot fire`,
    );
  }
  const allowed = (from, { path, dynamic }) =>
    from === importer && path === command && dynamic;
  // The bundle's own entries: esbuild also gives each module that is imported
  // dynamically an `entryPoint` in the metafile, `worker.ts` among them.
  for (const { source } of entries) {
    const [entry] =
      [...graph].find(([, { entryPoint }]) => entryPoint === source) ?? [];
    if (entry === undefined) {
      problems.push(
        `the entry ${source} is in no output, so the worker's check cannot fire`,
      );
      continue;
    }
    for (const output of [...reachable(graph, entry, { skip: allowed })]) {
      if (imports(output)) {
        problems.push(
          `dist/${basename(output)} imports ${confined.specifier} and is reachable from ${source} other than through ${confined.importer}'s dynamic import of ${confined.command}`,
        );
      }
    }
  }
  return problems;
}

/**
 * What is wrong with where esbuild wrote: an output that is not directly in
 * `<directory>/dist`, and an entry that is not `dist/<name>.js` from its
 * source.
 */
export function layoutProblems(metafile, directory) {
  const dist = realpathSync(join(directory, "dist"));
  const problems = [];
  const outputs = [...outputGraph(metafile)];
  for (const [path] of outputs) {
    if (realpathSync(dirname(path)) !== dist) {
      problems.push(`${path} is not directly in ${dist}`);
    }
  }
  for (const { name, source } of entries) {
    const output = outputs.find(([, { entryPoint }]) => entryPoint === source);
    if (
      output === undefined ||
      realpathSync(output[0]) !== join(dist, `${name}.js`)
    ) {
      problems.push(`the entry ${source} is not dist/${name}.js`);
    }
  }
  return problems;
}

/**
 * What is wrong with an output's module comments: esbuild writes
 * `// <path>` above each module it inlines, and each must name a module
 * inside the repository, by its path from the root, none a module only a
 * test reaches, and none a module of another workspace than
 * `apps/requestport`, whose package `requestport` depends on instead
 * (`WORKSPACE_INPUT`): so no tarball check of `requestport`'s accepts a
 * second copy of another package's code, the private module of `db`'s
 * among it (ruling 193 item 5).
 */
export function moduleCommentProblems(file, text) {
  const problems = [];
  for (const [, module] of text.matchAll(
    /^\/\/ (\S+\.(?:ts|tsx|js|mjs|cjs))$/gmu,
  )) {
    if (!insideRepository(module)) {
      problems.push(`${file} names a module outside the repository: ${module}`);
    } else if (testOnlyInput(module)) {
      problems.push(`${file} inlines ${module}, which only a test reaches`);
    } else if (!WORKSPACE_INPUT.test(module)) {
      problems.push(
        `${file} inlines ${module}, which is not one of apps/requestport's modules`,
      );
    }
  }
  return problems;
}

/**
 * Builds `requestport`'s bundle into `directory`, outside the repository and
 * empty or absent, and refuses it on any problem this module's header lists.
 * Returns what the pack needs next.
 */
export async function stageBundle({ directory }) {
  refuseStageDirectory(directory);
  const metafile = await buildRequestPortBundle(directory);
  const inputs = Object.keys(metafile.inputs).sort();
  const code = inputs.filter((input) => /\.[cm]?[jt]sx?$/u.test(input));
  const external = externalPackages(metafile);
  const requires = await runtimeRequires(code);
  const resolves = await runtimeResolves(code);
  const javascript = Object.keys(metafile.outputs)
    .map((output) => relative(directory, resolve(repositoryRoot, output)))
    .sort();
  const paths = machinePaths(directory);
  const problems = [
    ...inputProblems(inputs),
    ...unaccountedLoads(
      { requires, resolves },
      { external, runtime: REQUESTPORT.runtime },
    ),
    ...confinementProblems(metafile, REQUESTPORT.confined),
    ...layoutProblems(metafile, directory),
    ...javascript.flatMap((file) => {
      const text = readFileSync(join(directory, file), "utf8");
      return [
        ...moduleCommentProblems(file, text),
        ...machinePathProblems(file, text, paths),
      ];
    }),
  ];
  if (problems.length > 0) {
    throw new Error(
      `pack-requestport refuses ${REQUESTPORT.source}:\n- ${problems.join("\n- ")}`,
    );
  }
  return {
    directory,
    metafile,
    inputs,
    external,
    requires,
    resolves,
    javascript,
  };
}

/** The workspaces whose modules are among the bundle's inputs. */
export function inlinedWorkspaces(inputs) {
  return [
    ...new Set(
      inputs
        .map(
          (input) =>
            /^(?:apps\/requestport|packages\/[^/]+)(?=\/)/u.exec(input)?.[0],
        )
        .filter((workspace) => workspace !== undefined),
    ),
  ].sort();
}

/**
 * The manifests the dependency list reads, by directory from the root: each
 * `packages/*` workspace's (G.7's `readWorkspaceManifests`), and
 * `apps/requestport`'s and `apps/web`'s.
 */
export function readManifests() {
  const manifests = readWorkspaceManifests();
  for (const workspace of [REQUESTPORT.source, WEB.source]) {
    manifests.set(
      workspace,
      JSON.parse(
        readFileSync(join(repositoryRoot, workspace, "package.json"), "utf8"),
      ),
    );
  }
  return manifests;
}

/**
 * The third-party dependencies `requestport` declares, and what is wrong
 * with them and with its `@requestport/*` ones, from the bundle's `inputs`
 * and `external` packages (`stageBundle`'s):
 *
 * - the bundle's third-party externals, its run-time list and `declared`
 *   (`REQUESTPORT.declared` unless a test hands another), at the version the
 *   workspaces it inlines (`apps/requestport` alone) declare in
 *   `dependencies`, by G.7's one-version rule (`dependencyVersions`): a name
 *   none of them declares there, or one they declare at two versions, is a
 *   problem. `REQUESTPORT.fromWeb` (`next`) is left out: `requestport` loads
 *   it from `@requestport/web`'s directory and does not declare it (ruling
 *   193 item 4);
 * - each `@requestport/*` package among them must be one of `LOCKSTEP`,
 *   which `requestportManifest` names, every one, at the stamped version;
 *   another is a problem.
 */
export function requestportDependencies({
  inputs,
  external,
  runtime = REQUESTPORT.runtime,
  declared = REQUESTPORT.declared,
  manifests = readManifests(),
}) {
  const named = [...new Set([...external, ...runtime, ...declared])];
  const versions = dependencyVersions({
    names: named.filter(
      (name) =>
        !name.startsWith("@requestport/") &&
        !REQUESTPORT.fromWeb.includes(name),
    ),
    peers: [],
    workspaces: inlinedWorkspaces(inputs),
    manifests,
  });
  return {
    dependencies: Object.fromEntries(
      Object.entries(versions.dependencies).sort(([a], [b]) =>
        byCodeUnit(a, b),
      ),
    ),
    problems: [
      ...versions.problems,
      ...named
        .filter(
          (name) =>
            name.startsWith("@requestport/") && !LOCKSTEP.includes(name),
        )
        .sort(byCodeUnit)
        .map(
          (name) =>
            `${name}: the bundle imports it, and this run packs no ${name}`,
        ),
    ],
  };
}

/**
 * The `DATABASE_URL` the self-host build is made with: a closed port on
 * loopback, so it names no server, and no password, so it holds nothing
 * J's denylist reads as a credential (H.7, round 4, slice a). Measured in
 * H.7's survey: without a `DATABASE_URL` the build fails ("Failed to collect
 * configuration for /.well-known/oauth-protected-resource/api/v1", a
 * `ZodError` at `DATABASE_URL`); with one it builds, so it parses the URL and
 * opens no connection, and no file of the standalone `apps/web` holds it.
 * The survey's placeholder had a password and this one has none, which
 * `@requestport/config`'s rule does not ask for (`isPostgresDatabaseUrl`: a
 * postgres URL with a host and a database); round 4's packs built with it.
 */
export const PLACEHOLDER_DATABASE_URL =
  "postgres://placeholder@127.0.0.1:9/placeholder";

/**
 * What the self-host build inherits, from `inherited`: `PATH`, `HOME` and,
 * when it is set, `TMPDIR`, as the survey's build had; Next's telemetry
 * switched off (`NEXT_TELEMETRY_DISABLED`); and the placeholder
 * `DATABASE_URL`. Nothing else of the packing machine's environment reaches
 * the build. `buildSelfHostWeb` adds its own: the self-host switch,
 * `NODE_ENV`, and a placeholder public URL and secret.
 */
export function webBuildEnvironment(inherited = process.env) {
  return {
    PATH: inherited.PATH,
    HOME: inherited.HOME,
    ...(inherited.TMPDIR === undefined ? {} : { TMPDIR: inherited.TMPDIR }),
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: PLACEHOLDER_DATABASE_URL,
  };
}

/**
 * Makes the self-host build with H.5's `buildSelfHostWeb`, in `webDirectory`
 * (`apps/web`), with `environment` (`webBuildEnvironment()`) and
 * `SELF_HOST_CONTAINED_VARIABLE` naming a new temporary directory, and
 * answers it, with `contained`: what the build's recorder wrote there
 * (`readContained`; `apps/requestport/src/web/contained-modules.ts`). The
 * directory is removed. `runNextBuild` is another runner only in tests.
 */
export async function buildWeb({
  webDirectory = join(repositoryRoot, WEB.source),
  environment = webBuildEnvironment(),
  runNextBuild,
} = {}) {
  const records = mkdtempSync(join(tmpdir(), "requestport-contained-"));
  try {
    const built = await buildSelfHostWeb({
      webDirectory,
      environment: { ...environment, [SELF_HOST_CONTAINED_VARIABLE]: records },
      ...(runNextBuild === undefined ? {} : { runNextBuild }),
    });
    return { ...built, contained: readContained(records) };
  } finally {
    rmSync(records, { recursive: true, force: true });
  }
}

/** `path` as the file system resolves it where it exists, and as given where it does not. */
function resolvedPath(path) {
  return existsSync(path) ? realpathSync(path) : path;
}

/**
 * What the self-host build's processes recorded in `directory`, each as
 * `<pid>.json` (`contained-modules.ts`' `writeContainedModules`), read
 * together: the compiler of each compilation they sealed, by name, once per
 * compilation; each module's file, once; and each file a record names as
 * replaced (built from its replacement in every chunk of that process's
 * compilations that holds it, under any of its paths: the recorder keys
 * what it built as it is and what it replaced by the file's real path,
 * so a record does not name as replaced a file that its process put in a
 * chunk as it is under another of its paths; ruling 199 item 2) that no
 * record holds among its files and not among its replaced, each path
 * compared as resolved (`resolvedPath`), so that a file one process built
 * as it is is not replaced whatever another replaced; each sorted.
 */
export function readContained(directory) {
  const compilers = [];
  const files = new Set();
  const replaced = new Set();
  const asIs = new Set();
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const recorded = JSON.parse(readFileSync(join(directory, name), "utf8"));
    compilers.push(...recorded.compilers);
    const own = new Set((recorded.replaced ?? []).map(resolvedPath));
    for (const file of recorded.files) {
      files.add(file);
      if (!own.has(resolvedPath(file))) asIs.add(resolvedPath(file));
    }
    for (const file of recorded.replaced ?? []) replaced.add(file);
  }
  return {
    compilers: compilers.sort(),
    files: [...files].sort(),
    replaced: [...replaced]
      .filter((file) => !asIs.has(resolvedPath(file)))
      .sort(),
  };
}

/**
 * Each private module of `variants` (`packages/core/bundle.mjs`'s
 * `publicVariants`, unless a test names others) that the self-host build
 * put in a chunk (`contained`'s `files`) and did not build from its public
 * variant (`contained`'s `replaced`: as `readContained` reads the records,
 * each file every process that put it in a chunk built from its
 * replacement in every such chunk, under every path it put it there by;
 * ruling 193 item 5; ruling 199 item 2). Each recorded path
 * and the module's path under `root` are compared as resolved
 * (`resolvedPath`), so a module recorded under any of its paths (through a
 * symbolic link to its workspace, as webpack records it with
 * `resolve.symlinks` off, or under a linked checkout) is found. G.7's
 * checks of the tarball look for a private module's digests, its `kind =
 * "private"` marker and its doc comments; a minified chunk keeps no doc
 * comment and renames the marker's binding, and the hosted driver holds no
 * digest, so they do not see it compiled in: a whole build that left
 * `hosted-driver.ts` and `hosted-migrator.ts` out of the replacements
 * packed (H.7 round 6). This refusal sees what the recorder records: a
 * process without it records nothing, and `containedClosure` refuses a
 * record that lacks any of Next's three compilers.
 */
export function privateModuleBuildProblems(
  contained,
  root = repositoryRoot,
  variants = publicVariants,
) {
  const files = new Set((contained?.files ?? []).map(resolvedPath));
  const replaced = new Set((contained?.replaced ?? []).map(resolvedPath));
  const problems = [];
  for (const [module, variant] of Object.entries(variants)) {
    const path = resolvedPath(join(root, module));
    if (files.has(path) && !replaced.has(path)) {
      problems.push(
        `the self-host build compiled the private module ${module} as it is, and not its public variant ${variant} in its place`,
      );
    }
  }
  return problems;
}

/**
 * The third-party packages `files` belong to (`contained`'s: the files of
 * the modules a build put in a chunk, and those `emittedPackages`
 * attributes). Each file under a `node_modules` directory belongs to the
 * package directly under the last one in its path (`node_modules/<name>` or
 * `node_modules/@<scope>/<name>`), as pnpm's install lays them out, by its
 * manifest's `name@version`; unless a `package.json` between that
 * directory and the file names another package, which the installed one
 * vendors: then it is that package's. Next 16.4.2 keeps the packages it
 * compiles under its `dist/compiled/<name>`, each with its own manifest and
 * licence files, and the self-host build compiles some of them in
 * (fourteen in H.7 round 5's build and round 6's: `ua-parser-js`, `cookie`
 * and `@edge-runtime/cookies` among them), whose notices are their own, not
 * `next`'s.
 *
 * A vendored package's key says where it is, `<name>[@<version>] (vendored
 * in <name>@<version> at <path>)`, so that no installed package's
 * `name@version` can be it and two copies of one name are two (Next's
 * `dist/compiled/schema-utils2` and `schema-utils3` both name
 * `schema-utils`); its version is there when its manifest gives one, which
 * most of Next's do not. A `package.json` below a package's own that names
 * nothing (`{"type": "module"}`), that package again, or a subpath of it
 * (`socket.io-client`'s `build/esm`, Next's `dist/compiled/hash.js/sha256`)
 * is its own.
 *
 * Answers each package by its key, with its directory and manifest, the
 * files of `files` that are its (`files`, sorted), and, for a vendored one,
 * `vendoredIn`: the key and name of the installed package that holds it;
 * sorted; and a problem for a package directory
 * without a manifest that names it. A file under no `node_modules` (a
 * workspace's own module) is not third-party, and is left out.
 */
export function containedPackages(files) {
  const packages = new Map();
  const problems = [];
  const manifests = new Map();
  const manifestIn = (directory) => {
    if (!manifests.has(directory)) {
      const file = join(directory, "package.json");
      let manifest;
      try {
        manifest = existsSync(file)
          ? JSON.parse(readFileSync(file, "utf8"))
          : undefined;
      } catch {
        manifest = undefined;
      }
      manifests.set(directory, manifest);
    }
    return manifests.get(directory);
  };
  const refused = new Set();
  const filesOf = new Map();
  for (const file of files) {
    const at = file.lastIndexOf("/node_modules/");
    if (at === -1) continue;
    const segments = file.slice(at + "/node_modules/".length).split("/");
    const depth = segments[0].startsWith("@") ? 2 : 1;
    const name = segments.slice(0, depth).join("/");
    const directory = `${file.slice(0, at)}/node_modules/${name}`;
    const manifest = manifestIn(directory);
    if (manifest?.name !== name || typeof manifest.version !== "string") {
      if (!refused.has(directory)) {
        refused.add(directory);
        problems.push(
          `${directory} holds a module the build contains, and no package.json that names ${name} with a version`,
        );
      }
      continue;
    }
    const installed = {
      key: `${manifest.name}@${manifest.version}`,
      directory,
      manifest,
    };
    let owner = installed;
    let below = directory;
    for (const segment of segments.slice(depth, -1)) {
      below = `${below}/${segment}`;
      const inner = manifestIn(below);
      if (
        typeof inner?.name !== "string" ||
        inner.name === owner.manifest.name ||
        inner.name.startsWith(`${owner.manifest.name}/`)
      ) {
        continue;
      }
      const version =
        typeof inner.version === "string" ? `@${inner.version}` : "";
      owner = {
        key: `${inner.name}${version} (vendored in ${installed.key} at ${relative(directory, below)})`,
        directory: below,
        manifest: inner,
        vendoredIn: { key: installed.key, name: installed.manifest.name },
      };
    }
    if (!packages.has(owner.key)) packages.set(owner.key, owner);
    filesOf.set(owner.key, (filesOf.get(owner.key) ?? new Set()).add(file));
  }
  return {
    packages: new Map(
      [...packages]
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([key, entry]) => [
          key,
          { ...entry, files: [...filesOf.get(key)].sort() },
        ]),
    ),
    problems,
  };
}

/**
 * The closure `@requestport/web`'s notices cover (ruling 197 item 4): the
 * packages `contained` (`buildWeb`'s) holds a module of, by
 * `containedPackages`: each of `closure`, `apps/web`'s production closure
 * (`productionClosure`), that the build contains; each package the build
 * contains outside it whose name `beyond` lists (`WEB.beyondClosure`); and
 * each package one of those vendors that the build contains, each as
 * `containedPackages` found it, with the files of it the build contains
 * (`files`). A problem when the build sealed no
 * compilation, so that nothing says what it contains, or none of a compiler
 * `compilers` names (`WEB.compilers`, Next's three), so that nothing says
 * what that compilation put in its chunks (a record lost with the process
 * that held it); for a package it contains outside the production closure
 * that `beyond` does not name, or vendored in one; for a name of `beyond`
 * the build contains no installed package of (a package vendored under
 * that name is not it), which no build needs then; and
 * `containedPackages`' own.
 * `scope` names it in `noticesProblems`' words.
 */
export function containedClosure(
  closure,
  contained,
  beyond = WEB.beyondClosure,
  compilers = WEB.compilers,
) {
  const problems = [];
  const sealed = contained?.compilers ?? [];
  if (sealed.length === 0) {
    problems.push(
      "the self-host build recorded no sealed compilation, so nothing says what code it contains",
    );
  } else {
    for (const name of compilers) {
      if (!sealed.includes(name)) {
        problems.push(
          `the self-host build recorded no sealed compilation of Next's ${name} compiler, so nothing says what code that compilation contains`,
        );
      }
    }
  }
  const found = containedPackages(contained?.files ?? []);
  problems.push(...found.problems);
  const packages = new Map();
  const members = closure.members.join(" and ");
  for (const [key, entry] of found.packages) {
    const holder = entry.vendoredIn ?? { key, name: entry.manifest.name };
    if (closure.packages.has(holder.key)) {
      packages.set(
        key,
        entry.vendoredIn === undefined
          ? { ...closure.packages.get(key), files: entry.files }
          : entry,
      );
    } else if (beyond.includes(holder.name)) {
      packages.set(key, entry);
    } else {
      problems.push(
        entry.vendoredIn === undefined
          ? `the self-host build contains ${key}, which is not in the production closure of ${members}`
          : `the self-host build contains ${key}, and ${holder.key}, which holds it, is not in the production closure of ${members}`,
      );
    }
  }
  for (const name of beyond) {
    if (
      ![...found.packages.values()].some(
        ({ manifest, vendoredIn }) =>
          vendoredIn === undefined && manifest.name === name,
      )
    ) {
      problems.push(
        `WEB.beyondClosure names ${name}, and the self-host build contains no module of it`,
      );
    }
  }
  return {
    closure: {
      members: closure.members,
      workspaces: closure.workspaces,
      packages: new Map([...packages].sort(([a], [b]) => byCodeUnit(a, b))),
      unresolved: closure.unresolved,
      scope: `the third-party code ${WEB.published}'s self-host build contains`,
    },
    problems,
  };
}

/**
 * A media file's extension, as `static/media` holds them: fonts and images
 * a stylesheet or `next/font` names.
 */
const MEDIA = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)$/iu;

/**
 * A licence banner a stylesheet carries for the tool that wrote part of it,
 * `/*! <name> v<version> …` (Tailwind's: `/*! tailwindcss v4.3.3 | MIT
 * License | https://tailwindcss.com *\/`).
 */
const BANNER =
  /\/\*!\s*(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)\s+v(\d+\.\d+\.\d+[\w.+-]*)/giu;

/** The regular files under `directory`, recursively, but any `node_modules`, by their paths from it. */
function regularFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split("/").includes("node_modules"))
    .sort();
}

/**
 * What the self-host build emits outside its chunks that a third-party
 * package wrote (ruling 197 item 4), read from the build's own output in
 * `serverDirectory` (its `.next-self-host/static`): the recorder of chunk
 * modules (`contained-modules.ts`) does not see it, since Next makes it
 * through its stylesheet pipeline, not as modules of a chunk. Measured in
 * H.7 round 5's packs: the two fonts `geist` ships, which `next/font/local`
 * copies as they are, and Tailwind's preflight, under its banner.
 *
 * - Each file of `static/media` that is, byte for byte, a file a package of
 *   `closure` ships: that package's file. One that is, byte for byte, a file
 *   under one of `own` (`apps/web`'s own sources, `WEB.ownSources`, unless
 *   a test names others) is RequestPort's, is listed in `own`, and adds no
 *   entry. Any other is a problem: whose work it is, no entry says (a font
 *   `next/font/google` downloads as it builds would be one).
 * - Each licence banner a stylesheet of `static/css` carries
 *   (`BANNER`): that package of `closure`, by its `package.json`. A banner
 *   for no package of the closure is a problem: no entry could cover it.
 *
 * Answers `files`, which join `contained.files` (`containedClosure`), each
 * under the `node_modules` directory of its package, `own` and `problems`,
 * each naming its file from `serverDirectory`.
 */
export function emittedPackages(
  serverDirectory,
  closure,
  own = WEB.ownSources.map((path) => join(repositoryRoot, path)),
) {
  const files = [];
  const owned = [];
  const problems = [];
  const scope = `the production closure of ${closure.members.join(" and ")}`;
  const statics = join(SELF_HOST_DIST_DIR, "static");
  const media = regularFiles(join(serverDirectory, statics, "media")).map(
    (path) => join(statics, "media", path),
  );
  const sizes = new Set(
    media.map((path) => statSync(join(serverDirectory, path)).size),
  );
  const candidates = new Map();
  if (media.length > 0) {
    for (const { directory } of closure.packages.values()) {
      for (const path of regularFiles(directory)) {
        if (!MEDIA.test(path)) continue;
        const file = join(directory, path);
        const { size } = statSync(file);
        if (!sizes.has(size)) continue;
        candidates.set(size, [...(candidates.get(size) ?? []), file]);
      }
    }
  }
  const sources =
    media.length === 0
      ? []
      : own.flatMap((directory) =>
          regularFiles(directory).map((path) => join(directory, path)),
        );
  for (const path of media) {
    const body = readFileSync(join(serverDirectory, path));
    const same = (file) =>
      statSync(file).size === body.length && readFileSync(file).equals(body);
    const shipped = (candidates.get(body.length) ?? []).find(same);
    if (shipped !== undefined) {
      files.push(shipped);
    } else if (sources.some(same)) {
      owned.push(path);
    } else {
      problems.push(
        `${path} is, byte for byte, no file a package of ${scope} ships, nor one of ${WEB.source}'s own sources (${WEB.ownSources.join(", ")}), so no entry could cover it`,
      );
    }
  }
  const css = regularFiles(join(serverDirectory, statics, "css"))
    .filter((path) => path.endsWith(".css"))
    .map((path) => join(statics, "css", path));
  for (const path of css) {
    const text = readFileSync(join(serverDirectory, path), "utf8");
    for (const [, name, version] of text.matchAll(BANNER)) {
      const entry = closure.packages.get(`${name}@${version}`);
      if (entry === undefined) {
        problems.push(
          `${path} carries a licence banner for ${name} v${version}, which is not a package of ${scope}`,
        );
      } else {
        files.push(join(entry.directory, "package.json"));
      }
    }
  }
  return { files: [...new Set(files)], own: owned, problems };
}

/**
 * What the self-host build copies as it is (ruling 198 item 2): each regular
 * file of the build's output under `serverDirectory` (its `apps/web`, which
 * `stageWeb` copies), in `SELF_HOST_DIST_DIR`, but those of `static/media`,
 * which `emittedPackages` reads, that is, byte for byte, a file a package of
 * `closure` ships. Outside `SELF_HOST_DIST_DIR` the build writes Next's
 * `server.js` and `package.json` and traces `apps/web`'s own files, none a
 * copy of a package's, and a file as short as `export {};` matches files of
 * many packages. No chunk holds such a file, so the recorder of chunk
 * modules does not see it, and it may bundle other packages' code without
 * naming them: `next` 16.4.2's polyfills chunk is, byte for byte, its
 * `dist/build/polyfills/polyfill-nomodule.js`, which bundles `core-js`,
 * `whatwg-fetch` and `object-assign` and carries no licence comment and no
 * source map (H.7 round 6, at 16.3.8, whose file 16.4.2's is byte for
 * byte).
 *
 * `list` (`VERBATIM.files`, unless a test names another) must name each such
 * file by its SHA-256, with the package that ships it (`holder`) and its
 * path there. The shipping package's file joins what the build contains
 * (`files`), so that package has an entry of its own; and each package the
 * list's entry `bundles` is entered by itself as `<name>@<version> (bundled
 * in <holder>)`, `<holder>` the shipping package's `name@version`, with the
 * licence and the text of the licence file the entry gives (`packages`). A
 * problem, so that no such file ships before the list is reviewed: for a
 * file whose SHA-256 the list does not name (a new file, or a changed one);
 * for one whose entry names another package or path than the file is; and
 * for an entry no file of the build is.
 *
 * Answers `packages`, by key, sorted; `files`, the shipping packages' files,
 * absolute, sorted; `copied`, each such file of the build, from
 * `serverDirectory`, with the package and the file of it that it is; and
 * `problems`.
 */
export function verbatimPackages(
  serverDirectory,
  closure,
  list = VERBATIM.files,
) {
  const media = `${join(SELF_HOST_DIST_DIR, "static", "media")}/`;
  const emitted = regularFiles(join(serverDirectory, SELF_HOST_DIST_DIR))
    .map((path) => join(SELF_HOST_DIST_DIR, path))
    .filter((path) => !path.startsWith(media));
  const bySize = new Map();
  for (const path of emitted) {
    const { size } = statSync(join(serverDirectory, path));
    bySize.set(size, [...(bySize.get(size) ?? []), path]);
  }
  const bodies = new Map();
  const body = (path) => {
    if (!bodies.has(path)) {
      bodies.set(path, readFileSync(join(serverDirectory, path)));
    }
    return bodies.get(path);
  };
  const shipped = new Map();
  for (const entry of closure.packages.values()) {
    for (const path of regularFiles(entry.directory)) {
      const file = join(entry.directory, path);
      const same = bySize.get(statSync(file).size);
      if (same === undefined) continue;
      const bytes = readFileSync(file);
      for (const copy of same) {
        if (body(copy).equals(bytes)) {
          shipped.set(copy, [...(shipped.get(copy) ?? []), { entry, path }]);
        }
      }
    }
  }
  const packages = new Map();
  const files = new Set();
  const copied = [];
  const problems = [];
  const reviewed = new Set();
  for (const path of [...shipped.keys()].sort(byCodeUnit)) {
    const matches = shipped.get(path);
    const sha256 = createHash("sha256").update(body(path)).digest("hex");
    const listed = list.find((entry) => entry.sha256 === sha256);
    const as = matches
      .map(({ entry, path: at }) => `${entry.key}'s ${at}`)
      .join(" and ");
    if (listed === undefined) {
      problems.push(
        `${path} is, byte for byte, ${as}, which the build copies as it is, and ${VERBATIM.file} names no file of SHA-256 ${sha256}: review what it bundles, and list it`,
      );
      continue;
    }
    reviewed.add(listed);
    const holder = matches.find(
      ({ entry, path: at }) =>
        entry.manifest.name === listed.holder && at === listed.path,
    );
    if (holder === undefined) {
      problems.push(
        `${path} is, byte for byte, ${as}, and ${VERBATIM.file} gives its SHA-256 ${sha256} to ${listed.holder}'s ${listed.path}`,
      );
      continue;
    }
    files.add(join(holder.entry.directory, holder.path));
    copied.push({ path, package: holder.entry.key, file: holder.path });
    for (const { name, version, license, file, text } of listed.bundles) {
      const key = `${name}@${version} (bundled in ${holder.entry.key})`;
      if (!packages.has(key)) {
        packages.set(key, {
          key,
          manifest: { name, version, license },
          bundledIn: holder.entry.key,
          texts: [{ file, text }],
        });
      }
    }
  }
  for (const entry of list) {
    if (!reviewed.has(entry)) {
      problems.push(
        `${VERBATIM.file} lists ${entry.holder}'s ${entry.path} (SHA-256 ${entry.sha256}), and the build copies no file of it: review the list`,
      );
    }
  }
  return {
    packages: new Map([...packages].sort(([a], [b]) => byCodeUnit(a, b))),
    files: [...files].sort(),
    copied,
    problems,
  };
}

/**
 * A source map's `sources` entry for code under a `node_modules` directory:
 * the package directly under the last one (`node_modules/<name>` or
 * `node_modules/@<scope>/<name>`), and its version where the pnpm store
 * directory above it records one (`.pnpm/<name, its / as +>@<version>…`,
 * as the maps `@modelcontextprotocol/server`'s build writes do). `undefined`
 * for a source under no `node_modules` (one of the bundling package's own
 * sources, which a map names by a path inside that package), and for a
 * declaration (`.d.ts`, `.d.mts`, `.d.cts`), which compiles to no code. A
 * source under a `node_modules` directory that names the bundling package
 * itself is answered as that package; `bundledPackages` drops it.
 */
export function bundledSource(source) {
  if (typeof source !== "string" || /\.d\.[cm]?ts$/u.test(source)) {
    return undefined;
  }
  const at = source.lastIndexOf("node_modules/");
  if (at === -1) return undefined;
  const segments = source.slice(at + "node_modules/".length).split("/");
  const depth = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length <= depth) return undefined;
  const name = segments.slice(0, depth).join("/");
  if (!/^(?:@[\w-][\w.-]*\/)?[\w-][\w.-]*$/u.test(name)) return undefined;
  const store = /(?:^|\/)\.pnpm\/([^/]+)\/$/u.exec(source.slice(0, at))?.[1];
  const flat = `${name.replace("/", "+")}@`;
  const version = store?.startsWith(flat)
    ? /^\d+\.\d+\.\d+[^_()]*/u.exec(store.slice(flat.length))?.[0]
    : undefined;
  return { name, version };
}

/** A `sourceMappingURL` comment, on a line of its own, as bundlers write one. */
const SOURCE_MAPPING_URL =
  /^\s*(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*]+)\s*(?:\*\/)?\s*$/gmu;

/**
 * The `sources` of the source map of the JavaScript file `file`: the map its
 * last `sourceMappingURL` comment names, a `data:` URL's or a file's beside
 * it, or `<file>.map` when it names none. `{}` when there is no map (a named
 * file that the package does not ship is none); a `problem` when a map is
 * there and is not JSON with `sources` (in an index map, its sections').
 */
export function sourceMapOf(file) {
  const text = readFileSync(file, "utf8");
  const url = [...text.matchAll(SOURCE_MAPPING_URL)].at(-1)?.[1];
  let raw;
  try {
    if (url?.startsWith("data:")) {
      const comma = url.indexOf(",");
      raw = url.slice(0, comma).endsWith(";base64")
        ? Buffer.from(url.slice(comma + 1), "base64").toString("utf8")
        : decodeURIComponent(url.slice(comma + 1));
    } else {
      const path =
        url === undefined
          ? `${file}.map`
          : join(dirname(file), decodeURIComponent(url));
      if (!existsSync(path)) return {};
      raw = readFileSync(path, "utf8");
    }
    const map = JSON.parse(raw);
    const sources = Array.isArray(map.sections)
      ? map.sections.flatMap((section) => section?.map?.sources ?? [])
      : map.sources;
    if (!Array.isArray(sources)) {
      return { problem: `${file}'s source map has no sources` };
    }
    return { sources };
  } catch (error) {
    return {
      problem: `${file}'s source map cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** `a` against `b`, two versions, by their major, minor and patch numbers, then as text. */
function byVersion(a, b) {
  const parts = (version) =>
    (/^(\d+)\.(\d+)\.(\d+)/u.exec(version) ?? []).slice(1).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return byCodeUnit(a, b);
}

/**
 * The packages pnpm's store `store` installs, by name, each copy with its
 * directory and manifest, by version, ascending: read from the store's
 * directory names (`<name, its / as +>@<version>…`) and each copy's
 * `package.json`, which must name it with a version.
 */
function storeIndex(store) {
  const named = new Map();
  for (const entry of existsSync(store) ? readdirSync(store) : []) {
    const at = entry.indexOf("@", entry.startsWith("@") ? 1 : 0);
    if (at <= 0) continue;
    const name = entry.slice(0, at).replace("+", "/");
    named.set(name, [...(named.get(name) ?? []), entry]);
  }
  const copies = new Map();
  return (name) => {
    if (!copies.has(name)) {
      const found = [];
      for (const entry of named.get(name) ?? []) {
        const directory = join(store, entry, "node_modules", name);
        const file = join(directory, "package.json");
        if (!existsSync(file)) continue;
        try {
          const manifest = JSON.parse(readFileSync(file, "utf8"));
          if (
            manifest.name === name &&
            typeof manifest.version === "string" &&
            !found.some((copy) => copy.manifest.version === manifest.version)
          ) {
            found.push({ directory, manifest });
          }
        } catch {
          // A manifest that is not JSON names nothing.
        }
      }
      copies.set(
        name,
        found.sort((a, b) => byVersion(a.manifest.version, b.manifest.version)),
      );
    }
    return copies.get(name);
  };
}

/**
 * The packages whose code a file the self-host build contains bundles, as
 * that file's source map names them (ruling 198 item 2): for each
 * JavaScript file of each entry of `packages` (`containedClosure`'s, each
 * with the files of it the build contains), each `sources` entry of its map
 * (`sourceMapOf`) under a `node_modules` directory that names another
 * package than the entry's own (`bundledSource`), entered by itself as
 * `<name>@<version> (bundled in <holder>)`, `<holder>` the entry's key, or
 * `<name> (bundled in <holder>)` where the map records no version.
 * `@modelcontextprotocol/server`'s `dist` bundles `ajv`, `ajv-formats`,
 * `fast-deep-equal`, `fast-uri`, `json-schema-traverse` and `content-type`
 * this way: no bundler's licence comment names them, `ajvProvider-*.mjs`
 * keeps no copyright or licence comment of the five it bundles, and
 * `src-*.mjs` keeps `content-type`'s own `/*!` copyright banner, which the
 * build's minifier drops.
 *
 * Its licence and text are those of that name at that version in pnpm's
 * store (`store`, the repository's `node_modules/.pnpm`, unless a test
 * names another): its `package.json`'s licence, and its licence and notice
 * files (`licenceFiles`). Where the store holds that name at other versions
 * only, the highest of them, whose `name@version` the entry gives as
 * `textFrom`, which `thirdPartyNotices` writes beside each file. A problem
 * where the store holds no package of that name, and where a map is there
 * and cannot be read.
 *
 * Answers `packages`, by key, sorted, and `problems`.
 */
export function bundledPackages(
  packages,
  store = join(repositoryRoot, "node_modules/.pnpm"),
) {
  const installed = storeIndex(store);
  const found = new Map();
  const problems = [];
  for (const [holder, entry] of packages) {
    for (const file of entry.files ?? []) {
      if (!/\.(?:c|m)?js$/u.test(file) || !existsSync(file)) continue;
      const map = sourceMapOf(file);
      if (map.problem !== undefined) {
        problems.push(map.problem);
        continue;
      }
      for (const source of map.sources ?? []) {
        const named = bundledSource(source);
        if (named === undefined || named.name === entry.manifest.name) continue;
        const id =
          named.version === undefined
            ? named.name
            : `${named.name}@${named.version}`;
        const key = `${id} (bundled in ${holder})`;
        if (found.has(key)) continue;
        const copies = installed(named.name);
        const copy =
          copies.find(({ manifest }) => manifest.version === named.version) ??
          copies.at(-1);
        if (copy === undefined) {
          problems.push(
            `${relative(entry.directory, file)} of ${holder} bundles ${id}, as its source map names it, and this tree installs no ${named.name} whose licence an entry could give`,
          );
          found.set(key, undefined);
          continue;
        }
        found.set(key, {
          key,
          directory: copy.directory,
          manifest: copy.manifest,
          bundledIn: holder,
          ...(copy.manifest.version === named.version
            ? {}
            : { textFrom: `${named.name}@${copy.manifest.version}` }),
        });
      }
    }
  }
  return {
    packages: new Map(
      [...found]
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => byCodeUnit(a, b)),
    ),
    problems,
  };
}

/**
 * The entry of the bundler Next's build runs (`WEB.bundler`, unless a test
 * names another): the package that `bundler.holder`, a package of
 * `closure`, vendors at the directory of its file `bundler.path`, as
 * `containedPackages` keys it (`webpack (vendored in next@16.4.2 at
 * dist/compiled/webpack)`), with no file of it as contained, since what the
 * build holds of it is its runtime, in the build's runtime chunks, and the
 * chunk format around each other chunk's modules (`WEB.bundler`), not that
 * file's code. A problem where the closure holds no `bundler.holder`, the
 * file is not there, or no `package.json` between it and the holder's
 * directory names a package of its own.
 *
 * Answers `packages`, by key, and `problems`.
 */
export function bundlerPackages(closure, bundler = WEB.bundler) {
  const holder = [...closure.packages.values()].find(
    ({ manifest }) => manifest?.name === bundler.holder,
  );
  const file =
    holder === undefined ? undefined : join(holder.directory, bundler.path);
  if (file === undefined || !existsSync(file)) {
    return {
      packages: new Map(),
      problems: [
        `${bundler.holder} ships no ${bundler.path}, the bundler whose runtime the self-host build's runtime chunks hold (WEB.bundler), or is not in ${closure.scope ?? "the closure"}: review WEB.bundler`,
      ],
    };
  }
  const found = containedPackages([file]);
  const vendored = [...found.packages.values()].filter(
    ({ vendoredIn }) => vendoredIn !== undefined,
  );
  if (found.problems.length > 0 || vendored.length !== 1) {
    return {
      packages: new Map(),
      problems: [
        ...found.problems,
        `no package.json between ${bundler.path} and ${holder.key}'s directory names the bundler as a package of its own: review WEB.bundler`,
      ],
    };
  }
  return {
    packages: new Map(
      vendored.map((entry) => [entry.key, { ...entry, files: [] }]),
    ),
    problems: [],
  };
}

/**
 * The entries of `closure` that are installed packages: each with a
 * directory, and neither vendored in another (`vendoredIn`) nor bundled in
 * one (`bundledIn`).
 */
function installedEntries(closure) {
  return [...closure.packages.values()].filter(
    ({ directory, vendoredIn, bundledIn }) =>
      directory !== undefined &&
      vendoredIn === undefined &&
      bundledIn === undefined,
  );
}

/**
 * The packages vendored inside the installed packages of `closure` (ruling
 * 199 item 1): every `package.json` anywhere below an installed package's
 * own directory (`installedEntries`; a directory that is a symbolic link is
 * not entered, and a `package.json` that is one is read through it, as
 * `containedPackages` reads a manifest) that names a package other than the
 * one whose directory encloses it, the installed package or a package
 * vendored in it above that `package.json`, and not a subpath of that one's
 * name, as `containedPackages` reads a vendored package; each entered by
 * itself, keyed as `containedPackages` keys one, `<name>[@<version>]
 * (vendored in <holder> at <path>)`, with its directory and manifest and no
 * file of it as contained, whether or not the build compiles a file of it
 * in. A `package.json` that names nothing (`{"type": "module"}`), the
 * enclosing package, or a subpath of it (`hash.js/sha256`) is that
 * package's own, and so is one that is not JSON, which names no package.
 * A package `containedPackages` or `bundlerPackages` already entered has the
 * same key, and `withAdded` keeps that entry, with the files of it the build
 * contains, where this one has none.
 *
 * It does not fail open (H.7 round 7's review): a directory below an
 * installed package's own, or that directory itself, that cannot be read,
 * and a `package.json` there that cannot be read (a symbolic link to
 * nothing, or one the reader may not open), is a problem, by the installed
 * package and the path in it, since nothing then says which packages it
 * vendors there.
 *
 * Answers `packages`, by key, sorted, and `problems`, sorted.
 */
export function nestedPackages(closure) {
  const packages = new Map();
  const problems = [];
  for (const installed of installedEntries(closure)) {
    const where = (path) =>
      `${installed.key}'s ${relative(installed.directory, path) || "own directory"}`;
    const walk = (directory, owner) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        problems.push(
          `${where(directory)} cannot be read (${error.code ?? error.message}), so nothing says which packages ${installed.key} vendors there (nestedPackages)`,
        );
        return;
      }
      let here = owner;
      if (
        directory !== installed.directory &&
        entries.some(
          (entry) => entry.name === "package.json" && !entry.isDirectory(),
        )
      ) {
        const file = join(directory, "package.json");
        let text;
        try {
          text = readFileSync(file, "utf8");
        } catch (error) {
          problems.push(
            `${where(file)} cannot be read (${error.code ?? error.message}), so nothing says whether it names a package ${installed.key} vendors there (nestedPackages)`,
          );
        }
        let manifest;
        try {
          manifest = text === undefined ? undefined : JSON.parse(text);
        } catch {
          manifest = undefined;
        }
        const name = manifest?.name;
        if (
          typeof name === "string" &&
          name !== "" &&
          name !== owner &&
          !name.startsWith(`${owner}/`)
        ) {
          const version =
            typeof manifest.version === "string" ? `@${manifest.version}` : "";
          const key = `${name}${version} (vendored in ${installed.key} at ${relative(installed.directory, directory)})`;
          if (!packages.has(key)) {
            packages.set(key, {
              key,
              directory,
              manifest,
              vendoredIn: { key: installed.key, name: installed.manifest.name },
              files: [],
            });
          }
          here = name;
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(directory, entry.name), here);
      }
    };
    walk(installed.directory, installed.manifest.name);
  }
  return {
    packages: new Map([...packages].sort(([a], [b]) => byCodeUnit(a, b))),
    problems: problems.sort(byCodeUnit),
  };
}

/**
 * The packages that the vendored copies the reviewed list names
 * (`VENDORED_COPIES`, unless a test names another `list`) bundle, each copy
 * one that carries no `package.json` of its own, inside an installed
 * package of `closure` (`installedEntries`; ruling 199 item 1): for each
 * entry whose `holder` is such a package, at the entry's `version`, and
 * whose file at the entry's `path` there is the copy at the entry's
 * SHA-256, each package it `bundles` is entered by itself as
 * `<name>@<version> (vendored in <holder>)`, `<holder>` the installed
 * package's `name@version`, with the licence and the text of the licence
 * file the entry gives, once whichever of its copies names it. An entry
 * whose holder `production` (the production closure the notices are
 * bounded by; `closure` itself, unless a caller hands another) installs,
 * and of whose name `closure` holds no package at all, adds nothing: the
 * notices cover no code of it.
 *
 * A problem, so that a changed copy is reviewed before it ships: for an
 * entry whose holder the closure holds at another version, or whose file
 * there is missing or at another SHA-256. And, so that a mis-keyed entry
 * closes nothing silently (H.7 round 7's review): for an entry whose holder
 * `closure` holds only as vendored in, or bundled in, another package (a
 * list entry is keyed by the installed package that holds the copy, and the
 * copy's path from that package's directory), and for one whose holder
 * neither `closure` nor `production` holds a package of.
 *
 * Answers `packages`, by key, sorted, and `problems`.
 */
export function listedVendoredPackages(
  closure,
  list = VENDORED_COPIES.copies,
  production = closure,
) {
  const installed = installedEntries(closure);
  const packages = new Map();
  const problems = [];
  for (const copy of list) {
    const holders = installed.filter(
      ({ manifest }) => manifest.name === copy.holder,
    );
    if (holders.length === 0) {
      const inside = [...closure.packages.values()]
        .filter(
          ({ manifest, vendoredIn, bundledIn }) =>
            manifest?.name === copy.holder &&
            (vendoredIn !== undefined || bundledIn !== undefined),
        )
        .map(({ key }) => key);
      if (inside.length > 0) {
        problems.push(
          `${VENDORED_COPIES.file} lists ${copy.holder} ${copy.version}'s ${copy.path}, and the notices cover ${copy.holder} only as vendored or bundled in another package (${inside.join(", ")}): key the entry by the installed package that holds the copy, with the copy's path from that package's directory`,
        );
      } else if (
        ![...production.packages.values()].some(
          ({ manifest }) => manifest?.name === copy.holder,
        )
      ) {
        problems.push(
          `${VENDORED_COPIES.file} lists ${copy.holder} ${copy.version}'s ${copy.path}, and neither the notices nor the production closure they are bounded by hold a package of that name: the entry is stale or mis-keyed: review the list`,
        );
      }
      continue;
    }
    for (const holder of holders) {
      if (holder.manifest.version !== copy.version) {
        problems.push(
          `${VENDORED_COPIES.file} lists ${copy.holder} ${copy.version}'s ${copy.path}, and the notices cover ${holder.key}: review what its copy bundles, and the list`,
        );
        continue;
      }
      const file = join(holder.directory, copy.path);
      const sha256 = existsSync(file)
        ? createHash("sha256").update(readFileSync(file)).digest("hex")
        : undefined;
      if (sha256 !== copy.sha256) {
        problems.push(
          sha256 === undefined
            ? `${VENDORED_COPIES.file} lists ${holder.key}'s ${copy.path}, which it does not ship: review the list`
            : `${VENDORED_COPIES.file} lists ${holder.key}'s ${copy.path} at SHA-256 ${copy.sha256}, and it is at ${sha256}: review what it bundles, and the list`,
        );
        continue;
      }
      for (const {
        name,
        version,
        license,
        file: licenceFile,
        text,
      } of copy.bundles) {
        const key = `${name}@${version} (vendored in ${holder.key})`;
        if (!packages.has(key)) {
          packages.set(key, {
            key,
            manifest: { name, version, license },
            vendoredIn: { key: holder.key, name: holder.manifest.name },
            texts: [{ file: licenceFile, text }],
          });
        }
      }
    }
  }
  return {
    packages: new Map([...packages].sort(([a], [b]) => byCodeUnit(a, b))),
    problems,
  };
}

/**
 * The bundlers whose runtime binds names of esbuild's runtime helpers
 * (`pack-packages.mjs`' `ESBUILD_RUNTIME_HELPERS`) as `var __<name> = ` at
 * the start of a line: esbuild, and rolldown, whose runtime uses some of the
 * same names (ruling 210 item 2). An entry for either, as vendored in a
 * package, is what `helperHolderProblems` accepts for that package's files.
 */
export const HELPER_BUNDLERS = Object.freeze(["esbuild", "rolldown"]);

/**
 * X27 (ruling 231; ruling 210 item 2): a new holder of esbuild's runtime
 * helpers fails the pack. Each JavaScript file (`.js`, `.cjs`, `.mjs`) of
 * each package of `contained` (`containedClosure`'s closure: the
 * third-party packages whose files the self-host build contains, each with
 * those `files`) is read, and a problem is answered for each package with a
 * file that binds one of esbuild's runtime helpers at the start of a line
 * (`esbuildHelpersIn`) when `noticed` (the closure the notices are written
 * from) holds no entry for one of `HELPER_BUNDLERS` as vendored in it. A
 * package vendored inside an installed one (Next's `dist/compiled`
 * packages) is judged as that installed package, which is how the reviewed
 * list of vendored copies keys an entry, and its files are named from that
 * package's directory, as `production` (the production closure) holds it,
 * or `contained` for a package beyond that closure. Next's minifier renames
 * the helpers in web's chunks, so `checkRun` cannot see them there; this
 * reads the installed files instead. It sees a package only through a file
 * the build contains: one the build's recorder records (a module webpack
 * put in a chunk), or one `emittedPackages` attributes to it (a file of
 * `static/media` byte for byte one it ships, or its `package.json`, for a
 * stylesheet's licence banner that names it) or `verbatimPackages` matches
 * (a file the build copies as it is), which stageWeb joins to the
 * recorder's before `containedClosure`; and it sees the helpers only in the
 * one layout `esbuildHelpersIn` matches. A file under no
 * `node_modules`, a module of RequestPort's own, is in no package of
 * `contained` (`containedPackages`), and is not judged.
 */
export function helperHolderProblems(contained, noticed, production) {
  const covered = new Set(
    [...noticed.packages.values()]
      .filter(
        ({ manifest, vendoredIn }) =>
          vendoredIn !== undefined && HELPER_BUNDLERS.includes(manifest?.name),
      )
      .map(({ vendoredIn }) => vendoredIn.key),
  );
  const holders = new Map();
  for (const entry of contained.packages.values()) {
    const key = entry.vendoredIn?.key ?? entry.key;
    for (const file of entry.files ?? []) {
      if (!/\.[cm]?js$/u.test(file)) continue;
      const names = esbuildHelpersIn(readFileSync(file, "utf8"));
      if (names.length === 0) continue;
      const found = holders.get(key) ?? { files: [], names: new Set() };
      found.files.push(file);
      for (const name of names) found.names.add(name);
      holders.set(key, found);
    }
  }
  return [...holders]
    .filter(([key]) => !covered.has(key))
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([key, { files, names }]) => {
      const holder =
        production?.packages.get(key) ?? contained.packages.get(key);
      const paths = files
        .map((file) =>
          holder?.directory === undefined
            ? file
            : relative(holder.directory, file),
        )
        .sort(byCodeUnit);
      const others = paths.length - 1;
      return `${paths[0]} of ${key}${
        others === 0
          ? " binds"
          : `, and ${others} other file${others === 1 ? "" : "s"} of it the build contains, bind`
      } esbuild's runtime helpers as esbuild writes them (${[...names]
        .sort(byCodeUnit)
        .join(
          ", ",
        )}), and ${NOTICES.file} enters neither ${HELPER_BUNDLERS.join(" nor ")} as vendored in ${key}: review whose runtime it is, and enter that bundler as vendored in ${holder?.manifest?.name ?? key} in ${VENDORED_COPIES.file}`;
    });
}

/**
 * `closure` (`containedClosure`'s) with the entries of `added` (each a map of
 * entries by key: `verbatimPackages`', `bundledPackages`',
 * `bundlerPackages`', `nestedPackages`' and `listedVendoredPackages'`
 * `packages`) beside its own, sorted; a key already there keeps its entry.
 */
export function withAdded(closure, ...added) {
  const packages = new Map(closure.packages);
  for (const map of added) {
    for (const [key, entry] of map) {
      if (!packages.has(key)) packages.set(key, entry);
    }
  }
  return {
    ...closure,
    packages: new Map([...packages].sort(([a], [b]) => byCodeUnit(a, b))),
  };
}

/**
 * The packages Next's standalone trace holds under `standalone`: every
 * `node_modules/<name>` and `node_modules/@scope/<name>` that is a directory
 * or a symbolic link, wherever it is (pnpm's `.pnpm/<entry>/node_modules`
 * included). Symbolic links are not followed.
 */
export function tracedPackages(standalone) {
  const names = new Set();
  const walk = (directory, segments) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const parent = segments.at(-1);
      if (
        parent === "node_modules" &&
        !entry.name.startsWith(".") &&
        !entry.name.startsWith("@")
      ) {
        names.add(entry.name);
      } else if (
        segments.at(-2) === "node_modules" &&
        parent?.startsWith("@")
      ) {
        names.add(`${parent}/${entry.name}`);
      }
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), [...segments, entry.name]);
      }
    }
  };
  walk(standalone, []);
  return [...names].sort();
}

/** What is wrong with what the trace holds (`tracedPackages`), against `WEB`. */
export function tracedProblems(names) {
  const problems = [];
  for (const name of WEB.packages) {
    if (!names.includes(name)) {
      problems.push(`the self-host build's trace holds no ${name}`);
    }
  }
  for (const name of names) {
    if (!WEB.traced.includes(name) && !SHARP_PLATFORM.test(name)) {
      problems.push(
        `the self-host build's trace holds ${name}, which is not next, react or react-dom nor one of the packages that come with them (WEB.traced)`,
      );
    }
  }
  return problems;
}

/**
 * `NEUTRAL_ROOT`, refused where it exists (`exists` is another check only in
 * tests): there, `@requestport/web` would name a directory of the machine
 * that packs.
 */
export function neutralRootProblems(exists = existsSync) {
  return exists(NEUTRAL_ROOT)
    ? [
        `${NEUTRAL_ROOT}, the root ${WEB.published} is rewritten to, exists on this machine`,
      ]
    : [];
}

/**
 * Copies `from` into `to`, but for anything named `node_modules`, and
 * answers the files it copied, by their paths from `to`, and a problem for
 * each symbolic link, which it does not copy: a link carries its target, a
 * path of the machine that built it.
 */
function copyWithoutModules(from, to) {
  const files = [];
  const problems = [];
  const walk = (relativePath) => {
    mkdirSync(join(to, relativePath), { recursive: true });
    for (const entry of readdirSync(join(from, relativePath), {
      withFileTypes: true,
    })) {
      const path =
        relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) {
        problems.push(`${path} is a symbolic link`);
      } else if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        copyFileSync(join(from, path), join(to, path));
        files.push(path);
      } else {
        problems.push(`${path} is neither a file nor a directory`);
      }
    }
  };
  walk("");
  return { files: files.sort(), problems };
}

/**
 * `@requestport/web`'s packed manifest (this module's header, `stageWeb`,
 * step 3), in place of the build's, which is `apps/web`'s, with its
 * `workspace:` specifiers, which Done when 17 keeps out of the tarball. It
 * keeps the build's `type`, which Node reads, and which makes the
 * standalone `server.js` a module. `files` names `LICENSE`, which every
 * packed manifest names (G.7's `LICENCE_FILE`), `THIRD-PARTY-NOTICES`, which
 * no packer packs unnamed (`REQUESTPORT.files`), and each of `entries`, the
 * top-level files and directories the stage copied from the build, but
 * `package.json`, which every packer packs. `private` is `false` and
 * `repository` the public repository with `apps/web` as `directory`, as in
 * every packed manifest (option (B); ruling 207 item 3); `dependencies` are
 * `WEB.packages` at `apps/web`'s versions (`stageWeb`). That Next serves
 * the package with it is shown by starting the packed tree, not by this
 * module's test.
 */
export function webManifest(built, { version, entries, dependencies }) {
  const root = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  return {
    name: WEB.published,
    version,
    private: false,
    ...(built.type === undefined ? {} : { type: built.type }),
    license: WEB.license,
    repository: packedRepository(WEB.source),
    files: [
      ...new Set([
        ...entries.filter((entry) => entry !== "package.json"),
        LICENCE_FILE,
        NOTICES.file,
      ]),
    ].sort(),
    engines: { node: root.engines.node },
    dependencies,
  };
}

/** A string's bytes as `latin1` text, which maps each byte to one character and back. */
function asBytes(text) {
  return Buffer.from(text, "utf8").toString("latin1");
}

/**
 * Replaces each of `checkouts` (this checkout's path, as given and as
 * resolved), in each form `PATH_FORMS` lists, with `NEUTRAL_ROOT` in the same
 * form, the longest first, in each of `files` (paths from `directory`) that
 * holds no NUL byte; a file with one is binary, and is left for the content
 * check. Answers how many files changed and how many occurrences it replaced.
 */
export function rewriteCheckout(
  directory,
  files,
  checkouts = [repositoryRoot, realpathSync(repositoryRoot)],
) {
  const pairs = new Map();
  for (const checkout of checkouts) {
    for (const form of PATH_FORMS) {
      if (!pairs.has(form(checkout))) {
        pairs.set(form(checkout), form(NEUTRAL_ROOT));
      }
    }
  }
  const ordered = [...pairs].sort(([a], [b]) => b.length - a.length);
  let changed = 0;
  let occurrences = 0;
  for (const file of files) {
    const body = readFileSync(join(directory, file));
    if (body.includes(0)) continue;
    let text = body.toString("latin1");
    let replaced = 0;
    for (const [from, to] of ordered) {
      const parts = text.split(asBytes(from));
      replaced += parts.length - 1;
      text = parts.join(asBytes(to));
    }
    if (replaced > 0) {
      writeFileSync(join(directory, file), Buffer.from(text, "latin1"));
      changed += 1;
      occurrences += replaced;
    }
  }
  return { files: changed, occurrences };
}

/**
 * `@requestport/web` as G.7's `checkTarball` reads a package: its source and
 * licence mapping entry, a bundle with no entries, no `@requestport/*`
 * package external and nothing inlined, no unpublished subpath and no
 * migrations.
 */
const WEB_PACK = Object.freeze({
  source: WEB.source,
  license: WEB.license,
  licenseText: WEB.licenseText,
  bundle: Object.freeze({
    package: WEB.published,
    entries: Object.freeze([]),
    external: Object.freeze([]),
    inlines: Object.freeze([]),
  }),
  unpublished: Object.freeze([]),
  migrations: undefined,
});

/**
 * Stages `@requestport/web` in `directory`, outside the repository and empty
 * or absent (this module's header, `stageWeb`), from `build()`, a self-host
 * build (`buildWeb`'s answer: its `standaloneDirectory` and its
 * `serverDirectory`, the tree's `apps/web`, and `contained`, what it
 * compiled in), and refuses it on any problem that header lists for it.
 * `exists` answers whether `NEUTRAL_ROOT` exists (`neutralRootProblems`'s,
 * `existsSync` unless a test hands another); `manifests`, `closure`,
 * `bundler` and `vendored` are another set of workspace manifests, another
 * production closure, another `WEB.bundler` and another list of vendored
 * copies (`VENDORED_COPIES.copies`) only in tests. Answers what
 * `checkWebTarball` reads, `closure` being the one its notices cover
 * (`containedClosure`'s, with the entries `withAdded` gives it).
 */
export async function stageWeb({
  version,
  directory,
  build,
  exists = existsSync,
  manifests = readManifests(),
  closure = productionClosure({ members: WEB.notices.members }),
  bundler = WEB.bundler,
  vendored = VENDORED_COPIES.copies,
}) {
  refuseVersion(version);
  refuseStageDirectory(directory);
  const refuse = (what, problems) => {
    throw new Error(
      `pack-requestport refuses ${what}:\n- ${problems.join("\n- ")}`,
    );
  };
  const versions = dependencyVersions({
    names: WEB.packages,
    peers: [],
    workspaces: [WEB.source],
    manifests,
  });
  if (versions.problems.length > 0) {
    refuse(`${WEB.published}'s dependencies`, versions.problems);
  }
  const unresolved = unresolvedProblems(closure);
  if (unresolved.length > 0) {
    refuse(`${WEB.published}'s ${NOTICES.file}`, unresolved);
  }
  const built = await build();
  const traced = tracedPackages(built.standaloneDirectory);
  const before = [
    ...tracedProblems(traced),
    ...neutralRootProblems(exists),
    ...privateModuleBuildProblems(built.contained),
  ];
  if (before.length > 0) refuse("the self-host build", before);
  const emitted = emittedPackages(built.serverDirectory, closure);
  const verbatim = verbatimPackages(built.serverDirectory, closure);
  const contained = containedClosure(
    closure,
    built.contained === undefined
      ? undefined
      : {
          ...built.contained,
          files: [
            ...built.contained.files,
            ...emitted.files,
            ...verbatim.files,
          ],
        },
  );
  const bundled = bundledPackages(contained.closure.packages);
  const bundlerEntry = bundlerPackages(closure, bundler);
  const seen = withAdded(
    contained.closure,
    verbatim.packages,
    bundled.packages,
    bundlerEntry.packages,
  );
  const nested = nestedPackages(seen);
  // The list is read against what the nested scan found too, so that an
  // entry keyed by a package vendored in another is refused.
  const listed = listedVendoredPackages(
    withAdded(seen, nested.packages),
    vendored,
    closure,
  );
  const noticed = withAdded(seen, nested.packages, listed.packages);
  const notices = thirdPartyNotices(noticed, WEB.notices);
  const unnoticed = [
    ...emitted.problems,
    ...verbatim.problems,
    ...contained.problems,
    ...bundled.problems,
    ...bundlerEntry.problems,
    ...nested.problems,
    ...listed.problems,
    ...helperHolderProblems(contained.closure, noticed, closure),
    ...ownLicenceCommentProblems(built.contained?.files ?? []),
    ...noticesProblems(noticed, notices),
  ];
  if (unnoticed.length > 0) {
    refuse(`${WEB.published}'s ${NOTICES.file}`, unnoticed);
  }
  const copied = copyWithoutModules(built.serverDirectory, directory);
  const manifest = webManifest(
    JSON.parse(
      readFileSync(join(built.serverDirectory, "package.json"), "utf8"),
    ),
    {
      version,
      entries: [...new Set(copied.files.map((file) => file.split("/")[0]))],
      dependencies: versions.dependencies,
    },
  );
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const rewritten = rewriteCheckout(directory, copied.files);
  const licence = copyLicence(WEB, directory);
  writeFileSync(join(directory, NOTICES.file), notices);
  const allowList = [
    ...new Set([...copied.files, licence, NOTICES.file]),
  ].sort();
  const paths = machinePaths(directory);
  const problems = [
    ...copied.problems,
    ...allowList.flatMap((file) =>
      machinePathProblems(file, readFileSync(join(directory, file)), paths),
    ),
  ];
  if (problems.length > 0) refuse("the self-host build", problems);
  return {
    pack: WEB_PACK,
    directory,
    manifest,
    closure: noticed,
    emitted,
    verbatim,
    notices,
    files: copied.files,
    traced,
    rewritten,
    allowList,
  };
}

/** The files under `root`'s `path`, by their paths from `root`, sorted. */
function filesUnder(root, path) {
  return readdirSync(join(root, path), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(root, `${path}/${entry.name}`)
        : [`${path}/${entry.name}`],
    )
    .sort();
}

/**
 * The client's entries, from its source manifest's `exports`: each subpath
 * and the module it names, `./src/<name>.ts`, as `{ subpath, name }`, the
 * shape G.7's `packedManifest` and `checkTarball` read; and a problem for an
 * export that is not a module directly in `src/`.
 */
export function clientEntries(source) {
  const found = [];
  const problems = [];
  for (const [subpath, target] of Object.entries(source.exports ?? {})) {
    const name =
      typeof target === "string"
        ? /^\.\/src\/([\w-]+)\.ts$/u.exec(target)?.[1]
        : undefined;
    if (name === undefined) {
      problems.push(
        `${CLIENT.source} exports ${subpath} as ${JSON.stringify(target)}, which is not a module directly in src/`,
      );
    } else {
      found.push({ subpath, name });
    }
  }
  if (found.length === 0 && problems.length === 0) {
    problems.push(`${CLIENT.source} exports nothing`);
  }
  return { entries: found, problems };
}

/**
 * What is wrong with the client's emit (`emitted`, paths from the stage):
 * a file that is neither the `.js` or `.d.ts` of an export's module or of
 * one of `internal`, and one of those that is missing.
 */
export function emitProblems(emitted, { entries: exported, internal }) {
  const expected = [
    ...new Set([...exported.map(({ name }) => name), ...internal]),
  ].flatMap((name) => [`dist/${name}.d.ts`, `dist/${name}.js`]);
  return [
    ...emitted
      .filter((file) => !expected.includes(file))
      .map(
        (file) =>
          `${file} is emitted, and is neither an export's module nor on CLIENT.internal`,
      ),
    ...expected
      .filter((file) => !emitted.includes(file))
      .map((file) => `${file} is not emitted`),
  ];
}

/**
 * The packages `files` (paths from `directory`, `.js` or `.d.ts`) import by
 * a bare specifier that is not a `node:` builtin: through an import or
 * export declaration, a dynamic `import()`, or an `import("…")` type; and a
 * problem for a dynamic import whose specifier is not a string literal.
 */
export async function importedPackages(directory, files) {
  const parseAst = await parser();
  const names = new Set();
  const problems = [];
  for (const file of files) {
    const program = parseAst(readFileSync(join(directory, file), "utf8"), {
      lang: file.endsWith(".d.ts") ? "dts" : "js",
    });
    for (const node of descendants(program)) {
      if (
        ![
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "ImportExpression",
          "TSImportType",
        ].includes(node.type) ||
        !isNode(node.source)
      ) {
        continue;
      }
      const specifier = stringLiteral(unwrap(node.source));
      if (specifier === undefined) {
        problems.push(`${file} imports something that is not a string literal`);
      } else if (
        !specifier.startsWith(".") &&
        !isAbsolute(specifier) &&
        !isBuiltin(specifier)
      ) {
        names.add(packageName(specifier));
      }
    }
  }
  return { names: [...names].sort(), problems };
}

/**
 * The client's packed dependencies: each package its emit imports, at the
 * version `source` (its manifest) declares in `dependencies`; a package it
 * does not declare there, or declares as a workspace package, is a problem.
 */
export function clientDependencies(names, source) {
  const dependencies = {};
  const problems = [];
  for (const name of [...names].sort()) {
    const version = source.dependencies?.[name];
    if (version === undefined) {
      problems.push(
        `the emit imports ${name}, which ${CLIENT.source} does not declare in dependencies`,
      );
    } else if (version.startsWith("workspace:")) {
      problems.push(
        `the emit imports ${name}, which ${CLIENT.source} declares as a workspace package (${version})`,
      );
    } else {
      dependencies[name] = version;
    }
  }
  return { dependencies, problems };
}

/**
 * The client as G.7's `packedManifest` and `checkTarball` read a package:
 * its entries as a bundle's, with no `@requestport/*` package external, no
 * unpublished subpath and no migrations.
 */
function clientPack(found) {
  return {
    source: CLIENT.source,
    license: CLIENT.license,
    licenseText: CLIENT.licenseText,
    bundle: { entries: found, external: [] },
    unpublished: [],
    migrations: undefined,
  };
}

/**
 * Emits the client's modules into `dist` by `tsc -p
 * packages/client/tsconfig.build.json`, H.2's build, with its `outDir`
 * replaced by `dist`, running the TypeScript that resolves from
 * `packages/client` (the root's devDependency), and refuses any output it
 * prints.
 */
function emitClient(dist) {
  const tsc = join(
    dirname(
      createRequire(
        join(repositoryRoot, CLIENT.source, "package.json"),
      ).resolve("typescript/package.json"),
    ),
    "bin",
    "tsc",
  );
  const run = spawnSync(
    process.execPath,
    [tsc, "-p", join(repositoryRoot, CLIENT.build), "--outDir", dist],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (run.status !== 0 || `${run.stdout}${run.stderr}` !== "") {
    throw new Error(
      `pack-requestport: tsc -p ${CLIENT.build} exited ${run.status}: ${run.stdout}${run.stderr}`,
    );
  }
}

/** Refuses a stage directory that is inside the repository or not empty. */
function refuseStageDirectory(directory) {
  refuseInsideRepository(directory);
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`pack-requestport: ${directory} is not empty.`);
  }
}

/**
 * Stages `@requestport/client` in `directory` (this module's header,
 * `stageClient`), and answers what `checkClientTarball` reads.
 */
export async function stageClient({ version, directory }) {
  refuseVersion(version);
  refuseStageDirectory(directory);
  const source = JSON.parse(
    readFileSync(join(repositoryRoot, CLIENT.source, "package.json"), "utf8"),
  );
  const { entries: found, problems: exported } = clientEntries(source);
  const refuse = (problems) => {
    throw new Error(
      `pack-requestport refuses ${CLIENT.source}:\n- ${problems.join("\n- ")}`,
    );
  };
  if (exported.length > 0) refuse(exported);
  mkdirSync(directory, { recursive: true });
  emitClient(join(directory, "dist"));
  const emitted = filesUnder(directory, "dist");
  const imported = await importedPackages(directory, emitted);
  const { dependencies, problems: undeclared } = clientDependencies(
    imported.names,
    source,
  );
  const problems = [
    ...emitProblems(emitted, { entries: found, internal: CLIENT.internal }),
    ...imported.problems,
    ...undeclared,
  ];
  if (problems.length > 0) refuse(problems);
  const pack = clientPack(found);
  const licence = copyLicence(pack, directory);
  const manifest = packedManifest(pack, {
    version,
    dependencies,
    peerDependencies: {},
  });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    pack,
    directory,
    manifest,
    emitted,
    allowList: ["package.json", licence, ...emitted].sort(),
  };
}

/** A tarball's files under `package/`, by their paths from it. */
function packageFiles(entries) {
  return new Map(
    [...entries]
      .filter(([path]) => path.startsWith("package/"))
      .map(([path, body]) => [path.slice("package/".length), body]),
  );
}

/**
 * Done when 12c, by name, over the client's tarball: every export's `.js`
 * and `.d.ts`; no test, nothing under `src/`, no `onboard-live`, no `.env*`,
 * and no `workspace:` in any file.
 */
export function doneWhen12cProblems(entries, staged) {
  const files = packageFiles(entries);
  const problems = [];
  for (const { subpath, name } of staged.pack.bundle.entries) {
    for (const file of [`dist/${name}.js`, `dist/${name}.d.ts`]) {
      if (!files.has(file)) {
        problems.push(`Done when 12c: ${subpath} has no ${file}`);
      }
    }
  }
  for (const [path, body] of files) {
    const name = basename(path);
    if (/\.test\./u.test(name))
      problems.push(`Done when 12c: ${path} is a test`);
    if (path.split("/").includes("src")) {
      problems.push(`Done when 12c: ${path} is under src/`);
    }
    if (path.includes("onboard-live")) {
      problems.push(`Done when 12c: ${path} is onboard-live`);
    }
    if (name.startsWith(".env")) {
      problems.push(`Done when 12c: ${path} is an environment file`);
    }
    if (body.includes("workspace:")) {
      problems.push(`Done when 12c: ${path} holds workspace:`);
    }
  }
  return problems;
}

/**
 * Every problem with the client's tarball (this module's header,
 * `checkClientTarball`): G.7's `checkTarball`, which reads this machine's
 * paths in every form, then Done when 12c by name.
 */
export function checkClientTarball(entries, staged) {
  return [
    ...checkTarball(entries, staged),
    ...doneWhen12cProblems(entries, staged),
  ];
}

/** Compares two strings by code unit, as `sort()` does. */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A production closure, by G.A's view (b), which bounds what
 * `@requestport/web`'s `THIRD-PARTY-NOTICES` may cover (`containedClosure`)
 * (`scripts/licence-inventory.mjs`'s `walkFirstParty`, as its `inventory`
 * walks a package's closure): from each of `members` (`apps/web`'s,
 * `WEB.notices.members`, unless a caller names another package's),
 * every third-party package that `dependencies`, `optionalDependencies` and
 * the peers not marked optional reach, as Node resolves them in `root`'s
 * installed tree, through every workspace package reached the same way; not
 * development dependencies, nor the optional peers the tree happens to hold.
 *
 * Answers `members`, the workspace packages walked (`workspaces`), each
 * third-party package by `name@version` with its directory and manifest
 * (`packages`, sorted), and each dependency a package declares and the tree
 * does not hold (`unresolved`), but for an optional one.
 */
export function productionClosure({
  root = repositoryRoot,
  members = WEB.notices.members,
} = {}) {
  const context = openContext(root);
  const located = new Map();
  for (const name of members) {
    const directory = context.locate(name);
    if (directory === undefined) {
      throw new Error(
        `pack-requestport: ${name} is not a workspace package of ${root}.`,
      );
    }
    located.set(name, directory);
  }
  const packages = new Map();
  const unresolved = [];
  const queue = [...located.keys()];
  while (queue.length > 0) {
    const name = queue.shift();
    const walked = walkFirstParty(
      context.tree,
      { name, directory: located.get(name) },
      {
        development: false,
        followOptionalPeers: false,
        isFirstParty: context.isFirstParty,
      },
    );
    for (const [workspace, { directory }] of walked.firstParty) {
      if (!located.has(workspace)) {
        located.set(workspace, directory);
        queue.push(workspace);
      }
    }
    for (const [key, { directory, manifest }] of walked.packages) {
      if (!packages.has(key)) packages.set(key, { key, directory, manifest });
    }
    unresolved.push(...walked.unresolved);
  }
  return {
    members: [...members],
    workspaces: [...located.keys()].sort(),
    packages: new Map([...packages].sort(([a], [b]) => byCodeUnit(a, b))),
    unresolved,
    scope: `the production closure of ${members.join(" and ")}`,
  };
}

/** The line above each entry of `THIRD-PARTY-NOTICES`. */
const NOTICES_RULE = "=".repeat(80);

/**
 * A bundler's comment naming the packages whose code a file bundles, each
 * with its own licence comment: esbuild's `legalComments: "eof"` form,
 * `/*! Bundled license information:` to the comment's end, each package's
 * comment written as `(*! … *)` inside it. The `index.mjs` of the
 * serverless PostgreSQL driver `@requestport/db`'s manifest depends on
 * carries one for the `buffer` and `ieee754` it bundles, and the build's
 * minifier drops it; H.7 round 5's build held that file's code. Since J.2b
 * the self-host build compiles `db`'s public variant of its hosted driver
 * (ruling 194 item 3) and holds none of the driver's code, and no file H.7
 * round 6's build contains carries such a comment.
 */
const BUNDLED_LICENCES = /\/\*! Bundled license information:\n[\s\S]*?\*\//gu;

/**
 * Each bundler's licence comment (`BUNDLED_LICENCES`) a JavaScript file of
 * `files` carries, with the file's path from `directory`, its package's.
 */
function bundledLicences(directory, files) {
  return files
    .filter((file) => /\.(?:c|m)?js$/u.test(file) && existsSync(file))
    .flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(BUNDLED_LICENCES)].map(
        ([comment]) => ({ file: relative(directory, file), comment }),
      ),
    );
}

/**
 * A comment of a JavaScript, TypeScript or stylesheet file, as `licenceComments` reads
 * it: a block comment, `/*` then `!`, `*` or white space, to the first `*`
 * + `/`, but not where the `/*` is just after a quote or a backslash, as in
 * a string or a regular expression that opens with it; or a run of lines
 * that each begin `//`. A comment-like text elsewhere in a string is read
 * as a comment, which can only add to what the notices carry.
 */
const BLOCK_COMMENT = /(?<!["'`\\])\/\*(?=[!*\s])[\s\S]*?\*\//gu;
const LINE_COMMENT = /^\s*\/\//u;

/**
 * What makes a comment a licence comment: a copyright line (`Copyright`,
 * `©`, or `(c)` before a year or a capital letter) or a licence grant or
 * name (`Permission is hereby granted`, `licensed`, `SPDX-License-Identifier`,
 * `@license`, `MIT License`, `ISC license`, `Apache License`, `BSD license`,
 * `MPL 2.0 License`, `released under`).
 */
const LICENCE_WORDS =
  /\bcopyright\b|©|permission is hereby granted|\blicen[cs]ed\b|\bspdx-license-identifier\b|@license\b|\b(?:mit|isc|bsd|apache|mpl)[- ](?:\d\.\d )?licen[cs]e\b|\breleased under\b/iu;
const COPYRIGHT_SIGN = /\(c\)\s*(?:\d|\p{Lu})/u;

/** The files whose comments `licenceComments` reads: JavaScript, TypeScript and stylesheets. */
const COMMENTED = /\.(?:[cm]?[jt]sx?|css)$/u;

/**
 * Each licence comment of `text` (a file's: `BLOCK_COMMENT`'s, with
 * `LICENCE_WORDS` or `COPYRIGHT_SIGN`), once, block comments first, each in
 * the order it is in the file; but esbuild's `Bundled license information`
 * comment, which `bundledLicences` carries under its own heading. Mitt's
 * MIT licence at the top of `next`'s `dist/shared/lib/mitt.js` is one, and
 * Node's (Joyent's) above `dist/shared/lib/router/utils/format-url.js`
 * another: comments the build's minifier drops (H.7 round 6's review).
 */
export function licenceComments(text) {
  const found = [...text.matchAll(BLOCK_COMMENT)].map(([comment]) => comment);
  let run = [];
  for (const line of `${text}\n`.split("\n")) {
    if (LINE_COMMENT.test(line)) {
      run.push(line.trim());
    } else if (run.length > 0) {
      found.push(run.join("\n"));
      run = [];
    }
  }
  return [...new Set(found)].filter(
    (comment) =>
      !comment.startsWith("/*! Bundled license information:") &&
      (LICENCE_WORDS.test(comment) || COPYRIGHT_SIGN.test(comment)),
  );
}

/**
 * Each licence comment (`licenceComments`) a JavaScript or stylesheet file
 * of `files` carries, once, with the files that carry it (each by its path
 * from `directory`, its package's), in the order of the first.
 */
function packageLicenceComments(directory, files) {
  const comments = new Map();
  for (const file of [...files].sort()) {
    if (!COMMENTED.test(file) || !existsSync(file)) continue;
    for (const comment of licenceComments(readFileSync(file, "utf8"))) {
      comments.set(comment, [
        ...(comments.get(comment) ?? []),
        relative(directory, file),
      ]);
    }
  }
  return [...comments].map(([comment, carriers]) => ({ comment, carriers }));
}

/**
 * A problem for each licence comment (`licenceComments`) that a file of
 * `files` (the self-host build's `contained`) under no `node_modules`
 * directory, a module of RequestPort's own, carries: no entry of the
 * notices is any such module's, so none could carry it, and a licence
 * comment there marks code taken from another work, whose notice would be
 * left out. None of the modules of RequestPort's own that H.7 round 6's
 * build contains carries one (measured after its review).
 */
export function ownLicenceCommentProblems(files, root = repositoryRoot) {
  return files
    .filter(
      (file) =>
        !file.split("/").includes("node_modules") &&
        COMMENTED.test(file) &&
        existsSync(file),
    )
    .flatMap((file) =>
      licenceComments(readFileSync(file, "utf8")).map(
        (comment) =>
          `${relative(root, file)}, RequestPort's own module, which the self-host build contains, carries a licence comment, and no entry of ${NOTICES.file} could carry it: ${JSON.stringify(
            comment
              .split("\n")
              .find(
                (line) => LICENCE_WORDS.test(line) || COPYRIGHT_SIGN.test(line),
              )
              ?.trim(),
          )}`,
      ),
    );
}

/**
 * `THIRD-PARTY-NOTICES` for `closure` (`containedClosure`'s, with the
 * entries `withAdded` gives it, or `productionClosure`'s): `notices`' header
 * (`WEB.notices`, unless a caller names another),
 * then one entry per package, in the closure's order, below
 * `NOTICES_RULE`: `Package: ` and its key (`<name>@<version>`, or a vendored
 * or bundled package's), `License: ` and the licence its manifest declares
 * as G.A's `classifyLicence` writes it, then each licence or notice file
 * G.A's `licenceFiles` finds in its directory, or, for an entry that gives
 * its own (`texts`: a package the reviewed list says a copied file bundles,
 * `verbatimPackages`), each of those, under `--- <file> ---`, or, for an
 * entry whose text is another version's (`textFrom`: a package a source
 * map names at a version the store does not install, `bundledPackages`),
 * under `--- <file>, from <name>@<version>, the version of it this tree
 * installs ---`; each text with CRLF line endings written as LF and its
 * trailing white space dropped;
 * then, for a package whose contained `files`
 * (`containedClosure`'s) include JavaScript that carries a bundler's
 * licence comment for code it bundles (`BUNDLED_LICENCES`), each such
 * comment, under `--- <file>: bundled license information ---`, the file
 * by its path in the package; then each licence comment those files carry
 * (`licenceComments`), once, under `--- <file>: licence comment ---`, the
 * first file that carries it, or `--- <file>, and <n> other file(s) of it:
 * licence comment ---`. It writes no path of this machine and no date.
 */
export function thirdPartyNotices(closure, notices = WEB.notices) {
  const entries = [...closure.packages.values()].map(
    ({ key, directory, manifest, files: contained = [], texts, textFrom }) => {
      const files =
        texts ??
        licenceFiles(directory)
          .filter(({ file }) => statSync(join(directory, file)).isFile())
          .map(({ file }) => ({
            file,
            text: readFileSync(join(directory, file), "utf8"),
          }));
      const bundled =
        directory === undefined ? [] : bundledLicences(directory, contained);
      const comments =
        directory === undefined
          ? []
          : packageLicenceComments(directory, contained);
      return [
        `Package: ${key}`,
        `License: ${classifyLicence(manifest).field}`,
        ...(files.length === 0
          ? ["", "(This package ships no licence or notice file.)"]
          : files.flatMap(({ file, text }) => [
              "",
              textFrom === undefined
                ? `--- ${file} ---`
                : `--- ${file}, from ${textFrom}, the version of it this tree installs ---`,
              "",
              text.replaceAll("\r\n", "\n").trimEnd(),
            ])),
        ...bundled.flatMap(({ file, comment }) => [
          "",
          `--- ${file}: bundled license information ---`,
          "",
          comment.replaceAll("\r\n", "\n").trimEnd(),
        ]),
        ...comments.flatMap(({ comment, carriers }) => [
          "",
          carriers.length === 1
            ? `--- ${carriers[0]}: licence comment ---`
            : `--- ${carriers[0]}, and ${carriers.length - 1} other file${carriers.length === 2 ? "" : "s"} of it: licence comment ---`,
          "",
          comment.replaceAll("\r\n", "\n").trimEnd(),
        ]),
      ].join("\n");
    },
  );
  return `${notices.header}${entries
    .map((entry) => `\n${NOTICES_RULE}\n${entry}\n`)
    .join("")}`;
}

/**
 * The entries of a `THIRD-PARTY-NOTICES` text, each as the `name@version`
 * its `Package:` line names and the licence its `License:` line gives, in
 * order; `undefined` for a line that is not there.
 */
export function noticesEntries(text) {
  return text
    .split(`\n${NOTICES_RULE}\n`)
    .slice(1)
    .map((entry) => {
      const [first = "", second = ""] = entry.split("\n", 2);
      return {
        key: /^Package: (.+)$/u.exec(first)?.[1],
        license: /^License: (.*)$/u.exec(second)?.[1],
      };
    });
}

/**
 * Each dependency `closure` could not resolve, which no entry of a
 * `THIRD-PARTY-NOTICES` can cover, as a problem.
 */
export function unresolvedProblems(closure) {
  return closure.unresolved.map(
    ({ dependent, name, range }) =>
      `${dependent} depends on ${name}@${range}, which this tree does not hold, so ${NOTICES.file} cannot cover it`,
  );
}

/**
 * What is wrong with `text` as `THIRD-PARTY-NOTICES` for `closure`: a
 * dependency the closure could not resolve (`unresolvedProblems`); a
 * package of the closure with no entry; an entry for a package outside it,
 * or without its `Package:` line; a package with more than one entry; and an
 * entry whose licence is not the one the package's manifest declares. Each
 * problem with the closure names it by its `scope`, or, for a closure
 * without one, as the production closure of its `members`.
 */
export function noticesProblems(closure, text) {
  const scope =
    closure.scope ??
    `the production closure of ${(closure.members ?? []).join(" and ")}`;
  const problems = unresolvedProblems(closure);
  const listed = new Map();
  for (const { key, license } of noticesEntries(text)) {
    if (key === undefined) {
      problems.push(`${NOTICES.file} has an entry with no Package: line`);
    } else {
      listed.set(key, [...(listed.get(key) ?? []), license]);
    }
  }
  for (const [key, { manifest }] of closure.packages) {
    const licenses = listed.get(key);
    const declared = classifyLicence(manifest).field;
    if (licenses === undefined) {
      problems.push(
        `${NOTICES.file} has no entry for ${key}, which is in ${scope}`,
      );
    } else if (licenses.length > 1) {
      problems.push(
        `${NOTICES.file} has ${licenses.length} entries for ${key}`,
      );
    } else if (licenses[0] !== declared) {
      problems.push(
        `${NOTICES.file} gives ${key}'s licence as ${licenses[0]}, where its package.json declares ${declared}`,
      );
    }
  }
  for (const key of listed.keys()) {
    if (!closure.packages.has(key)) {
      problems.push(
        `${NOTICES.file} has an entry for ${key}, which is outside ${scope}`,
      );
    }
  }
  return problems;
}

/**
 * The packed manifest of `requestport` (this module's header,
 * `stageRequestport`), with `dependencies` (`requestportDependencies`') and
 * each package of `LOCKSTEP` at `version`, the stamped version this run packs
 * them all at (J question 10's lockstep; ruling 190).
 */
export function requestportManifest({ version, dependencies }) {
  const root = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  return {
    name: REQUESTPORT.published,
    version,
    private: false,
    type: "module",
    license: REQUESTPORT.license,
    repository: packedRepository(REQUESTPORT.source),
    bin: { ...REQUESTPORT.bin },
    files: [...REQUESTPORT.files],
    engines: { node: root.engines.node },
    dependencies: Object.fromEntries(
      Object.entries({
        ...dependencies,
        ...Object.fromEntries(LOCKSTEP.map((name) => [name, version])),
      }).sort(([a], [b]) => byCodeUnit(a, b)),
    ),
  };
}

/**
 * Stages `requestport` in `directory` (this module's header,
 * `stageRequestport`), and answers what `checkRequestportTarball` reads.
 * It builds no web UI (`stageWeb` stages `@requestport/web`), and writes no
 * `THIRD-PARTY-NOTICES`: its `dist/` inlines no third-party code (ruling 197
 * item 4). `manifests` is another set of workspace manifests only in tests.
 */
export async function stageRequestport({
  version,
  directory,
  manifests = readManifests(),
}) {
  refuseVersion(version);
  const bundle = await stageBundle({ directory });
  const { dependencies, problems } = requestportDependencies({
    inputs: bundle.inputs,
    external: bundle.external,
    manifests,
  });
  if (problems.length > 0) {
    throw new Error(
      `pack-requestport refuses ${REQUESTPORT.source}'s dependencies:\n- ${problems.join("\n- ")}`,
    );
  }
  const licence = copyLicence(REQUESTPORT, directory);
  copyFileSync(
    join(repositoryRoot, REQUESTPORT.readme),
    join(directory, "README.md"),
  );
  const manifest = requestportManifest({ version, dependencies });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    pack: REQUESTPORT,
    directory,
    manifest,
    bundle,
    allowList: [
      "package.json",
      licence,
      "README.md",
      ...bundle.javascript,
    ].sort(),
  };
}

/**
 * The E2E owner storage, by the pattern G.7's `checkTarball` refuses in
 * core's tarball (`scripts/pack-packages.mjs`'s `E2E_OWNER_STORAGE`, which
 * that module does not export; the test holds this one equal to it): its
 * factory's name, its refusals' names, and the words its refusals say.
 * `requestport`'s and `@requestport/web`'s checks refuse it in any file
 * (ruling 170; `fileProblems`).
 */
export const E2E_OWNER_STORAGE =
  /createE2EOwnerStorage|E2E_OWNER_STORAGE_REFUSED|E2E owner storage/u;

/**
 * The test routes `apps/web` serves under `src/app/api/test` (its E2E
 * scenario hook, and the route that reads auth's fake e-mail outbox), which
 * no tarball may carry (ruling 170): `requestport`'s and
 * `@requestport/web`'s checks refuse a file under either route's directory,
 * and a file that names either (`fileProblems`). The outbox itself is
 * refused by its markers (`TEST_SEAMS`; ruling 174).
 */
export const TEST_ROUTES = Object.freeze([
  "/api/test/scenarios",
  "/api/test/email-outbox",
]);

/** The dependency fields of a manifest. */
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
]);

/**
 * A dependency `requestport` may not declare: no `@trigger.dev/*` package is
 * installed with it (`@requestport/web`'s chunks still inline
 * `@trigger.dev/sdk`, as H.7's survey measured `web/`'s; this refuses a
 * declared dependency, not inlined code), and no `@requestport/*` package
 * but those of `LOCKSTEP`, which `checkRequestportTarball` requires in
 * `dependencies`, each at the manifest's own version, and refuses anywhere
 * else.
 */
const FORBIDDEN_DEPENDENCY = /^@(?:requestport|trigger\.dev)\//u;

/** The first line every `bin` target of `requestport` starts with. */
const HASHBANG = "#!/usr/bin/env node\n";

/**
 * What is wrong with one file of `requestport`'s or `@requestport/web`'s
 * tarball, `path` from `package/` and its `body`, against this machine's
 * `paths` (`machinePaths`): a test, an `.env*` file, a source map, test
 * support or the sweep's ledger; a machine path in any form; `workspace:`
 * in a `package.json`, or a `workspace:` specifier in any other file; the
 * E2E owner storage; a file under one of `TEST_ROUTES`' directories, or one
 * that names one; a test seam's marker; and what it holds of a private
 * module, by G.7's `privateModuleProblems` (this module's header,
 * `checkRequestportTarball`).
 */
export function fileProblems(path, body, paths) {
  const problems = [];
  const name = basename(path);
  if (/\.test\./u.test(name)) problems.push(`${path} is a test`);
  if (name.startsWith(".env")) problems.push(`${path} is an environment file`);
  if (name.endsWith(".map")) problems.push(`${path} is a source map`);
  if (path.split("/").includes("test-support")) {
    problems.push(`${path} is test support`);
  }
  if (path.includes("tenant-scope-sweep")) {
    problems.push(`${path} is the sweep's ledger`);
  }
  problems.push(...machinePathProblems(path, body, paths));
  const text = body.toString("latin1");
  if (
    name === "package.json"
      ? text.includes("workspace:")
      : WORKSPACE_SPECIFIER.test(text)
  ) {
    problems.push(`${path} holds a workspace: specifier`);
  }
  if (E2E_OWNER_STORAGE.test(text)) {
    problems.push(`${path} holds the E2E owner storage`);
  }
  for (const route of TEST_ROUTES) {
    if (path.includes(`/app${route}/`)) {
      problems.push(`${path} belongs to the test route ${route}`);
    }
    if (text.includes(route)) {
      problems.push(`${path} names the test route ${route}`);
    }
  }
  for (const { seam, marker } of seamMarkersIn(text)) {
    problems.push(`${path} holds ${seam.name} (${marker})`);
  }
  // As G.7's `checkTarball` reads it, from the text as UTF-8: a private
  // module's doc comments may hold characters outside ASCII.
  problems.push(...privateModuleProblems(path, body.toString("utf8")));
  return problems;
}

/**
 * What is wrong with the `THIRD-PARTY-NOTICES` of `@requestport/web`'s
 * tarball, its `files` (`packageFiles`'), against what its stage wrote
 * (`staged.notices`) for the closure its build contains (`staged.closure`):
 * missing, a problem `noticesProblems` finds, or other bytes than the
 * stage's.
 */
function noticesFileProblems(files, staged) {
  const notices = files.get(NOTICES.file)?.toString("utf8");
  if (notices === undefined) return [`${NOTICES.file} is missing`];
  return [
    ...noticesProblems(staged.closure, notices),
    ...(notices === staged.notices
      ? []
      : [`${NOTICES.file} is not the notices the stage wrote, byte for byte`]),
  ];
}

/**
 * Every problem with `requestport`'s tarball, against what
 * `stageRequestport` staged (this module's header,
 * `checkRequestportTarball`): an empty list is a tarball this script
 * accepts.
 */
export function checkRequestportTarball(entries, staged) {
  const { pack, manifest: written, allowList, directory } = staged;
  const problems = [];
  for (const path of entries.keys()) {
    if (!path.startsWith("package/"))
      problems.push(`${path} is outside package/`);
  }
  const files = packageFiles(entries);
  const allowed = new Set(allowList);
  for (const path of files.keys()) {
    if (!allowed.has(path)) problems.push(`${path} is not on the allow-list`);
  }
  for (const path of allowList) {
    if (!files.has(path)) {
      problems.push(`${path} is on the allow-list but not in the tarball`);
    }
  }

  const paths = machinePaths(directory);
  for (const [path, body] of files) {
    problems.push(...fileProblems(path, body, paths));
    if (path.startsWith("dist/") && path.endsWith(".js")) {
      problems.push(...moduleCommentProblems(path, body.toString("utf8")));
    }
  }

  const licence = files.get("LICENSE");
  if (licence === undefined) {
    problems.push(`LICENSE is missing: the mapping names ${pack.licenseText}`);
  } else if (
    !licence.equals(readFileSync(join(repositoryRoot, pack.licenseText)))
  ) {
    problems.push(`LICENSE is not ${pack.licenseText}, byte for byte`);
  }

  const readme = files.get("README.md");
  if (readme === undefined) {
    problems.push(`README.md is missing: the stage copies ${pack.readme}`);
  } else if (!readme.equals(readFileSync(join(repositoryRoot, pack.readme)))) {
    problems.push(`README.md is not ${pack.readme}, byte for byte`);
  }

  const text = files.get("package.json")?.toString("utf8");
  if (text === undefined) return [...problems, "package.json is missing"];
  const packed = JSON.parse(text);
  if (packed.license !== pack.license) {
    problems.push(
      `package.json's license is ${packed.license}, not the mapping's ${pack.license}`,
    );
  }
  for (const field of new Set([
    ...Object.keys(written),
    ...Object.keys(packed),
  ])) {
    if (!isDeepStrictEqual(packed[field], written[field])) {
      problems.push(
        `package.json's ${field} is ${JSON.stringify(packed[field])}, not ${JSON.stringify(written[field])}`,
      );
    }
  }
  problems.push(...releaseFieldProblems(packed, pack.source));
  if (packed.scripts !== undefined) problems.push("package.json has scripts");
  const bin =
    typeof packed.bin === "object" && packed.bin !== null ? packed.bin : {};
  if (!isDeepStrictEqual(Object.keys(bin), Object.keys(pack.bin))) {
    problems.push(
      `package.json's bin is ${JSON.stringify(packed.bin)}, not exactly ${JSON.stringify(Object.keys(pack.bin))}`,
    );
  }
  for (const [command, target] of Object.entries(bin)) {
    const program =
      typeof target === "string"
        ? files.get(target.replace(/^\.\//u, ""))
        : undefined;
    if (program === undefined) {
      problems.push(
        `package.json's bin ${command} is ${JSON.stringify(target)}, which the tarball does not hold`,
      );
    } else if (!program.toString("utf8").startsWith(HASHBANG)) {
      problems.push(
        `${target}, the bin ${command}, does not start with ${HASHBANG.trim()}`,
      );
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    const value = packed[field] ?? {};
    for (const name of Array.isArray(value) ? value : Object.keys(value)) {
      const lockstep =
        field === "dependencies" &&
        LOCKSTEP.includes(name) &&
        value[name] === packed.version;
      if (FORBIDDEN_DEPENDENCY.test(name) && !lockstep) {
        problems.push(`package.json's ${field} names ${name}`);
      }
    }
  }
  for (const name of LOCKSTEP) {
    if (packed.dependencies?.[name] !== packed.version) {
      problems.push(
        `package.json's dependencies does not name ${name} at its own version, ${JSON.stringify(packed.version)}`,
      );
    }
  }
  return problems;
}

/**
 * Every problem with `@requestport/web`'s tarball, against what `stageWeb`
 * staged (this module's header, `checkWebTarball`), each once: G.7's
 * `checkTarball`; a file under a `node_modules` directory, and
 * `fileProblems`' for every file; and its `THIRD-PARTY-NOTICES`. An empty
 * list is a tarball this script accepts.
 */
export function checkWebTarball(entries, staged) {
  const paths = machinePaths(staged.directory);
  const files = packageFiles(entries);
  const problems = [...checkTarball(entries, staged)];
  for (const [path, body] of files) {
    if (path.split("/").includes("node_modules")) {
      problems.push(
        `${path} is under node_modules, which Next traced and ${WEB.published} does not ship`,
      );
    }
    problems.push(...fileProblems(path, body, paths));
  }
  problems.push(...noticesFileProblems(files, staged));
  return [...new Set(problems)];
}

/** A module comment, as esbuild writes one above each module it inlines. */
const MODULE_COMMENT = /^\/\/ (\S+\.(?:ts|tsx|js|mjs|cjs))$/gmu;

/**
 * What is wrong with where `jobs`' index and its worker root sit in the
 * run's JavaScript, read from its tarballs (`packs`, as `main` packs them,
 * each with its `entries`): the dist chunk graph of the run, in which a
 * file imports, statically or through `import(…)`, a relative specifier
 * resolved in its own tarball, or an `@requestport/*` specifier resolved
 * through the `import` target that the packed manifest of the package of
 * the run it names exports for its subpath (one that resolves to no file is
 * `checkRun`'s; any other package's specifier, and a builtin, is left out).
 *
 * A file that holds one of `confined.modules` (a module comment naming it),
 * reachable from `requestport`'s two entries (`dist/requestport.js` and
 * `dist/operator.js`) by any path but the dynamic import of the file holding
 * `confined.command` by the file holding `confined.importer`, is a problem:
 * `jobs`' index registers the worker root as it loads, and only `requestport
 * worker` may load it, whichever package's chunk imports it. So is the check
 * unable to fire: a module, the command or the importer in no file, that
 * import missing, or the command's file reaching none of the modules.
 */
export async function runConfinementProblems(
  packs,
  confined = REQUESTPORT.confined,
) {
  const parseAst = await parser();
  const tarballs = new Map();
  for (const { entries: read } of packs) {
    const files = packageFiles(read);
    const manifest = files.get("package.json")?.toString("utf8");
    if (manifest !== undefined) {
      tarballs.set(JSON.parse(manifest).name, {
        files,
        exports: JSON.parse(manifest).exports ?? {},
      });
    }
  }
  const key = (name, path) => `${name}\0${path}`;
  const named = (file) => {
    const [name, path] = file.split("\0");
    return `${name}'s ${path}`;
  };
  const comments = new Map();
  for (const [name, { files }] of tarballs) {
    for (const [path, body] of files) {
      if (!path.endsWith(".js")) continue;
      comments.set(
        key(name, path),
        [...body.toString("utf8").matchAll(MODULE_COMMENT)].map(
          ([, module]) => module,
        ),
      );
    }
  }
  const holding = (module) =>
    [...comments]
      .filter(([, modules]) => modules.includes(module))
      .map(([file]) => file);
  const resolveSpecifier = (name, path, specifier) => {
    if (specifier.startsWith(".")) {
      const target = posix.normalize(
        posix.join(posix.dirname(path), specifier),
      );
      return tarballs.get(name).files.has(target)
        ? key(name, target)
        : undefined;
    }
    if (!specifier.startsWith("@requestport/")) return undefined;
    const imported = packageName(specifier);
    const subpath =
      specifier === imported ? "." : `.${specifier.slice(imported.length)}`;
    const tarball = tarballs.get(imported);
    const target = tarball?.exports[subpath];
    const file = (
      typeof target === "string" ? target : target?.import
    )?.replace(/^\.\//u, "");
    return file !== undefined && tarball.files.has(file)
      ? key(imported, file)
      : undefined;
  };
  const edges = new Map();
  const importsOf = (file) => {
    if (!edges.has(file)) {
      const [name, path] = file.split("\0");
      const found = [];
      for (const node of descendants(
        parseAst(tarballs.get(name).files.get(path).toString("utf8"), {
          lang: "js",
        }),
      )) {
        if (
          ![
            "ImportDeclaration",
            "ExportNamedDeclaration",
            "ExportAllDeclaration",
            "ImportExpression",
          ].includes(node.type)
        ) {
          continue;
        }
        const specifier = stringLiteral(unwrap(node.source));
        const to =
          specifier === undefined
            ? undefined
            : resolveSpecifier(name, path, specifier);
        if (to !== undefined) {
          found.push({ to, dynamic: node.type === "ImportExpression" });
        }
      }
      edges.set(file, found);
    }
    return edges.get(file);
  };
  const reach = (from, skip = () => false) => {
    const seen = new Set();
    const queue = [from];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const edge of importsOf(file)) {
        if (!skip(file, edge)) queue.push(edge.to);
      }
    }
    return seen;
  };

  const problems = [];
  const confinedFiles = new Map(
    confined.modules.map((module) => [module, holding(module)]),
  );
  for (const [module, files] of confinedFiles) {
    if (files.length === 0) {
      problems.push(
        `${module} is in no file of the run, so the worker's check cannot fire`,
      );
    }
  }
  const [importer] = holding(confined.importer);
  const [command] = holding(confined.command);
  for (const [module, file] of [
    [confined.importer, importer],
    [confined.command, command],
  ]) {
    if (file === undefined) {
      problems.push(
        `${module} is in no file of the run, so the worker's check cannot fire`,
      );
    }
  }
  if (problems.length > 0) return problems;
  if (
    !importsOf(importer).some(({ to, dynamic }) => dynamic && to === command)
  ) {
    problems.push(
      `${named(importer)}, which holds ${confined.importer}, does not import ${named(command)}, which holds ${confined.command}, dynamically`,
    );
  }
  const commandReaches = reach(command);
  if (
    ![...confinedFiles.values()].flat().some((file) => commandReaches.has(file))
  ) {
    problems.push(
      `${named(command)}, which holds ${confined.command}, reaches none of ${confined.modules.join(" and ")}, so the worker's check cannot fire`,
    );
  }
  const allowed = (from, { to, dynamic }) =>
    from === importer && to === command && dynamic;
  for (const { name } of entries) {
    const entry = key(REQUESTPORT.published, `dist/${name}.js`);
    if (!comments.has(entry)) {
      problems.push(
        `${named(entry)} is not in the run, so the worker's check cannot fire`,
      );
      continue;
    }
    const seen = reach(entry, allowed);
    for (const [module, files] of confinedFiles) {
      for (const file of files.filter((held) => seen.has(held))) {
        problems.push(
          `${named(file)}, which holds ${module}, is reachable from ${named(entry)} other than through ${confined.importer}'s dynamic import of ${confined.command}`,
        );
      }
    }
  }
  return problems;
}

/** Packs `staged` into `out`, reads the tarball back, and refuses it on any problem `check` finds. */
function packAndCheck(staged, out, check) {
  const tarball = packStaged(staged.directory, out);
  const read = readTarball(tarball);
  const problems = check(read, staged);
  if (problems.length > 0) {
    throw new Error(
      `pack-requestport refuses ${basename(tarball)}:\n- ${problems.join("\n- ")}`,
    );
  }
  return { staged, tarball, entries: read };
}

/**
 * The command (this module's header, `main`). `treeStatus`, `log` and
 * `build` are its inputs and output, for its test: the command line has no
 * way to pass them.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    treeStatus = readTreeStatus,
    log = (line) => process.stdout.write(`${line}\n`),
    build = () => buildWeb(),
  } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: { version: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  refuseVersion(values.version);
  const before = treeStatus();
  refuseDirtyTree(before);
  const out = resolve(
    values.out ?? mkdtempSync(join(tmpdir(), "pack-requestport-")),
  );
  refuseStageDirectory(out);
  mkdirSync(out, { recursive: true });

  // requestport's stage first: its refusals come before any other build.
  const stagedRequestport = await stageRequestport({
    version: values.version,
    directory: join(out, "stage", "requestport"),
  });
  const packs = {};
  for (const [key, pack] of Object.entries(PACKAGES)) {
    packs[key] = packAndCheck(
      await stagePackage(pack, {
        version: values.version,
        directory: join(out, "stage", key),
      }),
      out,
      checkTarball,
    );
  }
  packs.web = packAndCheck(
    await stageWeb({
      version: values.version,
      directory: join(out, "stage", "web"),
      build,
    }),
    out,
    checkWebTarball,
  );
  packs.client = packAndCheck(
    await stageClient({
      version: values.version,
      directory: join(out, "stage", "client"),
    }),
    out,
    checkClientTarball,
  );
  packs.requestport = packAndCheck(
    stagedRequestport,
    out,
    checkRequestportTarball,
  );
  const ordered = Object.values(packs);
  const run = [
    ...(await checkRun(ordered)),
    ...(await runConfinementProblems(ordered)),
  ];
  if (run.length > 0) {
    throw new Error(`pack-requestport refuses the run:\n- ${run.join("\n- ")}`);
  }

  refuseChangedTree(before, treeStatus());
  const record = buildRecord(
    ordered.map(({ staged, tarball, entries: read }) =>
      tarballFacts(tarball, read, staged.manifest),
    ),
    { treeStatus: before },
  );
  writeFileSync(
    join(out, "build-record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  log(JSON.stringify(record, null, 2));
  log(`pack-requestport: tarballs and build-record.json are in ${out}`);
  return { out, record, packs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
