# requestport

RequestPort on your own machine. `requestport start` initialises an
instance and serves it from one Node.js process: the REST API, MCP, the web
application and the background worker, on PGlite or on PostgreSQL. Agents
reach it through `requestport login`, `link` and `mcp`.

It needs Node.js 22. Every command here runs through `npx`, which comes
with npm.

It supports three platforms: Linux on x64 and on arm64, with glibc
(`linux-x64` and `linux-arm64`), and macOS on arm64 (`darwin-arm64`).
Windows, Linux with musl, such as Alpine, and macOS on x64 are not among
them.

## The commands

Each command below runs `npx requestport@<version>`, where `<version>` is
the version you run, the same in every command.
`npx requestport@<version> --help` lists the commands, and
`npx requestport@<version> <command> --help` says what one takes.

```sh
npx requestport@<version> --version
```

## Start on PGlite

PGlite needs no PostgreSQL server and no owner URL: its database is inside
the data directory.

```sh
npx requestport@<version> start --storage pglite --email owner@example.com --organization acme --organization-name "Acme"
```

PGlite serves one user on this machine: it binds a loopback address only,
and row-level security does not apply to it, because PGlite connects as its
superuser.

## Start on PostgreSQL

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

## What a first start does

A first start writes its data directory, prepares the database, creates the
owner's account and organisation, and prints the owner's local credential
on standard output. It is shown once, so keep it. Then `start` serves the
instance at its public URL, `http://127.0.0.1:3200` unless you choose
another, with its background worker, until SIGTERM or SIGINT (Ctrl-C) stops
it. A supervisor should signal `start`'s process group, or run the installed `requestport` bin, because `npm exec` runs `start` through `sh -c`, and on Debian, whose `sh` is `dash`, that shell does not pass SIGTERM on: a SIGTERM to `npx`'s own process leaves `start` serving.

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

## The data directory

On macOS it is `~/Library/Application Support/RequestPort`. On Linux it is
`$XDG_DATA_HOME/requestport`, or `~/.local/share/requestport` when
`XDG_DATA_HOME` is unset. `--data-dir <path>` chooses another; give it to
every command that takes it. One data directory holds one instance, and one
database serves one instance.

It holds `config.json`; `secrets.json`, the instance's keys and, on
PostgreSQL, its logins' passwords; `owner.json`, on PostgreSQL; `init.json`;
`server-action-key`, the web UI's key for its server actions; and, on PGlite,
the database, in `pglite/`. `start` refuses a data directory that is open to
group or others, and writes its JSON files and the key with mode 0600.

## The public URL

The public URL is where people and agents reach the instance. It is https,
or http on a loopback host (`localhost`, a name ending in `.localhost`,
`127.0.0.0/8` or `[::1]`), with no path, user name, password, query or
fragment. requestport terminates no TLS:
to serve anyone beyond this machine it needs an https public URL and, in
front of it, something that terminates TLS. `--trusted-proxy` names a
reverse proxy whose forwarded headers to trust. PGlite binds a loopback
address only.

## Sign in

Open the public URL in a browser, and sign in with the owner's email
address and the local credential the first start printed.

## If the owner's credential is lost

```sh
npx requestport@<version> owner rotate-credential
```

It sets a new local credential for the owner and prints it once. The one
before it no longer signs in, and the owner's sessions and operator
credentials are revoked. It changes nothing else, and never migrates. On
PostgreSQL it runs beside a serving `start`; on PGlite, stop `start` first.

## Agents

An agent reaches the instance through `requestport mcp`, which serves MCP
on standard input and output and forwards it to the instance with an `mcp`
credential stored on this machine. Run `requestport login` first, before
the agent starts `mcp`: the bridge authorizes before it reads its first
message, and an agent's client waits only about a minute for it.

```sh
npx requestport@<version> login --server http://127.0.0.1:3200
```

`login` prints a URL and opens it in a browser, where you sign in, choose
the project and consent. It stores the `mcp` credential for that project
and prints the project's id. Then, in the checkout the agent works in, bind
the checkout to that project:

```sh
npx requestport@<version> link --server http://127.0.0.1:3200 --project <project id>
```

`link` writes `.requestport/project.json`, which names the server and the
project and holds no secret, so it can be committed. Then give the agent
this MCP configuration:

```json
{
  "mcpServers": {
    "requestport": {
      "command": "npx",
      "args": ["requestport@<version>", "mcp"]
    }
  }
}
```

For the REST API's credential, run this in the checkout:

```sh
npx requestport@<version> login --for api
```

`--for both` authorizes both, one after the other, each with its own
consent.

Credentials are kept in the macOS login keychain where macOS has one, and
in a file under `~/.requestport` elsewhere.
`REQUESTPORT_CREDENTIAL_STORE=file` or `REQUESTPORT_CREDENTIAL_STORE=keychain`
chooses one for every command. `--no-browser`, on `login` and `link`,
prints the URL and opens nothing. `REQUESTPORT_NO_BROWSER=1` does the same
for every command, `mcp` included.

## Webhook receivers on your own network

RequestPort delivers webhooks to public receivers only, unless you choose
otherwise. It refuses a webhook endpoint whose address is a loopback,
private, link-local or otherwise non-public one, when the webhook is
registered and again at each delivery, and it requires https, on the
default port or 443.

To deliver to receivers on this machine or your local network, set
`REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS=enabled` in the environment `start`
runs in:

```sh
REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS=enabled npx requestport@<version> start
```

Then RequestPort also admits receivers in these ranges: loopback
(`127.0.0.0/8` and `::1`), the private ranges of RFC 1918 (`10.0.0.0/8`,
`172.16.0.0/12` and `192.168.0.0/16`), shared address space
(`100.64.0.0/10`) and IPv6 unique local addresses (`fc00::/7`). A receiver
whose every address is in them may use plain http and any port, such as
`http://192.168.1.5:8080/`. Every other receiver keeps https, on its
default port or 443. Link-local addresses (`169.254.0.0/16` and
`fe80::/10`) are never admitted, nor are a few known cloud metadata
endpoints inside the admitted ranges, nor unspecified, multicast, broadcast
or other reserved addresses.

`start` does not record the variable: give it to each start that should
admit them. It takes exactly `enabled`; any other value, empty included,
is refused. It is refused wherever `VERCEL_ENV` is set, and unless
`REQUESTPORT_JOB_RUNNER` is `postgres`, which `start` always sets.

## What you run yourself, and what the hosted service adds

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

## Licence

`LICENSE` holds this package's licence. This package holds RequestPort's
own code: it compiles in no third-party code, so it carries no
`THIRD-PARTY-NOTICES`. Every package it depends on, RequestPort's and
third-party, is installed, each in its own directory under `node_modules`,
which holds its licence: the licence its `package.json` declares, and the
licence files it ships. Its web application is the
package `@requestport/web`, which carries a `THIRD-PARTY-NOTICES` for the
third-party code its build compiles in.
