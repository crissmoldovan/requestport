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
  "Command",
  "Graphite",
  "Kiln",
  "Ledger",
  "Monolith",
  "Porcelain",
  "Prism",
  "QuotaMate",
  "Tender",
  "Zine",
];
const densityOptionLabels = ["Ultra compact", "Compact", "Normal", "Large"];
const modeOptionLabels = ["Match system", "Dark", "Light"];
const typefaceOptionLabels = [
  "Geist",
  "Geist Mono",
  "Inter",
  "Inter with Source Code Pro",
  "IBM Plex",
  "DM Sans",
  "Cal Sans",
  "Fraunces with JetBrains Mono",
  "System",
];
const lookOptionLabels = [
  "Console",
  "Editorial",
  "Marketing",
  "Graphite",
  "Tender",
  "Zine",
  "Kiln",
  "Porcelain",
  "Ledger",
  "Command",
  "Monolith",
  "Prism",
];
const surfaceOptionLabels = [
  "None",
  "Halo",
  "Hatch",
  "Lift",
  "Frost",
  "Bevel",
  "Grain",
  "Plume",
  "Matte",
  "Glaze",
];
/** Every row's first option names the organization's value on that axis. */
const inheritLabel = /^Organization default: /u;

const organizationDefaults: AppearanceDefaults & { version: number } = {
  density: "normal",
  font: "match",
  look: "match",
  mode: "dark",
  paint: "match",
  theme: "cue",
  version: 4,
};

/** No personal choice on any axis. */
const inheriting = {
  density: null,
  font: null,
  look: null,
  mode: null,
  paint: null,
  theme: null,
} as const;

function buildSnapshot(
  input: {
    organization?: (AppearanceDefaults & { version: number }) | null;
    user?: AppearanceOverrides & { version: number };
  } = {},
): AppearanceSnapshot {
  const organization = input.organization ?? organizationDefaults;
  const user = input.user ?? { ...inheriting, version: 0 };
  const present = organization.version > 0;
  const defaults: AppearanceDefaults = present
    ? {
        density: organization.density,
        font: organization.font,
        look: organization.look,
        mode: organization.mode,
        paint: organization.paint,
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
  test("gives every one of the six axes one labelled row, under Just for you (ruling 255)", () => {
    render(personal());

    const section = screen.getByRole("group", { name: "Just for you" });
    for (const name of [
      "Theme",
      "Mode",
      "Density",
      "Typeface",
      "Look",
      "Surface",
    ]) {
      expect(
        within(section).getByRole("combobox", { name }),
        name,
      ).toBeInTheDocument();
    }
  });

  test("offers the organization's value first, then every registered value", async () => {
    const user = userEvent.setup();
    render(personal());

    expect(optionLabels(await openOptions(user, "Theme"))).toEqual([
      "Organization default: CUE++",
      ...themeOptionLabels,
    ]);
    await user.keyboard("{Escape}");

    expect(optionLabels(await openOptions(user, "Density"))).toEqual([
      "Organization default: Normal",
      ...densityOptionLabels,
    ]);
    await user.keyboard("{Escape}");

    expect(optionLabels(await openOptions(user, "Mode"))).toEqual([
      "Organization default: Dark",
      ...modeOptionLabels,
    ]);
  });

  test("offers match first on typeface, Look and surface, named by what the theme's Look resolves it to", async () => {
    const user = userEvent.setup();
    render(personal());

    // The organization is on cue, whose Look is classic: Geist, Console, None.
    expect(optionLabels(await openOptions(user, "Typeface"))).toEqual([
      "Organization default: Match the theme (Geist)",
      "Match the theme (Geist)",
      ...typefaceOptionLabels,
    ]);
    await user.keyboard("{Escape}");
    expect(optionLabels(await openOptions(user, "Look"))).toEqual([
      "Organization default: Match the theme (Console)",
      "Match the theme (Console)",
      ...lookOptionLabels,
    ]);
    await user.keyboard("{Escape}");
    expect(optionLabels(await openOptions(user, "Surface"))).toEqual([
      "Organization default: Match the theme (None)",
      "Match the theme (None)",
      ...surfaceOptionLabels,
    ]);
    await user.keyboard("{Escape}");

    // Choosing graphite moves what this person's own match resolves to.
    await chooseTheme(user, "Graphite");
    expect(optionLabels(await openOptions(user, "Typeface"))).toContain(
      "Match the theme (Geist Mono)",
    );
  });

  test("names the organization's match by what it gives this person, under the theme they see", async () => {
    const user = userEvent.setup();
    // The organization is cue with match on every axis; this person chose
    // graphite and nothing else, so the page renders graphite's Look for them:
    // Geist Mono, Graphite, Bevel. The inherited row must name that, not cue's.
    render(
      personal({
        snapshot: buildSnapshot({
          user: { ...inheriting, theme: "graphite", version: 2 },
        }),
      }),
    );

    expect(optionLabels(await openOptions(user, "Typeface"))[0]).toBe(
      "Organization default: Match the theme (Geist Mono)",
    );
    await user.keyboard("{Escape}");
    expect(optionLabels(await openOptions(user, "Look"))[0]).toBe(
      "Organization default: Match the theme (Graphite)",
    );
    await user.keyboard("{Escape}");
    expect(optionLabels(await openOptions(user, "Surface"))[0]).toBe(
      "Organization default: Match the theme (Bevel)",
    );
    await user.keyboard("{Escape}");

    // Back on the organization's theme in the draft, the row follows it.
    await chooseTheme(user, "Organization default: CUE++");
    expect(optionLabels(await openOptions(user, "Typeface"))[0]).toBe(
      "Organization default: Match the theme (Geist)",
    );
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
          user: { ...inheriting, theme: "terminal", version: 2 },
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

  test("previews a typeface, a Look and a surface on the document, a match as it resolves", async () => {
    const user = userEvent.setup();
    const { submissions, action } = recordingAction();
    render(personal({ action }));

    await user.click(
      within(await openOptions(user, "Typeface")).getByRole("option", {
        name: "IBM Plex",
      }),
    );
    await user.click(
      within(await openOptions(user, "Surface")).getByRole("option", {
        name: "Frost",
      }),
    );
    await chooseTheme(user, "Graphite");

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-font")).toBe("plex");
    });
    const root = document.querySelector("[data-cue-root]");
    expect(root?.getAttribute("data-paint")).toBe("frost");
    // The Look is still the organization's match, which graphite resolves to
    // its own set.
    expect(root?.getAttribute("data-style")).toBe("graphite");
    expect(submissions).toEqual([]);
  });

  test("previews the inherited value when an axis returns to inherit", async () => {
    const user = userEvent.setup();
    render(
      personal({
        snapshot: buildSnapshot({
          user: { ...inheriting, theme: "terminal", version: 2 },
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
            font: "dm",
            look: "editorial",
            mode: "light",
            paint: "grain",
            theme: "terminal",
            version: 7,
          },
        }),
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Use organization defaults" }),
    );

    for (const axis of [
      "Theme",
      "Density",
      "Mode",
      "Typeface",
      "Look",
      "Surface",
    ]) {
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
      font: appearanceInheritValue,
      look: appearanceInheritValue,
      mode: appearanceInheritValue,
      paint: appearanceInheritValue,
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
          user: { ...inheriting, theme: "terminal", version: 2 },
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

  // Using the organization's defaults writes the draft to inherit on every
  // axis. From a pristine inheriting form that changes nothing, so the control
  // is not offered there, and neither is Apply.
  test("offers no reset while nothing is your own", () => {
    render(personal());

    expect(
      screen.getByRole("button", { name: "Use organization defaults" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("You follow the organization default on every setting."),
    ).toBeInTheDocument();
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
      font: appearanceInheritValue,
      idempotencyKey: [
        idempotencyNonce,
        "signal",
        ...Array(5).fill(appearanceInheritValue),
      ].join(":"),
      look: appearanceInheritValue,
      mode: appearanceInheritValue,
      paint: appearanceInheritValue,
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
          contextToken={contextToken}
          defaults={{
            density: organizationDefaults.density,
            font: organizationDefaults.font,
            look: organizationDefaults.look,
            mode: organizationDefaults.mode,
            paint: organizationDefaults.paint,
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

  test("never offers inherit to an owner, and offers match first where a Look decides", async () => {
    const user = userEvent.setup();
    render(organization());

    expect(
      screen.getByRole("group", {
        name: `Organization default · everyone in ${organizationName}`,
      }),
    ).toBeInTheDocument();
    expect(optionLabels(await openOptions(user, "Theme"))).toEqual(
      themeOptionLabels,
    );
    await user.keyboard("{Escape}");
    expect(optionLabels(await openOptions(user, "Typeface"))).toEqual([
      "Match the theme (Geist)",
      ...typefaceOptionLabels,
    ]);
  });

  test("submits all six axes with the expected version (ruling 255)", async () => {
    const user = userEvent.setup();
    const { action, submissions } = recordingAction();
    render(organization({ action }));

    await chooseTheme(user, "Zine");
    await user.click(
      within(await openOptions(user, "Look")).getByRole("option", {
        name: "Editorial",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(submissions).toHaveLength(1);
    });
    expect(submissions[0]).toMatchObject({
      density: organizationDefaults.density,
      expectedVersion: String(organizationDefaults.version),
      font: "match",
      look: "editorial",
      mode: organizationDefaults.mode,
      paint: "match",
      theme: "zine",
    });
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
});
