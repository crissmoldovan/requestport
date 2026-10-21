import {
  type AuthorizedCommandContext,
  DomainError,
  type OperatorCredentialAvailability,
} from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import { createOperatorActions } from "./server-operator-actions.js";

/*
  Plan 13, F.3: what the `/settings/operators` actions do once the action has
  resolved its session and its limiter. Every action answers with the
  unavailable state while F3-14's answer is off — revocation by a person
  included — before it reads the submission or calls anything, and never
  with a thrown error the page would render as a 500.
*/

const organizationId = "0190c8a4-0000-7000-8000-000000000001";
const credentialId = "0190c8a4-0000-7000-8000-000000000004";

const current = {
  organizationId,
  command: {
    actor: { type: "user", id: "user_issuer" },
    organizationId,
    scopes: new Set(["operator:manage"]),
    credentialId: "session_live",
    correlationId: "corr_operator_actions",
  } satisfies AuthorizedCommandContext,
};

function harness(
  availability: OperatorCredentialAvailability = { available: true },
) {
  const dependencies = {
    availability: vi.fn(async () => availability),
    service: {
      issue: vi.fn(async () => ({ plaintextKey: "rpo_issued_secret" })),
      rotate: vi.fn(async () => ({ plaintextKey: "rpo_rotated_secret" })),
    },
    executeCommand: vi.fn(async () => ({ id: credentialId, revoked: true })),
    revalidatePath: vi.fn(),
  };
  return { dependencies, actions: createOperatorActions(dependencies) };
}

function form(values: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }
  return data;
}

const issueForm = () =>
  form({
    name: "CI deploy",
    projectId: "",
    scopes: ["operator:revoke"],
    expiresInDays: "30",
    expectedVersion: "0",
    idempotencyKey: "web:operators:issue:0001",
  });

const credentialForm = () =>
  form({
    credentialId,
    expectedVersion: "1",
    idempotencyKey: "web:operators:credential:0001",
    overlapMinutes: "15",
  });

describe("the operator actions", () => {
  test("issue hands the service the organisation, the fields and the key, and reveals the key once", async () => {
    const { actions, dependencies } = harness();

    await expect(actions.issue(current, issueForm())).resolves.toEqual({
      status: "success",
      message:
        "Operator credential created. Copy it now; RequestPort never stores or reveals the plaintext again.",
      plaintextKey: "rpo_issued_secret",
    });
    expect(dependencies.service.issue).toHaveBeenCalledWith(
      current.command,
      {
        organizationId,
        projectId: null,
        name: "CI deploy",
        scopes: ["operator:revoke"],
        expiresInDays: 30,
      },
      { expectedVersion: 0, idempotencyKey: "web:operators:issue:0001" },
    );
    expect(dependencies.revalidatePath).toHaveBeenCalledWith(
      "/settings/operators",
    );
  });

  test("rotate hands the service the credential, its version and the overlap", async () => {
    const { actions, dependencies } = harness();

    await expect(
      actions.rotate(current, credentialForm()),
    ).resolves.toMatchObject({
      status: "success",
      plaintextKey: "rpo_rotated_secret",
    });
    expect(dependencies.service.rotate).toHaveBeenCalledWith(current.command, {
      organizationId,
      credentialId,
      overlapMinutes: 15,
      meta: {
        expectedVersion: 1,
        idempotencyKey: "web:operators:credential:0001",
      },
    });
  });

  test("revoke runs revoke_operator_credential on the bus, as the person", async () => {
    const { actions, dependencies } = harness();

    await expect(actions.revoke(current, credentialForm())).resolves.toEqual({
      status: "success",
      message: "Operator credential revoked.",
    });
    expect(dependencies.executeCommand).toHaveBeenCalledWith({
      name: "revoke_operator_credential",
      context: current.command,
      input: { organizationId, credentialId },
      meta: {
        expectedVersion: 1,
        idempotencyKey: "web:operators:credential:0001",
      },
    });
  });

  test.each([
    ["not-migrated"],
    ["switched-off"],
    ["change-password-mounted"],
  ] as const)(
    "every action answers the unavailable state while off (%s), having called nothing",
    async (reason) => {
      const { actions, dependencies } = harness({ available: false, reason });
      for (const [action, data] of [
        [actions.issue, issueForm()],
        [actions.rotate, credentialForm()],
        [actions.revoke, credentialForm()],
      ] as const) {
        await expect(action(current, data)).resolves.toMatchObject({
          status: "unavailable",
          reason,
        });
      }
      expect(dependencies.service.issue).not.toHaveBeenCalled();
      expect(dependencies.service.rotate).not.toHaveBeenCalled();
      expect(dependencies.executeCommand).not.toHaveBeenCalled();
    },
  );

  test("a service that finds the switch off mid-flight answers the unavailable state too", async () => {
    const { actions, dependencies } = harness();
    dependencies.service.issue.mockRejectedValueOnce(
      new DomainError("configuration_error", "off", { reason: "switched-off" }),
    );
    await expect(actions.issue(current, issueForm())).resolves.toMatchObject({
      status: "unavailable",
      reason: "switched-off",
    });
  });

  test("maps refusals to messages and a field, never to a thrown error", async () => {
    const { actions, dependencies } = harness();
    dependencies.executeCommand.mockRejectedValueOnce(
      new DomainError(
        "forbidden",
        "Operator credential revocation is not permitted",
      ),
    );
    await expect(actions.revoke(current, credentialForm())).resolves.toEqual({
      status: "error",
      message: "You do not have permission to manage that operator credential.",
    });

    dependencies.service.issue.mockRejectedValueOnce(
      new DomainError("validation_failed", "not admissible", {
        field: "scopes",
      }),
    );
    await expect(actions.issue(current, issueForm())).resolves.toEqual({
      status: "error",
      field: "scopes",
      message: "Check the values and try again.",
    });

    await expect(
      actions.issue(current, form({ name: "", expectedVersion: "0" })),
    ).resolves.toMatchObject({ status: "error", field: expect.any(String) });

    dependencies.service.rotate.mockRejectedValueOnce(
      new Error("socket hang up"),
    );
    await expect(actions.rotate(current, credentialForm())).resolves.toEqual({
      status: "error",
      message: "The operator credential action could not be completed.",
    });
  });
});
