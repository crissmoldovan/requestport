import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ORGANIZATION_SWITCH_ENDPOINT } from "../lib/organization-switch.js";
import {
  CREATE_ORGANIZATION_OPTION,
  OrganizationSwitcher,
} from "./organization-switcher.js";

const organizations = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "RequestPort",
    role: "member",
    slug: "requestport",
  },
] as const;

const assign = vi.fn();

function stubNavigation() {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign, href: "http://localhost/", pathname: "/", search: "" },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => {
  assign.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderSwitcher(
  available: readonly (typeof organizations)[number][] = organizations,
) {
  return render(
    <ThemeProvider persistPreferences={false} theme="requestport">
      <OrganizationSwitcher
        currentOrganization={available[0] ?? null}
        organizations={[...available]}
      />
    </ThemeProvider>,
  );
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  option: string,
) {
  await user.click(
    screen.getByRole("combobox", { name: "Current organization" }),
  );
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: option }));
}

describe("organization switcher", () => {
  test("posts the chosen organization to the switch endpoint and navigates the whole document", async () => {
    stubNavigation();
    const user = userEvent.setup();
    const send = vi.fn(async () =>
      jsonResponse({
        destination: "/",
        message: "Organization switched.",
        status: "success",
      }),
    );
    vi.stubGlobal("fetch", send);

    renderSwitcher();
    await choose(user, "RequestPort");

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ORGANIZATION_SWITCH_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.body as FormData).get("organizationId")).toBe(
      organizations[1].id,
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  test("never navigates while the switch is still pending or unresolved", async () => {
    stubNavigation();
    const user = userEvent.setup();
    vi.stubGlobal("fetch", async () =>
      jsonResponse(
        {
          code: "forbidden",
          message: "That organization is unavailable.",
          status: "error",
        },
        403,
      ),
    );

    renderSwitcher();
    await choose(user, "RequestPort");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That organization is unavailable.",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  /**
   * It used to be disabled outright, which was right while every entry in it
   * was a tenant this account could not switch to. It now also holds the one
   * action that account needs, so disabling it would lock the door on exactly
   * the person standing outside it.
   */
  test("stays usable for an account that belongs to no organization", async () => {
    const user = userEvent.setup();
    renderSwitcher([]);

    const control = screen.getByRole("combobox", {
      name: "Current organization",
    });
    expect(control).toBeEnabled();

    await user.click(control);
    const listbox = await screen.findByRole("listbox");
    const labels = within(listbox)
      .getAllByRole("option")
      .map((option) => option.textContent?.trim());

    // Nothing to switch to, and the one thing there is to do.
    expect(labels).toEqual(["No organization", "Create organization…"]);
  });

  test("reports the fixed unavailable message when the endpoint cannot be reached", async () => {
    stubNavigation();
    const user = userEvent.setup();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network detail");
    });

    renderSwitcher();
    await choose(user, "RequestPort");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Organization switching is temporarily unavailable.",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  test("keeps a long organization name inside one native control", () => {
    const long = "W".repeat(120);
    render(
      <ThemeProvider persistPreferences={false} theme="requestport">
        <OrganizationSwitcher
          currentOrganization={{ ...organizations[0], name: long }}
          organizations={[{ ...organizations[0], name: long }]}
        />
      </ThemeProvider>,
    );

    expect(
      screen.getByRole("combobox", { name: "Current organization" }),
    ).toHaveTextContent(long);
  });

  test("submits the switch without a form the framework could turn into an action", () => {
    const { container } = renderSwitcher();

    expect(container.querySelector("form")).toBeNull();
  });
});

/**
 * The second door.
 *
 * `/api/organization/create` is routed and `postOrganizationCreate` exists, and
 * until now nothing in the interface reached either: `OrganizationForm` is
 * rendered only by `NoOrganizationSetup`, the page shown to an account that has
 * no organization at all. So an account arrived at its first organization
 * during bootstrap and could never have a second — which after bootstrap is
 * every account, and which made the organization-switch journey of Task 12 Step
 * 7 impossible to drive.
 *
 * Reported by the product owner: "i cannot switch as i have a single org and no
 * create new org button."
 */
describe("reaching organization creation", () => {
  test("offers creation beneath the organizations it lists", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(
      screen.getByRole("combobox", { name: "Current organization" }),
    );
    const listbox = await screen.findByRole("listbox");
    const labels = within(listbox)
      .getAllByRole("option")
      .map((option) => option.textContent?.trim());

    expect(labels).toEqual(["CUE++", "RequestPort", "Create organization…"]);
  });

  test("offers it to an account that has none, where the switch itself is dead", async () => {
    const user = userEvent.setup();
    renderSwitcher([]);

    await user.click(
      screen.getByRole("combobox", { name: "Current organization" }),
    );
    const listbox = await screen.findByRole("listbox");

    expect(
      within(listbox).getByRole("option", { name: "Create organization…" }),
    ).toBeInTheDocument();
  });

  test("opens the creation form rather than switching to it", async () => {
    const user = userEvent.setup();
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    renderSwitcher();

    await choose(user, "Create organization…");

    const dialog = await screen.findByRole("dialog");

    expect(
      within(dialog).getByRole("textbox", { name: "Organization name" }),
    ).toBeInTheDocument();
    // Choosing it is not a tenant change, so nothing was posted. The switcher
    // itself is not asserted here: the dialog is modal, so the rest of the page
    // is out of the accessibility tree while it is open, which is the point.
    expect(send).not.toHaveBeenCalled();
  });

  // The sentinel shares a list with organization identifiers, which are UUIDs,
  // so it cannot be one — asserted rather than assumed, because a collision
  // would silently switch to an organization instead of creating one.
  test("uses a sentinel no organization identifier could equal", () => {
    for (const organization of organizations) {
      expect(organization.id).not.toBe(CREATE_ORGANIZATION_OPTION);
    }
    expect(CREATE_ORGANIZATION_OPTION).not.toMatch(/^[0-9a-f-]{36}$/u);
  });
});
