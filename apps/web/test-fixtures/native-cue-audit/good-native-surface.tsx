import * as CueForms from "@cueplusplus/ui/forms";
import { Field, FieldLabel, Select } from "@cueplusplus/ui/forms";
import { Button as CueButton, Chip } from "@cueplusplus/ui/primitives";
import { Play } from "lucide-react";

import { Tag } from "./good-local-barrel.js";

const modes = ["system", "dark", "light"] as const;

type Mode = (typeof modes)[number];

/**
 * A natively composed surface: every visible control comes from the smallest
 * CUE++ subpath that exports it, every closed axis is written as a literal or
 * as a value the checker already knows is one of that axis's literals, the one
 * native `input` is hidden server-action metadata, and the appearance mode
 * keywords are ordinary product enums rather than colours.
 *
 * `badge` is the ordinary shape of an optional React prop: the manifest marks
 * `tone` optional, so `"accent" | "info" | undefined` is both type-safe and
 * manifest-conformant, and forwarding it must not be treated as an unverified
 * variant.
 *
 * The last two tags are the two ways a CUE++ component reaches a module under a
 * name the module's own import specifier does not spell: through a namespace
 * import, and through a local barrel that re-exports it. Both are documented
 * components with checked axes, and a scanner that read the documented name off
 * the import text reported both as undocumented and stopped checking either.
 */
export function GoodNativeSurface({
  badge,
  mode,
  tone,
}: {
  badge?: "accent" | "info";
  mode: Mode;
  tone: "ok" | "warn";
}) {
  return (
    <form
      action="/settings/appearance"
      className="settings-form flex min-w-0 flex-col gap-(--cue-space-4) text-(length:--cue-text-body) text-fg-muted"
    >
      <input name="expectedVersion" type="hidden" value="1" />
      <Field>
        <FieldLabel>Mode</FieldLabel>
        <Select
          items={modes.map((value) => ({ label: value, value }))}
          name="mode"
          size="sm"
          value={mode}
        />
      </Field>
      <Chip tone={tone} variant="tinted">
        {mode === "dark" ? "Dark" : "Light"}
      </Chip>
      <Chip tone={badge}>Optional</Chip>
      {/* Aliased on import, because `Button` collides with plenty. What the
          component is comes from the symbol, not from the name this file
          happens to give it. */}
      <CueButton icon={Play} size="sm" variant="primary">
        Apply
      </CueButton>
      <CueForms.FieldDescription>
        Applies to every organization you belong to.
      </CueForms.FieldDescription>
      <Tag tone={tone} variant="tinted">
        Renamed by a local barrel
      </Tag>
    </form>
  );
}
