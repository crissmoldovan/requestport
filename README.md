# RequestPort

RequestPort keeps cross-project work in one canonical record. People work
on its requests and questions in a web application, and agents reach the
same record over MCP and a REST API.

This repository holds its source: the web application, the REST API and
MCP server, the background worker, the database layer, and the
`requestport` command, which runs an instance on your own machine.

## Quick start

`requestport start` initialises an instance and serves it from one Node.js
process: the REST API, MCP, the web application and the background worker,
on PGlite or on PostgreSQL. Agents reach it through `requestport login`,
`link` and `mcp`.

It needs Node.js 22. Every command in this quick start runs through `npx`,
which comes with npm.

It supports three platforms: Linux on x64 and on arm64, with glibc
(`linux-x64` and `linux-arm64`), and macOS on arm64 (`darwin-arm64`).
Windows, Linux with musl, such as Alpine, and macOS on x64 are not among
them.

Each command in this quick start runs `npx requestport@<version>`, where
`<version>` is
the version you run, the same in every command.
`npx requestport@<version> --help` lists the commands, and
`npx requestport@<version> <command> --help` says what one takes.

```sh
npx requestport@<version> --version
```

### Start on PGlite

PGlite needs no PostgreSQL server and no owner URL: its database is inside
the data directory.

```sh
npx requestport@<version> start --storage pglite --email owner@example.com --organization acme --organization-name "Acme"
```

PGlite serves one user on this machine: it binds a loopback address only,
and row-level security does not apply to it, because PGlite connects as its
superuser.

### Start on PostgreSQL

PostgreSQL is `start`'s default storage. It needs a PostgreSQL server and
an owner URL: a `postgres://` URL naming a role and its password, the host,
optionally the port, and the database. `start` connects as that URL's role
to check the server, claim the database for this instance, apply the
migrations and create the instance's four logins.
The owner URL's role must be a superuser, or have both `BYPASSRLS` and
`CREATEROLE`. If the instance's group roles already exist in the cluster,
created by another role, it must also hold `ADMIN OPTION` on each of them.
`start` checks this before it creates or migrates anything, and its
refusal says what to run. A managed PostgreSQL service will do only if it
gives you such a role.
On a server whose `createrole_self_grant` setting includes `inherit` (it is
empty by default), a role that is not a superuser inherits each group role
it creates, and `start` then stops at the migrations with an error that
names that setting.

The owner URL is never accepted as a value on the command line. Give it in
a file that only you can read:

```sh
chmod 600 owner-url.txt
npx requestport@<version> start --owner-url-file owner-url.txt --email owner@example.com --organization acme --organization-name "Acme"
```

Or give it as one line of standard input, with `--owner-url-stdin`. At a
terminal, `start` asks for it, without echoing it, when neither is given.
It keeps the owner URL in the data directory's `owner.json`, which only its
operator step reads, so that every later start can apply new migrations.

### What a first start does

A first start writes its data directory, prepares the database, creates the
owner's account and organisation, and prints the owner's local credential
on standard output. It is shown once, so keep it. Then `start` serves the
instance at its public URL, `http://127.0.0.1:3200` unless you choose
another, with its background worker, until SIGTERM or SIGINT (Ctrl-C) stops
it. A supervisor should signal `start`'s process group, or run the installed
`requestport` bin, because `npm exec` runs `start` through `sh -c`, and on
Debian, whose `sh` is `dash`, that shell does not pass SIGTERM on: a SIGTERM
to `npx`'s own process leaves `start` serving.

A later start serves the same instance. Run `start` again with no owner URL
and none of the owner's details: the data directory holds them.

```sh
npx requestport@<version> start
```

The first start records `--storage`, `--public-url`, `--port`, `--host` and
`--trusted-proxy` in the data directory's `config.json`. A later start
refuses a value that differs from it, unless `--public-url` is given: then
`config.json` records the values given, but for `--storage`, which never
changes.

### Sign in

Open the public URL in a browser, and sign in with the owner's email
address and the local credential the first start printed.

### The rest of the guide

`apps/requestport/README.md` is the `requestport` package's own guide. It
also covers the data directory, the public URL, a lost owner credential,
agents (`login`, `link` and `mcp`), and webhook receivers on your own
network.

## What you run yourself, and what the hosted service adds

RequestPort also runs as a hosted service, at `requestport.com`. A
self-hosted instance differs from it in these ways.

PGlite serves one user on this machine: it binds a loopback address only,
and row-level security does not apply to it, because PGlite connects as its
superuser.

Agents' credentials are bound to this instance's public URL, the issuer
they authenticate against. If it changes, those credentials stop working,
and each agent authorizes again. The hosted service's issuer is a stable
public HTTPS URL that does not move.

requestport serves plain HTTP and terminates no TLS. The hosted service
manages TLS.

An instance on a loopback address can be reached from this machine only,
so nothing on the internet can call it. The hosted service has public
webhook ingress.

requestport start sends no e-mail and offers no sign-in by e-mailed link.
The hosted service sends e-mail, and keeps its deliverability.

requestport start offers no GitHub sign-in. The hosted service's Slack and
GitHub apps are its own, registered to its URLs, and install in one click.

You upgrade, back up and support a self-hosted instance yourself. A later
version's `start` applies its new migrations. Back up the data directory,
which holds the instance's keys, and, on PostgreSQL, the database. The
hosted service upgrades, backs up and supports its instances.

## Build from source

The quick start runs the published `requestport` package. To build this
repository itself, you need Node.js 22. Node.js 22.22.3 is the version
`.node-version` names, and the one the cold build is proved on. You also
need pnpm 11.22.0, the version `packageManager` in `package.json`
pins. Corepack, which comes with Node.js 22, provides that pnpm.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` runs each workspace's `build` script through Turborepo:
TypeScript for the packages, and Next.js for the web application in
`apps/web`. It needs the four variables below.

### Build-time variables

`pnpm build` stops with a `ZodError` while Next.js collects the web
application's page data, unless all four of these are set. The web
application imports `@requestport/config`, which parses them as it is
imported. Give them in the environment `pnpm build` runs in, or in a
`.env.local` at the repository root, which `pnpm build` reads for any
variable its environment does not set.

- `NEXT_PUBLIC_APP_URL=https://requestport.example.com`
- `BETTER_AUTH_URL=https://requestport.example.com`
- `BETTER_AUTH_SECRET=build-time-placeholder-never-a-real-secret`
- `DATABASE_URL=postgres://placeholder@127.0.0.1:9/placeholder`

These placeholders are enough to build. The database URL names no server
(a closed port on loopback) and holds no password.

The build reads the four only because the configuration is parsed as it is
imported: the pages and the server code it builds hold none of their
values. The server parses them again from its environment when it runs,
and that is where real values go: the instance's public URL for
`NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL`, a secret of your own, of at
least 32 characters, for `BETTER_AUTH_SECRET`, and your database for
`DATABASE_URL`.

Never run RequestPort with these placeholders. The secret above is
published here, so it protects nothing.

## Licence

RequestPort is licensed under the Apache License, Version 2.0
(`Apache-2.0`). The licence's text is in `LICENSE`.
`THIRD_PARTY_NOTICES` lists the third-party material this repository
carries, with the licence each is under, and the third-party code that
esbuild writes into the packages it bundles. `@requestport/web`'s npm
tarball carries a `THIRD-PARTY-NOTICES` of its own, for the third-party
code its build compiles in.

## Security

`SECURITY.md` says how to report a vulnerability: privately, through
GitHub's private vulnerability reporting on this repository. Do not report
one in a public issue, a pull request or a discussion.

## About this repository

This repository does not accept outside contributions at the moment.

Comments in the code cite design documents under `docs/` that this
repository does not publish.
