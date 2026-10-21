import { APIError } from "better-auth";
import { describe, expect, test, vi } from "vitest";

import { createRequireHumanSession } from "./server-session.js";

describe("requireHumanSession", () => {
  test("returns the verified session and user", async () => {
    const verified = {
      session: { id: "session_1", userId: "user_1" },
      user: { id: "user_1", email: "person@example.com" },
    };
    const headers = new Headers({ cookie: "session=opaque" });
    const getSession = vi.fn(async () => verified);

    await expect(createRequireHumanSession(getSession)(headers)).resolves.toBe(
      verified,
    );
    expect(getSession).toHaveBeenCalledWith({ headers });
  });

  test("throws a typed unauthorized error when the session is absent", async () => {
    const requireSession = createRequireHumanSession(vi.fn(async () => null));

    const result = requireSession(new Headers());
    await expect(result).rejects.toBeInstanceOf(APIError);
    await expect(result).rejects.toMatchObject({
      status: "UNAUTHORIZED",
      body: { code: "unauthorized", message: "unauthorized" },
    });
  });
});
