import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { declaresServerDirective } from "../test/source-text.js";
import type { AdministrationActionState } from "./administration-actions.js";
import {
  createOrganizationCreateRoute,
  ORGANIZATION_CREATE_DESTINATION,
  ORGANIZATION_CREATE_ENDPOINT,
  postOrganizationCreate,
} from "./organization-create.js";

const webRoot = resolve(import.meta.dirname, "..", "..");
const sourceRoot = resolve(webRoot, "src");

const created: AdministrationActionState = {
  destination: ORGANIZATION_CREATE_DESTINATION,
  message: "Organization created.",
  status: "success",
};

const unavailable: AdministrationActionState = {
  code: "unexpected_error",
  message: "This action is temporarily unavailable.",
  status: "error",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function identity(entries: Record<string, string> = {}) {
  const body = new FormData();
  body.set("name", "CUE++");
  body.set("slug", "example-org");
  for (const [key, value] of Object.entries(entries)) body.set(key, value);
  return body;
}

function createRequest(body: BodyInit) {
  return new Request(`http://127.0.0.1${ORGANIZATION_CREATE_ENDPOINT}`, {
    body,
    method: "POST",
  });
}

/** Every module the App Router compiles into a Server Action endpoint. */
function serverActionModules() {
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .filter(
      (file) =>
        relative(sourceRoot, file).split(sep).join("/") !==
          "lib/organization-switch.test.ts" &&
        declaresServerDirective(readFileSync(file, "utf8")),
    );
}

describe("organization creation transport", () => {
  test("posts the submitted identity to the endpoint and returns its verdict", async () => {
    const send = vi.fn(async () => jsonResponse(created));

    await expect(postOrganizationCreate(identity(), send)).resolves.toEqual(
      created,
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ORGANIZATION_CREATE_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.body as FormData).get("name")).toBe("CUE++");
    expect((init.body as FormData).get("slug")).toBe("example-org");
  });

  test("reports the fixed unavailable message when the endpoint cannot be reached", async () => {
    const result = await postOrganizationCreate(identity(), async () => {
      throw new Error("postgres://secret@host offline");
    });

    expect(result).toEqual(unavailable);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test.each([
    ["a body that is not JSON", () => new Response("<html>proxy</html>")],
    ["a verdict with no status", () => jsonResponse({ message: "ok" })],
    [
      "a success with no destination",
      () => jsonResponse({ message: "ok", status: "success" }),
    ],
    [
      "a destination that leaves this origin",
      () =>
        jsonResponse({
          destination: "https://evil.example/steal",
          message: "ok",
          status: "success",
        }),
    ],
  ])("refuses %s", async (_name, respond) => {
    await expect(
      postOrganizationCreate(identity(), async () => respond()),
    ).resolves.toEqual(unavailable);
  });

  test("keeps a reported field failure exactly as the server phrased it", async () => {
    const taken: AdministrationActionState = {
      code: "conflict",
      field: "slug",
      message: "That organization slug is already taken.",
      status: "error",
    };

    await expect(
      postOrganizationCreate(identity(), async () => jsonResponse(taken, 400)),
    ).resolves.toEqual(taken);
  });
});

describe("organization creation route handler", () => {
  test("answers a committed creation with the validated destination and never a redirect", async () => {
    const createOrganization = vi.fn(async () => created);
    const route = createOrganizationCreateRoute({ createOrganization });

    const response = await route.POST(createRequest(identity()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual(created);
    expect(
      (createOrganization.mock.calls[0] as unknown as [FormData])[0].get(
        "slug",
      ),
    ).toBe("example-org");
  });

  test.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["validation_failed", 400],
    ["rate_limited", 429],
    ["unexpected_error", 500],
    ["conflict", 400],
  ] as const)("answers a %s creation with %i", async (code, status) => {
    const route = createOrganizationCreateRoute({
      createOrganization: async () => ({
        code,
        message: "Denied.",
        status: "error",
      }),
    });

    const response = await route.POST(createRequest(identity()));

    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBeNull();
  });

  test("redacts a thrown creation failure behind the fixed message", async () => {
    const route = createOrganizationCreateRoute({
      createOrganization: async () => {
        throw new Error("postgres://secret@host/tenant insert");
      },
    });

    const response = await route.POST(createRequest(identity()));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("secret");
    expect(JSON.parse(body)).toEqual({
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
      status: "error",
    });
  });

  test("refuses a body the action cannot read without reaching the action", async () => {
    const createOrganization = vi.fn(async () => created);
    const route = createOrganizationCreateRoute({ createOrganization });

    const response = await route.POST(
      new Request(`http://127.0.0.1${ORGANIZATION_CREATE_ENDPOINT}`, {
        body: "not-a-form",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(createOrganization).not.toHaveBeenCalled();
  });
});

describe("organization creation dispatch boundary", () => {
  /**
   * Creating an organization makes it the current tenant, so it writes the same
   * cookie a switch writes and inherits the same hazard: Next stamps
   * `x-action-revalidated` on any action response whose mutable cookies
   * changed, and this action also called `revalidatePath("/", "layout")` and
   * `redirect("/")` outright — so the client took the SPA path and adopted the
   * new tenant's appearance triple during a transition in the open document.
   * Commit 646f693 moved the switch off that path for exactly this reason; the
   * creation has to be on the same side of the line.
   */
  test("never dispatches organization creation through a Server Action", () => {
    const modules = serverActionModules();

    expect(modules.length).toBeGreaterThan(0);
    for (const file of modules) {
      const named = file.slice(webRoot.length + 1);
      expect({
        file: named,
        mentionsCreate: readFileSync(file, "utf8").includes(
          "createOrganization",
        ),
      }).toEqual({ file: named, mentionsCreate: false });
    }
  });

  test("serves the endpoint from the route handler its own path names", () => {
    const handler = resolve(
      sourceRoot,
      "app",
      `${ORGANIZATION_CREATE_ENDPOINT.replace(/^\//u, "")}/route.ts`,
    );
    const source = readFileSync(handler, "utf8");

    expect(source).toContain("createOrganizationCreateRoute");
    expect(source).toContain("POST");
  });

  test("submits the creation from the client through that one endpoint", () => {
    const source = readFileSync(
      resolve(sourceRoot, "components", "administration-forms.tsx"),
      "utf8",
    );

    expect(source).toContain("postOrganizationCreate");
  });
});
