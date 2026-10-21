import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { declaresServerDirective } from "../test/source-text.js";
import type { AdministrationActionState } from "./administration-actions.js";
import {
  createOrganizationSwitchRoute,
  ORGANIZATION_SWITCH_DESTINATION,
  ORGANIZATION_SWITCH_ENDPOINT,
  postOrganizationSwitch,
} from "./organization-switch.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const webRoot = resolve(import.meta.dirname, "..", "..");
const sourceRoot = resolve(webRoot, "src");

const switched: AdministrationActionState = {
  destination: ORGANIZATION_SWITCH_DESTINATION,
  message: "Organization switched.",
  status: "success",
};

const unavailable: AdministrationActionState = {
  code: "unexpected_error",
  message: "Organization switching is temporarily unavailable.",
  status: "error",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function switchRequest(entries: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(entries)) body.set(key, value);
  return new Request(`http://127.0.0.1${ORGANIZATION_SWITCH_ENDPOINT}`, {
    body,
    method: "POST",
  });
}

/**
 * Modules that write the directive as data rather than as a directive.
 *
 * This suite is one of them: it has to spell the shape it detects in order to
 * prove the detector reads it, and it is scanned by its own survey. Naming the
 * file is the honest exemption — a pattern able to tell a directive from a
 * fixture of one is a JavaScript parser, and the invariant that keeps the list
 * safe is asserted rather than assumed: only a suite may ever appear here, so
 * no shipped module can buy its way out of the dispatch rule.
 */
const directiveFixtureModules = ["lib/organization-switch.test.ts"];

/** Every module the App Router compiles into a Server Action endpoint. */
function serverActionModules() {
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !directiveFixtureModules.includes(
          relative(sourceRoot, file).split(sep).join("/"),
        ) && declaresServerDirective(readFileSync(file, "utf8")),
    );
}

describe("organization switch transport", () => {
  test("posts the chosen organization to the endpoint and returns its verdict", async () => {
    const send = vi.fn(async () => jsonResponse(switched));

    await expect(
      postOrganizationSwitch(ORGANIZATION_ID, send),
    ).resolves.toEqual(switched);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ORGANIZATION_SWITCH_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.body as FormData).get("organizationId")).toBe(ORGANIZATION_ID);
  });

  test("reports the fixed unavailable message when the endpoint cannot be reached", async () => {
    const send = vi.fn(async () => {
      throw new Error("postgres://secret@host offline");
    });

    const result = await postOrganizationSwitch(ORGANIZATION_ID, send);

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
    [
      "a destination with a backslash authority",
      () =>
        jsonResponse({
          destination: "/\\evil.example",
          message: "ok",
          status: "success",
        }),
    ],
  ])("refuses %s", async (_name, respond) => {
    await expect(
      postOrganizationSwitch(ORGANIZATION_ID, async () => respond()),
    ).resolves.toEqual(unavailable);
  });

  test("keeps a reported switch failure exactly as the server phrased it", async () => {
    const denied: AdministrationActionState = {
      code: "forbidden",
      message: "That organization is unavailable.",
      status: "error",
    };

    await expect(
      postOrganizationSwitch(ORGANIZATION_ID, async () =>
        jsonResponse(denied, 403),
      ),
    ).resolves.toEqual(denied);
  });
});

describe("organization switch route handler", () => {
  test("answers a committed switch with the validated destination and never a redirect", async () => {
    const switchOrganization = vi.fn(async () => switched);
    const route = createOrganizationSwitchRoute({ switchOrganization });

    const response = await route.POST(
      switchRequest({ organizationId: ORGANIZATION_ID }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual(switched);
    expect(
      (switchOrganization.mock.calls[0] as unknown as [FormData])[0].get(
        "organizationId",
      ),
    ).toBe(ORGANIZATION_ID);
  });

  test.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["validation_failed", 400],
    ["rate_limited", 429],
    ["unexpected_error", 500],
    ["conflict", 400],
  ] as const)("answers a %s switch with %i", async (code, status) => {
    const route = createOrganizationSwitchRoute({
      switchOrganization: async () => ({
        code,
        message: "Denied.",
        status: "error",
      }),
    });

    const response = await route.POST(
      switchRequest({ organizationId: ORGANIZATION_ID }),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBeNull();
  });

  test("redacts a thrown switch failure behind the fixed message", async () => {
    const route = createOrganizationSwitchRoute({
      switchOrganization: async () => {
        throw new Error("postgres://secret@host/tenant lookup");
      },
    });

    const response = await route.POST(
      switchRequest({ organizationId: ORGANIZATION_ID }),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("secret");
    expect(JSON.parse(body)).toEqual({
      code: "unexpected_error",
      message: "RequestPort could not complete that action.",
      status: "error",
    });
  });

  test("refuses a body the switch cannot read without reaching the switch", async () => {
    const switchOrganization = vi.fn(async () => switched);
    const route = createOrganizationSwitchRoute({ switchOrganization });

    const response = await route.POST(
      new Request(`http://127.0.0.1${ORGANIZATION_SWITCH_ENDPOINT}`, {
        body: "not-a-form",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(switchOrganization).not.toHaveBeenCalled();
  });
});

describe("organization switch dispatch boundary", () => {
  /**
   * The cookie write is what makes the switch dangerous inside a Server Action.
   * Next stamps `x-action-revalidated` on *any* action response whose mutable
   * cookies changed, and the client reducer answers that header by refetching
   * and committing the route tree in the document that is still open — the
   * client transition this switch exists to avoid. A Route Handler's
   * `Set-Cookie` never passes through that machinery, so the endpoint is the
   * contract, not an implementation detail.
   */
  test("never dispatches the organization switch through a Server Action", () => {
    const modules = serverActionModules();

    expect(modules.length).toBeGreaterThan(0);
    for (const file of modules) {
      const named = file.slice(webRoot.length + 1);
      expect({
        file: named,
        mentionsSwitch: readFileSync(file, "utf8").includes(
          "switchOrganization",
        ),
      }).toEqual({ file: named, mentionsSwitch: false });
    }
  });

  test("reads the directive at the head of a module", () => {
    expect(
      declaresServerDirective(
        '"use server";\n\nexport async function act() {}',
      ),
    ).toBe(true);
    expect(
      declaresServerDirective(
        "// The tenant actions.\n'use server';\nexport async function act() {}",
      ),
    ).toBe(true);
  });

  test("reads the directive at the head of a function body", () => {
    // The shape a top-of-file pattern cannot see, and the cheapest one to
    // write: the module says nothing, and one function inside it is an action
    // endpoint. Both spellings of a body are the same statement position — and
    // both fixtures are written out verbatim, which is what puts this suite on
    // `directiveFixtureModules` and keeps that exemption honest.
    expect(
      declaresServerDirective(`
export async function switchTenant(formData: FormData) {
  "use server";
  return formData.get("organizationId");
}
`),
    ).toBe(true);
    expect(
      declaresServerDirective(`
export const switchTenant = async () => {
  'use server';
  return null;
};
`),
    ).toBe(true);
  });

  test("never reads a directive out of prose or out of a quoted example", () => {
    expect(
      declaresServerDirective(
        '/**\n * A plain module on purpose: a `"use server";` file may only\n * export async functions.\n */\nexport const code = 1;',
      ),
    ).toBe(false);
    expect(
      declaresServerDirective(
        'expect(source).toContain("use server");\nconst pattern = /["\']use server["\'];/u;',
      ),
    ).toBe(false);
    expect(declaresServerDirective("const shape = '\"use server\";';")).toBe(
      false,
    );
  });

  test("classifies the shipped tree, and exempts only a suite", () => {
    const modules = serverActionModules().map((file) =>
      relative(sourceRoot, file).split(sep).join("/"),
    );

    expect(modules).toContain("app/(app)/actions.ts");
    // Prose about the directive, in a module that carries none.
    expect(modules).not.toContain(
      "app/(app)/settings/appearance/action-state.ts",
    );

    for (const file of directiveFixtureModules) {
      expect({
        file,
        suite: /\.test\.tsx?$/u.test(file),
        writesTheShape: declaresServerDirective(
          readFileSync(resolve(sourceRoot, file), "utf8"),
        ),
      }).toEqual({ file, suite: true, writesTheShape: true });
    }
  });

  test("serves the endpoint from the route handler its own path names", () => {
    const handler = resolve(
      sourceRoot,
      "app",
      `${ORGANIZATION_SWITCH_ENDPOINT.replace(/^\//u, "")}/route.ts`,
    );
    const source = readFileSync(handler, "utf8");

    expect(source).toContain("createOrganizationSwitchRoute");
    expect(source).toContain("POST");
  });

  test("submits the switch from the client through that one endpoint", () => {
    const source = readFileSync(
      resolve(sourceRoot, "components", "organization-switcher.tsx"),
      "utf8",
    );

    expect(source).toContain("postOrganizationSwitch");
    expect(source).not.toContain("useActionState");
    expect(source).not.toContain("requestSubmit");
  });
});
