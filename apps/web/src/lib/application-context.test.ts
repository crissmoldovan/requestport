import type { FoundationQueryRepository } from "@requestport/domain";
import { APIError } from "better-auth";
import { describe, expect, test, vi } from "vitest";

import {
  carryingIntoSignIn,
  loadApplicationContext,
} from "./application-context.js";

const emptyQuery = {
  findActiveOrganizationForUser: vi.fn(),
  listActiveOrganizationsForUser: vi.fn(async () => []),
  listOrganizationMembers: vi.fn(),
  listOrganizationLanes: vi.fn(),
  listOrganizationProjects: vi.fn(),
  listPendingInvitations: vi.fn(),
} satisfies FoundationQueryRepository;

/** Better Auth's APIError as another copy of `better-auth` builds it: another class, with the same name and status. */
class AnotherCopysAPIError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(status.toLowerCase());
    this.name = "APIError";
    this.status = status;
  }
}

describe("loadApplicationContext", () => {
  test("redirects unauthenticated application access to sign in", async () => {
    const redirect = vi.fn((path: string): never => {
      throw new Error(`redirect:${path}`);
    });

    await expect(
      loadApplicationContext({
        preferredOrganizationId: undefined,
        query: emptyQuery,
        redirect,
        requireSession: vi.fn(async () => {
          throw new APIError("UNAUTHORIZED", {
            code: "unauthorized",
            message: "unauthorized",
          });
        }),
      }),
    ).rejects.toThrow("redirect:/sign-in");
    expect(redirect).toHaveBeenCalledWith("/sign-in");
  });

  /*
    Where the host's handoff is set, the session check Next's pages run is
    the host's: `requireHumanSession` is a member of the Better Auth the
    handoff carries (Plan 13, H.5; manifest-h.md §2.7.1). Its APIError comes
    from the host's copy of `better-auth`, not the one Next bundles: another
    class, with the same name and status. So the check reads those.
  */
  test.each([
    ["another copy's APIError", () => new AnotherCopysAPIError("UNAUTHORIZED")],
    [
      "a plain object named APIError",
      () => ({ name: "APIError", status: "UNAUTHORIZED" }),
    ],
  ])(
    "redirects to sign in when the session is refused with %s",
    async (_label, refusal) => {
      const redirect = vi.fn((path: string): never => {
        throw new Error(`redirect:${path}`);
      });

      await expect(
        loadApplicationContext({
          preferredOrganizationId: undefined,
          query: emptyQuery,
          redirect,
          requireSession: vi.fn(async () => {
            throw refusal();
          }),
        }),
      ).rejects.toThrow("redirect:/sign-in");
      expect(redirect).toHaveBeenCalledWith("/sign-in");
    },
  );

  test("throws, and does not redirect, an APIError with another status", async () => {
    const redirect = vi.fn();
    const forbidden = new APIError("FORBIDDEN", {
      code: "forbidden",
      message: "forbidden",
    });

    await expect(
      loadApplicationContext({
        preferredOrganizationId: undefined,
        query: emptyQuery,
        redirect,
        requireSession: vi.fn(async () => {
          throw forbidden;
        }),
      }),
    ).rejects.toBe(forbidden);
    expect(redirect).not.toHaveBeenCalled();
  });

  test("returns a useful authenticated setup context without redirecting when membership is absent", async () => {
    const redirect = vi.fn();
    const session = {
      session: { id: "session_1", userId: "user_1" },
      user: {
        id: "user_1",
        email: "owner@example.com",
        name: "Owner",
        image: null,
      },
    };

    await expect(
      loadApplicationContext({
        preferredOrganizationId: undefined,
        query: emptyQuery,
        redirect,
        requireSession: vi.fn(async () => session),
      }),
    ).resolves.toEqual({
      currentOrganization: null,
      organizations: [],
      session,
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});

/**
 * Where an unauthenticated request carrying `submitted` is sent.
 *
 * The whole point of the store is that the gate reads it without being handed
 * it, so these drive the real entry point rather than the private helper.
 */
async function signInTargetCarrying(submitted: unknown): Promise<string> {
  const redirect = vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  });

  await expect(
    carryingIntoSignIn(
      () => submitted,
      () =>
        loadApplicationContext({
          preferredOrganizationId: undefined,
          query: emptyQuery,
          redirect,
          requireSession: vi.fn(async () => {
            throw new APIError("UNAUTHORIZED", {
              code: "unauthorized",
              message: "unauthorized",
            });
          }),
        }),
    ),
  ).rejects.toThrow(/^redirect:/u);
  expect(redirect).toHaveBeenCalledTimes(1);

  return redirect.mock.calls[0]?.[0] as string;
}

describe("the authorization a lapsed session carries into sign in", () => {
  test("travels, so sign in has something to resume", async () => {
    await expect(
      signInTargetCarrying("client_id=agent&sig=abc&exp=1700000000"),
    ).resolves.toBe("/sign-in?client_id=agent&sig=abc&exp=1700000000");
  });

  test("is re-encoded, so nothing submitted can end the header or reach past the path", async () => {
    const target = await signInTargetCarrying("client_id=a b\nc#d/e");

    expect(target).toBe("/sign-in?client_id=a+b%0Ac%23d%2Fe");
  });

  test("is dropped when it is not a submitted string at all", async () => {
    await expect(signInTargetCarrying(undefined)).resolves.toBe("/sign-in");
    await expect(signInTargetCarrying(["a=1"])).resolves.toBe("/sign-in");
  });

  /**
   * The budget is spent by the header, not by the submission, and the two are
   * not the same size: percent-encoding expands as it escapes, by an amount
   * that depends on the bytes. A newline trebles, which is what this case
   * uses; a character several UTF-8 bytes wide grows by more. So no single
   * ratio bounds the pair — the point is only that a cap measured before
   * re-serialising passes this submission, 2042 characters and comfortably
   * under 2048, and then writes 6127 of them into `Location`.
   */
  test("is dropped when rebuilding it would outgrow the redirect budget", async () => {
    const submitted = "\n".repeat(2042);
    expect(submitted.length).toBeLessThan(2048);
    expect(new URLSearchParams(submitted).toString()).toHaveLength(6127);

    await expect(signInTargetCarrying(submitted)).resolves.toBe("/sign-in");
  });

  test("travels at the budget and is dropped one character past it", async () => {
    // `URLSearchParams` reads a bare key as an empty-valued one, so each of
    // these rebuilds to itself plus a trailing `=`.
    await expect(signInTargetCarrying("a".repeat(2047))).resolves.toBe(
      `/sign-in?${"a".repeat(2047)}=`,
    );
    await expect(signInTargetCarrying("a".repeat(2048))).resolves.toBe(
      "/sign-in",
    );
  });
});
