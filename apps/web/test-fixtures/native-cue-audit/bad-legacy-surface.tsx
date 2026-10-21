"use client";

import type { AppearanceTheme } from "@requestport/domain/browser";

import { Button, Chip } from "@cueplusplus/ui";
import { Table } from "@cueplusplus/ui/instruments";
import { ThemeProvider } from "@cueplusplus/ui/system";
import { Button as LegacyButton } from "@requestport/ui";
import NextLink from "next/link";

/**
 * A retired recipe and an arbitrary colour hoisted out of the attribute they
 * used to be written in. A class name held in a constant is the same class
 * name; the audit reads the literal wherever it is written.
 */
const hoistedRecipe = "ui-hoisted bg-[#00ff00]";

/**
 * Two casts into the appearance vocabulary, which is what section 9's
 * resolution contract exists to prevent: an unvalidated value asserted into the
 * closed axis instead of parsed into it. `spacing` is the near miss — `normal`
 * is an ordinary English word before it is a density, and a single literal that
 * is not a theme name is not a theme-name cast.
 */
declare const raw: string;

const asserted = raw as AppearanceTheme;
const assertedName = raw as "requestport";
const spacing = raw as "normal";

/**
 * Three near misses, kept here because the expectation for this file is exact
 * and therefore says they are never reported. The first two quote a class
 * inside a line the audit itself records — a recorded line carries a `|`, which
 * no class name may, and that is what separates the bookkeeping from the class
 * it quotes. The third is a font stack: `ui-monospace` is a CSS generic family,
 * not a retired RequestPort recipe.
 */
const recordedAuditLine = "arbitrary-class-value|bg-[#ff0000]";
const recordedModifiedLine = "arbitrary-class-value|bg-[#ff0000]/50";
const monoStack = "__Geist_Mono, ui-monospace, monospace";

/**
 * Every signal the audit exists to find, in one unmigrated surface: the retired
 * package, the barrel import instead of the
 * smallest subpath, a retired recipe class, arbitrary Tailwind colour and
 * length values, an application `style` prop, raw visible controls, a local
 * SVG, an `asChild` clone outside its two boundaries, and a variant whose type
 * is `string` rather than the component's closed axis.
 *
 * `hint` is that last one made optional. Dropping the nullish member of an
 * optional prop must not drop the rest of it: `string | undefined` is still
 * open, and is still reported.
 */
export function BadLegacySurface({
  hint,
  tone,
}: {
  hint?: string;
  tone: string;
}) {
  return (
    <div className="ui-panel bg-[#ff0000] h-[32px]">
      <p className={hoistedRecipe} title={recordedAuditLine}>
        Hoisted
      </p>
      {/* An arbitrary colour and an arbitrary length, each carrying the
          modifier Tailwind writes after the value. The modifier is the standard
          way to spell an opacity or a line height, and it does not make the
          value any less raw. */}
      <p aria-label={recordedModifiedLine} className="bg-[#ff0000]/50">
        Modified
      </p>
      <p className="text-[10px]/[1.2]">Sized</p>
      {/* The same modifier on a Tailwind palette colour, which is the other
          half of the rule and the same hole. */}
      <p className="text-white/80">Faded</p>
      {/* The same palette colours behind a variant chain. A variant says *when*
          a utility applies; it does not make the utility a different one. A
          rule anchored at the start of the token therefore exempted every
          hover, breakpoint, and dark-mode spelling of the colour it forbids —
          which is how a palette survives a migration. */}
      <p className="hover:bg-red-500 peer-checked:text-white/80">Varied</p>
      {/* A variant that carries a bracket of its own, whose contents hold the
          very separator the chain is split on. */}
      <p className="[&_svg]:text-red-500">Descendant</p>
      {/* Every bracketed variant form. The bracket a variant carries is a
          condition, not the utility's value, so a rule that read only the first
          bracket group in the token judged the condition and let the raw colour
          or raw length behind it through untouched. */}
      <p className="[&:hover]:bg-[#ff0000] [&_svg]:text-[#ff0000] [&>svg]:h-[32px]">
        Bracketed
      </p>
      {/* The same hole spelled with the functional variants, two of which a
          prefix pattern without `=` could not even parse. `max-[42rem]:` was
          caught before only by the accident of its own bracket holding a raw
          length, and has to stay caught for the reason that is written on it. */}
      <p className="supports-[display:grid]:bg-[#ff0000] data-[state=open]:bg-[#ff0000] aria-[expanded=true]:bg-[#ff0000] max-[42rem]:bg-[#ff0000]">
        Conditioned
      </p>
      {/* Tailwind v4's arbitrary *property* form, which carries no `-[` and so
          was invisible to every rule the audit declares. The first spelling is
          the retired unlayered `:root { --radius-control: 3px }` written as one
          class: Tailwind emits it into `@layer utilities`, the CUE++ bridge
          sits in `@layer theme`, and utilities outrank theme — so this one
          token flattens every control corner in the subtree on every theme and
          density. The second redeclares a published colour name outright. */}
      <p className="[--radius-control:3px] [--cue-bg:#ff0000]">Propertied</p>
      {/* The same door with an ordinary CSS property behind it: a raw hex
          colour and raw px type, padding and radius, straight into the shipped
          stylesheet, with nothing in the class that a value rule could see. */}
      <p className="[color:#ff0000] [padding:12px] [font-size:9px] [border-radius:3px]">
        Declared
      </p>
      {/* Tailwind's own scale, which resolves through Tailwind's `--spacing`,
          type and radius ladders and never through a CUE++ density token. None
          of these carries a bracket or a palette name, so every value rule the
          audit had looked straight past them: `h-8` pins a control at a fixed
          2rem that does not move with the density the reader chose, and
          `text-2xl` reintroduces the second type scale the reskin retired. */}
      <p className="p-4 h-8 gap-2 w-64 rounded-lg text-2xl">Scaled</p>
      {/* Scroll padding and scroll margin. Section 5.2 names padding and
          margin among the families the class channel must reject, and these
          are both — they take the same `--spacing` ladder rung as `p-4` and
          `mt-8`, and no more resolve through a CUE++ density token than those
          do. They were neither governed nor written down as an exception,
          which is the one state an exclusion may never be in. */}
      <p className="scroll-p-4 scroll-mt-8">Scrolled</p>
      {/* The same rung behind a breakpoint variant, and Tailwind's bare default
          radius — the spelling that carries no value at all. */}
      <p className="md:max-w-40 rounded">Ruled</p>
      {/* A threshold written into a variant rather than into a value. The
          arbitrary-value rule required the whole token to end in `]`, so a
          bracket that qualifies a *conforming* utility was never read at all —
          and section 5.2 permits exactly three responsive thresholds, which
          the stylesheet channel enforces and the class channel did not. The
          first of these introduces a fourth breakpoint invisibly. The other
          two name thresholds 5.2 allows, and the exact expectation for this
          file says they are not findings. */}
      <p className="min-[37rem]:p-(--cue-space-2) min-[40rem]:p-(--cue-space-2) max-[56.25rem]:gap-(--cue-space-1)">
        Thresholded
      </p>
      {/* The same fourth threshold, spelled the way Tailwind spells a space.
          The underscore is a word character, so the lookbehind that keeps the
          rung in a token name from reading as a measurement keeps this one
          from reading as one too — and the variant bracket was the last site
          producing a value that never had the convention read back. The first
          of these compiles to a fourth breakpoint under tailwindcss 4.3.3 and
          is a finding; the second names a threshold 5.2 allows, and the exact
          expectation for this file says it is not one. */}
      <p className="[@media(min-width:_37rem)]:p-(--cue-space-2) [@media(min-width:_40rem)]:p-(--cue-space-2)">
        Underscored threshold
      </p>
      {/* Not findings, and the exact expectation for this file says so. `0`,
          fractions, viewport and intrinsic keywords carry no measurement, which
          is why section 5.2 allows them in shell layout; and `text-` spells an
          alignment and a published colour long before it spells a type rung. */}
      <p className="min-w-0 w-full max-w-none h-fit text-center text-fg-subtle">
        Unmeasured
      </p>
      {/* The conforming spellings, which have to keep passing: a CUE++ theme
          key, and the custom-property form Tailwind v4 reads a token through. */}
      <p className="h-control-sm rounded-control gap-(--cue-space-2) text-(length:--cue-text-label)">
        Tokenized
      </p>
      {/* One `!` defeats every class rule at once. Every value rule the audit
          declares was anchored on the raw token — the arbitrary property on
          `^[`, the arbitrary value on `]$`, the palette on `$`, the rung on a
          family prefix — so a `!` on either end made the token unreadable to
          all of them simultaneously. tailwindcss 4.3.3 compiles both of these
          spellings, and the first one still ships the layer-utilities override
          that flattens every CUE++ control corner in the subtree. */}
      <p className="[--radius-control:3px]! ![--cue-bg:#ff0000] !bg-red-500 bg-[#ff0000]! !p-4 gap-2!">
        Insistent
      </p>
      {/* A negative rung is the same hand-written geometry as a positive one.
          `margin: -1px` is no more resolved by a density than `margin: 1px`,
          and the stylesheet channel says so in as many words — its own raw
          length matches the sign rather than forbidding it. The class channel
          measured the rung from a family prefix instead, so the leading sign
          carried every negative rung of every governed family straight past
          the only rule that reads one. */}
      <p className="-mt-4 -mx-2 md:-top-8">Pulled</p>
      {/* Tailwind v4's parenthesised custom-property shorthand, written in a
          governed family against a property the token layer never declared.
          `--brand-gap` and `--brand-w` answer no theme and no density, which
          is the whole of what section 5.2 asks a length to do — and the data
          type hint puts a `:` inside the parentheses, which is where the
          variant split used to cut the token in half. */}
      <p className="p-(--brand-gap) w-(length:--brand-w)">Hand-rolled</p>
      {/* The same two utilities in the spelling the parentheses abbreviate.
          `p-(--brand-gap)` is exact shorthand for `p-[var(--brand-gap)]` and
          tailwindcss 4.3.3 emits the identical declaration for both, but the
          rung rule read the shorthand and dropped the long form — so the
          widening written to hold a governed family to a `--cue-*` property
          missed the very spelling it was written for. The third is conforming
          and the exact expectation for this file says it is never reported: a
          bracket is not the offence, an ungoverned property is. */}
      <p className="p-[var(--brand-gap)] w-[var(--brand-w)] gap-[var(--cue-space-1)]">
        Bracketed hand-rolled
      </p>
      {/* A retired recipe behind a variant chain, and the same recipe carrying
          the important flag. Every other class rule was converted to read the
          parsed utility; this one alone kept testing the raw token, so a `md:`
          in front of a retired recipe or a `!` behind it hid it from the only
          rule that looks for one — the exact spelling a half-finished migration
          leaves behind. */}
      <p className="md:ui-legacy ui-legacy!">Prefixed</p>
      {/* Three raw values a character gate hid from every class rule at once.
          The parser refused any token outside a hand-written alphabet and any
          token carrying a `|`, and refused it *before* a rule ran — so a brace,
          a caret and the separator the audit's own bookkeeping uses each made a
          token invisible to the whole class channel. tailwindcss 4.3.3 compiles
          all three: `padding: 1px|2px`, `width: calc(100% - {2px})` and
          `background-color: #ff0000^` reach the emitted stylesheet. */}
      <p className="p-[1px|2px] w-[calc(100%-{2px})] bg-[#ff0000^]">Ungated</p>
      {/* Not a finding: an arbitrary property is only a declaration when it
          spells one, and a value that is neither a colour nor a length is
          neither. */}
      <p className="[mask-type:alpha]">Masked</p>
      {/* Tailwind spells a space inside an arbitrary value as `_`, and only one
          of the two branches that produce a value read it back. The arbitrary
          *property* did; the arbitrary *value* and the bracketed modifier kept
          the underscore — and `_` is a word character, so the raw-length
          lookbehind and every raw-colour word boundary were defeated by the
          convention itself. tailwindcss 4.3.3 emits
          `height: calc(100% - 2px)`, a 1px red box shadow and
          `line-height: calc(100% - 2px)` for these three. The fourth is the
          same convention in the branch that always read it, and is not a
          finding: a track list is neither a colour nor a length. */}
      <p className="h-[calc(100%_-_2px)] shadow-[0_0_0_1px_red] text-base/[calc(100%_-_2px)] [grid-template-columns:auto_1fr]">
        Underscored
      </p>
      {/* A fourth responsive threshold in front of an arbitrary property. The
          same threshold in front of a named, an arbitrary-value or a
          custom-property utility is caught, but the declaration branch returned
          before the variant chain was ever examined — so the one utility form
          that carries no utility name was also the one form whose condition
          nobody read. Section 5.2 permits three thresholds regardless of what
          the utility behind them happens to be. */}
      <p className="min-[37rem]:[display:grid]">Thresholded declaration</p>
      {/* Not findings, and the exact expectation for this file says so: an
          arbitrary aspect ratio and a fractional width carry neither a colour
          nor a length, and a URL is not a utility however much of one its path
          spells. */}
      <p className="aspect-[16/9] w-1/2">Shaped</p>
      <a href="https://example.com/docs/bg-red-500">Documentation</a>
      {/* Two anchors the application styles itself and gives no focus ring.
          `raw-visible-control` excludes `a` on purpose — an anchor carries no
          visual recipe — but section 13 requires the focus indicator to come
          from the CUE++ focus token, and the retired stylesheet's element-level
          `:focus-visible` rule was the only thing that had ever supplied one
          here. A keyboard user gets the browser default on these while every
          adjacent CUE++ control gets `outline-color: var(--cue-accent)`: two
          different affordances on the same row. */}
      <a className="underline" href="/requests">
        Unfocused
      </a>
      <NextLink className="font-mono underline" href="/requests">
        Routed and unfocused
      </NextLink>
      {/* Three anchors that satisfy the letter of a `focus-visible:` outline
          and draw no ring whatever. `outline-hidden` is v4's spelling of the
          suppression `outline-none` spells in v3 — the rule excluded only the
          literal `outline-none`, so it *admitted* the same claim under its
          other name. `outline-0` sets a zero width. And a bare colour sets
          `outline-color` and neither a width nor a style, so it paints an
          outline that is not drawn. Section 13 asks for an indicator that
          comes from the CUE++ focus token and stays visible on every
          theme/mode pair; each of these is a styled anchor claiming to hold
          that contract while a keyboard user gets nothing. */}
      <a className="underline focus-visible:outline-hidden" href="/hidden">
        Hidden ring
      </a>
      <a
        className="underline focus-visible:outline-0 focus-visible:outline-accent"
        href="/zeroed"
      >
        Zero-width ring
      </a>
      <a className="underline focus-visible:outline-accent" href="/uncoloured">
        Colour with no ring
      </a>
      {/* The chassis contract, written out. This is the package's own focus
          recipe — the same four utilities `linkVariants` carries — so an anchor
          that states it is holding the contract rather than breaking it. */}
      <a
        className="underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent"
        href="/activity"
      >
        Focused
      </a>
      <input name="fontStack" type="hidden" value={monoStack} />
      <input name="theme" type="hidden" value={asserted} />
      <input name="themeName" type="hidden" value={assertedName} />
      <input name="density" type="hidden" value={spacing} />
      <LegacyButton>Legacy</LegacyButton>
      <Chip tone={tone}>Dynamic</Chip>
      <Chip tone={hint}>Optional but open</Chip>
      <Button style={{ color: "red" }} variant="primary">
        Styled
      </Button>
      {/* The manifest documents seven members of `Table`; `Section` is not one
          of them, so this reaches for a CUE++ surface nobody published. */}
      <Table.Section>Undocumented</Table.Section>
      <button type="button">Raw</button>
      <input name="query" type="text" />
      <select name="lane">
        <option value="one">One</option>
      </select>
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="M2 10 5.25 6.5" />
      </svg>
      <ThemeProvider asChild density="normal" mode="system" theme="requestport">
        <section>Cloned</section>
      </ThemeProvider>
    </div>
  );
}
