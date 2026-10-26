# Changelog

Each RequestPort release publishes its packages together, at one version.
This file records each release, the newest first.

## 0.2.4

**What.** The fourteen packages at `0.2.4`, together, as before. The web
console is redesigned on `@cueplusplus/ui` 0.29.0: its shell, requests,
overview, agents, settings and sign-in pages. Appearance takes six settings.
Requests can be assigned, from the console, over REST and over MCP. Two
migrations.

**Why.** The console was hard to read: the default appearance was the
all-monospace `requestport` theme at ultra-compact density. The redesign
follows a prototype the owner agreed.

**Impact.**

- **Appearance.** There are six settings: theme (any cue-ui theme), mode,
  density (now including `compact`), typeface, Look and surface. Owners and
  admins set the organization's default; everyone can choose differently
  for themselves. A new organization starts on the `cue` theme at normal
  density.
- **Migration `0026`** adds the new appearance columns. It moves every
  organization still exactly on the old untouched default to `cue` and
  normal, with one event each, and leaves an organization anyone had edited
  as it was.
- **Migration `0027`** adds `agent_oauth_grants.last_used_at`. An API key's
  or OAuth grant's last use is written at most once every five minutes, and
  the agents page shows when each agent last signed in.
- **New REST commands:**
  - `POST /api/v1/commands/resend_organization_invitation` (operator
    credentials, `members:manage`);
  - `POST /api/v1/commands/assign_request` (agents, `request:triage`), also
    an MCP tool.
- **A new event, `request.assigned.v1`.** Webhook subscribers receive it,
  and the person assigned gets an email. Deploy the worker before the web
  application, so the worker handles the event before anyone assigns.
- **The console's pages:**
  - Requests shows names instead of ids, member pickers in its filters, and
    a count on each view.
  - Settings pages that fail or do not exist keep the settings navigation.
  - Members shows when each person joined and can resend an invitation.
  - The overview gains a setup card, which can be hidden, and a health line.
- **One version, as before.** `requestport` 0.2.4 depends on each of the
  other thirteen packages at exactly `0.2.4`, and `latest` moves to `0.2.4`.
- **Supported versions.** Security fixes go to the latest `0.x` release
  only, as `SECURITY.md` says, so 0.2.3 receives none from now on.

## 0.2.3

**What.** The fourteen packages at `0.2.3`, together, as before. The web
application's navigation gains an "Operator keys" link, to the page where
people issue operator credentials. The development tools' last four
advisories are gone.

**Why.**

- **The operator credentials page was reachable only by its URL.** It
  shipped that way so it could stay hidden until a deployment turned operator
  credentials on. The hosted service has now turned them on, so the page gets
  its link.
- **`pnpm audit` still reported four moderate advisories.** vitest 4.1.10 had
  GHSA-82fw-gwwq-j7x9 and GHSA-qxg6-89mg-rqv8, and esbuild 0.18.20 had
  GHSA-67mh-4wv8-2f99. They were all in development tools: none of them is in
  what `requestport start` runs.

**Impact.**

- **New link: Operator keys.** Every signed-in person sees it, between
  Operations and Agents. Owners and admins see every operator credential in
  their organization; a member sees their own.
- **Self-hosted instances: off until you turn it on.** The page issues
  nothing unless the server's environment sets
  `REQUESTPORT_OPERATOR_CREDENTIALS=enabled`. With it unset, the default, the
  link opens the page's notice that operator credentials are off.
- **Development tools.** vitest moves to 4.1.12. esbuild 0.18.20, which only
  drizzle-kit's `@esbuild-kit` loader carried, leaves the tree. `pnpm audit
  --prod` reports no known vulnerabilities. No runtime package changes.
- **Nothing else changes.** The REST API, MCP and the web application behave
  exactly as in 0.2.2, apart from the new link. No migration.
- **One version, as before.** `requestport` 0.2.3 depends on each of the
  other thirteen packages at exactly `0.2.3`, and `latest` moves to `0.2.3`.
- **Supported versions.** Security fixes go to the latest `0.x` release only,
  as `SECURITY.md` says, so 0.2.2 receives none from now on.

## 0.2.2

**What.** The fourteen packages at `0.2.2`, together, as before. `requestport
start` now takes a doubled Ctrl-C as one stop, as `requestport worker` has
since 0.2.0.

**Why.** Run through `npx`, or from a `package.json` script under pnpm or npm,
`requestport start` gets a terminal's Ctrl-C twice, milliseconds apart: once
from the terminal and once passed on by the launcher. `start` took the second
copy as a demand to stop at once. It exited with code 1 without closing its
listener, its worker or its database. On PostgreSQL with work in flight, that
happened in 11 of 12 runs.

**Impact.**

- **Fixed: `requestport start`.** A second SIGTERM or SIGINT less than one
  second after the first is now the same stop. `start` logs it in one line
  ("the same stop, which goes on"), then closes its listener, its worker and
  every storage, and exits 0. A second signal one second or more after the
  first still stops it at once, with code 1, as before. `start --help` and
  the README's "What a first start does" say so.
- **Nothing else changes.** The REST API, MCP, the web application and every
  other package behave exactly as in 0.2.1. No migration.
- **One version, as before.** `requestport` 0.2.2 depends on each of the
  other thirteen packages at exactly `0.2.2`, and `latest` moves to `0.2.2`.
- **Supported versions.** Security fixes go to the latest `0.x` release only,
  as `SECURITY.md` says, so 0.2.1 receives none from now on.

## 0.2.1

**What.** The fourteen packages at `0.2.1`, together, as before. Every
package now depends on zod 4.6.7, which closes the advisory 0.2.0 shipped
with. What the REST API and MCP accept and return is unchanged, except for
one answer that is the fix itself.

**Why.**

- **0.2.0's known issue.** zod before 4.6.6 has GHSA-mrhx-c7xc-m3w5 (high).
  It spends memory on an issue for every element of a collection that is
  over its size limit, so a large enough array could exhaust a process's
  memory. 0.2.0 shipped with it, so that its Next.js fixes reached you
  without delay, and said 0.2.1 would move zod.
- **zod 4.5 and 4.6 changed other answers too.** They count string lengths
  differently, require seconds in a datetime, strip whitespace from URLs,
  and word some messages differently. A patch release should not change
  your API, so 0.2.1 keeps 0.2.0's answers.

**Impact.**

- **Security: zod 4.6.7.** GHSA-mrhx-c7xc-m3w5 is closed in every package.
- **One answer changes, because it is the fix:** an array over its size
  limit is now refused by its size alone, before its elements are read.
  - On REST and MCP, the refusal's `details.field` names the array (for
    example `choices`), where it named its first bad element
    (`choices.0`).
  - MCP's refusal text lists only the size issue.
  - A check on the whole command that runs after the array, such as
    `create_routing_rule`'s check that its conditions are unique, no longer
    runs for that request.
- **Everything else is as in 0.2.0:**
  - string lengths are counted in UTF-16 units;
  - a datetime without seconds is accepted (`ask_question`'s `deadlineAt`
    of `2026-10-24T12:30Z`, for example);
  - a URL keeps its tabs and newlines;
  - email addresses are matched by the same pattern;
  - messages read as they did;
  - an own `__proto__` key in a request body is dropped, as before.

  The published OpenAPI document and MCP's list of tools are byte for byte
  0.2.0's.
- **Additive: `@requestport/domain`** exports eight helpers that keep zod
  4.4.3's answers: `utf16Max`, `utf16Min`, `isoDatetimePattern`,
  `isoDatetime`, `trimmedUrl`, `emailPattern`, `english443` and
  `dropOwnProtoKeys`. Loading the package sets zod's English messages to
  4.4.3's words, as 0.2.0's zod already did when it loaded.
- **A correction to 0.2.0's notes.** They said zod could exhaust memory
  validating a large array "against a schema with no length limit". The
  advisory is about collections that *have* a size limit, and zod 4.6.7
  fixes those. An array with no limit is still read in full. On REST and
  MCP, RequestPort refuses a body of more than 17,000 JSON values before
  zod reads it.
- **Migration.** None, unless a client reads `details.field` from the
  refusal of an oversized array: it now names the array.
- **One version, as before.** `requestport` 0.2.1 depends on each of the
  other thirteen packages at exactly `0.2.1`, and `latest` moves to
  `0.2.1`.
- **Supported versions.** Security fixes go to the latest `0.x` release
  only, as `SECURITY.md` says, so 0.2.0 receives none from now on.

## 0.2.0

**What.** The fourteen packages at `0.2.0`, together, as before. This
release tightens what the API accepts, and fixes how a person's session and
an agent's provisioning grant are checked at the moment of a write. It
moves Next.js to 16.4.2, for two critical advisories and one high, and fixes
how `requestport worker` stops. It is the first release published from this
repository's own workflow, with npm provenance.

**Why.**

- **Unbounded input.** A work update's evidence, an artifact's provenance
  and a question's structured answer were free-form JSON with no limit on
  their size or nesting. A body could hold 100,000 JSON values. The largest
  call a legitimate client makes holds about 16,500.
- **A check that could go stale.** A person's session was checked before a
  write, not during it. A session that ended between the two could still
  manage webhooks, issue or rotate an agent's key, or bind an OAuth consent.
  `provision_agent` did not read its provisioning grant before writing.
- **A worker that lost its work on Ctrl-C.** Run from a `package.json`
  script, `requestport worker` gets a terminal's Ctrl-C twice: once from
  the terminal and once passed on by pnpm or npm. The worker took the second
  copy as a demand to exit at once. So it stopped without finishing the jobs
  it was running.
- **Next.js 16.3.8's advisories,** published 2026-10-22. 0.1.0's
  `@requestport/web` depends on `next` 16.3.8:
  - GHSA-2464-fhr4-w9xw, critical: unauthenticated remote code execution in
    the Image Optimization API when SVG files are used;
  - GHSA-673q-mjm6-r5xr, critical: unauthenticated remote code execution in
    `use cache` functions returning typed arrays;
  - GHSA-p3m5-59mp-jv5r, high: denial of service in the App Router with
    Server Actions.
- **Publishing.** 0.1.0 was published by hand, with no provenance.

**Impact.**

- **Breaking: limits on free-form input** (`@requestport/domain`, so REST
  and MCP alike):
  - `post_work_update`'s `evidence`: at most 10,000 elements, nested at most
    8 deep, and 262,144 bytes;
  - `attach_artifact`'s `provenance` and `answer_question`'s
    `structuredValue`: at most 2,000 elements, 8 deep, and 65,536 bytes;
  - a value past a limit is refused as a validation error, whose details
    name the limit (`bound`: `elements`, `depth` or `bytes`) and its
    `maximum`.
- **Breaking: smaller request bodies** (`@requestport/server`,
  `@requestport/mcp`): a REST or MCP request body holding more than 17,000
  JSON values is refused as `validation_failed`, "JSON input is too
  complex". Before, the limit was 100,000. Split larger batches.
- **Breaking: the database role guard only enforces**
  (`@requestport/db`):
  - its `modes` option accepts only `"enforce"`, and any other value throws
    a `TypeError` when the guard is built;
  - its reports no longer give the status `"warned"`;
  - a caller that passed another mode removes it, and the guard enforces
    every check, as RequestPort's own surfaces already did.
- **Breaking, only for callers who build it themselves:**
  `ProjectProvisioningOptions` (`@requestport/core`) requires a
  `provisioningGrant()`. `createRequestPort` supplies it, so its callers
  change nothing.
- **Security: Next.js 16.4.2.** `@requestport/web` depends on `next`
  16.4.2, which closes the three advisories above, so `requestport start`
  serves it. If you run 0.1.0, upgrade.
  - RequestPort's web application uses no `use cache` and does not enable
    SVG images. It does use Server Actions.
  - One runtime difference: a request naming a Server Action that does not
    exist is now answered `409` or `400`, with `x-nextjs-action-not-found:
    1`, where it was `404`.
- **Known issue: zod's GHSA-mrhx-c7xc-m3w5 (high).** Before 4.6.6, zod can
  exhaust memory when it validates a very large array against a schema with
  no length limit. 0.2.0 still depends on zod 4.4.3 (4.5.4 in
  `@requestport/auth`).
  - REST and MCP refuse a body holding more than 17,000 JSON values before
    zod reads it.
  - The web application's Server Actions have not been measured against
    it.
  - This release ships with it so that the Next.js fixes reach you now.
    0.2.1 moves zod to a patched version.
- **Security: checked at the write.**
  - Managing a webhook, issuing or rotating an agent's key, and binding an
    OAuth consent now re-read the person's session inside the write's own
    transaction. A session that ended in between is refused, and nothing is
    written.
  - `provision_agent` refuses before it writes when the provisioning grant
    is missing, revoked, expired, of another kind or another person's, or
    was delegated by someone who is no longer an active owner or admin.
  - Each of these calls makes one more indexed read. An agent's calls are
    unchanged.
- **Fixed: `requestport worker`.** A second SIGTERM or SIGINT less than one
  second after the first is now the same stop: the worker logs
  `worker.stop_repeated` and finishes what it is running. A second signal
  one second or more after the first still exits at once, with status 1, as
  before. `requestport start` and `serve` are unchanged: under pnpm or npm,
  a terminal's Ctrl-C may still make them exit at once. That has not been
  measured yet.
- **Provenance.** Each package is published by this repository's
  `.github/workflows/publish.yml`, from the files of this release's GitHub
  release, through npm trusted publishing, with provenance.
  `npm audit signatures` verifies it.
- **Migration.** A client within the limits above changes nothing. A client
  that sends larger evidence, provenance, answers or batches must split
  them. A caller that passed `modes` to the role guard removes it.
- **One version, as before.** `requestport` 0.2.0 depends on each of the
  other thirteen packages at exactly `0.2.0`, and `latest` moves to `0.2.0`.
- **Supported versions.** Security fixes go to the latest `0.x` release
  only, as `SECURITY.md` says, so 0.1.0 receives none from now on.

## 0.1.0

**What.** RequestPort's first public release: the source in this
repository, and fourteen npm packages, each at `0.1.0`, under the Apache
License, Version 2.0 (`Apache-2.0`):

- `requestport`, the command that runs an instance on your own machine;
- `@requestport/web`, the web application `requestport start` serves;
- `@requestport/auth`, `@requestport/client`, `@requestport/config`,
  `@requestport/core`, `@requestport/db`, `@requestport/domain`,
  `@requestport/importer`, `@requestport/jobs`, `@requestport/mcp`,
  `@requestport/notifications`, `@requestport/server` and
  `@requestport/webhooks`: with `@requestport/web`, the packages
  `requestport` depends on.

**Why.** This release is for running RequestPort yourself, rather than on
the hosted service at `requestport.com`. `requestport start` serves the
REST API, MCP, the web application and the background worker from one
Node.js process, on PGlite or on PostgreSQL, and agents reach it through
`requestport login`, `link` and `mcp`. `README.md` has the quick start, and
how to build this repository from source.

**Impact.**

- **Nothing to upgrade from.** This is the first release, so there is no
  migration.
- **One version.** `requestport` 0.1.0 depends on each of the other
  thirteen packages at exactly `0.1.0`, so installing it installs that set.
- **Where it runs.** Node.js 22, on Linux on x64 and on arm64 with glibc,
  and on macOS on arm64. Windows, Linux with musl and macOS on x64 are not
  among the supported platforms.
- **Security fixes** go to the latest `0.x` release only, as `SECURITY.md`
  says under "Supported versions".
- **Licence.** Each package's tarball carries the licence's text as
  `LICENSE`.
