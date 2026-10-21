import {
  type AuthorizedCommandContext,
  admitsCredentialKind,
  type CommandCapability,
  type CredentialKind,
  capabilityRegistry,
  createCoreCommandRegistry,
  DomainError,
  operatorActor,
  restCommandTransports,
} from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import { humanScopes } from "./command-bus.js";
import { type CommandTargets, createCommandExecution } from "./execute.js";
import { inProcessPersonCommands } from "./person.js";

/*
 * Running a registry command through core (manifest-g.md §2.5; Done when 7,
 * for the registry's commands): every command entry reaches its dispatch
 * target under each kind of credential it admits, and is refused under each
 * kind it excludes, exactly where `admitsCredentialKind` says no; a name the
 * registry does not hold, a call whose stated kind is not its context's, and
 * a credential bound to no project where the entry requires one are refused
 * before any target is asked. A person, in process, reaches exactly the
 * commands the in-process rule holds, and nothing else (ruling 63). The
 * targets are stand-ins that record what reached them, so nothing here opens
 * a database.
 */

const organizationId = "018f0000-0000-7000-8000-0000000c0e01";
const projectId = "018f0000-0000-7000-8000-0000000c0e02";
const meta = { idempotencyKey: "core-execute-idempotency", expectedVersion: 0 };

function agentContext(project: string | null = projectId) {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c0e03" },
    organizationId,
    projectId: project,
    scopes: new Set(["request:write"]),
    credentialId: "core-execute-agent-credential",
    correlationId: "018f0000-0000-7000-8000-0000000c0e04",
    // What an agent's context from `@requestport/auth` also carries.
    audience: "api",
    authorizationId: "core-execute-authorization",
    laneIds: new Set<string>(),
  } satisfies AuthorizedCommandContext & Record<string, unknown>;
}

function operatorContext(
  project: string | null = projectId,
): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000c0e05",
      memberUserId: "018f0000-0000-7000-8000-0000000c0e06",
    }),
    credentialKind: "operator",
    organizationId,
    projectId: project,
    scopes: new Set(["agent:revoke"]),
    credentialId: "core-execute-operator-credential",
    correlationId: "018f0000-0000-7000-8000-0000000c0e07",
  };
}

const contextOf: Record<CredentialKind, () => AuthorizedCommandContext> = {
  agent: () => agentContext(),
  operator: () => operatorContext(),
};

/** Stand-in targets, each answering its own name, and every call they saw. */
function recordingTargets() {
  const calls: Array<{ target: string; args: unknown[] }> = [];
  const record =
    (target: string) =>
    async (...args: unknown[]) => {
      calls.push({ target, args });
      return { answeredBy: target };
    };
  const targets: CommandTargets = {
    commandBus: record("commandBus"),
    projectRegistration: record("projectRegistration"),
    agentAdministration: record("agentAdministration"),
    importSplit: record("importSplit"),
    slackConnectionTest: record("slackConnectionTest"),
  };
  return { targets, calls };
}

/** The target and arguments a command entry must reach, for `context` and `input`. */
function expectedCall(
  entry: CommandCapability,
  context: AuthorizedCommandContext,
  input: Record<string, unknown>,
) {
  const { dispatch } = entry;
  switch (dispatch.to) {
    case "command-bus":
      return {
        target: "commandBus",
        args: [{ name: dispatch.commandName, input, context, meta }],
      };
    case "project-registration-repository":
      return { target: "projectRegistration", args: [context, input, meta] };
    case "agent-administration":
      return {
        target: "agentAdministration",
        args: [dispatch.handler, context, input, meta],
      };
    case "import-split":
      return { target: "importSplit", args: [context, input, meta] };
    case "slack-connection-test":
      return { target: "slackConnectionTest", args: [context, input, meta] };
  }
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("execute was not refused");
}

const commands = capabilityRegistry.filter(
  (capability): capability is CommandCapability =>
    capability.kind === "command",
);
const kinds: readonly CredentialKind[] = ["agent", "operator"];

describe("every registry command, through core", () => {
  test("covers every command the registry holds, and no entry names a kind outside CredentialKind", () => {
    expect(commands.map((entry) => entry.name)).toEqual(
      restCommandTransports.map((transport) => transport.name),
    );
    for (const capability of capabilityRegistry) {
      for (const kind of capability.credentialKinds ?? [])
        expect(kinds, capability.name).toContain(kind);
    }
  });

  test.each(
    commands.flatMap((entry) =>
      kinds.map((kind) => [entry.name, kind, entry] as const),
    ),
  )(
    "%s, for an %s credential: reaches its target exactly when admitsCredentialKind admits it",
    async (name, kind, entry) => {
      const { targets, calls } = recordingTargets();
      const execute = createCommandExecution(targets);
      const context = contextOf[kind]();
      const input = { marker: `${name}-input` };

      const outcome = execute(name, input, {
        context,
        credentialKind: kind,
        meta,
      });

      if (admitsCredentialKind(entry, kind)) {
        const expected = expectedCall(entry, context, input);
        await expect(outcome).resolves.toEqual({
          answeredBy: expected.target,
        });
        expect(calls).toEqual([expected]);
      } else {
        const error = await refusal(outcome);
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({
          code: "forbidden",
          message: "This kind of credential is not admitted to this command",
        });
        expect(calls).toEqual([]);
      }
    },
  );

  test("hands each target the caller's context and input objects themselves", async () => {
    const { targets, calls } = recordingTargets();
    const execute = createCommandExecution(targets);
    const context = agentContext();
    const input = { bodyMd: "Hello" };

    await execute("post_message", input, {
      context,
      credentialKind: "agent",
      meta,
    });

    const handed = calls[0]?.args[0] as { input: unknown; context: unknown };
    expect(handed.input).toBe(input);
    expect(handed.context).toBe(context);
  });
});

describe("what core refuses before any target is asked", () => {
  test.each([
    "",
    "constructor",
    "__proto__",
    "whoami",
    "create_agent_principal",
    "claim_request ",
  ])("a name no command entry holds (%j) is not found", async (name) => {
    const { targets, calls } = recordingTargets();
    const error = await refusal(
      createCommandExecution(targets)(
        name,
        {},
        { context: agentContext(), credentialKind: "agent", meta },
      ),
    );

    expect(error).toMatchObject({
      code: "not_found",
      message: "API command was not found",
    });
    expect(calls).toEqual([]);
  });

  test.each([
    [
      "an operator's context stated as an agent's",
      () => operatorContext(),
      "agent",
      "claim_request",
    ],
    [
      "an agent's context stated as an operator's",
      () => agentContext(),
      "operator",
      "revoke_agent_credential",
    ],
    [
      "a person's context stated as an agent's",
      (): AuthorizedCommandContext => ({
        actor: { type: "user", id: "018f0000-0000-7000-8000-0000000c0e08" },
        organizationId,
        projectId,
        scopes: new Set(["request:write"]),
        credentialId: "a-live-session",
        correlationId: "018f0000-0000-7000-8000-0000000c0e09",
      }),
      "agent",
      "post_message",
    ],
  ] as const)(
    "%s is refused as the kind it is not",
    async (_, context, credentialKind, name) => {
      const { targets, calls } = recordingTargets();
      const error = await refusal(
        createCommandExecution(targets)(
          name,
          {},
          { context: context(), credentialKind, meta },
        ),
      );

      expect(error).toMatchObject({
        code: "forbidden",
        message: "This kind of credential is not admitted to this command",
      });
      expect(calls).toEqual([]);
    },
  );

  test("a credential bound to no project is refused where the entry requires one, and admitted where it does not", async () => {
    const requiring = commands
      .filter(
        (entry) =>
          entry.rest.routeRequiresProject &&
          admitsCredentialKind(entry, "agent"),
      )
      .map((entry) => entry.name);
    expect(requiring).toEqual(["create_request_draft", "register_project"]);
    for (const name of requiring) {
      const { targets, calls } = recordingTargets();
      const error = await refusal(
        createCommandExecution(targets)(
          name,
          {},
          { context: agentContext(null), credentialKind: "agent", meta },
        ),
      );
      expect(error, name).toMatchObject({
        code: "forbidden",
        message:
          "This credential is not bound to a project, so it cannot reach project data",
      });
      expect(calls, name).toEqual([]);
    }

    const { targets, calls } = recordingTargets();
    await createCommandExecution(targets)(
      "post_message",
      {},
      { context: agentContext(null), credentialKind: "agent", meta },
    );
    expect(calls.map((call) => call.target)).toEqual(["commandBus"]);
  });

  test("a target's refusal is the caller's answer", async () => {
    const { targets } = recordingTargets();
    const refused = new DomainError("conflict", "The operation conflicts");
    targets.importSplit = vi.fn(async () => {
      throw refused;
    });

    await expect(
      createCommandExecution(targets)(
        "split_legacy_import_entry",
        {},
        { context: operatorContext(), credentialKind: "operator", meta },
      ),
    ).rejects.toBe(refused);
  });
});

describe("a person, in process (ruling 63)", () => {
  const person = {
    id: "core-execute-session",
    userId: "018f0000-0000-7000-8000-0000000c0e0a",
  };
  const personContext = expect.objectContaining({
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: humanScopes,
    credentialId: person.id,
    correlationId: expect.any(String),
  });
  /** What a person's command must reach: its entry's off-bus target, or the bus. */
  function expectedPersonCall(name: string, input: Record<string, unknown>) {
    const dispatch = restCommandTransports.find(
      (transport) => transport.name === name,
    )?.dispatch;
    switch (dispatch?.to) {
      case "agent-administration":
        return {
          target: "agentAdministration",
          args: [dispatch.handler, personContext, input, meta],
        };
      case "import-split":
        return { target: "importSplit", args: [personContext, input, meta] };
      case "slack-connection-test":
        return {
          target: "slackConnectionTest",
          args: [personContext, input, meta],
        };
      default:
        return {
          target: "commandBus",
          args: [{ name, input, context: personContext, meta }],
        };
    }
  }
  // Every name a command goes by: the registry's REST names, the tenant
  // bus's command names, and the rule's own.
  const everyName = [
    ...new Set([
      ...commands.map((entry) => entry.name),
      ...createCoreCommandRegistry().names(),
      ...inProcessPersonCommands,
    ]),
  ].sort();

  test("the names enumerated cover the rule and every command either side knows", () => {
    expect(everyName).toEqual(
      expect.arrayContaining([...inProcessPersonCommands]),
    );
    expect(everyName.length).toBeGreaterThan(inProcessPersonCommands.length);
  });

  test.each(everyName)(
    "%s: reaches its target, as the person, exactly when the in-process rule admits it",
    async (name) => {
      const { targets, calls } = recordingTargets();
      const input = { marker: `${name}-input` };

      const outcome = createCommandExecution(targets)(name, input, {
        person,
        organizationId,
        meta,
      });

      if (inProcessPersonCommands.includes(name)) {
        const expected = expectedPersonCall(name, input);
        await expect(outcome).resolves.toEqual({
          answeredBy: expected.target,
        });
        expect(calls).toEqual([expected]);
      } else {
        const error = await refusal(outcome);
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({
          code: "forbidden",
          message: "A person is not admitted to this command in process",
        });
        expect(calls).toEqual([]);
      }
    },
  );

  test("needs no project, and is handed no injected field: the input reaches the bus as given", async () => {
    const { targets, calls } = recordingTargets();
    const input = { title: "A draft", projectId };

    await createCommandExecution(targets)("create_request_draft", input, {
      person,
      organizationId,
      meta,
    });

    const handed = calls[0]?.args[0] as { input: unknown };
    expect(calls.map((call) => call.target)).toEqual(["commandBus"]);
    expect(handed.input).toBe(input);
  });
});
