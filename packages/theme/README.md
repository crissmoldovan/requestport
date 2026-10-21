# @requestport/theme

The RequestPort palette. RequestPort owns it, and this package is where it
lives.

## Why it is here and not in the design system

It used to be `@cueplusplus/theme-requestport`, generated in `cueplusplus/cue-ui`
and installed from GitHub Packages. Two things were wrong with that. A brand is
the product's, not the design system's — cue-ui says so itself: "a theme is an
*application's* choice, and the library's job is to accept the ones it is handed
rather than to contain ten of them". And the arrangement failed in practice: two
RequestPort colours were measured below WCAG AA, the correction was merged
upstream as cue-ui#117, and it could not reach this application, because
publishing needs a release run and installing needs a registry download — both
refused while the CUE++ account is billing-locked.

The correction is in the sources here, and it took effect the moment this
package existed.

## What is hand-written, and what is generated

Hand-written: `theme.config.ts` and the two DTCG colour sources under `src/`.

Generated, and committed: `theme.css`, `variants.css`, `manifest.json`,
`index.js`, `index.d.ts`. They are committed because the application imports
them directly; nothing builds this package at install or deploy time.

## Changing a colour

```sh
pnpm --filter @requestport/theme run theme:generate
```

That runs the CUE++ theme tools over `src/`, re-measures every contrast pair,
and rewrites the five generated files. It refuses to emit a palette that fails a
required pair unless a waiver names it. `theme.test.ts` re-runs the same check
and fails if what is committed is not what the sources say — so a hand-edited
stylesheet is caught, not shipped.

The generator is `@cueplusplus/theme-tools`, installed from public npm. It runs
offline once installed; changing this theme needs no credential.

## Staying in line with CUE++

The file layout is cue-ui's, unchanged, so a future re-sync is a plain diff. The
manifest still `extends` `@cueplusplus/theme-base`, and `index.d.ts` still
augments that package's `ThemeRegistry`, which is what keeps `ThemeName` closed
over `"requestport"` in application code.

## One repository detail

The generated files and the DTCG sources are excluded from Biome in the root
`biome.json`. A formatter that reindents `theme.css` or `manifest.json` would
make them differ from what the generator emits, and `theme:check` — which
compares byte for byte — would then fail on a change nobody made. The
hand-written files here are formatted like the rest of the repository.
