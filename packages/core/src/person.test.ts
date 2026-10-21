import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import * as domain from "@requestport/domain";
import {
  capabilityRegistry,
  createCoreCommandRegistry,
  DomainError,
  findRestCommandTransport,
} from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  admitsPersonInProcess,
  createSignIn,
  inProcessPersonCommands,
} from "./person.js";

/*
 * A person, in process (ruling 63): `signIn` goes through the caller's Better
 * Auth, and the in-process rule is exactly what the web's server actions run
 * for a signed-in person. What `execute` admits under it is
 * `execute.test.ts`'s.
 */

const repository = fileURLToPath(new URL("../../../", import.meta.url));

describe("signIn", () => {
  test.each([
    ["no betterAuth", undefined],
    ["a betterAuth without signInWithLocalCredential", {}],
  ])("refuses with %s, as a configuration error", async (_, betterAuth) => {
    const error = await createSignIn(betterAuth)({
      email: "owner@example.com",
      credential: "local-credential",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "configuration_error" });
  });

  test("hands the credential to Better Auth, and answers the session it wrote", async () => {
    const session = { id: "session-1", userId: "user-1" };
    const signInWithLocalCredential = vi.fn(async () => session);
    const credential = {
      email: "owner@example.com",
      credential: "local-credential",
    };

    await expect(
      createSignIn({ signInWithLocalCredential })(credential),
    ).resolves.toBe(session);
    expect(signInWithLocalCredential.mock.calls).toEqual([[credential]]);
  });
});

/** The registry entries that run off the bus, by the target they reach. */
const offBusTargets = new Set([
  "agent-administration",
  "import-split",
  "slack-connection-test",
]);
const tenantBusCommands = new Set(createCoreCommandRegistry().names());

describe("the in-process rule", () => {
  test("names each command once, and cannot be changed in place", () => {
    expect(new Set(inProcessPersonCommands).size).toBe(
      inProcessPersonCommands.length,
    );
    expect(Object.isFrozen(inProcessPersonCommands)).toBe(true);
    for (const name of inProcessPersonCommands)
      expect(admitsPersonInProcess(name), name).toBe(true);
  });

  test("holds tenant-bus commands, each under the name its registry entry, if it has one, gives the bus, and the off-bus entries by their entry's name", () => {
    for (const name of inProcessPersonCommands) {
      const dispatch = findRestCommandTransport(name)?.dispatch;
      if (tenantBusCommands.has(name)) {
        // No entry (`create_agent_principal`), or an entry that hands the
        // bus this very name, so a person and a network credential reach
        // the same command under it.
        if (dispatch)
          expect(dispatch, name).toMatchObject({ commandName: name });
      } else {
        expect(dispatch && offBusTargets.has(dispatch.to), name).toBe(true);
      }
    }
  });

  test("is exactly what the web's server actions run for a signed-in person, read from their source", () => {
    const web = join(repository, "apps/web/src");
    const actionModules = [
      ...walk(join(web, "app")).filter((path) => path.endsWith("/actions.ts")),
      ...readdirSync(join(web, "lib"))
        .filter((name) => /^server-.*-actions\.ts$/u.test(name))
        .map((name) => join(web, "lib", name)),
    ]
      // Human-only by design (ruling 62).
      .filter((path) => !path.endsWith("/oauth/agent-consent/actions.ts"));
    // What each off-bus entry's handler is called by in the web.
    const offBusHandlers: Record<string, string> = {
      revokeAgentCredential: "revoke_agent_credential",
      revokeAgentOauthGrant: "revoke_agent_oauth_grant",
      splitImportEntry: "split_legacy_import_entry",
      queueSlackConnectionTest: "send_slack_connection_test",
    };
    for (const [handler, name] of Object.entries(offBusHandlers)) {
      const dispatch = findRestCommandTransport(name)?.dispatch;
      expect(dispatch && offBusTargets.has(dispatch.to), handler).toBe(true);
      if (dispatch?.to === "agent-administration")
        expect(dispatch.handler, handler).toBe(name);
    }
    const commandNameConstants = new Map<string, string>();
    for (const [constant, value] of Object.entries(domain) as Array<
      [string, unknown]
    >)
      if (constant.endsWith("CommandName") && typeof value === "string")
        commandNameConstants.set(constant, value);

    // A tenant-bus command named by a literal or by the domain's constant for
    // it, and an off-bus entry by its handler's call.
    const run = new Set<string>();
    for (const path of actionModules) {
      const source = readFileSync(path, "utf8");
      for (const [, literal] of source.matchAll(/"([a-z][a-z0-9_.]*)"/gu))
        if (literal && tenantBusCommands.has(literal)) run.add(literal);
      for (const [constant, value] of commandNameConstants)
        if (
          new RegExp(`\\b${constant}\\b`, "u").test(source) &&
          tenantBusCommands.has(value)
        )
          run.add(value);
      for (const [handler, name] of Object.entries(offBusHandlers))
        if (new RegExp(`\\b${handler}\\(`, "u").test(source)) run.add(name);
    }

    expect(actionModules.map((path) => relative(repository, path))).toContain(
      "apps/web/src/app/(app)/requests/actions.ts",
    );
    expect([...run].sort()).toEqual([...inProcessPersonCommands].sort());
  });

  test("leaves the registry's credential kinds as they are: no entry names a person", () => {
    for (const capability of capabilityRegistry)
      for (const kind of capability.credentialKinds ?? [])
        expect(["agent", "operator"], capability.name).toContain(kind);
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
