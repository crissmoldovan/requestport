import { beforeEach, describe, expect, test, vi } from "vitest";

const operators = vi.hoisted(() => ({
  availability: vi.fn(),
  calls: [] as string[],
  execute: vi.fn(),
  issue: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  rotate: vi.fn(),
}));

vi.mock("@requestport/auth/server", () => ({
  operatorCredentialAvailability: operators.availability,
  operatorCredentialService: {
    issue: operators.issue,
    rotate: operators.rotate,
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {
    operators.calls.push("limiter");
  },
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => {
    operators.calls.push("session");
    return {
      currentOrganization: operators.organization,
      session: {
        session: { id: "session_live" },
        user: { id: "00000000-0000-4000-8000-0000000000aa" },
      },
    };
  },
}));

vi.mock("../../../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: operators.execute },
  humanCommandContext: (
    session: { session: { id: string }; user: { id: string } },
    organizationId: string,
  ) => ({
    actor: { type: "user", id: session.user.id },
    organizationId,
    scopes: new Set(["operator:manage"]),
    credentialId: session.session.id,
    correlationId: "correlation",
  }),
}));

import { initialOperatorActionState } from "./action-state.js";
import {
  issueOperatorCredentialAction,
  revokeOperatorCredentialAction,
  rotateOperatorCredentialAction,
} from "./actions.js";

/*
  Plan 13, F.3: the `/settings/operators` Server Actions. What each does once
  authorised is `server-operator-actions.test.ts`'s; this holds the part only
  the module can show — the session and the limiter come first, a caller with
  no organisation is refused, and while operator credentials are off every
  action, revocation included, answers the unavailable state and calls
  nothing.
*/

const credentialForm = () => {
  const data = new FormData();
  data.set("credentialId", "00000000-0000-4000-8000-0000000000c1");
  data.set("expectedVersion", "1");
  data.set("idempotencyKey", "web:operators:credential:0001");
  return data;
};

beforeEach(() => {
  operators.calls.length = 0;
  operators.availability.mockReset();
  operators.availability.mockImplementation(async () => {
    operators.calls.push("availability");
    return { available: false, reason: "switched-off" };
  });
  operators.execute.mockReset();
  operators.issue.mockReset();
  operators.rotate.mockReset();
  operators.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
});

describe("the operator credential actions", () => {
  test.each([
    ["issue", issueOperatorCredentialAction],
    ["rotate", rotateOperatorCredentialAction],
    ["revoke", revokeOperatorCredentialAction],
  ] as const)(
    "%s resolves the session and the limiter, then answers the unavailable state while off",
    async (_label, action) => {
      await expect(
        action(initialOperatorActionState, credentialForm()),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: "switched-off",
      });
      expect(operators.calls).toEqual(["session", "limiter", "availability"]);
      expect(operators.issue).not.toHaveBeenCalled();
      expect(operators.rotate).not.toHaveBeenCalled();
      expect(operators.execute).not.toHaveBeenCalled();
    },
  );

  test("revocation, available, runs on the bus as the person in session", async () => {
    operators.availability.mockResolvedValue({ available: true });
    operators.execute.mockResolvedValue({ revoked: true });
    await expect(
      revokeOperatorCredentialAction(
        initialOperatorActionState,
        credentialForm(),
      ),
    ).resolves.toMatchObject({ status: "success" });
    expect(operators.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "revoke_operator_credential",
        context: expect.objectContaining({
          actor: { type: "user", id: "00000000-0000-4000-8000-0000000000aa" },
          credentialId: "session_live",
        }),
      }),
    );
  });

  test("refuses a caller with no organisation before anything else", async () => {
    operators.organization = null;
    await expect(
      issueOperatorCredentialAction(
        initialOperatorActionState,
        credentialForm(),
      ),
    ).resolves.toMatchObject({ status: "error" });
    expect(operators.calls).toEqual(["session"]);
  });
});
