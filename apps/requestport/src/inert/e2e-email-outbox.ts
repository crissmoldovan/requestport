/**
 * The inert stand-in for auth's magic-link outbox (Plan 13, H.7; ruling
 * 174). requestport's self-host Next build, which `@requestport/web`
 * carries, puts this module where the real one would be
 * (`../web/test-seams.ts`). Here the E2E predicate is false for every
 * environment, and capturing, reading or clearing a link refuses. Nothing
 * else of the real module is here.
 */

type MagicLinkEntry = Readonly<{
  email: string;
  url: string;
}>;

/** Never true: this build has no E2E mode, whatever the environment says. */
export function isE2EEmailMode(_env?: unknown): boolean {
  return false;
}

function refuse(): never {
  throw new Error("This build of RequestPort has no test outbox.");
}

export function captureE2EMagicLink(
  _input: MagicLinkEntry,
  _env?: unknown,
): void {
  refuse();
}

export function readE2EMagicLink(
  _email: string,
  _env?: unknown,
): MagicLinkEntry | null {
  return refuse();
}

export function clearE2EMagicLinks(_env?: unknown): void {
  refuse();
}
