import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

import {
  checkDocument,
  DOCUMENT_PATH,
  errorAnswers,
  generateOpenApiDocument,
  loadDomainModule,
  loadZod,
  queryDescription,
  queryOperation,
  renderDocument,
  repositoryRoot,
} from "./generate-openapi.mjs";

const document = await generateOpenApiDocument();
const metadata = await loadDomainModule("transport-metadata.ts");
const { z } = await loadZod();
const generator = resolve(import.meta.dirname, "generate-openapi.mjs");

/** The JSON Schema zod gives for a value schema, as the generator embeds it. */
function converted(schema) {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    io: "input",
  });
  return rest;
}

/** Follows one local `$ref` to what it names. */
function resolveReference(reference) {
  assert.match(reference, /^#\//u, `${reference} is not a local reference`);
  let target = document;
  for (const segment of reference.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(
      target !== null && typeof target === "object" && key in target,
      `${reference} does not resolve (at ${segment})`,
    );
    target = target[key];
  }
  return target;
}

function operation(method, path) {
  const found = document.paths[path]?.[method];
  assert.ok(found, `${method.toUpperCase()} ${path} is not in the document`);
  return found;
}

function commandInputSchema(transport) {
  const body = operation("post", transport.path).requestBody.content[
    "application/json"
  ].schema;
  return resolveReference(body.properties.input.$ref);
}

function everyValue(value, visit, path = "#") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      everyValue(child, visit, `${path}/${index}`);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      everyValue(child, visit, `${path}/${key}`);
    }
  }
}

describe("the OpenAPI document generated from the transport metadata", () => {
  test("covers every transport the metadata records, and nothing else", () => {
    // Derived, not counted: a transport added to the metadata must appear
    // here, and one removed must go. The metadata must not be empty, or the
    // comparison below would hold over nothing.
    assert.ok(metadata.restCommandTransports.length > 0);
    assert.ok(metadata.restQueryTransports.length > 0);

    const documented = Object.entries(document.paths)
      .flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    const recorded = [
      ...metadata.restCommandTransports,
      ...metadata.restQueryTransports,
    ]
      .map((transport) => `${transport.method} ${transport.path}`)
      .sort();

    assert.deepEqual(documented, recorded);
    assert.equal(document.openapi, "3.1.0");
  });

  test("names each command and each read by its own name", () => {
    const ids = [];
    for (const transport of metadata.restCommandTransports) {
      const found = operation("post", transport.path);
      assert.equal(found.operationId, transport.name);
      ids.push(found.operationId);
    }
    for (const transport of metadata.restQueryTransports) {
      const found = operation("get", transport.path);
      assert.equal(found.operationId, transport.name);
      ids.push(found.operationId);
    }
    assert.equal(new Set(ids).size, ids.length, "operationIds must be unique");
  });

  /*
    Plan 13, F.2.0: a read may be bound to the organization and have no MCP
    tool. Reads of each binding are built here, so every binding is described
    whichever the registry's entries use.
  */
  test("describes a read by its binding, and names one with no MCP tool by its own name", () => {
    const read = {
      name: "f2_probe_read",
      method: "GET",
      path: `${metadata.administrationBasePath}/probes/{probeId}`,
      pathParameters: ["probeId"],
      queryParameters: [],
      scope: "org:read",
      rateLimitClass: "token",
      mcpTool: null,
    };
    const bound = (binding, overrides = {}) => ({
      ...read,
      binding,
      routeRequiresProject: binding === "project",
      ...overrides,
    });
    const found = queryOperation(z, bound("project"), metadata.restApiBasePath);
    assert.equal(found.operationId, "f2_probe_read");
    assert.equal(found.summary, "/administration/probes/{probeId}");
    assert.equal(found["x-requestport-mcp-tool"], null);
    assert.equal(found["x-requestport-route-requires-project"], true);
    assert.deepEqual(found.security, [{ agentBearer: ["org:read"] }]);
    assert.deepEqual(
      Object.fromEntries(
        ["project", "organization", "organization-or-project"].map(
          (binding) => [binding, queryDescription(bound(binding))],
        ),
      ),
      {
        project:
          "The route checks the scope before it reads, and refuses a credential bound to no project.",
        organization:
          "The route checks the scope before it reads, and refuses a credential bound to a project.",
        "organization-or-project":
          "The route checks the scope before it reads, and admits a credential bound to a project or to none. A credential bound to a project is answered about that project alone where the rows belong to projects; rows that belong to no project, such as the organisation's members, are answered in full.",
      },
    );
    assert.throws(
      () => queryDescription(bound("organization", { scope: null })),
      /f2_probe_read is not bound to a project and checks no scope/u,
    );
    // An administration read refuses every agent credential (§4.1, rule 2),
    // so `agentBearer` would be a false security requirement for it. One
    // whose `credentialKinds` admits operators (F.3, ruling 25) publishes
    // `operatorBearer` alone, even when it names agents too; one that admits
    // no operator is read by no credential, so there is nothing true to
    // write, and the generator refuses rather than publish a false one.
    for (const binding of ["organization", "organization-or-project"]) {
      for (const credentialKinds of [undefined, ["agent"]])
        assert.throws(
          () =>
            queryOperation(
              z,
              bound(binding, credentialKinds ? { credentialKinds } : {}),
              metadata.restApiBasePath,
            ),
          /f2_probe_read is bound to .+, and the document has no security scheme for the credential that may read it/u,
          binding,
        );
      for (const credentialKinds of [["operator"], ["agent", "operator"]])
        assert.deepEqual(
          queryOperation(
            z,
            bound(binding, { credentialKinds }),
            metadata.restApiBasePath,
          ).security,
          [{ operatorBearer: ["org:read"] }],
          `${binding} ${credentialKinds.join(",")}`,
        );
    }
    // Every read the registry holds outside the administration prefix is
    // still bound to a project, and keeps the description it had before
    // bindings existed. The administration reads (F.2.0b on) are described
    // by their own binding.
    const administration = metadata.restQueryTransports.filter((transport) =>
      transport.path.startsWith(`${metadata.administrationBasePath}/`),
    );
    assert.ok(administration.length > 0);
    for (const transport of metadata.restQueryTransports) {
      const described = operation("get", transport.path).description;
      if (administration.includes(transport)) {
        assert.notEqual(transport.binding, "project", transport.name);
        assert.equal(described, queryDescription(transport), transport.name);
        continue;
      }
      assert.equal(transport.binding, "project", transport.name);
      assert.match(
        described,
        /refuses a credential bound to no project|bound to a project(, and any operator credential,)? reaches this/u,
        transport.name,
      );
    }
  });

  test("never shows a field the route writes over the caller's input", () => {
    let injectedChecked = 0;
    for (const transport of metadata.restCommandTransports) {
      const source = converted(transport.inputSchema);
      const shown = commandInputSchema(transport);
      const injected = new Set(
        transport.injectedFields.map((injection) => injection.field),
      );

      for (const field of injected) {
        // The domain's schema declares it — so its absence below is the
        // generator's doing, not a field that was never there.
        assert.ok(
          field in source.properties,
          `${transport.name}: ${field} is not in the domain schema`,
        );
        assert.ok(
          !(field in shown.properties),
          `${transport.name}: injected ${field} is shown as a property`,
        );
        assert.ok(
          !(shown.required ?? []).includes(field),
          `${transport.name}: injected ${field} is shown as required`,
        );
        injectedChecked += 1;
      }

      // Everything else the domain declares is still there, with its own
      // required list less the injected fields.
      assert.deepEqual(
        Object.keys(shown.properties),
        Object.keys(source.properties).filter((field) => !injected.has(field)),
        transport.name,
      );
      assert.deepEqual(
        shown.required ?? [],
        (source.required ?? []).filter((field) => !injected.has(field)),
        transport.name,
      );
      assert.deepEqual(
        shown["x-requestport-injected-fields"],
        undefined,
        "the injected fields are recorded on the operation, not the schema",
      );
      assert.deepEqual(
        operation("post", transport.path)["x-requestport-injected-fields"],
        transport.injectedFields,
      );
    }
    assert.ok(injectedChecked > 0);
  });

  test("strips action from the lifecycle names and keeps it on transition_request", () => {
    const transition = metadata.restCommandTransports.find(
      (transport) => transport.name === "transition_request",
    );
    const accept = metadata.restCommandTransports.find(
      (transport) => transport.name === "accept_request",
    );

    assert.ok("action" in commandInputSchema(transition).properties);
    assert.ok(commandInputSchema(transition).required.includes("action"));
    assert.ok(!("action" in commandInputSchema(accept).properties));
    assert.ok(!("organizationId" in commandInputSchema(accept).properties));
  });

  test("keeps the domain's own field descriptions", () => {
    // `register_project`'s fields carry `.meta({ description })`; the
    // conversion must bring them into the document.
    const registration = metadata.restCommandTransports.find(
      (transport) => transport.name === "register_project",
    );
    const shown = commandInputSchema(registration);

    assert.match(shown.properties.alias.description, /alias/u);
    assert.match(shown.properties.repositoryUrl.description, /GitHub/u);
  });

  test("says in words the register_project rule its schema cannot show", () => {
    // The object-level refine (one of alias or repositoryUrl) has no JSON
    // Schema form, so the shown schema requires neither field; the operation's
    // description has to carry the rule instead of claiming the schema does.
    const registration = metadata.restCommandTransports.find(
      (transport) => transport.name === "register_project",
    );
    const { description } = operation("post", registration.path);

    assert.equal(commandInputSchema(registration).required, undefined);
    assert.match(description, /one of `alias` or `repositoryUrl` is required/u);
    assert.doesNotMatch(description, /describes the checks/u);
  });

  test("wraps each command's input in the route's strict envelope", () => {
    for (const transport of metadata.restCommandTransports) {
      const found = operation("post", transport.path);
      assert.equal(found.requestBody.required, true);
      const envelope = found.requestBody.content["application/json"].schema;
      assert.equal(envelope.type, "object");
      assert.equal(envelope.additionalProperties, false);
      assert.deepEqual(envelope.required, [
        "idempotencyKey",
        "expectedVersion",
      ]);
      assert.deepEqual(
        envelope.properties.idempotencyKey,
        converted(metadata.restCommandEnvelopeFields.idempotencyKey),
      );
      assert.deepEqual(
        envelope.properties.expectedVersion,
        converted(metadata.restCommandEnvelopeFields.expectedVersion),
      );
      assert.deepEqual(Object.keys(envelope.properties), [
        "input",
        "idempotencyKey",
        "expectedVersion",
      ]);
    }
  });

  test("states each scope as a security requirement, under each scheme the entry admits", () => {
    assert.deepEqual(document.components.securitySchemes.agentBearer, {
      type: "http",
      scheme: "bearer",
      description: document.components.securitySchemes.agentBearer.description,
    });
    assert.deepEqual(document.components.securitySchemes.operatorBearer, {
      type: "http",
      scheme: "bearer",
      description:
        document.components.securitySchemes.operatorBearer.description,
    });
    // Plan 13, F.3: an entry's `credentialKinds` name the schemes, agents
    // before operators; an entry that names none admits agents only.
    const schemes = (transport) =>
      transport.credentialKinds.map((kind) =>
        kind === "operator" ? "operatorBearer" : "agentBearer",
      );

    for (const transport of metadata.restCommandTransports) {
      const found = operation("post", transport.path);
      if (transport.scope.kind === "fixed") {
        assert.deepEqual(
          found.security,
          schemes(transport).map((scheme) => ({
            [scheme]: [transport.scope.scope],
          })),
        );
      } else {
        const scopes = [...new Set(Object.values(transport.scope.scopes))];
        assert.deepEqual(
          found.security,
          schemes(transport).flatMap((scheme) =>
            scopes.sort().map((scope) => ({ [scheme]: [scope] })),
          ),
        );
        assert.deepEqual(
          found["x-requestport-scope-by-action"],
          transport.scope.scopes,
        );
      }
      assert.equal(
        found["x-requestport-scope-checked-by"],
        transport.scope.checkedBy,
      );
      assert.equal(
        found["x-requestport-rate-limit-class"],
        transport.rateLimitClass,
      );
    }
    for (const transport of metadata.restQueryTransports) {
      const found = operation("get", transport.path);
      assert.deepEqual(
        found.security,
        schemes(transport).map((scheme) => ({
          [scheme]: transport.scope === null ? [] : [transport.scope],
        })),
      );
      assert.equal(
        found["x-requestport-rate-limit-class"],
        transport.rateLimitClass,
      );
    }
  });

  test("names operatorBearer on exactly the operations whose entry admits operators", () => {
    const withOperator = [];
    for (const [path, methods] of Object.entries(document.paths))
      for (const [method, found] of Object.entries(methods))
        if (
          found.security?.some((requirement) => "operatorBearer" in requirement)
        )
          withOperator.push(`${method.toUpperCase()} ${path}`);
    // Each group's operations under its own name, in no particular order:
    // the whole is flattened and sorted where it is compared, so no entry
    // has to sit under another group's comment to keep the list sorted. A
    // group that lands adds its own array; one operation listed twice fails
    // the comparison, since the document names each operation once.
    const operatorOperations = {
      // F.2.0b: the three shared administration reads.
      "F.2.0b": [
        "GET /api/v1/administration/projects",
        "GET /api/v1/administration/lanes",
        "GET /api/v1/administration/members",
      ],
      // F.3: whoami, which admits an agent too, and the operator revocation.
      "F.3": [
        "GET /api/v1/whoami",
        "POST /api/v1/commands/revoke_operator_credential",
      ],
      // Plan 13, F.2.3: the project settings read and its eleven commands.
      "F.2.3": [
        "GET /api/v1/administration/projects/{projectId}/settings",
        "POST /api/v1/commands/add_project_alias",
        "POST /api/v1/commands/add_project_repository",
        "POST /api/v1/commands/set_default_project_repository",
        "POST /api/v1/commands/set_project_repository_status",
        "POST /api/v1/commands/add_project_lane",
        "POST /api/v1/commands/set_default_project_lane",
        "POST /api/v1/commands/set_project_lane_status",
        "POST /api/v1/commands/set_project_member",
        "POST /api/v1/commands/set_project_work_policy",
        "POST /api/v1/commands/update_project_metadata",
        "POST /api/v1/commands/set_project_status",
      ],
      // Plan 13, F.2.1: the routing rules read, route evaluation, and the
      // three routing rule commands.
      "F.2.1": [
        "GET /api/v1/administration/routing-rules",
        "GET /api/v1/administration/route-evaluations/test",
        "GET /api/v1/administration/route-evaluations/preview",
        "POST /api/v1/commands/create_routing_rule",
        "POST /api/v1/commands/update_routing_rule",
        "POST /api/v1/commands/disable_routing_rule",
      ],
      // Plan 13, F.2.2: agent administration — its two reads, the
      // suspension, and the two revocations off the bus.
      "F.2.2": [
        "GET /api/v1/administration/agent-principals",
        "GET /api/v1/administration/agent-principals/{agentPrincipalId}",
        "POST /api/v1/commands/set_agent_principal_status",
        "POST /api/v1/commands/revoke_agent_credential",
        "POST /api/v1/commands/revoke_agent_oauth_grant",
      ],
      // Plan 13, F.2.4: the operations and retention hold reads, the
      // two retention hold commands and the four requeues.
      "F.2.4": [
        "GET /api/v1/administration/operations",
        "GET /api/v1/administration/retention-holds",
        "POST /api/v1/commands/create_retention_hold",
        "POST /api/v1/commands/release_retention_hold",
        "POST /api/v1/commands/requeue_outbox",
        "POST /api/v1/commands/requeue_notification",
        "POST /api/v1/commands/requeue_slack_operation",
        "POST /api/v1/commands/requeue_import_dispatch",
      ],
      // Plan 13, F.2.5: the Slack configuration read, the three Slack
      // administration commands, and the connection test, off the bus.
      "F.2.5": [
        "GET /api/v1/administration/slack",
        "POST /api/v1/commands/set_slack_installation_status",
        "POST /api/v1/commands/set_slack_user_mapping",
        "POST /api/v1/commands/set_slack_route",
        "POST /api/v1/commands/send_slack_connection_test",
      ],
      // Plan 13, F.2.6: the two import run reads, import review, and the
      // split, off the bus.
      "F.2.6": [
        "GET /api/v1/administration/import-runs",
        "GET /api/v1/administration/import-runs/{runId}",
        "POST /api/v1/commands/review_legacy_import_entry",
        "POST /api/v1/commands/split_legacy_import_entry",
      ],
      // Plan 13, F.2.7: the invitations and organisation appearance reads,
      // and the four member, invitation and appearance commands.
      "F.2.7": [
        "GET /api/v1/administration/invitations",
        "GET /api/v1/administration/appearance",
        "POST /api/v1/commands/invite_organization_member",
        "POST /api/v1/commands/set_organization_member",
        "POST /api/v1/commands/revoke_organization_invitation",
        "POST /api/v1/commands/appearance.update_organization_defaults.v1",
      ],
      // Ruling 263: resending an invitation, beside revoking one.
      "ruling 263": ["POST /api/v1/commands/resend_organization_invitation"],
    };
    assert.deepEqual(
      withOperator.sort(),
      Object.values(operatorOperations).flat().sort(),
    );
    // F.2.0b's reads refuse every agent credential, so they name the
    // operator's scheme alone, with the scope the route checks.
    for (const [path, scope] of [
      ["/api/v1/administration/projects", "project:read"],
      ["/api/v1/administration/lanes", "project:read"],
      ["/api/v1/administration/members", "org:read"],
    ])
      assert.deepEqual(
        operation("get", path).security,
        [{ operatorBearer: [scope] }],
        path,
      );
    // An administration read publishes the operator scheme alone, with its
    // scope, and says a project-bound credential is answered about its own
    // project only.
    const settings = operation(
      "get",
      "/api/v1/administration/projects/{projectId}/settings",
    );
    assert.deepEqual(settings.security, [
      { operatorBearer: ["project:manage"] },
    ]);
    assert.equal(settings["x-requestport-mcp-tool"], null);
    assert.equal(settings["x-requestport-route-requires-project"], false);
    assert.match(
      settings.description,
      /A credential bound to a project is answered about that project alone/u,
    );
    // Plan 13, F.2.1: its three reads are bound to the organisation, so each
    // says a project-bound credential is refused, and each names the scope
    // its form checks.
    for (const [path, scope] of [
      ["/api/v1/administration/routing-rules", "routing:manage"],
      ["/api/v1/administration/route-evaluations/test", "routing:manage"],
      ["/api/v1/administration/route-evaluations/preview", "request:create"],
    ]) {
      const read = operation("get", path);
      assert.deepEqual(read.security, [{ operatorBearer: [scope] }], path);
      assert.equal(read["x-requestport-mcp-tool"], null, path);
      assert.equal(read["x-requestport-route-requires-project"], false, path);
      assert.match(
        read.description,
        /refuses a credential bound to a project/u,
      );
    }
    for (const name of [
      "create_routing_rule",
      "update_routing_rule",
      "disable_routing_rule",
    ])
      assert.deepEqual(
        operation("post", `/api/v1/commands/${name}`).security,
        [{ operatorBearer: ["routing:manage"] }],
        name,
      );
    // Plan 13, F.2.4: its two reads are bound to the organisation too: the
    // operator scheme alone, with their scope, and a project-bound credential
    // refused.
    for (const path of [
      "/api/v1/administration/operations",
      "/api/v1/administration/retention-holds",
    ]) {
      const read = operation("get", path);
      assert.deepEqual(
        read.security,
        [{ operatorBearer: ["operations:manage"] }],
        path,
      );
      assert.equal(read["x-requestport-mcp-tool"], null, path);
      assert.equal(read["x-requestport-route-requires-project"], false, path);
      assert.match(
        read.description,
        /refuses a credential bound to a project\./u,
        path,
      );
    }
    // Plan 13, F.2.5: the Slack read, bound to the organisation, says a
    // credential bound to a project is refused; each Slack command publishes
    // the operator scheme alone, with `slack:manage`.
    const slack = operation("get", "/api/v1/administration/slack");
    assert.deepEqual(slack.security, [{ operatorBearer: ["slack:manage"] }]);
    assert.equal(slack["x-requestport-mcp-tool"], null);
    assert.equal(slack["x-requestport-route-requires-project"], false);
    assert.match(slack.description, /refuses a credential bound to a project/u);
    for (const name of [
      "set_slack_user_mapping",
      "set_slack_route",
      "set_slack_installation_status",
      "send_slack_connection_test",
    ])
      assert.deepEqual(
        operation("post", `/api/v1/commands/${name}`).security,
        [{ operatorBearer: ["slack:manage"] }],
        name,
      );
    // The connection test is off the bus: it says where it runs and who
    // checks its scope, by its own dispatch line and `checkedBy` text alone.
    const connectionTest = operation(
      "post",
      "/api/v1/commands/send_slack_connection_test",
    );
    assert.deepEqual(connectionTest["x-requestport-dispatch"], {
      to: "slack-connection-test",
    });
    assert.equal(
      connectionTest["x-requestport-scope-checked-by"],
      "slack-connection-test-handler",
    );
    assert.equal(connectionTest["x-requestport-mcp-tool"], null);
    assert.equal(connectionTest["x-requestport-route-requires-project"], false);
    assert.match(
      connectionTest.description,
      /The route hands `input` to the Slack connection test's handler, off the command bus/u,
    );
    assert.match(
      connectionTest.description,
      /The scope is checked by the Slack connection test's handler/u,
    );
    assert.doesNotMatch(
      connectionTest.description,
      /import split|agent administration handler|agent key or grant service|project registration repository/u,
    );
    // Plan 13, F.2.7: its two reads are the organisation's, so they publish
    // the operator scheme alone, with `members:manage`, and say a credential
    // bound to a project is refused.
    for (const path of [
      "/api/v1/administration/invitations",
      "/api/v1/administration/appearance",
    ]) {
      const read = operation("get", path);
      assert.deepEqual(read.security, [{ operatorBearer: ["members:manage"] }]);
      assert.equal(read["x-requestport-mcp-tool"], null, path);
      assert.equal(read["x-requestport-route-requires-project"], false, path);
      assert.match(
        read.description,
        /refuses a credential bound to a project/u,
      );
    }
    for (const name of [
      "invite_organization_member",
      "set_organization_member",
      "revoke_organization_invitation",
      "resend_organization_invitation",
      "appearance.update_organization_defaults.v1",
    ])
      assert.deepEqual(
        operation("post", `/api/v1/commands/${name}`).security,
        [{ operatorBearer: ["members:manage"] }],
        name,
      );
    assert.deepEqual(
      operation("post", "/api/v1/commands/revoke_operator_credential").security,
      [{ operatorBearer: ["operator:revoke"] }],
    );
    // Plan 13, F.2.6: import review, operators alone under `import:write`
    // (an agent scope too, which the scheme does not admit here). The split
    // says where it runs and who checks its scope; each read says a bound
    // credential is answered about its own project.
    for (const name of [
      "review_legacy_import_entry",
      "split_legacy_import_entry",
    ])
      assert.deepEqual(
        operation("post", `/api/v1/commands/${name}`).security,
        [{ operatorBearer: ["import:write"] }],
        name,
      );
    const split = operation(
      "post",
      "/api/v1/commands/split_legacy_import_entry",
    );
    assert.equal(
      split["x-requestport-scope-checked-by"],
      "import-split-handler",
    );
    assert.equal(split["x-requestport-mcp-tool"], null);
    assert.match(
      split.description,
      /The route hands `input` to the import split's handler, off the command bus/u,
    );
    assert.match(
      split.description,
      /The scope is checked by the import split's handler/u,
    );
    // The registry halves' stack: F.2.2's two revocations and this split are
    // both off the bus, each dispatched to its own target and described by
    // its own dispatch line and `checkedBy` text alone.
    assert.deepEqual(split["x-requestport-dispatch"], { to: "import-split" });
    assert.doesNotMatch(
      split.description,
      /agent administration handler|agent key or grant service|project registration repository/u,
    );
    for (const name of ["revoke_agent_credential", "revoke_agent_oauth_grant"])
      assert.doesNotMatch(
        operation("post", `/api/v1/commands/${name}`).description,
        /import split/u,
        name,
      );
    for (const path of [
      "/api/v1/administration/import-runs",
      "/api/v1/administration/import-runs/{runId}",
    ]) {
      const read = operation("get", path);
      assert.deepEqual(read.security, [{ operatorBearer: ["import:write"] }]);
      assert.equal(read["x-requestport-mcp-tool"], null, path);
      assert.equal(read["x-requestport-route-requires-project"], false, path);
      assert.match(
        read.description,
        /A credential bound to a project is answered about that project alone/u,
        path,
      );
    }
    assert.deepEqual(operation("get", "/api/v1/whoami").security, [
      { agentBearer: [] },
      { operatorBearer: [] },
    ]);
    // Plan 13, F.2.2: agent administration publishes the operator's scheme
    // alone, under `agent:revoke`. The two revocations say where they run and
    // who checks the scope, since neither is a bus command.
    for (const [method, path] of [
      ["get", "/api/v1/administration/agent-principals"],
      ["get", "/api/v1/administration/agent-principals/{agentPrincipalId}"],
      ["post", "/api/v1/commands/set_agent_principal_status"],
      ["post", "/api/v1/commands/revoke_agent_credential"],
      ["post", "/api/v1/commands/revoke_agent_oauth_grant"],
    ]) {
      const found = operation(method, path);
      assert.deepEqual(found.security, [{ operatorBearer: ["agent:revoke"] }]);
      assert.equal(found["x-requestport-mcp-tool"], null, path);
      assert.equal(found["x-requestport-route-requires-project"], false, path);
    }
    for (const name of [
      "revoke_agent_credential",
      "revoke_agent_oauth_grant",
    ]) {
      const found = operation("post", `/api/v1/commands/${name}`);
      assert.deepEqual(found["x-requestport-dispatch"], {
        to: "agent-administration",
        handler: name,
      });
      assert.equal(
        found["x-requestport-scope-checked-by"],
        "agent-auth-service",
        name,
      );
      assert.match(
        found.description,
        /agent administration handler, off the command bus/u,
        name,
      );
      assert.match(
        found.description,
        /checked by the agent key or grant service/u,
        name,
      );
      assert.doesNotMatch(
        found.description,
        /project registration repository/u,
        name,
      );
    }
  });

  test("describes each query parameter by its recorded value schema", () => {
    let queryChecked = 0;
    for (const transport of metadata.restQueryTransports) {
      const parameters = operation("get", transport.path).parameters ?? [];
      assert.deepEqual(
        parameters.map((parameter) => [parameter.in, parameter.name]),
        [
          ...transport.pathParameters.map((name) => ["path", name]),
          ...transport.queryParameters.map((query) => ["query", query.name]),
        ],
        transport.path,
      );
      for (const name of transport.pathParameters) {
        const parameter = parameters.find(
          (candidate) => candidate.name === name,
        );
        assert.equal(parameter.required, true);
        assert.deepEqual(parameter.schema, { type: "string" });
      }
      for (const query of transport.queryParameters) {
        const parameter = parameters.find(
          (candidate) =>
            candidate.in === "query" && candidate.name === query.name,
        );
        const value = converted(query.valueSchema);
        // Required exactly when the registry marks it so; absent is optional.
        assert.equal(
          parameter.required,
          query.required === true,
          `${transport.path} ${query.name}`,
        );
        assert.equal(parameter.description, query.description);
        if (query.repeated) {
          assert.equal(parameter.style, "form");
          assert.equal(parameter.explode, true);
          assert.deepEqual(parameter.schema, {
            type: "array",
            items: value,
            ...(query.maxCount === undefined
              ? {}
              : { maxItems: query.maxCount }),
          });
        } else {
          assert.deepEqual(parameter.schema, {
            ...value,
            ...(query.defaultValue === undefined
              ? {}
              : { default: query.defaultValue }),
          });
        }
        queryChecked += 1;
      }
    }
    assert.ok(queryChecked > 0);

    // Plan 13, F.2.1: route evaluation refuses a route without a target
    // project, a request type or a priority, and the document says so; the
    // source project, lane and agent principal stay optional.
    const requiredQuery = (path) =>
      Object.fromEntries(
        operation("get", path)
          .parameters.filter((parameter) => parameter.in === "query")
          .map((parameter) => [parameter.name, parameter.required]),
      );
    assert.deepEqual(
      requiredQuery("/api/v1/administration/route-evaluations/test"),
      {
        sourceProjectId: false,
        targetProjectId: true,
        requestType: true,
        priority: true,
        laneId: false,
        agentPrincipalId: false,
      },
    );
    assert.deepEqual(
      requiredQuery("/api/v1/administration/route-evaluations/preview"),
      {
        sourceProjectId: false,
        targetProjectId: true,
        requestType: true,
        priority: true,
      },
    );

    const state = operation("get", "/api/v1/requests").parameters.find(
      (parameter) => parameter.name === "state",
    );
    assert.equal(state.schema.maxItems, 20);
    assert.ok(state.schema.items.enum.includes("in_progress"));
  });

  test("gives no response schema, because none is recorded, and says so", () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, found] of Object.entries(item)) {
        const success = found.responses["200"];
        assert.ok(success, `${method} ${path} has no 200`);
        assert.equal(success.content, undefined, `${method} ${path}`);
        assert.match(success.description, /no response schema is recorded/iu);
      }
    }
    assert.match(document.info.description, /no response schema/iu);
  });

  test("answers every operation with the route's error envelope", () => {
    const codes = errorAnswers.flatMap((answer) => answer.codes);
    assert.equal(new Set(codes).size, codes.length, "a code has one status");

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, found] of Object.entries(item)) {
        const expected = errorAnswers
          .filter(
            (answer) =>
              answer.methods === undefined ||
              answer.methods.includes(method.toUpperCase()),
          )
          .map((answer) => String(answer.status));
        const statuses = Object.keys(found.responses).filter(
          (status) => status !== "200",
        );
        assert.deepEqual(statuses.sort(), expected.sort(), `${method} ${path}`);
      }
    }

    for (const answer of errorAnswers) {
      const response = resolveReference(
        `#/components/responses/Status${answer.status}`,
      );
      const schema = response.content["application/json"].schema;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.properties.error.enum, answer.codes);
      assert.equal("details" in schema.properties, answer.details !== "none");
      assert.equal(
        (schema.required ?? []).includes("details"),
        answer.details === "always",
      );
    }
    assert.ok(
      "WWW-Authenticate" in
        resolveReference("#/components/responses/Status401").headers,
    );
    assert.ok(
      "Retry-After" in
        resolveReference("#/components/responses/Status429").headers,
    );
  });

  test("resolves every $ref inside the document, and leaves no $defs behind", () => {
    let references = 0;
    everyValue(document, (value, path) => {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        assert.ok(!("$defs" in value), `${path} keeps a $defs`);
        assert.ok(!("$schema" in value), `${path} keeps a $schema`);
        if (typeof value.$ref === "string") {
          resolveReference(value.$ref);
          references += 1;
        }
      }
    });
    assert.ok(references > 0);
  });
});

describe("the committed document", () => {
  test("is what the generator produces from the tree as it is", async () => {
    const result = await checkDocument();
    assert.equal(
      result.upToDate,
      true,
      `${DOCUMENT_PATH} is stale: run node scripts/generate-openapi.mjs`,
    );
  });

  test("reads as stale once anything in it differs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openapi-check-"));
    try {
      const tampered = JSON.parse(renderDocument(document));
      tampered.paths["/api/v1/whoami"].get.security = [];
      const path = join(directory, "openapi.json");
      writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);

      assert.equal((await checkDocument({ path })).upToDate, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("is checked and written by the command line", () => {
    const checked = spawnSync(process.execPath, [generator, "--check"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /up to date/u);

    const directory = mkdtempSync(join(tmpdir(), "openapi-write-"));
    try {
      const out = join(directory, "openapi.json");
      const written = spawnSync(process.execPath, [generator, "--out", out], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
      assert.equal(written.status, 0, written.stderr);
      assert.equal(readFileSync(out, "utf8"), renderDocument(document));

      const stale = spawnSync(
        process.execPath,
        [generator, "--check", "--out", join(directory, "missing.json")],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /generate-openapi\.mjs/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
