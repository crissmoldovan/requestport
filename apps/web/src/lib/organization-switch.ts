import type { AdministrationActionState } from "./administration-actions.js";

/** Where a committed organization switch lands. */
export const ORGANIZATION_SWITCH_DESTINATION = "/";

/**
 * The one path a tenant switch is posted to.
 *
 * A switch commits the active-organization cookie, and a cookie written inside
 * a Server Action is never just a cookie: Next stamps `x-action-revalidated` on
 * every action response whose mutable cookies changed, and the client reducer
 * answers that header by evicting the prefetch cache and refetching the current
 * route tree into the document that is still open. That is precisely the client
 * transition the appearance contract forbids — the new tenant's theme would be
 * adopted from a provider prop while `<html>` still carried the outgoing
 * document's pre-paint stamp. A Route Handler's `Set-Cookie` never passes
 * through that machinery, so the endpoint is the contract rather than an
 * implementation detail, and the client's `window.location.assign` is the only
 * navigation a switch performs.
 */
export const ORGANIZATION_SWITCH_ENDPOINT = "/api/organization/switch";

/**
 * What the switcher reports when the endpoint itself never answered.
 *
 * A transport failure carries provider detail, so the control shows this fixed
 * sentence instead and the failure never reaches the document.
 *
 * The sentence is exported because it is the only thing a caller outside this
 * module can read a failed switch by: the control renders it in an alert and
 * nothing else about the page changes. The acceptance fixture waits on it
 * beside the page header for exactly that reason, and it imports this rather
 * than spelling it, so the two cannot come to disagree.
 */
export const ORGANIZATION_SWITCH_UNAVAILABLE =
  "Organization switching is temporarily unavailable.";

const SWITCH_UNAVAILABLE: AdministrationActionState = {
  code: "unexpected_error",
  message: ORGANIZATION_SWITCH_UNAVAILABLE,
  status: "error",
};

const SWITCH_UNREADABLE: AdministrationActionState = {
  code: "validation_failed",
  message: "Check the highlighted field and try again.",
  status: "error",
};

const SWITCH_FAILED: AdministrationActionState = {
  code: "unexpected_error",
  message: "RequestPort could not complete that action.",
  status: "error",
};

type SwitchErrorCode = Extract<
  AdministrationActionState,
  { status: "error" }
>["code"];

type TenantWriteField = NonNullable<
  Extract<AdministrationActionState, { status: "error" }>["field"]
>;

/**
 * The HTTP answer each redacted verdict earns. Anything unmapped is a rejected
 * request rather than a server fault, so it answers `400`.
 */
const statusByCode: Partial<Record<SwitchErrorCode, number>> = {
  forbidden: 403,
  rate_limited: 429,
  unauthenticated: 401,
  unexpected_error: 500,
};

const sameOriginPath = /^\/[\w\-.~!$&'()*+,;=:@%/?]*$/u;

/**
 * Whether a value is a same-origin absolute path, and nothing else.
 *
 * A destination crosses the server/client boundary and is handed straight to
 * `window.location.assign`, so anything carrying an authority, a scheme, or a
 * backslash is not one.
 */
export function isSameOriginDestination(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();

  return (
    candidate.length > 0 &&
    candidate.length <= 512 &&
    candidate.startsWith("/") &&
    !candidate.startsWith("//") &&
    !candidate.includes("\\") &&
    sameOriginPath.test(candidate)
  );
}

/** The same rule as a coercion: an unusable destination becomes the overview. */
export function sameOriginDestination(value: unknown): string {
  return isSameOriginDestination(value)
    ? value.trim()
    : ORGANIZATION_SWITCH_DESTINATION;
}

/**
 * The verdict as the browser is willing to act on it.
 *
 * The server already validated the destination; parsing it again here is the
 * runtime boundary doing its job, and a success whose destination did not
 * survive that parse is refused rather than coerced — the caller has nowhere
 * safe to send the document, so it reports the failure instead of navigating.
 *
 * Shared with the organization *creation* boundary next door, which is the same
 * cookie write posted to the same kind of Route Handler and therefore owes the
 * same reading. Only the sentence a transport failure shows differs, so that is
 * the one thing the caller supplies.
 */
export function tenantWriteVerdict(
  value: unknown,
  unavailable: AdministrationActionState,
): AdministrationActionState {
  if (typeof value !== "object" || value === null) return unavailable;
  const verdict = value as Record<string, unknown>;
  if (typeof verdict.message !== "string") return unavailable;

  if (verdict.status === "success") {
    return isSameOriginDestination(verdict.destination)
      ? {
          destination: verdict.destination,
          message: verdict.message,
          status: "success",
        }
      : unavailable;
  }

  if (verdict.status !== "error" || typeof verdict.code !== "string") {
    return unavailable;
  }

  // A named field travels with the failure, because that is the line the reader
  // sees: a creation rejected on its slug has to land on the slug control
  // rather than in the banner. The name is inert either way — the forms only
  // ever match it against the controls they themselves draw — so a string is
  // all this boundary has to insist on.
  return {
    code: verdict.code as SwitchErrorCode,
    ...(typeof verdict.field === "string"
      ? { field: verdict.field as TenantWriteField }
      : {}),
    message: verdict.message,
    status: "error",
  };
}

type SwitchFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Post a tenant switch and report what the endpoint decided.
 *
 * This is an ordinary same-origin `fetch`, deliberately: it produces no
 * `x-action-revalidated` header, so nothing about it can make the router
 * commit a new route tree into the document the caller is about to replace.
 */
export async function postOrganizationSwitch(
  organizationId: string,
  send: SwitchFetch = (input, init) => globalThis.fetch(input, init),
): Promise<AdministrationActionState> {
  const body = new FormData();
  body.set("organizationId", organizationId);

  try {
    const response = await send(ORGANIZATION_SWITCH_ENDPOINT, {
      body,
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "POST",
    });
    return tenantWriteVerdict(await response.json(), SWITCH_UNAVAILABLE);
  } catch {
    return SWITCH_UNAVAILABLE;
  }
}

/**
 * The HTTP answer for one redacted verdict. Shared with the creation boundary
 * for the same reason the reader above is: one cookie-writing tenant mutation
 * served off the action path, answered with a body rather than a redirect, so
 * the navigation stays the client's.
 */
export function tenantWriteResponse(verdict: AdministrationActionState) {
  return Response.json(verdict, {
    headers: { "cache-control": "no-store" },
    status:
      verdict.status === "success" ? 200 : (statusByCode[verdict.code] ?? 400),
  });
}

/**
 * The transport half of the switch: it owns the HTTP shape and nothing else.
 *
 * Every authorization, tenant, validation, and redaction decision stays in the
 * injected switch, so this handler can never widen what a switch is allowed to
 * do — and it answers with a body rather than a redirect, because a redirect
 * would hand the navigation back to the router instead of to the document.
 */
export function createOrganizationSwitchRoute({
  switchOrganization,
}: {
  switchOrganization: (
    formData: FormData,
  ) => Promise<AdministrationActionState>;
}) {
  return {
    async POST(request: Request): Promise<Response> {
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return tenantWriteResponse(SWITCH_UNREADABLE);
      }

      try {
        return tenantWriteResponse(await switchOrganization(formData));
      } catch {
        return tenantWriteResponse(SWITCH_FAILED);
      }
    },
  };
}
