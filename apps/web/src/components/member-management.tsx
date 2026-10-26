"use client";

import { Select } from "@cueplusplus/ui/forms";
import { TwoStepButton } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { AlertDialog, DropdownMenu, useToast } from "@cueplusplus/ui/overlays";
import { Button, Chip, IconButton } from "@cueplusplus/ui/primitives";
import type {
  OrganizationMember,
  PendingInvitation,
} from "@requestport/domain";
import { Ellipsis, Send, UserX } from "lucide-react";
import {
  type KeyboardEvent,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";

import type { MemberActionState } from "../app/(app)/settings/members/action-state.js";
import { initialMemberActionState } from "../app/(app)/settings/members/action-state.js";
import { actionBannerMessage } from "../lib/action-field-issues.js";

/**
 * Organization access, on native CUE++ controls (ruling 259).
 *
 * Every control here sits in a table row whose column heading already names
 * it, which is the one case §7 lets a control carry an `aria-label` instead of
 * its own visible field. A role is changed by choosing it: the choice is sent
 * through the same role action at once, and a toast confirms it, so there is
 * no separate save. A letter typed on the closed control chooses nothing
 * (`ignoreClosedTypeahead`), so a choice is always one made in the open
 * listbox. Revoking a person's access sits in the row's menu and asks
 * for confirmation in an `AlertDialog` first; it is reversible (the person can
 * be invited again), but a menu item has nowhere to arm in place. Revoking an
 * invitation still arms in place through `TwoStepButton`, because it has a
 * row of its own to do it in. Resending one (ruling 260) is a single press
 * beside it: it re-issues the invitation and sends its email again, which
 * takes nothing from anyone, and the button holds while the press is in
 * flight.
 */

type Action = (
  state: MemberActionState,
  data: FormData,
) => Promise<MemberActionState>;

const roleLabels = { admin: "Admin", member: "Member", owner: "Owner" };

const roleOptions = [
  { label: roleLabels.member, value: "member" },
  { label: roleLabels.admin, value: "admin" },
];

function labelOf(role: string) {
  return roleLabels[role as keyof typeof roleLabels] ?? role;
}

/** A refused change: a tone chip and a message, never colour alone. */
function Failure({ state }: { state: MemberActionState }) {
  const failure = actionBannerMessage(state);
  if (!failure) return null;

  return (
    <div role="alert">
      <Stack align="center" direction="row" gap={2}>
        <Chip tone="danger">Error</Chip>
        <span>{failure}</span>
      </Stack>
    </div>
  );
}

/** The live toast manager, read through a ref when an answer arrives. */
function useToastRef() {
  const toast = useToast();
  const ref = useRef(toast);
  ref.current = toast;
  return ref;
}

/**
 * The action, with a success confirmed in a toast as soon as it answers.
 *
 * Raised from the answer rather than from an effect on the state it leaves.
 * A revocation's row leaves the page in the same answer: the action
 * revalidates `/settings/members`, which lists active members and unrevoked
 * invitations only, so the component holding the state unmounts before an
 * effect of its own could run. The toast's provider is the console's one,
 * mounted by the shell around every page (`ConsoleToasts`), and outlives the
 * row and the page.
 */
function useConfirmedAction(
  action: Action,
  confirmation: (answer: MemberActionState, data: FormData) => string,
): Action {
  const toast = useToastRef();
  return async (previous, data) => {
    const answer = await action(previous, data);
    if (answer.status === "success") {
      const title = confirmation(answer, data);
      if (title) toast.current.add({ title, tone: "ok" });
    }
    return answer;
  };
}

/**
 * Keeps a letter typed on the closed role control from choosing a role.
 *
 * Base UI's `Select` matches a printable key typed on its closed trigger to an
 * option and sets the value at once, without opening (typeahead, through
 * `SelectRoot`'s `onMatch`), and cue-ui's `Select` hands `onValueChange` the
 * value alone, without Base UI's reason, so the control cannot tell that from
 * a choice. Here a choice is a write — "o" would make the person an owner —
 * so such a key is stopped, in the capture phase, before Base UI's handler on
 * the trigger sees it. Enter and the arrow keys are not single printable keys,
 * and Space is let through: each opens the listbox, where typing only moves
 * the highlight and Enter or a press chooses. A key held with Alt, Control or
 * Meta is a shortcut, not typeahead, and passes too.
 */
function ignoreClosedTypeahead(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  if (target.dataset.slot !== "select-trigger") return;
  if (target.getAttribute("aria-expanded") === "true") return;
  if (event.key.length !== 1 || event.key === " ") return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
}

/**
 * A person's role, changed by choosing another one.
 *
 * An admin cannot change an owner, so an owner's row reads as a chip for them.
 * A refused change puts the choice back to the role the server still holds,
 * and says why beside the control. A saved one is confirmed in a toast.
 */
export function MemberRoleControl({
  action,
  actorRole,
  idempotencyKey,
  member,
}: {
  action: Action;
  actorRole: "owner" | "admin";
  idempotencyKey: string;
  member: OrganizationMember;
}) {
  const [state, dispatch, pending] = useActionState(
    useConfirmedAction(
      action,
      (_answer, data) =>
        `${member.name} is now ${labelOf(String(data.get("role")))}.`,
    ),
    initialMemberActionState,
  );
  const [role, setRole] = useState<string>(member.role);
  const answered = useRef<MemberActionState>(state);

  // A refreshed page can carry a role somebody else just set.
  useEffect(() => {
    setRole(member.role);
  }, [member.role]);

  useEffect(() => {
    if (answered.current === state) return;
    answered.current = state;
    if (state.status === "error") setRole(member.role);
  }, [member.role, state]);

  if (member.role === "owner" && actorRole !== "owner") {
    return <Chip tone="neutral">{labelOf(member.role)}</Chip>;
  }

  return (
    <Stack direction="column" gap={2} onKeyDownCapture={ignoreClosedTypeahead}>
      <Select
        aria-label={`Role for ${member.name}`}
        disabled={pending}
        items={
          actorRole === "owner"
            ? [...roleOptions, { label: roleLabels.owner, value: "owner" }]
            : roleOptions
        }
        onValueChange={(next) => {
          const value = String(next ?? "");
          if (!value || value === role) return;
          setRole(value);
          const data = new FormData();
          data.set("userId", member.userId);
          data.set("idempotencyKey", idempotencyKey);
          data.set("expectedVersion", String(member.version));
          data.set("role", value);
          data.set("status", "active");
          startTransition(() => dispatch(data));
        }}
        size="sm"
        value={role}
      />
      <Failure state={state} />
    </Stack>
  );
}

/**
 * The row's menu: revoking the person's access, after a confirmation.
 *
 * Drawn only where the actor may revoke: never on their own row, and on an
 * owner's row only for an owner.
 */
export function MemberActionsMenu({
  action,
  idempotencyKey,
  member,
}: {
  action: Action;
  idempotencyKey: string;
  member: OrganizationMember;
}) {
  const [state, formAction, revoking] = useActionState(
    useConfirmedAction(action, (answer) => answer.message),
    initialMemberActionState,
  );
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  return (
    <form action={formAction} ref={form}>
      <Stack align="end" direction="column" gap={2}>
        <input name="userId" type="hidden" value={member.userId} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <input name="expectedVersion" type="hidden" value={member.version} />
        <input name="role" type="hidden" value={member.role} />
        <input name="status" type="hidden" value="revoked" />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            render={
              <IconButton
                aria-label={`More for ${member.name}`}
                disabled={revoking}
                icon={Ellipsis}
                size="sm"
                type="button"
              />
            }
          />
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item
              icon={UserX}
              onClick={() => setConfirming(true)}
              tone="danger"
            >
              Revoke access…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <AlertDialog.Root onOpenChange={setConfirming} open={confirming}>
          <AlertDialog.Content>
            <AlertDialog.Title>
              Revoke {member.name}’s access?
            </AlertDialog.Title>
            <AlertDialog.Description>
              They stop being a member of this organization at once. You can
              invite them again later.
            </AlertDialog.Description>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Keep access</AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => form.current?.requestSubmit()}
                tone="danger"
              >
                Revoke access
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
        <Failure state={state} />
      </Stack>
    </form>
  );
}

export function RevokeInvitationForm({
  action,
  idempotencyKey,
  invitation,
}: {
  action: Action;
  idempotencyKey: string;
  invitation: PendingInvitation;
}) {
  const [state, formAction, pending] = useActionState(
    useConfirmedAction(action, (answer) => answer.message),
    initialMemberActionState,
  );
  const form = useRef<HTMLFormElement>(null);

  return (
    <form action={formAction} ref={form}>
      <Stack align="end" direction="column" gap={2}>
        <input name="invitationId" type="hidden" value={invitation.id} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <input
          name="expectedVersion"
          type="hidden"
          value={invitation.version}
        />
        {/* Reversible — the address can simply be invited again. */}
        <TwoStepButton
          disabled={pending}
          onConfirm={() => form.current?.requestSubmit()}
          size="sm"
        >
          Revoke invitation
        </TwoStepButton>
        <Failure state={state} />
      </Stack>
    </form>
  );
}

/**
 * Resends a pending invitation (ruling 260): one press posts the invitation's
 * id, the form's own key and the version the page read, and a resend that
 * lands is confirmed in a toast. A refusal is said beside the control.
 */
export function ResendInvitationForm({
  action,
  idempotencyKey,
  invitation,
}: {
  action: Action;
  idempotencyKey: string;
  invitation: PendingInvitation;
}) {
  const [state, formAction, pending] = useActionState(
    useConfirmedAction(action, (answer) => answer.message),
    initialMemberActionState,
  );

  return (
    <form action={formAction}>
      <Stack align="end" direction="column" gap={2}>
        <input name="invitationId" type="hidden" value={invitation.id} />
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <input
          name="expectedVersion"
          type="hidden"
          value={invitation.version}
        />
        <Button
          disabled={pending}
          icon={Send}
          size="sm"
          type="submit"
          variant="secondary"
        >
          Resend invitation
        </Button>
        <Failure state={state} />
      </Stack>
    </form>
  );
}
