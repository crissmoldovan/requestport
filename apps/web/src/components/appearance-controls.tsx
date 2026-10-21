"use client";

import { Row } from "@cueplusplus/ui/chrome";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Select,
} from "@cueplusplus/ui/forms";
import { Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import { useTheme } from "@cueplusplus/ui/system";
import {
  type AppearanceDefaults,
  type AppearanceDensity,
  type AppearanceMode,
  type AppearanceOverrides,
  type AppearanceSnapshot,
  type AppearanceTheme,
  appearanceDensities,
  appearanceModes,
  appearanceThemes,
  isAppearanceDensity,
  isAppearanceMode,
  isAppearanceTheme,
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

/**
 * The appearance menu and editor.
 *
 * Both forms keep the last confirmed values until the server accepts the write:
 * editing a control only moves an in-memory draft, which is previewed through
 * the existing CUE++ provider. Nothing here reads or writes browser storage —
 * the root provider runs with `persistPreferences={false}` — and nothing here
 * writes to the database except by submitting the form.
 */

const themeLabels: Record<AppearanceTheme, string> = {
  cue: "CUE++",
  dusk: "Dusk",
  hivehub: "HiveHub",
  luma: "Luma",
  requestport: "RequestPort",
  signal: "Signal",
  snuffle: "Snuffle",
  terminal: "Terminal",
  venu: "Venu",
};

const densityLabels: Record<AppearanceDensity, string> = {
  large: "Large",
  normal: "Normal",
  "ultra-compact": "Ultra compact",
};

const modeLabels: Record<AppearanceMode, string> = {
  dark: "Dark",
  light: "Light",
  system: "Match system",
};

const axisLabels = {
  density: "Density",
  mode: "Mode",
  theme: "Theme",
} as const;

const inheritOptionLabel = "Organization default";
const overriddenDescription = "Set for your account";
const fallbackSourceDescription = "Inherited from the RequestPort default";

type AxisOption = { label: string; value: string };

function axisOptions(
  values: readonly string[],
  labels: Record<string, string>,
  inheritable: boolean,
): AxisOption[] {
  const options = values.map((value) => ({
    label: labels[value] ?? value,
    value,
  }));
  return inheritable
    ? [{ label: inheritOptionLabel, value: appearanceInheritValue }, ...options]
    : options;
}

const personalOptions = {
  density: axisOptions(appearanceDensities, densityLabels, true),
  mode: axisOptions(appearanceModes, modeLabels, true),
  theme: axisOptions(appearanceThemes, themeLabels, true),
} as const;

const organizationOptions = {
  density: axisOptions(appearanceDensities, densityLabels, false),
  mode: axisOptions(appearanceModes, modeLabels, false),
  theme: axisOptions(appearanceThemes, themeLabels, false),
} as const;

/**
 * Whether the draft differs from what is stored.
 *
 * The preview already computes this to decide whether to drive the provider at
 * all; saying it out loud is what was missing. A person who has repainted the
 * whole interface should be told that is all they have done, and the control
 * that saves it should appear exactly when there is something to save.
 */
function isDirty(draft: AppearanceDraft, confirmed: AppearanceDraft): boolean {
  return (
    draft.theme !== confirmed.theme ||
    draft.density !== confirmed.density ||
    draft.mode !== confirmed.mode
  );
}

/** Said once, so both editors say it the same way. */
const previewNotice = "Previewing. Apply to save.";

/**
 * What an owner needs to offer their own choice to the organization.
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
 * The triple this draft would make the organization's default.
 *
 * An axis left on *Organization default* is not a statement about what the
 * organization should inherit — there is no value to promote — so it carries
 * what the organization already has. Only the axes the person actually chose
 * travel.
 */
function promotedTriple(
  draft: AppearanceDraft,
  current: AppearanceDefaults,
): AppearanceDefaults {
  return {
    density: isAppearanceDensity(draft.density)
      ? draft.density
      : current.density,
    mode: isAppearanceMode(draft.mode) ? draft.mode : current.mode,
    theme: isAppearanceTheme(draft.theme) ? draft.theme : current.theme,
  };
}

/**
 * The owner's promotion, as its own form.
 *
 * A sibling rather than a second button on the personal form, because it writes
 * a different command with a different authority, a different render context
 * and a different expected version. Sharing a form with *Apply* is precisely
 * how an owner would change everyone's appearance while meaning to change their
 * own, and the confirmation is the second guard on the same thought.
 */
function PromoteToOrganizationDefault({
  organizationName,
  promotion,
  triple,
  version,
}: {
  organizationName: string | null;
  promotion: OrganizationDefaultPromotion;
  triple: AppearanceDefaults;
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
        value={`${promotion.idempotencyNonce}:${triple.theme}:${triple.density}:${triple.mode}`}
      />
      <input
        name="renderContext"
        type="hidden"
        value={promotion.contextToken}
      />
      <input name="density" type="hidden" value={triple.density} />
      <input name="mode" type="hidden" value={triple.mode} />
      <input name="theme" type="hidden" value={triple.theme} />
      <Stack direction="column" gap={2}>
        <AppearanceBanner message={bannerMessage(state)} />
        {confirming ? (
          <Stack direction="row" gap={2} wrap>
            <span>
              {organizationName === null
                ? "Everyone who has not overridden these axes will see this."
                : `Everyone in ${organizationName} who has not overridden these axes will see this.`}
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

/** A draft axis value: a supported literal, or `inherit` on a personal axis. */
type AppearanceDraft = Record<AppearanceFieldName, string>;

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

/**
 * Applies the draft to the ambient provider while the draft differs from the
 * confirmed values, and puts the confirmed values back the moment it stops —
 * whether that is Cancel, a reset, an Escape, an outside press, or the panel
 * unmounting with the popover that held it.
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
  const { setDensity, setMode, setTheme } = useTheme();
  const dirty =
    preview.theme !== confirmed.theme ||
    preview.density !== confirmed.density ||
    preview.mode !== confirmed.mode;
  const previewing = useRef(false);
  const restoreRef = useRef({ confirmed, setDensity, setMode, setTheme });
  restoreRef.current = { confirmed, setDensity, setMode, setTheme };

  useEffect(() => {
    if (dirty) {
      previewing.current = true;
      setTheme(preview.theme);
      setDensity(preview.density);
      setMode(preview.mode);
      return;
    }
    if (!previewing.current) return;
    previewing.current = false;
    setTheme(confirmed.theme);
    setDensity(confirmed.density);
    setMode(confirmed.mode);
  }, [
    confirmed.density,
    confirmed.mode,
    confirmed.theme,
    dirty,
    preview.density,
    preview.mode,
    preview.theme,
    setDensity,
    setMode,
    setTheme,
  ]);

  useEffect(
    () => () => {
      if (!previewing.current) return;
      previewing.current = false;
      const restore = restoreRef.current;
      restore.setTheme(restore.confirmed.theme);
      restore.setDensity(restore.confirmed.density);
      restore.setMode(restore.confirmed.mode);
    },
    [],
  );

  return null;
}

function AppearanceAxisField({
  description,
  disabled,
  field,
  issues,
  onValueChange,
  options,
  value,
}: {
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
      <FieldLabel>{axisLabels[field]}</FieldLabel>
      <Select
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
 * next paint comes from the server-resolved triple rather than from provider
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

export function PersonalAppearanceForm({
  action,
  contextToken,
  idempotencyNonce,
  onDismiss,
  organizationDefault,
  organizationName,
  snapshot,
}: PersonalAppearanceFormProps) {
  const confirmed: AppearanceDraft = {
    density: snapshot.user.density ?? appearanceInheritValue,
    mode: snapshot.user.mode ?? appearanceInheritValue,
    theme: snapshot.user.theme ?? appearanceInheritValue,
  };
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
  const preview: AppearanceDefaults = {
    density: isAppearanceDensity(draft.density)
      ? draft.density
      : inherited.density,
    mode: isAppearanceMode(draft.mode) ? draft.mode : inherited.mode,
    theme: isAppearanceTheme(draft.theme) ? draft.theme : inherited.theme,
  };
  const confirmedTriple: AppearanceDefaults = {
    density: snapshot.effective.density,
    mode: snapshot.effective.mode,
    theme: snapshot.effective.theme,
  };
  const idempotencyKey = `${idempotencyNonce}:${draft.theme}:${draft.density}:${draft.mode}`;
  const dirty = isDirty(draft, confirmed);
  // Offered only when it would change something. A promotion that writes the
  // organization's own values back to it is a confirmation dialog for nothing.
  const promotion = promotedTriple(draft, inherited);
  const promotable =
    organizationDefault !== undefined &&
    inherited.version > 0 &&
    (promotion.theme !== inherited.theme ||
      promotion.density !== inherited.density ||
      promotion.mode !== inherited.mode);

  function change(field: AppearanceFieldName) {
    return (next: string | null) =>
      setDraft((current) => ({
        ...current,
        [field]: accepted(next, personalOptions[field], current[field]),
      }));
  }

  return (
    <>
      <form action={formAction}>
        <AppearanceDraftPreview confirmed={confirmedTriple} preview={preview} />
        <input
          name="expectedVersion"
          type="hidden"
          value={snapshot.user.version}
        />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <input name="renderContext" type="hidden" value={contextToken} />
        <input name="returnTo" type="hidden" value={returnTo} />
        <Stack direction="column" gap={3}>
          {(["theme", "density", "mode"] as const).map((field) => (
            <AppearanceAxisField
              description={
                draft[field] === appearanceInheritValue
                  ? inheritDescription
                  : overriddenDescription
              }
              disabled={pending}
              field={field}
              issues={fieldIssues(state, field)}
              key={field}
              onValueChange={change(field)}
              options={personalOptions[field]}
              value={draft[field]}
            />
          ))}
          <AppearanceBanner message={bannerMessage(state)} />
          {dirty ? <p role="status">{previewNotice}</p> : null}
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
              disabled={pending}
              onClick={() =>
                setDraft({
                  density: appearanceInheritValue,
                  mode: appearanceInheritValue,
                  theme: appearanceInheritValue,
                })
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Reset to organization defaults
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
        </Stack>
      </form>
      {promotable && organizationDefault !== undefined ? (
        <PromoteToOrganizationDefault
          organizationName={organizationName}
          promotion={organizationDefault}
          triple={promotion}
          version={inherited.version}
        />
      ) : null}
    </>
  );
}

export type OrganizationAppearanceFormProps = {
  action?: AppearanceFormAction;
  canEdit: boolean;
  contextToken: string;
  defaults: AppearanceDefaults;
  idempotencyNonce: string;
  organizationName: string;
  /** The signed-in user's own overrides, so the preview shows what they will see. */
  overrides?: AppearanceOverrides;
  version: number;
};

const noOverrides: AppearanceOverrides = {
  density: null,
  mode: null,
  theme: null,
};

export function OrganizationAppearanceForm({
  action,
  canEdit,
  contextToken,
  defaults,
  idempotencyNonce,
  organizationName,
  overrides = noOverrides,
  version,
}: OrganizationAppearanceFormProps) {
  const [draft, setDraft] = useState<AppearanceDraft>({ ...defaults });
  const [state, formAction, pending] = useActionState(
    action ?? unavailableAppearanceAction,
    initialAppearanceActionState,
  );
  const returnTo = useReturnDestination();
  useSuccessNavigation(state);

  if (!canEdit) {
    return (
      <Stack direction="column" gap={2}>
        {(["theme", "density", "mode"] as const).map((field) => (
          <Row key={field}>
            <span>{axisLabels[field]}</span>
            <span>{valueLabel(defaults[field])}</span>
          </Row>
        ))}
        <p>Only an owner can change these defaults.</p>
      </Stack>
    );
  }

  // The preview shows what *this* owner will see: their own overrides still win
  // over the tenant draft they are editing.
  const preview: AppearanceDefaults = {
    density:
      overrides.density ??
      (isAppearanceDensity(draft.density) ? draft.density : defaults.density),
    mode:
      overrides.mode ??
      (isAppearanceMode(draft.mode) ? draft.mode : defaults.mode),
    theme:
      overrides.theme ??
      (isAppearanceTheme(draft.theme) ? draft.theme : defaults.theme),
  };
  const confirmedTriple: AppearanceDefaults = {
    density: overrides.density ?? defaults.density,
    mode: overrides.mode ?? defaults.mode,
    theme: overrides.theme ?? defaults.theme,
  };
  const idempotencyKey = `${idempotencyNonce}:${draft.theme}:${draft.density}:${draft.mode}`;

  function change(field: AppearanceFieldName) {
    return (next: string | null) =>
      setDraft((current) => ({
        ...current,
        [field]: accepted(next, organizationOptions[field], current[field]),
      }));
  }

  return (
    <form action={formAction}>
      <AppearanceDraftPreview confirmed={confirmedTriple} preview={preview} />
      <input name="expectedVersion" type="hidden" value={version} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <input name="renderContext" type="hidden" value={contextToken} />
      <input name="returnTo" type="hidden" value={returnTo} />
      <Stack direction="column" gap={3}>
        {(["theme", "density", "mode"] as const).map((field) => (
          <AppearanceAxisField
            description={`Applies to everyone in ${organizationName} who has not overridden this axis.`}
            disabled={pending}
            field={field}
            issues={fieldIssues(state, field)}
            key={field}
            onValueChange={change(field)}
            options={organizationOptions[field]}
            value={draft[field]}
          />
        ))}
        <AppearanceBanner message={bannerMessage(state)} />
        <Stack direction="row" gap={2} wrap>
          <Button disabled={pending} size="sm" type="submit" variant="primary">
            {pending ? "Applying…" : "Apply"}
          </Button>
          <Button
            disabled={pending}
            onClick={() => setDraft({ ...defaults })}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}

/** The three vocabularies are disjoint, so one guarded lookup names any axis. */
function valueLabel(value: string) {
  if (isAppearanceTheme(value)) return themeLabels[value];
  if (isAppearanceDensity(value)) return densityLabels[value];
  if (isAppearanceMode(value)) return modeLabels[value];
  return value;
}
