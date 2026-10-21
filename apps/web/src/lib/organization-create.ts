import type { AdministrationActionState } from "./administration-actions.js";
import {
  tenantWriteResponse,
  tenantWriteVerdict,
} from "./organization-switch.js";

/** Where a committed organization creation lands: the new tenant's overview. */
export const ORGANIZATION_CREATE_DESTINATION = "/";

/**
 * The one path an organization creation is posted to.
 *
 * Creating an organization makes it the current tenant, so it writes the same
 * active-organization cookie a switch writes — and inherits the same hazard.
 * Next stamps `x-action-revalidated` on every action response whose mutable
 * cookies changed, and the client reducer answers that header by evicting the
 * prefetch cache and refetching the current route tree into the document that
 * is still open. The creation went further still: it called
 * `revalidatePath("/", "layout")` and `redirect("/")` outright, so the router
 * took the SPA path and adopted the new tenant's inherited appearance triple
 * during a client transition, while `<html>` still carried the outgoing
 * document's pre-paint stamp.
 *
 * A Route Handler's `Set-Cookie` never passes through that machinery, so the
 * endpoint is the contract rather than an implementation detail — the same
 * ruling commit 646f693 made for the switch, applied to the other write that
 * changes which tenant the next document resolves.
 */
export const ORGANIZATION_CREATE_ENDPOINT = "/api/organization/create";

/**
 * What the form reports when the endpoint itself never answered.
 *
 * A transport failure carries provider detail, so the control shows this fixed
 * sentence instead and the failure never reaches the document. It is the same
 * sentence the form showed when no action was wired at all, because it answers
 * the same question for the reader: nothing was created, try again.
 */
const CREATE_UNAVAILABLE: AdministrationActionState = {
  code: "unexpected_error",
  message: "This action is temporarily unavailable.",
  status: "error",
};

const CREATE_UNREADABLE: AdministrationActionState = {
  code: "validation_failed",
  message: "Check the highlighted field and try again.",
  status: "error",
};

const CREATE_FAILED: AdministrationActionState = {
  code: "unexpected_error",
  message: "RequestPort could not complete that action.",
  status: "error",
};

type CreateFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Post an organization creation and report what the endpoint decided.
 *
 * This is an ordinary same-origin `fetch`, deliberately: it produces no
 * `x-action-revalidated` header, so nothing about it can make the router commit
 * a new route tree into the document the caller is about to replace.
 */
export async function postOrganizationCreate(
  formData: FormData,
  send: CreateFetch = (input, init) => globalThis.fetch(input, init),
): Promise<AdministrationActionState> {
  try {
    const response = await send(ORGANIZATION_CREATE_ENDPOINT, {
      body: formData,
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "POST",
    });
    return tenantWriteVerdict(await response.json(), CREATE_UNAVAILABLE);
  } catch {
    return CREATE_UNAVAILABLE;
  }
}

/**
 * The transport half of the creation: it owns the HTTP shape and nothing else.
 *
 * Every authentication, validation, commit and redaction decision stays in the
 * injected action, so this handler can never widen what a creation is allowed
 * to do — and it answers with a body rather than a redirect, because a redirect
 * would hand the navigation back to the router instead of to the document.
 */
export function createOrganizationCreateRoute({
  createOrganization,
}: {
  createOrganization: (
    formData: FormData,
  ) => Promise<AdministrationActionState>;
}) {
  return {
    async POST(request: Request): Promise<Response> {
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return tenantWriteResponse(CREATE_UNREADABLE);
      }

      try {
        return tenantWriteResponse(await createOrganization(formData));
      } catch {
        return tenantWriteResponse(CREATE_FAILED);
      }
    },
  };
}
