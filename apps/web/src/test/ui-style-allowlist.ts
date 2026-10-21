/**
 * The reviewed exception lists for raw local layout values, in both channels
 * that can carry one: the stylesheet and the JSX `className`.
 *
 * Section 5.2 of the reskin specification says every length RequestPort writes
 * itself has to resolve through CUE++ density tokens, with one narrow set of
 * exceptions: the responsive thresholds the shell breaks at, the two bounded
 * page widths, and the unit-free values (`0`, percentages, viewport units,
 * grid fractions, intrinsic keywords) that shell and workbench layout needs.
 * Unit-free values carry no length at all, so the audit never sees them; this
 * module records the two kinds that do.
 *
 * The list is deliberately unable to grow into a second design system: a tuple
 * whose property mentions colour, type, icon, radius, control, margin, padding
 * or gap is rejected by `isForbiddenAllowlistProperty`, which the allowlist's
 * own test runs over every entry.
 */

/** The only responsive thresholds the shell may break at. */
export const allowedMediaThresholds = ["40rem", "56.25rem", "75rem"] as const;

/**
 * The eight property families that may never be allowlisted, named as the
 * words that appear in the CSS property. `control` covers the retired
 * `--control-*` custom properties, which are exactly the rungs CUE++ density
 * now owns.
 */
export const forbiddenAllowlistProperties = [
  "color",
  "control",
  "font",
  "gap",
  "icon",
  "margin",
  "padding",
  "radius",
] as const;

export type StyleAllowlistTuple = {
  readonly selector: string;
  readonly property: string;
  readonly value: string;
};

/**
 * Exact selector/property/value tuples, and there are none.
 *
 * The two bounded content widths that used to be here were the retired
 * stylesheet's, and Task 11 retired the stylesheet: the native `PageShell`
 * carries the measure now, as one of its four documented widths, so no
 * application rule needs a length of its own. An entry left behind after its
 * last consumer is gone is worse than no entry at all — it reads as a licence
 * somebody already reviewed, and it is the shortest path back to a second
 * design system.
 *
 * Empty is therefore the contract. ({@link reviewedInlineStyleProps} is no
 * longer empty: ruling 192 records RequestPort's mark there.) Adding a tuple
 * means adding the surface it measures and the fixture that reviews it, in the
 * same commit.
 *
 * Empty is also, on its own, untestable. Against no entries an exact matcher
 * and a matcher that licenses nothing at all are the same function, and a
 * mechanism section 5.2 requires cannot be left in that state — it could break
 * in either direction without a single test noticing, and the first tuple
 * anyone added would be the one that found out. So the list the audit consults
 * is an *option* with this as its default, exactly as the `asChild` provider
 * boundary is: the production scan passes nothing and stays honestly empty,
 * while the fixture suite passes a reviewed tuple and proves the matcher is
 * exact in all three of its parts.
 */
export const styleAllowlist: readonly StyleAllowlistTuple[] = [];

/**
 * The Tailwind utility families a reviewed class exception may name.
 *
 * The class channel needs the same guard the CSS channel has, and for the same
 * reason: an exception list that can grow into a control height, a rung of
 * padding, a gap, a corner radius or a type step is a second design system with
 * a review process attached. Those five are exactly what CUE++ density owns, so
 * none of them is reviewable at any value.
 *
 * A bounded content *measure* is the one thing left, and it is the one thing
 * section 5.2 already licenses in the stylesheet ("bounded content widths") —
 * so `w`, `min-w` and `max-w` are the whole list, and the height families are
 * deliberately absent even though they look symmetrical.
 */
export const reviewableScaleFamilies = ["max-w", "min-w", "w"] as const;

/**
 * A Tailwind scale utility, assembled rather than spelled.
 *
 * This module is read by the audit that consumes it, and the class rules read
 * every string literal a module writes — that is what stops a recipe being
 * hoisted out of the attribute it used to live in. A reviewed token written out
 * here as a literal would therefore be a violation of the very rule it records
 * the exception to. The audit's own suite assembles a retired recipe class for
 * exactly the same reason.
 */
function scaleUtility(family: string, rung: string): string {
  return `${family}-${rung}`;
}

/**
 * Reviewed Tailwind scale utilities, recorded as their exact written token and
 * keyed by the module allowed to write them.
 *
 * The shell bar is one row and a tenant name is arbitrary text, so the
 * organization control needs a measure of its own: without one the trigger
 * grows to fit the name and pushes the search, the new-request action and the
 * account menu off a frame that clips rather than scrolls. CUE++ publishes no
 * measure token — the geometry ladder is control heights, icon sizes, spacing
 * rungs, radii and type steps — so there is no token spelling of "about `6`
 * characters of tenant name, and `10` from the first breakpoint up".
 *
 * Both rungs are therefore written down. That is the whole difference this
 * round is about: the audit called this file clean while these two shipped,
 * because it could not see an ordinary scale utility at all. An exception
 * nobody can see is not an exception, it is a blind spot.
 */
export const reviewedScaleUtilities: Record<string, readonly string[]> = {
  "apps/web/src/components/organization-switcher.tsx": [
    scaleUtility("max-w", "24"),
    `md:${scaleUtility("max-w", "40")}`,
  ],
};

/**
 * Whether a token names a family a reviewed exception may license.
 *
 * The variant chain is dropped by splitting on `:`, which is enough here and
 * only here: the entries are a handful of literal strings this repository
 * writes, and a token carrying a bracketed variant would split into something
 * that matches no family and be rejected. The guard therefore fails closed,
 * which is the direction an exception guard has to fail in.
 */
export function isReviewableScaleUtility(token: string): boolean {
  const utility = token.split(":").at(-1) ?? "";

  return reviewableScaleFamilies.some((family) =>
    utility.startsWith(`${family}-`),
  );
}

/**
 * The Tailwind families the class channel deliberately does not measure.
 *
 * Section 5.2 names this module as the place an exception is recorded and
 * reviewed, and until now the class channel's narrowings were argued in the
 * audit's own source and nowhere else. That is the same defect the reviewed
 * scale utilities had before they were written down: a narrowing only its
 * author can find is indistinguishable from a rule nobody wrote.
 *
 * Each `example` is a real utility of its family written out as a literal, and
 * that is load-bearing rather than decorative. This module is scanned by the
 * audit it configures, so the day any of these families becomes governed, this
 * file becomes a violation and the production scan says which line. An
 * exception that stops being true cannot sit here quietly.
 */
export type UngovernedScaleFamily = {
  readonly prefix: string;
  /** A real utility of that family, written out. See the note above. */
  readonly example: string;
  readonly reason: string;
};

export const ungovernedScaleFamilies: readonly UngovernedScaleFamily[] = [
  {
    example: "basis-4",
    prefix: "basis",
    reason:
      "Takes fractions and percentages far more often than rungs, and no reviewer has found a rung of it in this codebase.",
  },
  {
    example: "border-2",
    prefix: "border",
    reason:
      "The token layer declares --cue-border-width but the bridge publishes no key for it, so there is no conforming spelling shorter than the raw custom property.",
  },
  {
    example: "font-bold",
    prefix: "font",
    reason:
      "A weight and a face are not lengths a density ladder scales, so there is no rung for this family to miss.",
  },
  {
    example: "indent-4",
    prefix: "indent",
    reason:
      "Takes fractions and percentages far more often than rungs, and no reviewer has found a rung of it in this codebase.",
  },
  {
    example: "leading-6",
    prefix: "leading",
    reason:
      "A line height is a ratio against the type step rather than a density rung, and the bridge publishes no key for one.",
  },
  {
    example: "outline-2",
    prefix: "outline",
    reason:
      "The bridge publishes no key for --cue-focus-ring, and the installed package's own chassis writes this exact utility, so governing the family would flag the design system's focus contract. The ring is held instead by anchor-focus-contract, which requires the colour to come from a CUE++ key.",
  },
  {
    example: "outline-offset-2",
    prefix: "outline-offset",
    reason:
      "The bridge publishes no key for --cue-focus-ring-offset, and the package's chassis writes this utility and its negative form.",
  },
  {
    example: "ring-2",
    prefix: "ring",
    reason:
      "A ring width has no bridge key, for the same reason the outline width has none.",
  },
  {
    example: "ring-offset-2",
    prefix: "ring-offset",
    reason:
      "A ring offset has no bridge key, for the same reason the outline offset has none.",
  },
  {
    example: "tracking-wide",
    prefix: "tracking",
    reason:
      "--cue-tracking-label has no bridge key, and a letter spacing is not a length the density ladder scales.",
  },
  {
    example: "translate-x-2",
    prefix: "translate",
    reason:
      "Takes fractions and percentages far more often than rungs, and no reviewer has found a rung of it in this codebase.",
  },
];

/**
 * Every one of the families above is still reached by `arbitrary-class-value`
 * the moment it is written with a bracket, which is the form a raw measurement
 * takes: `border-[3px]` is a finding, `border-2` is not.
 */

/**
 * What the class channel deliberately declines to *read*, as opposed to what it
 * declines to measure.
 *
 * These are narrowings of a rule's field of view rather than of its family
 * list, and they are recorded here for the same reason: the rule that widened
 * to close a hole also decided where to stop, and where it stopped belongs in
 * the register a reviewer reads rather than in the source they do not.
 */
export type UnreadClassCondition = {
  readonly subject: string;
  readonly reason: string;
};

export const unreadClassConditions: readonly UnreadClassCondition[] = [
  {
    reason:
      "A bare modifier is a rung or a percentage rather than a value, and reading it turned a documentation URL whose path ends in a palette name into a colour finding. A bracketed modifier is an arbitrary value in its own right and is read.",
    subject: "a bare value modifier",
  },
  {
    reason:
      "A variant is a condition and paints nothing, so a colour name inside one is a state test rather than a palette: a data-attribute variant matching a tone named after a colour selects, it does not paint. A raw length inside a variant bracket is read, because that is a breakpoint and section 5.2 bounds it to three.",
    subject: "a colour inside a variant bracket",
  },
  {
    reason:
      "A named breakpoint is a key Tailwind's own theme publishes and the shell uses it, so holding md: to the three thresholds would flag conforming application layout rather than the hand-written threshold the rule is about. The bracketed spellings min-[…] and max-[…] are held.",
    subject: "a named breakpoint variant",
  },
  {
    reason:
      "One character is still decided by hand rather than by structure: the `|` this audit writes its own findings with. It is declined only where a Tailwind candidate can never carry one — outside every bracket and parenthesis group — so `p-[1px|2px]` is judged like any other arbitrary value while `untokenized-class-value|p-4` stays bookkeeping. The consequence is bounded and checked: if the installed Tailwind ever compiled a candidate with a group-external `|`, the compiler oracle over every declined token would fail and name it, because that oracle is what licenses the decline rather than the character.",
    subject: "the recorded-line separator outside every group",
  },
  {
    reason:
      "Tailwind spells a space inside an arbitrary value as `_`, and the audit reads it back at every site that produces a value — the arbitrary property, the arbitrary value, the bracketed modifier, and the variant bracket a threshold is written in — it has to, because `_` is a word character and both value rules are word-boundary rules. The substitution is unconditional where Tailwind's is not: Tailwind keeps `_` inside `var(…)` and honours a `\\_` escape. The consequence is bounded and one-directional. Replacing `_` with a space only ever adds word boundaries, so the divergence can make a value rule stricter than Tailwind and never blinder, and it cannot turn an ungoverned custom property into a `--cue-*` one.",
    subject: "the underscore-for-space convention, read unconditionally",
  },
];

/**
 * What this audit is known not to catch, and why each one was left open.
 *
 * The two registers above record where a *rule* was narrowed. This one records
 * where the audit as a whole stops: gaps three reviewers found by execution,
 * which were read, judged bounded, and deliberately not closed. The scan's job
 * is to stop regressions in the code humans write here, not to be a second
 * implementation of Tailwind — but the difference between those two only stays
 * honest while the distance between them is written down. An assumed limit and
 * a forgotten defect are the same artefact.
 *
 * Every entry carries both halves. The `reason` is why closing it was not worth
 * what closing it would cost; the `consequence` is what a reader of an empty
 * report is therefore not entitled to conclude. An entry whose consequence is
 * "the production scan would report this today" does not belong here — that is
 * a violation, and it is fixed or allowlisted rather than described.
 */
export type ReviewedAuditLimit = {
  readonly subject: string;
  /** Which channel the limit sits in: the JSX `className` or the stylesheet. */
  readonly channel: "class" | "register" | "stylesheet";
  readonly reason: string;
  readonly consequence: string;
};

export const reviewedAuditLimits: readonly ReviewedAuditLimit[] = [
  {
    channel: "class",
    consequence:
      "A colour written through an ungoverned custom property in any family but `text-` is not reported. Verified by probe on this tree: of `bg-(…)`, a bracketed `var()` on the same family, and `border-(…)`, none is reported, while the `text-` spelling is — and only because `text-` is governed as a type scale rather than as a paint. The application writes none of the three today, so the scan's zero is not resting on this.",
    reason:
      "The colour families are governed by name — the Tailwind palette pattern and the raw-value rules — and neither of those sees a custom-property reference. Governing them the way the measurement families are governed means asserting that every `--cue-*` ink key is spelled through a family this list knows, and the bridge publishes its ink under one namespace while the utilities that read it span a dozen families. A list that has to be complete to be correct is the shape of exception this register exists to avoid.",
    subject: "a colour resolved through a custom property outside `text-`",
  },
  {
    channel: "stylesheet",
    consequence:
      "A responsive threshold written in modern range syntax, or in a container or feature query, is not held to the three thresholds section 5.2 allows. Verified by probe: a range-syntax `@media`, a `@container` and a `@supports` prelude each carrying a raw length are all unreported. The one stylesheet the application still owns is `globals.css`, which contains a single `body` rule and no at-rule of any kind, so nothing in the shipped CSS reaches this gap.",
    reason:
      "The rule reads an `@media` prelude as a sequence of `(feature: value)` pairs. Range syntax writes no colon, and `@container` and `@supports` are different at-rules with different preludes. Matching all three means parsing three grammars in a channel that, since Task 11, holds five declarations — and the class channel already holds the bracketed variant spellings of the same thresholds, which is where this application writes them.",
    subject: "a threshold outside `@media` feature syntax",
  },
  {
    channel: "register",
    consequence:
      "The register above proves each of its entries is real and genuinely ungoverned; it does not prove that governed and registered together exhaust the families Tailwind gives a spacing, radius or type rung to. A family that is in neither list is measured by nothing and recorded nowhere — the one state this register exists to make impossible, and the one state it cannot yet detect.",
    reason:
      "Completeness has to be measured against something, and the only honest something is Tailwind's own utility list, which the compiler does not expose as data. Deriving it by compiling candidates family by family is a fixture that enumerates the thing this module refuses to enumerate, and it would go stale against the installed version in exactly the way the compiler oracle was adopted to avoid.",
    subject: "the ungoverned-family register is proved sound, not complete",
  },
  {
    channel: "class",
    consequence:
      "The clause could be deleted and no test would fail. The behaviour it describes is still correct — an anchor claiming a positive width, a CUE++ colour and a suppression at once is reported — but nothing pins it, so a later edit could drop it silently.",
    reason:
      "The focus rule requires a positive outline width and a CUE++ colour before it will call the ring held, and both suppression spellings set a zero width or none at all. So the clause that rejects them decides nothing on its own, and only a token carrying a suppression *alongside* a full ring reaches it. Pinning it means a fixture anchor that writes a contradiction no reviewer would write, which is a weaker thing to hold than the contract itself.",
    subject: "the focus-ring suppression clause is unpinned",
  },
  {
    channel: "class",
    consequence:
      "The oracle proves the declined forms silent for the tokens this repository writes, under the installed Tailwind. It does not prove them silent for every string that could be written. What it does guarantee is that the day one is written, the suite says so and names it — which is the property a hand-written alphabet could not offer at all.",
    reason:
      "The corpus is every whitespace-separated fragment of every string literal under `src`, `tests` and `test-fixtures` — deliberately wider than the scan's own reach, since a spelling nobody classified is likeliest where the scan does not look. Widening it to all possible strings is not a corpus, it is a proof, and Tailwind's candidate grammar is not published in a form one can be written against.",
    subject: "the compiler oracle runs over what this repository writes",
  },
  {
    channel: "class",
    consequence:
      "A class assembled at runtime is read only in its literal fragments, and a fragment that is not a whole utility is judged as nothing. The reskin's own components hand whole tokens to `cn()` rather than building them, so this is a limit on a style the codebase does not use — but it is the obvious way to smuggle a rung past the scan, and it is written down here rather than assumed away.",
    reason:
      "The rules read string literals because that is what survives hoisting a class into a constant or a helper. Reading a class that only exists once a substitution has run means evaluating the expression, and a scan that evaluates application code to decide what it forbids has stopped being a scan.",
    subject: "a class assembled across a template substitution",
  },
  {
    channel: "class",
    consequence:
      "No class-channel rule reads such a token: it lands in the unbalanced bucket, and every inert form is excluded from the rules. Whether anything then names it depends on the decline oracle recovering it from the corpus, and the corpus is matched line by line — so an apostrophe standing earlier on the same line opens a run of its own, the literal after it is read as that run's contents, and the token is never assembled to hand to the compiler at all. On a clean line the oracle does name it; sharing a line with a bare apostrophe it does not, and the token is then genuinely ungoverned and unannounced. Both halves are pinned by `reads its corpus line by line, so an apostrophe can hide a token`. No such token exists in this repository today: no `content-[` utility is written anywhere under `apps/web/src`.",
    reason:
      "The group tracker counts the four delimiters and does not read quotes, so a bracket written inside a quoted string counts as one and the arithmetic that decides the bucket is wrong for that token. Teaching it quoting means a second string-aware walker beside the CSS channel's — with the same bad-string recovery — inside the one channel whose declines are already licensed by the compiler rather than by that arithmetic. The narrower fix is to stop claiming the bucket means what it does not, which is what the form's own documentation now says.",
    subject: "a quoted bracket read as a group delimiter",
  },
];

/**
 * The two modules whose provider root may clone the document body, and so the
 * only two that may write `asChild`. Every other module using it is cloning an
 * element it did not create.
 */
export const providerBoundaryModules = [
  "apps/web/src/app/appearance-root.tsx",
  "apps/web/src/app/global-error.tsx",
] as const;

/**
 * The reviewed application `style` props, keyed by the module allowed to write
 * them. Each is recorded as the object literal the attribute's braces hold,
 * whitespace collapsed; the audit puts the attribute's name and braces back
 * before it compares. The name is left out because a text scan of this file
 * (the inline-style contract in `framework-boundaries.test.tsx`) would
 * otherwise read every entry here as a `style` prop of its own.
 *
 * Four, all RequestPort's mark (ruling 192, the owner's choice on 2026-10-10):
 * the app bar's wrapper that sets the mark beside the name, and the mark's own
 * fill, stroke and flex. No cue-ui component takes custom artwork in the theme's
 * accent, so the mark draws itself in `var(--cue-accent)`. Every value is a
 * literal written here, none is built from data, so the document-wide
 * `style-src-attr 'unsafe-inline'` directive gains no input it did not have.
 * Any other `style` attribute under `apps/web/src` is still a violation until
 * a reviewed tuple is recorded here.
 */
export const reviewedInlineStyleProps: Record<string, readonly string[]> = {
  "apps/web/src/components/app-shell.tsx": [
    '{ alignItems: "center", display: "inline-flex", gap: "0.5rem", }',
  ],
  "apps/web/src/components/request-port-mark.tsx": [
    "{ fill: accent }",
    "{ flexShrink: 0 }",
    "{ stroke: accent }",
  ],
};

/**
 * The modules allowed to write an `<svg>` element themselves (ruling 192).
 * Only RequestPort's mark, for the reason above: cue-ui's brand assets draw
 * CUE++'s own marks, and none takes custom artwork. Every other local `<svg>`
 * under `apps/web/src` is still a violation.
 */
export const reviewedLocalSvgModules: readonly string[] = [
  "apps/web/src/components/request-port-mark.tsx",
];

/** Hyphen-delimited word match, so `background-color` is a colour property. */
export function isForbiddenAllowlistProperty(property: string): boolean {
  const words = property.replace(/^--/u, "").split("-");

  return forbiddenAllowlistProperties.some((forbidden) =>
    words.includes(forbidden),
  );
}

export function isAllowedStyleTuple(
  selector: string,
  property: string,
  value: string,
  reviewed: readonly StyleAllowlistTuple[] = styleAllowlist,
): boolean {
  return reviewed.some(
    (tuple) =>
      tuple.selector === selector &&
      tuple.property === property &&
      tuple.value === value,
  );
}

export function isAllowedMediaThreshold(value: string): boolean {
  return (allowedMediaThresholds as readonly string[]).includes(value);
}
