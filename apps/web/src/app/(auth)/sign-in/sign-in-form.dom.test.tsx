import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({
  email: vi.fn(
    async (_request: {
      callbackURL: string;
      email: string;
      password: string;
    }): Promise<unknown> => ({ data: {}, error: null }),
  ),
  magicLink: vi.fn(
    async (_request: {
      callbackURL: string;
      email: string;
      errorCallbackURL: string;
      newUserCallbackURL: string;
    }) => {},
  ),
  social: vi.fn(
    async (_request: {
      callbackURL: string;
      errorCallbackURL: string;
      newUserCallbackURL: string;
      provider: string;
    }) => {},
  ),
}));

vi.mock("@requestport/auth/client", () => ({
  authClient: {
    signIn: {
      email: client.email,
      magicLink: client.magicLink,
      social: client.social,
    },
  },
}));

import { LostCredentialHelp, SignInForm } from "./sign-in-form.js";

function renderForm(resumeTo?: string) {
  return render(
    <ThemeProvider persistPreferences={false} theme="requestport">
      <SignInForm
        methods={{ github: true, magicLink: true, localCredential: false }}
        resumeTo={resumeTo}
      />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  client.email.mockReset();
  client.email.mockResolvedValue({ data: {}, error: null });
  client.magicLink.mockReset();
  client.magicLink.mockResolvedValue(undefined);
  client.social.mockReset();
  client.social.mockResolvedValue(undefined);
});

describe("sign-in controls", () => {
  test("labels the email control and starts the GitHub journey from a native button", async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByLabelText("Work email")).toHaveAttribute(
      "type",
      "email",
    );

    await user.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );

    await waitFor(() => expect(client.social).toHaveBeenCalledTimes(1));
    expect(client.social.mock.calls[0]?.[0]).toMatchObject({
      callbackURL: "/",
      errorCallbackURL: "/auth-error",
      provider: "github",
    });
  });

  test("requests a magic link and announces the existence-neutral result", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(
      screen.getByLabelText("Work email"),
      "owner@example.invalid",
    );
    await user.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    await waitFor(() => expect(client.magicLink).toHaveBeenCalledTimes(1));
    expect(client.magicLink.mock.calls[0]?.[0]).toMatchObject({
      email: "owner@example.invalid",
    });
    // The live region is in the document from the first paint, empty: it is the
    // *content* that arrives when the transition commits, so the wait has to be
    // for the text rather than for the element.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "If that address can sign in, a link is on its way.",
      ),
    );
  });

  test("disables the submit control while the request is in flight", async () => {
    const user = userEvent.setup();
    let release = () => {};
    client.magicLink.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    renderForm();

    await user.type(
      screen.getByLabelText("Work email"),
      "owner@example.invalid",
    );
    await user.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled(),
    );

    release();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Email me a sign-in link" }),
      ).toBeEnabled(),
    );
  });

  test("still announces the neutral result when the provider rejects", async () => {
    const user = userEvent.setup();
    client.magicLink.mockRejectedValue(new Error("resend-internal-detail"));
    renderForm();

    await user.type(
      screen.getByLabelText("Work email"),
      "owner@example.invalid",
    );
    await user.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "If that address can sign in, a link is on its way.",
      ),
    );
    expect(document.body.textContent).not.toContain("resend-internal-detail");
  });
});

/**
 * Both ways in have to carry it.
 *
 * The provider resumes an authorization by sending the browser back to
 * `/authorize` once a session exists, and the only thing that decides where a
 * successful sign-in goes is the callback address these two calls name. A form
 * that took the address and then used `/` anyway would leave the request
 * discarded exactly as before, with every test still green.
 */
describe("an authorization the sign-in was asked to resume", () => {
  const resumeTo = "/api/auth/oauth2/authorize?client_id=agent&sig=a-signature";

  test("is where GitHub returns to", async () => {
    const user = userEvent.setup();
    renderForm(resumeTo);

    await user.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );

    await waitFor(() => expect(client.social).toHaveBeenCalledTimes(1));
    expect(client.social.mock.calls[0]?.[0]).toMatchObject({
      callbackURL: resumeTo,
      newUserCallbackURL: resumeTo,
    });
  });

  test("is where the magic link returns to", async () => {
    const user = userEvent.setup();
    renderForm(resumeTo);

    await user.type(screen.getByLabelText("Work email"), "person@example.com");
    await user.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    await waitFor(() => expect(client.magicLink).toHaveBeenCalledTimes(1));
    expect(client.magicLink.mock.calls[0]?.[0]).toMatchObject({
      callbackURL: resumeTo,
      newUserCallbackURL: resumeTo,
    });
  });

  test("leaves an ordinary sign-in landing on the application", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );

    await waitFor(() => expect(client.social).toHaveBeenCalledTimes(1));
    expect(client.social.mock.calls[0]?.[0]).toMatchObject({
      callbackURL: "/",
      newUserCallbackURL: "/",
    });
  });
});

describe("the local credential", () => {
  const resumeTo = "/api/auth/oauth2/authorize?client_id=agent&sig=a-signature";

  function renderCredentialForm(resume?: string) {
    return render(
      <ThemeProvider persistPreferences={false} theme="requestport">
        <SignInForm
          methods={{ github: false, magicLink: false, localCredential: true }}
          resumeTo={resume}
        />
      </ThemeProvider>,
    );
  }

  test("signs in with email and credential, returning to what it was asked to resume", async () => {
    const user = userEvent.setup();
    renderCredentialForm(resumeTo);

    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Credential"), "the-credential");
    await user.click(
      screen.getByRole("button", { name: "Sign in with credential" }),
    );

    await waitFor(() => expect(client.email).toHaveBeenCalledTimes(1));
    expect(client.email.mock.calls[0]?.[0]).toEqual({
      email: "owner@example.com",
      password: "the-credential",
      callbackURL: resumeTo,
    });
    expect(
      screen.queryByRole("button", { name: "Continue with GitHub" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Work email")).toBeNull();
  });

  test("names every way the credential is issued (Plan 13, H.4; ruling 163, item 4)", () => {
    renderCredentialForm();

    expect(
      screen.getByText(
        "Printed once by requestport start, or issued by an operator or by requestport owner rotate-credential.",
      ),
    ).toBeVisible();
  });

  test("says only that the pair did not match when it is refused", async () => {
    const user = userEvent.setup();
    client.email.mockResolvedValue({
      data: null,
      error: { status: 401, message: "Invalid email or password" },
    });
    renderCredentialForm();

    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Credential"), "wrong");
    await user.click(
      screen.getByRole("button", { name: "Sign in with credential" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That email and credential do not match.",
      ),
    );
  });

  test("puts the refusal on the credential's own field (ruling 259)", async () => {
    const user = userEvent.setup();
    client.email.mockResolvedValue({
      data: null,
      error: { status: 401, message: "Invalid email or password" },
    });
    renderCredentialForm();

    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Credential"), "wrong");
    await user.click(
      screen.getByRole("button", { name: "Sign in with credential" }),
    );

    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveAttribute("data-slot", "field-error");
    const field = refusal.closest('[data-slot="field"]');
    expect(field).not.toBeNull();
    expect(
      within(field as HTMLElement).getByLabelText("Credential"),
    ).toHaveAttribute("aria-invalid", "true");
  });

  test("takes the credential in a password field that can be revealed, at the large size", async () => {
    const user = userEvent.setup();
    renderCredentialForm();

    const credential = screen.getByLabelText("Credential");
    expect(credential).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show credential" }));
    expect(credential).toHaveAttribute("type", "text");
    // The large rung of cue-ui's control ladder: on the Email input itself,
    // and on the group that draws the PasswordInput's rim around its input
    // and its reveal control.
    expect(screen.getByLabelText("Email")).toHaveClass("h-control-lg");
    expect(credential.closest('[data-slot="input-group"]')).toHaveClass(
      "h-control-lg",
    );
    expect(
      screen.getByRole("button", { name: "Sign in with credential" }),
    ).toHaveClass("h-control-lg");
  });

  test("is the card's one primary button when it is the only way in", () => {
    renderCredentialForm();

    // `bg-accent-fill` is the class cue-ui's primary Button variant paints.
    expect(
      screen.getByRole("button", { name: "Sign in with credential" }),
    ).toHaveClass("bg-accent-fill");
  });
});

describe("the card's one primary button", () => {
  test("is the first way in offered, and every way in is at the large size", () => {
    render(
      <ThemeProvider persistPreferences={false} theme="requestport">
        <SignInForm
          methods={{ github: true, magicLink: true, localCredential: true }}
        />
      </ThemeProvider>,
    );

    const ways = [
      "Continue with GitHub",
      "Email me a sign-in link",
      "Sign in with credential",
    ].map((name) => screen.getByRole("button", { name }));
    // `bg-accent-fill` is the class cue-ui's primary Button variant paints.
    expect(
      ways.map((button) => button.classList.contains("bg-accent-fill")),
    ).toEqual([true, false, false]);
    for (const button of ways) expect(button).toHaveClass("h-control-lg");
    expect(screen.getByLabelText("Work email")).toHaveClass("h-control-lg");
  });

  test("moves to the emailed link when GitHub is not offered", () => {
    render(
      <ThemeProvider persistPreferences={false} theme="requestport">
        <SignInForm
          methods={{ github: false, magicLink: true, localCredential: true }}
        />
      </ThemeProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    ).toHaveClass("bg-accent-fill");
    expect(
      screen.getByRole("button", { name: "Sign in with credential" }),
    ).not.toHaveClass("bg-accent-fill");
  });
});

describe("a lost credential", () => {
  test("names the exact command the CLI provides, behind Lost your credential?", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider persistPreferences={false} theme="requestport">
        <LostCredentialHelp />
      </ThemeProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Lost your credential?" }),
    );
    expect(
      await screen.findByText("requestport owner rotate-credential"),
    ).toBeVisible();
    // What it is for, and what it costs, as the command's own usage says
    // (OWNER_USAGE): the owner's operator credentials go with the old one.
    expect(screen.getByText(/with requestport start/u)).toBeVisible();
    expect(
      screen.getByText(/every operator key the owner issued is revoked/u),
    ).toBeVisible();
  });
});
