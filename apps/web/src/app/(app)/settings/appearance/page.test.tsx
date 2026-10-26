import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const page = vi.hoisted(() => ({
  mintOrganization: vi.fn((_input: unknown) => "organization-context-token"),
  mintPersonal: vi.fn((_actorId: unknown) => "personal-context-token"),
  organization: null as {
    id: string;
    name: string;
    role: string;
    slug: string;
  } | null,
  organizationVersion: 4,
  userId: "00000000-0000-4000-8000-0000000000aa",
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: page.organization,
    session: { session: { id: "session_live" }, user: { id: page.userId } },
  }),
}));

vi.mock("../../../../lib/server-appearance.js", () => ({
  getAppearance: async () => {
    const defaults = {
      theme: "cue",
      density: "normal",
      mode: "system",
      font: "match",
      look: "match",
      paint: "match",
    };
    const user = {
      theme: null,
      density: null,
      mode: null,
      font: null,
      look: null,
      paint: null,
      version: 0,
    };
    return {
      snapshot: {
        effective: {
          ...defaults,
          source: {
            theme: "organization",
            density: "organization",
            mode: "organization",
            font: "organization",
            look: "organization",
            paint: "organization",
          },
        },
        organization: { ...defaults, version: page.organizationVersion },
        user,
      },
      status: "authenticated",
    };
  },
}));

vi.mock("../../../../lib/server-appearance-actions.js", () => ({
  createOrganizationAppearanceRenderContext: page.mintOrganization,
  createPersonalAppearanceRenderContext: page.mintPersonal,
}));

// The forms are the controls' own suites' subject; here each stands in as a
// marker carrying the context token the page minted for it.
vi.mock("../../../../components/appearance-controls.js", () => ({
  OrganizationAppearanceForm: (props: { contextToken: string }) => (
    <form data-form="organization" data-token={props.contextToken} />
  ),
  PersonalAppearanceForm: (props: { contextToken: string }) => (
    <form data-form="personal" data-token={props.contextToken} />
  ),
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ status: "idle" });
  return {
    updateOrganizationAppearanceAction: inert,
    updatePersonalAppearanceAction: inert,
  };
});

import AppearanceSettingsPage from "./page.js";

/*
  Settings › Appearance (ruling 255). Who sees the Organization default
  section is the page's decision, and the token it mints for that form is
  the authority the organization action later checks. Only an owner or an
  admin of an organization with a defaults row gets either (ruling 255,
  item 7); everyone gets Just for you.
*/

const organizationId = "00000000-0000-4000-8000-0000000000d1";

function inOrganization(role: string) {
  page.organization = {
    id: organizationId,
    name: "CUE++",
    role,
    slug: "example-org",
  };
}

async function markup() {
  return renderToStaticMarkup((await AppearanceSettingsPage()) as ReactElement);
}

beforeEach(() => {
  page.mintOrganization.mockClear();
  page.mintPersonal.mockClear();
  page.organization = null;
  page.organizationVersion = 4;
});

describe("the appearance settings page", () => {
  test.each([
    ["owner", "As an owner you set the default for everyone in CUE++."],
    ["admin", "As an admin you set the default for everyone in CUE++."],
  ])(
    "gives the %s role the Organization default section and mints its token",
    async (role, description) => {
      inOrganization(role);

      const html = await markup();

      expect(html).toContain(
        '<h2 id="organization-appearance">Organization default</h2>',
      );
      expect(html).toContain(
        '<form data-form="organization" data-token="organization-context-token">',
      );
      expect(page.mintOrganization).toHaveBeenCalledTimes(1);
      expect(page.mintOrganization).toHaveBeenCalledWith({
        actorId: page.userId,
        organizationId,
      });
      expect(html).toContain(description);
      expect(html).toContain(
        '<form data-form="personal" data-token="personal-context-token">',
      );
    },
  );

  test("gives the member role neither the Organization default section nor its token", async () => {
    inOrganization("member");

    const html = await markup();

    expect(html).not.toContain("organization-appearance");
    expect(html).not.toContain("Organization default");
    expect(html).not.toContain('data-form="organization"');
    expect(page.mintOrganization).not.toHaveBeenCalled();
    expect(html).toContain("The owners and admins of CUE++ set its defaults.");
    expect(html).toContain(
      '<form data-form="personal" data-token="personal-context-token">',
    );
    expect(page.mintPersonal).toHaveBeenCalledWith(page.userId);
  });

  test.each(["owner", "admin"])(
    "offers the %s role nothing to edit before the organization has its defaults row",
    async (role) => {
      inOrganization(role);
      page.organizationVersion = 0;

      const html = await markup();

      expect(html).not.toContain('data-form="organization"');
      expect(page.mintOrganization).not.toHaveBeenCalled();
      expect(html).toContain('data-form="personal"');
    },
  );

  test("gives a person outside any organization Just for you alone", async () => {
    const html = await markup();

    expect(html).not.toContain('data-form="organization"');
    expect(page.mintOrganization).not.toHaveBeenCalled();
    expect(html).toContain(
      "Choose the theme, mode, density, typeface, Look and surface this account uses everywhere.",
    );
    expect(html).toContain('data-form="personal"');
  });
});
