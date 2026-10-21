import { DEFAULT_STORAGE_KEY, ThemeProvider } from "@cueplusplus/ui/system";
import {
  type AppearanceDefaults,
  type AppearanceOverrides,
  type AppearanceSnapshot,
  appearanceAxes,
  appearanceFallback,
} from "@requestport/domain/browser";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  type AppearanceActionState,
  type AppearanceFormAction,
  appearanceActionMessages,
  appearanceInheritValue,
} from "../app/(app)/settings/appearance/action-state.js";
import {
  OrganizationAppearanceForm,
  PersonalAppearanceForm,
} from "./appearance-controls.js";

vi.mock("next/navigation", () => ({
  usePathname: () => "/requests",
  useSearchParams: () => new URLSearchParams("view=inbox"),
}));

const organizationName = "CUE++";
const contextToken = "v1.render.context";
const idempotencyNonce = "6f1c2f1e-0000-4000-8000-000000000001";

const themeOptionLabels = [
  "RequestPort",
  "CUE++",
  "Terminal",
  "Signal",
  "Venu",
  "HiveHub",
  "Dusk",
  "Luma",
  "Snuffle",
];
const densityOptionLabels = ["Ultra compact", "Normal", "Large"];
const modeOptionLabels = ["Match system", "Dark", "Light"];
const inheritLabel = "Organization default";

const organizationDefaults: AppearanceDefaults & { version: number } = {
  density: "normal",
  mode: "dark",
  theme: "cue",
  version: 4,
};

function buildSnapshot(
  input: {
    organization?: (AppearanceDefaults & { version: number }) | null;
    user?: AppearanceOverrides & { version: number };
  } = {},
): AppearanceSnapshot {
  const organization = input.organization ?? organizationDefaults;
  const user = input.user ?? {
    density: null,
    mode: null,
    theme: null,
    version: 0,
  };
  const present = organization.version > 0;
  const defaults: AppearanceDefaults = present
    ? {
        density: organization.density,
        mode: organization.mode,
        theme: organization.theme,
      }
    : appearanceFallback;
  const effective = { ...defaults } as AppearanceSnapshot["effective"];
  const source = {} as AppearanceSnapshot["effective"]["source"];

  for (const axis of appearanceAxes) {
    const override = user[axis];
    if (override !== null) {
      Object.assign(effective, { [axis]: override });
      source[axis] = "user";
      continue;
    }
    source[axis] = present ? "organization" : "fallback";
  }

  return {
    effective: { ...effective, source },
    organization: { ...defaults, version: organization.version },
    user,
  };
}

type Recorded = Record<string, string>;

/**
 * React 19 entangles every async transition on one lane, so an action left
 * unsettled would stall the *next* test's state updates too. `"hold"` therefore
 * parks the action on a promise the test releases before it ends.
 */
function recordingAction(
  result: AppearanceActionState | "hold" = { status: "idle" },
) {
  const submissions: Recorded[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action: AppearanceFormAction = async (_state, data) => {
    submissions.push(
      Object.fromEntries(
        [...data.entries()].map(([key, value]) => [key, String(value)]),
      ),
    );
    if (result === "hold") {
      await held;
      return { status: "idle" };
    }
    return result;
  };
  return { action, release: () => release(), submissions };
}

function personal(
  overrides: Partial<Parameters<typeof PersonalAppearanceForm>[0]> = {},
): ReactElement {
  const snapshot = overrides.snapshot ?? buildSnapshot();
  return (
    <ThemeProvider
      density={snapshot.effective.density}
      mode={snapshot.effective.mode}
      persistPreferences={false}
      theme={snapshot.effective.theme}
    >
      <PersonalAppearanceForm
        contextToken={contextToken}
        idempotencyNonce={idempotencyNonce}
        organizationName={organizationName}
        {...overrides}
        snapshot={snapshot}
      />
    </ThemeProvider>
  );
}

async function openOptions(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("combobox", { name }));
  return await screen.findByRole("listbox");
}

/**
 * Choose a value, which is also what makes a form submittable.
 *
 * `Apply` appears only once the draft differs from what is stored, so a test
 * that wants to submit has to change something first — as a person does. Before
 * that rule existed these tests submitted pristine forms, which wrote a command
 * that changed nothing.
 */
async function chooseTheme(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const listbox = await openOptions(user, "Theme");
  await user.click(within(listbox).getByRole("option", { name }));
}

function optionLabels(listbox: HTMLElement) {
  return within(listbox)
    .getAllByRole("option")
    .map((option) => option.textContent?.trim() ?? "");
}

const realLocation = Object.getOwnPropertyDescriptor(window, "location");
let assigned: string[] = [];

beforeEach(() => {
  assigned = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      assign: (destination: string) => assigned.push(destination),
      href: "http://localhost/requests?view=inbox",
      pathname: "/requests",
      search: "?view=inbox",
    },
  });
});

afterEach(() => {
  if (realLocation) Object.defineProperty(window, "location", realLocation);
});

describe("personal appearance form controls", () => {
  test("gives every axis one labelled field", () => {
    render(personal());

    expect(screen.getByRole("combobox", { name: "Theme" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Density" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Mode" })).toBeInTheDocument();
  });

  test("offers the organization default plus every registered value", async () => {
    const user = userEvent.setup();
    render(personal());

    expect(optionLabels(await openOptions(user, "Theme"))).toEqual([
      inheritLabel,
      ...themeOptionLabels,
    ]);
    await user.keyboard("{Escape}");

    expect(optionLabels(await openOptions(user, "Density"))).toEqual([
      inheritLabel,
      ...densityOptionLabels,
    ]);
    await user.keyboard("{Escape}");

    expect(optionLabels(await openOptions(user, "Mode"))).toEqual([
      inheritLabel,
      ...modeOptionLabels,
    ]);
  });

  test("opens its options into a stamped CUE++ portal", async () => {
    const user = userEvent.setup();
    const snapshot = buildSnapshot();
    render(personal({ snapshot }));

    const listbox = await openOptions(user, "Theme");
    const portal = listbox.closest("[data-cue-portal]");

    expect(portal).not.toBeNull();
    expect(portal?.parentElement).toBe(document.body);
    expect(portal?.getAttribute("data-theme")).toBe(snapshot.effective.theme);
    expect(portal?.getAttribute("data-density")).toBe(
      snapshot.effective.density,
    );
    expect(portal?.getAttribute("data-mode")).toBe(snapshot.effective.mode);
  });

  test("names the source of every inherited and overridden axis", () => {
    render(
      personal({
        snapshot: buildSnapshot({
          user: { density: null, mode: null, theme: "terminal", version: 2 },
        }),
      }),
    );

    expect(
      screen.getByRole("combobox", { name: "Theme" }),
    ).toHaveAccessibleDescription(
      expect.stringContaining("Set for your account"),
    );
    expect(
      screen.getByRole("combobox", { name: "Density" }),
    ).toHaveAccessibleDescription(
      expect.stringContaining(`Inherited from ${organizationName}`),
    );
  });

  test("names the RequestPort fallback when no organization default applies", () => {
    render(
      personal({
        organizationName: null,
        snapshot: buildSnapshot({
          organization: { ...appearanceFallback, version: 0 },
        }),
      }),
    );

    expect(
      screen.getByRole("combobox", { name: "Mode" }),
    ).toHaveAccessibleDescription(
      expect.stringContaining("Inherited from the RequestPort default"),
    );
  });
});

describe("personal appearance draft preview", () => {
  test("previews a change through the provider without writing anything", async () => {
    const user = userEvent.setup();
    const { action, submissions } = recordingAction();
    render(personal({ action }));

    const listbox = await openOptions(user, "Theme");
    await user.click(within(listbox).getByRole("option", { name: "Terminal" }));

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe(
        "terminal",
      );
    });
    expect(
      document.querySelector("[data-cue-root]")?.getAttribute("data-theme"),
    ).toBe("terminal");
    expect(submissions).toEqual([]);
    expect(window.localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });

  test("previews the inherited value when an axis returns to inherit", async () => {
    const user = userEvent.setup();
    render(
      personal({
        snapshot: buildSnapshot({
          user: { density: null, mode: null, theme: "terminal", version: 2 },
        }),
      }),
    );

    const listbox = await openOptions(user, "Theme");
    await user.click(
      within(listbox).getByRole("option", { name: inheritLabel }),
    );

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe(
        organizationDefaults.theme,
      );
    });
  });

  test("restores the confirmed triple when the draft is cancelled", async () => {
    const user = userEvent.setup();
    render(personal());

    const listbox = await openOptions(user, "Theme");
    await user.click(within(listbox).getByRole("option", { name: "Luma" }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("luma");
    });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe(
        organizationDefaults.theme,
      );
    });
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent(
      inheritLabel,
    );
  });

  test("resets every axis to inherit and still waits for apply", async () => {
    const user = userEvent.setup();
    const { action, submissions } = recordingAction();
    render(
      personal({
        action,
        snapshot: buildSnapshot({
          user: {
            density: "large",
            mode: "light",
            theme: "terminal",
            version: 7,
          },
        }),
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Reset to organization defaults" }),
    );

    for (const axis of ["Theme", "Density", "Mode"]) {
      expect(screen.getByRole("combobox", { name: axis })).toHaveTextContent(
        inheritLabel,
      );
    }
    expect(submissions).toEqual([]);

    // Reset has already made this dirty — every axis moved from an override to
    // inherit — so Apply is offered without choosing anything further.
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(submissions).toHaveLength(1);
    });
    expect(submissions[0]).toMatchObject({
      density: appearanceInheritValue,
      expectedVersion: "7",
      mode: appearanceInheritValue,
      theme: appearanceInheritValue,
    });
  });
});

/**
 * What a preview owes the person looking at it.
 *
 * Choosing a value repaints the whole interface. That is the right preview — it
 * shows the real thing rather than a swatch — but nothing said it was one, so a
 * person could not tell whether what they were looking at had been saved. And
 * *Apply* was live before anything had changed, which made the one control that
 * could have told them look identical either way.
 *
 * Reported by the product owner: "this does not clearly state this is preview
 * only and that i need to apply to save — also button seems always active, so
 * having it not displayed until a change has been made would also make it
 * obvious."
 */
describe("personal appearance preview state", () => {
  test("offers nothing to apply until something has changed", () => {
    render(personal());

    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
  });

  test("offers Apply once an axis differs, and says the change is not saved", async () => {
    const user = userEvent.setup();
    render(personal());

    const listbox = await openOptions(user, "Theme");
    await user.click(within(listbox).getByRole("option", { name: "Terminal" }));

    expect(
      await screen.findByRole("button", { name: "Apply" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Previewing. Apply to save.",
    );
  });

  test("takes both away again when the axis returns to its saved value", async () => {
    const user = userEvent.setup();
    render(
      personal({
        snapshot: buildSnapshot({
          user: { density: null, mode: null, theme: "terminal", version: 2 },
        }),
      }),
    );

    const changed = await openOptions(user, "Theme");
    await user.click(within(changed).getByRole("option", { name: "Signal" }));
    expect(
      await screen.findByRole("button", { name: "Apply" }),
    ).toBeInTheDocument();

    const restored = await openOptions(user, "Theme");
    await user.click(
      within(restored).getByRole("option", { name: "Terminal" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Apply" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Reset writes the draft to inherit on every axis. From a pristine inheriting
  // form that changes nothing, and offering Apply there would be the same lie
  // in the other direction.
  test("stays quiet when reset changes nothing", async () => {
    const user = userEvent.setup();
    render(personal());

    await user.click(
      screen.getByRole("button", { name: "Reset to organization defaults" }),
    );

    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
  });
});

/**
 * An owner's own choice, offered to the organization from where it was made.
 *
 * The panel names the organization default and, until now, gave an owner no way
 * to set it — they had to leave, find the second form, and re-enter what they
 * had already chosen.
 *
 * Three things this must not become. It must not be a side effect of *Apply*:
 * an owner adjusting their own theme cannot change everyone's by accident. It
 * must not write the personal command. And an axis the owner left inheriting is
 * not a statement about what the organization should inherit, so it carries the
 * organization's current value rather than anything of theirs.
 */
describe("promoting a personal choice to the organization default", () => {
  const promotable = {
    contextToken: "v1.organization.context",
    idempotencyNonce: "6f1c2f1e-0000-4000-8000-000000000002",
  };

  test("is not offered without the authority to do it", async () => {
    const user = userEvent.setup();
    render(personal());

    await chooseTheme(user, "Terminal");

    expect(
      screen.queryByRole("button", {
        name: "Make this the organization default",
      }),
    ).toBeNull();
  });

  test("is not offered while the choice would change nothing", async () => {
    const { action } = recordingAction();
    render(
      personal({
        organizationDefault: { ...promotable, action },
      }),
    );

    expect(
      screen.queryByRole("button", {
        name: "Make this the organization default",
      }),
    ).toBeNull();
  });

  test("asks before it changes what everyone sees", async () => {
    const user = userEvent.setup();
    const { action, submissions } = recordingAction();
    render(personal({ organizationDefault: { ...promotable, action } }));

    await chooseTheme(user, "Terminal");
    await user.click(
      await screen.findByRole("button", {
        name: "Make this the organization default",
      }),
    );

    expect(submissions).toEqual([]);
    expect(
      screen.getByRole("button", { name: /^Confirm/u }),
    ).toBeInTheDocument();
  });

  test("writes the organization command, keeping inherited axes as they are", async () => {
    const user = userEvent.setup();
    const personalRecorder = recordingAction();
    const organizationRecorder = recordingAction();
    render(
      personal({
        action: personalRecorder.action,
        organizationDefault: {
          ...promotable,
          action: organizationRecorder.action,
        },
      }),
    );

    await chooseTheme(user, "Terminal");
    await user.click(
      await screen.findByRole("button", {
        name: "Make this the organization default",
      }),
    );
    await user.click(screen.getByRole("button", { name: /^Confirm/u }));

    await waitFor(() =>
      expect(organizationRecorder.submissions).toHaveLength(1),
    );
    const [submitted] = organizationRecorder.submissions;

    expect(submitted?.theme).toBe("terminal");
    // Density and mode were left inheriting, so the organization keeps what it
    // already had rather than receiving a value nobody chose for it.
    expect(submitted?.density).toBe(organizationDefaults.density);
    expect(submitted?.mode).toBe(organizationDefaults.mode);
    expect(submitted?.expectedVersion).toBe(
      String(organizationDefaults.version),
    );
    expect(submitted?.renderContext).toBe(promotable.contextToken);

    // The person's own preferences are untouched by this.
    expect(personalRecorder.submissions).toEqual([]);
  });
});

describe("personal appearance submission", () => {
  test("submits the draft with its version, key, context, and destination", async () => {
    const user = userEvent.setup();
    const { action, submissions } = recordingAction();
    render(personal({ action }));

    const listbox = await openOptions(user, "Theme");
    await user.click(within(listbox).getByRole("option", { name: "Signal" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(submissions).toHaveLength(1);
    });
    expect(submissions[0]).toEqual({
      density: appearanceInheritValue,
      expectedVersion: "0",
      idempotencyKey: `${idempotencyNonce}:signal:${appearanceInheritValue}:${appearanceInheritValue}`,
      mode: appearanceInheritValue,
      renderContext: contextToken,
      returnTo: "/requests?view=inbox",
      theme: "signal",
    });
  });

  test("disables the controls while the write is in flight", async () => {
    const user = userEvent.setup();
    const { action, release } = recordingAction("hold");
    render(personal({ action }));

    await chooseTheme(user, "Terminal");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    });
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeDisabled();

    release();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    });
  });

  test("shows a field failure on the owning field", async () => {
    const user = userEvent.setup();
    const { action } = recordingAction({
      field: "density",
      message: appearanceActionMessages.field,
      status: "field_error",
    });
    render(personal({ action }));

    await chooseTheme(user, "Terminal");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Density" }),
      ).toHaveAccessibleDescription(
        expect.stringContaining(appearanceActionMessages.field),
      );
    });
    expect(
      screen.getByRole("combobox", { name: "Theme" }),
    ).not.toHaveAccessibleDescription(
      expect.stringContaining(appearanceActionMessages.field),
    );
  });

  test.each([
    [
      {
        code: "unexpected_error",
        message: appearanceActionMessages.unexpected_error,
        status: "global_error",
      },
      appearanceActionMessages.unexpected_error,
    ],
    [
      {
        message: appearanceActionMessages.version_conflict,
        status: "version_conflict",
      },
      appearanceActionMessages.version_conflict,
    ],
    [
      {
        message: appearanceActionMessages.context_conflict,
        status: "context_conflict",
      },
      appearanceActionMessages.context_conflict,
    ],
  ] as const)("announces %j as a fixed banner", async (state, message) => {
    const user = userEvent.setup();
    const { action } = recordingAction(state as AppearanceActionState);
    render(personal({ action }));

    await chooseTheme(user, "Terminal");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(message);
    });
  });

  test("performs a full-document navigation on success", async () => {
    const user = userEvent.setup();
    const { action } = recordingAction({
      destination: "/requests?view=inbox",
      status: "success",
    });
    render(personal({ action }));

    await chooseTheme(user, "Terminal");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(assigned).toEqual(["/requests?view=inbox"]);
    });
  });
});

describe("organization appearance defaults", () => {
  function organization(
    overrides: Partial<Parameters<typeof OrganizationAppearanceForm>[0]> = {},
  ) {
    return (
      <ThemeProvider
        density={organizationDefaults.density}
        mode={organizationDefaults.mode}
        persistPreferences={false}
        theme={organizationDefaults.theme}
      >
        <OrganizationAppearanceForm
          canEdit
          contextToken={contextToken}
          defaults={{
            density: organizationDefaults.density,
            mode: organizationDefaults.mode,
            theme: organizationDefaults.theme,
          }}
          idempotencyNonce={idempotencyNonce}
          organizationName={organizationName}
          version={organizationDefaults.version}
          {...overrides}
        />
      </ThemeProvider>
    );
  }

  test("never offers inherit to an owner", async () => {
    const user = userEvent.setup();
    render(organization());

    expect(optionLabels(await openOptions(user, "Theme"))).toEqual(
      themeOptionLabels,
    );
  });

  test("submits the tenant triple with its expected version", async () => {
    const user = userEvent.setup();
    const { action, submissions } = recordingAction();
    render(organization({ action }));

    const listbox = await openOptions(user, "Density");
    await user.click(within(listbox).getByRole("option", { name: "Large" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(submissions).toHaveLength(1);
    });
    expect(submissions[0]).toMatchObject({
      density: "large",
      expectedVersion: String(organizationDefaults.version),
      mode: organizationDefaults.mode,
      renderContext: contextToken,
      theme: organizationDefaults.theme,
    });
  });

  test("shows a member the effective defaults without any control", () => {
    render(organization({ canEdit: false, contextToken: "" }));

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByText("CUE++")).toBeInTheDocument();
    expect(screen.getByText("Normal")).toBeInTheDocument();
    expect(screen.getByText("Dark")).toBeInTheDocument();
  });
});
