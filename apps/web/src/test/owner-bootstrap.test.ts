import type { Storage } from "@requestport/db";
import {
  BOOTSTRAP_OWNER_ACTOR,
  type BootstrapOwnerResult,
  DomainError,
} from "@requestport/domain";
import { describe, expect, test } from "vitest";

import { runOwnerBootstrap } from "../../tests/fixtures/owner-bootstrap.js";

/**
 * The browser lanes' owner bootstrap, around the command it runs (Plan 13,
 * J.6b; ruling 184). The command itself is `@requestport/domain`'s
 * `bootstrapOwner` over `@requestport/db`'s foundation repository, which their
 * own suites cover against a database; these cases replace it and the storage,
 * and hold what the fixture adds: the context it hands the command, the input
 * it hands on (a local-credential request included, J.6c), the storage it
 * closes, and the step a failure names.
 */

const input = {
  email: "owner@example.invalid",
  organizationSlug: "bootstrap-example",
  organizationName: "Bootstrap Example",
};

const awaiting: BootstrapOwnerResult = {
  status: "awaiting_authentication",
  organizationId: "00000000-0000-4000-8000-000000000001",
  organizationSlug: input.organizationSlug,
  normalizedEmail: input.email,
};

function fakeStorage(close: () => Promise<void> = async () => undefined) {
  const closed: string[] = [];
  const storage = {
    close: async () => {
      closed.push("close");
      await close();
    },
  } as unknown as Storage;
  return { closed, storage };
}

describe("the browser lanes' owner bootstrap", () => {
  test("runs the command as the bootstrap actor, under a correlation id of its own, and closes the storage after", async () => {
    const { closed, storage } = fakeStorage();
    const calls: unknown[] = [];

    const result = await runOwnerBootstrap(input, {
      buildStorage: () => storage,
      run: async (given, context, commandInput) => {
        calls.push({
          closedBefore: closed.length,
          context,
          commandInput,
          given,
        });
        return awaiting;
      },
    });

    expect(result).toEqual(awaiting);
    expect(calls).toEqual([
      {
        closedBefore: 0,
        context: {
          actor: BOOTSTRAP_OWNER_ACTOR,
          correlationId: expect.stringMatching(
            /^e2e_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
          ),
        },
        commandInput: input,
        given: storage,
      },
    ]);
    expect(closed).toEqual(["close"]);
  });

  test("hands the command a local-credential request unchanged, and answers the credential it issued", async () => {
    // The sign-in combinations' spec issues its owner's credential this way
    // (J.6c, ruling 187); without `localCredential` the command is the
    // two-stage one and answers no credential.
    const { closed, storage } = fakeStorage();
    const issuing = { ...input, localCredential: "issue" as const };
    const issued: BootstrapOwnerResult = {
      status: "owner_active",
      organizationId: awaiting.organizationId,
      organizationSlug: input.organizationSlug,
      normalizedEmail: input.email,
      userId: "planted-user",
      localCredential: "issued",
      credential: "planted-credential",
    };
    const handed: unknown[] = [];

    const result = await runOwnerBootstrap(issuing, {
      buildStorage: () => storage,
      run: async (_storage, _context, commandInput) => {
        handed.push(commandInput);
        return issued;
      },
    });

    expect(handed).toEqual([issuing]);
    expect(result).toEqual(issued);
    expect(closed).toEqual(["close"]);
  });

  test("names the command step, and the domain's code and field, when the command is refused, and still closes the storage", async () => {
    const { closed, storage } = fakeStorage();

    await expect(
      runOwnerBootstrap(input, {
        buildStorage: () => storage,
        run: async () => {
          throw new DomainError(
            "conflict",
            "Organization name does not match",
            {
              field: "name",
            },
          );
        },
      }),
    ).rejects.toThrow(
      new Error(
        "Foundation E2E owner bootstrap failed: command (conflict name)",
      ),
    );
    expect(closed).toEqual(["close"]);
  });

  test("names the domain's code alone when the field it names is not a bare name, so a value is never repeated", async () => {
    const { closed, storage } = fakeStorage();

    await expect(
      runOwnerBootstrap(input, {
        buildStorage: () => storage,
        run: async () => {
          throw new DomainError("validation_failed", "Invalid email", {
            field: input.email,
          });
        },
      }),
    ).rejects.toThrow(
      new Error(
        "Foundation E2E owner bootstrap failed: command (validation_failed)",
      ),
    );
    expect(closed).toEqual(["close"]);
  });

  test("names the command step alone when the failure is not the domain's, and repeats nothing it said", async () => {
    const { closed, storage } = fakeStorage();

    await expect(
      runOwnerBootstrap(input, {
        buildStorage: () => storage,
        run: async () => {
          throw new Error(`could not reach ${input.email}`);
        },
      }),
    ).rejects.toThrow(
      new Error("Foundation E2E owner bootstrap failed: command"),
    );
    expect(closed).toEqual(["close"]);
  });

  test("names the storage step when no storage could be built, and runs nothing", async () => {
    let ran = false;

    await expect(
      runOwnerBootstrap(input, {
        buildStorage: () => {
          throw new Error("unrecognised driver");
        },
        run: async () => {
          ran = true;
          return awaiting;
        },
      }),
    ).rejects.toThrow(
      new Error("Foundation E2E owner bootstrap failed: storage"),
    );
    expect(ran).toBe(false);
  });

  test("answers what the command answered when only the close fails, as the operator CLI does", async () => {
    const { closed, storage } = fakeStorage(async () => {
      throw new Error("pool already ended");
    });

    await expect(
      runOwnerBootstrap(input, {
        buildStorage: () => storage,
        run: async () => awaiting,
      }),
    ).resolves.toEqual(awaiting);
    expect(closed).toEqual(["close"]);
  });
});
