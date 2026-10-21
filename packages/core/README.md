# @requestport/core

RequestPort as a library: `createRequestPort(options)` composes RequestPort
over the storages you build, and answers a `RequestPort`.

## Entries

- `@requestport/core`: `createRequestPort`, the `RequestPort` it answers
  and the types of its options; every name those declarations reach that no
  other entry of this package exports; and what it re-exports from
  `@requestport/db` to build its storages.
- `@requestport/core/migrate`: `migrate` and `MigrationReport`.
- `@requestport/core/agent-services`: the agent API key and OAuth grant
  services.
- `@requestport/core/adapters`: names the repository's web application
  imports from core beyond `@requestport/core`, and `resolveRestQuery`,
  which `@requestport/server` imports.

## A person's command context

A person acts in process through a session Better Auth wrote.
`port.signIn({ email, credential })` answers it as a `PersonSession`: the
session's `id`, and its user's `userId`.

### What `execute` builds from a person's call

`port.execute(name, input, call)` takes a person's call as a
`PersonCapabilityCall`:

```ts
await port.execute("create_request_draft", input, {
  person, // the PersonSession signIn answered
  organizationId, // the organisation the command runs in
  meta: { idempotencyKey, expectedVersion },
});
```

It admits only the commands of the in-process rule
(`inProcessPersonCommands`, in `src/person.ts`), and refuses any other name
as `forbidden`. It runs the command as a context it builds itself:

- `actor`: `{ type: "user", id: person.userId }`;
- `organizationId`: the call's;
- `scopes`: the scopes a signed-in person carries, the list below;
- `credentialId`: `person.id`, the session's id;
- `correlationId`: a new UUID, which the command's events carry.

### Building it by hand

A member that takes a context rather than a call needs the context built by
its caller: the command bus's `execute` (`port.commandBus`), the off-bus
handlers (`port.handlers`), the webhook management methods
(`port.mcpOnly.webhooks`), and the services of
`@requestport/core/agent-services`. Core publishes no builder of a person's
context, so build it as `execute` does:

```ts
import { randomUUID } from "node:crypto";

import type { NetworkCapabilityCall, PersonSession } from "@requestport/core";

/** A command context: `@requestport/core` exports no name for its type. */
type CommandContext = NetworkCapabilityCall["context"];

/** The scopes `execute` gives a signed-in person, in core's order. */
const HUMAN_SCOPES = [
  "org:read",
  "project:read",
  "project:manage",
  "request:create",
  "request:read",
  "request:write",
  "request:triage",
  "request:complete",
  "request:verify",
  "routing:manage",
  "work:claim",
  "work:update",
  "question:answer",
  "agent:manage",
  "agent:register",
  "workspace:telemetry:reveal",
  "webhook:manage",
  "import:write",
  "operator:manage",
  "operations:manage",
  "slack:manage",
  "members:manage",
];

export function personContext(
  person: PersonSession,
  organizationId: string,
): CommandContext {
  return {
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: new Set(HUMAN_SCOPES),
    credentialId: person.id,
    correlationId: randomUUID(),
  };
}
```

`scripts/core-tarball-smoke/consumer.ts` builds it the same way
(`personContext`), against the packed tarballs.

What the context is checked against:

- The command bus re-checks it in each command's transaction, before the
  command runs. `credentialId` must name an unexpired session of `actor.id`
  while that user is an active member of the active organisation
  `organizationId`, or an active organisation-wide provisioning grant that
  user delegated to an agent, while that user is an active owner or admin of
  that organisation. Otherwise the command is refused as
  `forbidden`, "Current human authorization is no longer active".
- That re-check does not read `scopes`. A person's scopes are the context's
  own word, and a command's own checks read them as given, so give a person
  the list above, as `execute` does.
- Off the bus, a member checks the context by its own rules. These run the
  same re-check first, and refuse in its words:
  - the off-bus handlers (`port.handlers`), in the transaction each opens;
  - the five webhook management methods (`port.mcpOnly.webhooks`), for a
    person's context;
  - `issue`, `rotate` and `bindConsent` of
    `@requestport/core/agent-services`, for a person's context. Composed
    without their `authorization`, they refuse it as `configuration_error`.

  The webhook methods and the agent services run the re-check before the
  method's own work, and its locks are not held into that work, as the bus
  holds them into a command's. `revoke` and `revokeGrant` of
  `@requestport/core/agent-services` do not run it: called directly, they
  re-check no session, and the off-bus handlers run it before they call
  them. Build a person's context only from a session your own code has
  verified, such as the one `signIn` answered.

## An agent's context

REST and MCP, as `@requestport/server` serves them, build an agent's context
from the credential their authenticator verified. With `@requestport/auth`'s,
the context carries the stored key's scopes and lanes or, for an OAuth access
token, the grant's lanes and those of the grant's scopes that the token names
(`authenticate-bearer.ts`' `context`), so a token's context never holds a
scope its grant does not.

On the read path, an agent context's `scopes` and `laneIds` are taken at
their word. That path is `port.query`'s agent queries and
`port.agentQueries`. Each query refuses a context that lacks the query's
scope and reads within the context's lanes. The repository re-checks that
the agent's authorization is still active, not that the context's scopes
and lanes are the credential's. Project registration likewise checks the
scope the context states, and the webhook replay
(`port.mcpOnly.webhooks.replay`) the scope and lanes it states; each
re-checks that the authorization is active.

A context built by hand is taken as given, as code holding the database
credentials already is. Build an agent's context only from a credential your
own code has verified.
