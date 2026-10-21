/**
 * What `next dev` mounts into every document it serves.
 *
 * The development server injects its own devtools chrome into the page — an
 * indicator, and on a failure the error overlay — and both are ordinary
 * elements in the document the acceptance lanes then measure. They are the
 * tool's, not the product's, and holding them to this application's rules
 * reports the tool's layout and the tool's focus order as findings against the
 * application.
 *
 * That has already cost this suite once in each direction. The focus driver
 * refuses the overlay's own focusable host, and the overflow assertion did not:
 * on the one case that makes the development server open its error overlay, the
 * document measured wider than the viewport by the overlay's own width, and
 * nothing the application rendered was outside it.
 *
 * The names are the package's rather than this suite's, and
 * `src/test/development-overlay.test.ts` reads them back out of the installed
 * `next` — which describes exactly this nesting: under the App Router the
 * portal is mounted inside a script element carrying the attribute below, and
 * under the Pages Router it sits directly in the body. An upgrade that renames
 * either fails there rather than quietly measuring the overlay again.
 */
export const developmentOverlaySelectors = [
  "script[data-nextjs-dev-overlay]",
  "nextjs-portal",
] as const;
