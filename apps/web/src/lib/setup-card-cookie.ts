/**
 * Who has hidden the overview's setup card, and in which organization
 * (ruling 261).
 *
 * An HttpOnly cookie, because the server reads it before it renders `/`: a
 * hidden card is never drawn, so it cannot flash and then disappear, and no
 * script can read or forge it. Each entry names the organization and the
 * person, `organizationId:userId`, so on a browser two people share one
 * person's choice hides the card from no one else, and the same person still
 * sees it in another organization. It lives in one browser: hiding the card
 * there leaves it shown in every other browser the person signs in from.
 * Choosing this over a stored preference needed no migration; that trade is
 * the record's (track-j.md, ruling 261).
 */
export const SETUP_CARD_HIDDEN_COOKIE = "requestport.setup_card_hidden";

/** At most this many entries are kept, the newest last. */
export const setupCardHiddenEntriesKept = 20;

const oneYearSeconds = 365 * 24 * 60 * 60;

const organizationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function entryOf(userId: string, organizationId: string) {
  return `${organizationId}:${userId}`;
}

/**
 * The well-formed entries of a cookie value, in order, at most
 * `setupCardHiddenEntriesKept`: an organization id, a colon and a person.
 * Anything else in the value is dropped.
 */
function hiddenSetupCards(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split("|")
    .filter((entry) => {
      const separator = entry.indexOf(":");
      return (
        separator > 0 &&
        separator < entry.length - 1 &&
        organizationIdPattern.test(entry.slice(0, separator))
      );
    })
    .slice(-setupCardHiddenEntriesKept);
}

/** Whether this person hid the card in this organization. */
export function isSetupCardHidden(
  value: string | undefined,
  userId: string,
  organizationId: string,
): boolean {
  return hiddenSetupCards(value).includes(entryOf(userId, organizationId));
}

/**
 * The cookie's next value, with this person's card in this organization
 * hidden or shown and every other entry kept; the empty string when none is
 * left.
 */
export function withSetupCardHidden(
  value: string | undefined,
  userId: string,
  organizationId: string,
  hidden: boolean,
): string {
  const entry = entryOf(userId, organizationId);
  const others = hiddenSetupCards(value).filter((kept) => kept !== entry);
  return (hidden ? [...others, entry] : others)
    .slice(-setupCardHiddenEntriesKept)
    .join("|");
}

type CookieStore = {
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      maxAge: number;
      path: string;
      sameSite: "lax";
      secure: boolean;
    },
  ): void;
};

/**
 * Writes the value for a year, or expires the cookie when it is empty.
 * `Secure` only in production, with the environment read off an object as
 * `writeCurrentOrganizationCookie` reads it (organization-cookie.ts says
 * what a build-time constant there cost on WebKit).
 */
export function writeSetupCardCookie(
  cookieStore: CookieStore,
  value: string,
  env: { NODE_ENV?: string } = process.env,
) {
  cookieStore.set(SETUP_CARD_HIDDEN_COOKIE, value, {
    httpOnly: true,
    maxAge: value ? oneYearSeconds : 0,
    path: "/",
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
  });
}
