# Changelog

Each RequestPort release publishes its packages together, at one version.
This file records each release, the newest first.

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
