import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  createProjectRegistration,
  type ProjectRegistrationOptions,
} from "./project-registration.js";

/*
 * Project registration through core (manifest-g.md §2.5's
 * `project-registration-repository` row): an agent credential bound to a
 * project registers through the repository, built when the registration runs,
 * with its receipt keyed by the raw `commandFingerprintKey`, read then; any
 * other credential, and an agent bound to no project, is refused before the
 * repository is built, in the words the REST route used.
 */

const organizationId = "018f0000-0000-7000-8000-0000000c0f01";
const projectId = "018f0000-0000-7000-8000-0000000c0f02";
const meta = {
  idempotencyKey: "core-registration-idempotency",
  expectedVersion: 0,
};

function agent(project: string | null): AuthorizedCommandContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c0f03" },
    organizationId,
    projectId: project,
    scopes: new Set(["agent:register"]),
    credentialId: "core-registration-credential",
    correlationId: "018f0000-0000-7000-8000-0000000c0f04",
  };
}

function registration() {
  const register = vi.fn(async () => ({ projectId: "registered" }));
  const repository = vi.fn(() => ({ register }));
  const read: string[] = [];
  const { register: run } = createProjectRegistration({
    // A stand-in that answers less than the repository does.
    repository:
      repository as unknown as ProjectRegistrationOptions["repository"],
    secrets: {
      get commandFingerprintKey() {
        read.push("commandFingerprintKey");
        return "core-registration-signing-material";
      },
    },
  });
  return { run, repository, register, read };
}

describe("registering a project through core", () => {
  test("an agent bound to a project registers through the repository built then, with the secret read then", async () => {
    const { run, repository, register, read } = registration();
    const context = agent(projectId);
    const input = { alias: "core", repositoryUrl: "https://github.com/a/b" };

    expect(repository).not.toHaveBeenCalled();
    expect(read).toEqual([]);
    await expect(run(context, input, meta)).resolves.toEqual({
      projectId: "registered",
    });

    expect(repository).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
      { ...context, projectId },
      input,
      meta,
      "core-registration-signing-material",
    );
    expect(read).toEqual(["commandFingerprintKey"]);
  });

  test.each([
    [
      "an operator's context",
      (): AuthorizedCommandContext => ({
        actor: operatorActor({
          lineageId: "018f0000-0000-7000-8000-0000000c0f05",
          memberUserId: "018f0000-0000-7000-8000-0000000c0f06",
        }),
        credentialKind: "operator",
        organizationId,
        projectId,
        scopes: new Set(["agent:register"]),
        credentialId: "core-registration-operator",
        correlationId: "018f0000-0000-7000-8000-0000000c0f07",
      }),
      "This kind of credential is not admitted to this command",
    ],
    [
      "a person's context",
      (): AuthorizedCommandContext => ({
        ...agent(projectId),
        actor: { type: "user", id: "018f0000-0000-7000-8000-0000000c0f08" },
      }),
      "This kind of credential is not admitted to this command",
    ],
    [
      "an agent bound to no project",
      () => agent(null),
      "This credential is not bound to a project, so it cannot reach project data",
    ],
  ] as const)(
    "%s is refused before the repository is built",
    async (_, context, message) => {
      const { run, repository, read } = registration();

      const error = await run(context(), {}, meta).catch(
        (refused: unknown) => refused,
      );

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "forbidden", message });
      expect(repository).not.toHaveBeenCalled();
      expect(read).toEqual([]);
    },
  );
});
