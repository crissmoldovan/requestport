/**
 * Minting the account menu's render-context token on demand.
 *
 * The token itself is described in `appearance-form-context.ts`: it records
 * which actor and tenant the form in the reader's hand was rendered for, so a
 * stale document is refused rather than written into whichever context happens
 * to be current now. It carries no session or credential material, and knowing
 * it grants nothing.
 *
 * What this module fixes is *when* the menu's token is minted. The account menu
 * is part of the persistent app chrome, and the App Router keeps a shared layout
 * across soft navigations — so a token minted in the layout body aged with the
 * tab, not with the page. Past the fifteen-minute window the first Apply came
 * back `context_conflict`, whose only remedy is the page reload the menu exists
 * to avoid. Minting when the panel opens puts the recorded moment back where the
 * token's own definition says it belongs: when the form reaches the reader.
 *
 * The guarantee is untouched. The mint authenticates, binds the actor it just
 * authenticated, and the write still verifies the sealed claims against a
 * freshly authenticated context, still compares expected versions, and still
 * replays by idempotency key. Nothing here re-mints *after* a rejection, which
 * would be the one shortcut that would hand a form rendered for one actor a
 * token for another.
 *
 * The other half is knowing when the token already in hand is spent. A mint
 * that fails, or that outruns its bound, answers `null` — "keep the token you
 * have" — and on a tab past the fifteen minutes the token it has is one the
 * server is already certain to refuse. So this module also reads the issue time
 * out of a held token, which is the one thing about it a client is in a
 * position to decide.
 */

/** The one path the account menu mints its render context from. */
export const APPEARANCE_RENDER_CONTEXT_ENDPOINT =
  "/api/appearance/render-context";

/**
 * The longest token this boundary will hand a form.
 *
 * It is `appearanceFormContextMaxLength`, written out rather than imported:
 * that module opens `node:crypto`, and this one is reached from a client
 * component. The suite pins the two numbers equal, so anything longer than the
 * verifier would even read is refused here instead of being submitted.
 */
export const appearanceRenderContextMaxLength = 512;

/**
 * How long the panel waits for a mint before falling back.
 *
 * A mint that never answers must not be able to hold the control: the fallback
 * is the token the document was rendered with, which is exactly the behaviour
 * this replaced, rather than an Apply button that can no longer be pressed.
 */
export const appearanceRenderContextTimeoutMs = 5_000;

/**
 * The lifetime the verifier gives a rendered form.
 *
 * It is `appearanceFormContextTtlSeconds`, written out rather than imported for
 * the same reason the length above is: that module opens `node:crypto`, and
 * this one is reached from a client component. The suite pins the two numbers
 * equal.
 */
export const appearanceRenderContextTtlSeconds = 900;

/**
 * How much of that lifetime has to be left for a held token to be worth
 * spending.
 *
 * A submission has to travel, and a token that expires on the way is refused as
 * firmly as one that expired an hour ago. Giving up on the last half-minute
 * costs a mint the panel was going to make anyway and saves the reader a round
 * trip whose only outcome is "reload the page and try again".
 */
export const appearanceRenderContextExpiryMarginSeconds = 30;

/** The only token version this boundary knows how to read. */
const renderContextVersion = "v1";

type RenderContextFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

function readToken(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const token = (value as Record<string, unknown>).token;

  return typeof token === "string" &&
    token.length > 0 &&
    token.length <= appearanceRenderContextMaxLength
    ? token
    : null;
}

/**
 * The issue time sealed into a token, in seconds, or `null` if this side cannot
 * read one.
 *
 * The payload is base64url JSON and every holder of a token can read it, so
 * reading it here reveals nothing and — just as importantly — decides nothing:
 * the signature, the actor and the tenant are checked by the server and only by
 * the server. This is the timestamp, and nothing else, on a token the client
 * already holds.
 */
function issuedAtSeconds(encoded: string): number | null {
  let payload: unknown;
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    payload = JSON.parse(
      atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")),
    );
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const issuedAt = (payload as Record<string, unknown>).t;

  return typeof issuedAt === "number" && Number.isSafeInteger(issuedAt)
    ? issuedAt
    : null;
}

/**
 * Whether a token the tab is already holding is still worth submitting.
 *
 * `false` is never a verdict about trust — an unreadable token may be perfectly
 * valid and simply of a shape this side does not parse. It is a verdict about
 * *pointlessness*: a submission this boundary cannot see a live issue time on
 * is one it should mint again rather than spend, because the alternative is to
 * spend it and be told to reload the page.
 */
export function appearanceRenderContextUsable(
  token: unknown,
  now: number = Date.now(),
): boolean {
  const remaining = appearanceRenderContextRemainingMs(token, now);

  return remaining !== null && remaining > 0;
}

/**
 * How much longer a held token is worth submitting for, in milliseconds, or
 * `null` when this side cannot read an issue time out of it at all.
 *
 * A holder that only asks *whether* a token is usable has to ask again to find
 * out, which means either polling or never asking again — and a panel that
 * never asks again hands Apply a token that expired while the reader was
 * reading. The deadline is knowable exactly, so it is answered exactly, and
 * whoever holds the token can wait for that moment and no other.
 *
 * `null` is the same verdict `false` is: not a judgement about trust, but about
 * this side's ability to decide. A token of a shape this boundary does not
 * parse may be perfectly valid, and nothing here refuses it.
 */
export function appearanceRenderContextRemainingMs(
  token: unknown,
  now: number = Date.now(),
): number | null {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > appearanceRenderContextMaxLength
  ) {
    return null;
  }

  const [version, encoded, signature] = token.split(".");
  if (
    version !== renderContextVersion ||
    !encoded ||
    !signature ||
    token.split(".").length !== 3
  ) {
    return null;
  }

  const issuedAt = issuedAtSeconds(encoded);
  if (issuedAt === null) return null;

  // Only expiry. A token whose issue time is *ahead* of this clock is a
  // disagreement between two clocks, which is the server's to judge — refusing
  // it here would mint forever against a server that is merely fast.
  const spentAt =
    (issuedAt +
      appearanceRenderContextTtlSeconds -
      appearanceRenderContextExpiryMarginSeconds) *
    1_000;

  return spentAt - now;
}

async function mint(send: RenderContextFetch): Promise<string | null> {
  try {
    const response = await send(APPEARANCE_RENDER_CONTEXT_ENDPOINT, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "POST",
    });
    return readToken(await response.json());
  } catch {
    return null;
  }
}

/**
 * A render context minted for the signed-in actor, or `null` if the mint could
 * not answer in time. `null` means "keep the token you already have": the
 * caller is never left without one.
 */
export async function fetchPersonalAppearanceRenderContext(
  send: RenderContextFetch = (input, init) => globalThis.fetch(input, init),
  timeoutMs: number = appearanceRenderContextTimeoutMs,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([mint(send), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The transport half of the mint: it owns the HTTP shape and nothing else.
 *
 * The actor is resolved by the injected mint from the authenticated request, so
 * this handler cannot be asked to seal a context for anybody else, and a failed
 * mint answers with no token rather than with the reason it failed.
 */
export function createAppearanceRenderContextRoute({
  mintPersonalContext,
}: {
  mintPersonalContext: () => Promise<string>;
}) {
  return {
    async POST(): Promise<Response> {
      try {
        return Response.json(
          { token: await mintPersonalContext() },
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        return Response.json(
          { token: null },
          { headers: { "cache-control": "no-store" }, status: 503 },
        );
      }
    },
  };
}
