import { DatabaseSurfaceError } from "@requestport/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const root = vi.hoisted(() => ({ webStorage: vi.fn() }));
const configured = vi.hoisted(() => ({
  serverEnv: {
    BETTER_AUTH_SECRET: "readiness-test-signing-material",
    BETTER_AUTH_URL: "https://requestport.test",
  } as Record<string, string | undefined>,
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: configured.serverEnv,
}));
// The web root (Plan 13, G.5; manifest-g.md §2.2, Done when 4): the storage
// whose `ready()` the probe awaits.
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: root.webStorage,
}));

const { GET } = await import("./route.js");

/*
 * Each 503 writes one console line naming what readiness caught, by name and
 * code (`@requestport/server/health`; ruling 145). Captured, and printed by
 * none of these cases.
 */
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root.webStorage.mockReset();
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  configured.serverEnv.BETTER_AUTH_URL = "https://requestport.test";
  vi.restoreAllMocks();
});

describe("GET /api/health/ready", () => {
  test("answers { ready: true } once the web root's storage is ready", async () => {
    const ready = vi.fn(async () => {});
    root.webStorage.mockReturnValue({ ready });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ready).toHaveBeenCalledOnce();
    expect(logged).not.toHaveBeenCalled();
  });

  test("answers 503 when the web root's storage is not ready", async () => {
    root.webStorage.mockReturnValue({
      ready: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(logged.mock.calls).toEqual([
      ["RequestPort readiness answered 503: the probe rejected with Error."],
    ]);
  });

  test("answers 503 when the web root refuses to hand out its storage", async () => {
    root.webStorage.mockImplementation(() => {
      throw new DatabaseSurfaceError(
        "RequestPort database surface not declared",
      );
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(logged.mock.calls).toEqual([
      [
        "RequestPort readiness answered 503: the check threw DatabaseSurfaceError.",
      ],
    ]);
  });

  test("answers 503 without an issuer or a secret, and names that by its code, before it asks the web root for anything", async () => {
    configured.serverEnv.BETTER_AUTH_URL = undefined;

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
    expect(root.webStorage).not.toHaveBeenCalled();
    expect(logged.mock.calls).toEqual([
      [
        "RequestPort readiness answered 503: the check threw Error (code readiness_configuration_invalid).",
      ],
    ]);
  });
});
