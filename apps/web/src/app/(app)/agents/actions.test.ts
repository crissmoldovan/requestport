import { DomainError } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const agents = vi.hoisted(() => ({
  execute: vi.fn(),
  revokeAgentCredential: vi.fn(),
  revokeAgentOauthGrant: vi.fn(),
  command: { scopes: [], marker: "the-human-command-context" },
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  },
}));

vi.mock("@requestport/auth/server", () => ({
  agentApiKeyService: {},
  agentGrantService: {},
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_SECRET: "fixture-value-not-a-real-credential" },
}));

vi.mock("@requestport/db", () => ({
  createAgentAuthRepository: () => ({}),
  createWorkspaceRepository: () => ({}),
}));

// The web root (Plan 13, G.2 and G.3), handing back a fake handle as its
// storage's: the telemetry reveal and the credential read build their
// repositories over it when they run.
vi.mock("../../../lib/server-request-port.js", () => {
  const db = {};
  return { webStorage: () => ({ db }) };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: agents.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("../../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: agents.execute },
  humanCommandContext: () => agents.command,
  workspaceEncryption: {},
}));

vi.mock("../../../lib/server-agent-actions.js", () => ({
  revokeAgentCredential: agents.revokeAgentCredential,
  revokeAgentOauthGrant: agents.revokeAgentOauthGrant,
}));

import {
  createAgentAction,
  revokeAgentKeyAction,
  revokeAgentOauthGrantAction,
  setAgentStatusAction,
} from "./actions.js";
import { initialAgentActionState } from "./agent-action-state.js";

/**
 * Where a rejected agent submission is allowed to land.
 *
 * The registration form draws a field for the display name, the slug and the
 * software, so §7 puts a rejection about one of them on that control's own
 * error line. A denial is about the caller rather than about any field, so it
 * stays the fixed banner.
 */

const key = "0123456789abcdef0123";
const agentPrincipalId = "00000000-0000-4000-8000-0000000000a1";
const credentialId = "00000000-0000-4000-8000-0000000000c1";
const grantId = "00000000-0000-4000-8000-0000000000e1";

function formOf(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function registrationForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("projectId", "");
  data.set("displayName", "Claude Code");
  data.set("slug", "claude-code");
  data.set("softwareName", "Claude Code");
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

beforeEach(() => {
  agents.execute.mockReset();
  agents.execute.mockResolvedValue(undefined);
  agents.revokeAgentCredential.mockReset();
  agents.revokeAgentCredential.mockResolvedValue({
    id: credentialId,
    revoked: true,
  });
  agents.revokeAgentOauthGrant.mockReset();
  agents.revokeAgentOauthGrant.mockResolvedValue({
    id: grantId,
    revoked: true,
    version: 3,
  });
});

describe("registering an agent principal", () => {
  test("addresses a rejected slug to the slug control", async () => {
    const state = await createAgentAction(
      initialAgentActionState,
      registrationForm({ slug: "Claude Code" }),
    );

    expect(state).toMatchObject({ field: "slug", status: "error" });
    expect(state.status === "error" && state.message).not.toBe("");
  });

  test("addresses a rejected display name to its own control", async () => {
    expect(
      await createAgentAction(
        initialAgentActionState,
        registrationForm({ displayName: "" }),
      ),
    ).toMatchObject({ field: "displayName", status: "error" });
  });

  test("carries the field a domain rejection already names", async () => {
    agents.execute.mockRejectedValue(
      new DomainError("conflict", "slug already registered", { field: "slug" }),
    );

    expect(
      await createAgentAction(initialAgentActionState, registrationForm()),
    ).toEqual({
      field: "slug",
      message:
        "That agent change conflicts with current state. If credential issuance already completed, its plaintext cannot be shown again; create or rotate a replacement.",
      status: "error",
    });
  });

  test("keeps a denial in the fixed banner, addressed to no field", async () => {
    agents.execute.mockRejectedValue(
      new DomainError("forbidden", "not an administrator"),
    );

    expect(
      await createAgentAction(initialAgentActionState, registrationForm()),
    ).toEqual({
      message: "You do not have permission to manage this agent.",
      status: "error",
    });
  });
});

/**
 * The three capabilities F.2.2 ports (ruling 3: suspend, revoke a key, revoke
 * a grant). Each form keeps its answers and runs the one handler its REST
 * transport will share: the bus command for the status, and core's two
 * revocation handlers, through `server-agent-actions.ts`.
 */
describe("the forms F.2.2 ports", () => {
  test("setting an agent's status runs set_agent_principal_status on the bus", async () => {
    const state = await setAgentStatusAction(
      initialAgentActionState,
      formOf({
        agentPrincipalId,
        expectedVersion: "4",
        status: "suspended",
        reason: "Paused while the key is rotated",
        idempotencyKey: key,
      }),
    );

    expect(state).toEqual({ status: "success", message: "Agent suspended." });
    expect(agents.execute).toHaveBeenCalledWith({
      name: "set_agent_principal_status",
      context: agents.command,
      meta: { expectedVersion: 4, idempotencyKey: key },
      input: {
        organizationId: agents.organization.id,
        agentPrincipalId,
        status: "suspended",
        reason: "Paused while the key is rotated",
      },
    });
  });

  test("revoking a key runs the shared revocation handler", async () => {
    const state = await revokeAgentKeyAction(
      initialAgentActionState,
      formOf({
        agentPrincipalId,
        credentialId,
        expectedVersion: "2",
        idempotencyKey: key,
      }),
    );

    expect(state).toEqual({
      status: "success",
      message: "Credential revoked.",
    });
    expect(agents.revokeAgentCredential).toHaveBeenCalledWith(
      agents.command,
      {
        organizationId: agents.organization.id,
        agentPrincipalId,
        credentialId,
      },
      { expectedVersion: 2, idempotencyKey: key },
    );
  });

  test("an overlap of Infinity minutes is refused in zod 4.4.3's words, received number", async () => {
    expect(
      await revokeAgentKeyAction(
        initialAgentActionState,
        formOf({
          agentPrincipalId,
          credentialId,
          overlapMinutes: "Infinity",
          expectedVersion: "2",
          idempotencyKey: key,
        }),
      ),
    ).toEqual({
      status: "error",
      field: "overlapMinutes",
      message: "Invalid input: expected number, received number",
    });
    expect(agents.revokeAgentCredential).not.toHaveBeenCalled();
  });

  test("a refused key revocation is answered as before", async () => {
    agents.revokeAgentCredential.mockRejectedValue(
      new DomainError("version_conflict", "Agent credential changed"),
    );

    expect(
      await revokeAgentKeyAction(
        initialAgentActionState,
        formOf({
          agentPrincipalId,
          credentialId,
          expectedVersion: "2",
          idempotencyKey: key,
        }),
      ),
    ).toEqual({
      status: "error",
      message: "This record changed. Refresh and try again.",
    });
  });

  test("revoking a grant runs the shared revocation handler", async () => {
    const state = await revokeAgentOauthGrantAction(
      initialAgentActionState,
      formOf({
        agentPrincipalId,
        grantId,
        reason: "The laptop holding it was lost",
        expectedVersion: "3",
        idempotencyKey: key,
      }),
    );

    expect(state).toEqual({
      status: "success",
      message:
        "OAuth grant revoked. Existing and refreshed tokens are now denied.",
    });
    expect(agents.revokeAgentOauthGrant).toHaveBeenCalledWith(
      agents.command,
      {
        organizationId: agents.organization.id,
        agentPrincipalId,
        grantId,
        reason: "The laptop holding it was lost",
      },
      { expectedVersion: 3, idempotencyKey: key },
    );
  });

  test("a refused grant revocation is answered as before", async () => {
    agents.revokeAgentOauthGrant.mockRejectedValue(
      new DomainError("forbidden", "OAuth agent grant revocation is denied"),
    );

    expect(
      await revokeAgentOauthGrantAction(
        initialAgentActionState,
        formOf({
          agentPrincipalId,
          grantId,
          reason: "The laptop holding it was lost",
          expectedVersion: "3",
          idempotencyKey: key,
        }),
      ),
    ).toEqual({
      status: "error",
      message: "You do not have permission to manage this agent.",
    });
  });
});
