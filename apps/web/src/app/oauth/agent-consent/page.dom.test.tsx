import { ThemeProvider } from "@cueplusplus/ui/system";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const idle = { message: "", status: "idle" } as const;

const consent = vi.hoisted(() => ({
  approve: vi.fn(),
  deny: vi.fn(),
  getConsentOptions: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createAgentManagementRepository: () => ({
    getConsentOptions: consent.getConsentOptions,
  }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3). This lane declares no database surface, so the real
// root would refuse the page its storage.
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => ({
  approveAgentConsentAction: consent.approve,
  denyAgentConsentAction: consent.deny,
}));

import AgentConsentPage from "./page.js";

const laneId = "00000000-0000-4000-8000-0000000000b1";
const secondLaneId = "00000000-0000-4000-8000-0000000000b2";
const projectId = "00000000-0000-4000-8000-0000000000c1";
const organizationId = "00000000-0000-4000-8000-0000000000d1";
const secondProjectId = "00000000-0000-4000-8000-0000000000c2";
const otherOrganizationId = "00000000-0000-4000-8000-0000000000d2";

const options = {
  agents: [
    {
      displayName: "Release bot",
      id: "00000000-0000-4000-8000-0000000000a1",
      organizationId,
      organizationName: "CUE++",
      // The repository selects this, and the screen now depends on it: a
      // principal is only offered where the binder would accept it. A fixture
      // without it describes a row the query cannot return.
      projectId,
    },
    {
      displayName: "Someone else's bot",
      id: "00000000-0000-4000-8000-0000000000a2",
      organizationId,
      organizationName: "CUE++",
      projectId: "00000000-0000-4000-8000-0000000000c9",
    },
    {
      displayName: "Payments bot",
      id: "00000000-0000-4000-8000-0000000000a3",
      organizationId,
      organizationName: "CUE++",
      projectId: secondProjectId,
    },
    {
      displayName: "House keeper",
      id: "00000000-0000-4000-8000-0000000000a4",
      organizationId,
      organizationName: "CUE++",
      projectId: null,
    },
    {
      // Organization-scoped, but somebody else's organization. The repository
      // returns every organization this person belongs to.
      displayName: "Other org keeper",
      id: "00000000-0000-4000-8000-0000000000a5",
      organizationId: otherOrganizationId,
      organizationName: "Elsewhere",
      projectId: null,
    },
  ],
  client: {
    clientId: "client-abcdef",
    name: "Fixture agent",
    uri: "https://agent.example",
  },
  lanes: [
    { id: laneId, name: "release", projectId },
    { id: secondLaneId, name: "payouts", projectId: secondProjectId },
  ],
  organizations: [{ id: organizationId, name: "CUE++" }],
  projects: [
    {
      id: projectId,
      name: "Platform",
      organizationId,
      organizationName: "CUE++",
    },
    {
      id: secondProjectId,
      name: "Payments",
      organizationId,
      organizationName: "CUE++",
    },
  ],
};

async function renderConsent() {
  const page = (await AgentConsentPage({
    searchParams: Promise.resolve({
      client_id: "client-abcdef",
      resource: "https://requestport.test/mcp",
      scope: "request:read",
    }),
  })) as ReactElement;

  return render(
    <ThemeProvider persistPreferences={false} theme="requestport">
      {page}
    </ThemeProvider>,
  );
}

function consentForm(name: string) {
  const form = screen.getByRole("form", { name });
  if (!(form instanceof HTMLFormElement)) {
    throw new Error(`missing consent form: ${name}`);
  }
  return form;
}

beforeEach(() => {
  consent.getConsentOptions.mockReset();
  consent.getConsentOptions.mockResolvedValue(options);
  consent.approve.mockReset();
  consent.approve.mockResolvedValue(idle);
  consent.deny.mockReset();
  consent.deny.mockResolvedValue(idle);
});

describe("agent consent interaction", () => {
  test("submits no lane restriction until a lane is chosen", async () => {
    const user = userEvent.setup();
    await renderConsent();

    const group = screen.getByRole("group", { name: "Lane restriction" });

    expect(
      new FormData(consentForm("Allow connection")).getAll("laneIds"),
    ).toEqual([]);

    await user.click(
      within(group).getByRole("checkbox", { name: "Platform / release" }),
    );

    expect(
      new FormData(consentForm("Allow connection")).getAll("laneIds"),
    ).toEqual([laneId]);
  });

  test("binds the project and principal choices the server revalidates", async () => {
    const user = userEvent.setup();
    await renderConsent();

    expect(
      new FormData(consentForm("Allow connection")).get("projectBinding"),
    ).toBe(`${organizationId}:${projectId}`);
    expect(
      new FormData(consentForm("Allow connection")).get("agentPrincipalId"),
    ).toBe("new");

    await user.click(screen.getByRole("combobox", { name: "Agent principal" }));
    const listbox = await screen.findByRole("listbox");
    await user.click(
      within(listbox).getByRole("option", { name: "CUE++ / Release bot" }),
    );

    expect(
      new FormData(consentForm("Allow connection")).get("agentPrincipalId"),
    ).toBe(options.agents[0]?.id);
  });

  test("keeps deny a separate single-field submission", async () => {
    await renderConsent();

    const deny = new FormData(consentForm("Deny connection"));

    expect(deny.get("oauthQuery")).toContain("client_id=client-abcdef");
    expect(deny.get("projectBinding")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Deny" }).getAttribute("type"),
    ).toBe("submit");
  });
});

/**
 * The three halves of the form contract, on the one form that had none of
 * them: a server-side field failure lands on the control it is about, a
 * failure that names no field lands in the fixed banner, and a decision in
 * flight is visible on both submits.
 */
describe("agent consent form contract", () => {
  test.each([
    ["projectBinding", "Organization and project"],
    ["agentPrincipalId", "Agent principal"],
    ["displayName", "Display name"],
    ["slug", "Stable slug"],
    ["softwareName", "Software name"],
  ])("addresses a rejected %s to its own control", async (field, label) => {
    const user = userEvent.setup();
    const message = `The ${label.toLowerCase()} was refused.`;
    consent.approve.mockResolvedValue({ field, message, status: "error" });
    await renderConsent();

    await user.click(screen.getByRole("button", { name: "Allow connection" }));

    const line = await screen.findByText(message);
    expect(line).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("keeps a refusal that names no field in the fixed banner", async () => {
    const user = userEvent.setup();
    consent.approve.mockResolvedValue({
      message: "That connection could not be authorized.",
      status: "error",
    });
    await renderConsent();

    await user.click(screen.getByRole("button", { name: "Allow connection" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(
      "That connection could not be authorized.",
    );
  });

  test("keeps a refused denial in its own fixed banner", async () => {
    const user = userEvent.setup();
    consent.deny.mockResolvedValue({
      message: "That request could not be declined.",
      status: "error",
    });
    await renderConsent();

    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That request could not be declined.",
    );
  });

  test("shows both decisions as pending while one is in flight", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    consent.approve.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve(idle);
        }),
    );
    await renderConsent();

    const allow = screen.getByRole("button", {
      name: /Allow connection|Allowing/u,
    });
    await user.click(allow);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Allow connection|Allowing/u }),
      ).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();

    await act(async () => {
      settle();
    });
  });

  test("requires the new principal's three values only while one is created", async () => {
    const user = userEvent.setup();
    await renderConsent();

    for (const label of ["Display name", "Stable slug", "Software name"]) {
      expect(screen.getByLabelText(label)).toBeRequired();
    }

    await user.click(screen.getByRole("combobox", { name: "Agent principal" }));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "CUE++ / Release bot",
      }),
    );

    for (const label of ["Display name", "Stable slug", "Software name"]) {
      expect(screen.getByLabelText(label)).not.toBeRequired();
    }
  });
});

/**
 * Both decisions write, and they write opposite things: approve binds the grant
 * and revokes whatever the agent held before, while deny answers the waiting
 * client with `access_denied`. Neither is instant, so whichever one is in
 * flight has to make the other unreachable until it settles — otherwise a
 * second, impatient click binds the very connection the first click declined.
 */
describe("one decision at a time", () => {
  test("dispatches no approval while a denial is in flight", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    consent.deny.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve(idle);
        }),
    );
    await renderConsent();

    await user.click(screen.getByRole("button", { name: "Deny" }));
    // The denial is genuinely in flight once its own control says so; without
    // this the allow below could be clicked before the deny ever dispatched.
    await screen.findByRole("button", { name: "Denying…" });

    await user.click(
      screen.getByRole("button", { name: /Allow connection|Allowing/u }),
    );

    expect(consent.approve).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Allow connection|Allowing/u }),
    ).toBeDisabled();

    await act(async () => {
      settle();
    });
  });

  test("dispatches no denial while an approval is in flight", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    consent.approve.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve(idle);
        }),
    );
    await renderConsent();

    await user.click(screen.getByRole("button", { name: "Allow connection" }));
    await screen.findByRole("button", { name: "Allowing…" });

    await user.click(screen.getByRole("button", { name: /Deny|Denying/u }));

    expect(consent.deny).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Deny|Denying/u }),
    ).toBeDisabled();

    await act(async () => {
      settle();
    });
  });
});

/**
 * The binder accepts a principal that is organization-scoped, or one belonging
 * to the very project the grant names — not merely one from some project this
 * person manages. A screen that offers the rest hands out choices whose only
 * outcome is "you do not have permission to authorize this connection".
 */
describe("principals the binder would accept", () => {
  async function principalListbox(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("combobox", { name: "Agent principal" }));
    return await screen.findByRole("listbox");
  }

  test("offers only the selected project's principals, and the org's own", async () => {
    const user = userEvent.setup();
    await renderConsent();

    const listbox = await principalListbox(user);

    expect(
      within(listbox).getByRole("option", { name: "CUE++ / Release bot" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "CUE++ / House keeper" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).queryByRole("option", { name: "CUE++ / Payments bot" }),
    ).not.toBeInTheDocument();
  });

  test("follows the project a person switches to", async () => {
    const user = userEvent.setup();
    await renderConsent();

    await user.click(
      screen.getByRole("combobox", { name: "Organization and project" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "CUE++ / Payments",
      }),
    );

    const listbox = await principalListbox(user);

    expect(
      within(listbox).getByRole("option", { name: "CUE++ / Payments bot" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).queryByRole("option", { name: "CUE++ / Release bot" }),
    ).not.toBeInTheDocument();
  });

  test("does not submit a principal the new project cannot accept", async () => {
    const user = userEvent.setup();
    await renderConsent();

    await user.click(
      within(await principalListbox(user)).getByRole("option", {
        name: "CUE++ / Release bot",
      }),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Organization and project" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "CUE++ / Payments",
      }),
    );

    // Left as it was, the form would post Release bot against Payments — a
    // refusal the person never chose and cannot see coming.
    expect(
      new FormData(consentForm("Allow connection")).get("agentPrincipalId"),
    ).toBe("new");
  });
});

/**
 * A lane belongs to one project and the binder refuses one from any other, so
 * the screen draws only the lanes of the project selected beside them.
 */
describe("lanes the binder would accept", () => {
  test("draws only the selected project's lanes", async () => {
    await renderConsent();

    const group = screen.getByRole("group", { name: "Lane restriction" });

    expect(
      within(group).getByRole("checkbox", { name: "Platform / release" }),
    ).toBeInTheDocument();
    expect(
      within(group).queryByRole("checkbox", { name: "Payments / payouts" }),
    ).not.toBeInTheDocument();
  });

  test("follows the project a person switches to", async () => {
    const user = userEvent.setup();
    await renderConsent();

    await user.click(
      screen.getByRole("combobox", { name: "Organization and project" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "CUE++ / Payments",
      }),
    );

    const group = screen.getByRole("group", { name: "Lane restriction" });

    expect(
      within(group).getByRole("checkbox", { name: "Payments / payouts" }),
    ).toBeInTheDocument();
    expect(
      within(group).queryByRole("checkbox", { name: "Platform / release" }),
    ).not.toBeInTheDocument();
  });

  test("submits no lane the new project cannot accept", async () => {
    const user = userEvent.setup();
    await renderConsent();

    const group = screen.getByRole("group", { name: "Lane restriction" });
    await user.click(
      within(group).getByRole("checkbox", { name: "Platform / release" }),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Organization and project" }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "CUE++ / Payments",
      }),
    );

    // A lane checked under Platform must not travel to Payments, where the
    // binder would refuse it as a permission failure nobody chose.
    expect(
      new FormData(consentForm("Allow connection")).getAll("laneIds"),
    ).toEqual([]);
  });
});

/**
 * A principal belongs to one organization, and the binder scopes by it.
 *
 * `getConsentOptions` returns principals from every organization this person
 * belongs to, and the first filtering pass compared only projects — so an
 * organization-scoped principal from somebody else's organization was offered
 * against this one, and the binder refused it as a permission failure. That is
 * the same false refusal the lanes gave, one field over.
 */
describe("principals from another organization", () => {
  test("are not offered against this one", async () => {
    const user = userEvent.setup();
    await renderConsent();

    await user.click(screen.getByRole("combobox", { name: "Agent principal" }));
    const listbox = await screen.findByRole("listbox");

    expect(
      within(listbox).getByRole("option", { name: "CUE++ / House keeper" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).queryByRole("option", {
        name: "Elsewhere / Other org keeper",
      }),
    ).not.toBeInTheDocument();
  });
});
