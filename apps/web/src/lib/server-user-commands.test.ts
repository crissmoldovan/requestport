import { readFile } from "node:fs/promises";

import {
  appearanceOrganizationCommandName,
  appearancePersonalCommandName,
  createAuthenticatedUserCommandRegistry,
  createCoreCommandRegistry,
  findRestCommandTransport,
  restCommandTransports,
} from "@requestport/domain";
import { describe, expect, test } from "vitest";

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("authenticated-user command wiring", () => {
  test("builds the personal bus from the session-only registry", async () => {
    const wiring = await source("./server-user-commands.ts");

    expect(wiring).toContain("createAuthenticatedUserCommandRegistry()");
    // The tenant registry must never back the personal bus: it would give a
    // session-only context access to every organization-scoped command.
    expect(wiring).not.toContain("createCoreCommandRegistry");
    expect(wiring).toContain("createAppearanceRepository");
    expect(wiring).toContain("createCommandAuthorizationRepository");
    expect(wiring).toContain("AtomicCommandBus");
  });

  test("registers the appearance port on the tenant bus as well", async () => {
    // The port table's line (F.1 step 3). The tenant bus is the one the web's
    // RequestPort composes, over core's table (Plan 13, G.6; ruling 137);
    // `server-core-commands.test.ts` opens the port through the factory
    // itself.
    const wiring = await source("../../../../packages/core/src/command-bus.ts");

    expect(wiring).toContain('["appearance", createAppearanceRepository]');
  });

  // Plan 13, F.2.7's registry half admits an operator credential, and only
  // one, to the organisation's appearance defaults; the personal command
  // stays off the API.
  test("keeps the personal appearance command out of the generic API allowlist, and admits only operators to the organisation's", async () => {
    const route = await source("../app/api/v1/[[...path]]/route.ts");
    // Since Plan 13, H.1 the route composes `@requestport/server`'s REST
    // handlers, and the POST handler's allowlist is the capability
    // registry's POST commands.
    const handlers = await source("../../../../packages/server/src/rest.ts");
    expect(route).toContain('from "@requestport/server/rest"');
    expect(route).toContain("handleRestCommand(");
    expect(handlers).toContain("findRestCommandTransport(parts[1])");
    for (const transport of restCommandTransports) {
      const appearance =
        transport.name.includes("appearance") ||
        (transport.dispatch.to === "command-bus" &&
          transport.dispatch.commandName.includes("appearance"));
      if (appearance)
        expect(transport.name).toBe(appearanceOrganizationCommandName);
    }
    expect(
      findRestCommandTransport(appearancePersonalCommandName),
    ).toBeUndefined();
    expect(
      findRestCommandTransport(appearanceOrganizationCommandName),
    ).toMatchObject({
      dispatch: {
        to: "command-bus",
        commandName: appearanceOrganizationCommandName,
      },
      credentialKinds: ["operator"],
      mcpTool: null,
    });
    for (const text of [route, handlers]) {
      expect(text).not.toContain(appearancePersonalCommandName);
      expect(text).not.toContain(appearanceOrganizationCommandName);
    }
  });

  test("keeps appearance off the MCP tool surface", async () => {
    const server = await readFile(
      new URL("../../../../packages/mcp/src/server.ts", import.meta.url),
      "utf8",
    );

    expect(server).not.toContain("appearance");
  });

  test("keeps the personal command off the tenant registry", () => {
    expect(createCoreCommandRegistry().names()).not.toContain(
      appearancePersonalCommandName,
    );
    expect(createCoreCommandRegistry().names()).toContain(
      appearanceOrganizationCommandName,
    );
    expect(createAuthenticatedUserCommandRegistry().names()).toEqual([
      appearancePersonalCommandName,
    ]);
  });
});
