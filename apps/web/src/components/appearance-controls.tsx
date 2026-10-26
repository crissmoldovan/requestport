"use client";

import { Inspector, Row } from "@cueplusplus/ui/chrome";
import {
  Field,
  FieldDescription,
  FieldError,
  Select,
} from "@cueplusplus/ui/forms";
import { Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { useTheme } from "@cueplusplus/ui/system";
import {
  type AppearanceAxis,
  type AppearanceDefaults,
  type AppearanceOverrides,
  type AppearanceSnapshot,
  type AppearanceTheme,
  appearanceAxes,
  appearanceAxisGuards,
  appearanceAxisValues,
  appearanceMatchValue,
  appearanceThemeLook,
} from "@requestport/domain/browser";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  type AppearanceActionState,
  type AppearanceFieldName,
  type AppearanceFormAction,
  appearanceActionMessages,
  appearanceInheritValue,
  initialAppearanceActionState,
} from "../app/(app)/settings/appearance/action-state.js";
import {
  type AppearancePresentation,
  appearancePresentation,
} from "../lib/appearance-presentation.js";

/**
 * The appearance menu and editor: six axes (ruling 255) — theme, mode,
 * density, typeface, Look and surface — each a row of an `Inspector`.
 *
 * Both forms keep the last confirmed values until the server accepts the write:
 * editing a control only moves an in-memory draft, which is previewed through
 * the existing CUE++ provider. Nothing here reads or writes browser storage —
 * the root provider runs with `persistPreferences={false}` — and nothing here
 * writes to the database except by submitting the form.
 */

/** The order the rows are listed in. */
const displayedAxes = [
  "theme",
  "mode",
  "density",
  "font",
  "look",
  "paint",
] as const satisfies readonly AppearanceAxis[];

const axisLabels: Record<AppearanceAxis, string> = {
  theme: "Theme",
  mode: "Mode",
  density: "Density",
  font: "Typeface",
  look: "Look",
  paint: "Surface",
};

/** What each organization row says it changes. */
const axisHelp: Record<AppearanceAxis, string> = {
  theme: "Colours. Every theme CUE++ ships, and RequestPort's own.",
  mode: "Light, dark, or whatever the device uses.",
  density: "How much fits on screen. Normal suits most people.",
  font: "The interface face. IDs, keys and code stay monospaced.",
  look: "Type voice and structure: labels, chips, headings.",
  paint: "The finish on panels and controls.",
};

const valueLabels: {
  [K in AppearanceAxis]: Record<AppearanceDefaults[K], string>;
} = {
  theme: {
    requestport: "RequestPort",
    cue: "CUE++",
    terminal: "Terminal",
    signal: "Signal",
    venu: "Venu",
    hivehub: "HiveHub",
    dusk: "Dusk",
    luma: "Luma",
    snuffle: "Snuffle",
    command: "Command",
    graphite: "Graphite",
    kiln: "Kiln",
    ledger: "Ledger",
    monolith: "Monolith",
    porcelain: "Porcelain",
    prism: "Prism",
    quotamate: "QuotaMate",
    tender: "Tender",
    zine: "Zine",
  },
  density: {
    "ultra-compact": "Ultra compact",
    compact: "Compact",
    normal: "Normal",
    large: "Large",
  },
  mode: { system: "Match system", dark: "Dark", light: "Light" },
  font: {
    match: "Match the theme",
    geist: "Geist",
    "geist-mono": "Geist Mono",
    inter: "Inter",
    "inter-source": "Inter with Source Code Pro",
    plex: "IBM Plex",
    dm: "DM Sans",
    calsans: "Cal Sans",
    "fraunces-mono": "Fraunces with JetBrains Mono",
    system: "System",
  },
  look: {
    match: "Match the theme",
    console: "Console",
    editorial: "Editorial",
    marketing: "Marketing",
    graphite: "Graphite",
    tender: "Tender",
    zine: "Zine",
    kiln: "Kiln",
    porcelain: "Porcelain",
    ledger: "Ledger",
    command: "Command",
    monolith: "Monolith",
    prism: "Prism",
  },
  paint: {
    match: "Match the theme",
    none: "None",
    halo: "Halo",
    hatch: "Hatch",
    lift: "Lift",
    frost: "Frost",
    bevel: "Bevel",
    grain: "Grain",
    plume: "Plume",
    matte: "Matte",
    glaze: "Glaze",
  },
};

/**
 * One value's label on one axis. The vocabularies overlap — `graphite` is a
 * theme and a Look, `system` a mode and a typeface — so a label is always
 * looked up by its axis. A `match` names what it resolves to under `theme`.
 */
function valueLabel(
  axis: AppearanceAxis,
  value: string,
  theme: AppearanceTheme,
): string {
  if (
    value === appearanceMatchValue &&
    (axis === "font" || axis === "look" || axis === "paint")
  ) {
    const resolved: string = appearanceThemeLook(theme)[axis];
    const labels = valueLabels[axis] as Record<string, string>;
    return `Match the theme (${labels[resolved] ?? resolved})`;
  }
  const labels = valueLabels[axis] as Record<string, string>;
  return labels[value] ?? value;
}

const noOverrides: AppearanceOverrides = {
  theme: null,
  density: null,
  mode: null,
  font: null,
  look: null,
  paint: null,
};

const overriddenDescription = "Set for your account";
const fallbackSourceDescription = "Inherited from the RequestPort default";

type AxisOption = { label: string; value: string };

/** Every value of one axis, a `match` named by what it resolves to under `theme`. */
function axisOptions(axis: AppearanceAxis, theme: AppearanceTheme) {
  return (appearanceAxisValues[axis] as readonly string[]).map((value) => ({
    label: valueLabel(axis, value, theme),
    value,
  }));
}

/** A draft axis value: a supported literal, or `inherit` on a personal axis. */
type AppearanceDraft = Record<AppearanceFieldName, string>;

function draftOf(values: Record<AppearanceAxis, string | null>) {
  return Object.fromEntries(
    appearanceAxes.map((axis) => [
      axis,
      values[axis] ?? appearanceInheritValue,
    ]),
  ) as AppearanceDraft;
}

/**
 * Whether the draft differs from what is stored.
 *
 * The preview already computes this to decide whether to drive the provider at
 * all; saying it out loud is what was missing. A person who has repainted the
 * whole interface should be told that is all they have done, and the control
 * that saves it should appear exactly when there is something to save.
 */
function isDirty(draft: AppearanceDraft, confirmed: AppearanceDraft): boolean {
  return appearanceAxes.some((axis) => draft[axis] !== confirmed[axis]);
}

/** The draft's value on one axis when it is a value, or `fallback` for `inherit`. */
function axisValue<K extends AppearanceAxis>(
  draft: AppearanceDraft,
  axis: K,
  fallback: AppearanceDefaults[K],
): AppearanceDefaults[K] {
  const value = draft[axis];
  const guard = appearanceAxisGuards[axis] as (
    candidate: unknown,
  ) => candidate is AppearanceDefaults[K];
  return guard(value) ? value : fallback;
}

/** All six axes of the draft, each `inherit` replaced by `fallback`'s value. */
function withFallback(
  draft: AppearanceDraft,
  fallback: AppearanceDefaults,
): AppearanceDefaults {
  return {
    theme: axisValue(draft, "theme", fallback.theme),
    density: axisValue(draft, "density", fallback.density),
    mode: axisValue(draft, "mode", fallback.mode),
    font: axisValue(draft, "font", fallback.font),
    look: axisValue(draft, "look", fallback.look),
    paint: axisValue(draft, "paint", fallback.paint),
  };
}

/** The idempotency key: the rendered nonce and the six drafted values. */
function draftKey(nonce: string, draft: AppearanceDraft) {
  return [nonce, ...appearanceAxes.map((axis) => draft[axis])].join(":");
}

/** Said once, so both editors say it the same way. */
const previewNotice = "Previewing. Apply to save.";

/**
 * What an owner or an admin needs to offer their own choice to the
 * organization.
 *
 * Absent for anyone who may not: the caller supplies this only when
 * `canEditOrganizationAppearance` says so, which is the same authority the
 * settings page uses to decide whether to render the defaults form at all.
 */
export type OrganizationDefaultPromotion = Readonly<{
  action: AppearanceFormAction;
  contextToken: string;
  idempotencyNonce: string;
}>;

/**
 * The promotion an owner or an admin is offered, as its own form.
 *
 * A sibling rather than a second button on the personal form, because it writes
 * a different command with a different authority, a different render context
 * and a different expected version. Sharing a form with *Apply* is precisely
 * how an owner or an admin would change everyone's appearance while meaning to
 * change their own, and the confirmation is the second guard on the same
 * thought.
 *
 * An axis left on *Organization default* is not a statement about what the
 * organization should inherit — there is no value to promote — so it carries
 * what the organization already has. Only the axes the person actually chose
 * travel.
 */
function PromoteToOrganizationDefault({
  organizationName,
  promotion,
  axes,
  version,
}: {
  organizationName: string | null;
  promotion: OrganizationDefaultPromotion;
  axes: AppearanceDefaults;
  version: number;
}) {
  const [state, formAction, pending] = useActionState(
    promotion.action,
    initialAppearanceActionState,
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <form action={formAction}>
      <input name="expectedVersion" type="hidden" value={version} />
      <input
        name="idempotencyKey"
        type="hidden"
        value={draftKey(promotion.idempotencyNonce, axes)}
      />
      <input
        name="renderContext"
        type="hidden"
        value={promotion.contextToken}
      />
      {appearanceAxes.map((axis) => (
        <input key={axis} name={axis} type="hidden" value={axes[axis]} />
      ))}
      <Stack direction="column" gap={2}>
        <AppearanceBanner message={bannerMessage(state)} />
        {confirming ? (
          <Stack direction="row" gap={2} wrap>
            <span>
              {organizationName === null
                ? "Everyone who has not overridden these settings will see this."
                : `Everyone in ${organizationName} who has not overridden these settings will see this.`}
            </span>
            <Button
              disabled={pending}
              size="sm"
              type="submit"
              variant="primary"
            >
              {pending ? "Applying…" : "Confirm: change it for everyone"}
            </Button>
            <Button
              disabled={pending}
              onClick={() => setConfirming(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Keep it to myself
            </Button>
          </Stack>
        ) : (
          <Button
            onClick={() => setConfirming(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Make this the organization default
          </Button>
        )}
      </Stack>
    </form>
  );
}

/**
 * The runtime boundary for a control's own value. TypeScript is not validation:
 * a value that is not on the axis never reaches the provider, the document
 * attributes, or the submitted form.
 */
function accepted(
  next: string | null,
  options: readonly AxisOption[],
  current: string,
) {
  return next !== null && options.some((option) => option.value === next)
    ? next
    : current;
}

async function unavailableAppearanceAction(): Promise<AppearanceActionState> {
  return {
    code: "unexpected_error",
    message: appearanceActionMessages.unexpected_error,
    status: "global_error",
  };
}

function bannerMessage(state: AppearanceActionState) {
  return state.status === "global_error" ||
    state.status === "version_conflict" ||
    state.status === "context_conflict"
    ? state.message
    : null;
}

function fieldIssues(state: AppearanceActionState, field: AppearanceFieldName) {
  return state.status === "field_error" && state.field === field
    ? [{ message: state.message }]
    : undefined;
}

type PresentationSetters = Pick<
  ReturnType<typeof useTheme>,
  "setDensity" | "setFont" | "setMode" | "setPaint" | "setStyleSet" | "setTheme"
>;

function applyPresentation(
  setters: PresentationSetters,
  target: AppearancePresentation,
) {
  setters.setTheme(target.theme);
  setters.setDensity(target.density);
  setters.setMode(target.mode);
  setters.setFont(target.font);
  setters.setStyleSet(target.styleSet);
  setters.setPaint(target.paint);
}

function samePresentation(
  left: AppearancePresentation,
  right: AppearancePresentation,
) {
  return (
    left.theme === right.theme &&
    left.density === right.density &&
    left.mode === right.mode &&
    left.font === right.font &&
    left.styleSet === right.styleSet &&
    left.paint === right.paint
  );
}

/**
 * Applies the draft to the ambient provider while the draft differs from the
 * confirmed values, and puts the confirmed values back the moment it stops —
 * whether that is Cancel, a reset, an Escape, an outside press, or the panel
 * unmounting with the popover that held it. The typeface, style set and paint
 * are applied as they resolve (`appearancePresentation`), so a `match` previews
 * the theme's own Look.
 *
 * Only a dirty editor drives the provider, which is what lets the personal and
 * organization editors sit on the same page without fighting over it.
 */
function AppearanceDraftPreview({
  confirmed,
  preview,
}: {
  confirmed: AppearanceDefaults;
  preview: AppearanceDefaults;
}) {
  const { setDensity, setFont, setMode, setPaint, setStyleSet, setTheme } =
    useTheme();
  const next = appearancePresentation(preview);
  const saved = appearancePresentation(confirmed);
  const dirty = !samePresentation(next, saved);
  const previewing = useRef(false);
  const setters = {
    setDensity,
    setFont,
    setMode,
    setPaint,
    setStyleSet,
    setTheme,
  };
  const restoreRef = useRef({ saved, setters });
  restoreRef.current = { saved, setters };

  useEffect(() => {
    const setters = {
      setDensity,
      setFont,
      setMode,
      setPaint,
      setStyleSet,
      setTheme,
    };
    if (dirty) {
      previewing.current = true;
      applyPresentation(setters, {
        theme: next.theme,
        density: next.density,
        mode: next.mode,
        font: next.font,
        styleSet: next.styleSet,
        paint: next.paint,
      });
      return;
    }
    if (!previewing.current) return;
    previewing.current = false;
    applyPresentation(setters, {
      theme: saved.theme,
      density: saved.density,
      mode: saved.mode,
      font: saved.font,
      styleSet: saved.styleSet,
      paint: saved.paint,
    });
  }, [
    dirty,
    next.theme,
    next.density,
    next.mode,
    next.font,
    next.styleSet,
    next.paint,
    saved.theme,
    saved.density,
    saved.mode,
    saved.font,
    saved.styleSet,
    saved.paint,
    setDensity,
    setFont,
    setMode,
    setPaint,
    setStyleSet,
    setTheme,
  ]);

  useEffect(
    () => () => {
      if (!previewing.current) return;
      previewing.current = false;
      const restore = restoreRef.current;
      applyPresentation(restore.setters, restore.saved);
    },
    [],
  );

  return null;
}

/**
 * One axis's control: a `Select` that takes its name from the `Inspector.Row`
 * around it (the row lays its label on its control as `aria-label`), with the
 * row's description and, after a refused write, its field error.
 */
function AppearanceAxisSelect({
  "aria-label": label,
  description,
  disabled,
  field,
  issues,
  onValueChange,
  options,
  value,
}: {
  "aria-label"?: string;
  description: ReactNode;
  disabled: boolean;
  field: AppearanceFieldName;
  issues?: readonly { message: string }[];
  onValueChange: (next: string | null) => void;
  options: readonly AxisOption[];
  value: string;
}) {
  return (
    <Field name={field}>
      <Select
        aria-label={label ?? axisLabels[field]}
        disabled={disabled}
        items={options}
        name={field}
        onValueChange={onValueChange}
        size="sm"
        value={value}
      />
      <FieldDescription>{description}</FieldDescription>
      {issues ? <FieldError issues={issues} /> : null}
    </Field>
  );
}

/**
 * The fixed failure banner. Text plus a tone token, never colour alone, and
 * never a message derived from a thrown error.
 */
function AppearanceBanner({ message }: { message: string | null }) {
  return message ? (
    <div role="alert">
      <Row>
        <Chip tone="danger">Error</Chip>
        <span>{message}</span>
      </Row>
    </div>
  ) : null;
}

function useReturnDestination() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * The full-document navigation every accepted preference write ends in, so the
 * next paint comes from the server-resolved axes rather than from provider
 * state adopted during a client transition.
 */
function useSuccessNavigation(state: AppearanceActionState) {
  useEffect(() => {
    if (state.status === "success") window.location.assign(state.destination);
  }, [state]);
}

export type PersonalAppearanceFormProps = {
  action?: AppearanceFormAction;
  contextToken: string;
  idempotencyNonce: string;
  onDismiss?: () => void;
  organizationDefault?: OrganizationDefaultPromotion;
  organizationName: string | null;
  snapshot: AppearanceSnapshot;
};

/**
 * Just for you: a person's own choice on each axis, or the organization's
 * default. The first option on every row names that default's value, and
 * *Use organization defaults* puts every row back on it.
 */
export function PersonalAppearanceForm({
  action,
  contextToken,
  idempotencyNonce,
  onDismiss,
  organizationDefault,
  organizationName,
  snapshot,
}: PersonalAppearanceFormProps) {
  const confirmed = draftOf(snapshot.user);
  const [draft, setDraft] = useState<AppearanceDraft>(confirmed);
  const [state, formAction, pending] = useActionState(
    action ?? unavailableAppearanceAction,
    initialAppearanceActionState,
  );
  const returnTo = useReturnDestination();
  useSuccessNavigation(state);

  const inherited = snapshot.organization;
  const inheritDescription =
    inherited.version > 0 && organizationName !== null
      ? `Inherited from ${organizationName}`
      : fallbackSourceDescription;
  // Guarded rather than cast: `inherit` is not an axis value, and neither is a
  // value that fell off a vocabulary, so an axis the guard rejects previews the
  // inherited default instead of reaching the provider unchecked.
  const preview = withFallback(draft, inherited);
  const dirty = isDirty(draft, confirmed);
  const ownChoices = appearanceAxes.filter(
    (axis) => draft[axis] !== appearanceInheritValue,
  ).length;
  // Offered only when it would change something. A promotion that writes the
  // organization's own values back to it is a confirmation dialog for nothing.
  const promotion = withFallback(draft, inherited);
  const promotable =
    organizationDefault !== undefined &&
    inherited.version > 0 &&
    appearanceAxes.some((axis) => promotion[axis] !== inherited[axis]);

  function options(axis: AppearanceAxis): AxisOption[] {
    // A `match` on any of these rows, the inherited one included, is named by
    // what it resolves to under the theme this person will see: the page
    // renders the organization's `match` under their theme, not the
    // organization's.
    return [
      {
        label: `Organization default: ${valueLabel(axis, inherited[axis], preview.theme)}`,
        value: appearanceInheritValue,
      },
      ...axisOptions(axis, preview.theme),
    ];
  }

  function change(field: AppearanceFieldName) {
    return (next: string | null) =>
      setDraft((current) => ({
        ...current,
        [field]: accepted(next, options(field), current[field]),
      }));
  }

  return (
    <>
      <form action={formAction}>
        <AppearanceDraftPreview
          confirmed={snapshot.effective}
          preview={preview}
        />
        <input
          name="expectedVersion"
          type="hidden"
          value={snapshot.user.version}
        />
        <input
          name="idempotencyKey"
          type="hidden"
          value={draftKey(idempotencyNonce, draft)}
        />
        <input name="renderContext" type="hidden" value={contextToken} />
        <input name="returnTo" type="hidden" value={returnTo} />
        <Stack direction="column" gap={3}>
          <Inspector.Root>
            <Inspector.Section label="Just for you">
              {displayedAxes.map((field) => (
                <Inspector.Row key={field} label={axisLabels[field]}>
                  <AppearanceAxisSelect
                    description={
                      draft[field] === appearanceInheritValue
                        ? inheritDescription
                        : overriddenDescription
                    }
                    disabled={pending}
                    field={field}
                    issues={fieldIssues(state, field)}
                    onValueChange={change(field)}
                    options={options(field)}
                    value={draft[field]}
                  />
                </Inspector.Row>
              ))}
            </Inspector.Section>
            <Inspector.Footer
              action={
                <Stack direction="row" gap={2} wrap>
                  {dirty ? (
                    <Button
                      disabled={pending}
                      size="sm"
                      type="submit"
                      variant="primary"
                    >
                      {pending ? "Applying…" : "Apply"}
                    </Button>
                  ) : null}
                  <Button
                    disabled={pending || ownChoices === 0}
                    onClick={() => setDraft(draftOf(noOverrides))}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Use organization defaults
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setDraft(confirmed);
                      onDismiss?.();
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </Stack>
              }
              note={
                ownChoices === 0
                  ? "You follow the organization default on every setting."
                  : `You have ${ownChoices} of your own ${ownChoices === 1 ? "choice" : "choices"}.`
              }
            />
          </Inspector.Root>
          <AppearanceBanner message={bannerMessage(state)} />
          {dirty ? <p role="status">{previewNotice}</p> : null}
        </Stack>
      </form>
      {promotable && organizationDefault !== undefined ? (
        <PromoteToOrganizationDefault
          axes={promotion}
          organizationName={organizationName}
          promotion={organizationDefault}
          version={inherited.version}
        />
      ) : null}
    </>
  );
}

export type OrganizationAppearanceFormProps = {
  action?: AppearanceFormAction;
  contextToken: string;
  defaults: AppearanceDefaults;
  idempotencyNonce: string;
  organizationName: string;
  /** The signed-in user's own overrides, so the preview shows what they will see. */
  overrides?: AppearanceOverrides;
  version: number;
};

/**
 * The organization's default on each axis, for everyone in it who has not
 * chosen for themselves. Rendered only for a member who may change it: the
 * settings page decides with `canEditOrganizationAppearance`, the same
 * authority the command enforces.
 */
export function OrganizationAppearanceForm({
  action,
  contextToken,
  defaults,
  idempotencyNonce,
  organizationName,
  overrides = noOverrides,
  version,
}: OrganizationAppearanceFormProps) {
  const [draft, setDraft] = useState<AppearanceDraft>(draftOf(defaults));
  const [state, formAction, pending] = useActionState(
    action ?? unavailableAppearanceAction,
    initialAppearanceActionState,
  );
  const returnTo = useReturnDestination();
  useSuccessNavigation(state);

  const drafted = withFallback(draft, defaults);
  // The preview shows what *this* owner or admin will see: their own overrides
  // still win over the tenant draft they are editing.
  const preview = withFallback(draftOf(overrides), drafted);
  const confirmedAxes = withFallback(draftOf(overrides), defaults);

  function options(axis: AppearanceAxis): AxisOption[] {
    // A `match` here follows the theme the organization is being given.
    return axisOptions(axis, drafted.theme);
  }

  function change(field: AppearanceFieldName) {
    return (next: string | null) =>
      setDraft((current) => ({
        ...current,
        [field]: accepted(next, options(field), current[field]),
      }));
  }

  return (
    <form action={formAction}>
      <AppearanceDraftPreview confirmed={confirmedAxes} preview={preview} />
      <input name="expectedVersion" type="hidden" value={version} />
      <input
        name="idempotencyKey"
        type="hidden"
        value={draftKey(idempotencyNonce, draft)}
      />
      <input name="renderContext" type="hidden" value={contextToken} />
      <input name="returnTo" type="hidden" value={returnTo} />
      <Stack direction="column" gap={3}>
        <Inspector.Root>
          <Inspector.Section
            label={`Organization default · everyone in ${organizationName}`}
          >
            {displayedAxes.map((field) => (
              <Inspector.Row key={field} label={axisLabels[field]}>
                <AppearanceAxisSelect
                  description={axisHelp[field]}
                  disabled={pending}
                  field={field}
                  issues={fieldIssues(state, field)}
                  onValueChange={change(field)}
                  options={options(field)}
                  value={draft[field]}
                />
              </Inspector.Row>
            ))}
          </Inspector.Section>
          <Inspector.Footer
            action={
              <Stack direction="row" gap={2} wrap>
                <Button
                  disabled={pending}
                  size="sm"
                  type="submit"
                  variant="primary"
                >
                  {pending ? "Applying…" : "Apply"}
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => setDraft(draftOf(defaults))}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </Stack>
            }
            note="Applies to everyone who has not chosen for themselves."
          />
        </Inspector.Root>
        <AppearanceBanner message={bannerMessage(state)} />
      </Stack>
    </form>
  );
}
