#!/usr/bin/env node
/**
 * Writes the OpenAPI 3.1 document for the REST API at `/api/v1`, from the
 * transport metadata `@requestport/domain` records (Plan 13, B2).
 *
 *   node scripts/generate-openapi.mjs            write the committed document
 *   node scripts/generate-openapi.mjs --check    exit 1 if it is stale
 *   --out <path>                                 write or check another path
 *
 * What it reads, and nothing else: `restApiBasePath`, `restCommandTransports`,
 * `restQueryTransports` and `restCommandEnvelopeFields` from
 * `packages/domain/src/transport-metadata.ts`. Request and query schemas are
 * `z.toJSONSchema` of the very zod objects the metadata holds, converted as
 * input (what a caller sends), with the fields the route writes over the
 * caller's input removed. No response schema is emitted: the metadata records
 * none, and the document says so rather than inventing one.
 *
 * Two things are written here from the route's handlers rather than read
 * from the metadata, which records them only in prose or not at all: the
 * envelope's `input` member and its strictness (`commandEnvelopeSchema`),
 * and the error answers — `errorAnswers` below is `responseError` in
 * `packages/server/src/rest.ts` restated, the module whose handlers
 * `apps/web/src/app/api/v1/[[...path]]/route.ts` composes (Plan 13, H.1).
 * `apps/web/src/app/docs/api/openapi-errors.test.ts` runs that route and holds
 * the committed document's error answers to what it sends.
 *
 * The document is committed rather than built, and
 * `scripts/generate-openapi.test.mjs` fails when it is stale. Loading the
 * domain here needs its TypeScript source transformed (see
 * `registerDomainLoader`), which the Next build has no reason to do; a
 * committed file also puts every change to the public contract in a diff.
 *
 * Needs Node 22.15 or later: `registerHooks` arrived in 22.15 and
 * `stripTypeScriptTypes` in 22.13. `package.json` allows any Node 22, so an
 * earlier 22 fails here, and with it `node --test scripts/*.test.mjs`;
 * `.node-version` pins 22.22.3.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createRequire,
  registerHooks,
  stripTypeScriptTypes,
} from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = resolve(import.meta.dirname, "..");

/** Relative to the repository root. Under `generated/`, which Biome skips. */
export const DOCUMENT_PATH = "apps/web/src/app/docs/api/generated/openapi.json";

const domainPackage = resolve(repositoryRoot, "packages/domain");
const domainSource = resolve(domainPackage, "src");
const domainSourceUrl = `${pathToFileURL(domainSource).href}/`;

let loaderRegistered = false;

/**
 * Lets this process import `packages/domain/src/**` as it is on disk.
 *
 * Two things stand in the way, and this hook handles exactly those two, for
 * files under that directory only. The source imports its siblings as `.js`
 * (NodeNext style), which exist only as `.ts`; and it uses TypeScript
 * parameter properties, which Node's default type stripping refuses, so each
 * file is transformed with `stripTypeScriptTypes` in `transform` mode. Node
 * prints an ExperimentalWarning for that function once per process.
 */
function registerDomainLoader() {
  if (loaderRegistered) return;
  loaderRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL?.startsWith(domainSourceUrl) &&
        specifier.startsWith(".") &&
        specifier.endsWith(".js") &&
        !existsSync(fileURLToPath(new URL(specifier, context.parentURL)))
      ) {
        return nextResolve(specifier.replace(/\.js$/u, ".ts"), context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(domainSourceUrl) && url.endsWith(".ts")) {
        return {
          format: "module",
          shortCircuit: true,
          source: stripTypeScriptTypes(
            readFileSync(fileURLToPath(url), "utf8"),
            {
              mode: "transform",
              sourceUrl: url,
            },
          ),
        };
      }
      return nextLoad(url, context);
    },
  });
}

/** Imports one module of `packages/domain/src`, by its path under `src`. */
export async function loadDomainModule(path) {
  registerDomainLoader();
  return import(pathToFileURL(resolve(domainSource, path)).href);
}

/**
 * The zod the domain itself depends on, as the ES module the domain imports,
 * so each schema is converted by the loaded copy that built it rather than by
 * whichever zod another workspace happens to resolve. (Descriptions would
 * survive a second copy either way: zod keeps its metadata registry on
 * `globalThis`.)
 */
export async function loadZod() {
  const require = createRequire(join(domainPackage, "package.json"));
  const commonJsEntry = require.resolve("zod");
  const root = dirname(commonJsEntry);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return import(pathToFileURL(join(root, manifest.exports["."].import)).href);
}

/**
 * `responseError` in the `/api/v1` route's handlers
 * (`packages/server/src/rest.ts`), as data: each status it answers, the
 * `error` codes that reach it, and whether the body carries `details`.
 *
 * `details` is `always` for a `DomainError` (an object, possibly empty), `none`
 * for the answers built without one, and `sometimes` for 422, which a
 * `DomainError` reaches with details and a `ZodError` without. 413 and 415 are
 * raised only by POST: the body-size limit and the content-type check run in
 * the POST handler alone.
 */
export const errorAnswers = [
  {
    status: 401,
    codes: ["unauthenticated"],
    details: "always",
    summary: "The credential is missing, invalid or not for this resource.",
  },
  {
    status: 403,
    codes: ["forbidden"],
    details: "always",
    summary:
      "The credential lacks a scope, role or binding the operation requires, or is bound to no project where one is required.",
  },
  {
    status: 404,
    codes: ["not_found"],
    details: "always",
    summary: "No such command, path or tenant-scoped resource.",
  },
  {
    status: 409,
    codes: [
      "conflict",
      "idempotency_conflict",
      "version_conflict",
      "route_denied",
      "invalid_state",
      "invalid_transition",
      "already_answered",
    ],
    details: "always",
    summary:
      "The operation conflicts with current state, the expected version or an earlier use of the idempotency key, or the routing policy denies it.",
  },
  {
    status: 413,
    codes: ["request_too_large"],
    details: "none",
    methods: ["POST"],
    summary: "The request body is over the route's size limit.",
  },
  {
    status: 415,
    codes: ["unsupported_media_type"],
    details: "none",
    methods: ["POST"],
    summary: "The request is not Content-Type: application/json.",
  },
  {
    status: 422,
    codes: ["validation_failed"],
    details: "sometimes",
    summary:
      "The body, the envelope, the input or a query parameter is invalid.",
  },
  {
    status: 429,
    codes: ["rate_limited"],
    details: "always",
    summary: "Too many requests; retry later.",
  },
  {
    status: 500,
    codes: ["unexpected_error"],
    details: "none",
    summary: "The operation failed for a reason the route does not name.",
  },
  {
    status: 503,
    codes: ["configuration_error"],
    details: "always",
    summary: "RequestPort is temporarily unavailable.",
  },
];

/**
 * What survives into `details`, per `publicDomainDetails` in the route's
 * handlers (`packages/server/src/rest.ts`).
 */
const errorDetailsSchema = {
  type: "object",
  properties: {
    field: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,128}$" },
    retryAfterSeconds: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

function errorResponse(answer) {
  const properties = {
    error: { type: "string", enum: answer.codes },
    message: { type: "string" },
    ...(answer.details === "none"
      ? {}
      : { details: { $ref: "#/components/schemas/ErrorDetails" } }),
  };
  const headers = {
    ...(answer.status === 401
      ? {
          "WWW-Authenticate": {
            description:
              "A Bearer challenge naming the protected-resource metadata for /api/v1.",
            schema: { type: "string" },
          },
        }
      : {}),
    ...(answer.status === 429
      ? {
          "Retry-After": {
            description:
              "Sent when the limiter reports a delay, as that number; details.retryAfterSeconds carries it raised to a whole second, at least one.",
            schema: { type: "string" },
          },
        }
      : {}),
  };
  return {
    description: answer.summary,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties,
          required: [
            "error",
            "message",
            ...(answer.details === "always" ? ["details"] : []),
          ],
          additionalProperties: false,
        },
      },
    },
  };
}

function errorResponsesFor(method) {
  return Object.fromEntries(
    errorAnswers
      .filter(
        (answer) =>
          answer.methods === undefined || answer.methods.includes(method),
      )
      .map((answer) => [
        String(answer.status),
        { $ref: `#/components/responses/Status${answer.status}` },
      ]),
  );
}

/**
 * One zod schema as an embeddable JSON Schema: converted as input, with the
 * dialect marker dropped and any `$defs` moved into `components.schemas` under
 * `<name>.<def>`, its references rewritten to match. A `#/$defs/…` reference
 * left inside an OpenAPI component would resolve against the document root,
 * where there is no `$defs`.
 */
function embeddedSchema(z, schema, name, components) {
  const {
    $schema: _dialect,
    $defs,
    ...converted
  } = z.toJSONSchema(schema, {
    io: "input",
  });
  if ($defs === undefined) return converted;
  if (components === undefined) {
    throw new Error(`${name}: a schema with $defs needs somewhere to put them`);
  }

  const renamed = (reference) =>
    reference.replace(
      /^#\/\$defs\/(.+)$/u,
      (_match, def) => `#/components/schemas/${name}.${def}`,
    );
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "$ref" && typeof child === "string"
          ? renamed(child)
          : rewrite(child),
      ]),
    );
  };
  for (const [def, definition] of Object.entries($defs)) {
    components[`${name}.${def}`] = rewrite(definition);
  }
  return rewrite(converted);
}

/**
 * The command's input as a caller sends it: its schema less every field the
 * route writes over the caller's. A field the metadata says is injected but
 * the schema does not declare is an error here, not something to skip.
 */
function withoutInjectedFields(schema, transport) {
  const injected = new Set(transport.injectedFields.map(({ field }) => field));
  if (injected.size === 0) return schema;
  if (schema.type !== "object" || schema.properties === undefined) {
    throw new Error(
      `${transport.name}: cannot strip injected fields from a schema that is not a plain object`,
    );
  }
  for (const field of injected) {
    if (!(field in schema.properties)) {
      throw new Error(
        `${transport.name}: injected field ${field} is not in its schema`,
      );
    }
  }
  const { properties, required, ...rest } = schema;
  const kept = (required ?? []).filter((field) => !injected.has(field));
  return {
    ...rest,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([field]) => !injected.has(field)),
    ),
    ...(kept.length > 0 ? { required: kept } : {}),
  };
}

function describeInjection(injection) {
  const value =
    injection.from === "constant"
      ? `the constant ${JSON.stringify(injection.value)}`
      : `the credential's ${injection.from.slice("credential.".length)}`;
  return `\`${injection.field}\` (${value})`;
}

/** What each place a scope is checked (`checkedBy`) is said to check. */
const scopeCheckedBy = {
  command:
    "A scope is necessary, never sufficient: the command also checks roles, claims, project and lane bindings and actor type.",
  "project-registration-repository":
    "The scope is checked by the project registration repository. It is necessary; what else that repository checks is not recorded here.",
  // Plan 13, F.2.2.
  "agent-auth-service":
    "The scope is checked by the agent key or grant service the handler calls. It is necessary, never sufficient: the service and its repository also check the member's role, the credential's project binding and the version.",
  // Plan 13, F.2.6.
  "import-split-handler":
    "The scope is checked by the import split's handler. It is necessary, never sufficient: the handler and the import repository also check the member's role, the run's organisation, a project-bound credential's project, and the version.",
  // Plan 13, F.2.5.
  "slack-connection-test-handler":
    "The scope is checked by the Slack connection test's handler. It is necessary, never sufficient: the handler refuses a credential bound to a project, and the Slack repository also checks the member's role, the installation's organisation and status, and the version.",
};

function commandDescription(transport) {
  const lines = [];
  if (transport.injectedFields.length > 0) {
    lines.push(
      `The route writes ${transport.injectedFields
        .map(describeInjection)
        .join(
          ", ",
        )} into \`input\` after the caller's fields, so a value sent for one is overwritten. They are left out of the schema shown.`,
    );
  }
  if (transport.dispatch.to === "project-registration-repository") {
    lines.push(
      "The route hands `input` to the project registration repository without parsing it, and the repository applies its own checks. The schema shown is the domain's description of those checks, less its refinements, which have no JSON Schema form: among them, one of `alias` or `repositoryUrl` is required.",
    );
  }
  // Plan 13, F.2.2: the two agent revocations, off the bus.
  if (transport.dispatch.to === "agent-administration") {
    lines.push(
      "The route hands `input` to the agent administration handler, off the command bus. It re-checks the credential in its own transaction and answers a retry from the key or grant service's own receipt.",
    );
  }
  // Plan 13, F.2.6: the import split, off the bus.
  if (transport.dispatch.to === "import-split") {
    lines.push(
      "The route hands `input` to the import split's handler, off the command bus. It re-checks the credential in its own transaction, cuts the record with the legacy parser, and answers a retry from the import repository's own receipt.",
    );
  }
  // Plan 13, F.2.5: the Slack connection test, off the bus.
  if (transport.dispatch.to === "slack-connection-test") {
    lines.push(
      "The route hands `input` to the Slack connection test's handler, off the command bus. It re-checks the credential in its own transaction, queues the test there, answers a retry under the same key with the same operation, and starts the test after that transaction commits; a test it could not start stays pending and is started later.",
    );
  }
  if (transport.scope.kind === "by-action") {
    lines.push(
      "The scope depends on `action`: `x-requestport-scope-by-action` maps each action to the one it requires.",
    );
  }
  if (transport.routeRequiresProject) {
    lines.push(
      "The route refuses a credential bound to no project before dispatch.",
    );
  }
  if (!credentialKindsOf(transport).includes("agent")) {
    lines.push(
      "Only an operator credential reaches this; the route refuses an agent credential before dispatch.",
    );
  }
  // Plan 13, F.3 (F3-9): the one command whose scope has an exemption.
  if (
    transport.dispatch.to === "command-bus" &&
    transport.dispatch.commandName === "revoke_operator_credential"
  ) {
    lines.push(
      "A credential revoking itself needs no scope; `operator:revoke` is required to revoke another.",
    );
  }
  const checkedBy = scopeCheckedBy[transport.scope.checkedBy];
  if (!checkedBy)
    throw new Error(
      `${transport.name}: no description for a scope checked by ${transport.scope.checkedBy}`,
    );
  lines.push(checkedBy);
  return lines.join("\n\n");
}

const noResponseSchema = (what) =>
  `${what} No response schema is recorded for this operation, so none is given.`;

/**
 * The security scheme for each kind of credential an entry admits (Plan 13,
 * F.3): `agentBearer` for agents, `operatorBearer` for operator credentials,
 * agents first. The route refuses a credential of a kind the entry does not
 * name, so an operation lists exactly the schemes its `credentialKinds` does.
 */
function credentialKindsOf(transport) {
  return transport.credentialKinds ?? ["agent"];
}

function schemesFor(transport) {
  return credentialKindsOf(transport).map((kind) =>
    kind === "operator" ? "operatorBearer" : "agentBearer",
  );
}

function commandOperation(z, transport, envelope, schemas) {
  const inputName = `${transport.name}.input`;
  schemas[inputName] = withoutInjectedFields(
    embeddedSchema(z, transport.inputSchema, inputName, schemas),
    transport,
  );
  const scopeAlternatives =
    transport.scope.kind === "fixed"
      ? [transport.scope.scope]
      : [...new Set(Object.values(transport.scope.scopes))].sort();
  const security = schemesFor(transport).flatMap((scheme) =>
    scopeAlternatives.map((scope) => ({ [scheme]: [scope] })),
  );

  return {
    operationId: transport.name,
    summary: transport.name,
    description: commandDescription(transport),
    tags: ["Commands"],
    security,
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              input: {
                $ref: `#/components/schemas/${inputName}`,
                description: "The command's input. Defaults to {} when absent.",
              },
              idempotencyKey: envelope.properties.idempotencyKey,
              expectedVersion: envelope.properties.expectedVersion,
            },
            required: ["idempotencyKey", "expectedVersion"],
            additionalProperties: false,
          },
        },
      },
    },
    responses: {
      200: {
        description: noResponseSchema(
          "`{ result }`, where `result` is the command's own output.",
        ),
      },
      ...errorResponsesFor("POST"),
    },
    ...(transport.scope.kind === "by-action"
      ? { "x-requestport-scope-by-action": transport.scope.scopes }
      : {}),
    "x-requestport-scope-checked-by": transport.scope.checkedBy,
    "x-requestport-injected-fields": transport.injectedFields,
    "x-requestport-dispatch": transport.dispatch,
    "x-requestport-route-requires-project": transport.routeRequiresProject,
    "x-requestport-rate-limit-class": transport.rateLimitClass,
    "x-requestport-mcp-tool": transport.mcpTool,
  };
}

function queryParameter(z, parameter) {
  const value = embeddedSchema(z, parameter.valueSchema, parameter.name);
  return {
    name: parameter.name,
    in: "query",
    required: parameter.required === true,
    description: parameter.description,
    ...(parameter.repeated
      ? {
          style: "form",
          explode: true,
          schema: {
            type: "array",
            items: value,
            ...(parameter.maxCount === undefined
              ? {}
              : { maxItems: parameter.maxCount }),
          },
        }
      : {
          schema: {
            ...value,
            ...(parameter.defaultValue === undefined
              ? {}
              : { default: parameter.defaultValue }),
          },
        }),
  };
}

/**
 * What a read's binding means for the credential that asks. Exported for its
 * test, which describes reads of every binding whichever the registry's
 * entries use.
 */
export function queryDescription(transport) {
  if (transport.scope === null && transport.binding === "project")
    return credentialKindsOf(transport).includes("operator")
      ? "Any authenticated agent credential bound to a project, and any operator credential, reaches this; it needs no scope. An operator is answered from its own credential: its organisation, its project or none, and its scopes."
      : "Any authenticated credential bound to a project reaches this; it needs no scope.";
  // A read bound otherwise is an administration read, and each of those
  // checks a scope (`manifest-f2.md` §4.1, rule 3), so there is no sentence
  // for one that does not.
  if (transport.scope === null)
    throw new Error(
      `${transport.name} is not bound to a project and checks no scope`,
    );
  switch (transport.binding) {
    case "project":
      return "The route checks the scope before it reads, and refuses a credential bound to no project.";
    case "organization":
      return "The route checks the scope before it reads, and refuses a credential bound to a project.";
    case "organization-or-project":
      return "The route checks the scope before it reads, and admits a credential bound to a project or to none. A credential bound to a project is answered about that project alone where the rows belong to projects; rows that belong to no project, such as the organisation's members, are answered in full.";
    default:
      throw new Error(
        `${transport.name} has a binding the generator does not describe: ${transport.binding}`,
      );
  }
}

/**
 * The security requirement a read publishes. A read bound to a project lists
 * a scheme for each kind of credential it admits (`schemesFor`). An
 * administration read refuses every agent credential (`manifest-f2.md` §4.1,
 * rule 2), so it lists `operatorBearer` alone, and only when its
 * `credentialKinds` admits operators (Plan 13, F.3). One that admits none is
 * read by no credential, so there is nothing true to publish, and the
 * generator refuses it rather than name a scheme the route would refuse.
 */
function querySecurity(transport) {
  const scopes = transport.scope === null ? [] : [transport.scope];
  if (transport.binding === "project")
    return schemesFor(transport).map((scheme) => ({ [scheme]: scopes }));
  if (!credentialKindsOf(transport).includes("operator"))
    throw new Error(
      `${transport.name} is bound to ${transport.binding}, and the document has no security scheme for the credential that may read it`,
    );
  return [{ operatorBearer: scopes }];
}

/**
 * One read's operation. Exported for its test, which builds reads of every
 * binding itself rather than take them from the registry.
 */
export function queryOperation(z, transport, basePath) {
  const parameters = [
    ...transport.pathParameters.map((name) => ({
      name,
      in: "path",
      required: true,
      description:
        "No value schema is recorded; the route passes the segment to the repository as given.",
      schema: { type: "string" },
    })),
    ...transport.queryParameters.map((parameter) =>
      queryParameter(z, parameter),
    ),
  ];
  return {
    operationId: transport.name,
    summary: transport.path.slice(basePath.length),
    description: queryDescription(transport),
    tags: ["Reads"],
    security: querySecurity(transport),
    ...(parameters.length > 0 ? { parameters } : {}),
    responses: {
      200: {
        description: noResponseSchema("The repository's answer as JSON."),
      },
      ...errorResponsesFor("GET"),
    },
    "x-requestport-route-requires-project": transport.routeRequiresProject,
    "x-requestport-rate-limit-class": transport.rateLimitClass,
    "x-requestport-mcp-tool": transport.mcpTool,
  };
}

export async function generateOpenApiDocument() {
  const { z } = await loadZod();
  const {
    restApiBasePath,
    restCommandEnvelopeFields,
    restCommandTransports,
    restQueryTransports,
  } = await loadDomainModule("transport-metadata.ts");

  const schemas = {
    ErrorDetails: errorDetailsSchema,
  };
  const envelope = embeddedSchema(
    z,
    z.object(restCommandEnvelopeFields),
    "envelope",
    schemas,
  );
  const paths = {};
  for (const transport of restQueryTransports) {
    paths[transport.path] = {
      get: queryOperation(z, transport, restApiBasePath),
    };
  }
  for (const transport of restCommandTransports) {
    paths[transport.path] = {
      post: commandOperation(z, transport, envelope, schemas),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "RequestPort REST API",
      version: "v1",
      description: [
        `The agent API at \`${restApiBasePath}\`. Generated by \`scripts/generate-openapi.mjs\` from \`packages/domain/src/transport-metadata.ts\`; do not edit it by hand.`,
        "Request schemas are each command's own input schema, less the fields the route writes over the caller's input. Checks made in code — zod refinements, and the repositories' own checks — have no JSON Schema form and are not shown.",
        "No response schema is recorded for any operation: a command answers `{ result }` with its own output, and a read answers the repository's rows, and neither declares a schema. The document gives none rather than invent one.",
      ].join("\n\n"),
    },
    tags: [
      {
        name: "Commands",
        description: `POST ${restApiBasePath}/commands/{name}, each with a JSON envelope.`,
      },
      { name: "Reads", description: "GET paths, each project-scoped." },
    ],
    paths,
    components: {
      securitySchemes: {
        agentBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "An agent credential, sent as `Authorization: Bearer …`. Browser cookies are not accepted. The scopes an operation lists are the ones the credential must hold.",
        },
        operatorBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "An operator credential: an `rpo_` key a person issues for a script, a CI job or the self-host CLI, sent as `Authorization: Bearer …`. It acts with the live authority of the member who issued it, narrowed by its scopes and, if the issuer chose, to one project. It reaches only the operations that list this scheme, and only while the deployment has operator credentials switched on. The scopes an operation lists are the ones the credential must hold.",
        },
      },
      schemas,
      responses: Object.fromEntries(
        errorAnswers.map((answer) => [
          `Status${answer.status}`,
          errorResponse(answer),
        ]),
      ),
    },
  };
}

/** The document as it is committed: two-space JSON and a final newline. */
export function renderDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Whether the document at `path` is exactly what the tree generates now. A
 * missing file is stale.
 */
export async function checkDocument({
  path = resolve(repositoryRoot, DOCUMENT_PATH),
} = {}) {
  const expected = renderDocument(await generateOpenApiDocument());
  const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  return { upToDate: actual === expected, expected, actual };
}

function parseArguments(argv) {
  const options = { check: false, out: resolve(repositoryRoot, DOCUMENT_PATH) };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out" && argv[index + 1] !== undefined) {
      options.out = resolve(argv[index + 1]);
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const shown = relative(repositoryRoot, options.out);
  if (options.check) {
    const result = await checkDocument({ path: options.out });
    if (result.upToDate) {
      console.log(`${shown} is up to date`);
    } else {
      console.error(
        `${shown} is stale: run node scripts/generate-openapi.mjs and commit the result`,
      );
      process.exitCode = 1;
    }
  } else {
    const document = renderDocument(await generateOpenApiDocument());
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, document);
    console.log(`wrote ${shown}`);
  }
}
