# Native CUE++ audit fixtures

Good and bad inputs for `apps/web/src/test/native-cue-audit.ts`, kept outside
`apps/web/src` on purpose: the bad ones are *supposed* to contain a legacy
import, retired recipe classes, raw controls, a local SVG, an `asChild` clone,
an application `style` prop, a stylesheet that shadows published token names,
and a raw stylesheet in the wrong import order. Inside `src` they would be
typechecked, linted, swept up by the document-wide inline-style contract in
`src/app/framework-boundaries.test.tsx`, and — worst of all — scanned by the
unconditional production audit they exist to falsify.

They are typed by their own `tsconfig.json`, which extends the web project so
`@cueplusplus/ui` resolves exactly as it does in the application. Nothing here
ships.

`bad-legacy-surface.tsx` still imports `@requestport/ui`, and deliberately so.
Task 11 deleted that package, and the `legacy-import` rule was rewritten to read
the specifier a module writes rather than to resolve it: a prohibition that can
only fire while the forbidden thing still exists stops being a prohibition the
moment it is finally gone. The specifier no longer resolves to anything, which
is exactly the state the rule has to keep failing in.
