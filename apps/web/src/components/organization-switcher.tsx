"use client";

import { Select } from "@cueplusplus/ui/forms";
import { Stack } from "@cueplusplus/ui/layout";
import { Dialog } from "@cueplusplus/ui/overlays";
import { Chip } from "@cueplusplus/ui/primitives";
import type { OrganizationAccess } from "@requestport/domain";
import { useState } from "react";

import { postOrganizationSwitch } from "../lib/organization-switch.js";
import { OrganizationForm } from "./administration-forms.js";

const emptyOption = { label: "No organization", value: "" };

/**
 * The entry that opens creation rather than switching to anything.
 *
 * It shares a list with organization identifiers, which are UUIDs, so it is a
 * word no identifier could equal — a collision would switch to an organization
 * while a person meant to make one.
 */
export const CREATE_ORGANIZATION_OPTION = "create-organization";

const createOption = {
  label: "Create organization…",
  value: CREATE_ORGANIZATION_OPTION,
};

/**
 * The current-organization control.
 *
 * It lives in the shell's bar rather than in a form of its own, so section 7's
 * toolbar exception applies: the surrounding chrome names it, and the control
 * carries `aria-label` instead of a visible `FieldLabel`.
 *
 * A switch is a tenant change, so it ends in a full-document navigation to the
 * destination the server validated. That is the whole point: the next document
 * resolves the new organization's appearance defaults on the server, before
 * paint, rather than adopting them during a client transition. It is posted to
 * a Route Handler rather than dispatched as a Server Action for the same
 * reason — an action that writes a cookie makes the router refetch and commit
 * the current route tree into this document, which is the transition being
 * avoided.
 */
export function OrganizationSwitcher({
  currentOrganization,
  organizations,
}: {
  currentOrganization: OrganizationAccess | null;
  organizations: OrganizationAccess[];
}) {
  const currentId = currentOrganization?.id ?? "";
  const [selected, setSelected] = useState(currentId);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);

  async function switchTo(next: string | null) {
    if (next === CREATE_ORGANIZATION_OPTION) {
      // Not a tenant change: the control goes back to where the person is, and
      // the form decides what happens next.
      setSelected(currentId);
      setCreating(true);
      return;
    }

    const organizationId = next ?? currentId;
    setSelected(organizationId);
    if (organizationId === "" || organizationId === currentId) return;

    setFailure(null);
    setPending(true);
    const verdict = await postOrganizationSwitch(organizationId);
    if (verdict.status === "success" && verdict.destination) {
      // The document is being replaced. The control deliberately stays pending
      // so a second choice cannot race the navigation out of this document.
      window.location.assign(verdict.destination);
      return;
    }

    setFailure(verdict.status === "error" ? verdict.message : null);
    setSelected(currentId);
    setPending(false);
  }

  // Creation is offered last and always — including to an account with no
  // organization, for which every other entry in this list is inert. That
  // account is exactly the one that needs it, and until now the only way to
  // reach the form was to have no organization *and* land on the setup page.
  const options = [
    ...(organizations.length === 0
      ? [emptyOption]
      : organizations.map((organization) => ({
          label: organization.name,
          value: organization.id,
        }))),
    createOption,
  ];

  // A tenant name is arbitrary text and the bar is one row, so the control
  // needs a measure of its own: without one the trigger grows to fit the name
  // and pushes the search and the account menu out of the viewport — off a
  // frame that clips rather than scrolls, so nothing looks wrong and nothing is
  // reachable. `Select` already truncates its value; this is the width it
  // truncates within, and the retired `.organization-select` recipe capped
  // itself for the same reason.
  return (
    <Stack align="center" className="min-w-0" direction="row" gap={2}>
      <Select
        aria-label="Current organization"
        className="max-w-24 md:max-w-40"
        disabled={pending}
        items={options}
        onValueChange={(next) => void switchTo(next)}
        size="sm"
        value={selected}
      />
      {failure === null ? null : (
        <span role="alert">
          <Chip tone="danger">{failure}</Chip>
        </span>
      )}
      <Dialog.Root onOpenChange={setCreating} open={creating}>
        <Dialog.Content>
          <Dialog.Title>Create organization</Dialog.Title>
          <Dialog.Description>
            An organization is the tenant and authorization boundary for
            projects, requests, members, and agents.
          </Dialog.Description>
          <OrganizationForm />
        </Dialog.Content>
      </Dialog.Root>
    </Stack>
  );
}
