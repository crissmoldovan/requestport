import { beforeEach, describe, expect, test, vi } from "vitest";

/*
  The setup card's Hide and Show (ruling 261): each writes the session's own
  person and organisation into the HttpOnly cookie the overview reads, and
  nothing the browser sends decides whose card it is.
*/

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  set: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  enforceRateLimit: vi.fn(async (_input: unknown) => {}),
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "requestport.setup_card_hidden" && state.cookie !== undefined
        ? { name, value: state.cookie }
        : undefined,
    set: state.set,
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: state.revalidatePath }));

vi.mock("../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: state.enforceRateLimit,
  rateLimitFingerprint: (...parts: string[]) => parts.join(":"),
}));

vi.mock("../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: state.organization,
    session: { user: { id: "user_ana" } },
  }),
}));

import {
  hideSetupCardAction,
  showSetupCardAction,
} from "./overview-actions.js";

const organizationId = "00000000-0000-4000-8000-0000000000d1";

beforeEach(() => {
  state.cookie = undefined;
  state.organization = {
    id: organizationId,
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  state.set.mockReset();
  state.enforceRateLimit.mockClear();
  state.revalidatePath.mockReset();
});

describe("the setup card's Hide and Show", () => {
  test("Hide adds the session's person and organisation, keeping what was there", async () => {
    state.cookie = `${organizationId}:user_bo`;

    await hideSetupCardAction();

    expect(state.set).toHaveBeenCalledTimes(1);
    expect(state.set.mock.calls[0]?.[0]).toBe("requestport.setup_card_hidden");
    expect(state.set.mock.calls[0]?.[1]).toBe(
      `${organizationId}:user_bo|${organizationId}:user_ana`,
    );
    expect(state.set.mock.calls[0]?.[2]).toMatchObject({
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60,
    });
    expect(state.revalidatePath).toHaveBeenCalledWith("/");
  });

  test("Show takes this person's entry out, and expires the cookie when it was the last", async () => {
    state.cookie = `${organizationId}:user_ana`;

    await showSetupCardAction();

    expect(state.set).toHaveBeenCalledWith(
      "requestport.setup_card_hidden",
      "",
      expect.objectContaining({ httpOnly: true, maxAge: 0 }),
    );
    expect(state.revalidatePath).toHaveBeenCalledWith("/");
  });

  test("ignores whatever the form sends", async () => {
    const forged = new FormData();
    forged.set("organizationId", "00000000-0000-4000-8000-0000000000ff");
    forged.set("userId", "user_mallory");

    await (hideSetupCardAction as (form: FormData) => Promise<void>)(forged);

    expect(state.set.mock.calls[0]?.[1]).toBe(`${organizationId}:user_ana`);
  });

  test("is rate limited as a mutation of the person's own", async () => {
    await hideSetupCardAction();

    expect(state.enforceRateLimit).toHaveBeenCalledWith({
      endpointClass: "mutation",
      fingerprint: "overview-setup-card:user_ana",
    });
  });

  test("writes nothing without an organisation to hide it in", async () => {
    state.organization = null;

    await hideSetupCardAction();

    expect(state.set).not.toHaveBeenCalled();
    expect(state.revalidatePath).not.toHaveBeenCalled();
  });
});
