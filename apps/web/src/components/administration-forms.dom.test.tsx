import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AdministrationActionState } from "../lib/administration-actions.js";
import { ORGANIZATION_CREATE_ENDPOINT } from "../lib/organization-create.js";
import {
  CreateProjectDialog,
  InvitationForm,
  InviteMemberDialog,
  OrganizationForm,
  ProjectForm,
} from "./administration-forms.js";
import { MembersView } from "./administration-views.js";
import { ConsoleToasts } from "./console-toasts.js";

/**
 * The organization, project and invitation forms, driven the way a person
 * drives them.
 *
 * Each form is bound to a real server action in production, so the action is
 * the one thing replaced here: the suite decides what a submission answers with
 * and then asserts where that answer lands — the rejected field's own error
 * line, or the fixed banner every other failure keeps.
 */

const idle: AdministrationActionState = { message: "", status: "success" };

function mount(node: ReactNode) {
  return render(
    <ThemeProvider
      density="ultra-compact"
      mode="system"
      persistPreferences={false}
      theme="requestport"
    >
      {node}
    </ThemeProvider>,
  );
}

/**
 * A confirmation, found in the toast viewport rather than in the form's own
 * result line, which is drawn in the dialog until it closes.
 */
async function toastSaying(text: string) {
  return within(
    screen.getByRole("region", { name: "Notifications" }),
  ).findByText(text);
}

/** The FormData one mocked action received, keyed by field name. */
function submitted(action: { mock: { calls: unknown[][] } }) {
  const data = action.mock.calls.at(-1)?.[1] as FormData | undefined;
  if (!data) throw new Error("the action was never invoked");

  return Object.fromEntries(
    [...data.entries()].map(([name, value]) => [name, String(value)]),
  );
}

/**
 * The organization form is the one form here that is not a Server Action.
 *
 * Creating an organization makes it the current tenant, so it writes the
 * active-organization cookie, and a cookie written inside an action makes the
 * router refetch the current route tree into the open document — the client
 * transition that would adopt the new tenant's appearance triple mid-document.
 * It posts to a Route Handler instead, so what is replaced here is `fetch` and
 * `window.location`, not an injected action.
 */
const send = vi.fn();
const assign = vi.fn();

function stubCreateEndpoint(verdict: AdministrationActionState, status = 200) {
  send.mockResolvedValue(
    new Response(JSON.stringify(verdict), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

/** The FormData the create endpoint was posted, keyed by field name. */
function posted() {
  const [, init] = (send.mock.calls.at(-1) ?? []) as [string, RequestInit];
  if (!init) throw new Error("the endpoint was never posted to");

  return Object.fromEntries(
    [...(init.body as FormData).entries()].map(([name, value]) => [
      name,
      String(value),
    ]),
  );
}

async function createOrganization(
  user: ReturnType<typeof userEvent.setup>,
  slug = "example-org",
) {
  await user.type(screen.getByLabelText("Organization name"), "CUE++");
  await user.type(screen.getByLabelText("Organization slug"), slug);
  await user.click(screen.getByRole("button", { name: "Create organization" }));
}

/** Picks one row out of a `Select`'s portalled listbox by its visible label. */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: string,
  option: RegExp | string,
) {
  await user.click(screen.getByRole("combobox", { name: control }));
  await user.click(
    within(await screen.findByRole("listbox")).getByRole("option", {
      name: option,
    }),
  );
}

const action = vi.fn();

beforeEach(() => {
  action.mockReset();
  action.mockResolvedValue(idle);
  send.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", send);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign, href: "http://localhost/", pathname: "/", search: "" },
  });
  stubCreateEndpoint({ message: "", status: "success" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("creating the first organization", () => {
  test("names every visible control through its own field", () => {
    mount(<OrganizationForm />);

    expect(screen.getByLabelText("Organization name")).toBeInTheDocument();
    expect(screen.getByLabelText("Organization slug")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create organization" }),
    ).toBeInTheDocument();
  });

  test("posts exactly the two canonical identity values to the create endpoint", async () => {
    const user = userEvent.setup();
    mount(<OrganizationForm />);

    await createOrganization(user);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ORGANIZATION_CREATE_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(posted()).toEqual({ name: "CUE++", slug: "example-org" });
  });

  test("navigates the whole document to the destination the server validated", async () => {
    const user = userEvent.setup();
    stubCreateEndpoint({
      destination: "/",
      message: "Organization created.",
      status: "success",
    });
    mount(<OrganizationForm />);

    await createOrganization(user);

    // The new organization is the current tenant, so its inherited appearance
    // triple has to be resolved by the *next* document rather than adopted in
    // this one during a client transition.
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  test("submits the creation without a Server Action to answer for it", async () => {
    const user = userEvent.setup();
    mount(<OrganizationForm />);

    await createOrganization(user);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
  });

  test("puts a rejected field's message on that field and not in the banner", async () => {
    const user = userEvent.setup();
    stubCreateEndpoint(
      {
        code: "conflict",
        field: "slug",
        message: "That organization slug is already taken.",
        status: "error",
      },
      400,
    );
    mount(<OrganizationForm />);

    // A value the control's own pattern accepts: the browser would refuse to
    // submit anything else, and the rejection under test is the server's.
    await createOrganization(user);

    const slug = await screen.findByText(
      "That organization slug is already taken.",
    );
    expect(slug).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  test("banners a failure that names no field", async () => {
    const user = userEvent.setup();
    stubCreateEndpoint(
      {
        code: "conflict",
        message: "That canonical value is already in use.",
        status: "error",
      },
      400,
    );
    mount(<OrganizationForm />);

    await createOrganization(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That canonical value is already in use.",
    );
  });

  test("puts the allowlisted result code on the line that carries the message", async () => {
    const user = userEvent.setup();
    stubCreateEndpoint(
      {
        code: "conflict",
        field: "slug",
        message: "That organization slug is already taken.",
        status: "error",
      },
      400,
    );
    mount(<OrganizationForm />);

    await createOrganization(user);

    // §12 closes the failure vocabulary, so the code travels with the sentence
    // it produced — on the field's own line when the failure names a field.
    const line = await screen.findByText(
      "That organization slug is already taken.",
    );
    expect(line).toHaveAttribute("data-slot", "field-error");
    expect(line).toHaveAttribute("data-code", "conflict");
  });

  test("puts the code on the banner when the failure names no field", async () => {
    const user = userEvent.setup();
    stubCreateEndpoint(
      {
        code: "conflict",
        message: "That canonical value is already in use.",
        status: "error",
      },
      400,
    );
    mount(<OrganizationForm />);

    await createOrganization(user);

    const line = await screen.findByText(
      "That canonical value is already in use.",
    );
    expect(line).toHaveAttribute("data-code", "conflict");
  });

  test("records no result code while nothing has failed", () => {
    const view = mount(<OrganizationForm />);

    expect(view.container.querySelector("[data-code]")).toBeNull();
  });

  test("reports the fixed unavailable message when the endpoint cannot be reached", async () => {
    const user = userEvent.setup();
    send.mockRejectedValue(new Error("postgres://secret@host offline"));
    mount(<OrganizationForm />);

    await createOrganization(user);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This action is temporarily unavailable.");
    expect(banner).not.toHaveTextContent("secret");
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("registering a project", () => {
  test("gives the description a real labelled multi-line control", async () => {
    const user = userEvent.setup();
    mount(<ProjectForm action={action} />);

    const description = screen.getByLabelText("Description");
    expect(description.tagName).toBe("TEXTAREA");

    await user.type(screen.getByLabelText("Project name"), "Platform");
    await user.type(screen.getByLabelText("Request key prefix"), "PLT");
    await user.type(screen.getByLabelText("Project slug"), "platform");
    await user.type(description, "The console");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toMatchObject({
      description: "The console",
      keyPrefix: "PLT",
      name: "Platform",
      slug: "platform",
    });
  });

  test("puts a rejected key prefix on its own field", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      code: "conflict",
      field: "keyPrefix",
      message: "That request key prefix is already registered.",
      status: "error",
    } satisfies AdministrationActionState);
    mount(<ProjectForm action={action} />);

    await user.type(screen.getByLabelText("Project name"), "Platform");
    await user.type(screen.getByLabelText("Request key prefix"), "PLT");
    await user.type(screen.getByLabelText("Project slug"), "platform");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(
      await screen.findByText("That request key prefix is already registered."),
    ).toHaveAttribute("data-slot", "field-error");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("inviting a member", () => {
  test("offers the owner role only to an owner", async () => {
    const user = userEvent.setup();
    const view = mount(
      <InvitationForm action={action} canInviteOwner={false} />,
    );

    await user.click(screen.getByRole("combobox", { name: "Role" }));
    const roles = within(await screen.findByRole("listbox"));
    expect(roles.queryByRole("option", { name: "Owner" })).toBeNull();
    await user.keyboard("{Escape}");

    view.unmount();
    mount(<InvitationForm action={action} canInviteOwner />);
    await user.click(screen.getByRole("combobox", { name: "Role" }));
    expect(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Owner",
      }),
    ).toBeInTheDocument();
  });

  test("submits the chosen address and role", async () => {
    const user = userEvent.setup();
    mount(<InvitationForm action={action} canInviteOwner />);

    await user.type(screen.getByLabelText("Email address"), "new@example.com");
    await choose(user, "Role", "Admin");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(submitted(action)).toEqual({
      email: "new@example.com",
      role: "admin",
    });
  });

  test("puts a rejected address on the address field", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      code: "validation_failed",
      field: "email",
      message: "Check the highlighted field and try again.",
      status: "error",
    } satisfies AdministrationActionState);
    mount(<InvitationForm action={action} canInviteOwner={false} />);

    await user.type(screen.getByLabelText("Email address"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(
      await screen.findByText("Check the highlighted field and try again."),
    ).toHaveAttribute("data-slot", "field-error");
  });

  // X15: the state `inviteMember` answers when the invite command refuses an
  // address that already has an account (`administration-actions.test.ts`
  // drives that answer through the command on the bus).
  test("puts the existing-account refusal on the address field, not in the banner", async () => {
    const user = userEvent.setup();
    const message =
      "This person already has a RequestPort account. Inviting an existing account is not supported yet, so no invitation was sent.";
    action.mockResolvedValue({
      code: "conflict",
      field: "email",
      message,
      status: "error",
    } satisfies AdministrationActionState);
    mount(<InvitationForm action={action} canInviteOwner={false} />);

    await user.type(
      screen.getByLabelText("Email address"),
      "known@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    const line = await screen.findByText(message);
    expect(line).toHaveAttribute("data-slot", "field-error");
    expect(line).toHaveAttribute("data-code", "conflict");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/**
 * The forms a settings page opens from its header (ruling 259): the trigger is
 * the header's one primary action, the form is in a non-modal dialog, and a
 * write that succeeds closes the dialog and is confirmed in a toast.
 */
describe("a form opened from a page's action", () => {
  function mountOnPage(node: ReactNode) {
    return mount(<ConsoleToasts>{node}</ConsoleToasts>);
  }

  test("opens the invitation in a dialog from Invite member, not on the page", async () => {
    const user = userEvent.setup();
    mountOnPage(<InviteMemberDialog action={action} canInviteOwner={false} />);

    expect(screen.queryByLabelText("Email address")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Invite member" }));

    const dialog = await screen.findByRole("dialog", { name: "Invite member" });
    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument();
    // The acceptance drivers find a form's dialog through this: the trigger
    // names the dialog it opened, so a toast (a `dialog` too) is never taken
    // for it.
    expect(
      screen.getByRole("button", { name: "Invite member" }),
    ).toHaveAttribute("aria-controls", dialog.id);
    expect(
      within(dialog).getByRole("button", { name: "Send invitation" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
  });

  test("closes on a sent invitation and says so in a toast", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      message: "Invitation created and queued for email.",
      status: "success",
    } satisfies AdministrationActionState);
    mountOnPage(<InviteMemberDialog action={action} canInviteOwner={false} />);

    await user.click(screen.getByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite member" });
    await user.type(
      within(dialog).getByLabelText("Email address"),
      "new@example.com",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Send invitation" }),
    );

    expect(
      await toastSaying("Invitation created and queued for email."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Invite member" }),
      ).toBeNull(),
    );
  });

  test("stays open on a refusal, with the refusal on its field", async () => {
    const user = userEvent.setup();
    action.mockResolvedValue({
      code: "validation_failed",
      field: "email",
      message: "Check the highlighted field and try again.",
      status: "error",
    } satisfies AdministrationActionState);
    mountOnPage(<InviteMemberDialog action={action} canInviteOwner={false} />);

    await user.click(screen.getByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite member" });
    await user.type(
      within(dialog).getByLabelText("Email address"),
      "new@example.com",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Send invitation" }),
    );

    expect(
      await within(dialog).findByText(
        "Check the highlighted field and try again.",
      ),
    ).toHaveAttribute("data-slot", "field-error");
    expect(
      screen.getByRole("dialog", { name: "Invite member" }),
    ).toBeInTheDocument();
  });

  test("opens a choice in the dialog as a listbox assistive technology can reach", async () => {
    // A modal dialog hides every other child of <body>, and a cue-ui Select
    // portals through a <body> child it appended when it mounted — with the
    // dialog — so its listbox would open inside an aria-hidden subtree.
    const user = userEvent.setup();
    mountOnPage(<InviteMemberDialog action={action} canInviteOwner />);

    await user.click(screen.getByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite member" });
    await user.click(within(dialog).getByRole("combobox", { name: "Role" }));

    const roles = await screen.findByRole("listbox");
    expect(roles.closest('[aria-hidden="true"]')).toBeNull();
    await user.click(within(roles).getByRole("option", { name: "Admin" }));
    expect(
      within(dialog).getByRole("combobox", { name: "Role" }),
    ).toHaveTextContent("Admin");
  });

  /**
   * The members page hands its invitation the Owner role for an owner only:
   * the role the server refuses to an admin is not offered to one.
   */
  async function invitationRolesFor(role: "owner" | "admin") {
    const user = userEvent.setup();
    mountOnPage(
      <MembersView
        currentUserId="user_1"
        invitationAction={action}
        invitations={[]}
        members={[]}
        organization={{
          id: "00000000-0000-4000-8000-000000000001",
          name: "CUE++",
          role,
          slug: "example-org",
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite member" });
    await user.click(within(dialog).getByRole("combobox", { name: "Role" }));
    const roles = await screen.findByRole("listbox");
    return within(roles)
      .getAllByRole("option")
      .map((option) => option.textContent);
  }

  test("offers an owner the Owner role in the members page's invitation", async () => {
    expect(await invitationRolesFor("owner")).toEqual([
      "Member",
      "Admin",
      "Owner",
    ]);
  });

  test("never offers an admin the Owner role in the members page's invitation", async () => {
    expect(await invitationRolesFor("admin")).toEqual(["Member", "Admin"]);
  });

  test("opens project registration in a dialog from New project", async () => {
    const user = userEvent.setup();
    mountOnPage(<CreateProjectDialog action={action} />);

    expect(screen.queryByLabelText("Project name")).toBeNull();
    await user.click(screen.getByRole("button", { name: "New project" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Create project",
    });
    expect(within(dialog).getByLabelText("Project name")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Create project" }),
    ).toBeInTheDocument();
  });
});
