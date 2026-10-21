"use client";

import { Select } from "@cueplusplus/ui/forms";
import { TwoStepButton } from "@cueplusplus/ui/instruments";
import { Stack } from "@cueplusplus/ui/layout";
import { Button, Chip } from "@cueplusplus/ui/primitives";
import type {
  OrganizationMember,
  PendingInvitation,
} from "@requestport/domain";
import { useActionState, useRef } from "react";

import type { MemberActionState } from "../app/(app)/settings/members/action-state.js";
import { initialMemberActionState } from "../app/(app)/settings/members/action-state.js";
import { actionBannerMessage } from "../lib/action-field-issues.js";

/**
 * Organization access, on native CUE++ controls.
 *
 * Both controls live in a table row whose column heading already names them,
 * which is the one case §7 lets a control carry an `aria-label` instead of its
 * own visible field. Revoking is destructive but reversible — the person can be
 * granted access again — so §6.2 arms it in place through `TwoStepButton`
 * rather than opening a modal for something an owner does routinely.
 */

type Action = (
  state: MemberActionState,
  data: FormData,
) => Promise<MemberActionState>;

const roleOptions = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

/** The fixed result line: a tone chip and a message, never colour alone. */
function Status({ state }: { state: MemberActionState }) {
  const failure = actionBannerMessage(state);
  if (failure) {
    return (
      <div role="alert">
        <Stack align="center" direction="row" gap={2}>
          <Chip tone="danger">Error</Chip>
          <span>{failure}</span>
        </Stack>
      </div>
    );
  }
  if (state.status !== "success" || !state.message) return null;

  return (
    <div role="status">
      <Stack align="center" direction="row" gap={2}>
        <Chip tone="ok">Done</Chip>
        <span>{state.message}</span>
      </Stack>
    </div>
  );
}

export function MemberManagementForm({
  action,
  actorRole,
  currentUserId,
  idempotencyKey,
  member,
}: {
  action: Action;
  actorRole: "owner" | "admin";
  currentUserId: string;
  idempotencyKey: string;
  member: OrganizationMember;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialMemberActionState,
  );
  const [revokeState, revokeFormAction, revoking] = useActionState(
    action,
    initialMemberActionState,
  );
  const revokeForm = useRef<HTMLFormElement>(null);
  if (member.role === "owner" && actorRole !== "owner") return <>—</>;
  return (
    <Stack direction="column" gap={2}>
      <form action={formAction}>
        <Stack align="center" direction="row" gap={2} wrap>
          <input name="userId" type="hidden" value={member.userId} />
          <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
          <input name="expectedVersion" type="hidden" value={member.version} />
          <input name="status" type="hidden" value="active" />
          <Select
            aria-label={`Role for ${member.name}`}
            defaultValue={member.role}
            items={
              actorRole === "owner"
                ? [...roleOptions, { label: "Owner", value: "owner" }]
                : roleOptions
            }
            name="role"
            size="sm"
          />
          <Button
            disabled={pending}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {pending ? "Saving…" : "Save role"}
          </Button>
        </Stack>
      </form>
      {member.userId === currentUserId ? null : (
        <form action={revokeFormAction} ref={revokeForm}>
          <input name="userId" type="hidden" value={member.userId} />
          <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
          <input name="expectedVersion" type="hidden" value={member.version} />
          <input name="role" type="hidden" value={member.role} />
          <input name="status" type="hidden" value="revoked" />
          {/* Reversible — the person can be granted access again — so the
              confirmation arms in place rather than opening a modal. */}
          <TwoStepButton
            disabled={revoking}
            onConfirm={() => revokeForm.current?.requestSubmit()}
            size="sm"
          >
            Revoke access
          </TwoStepButton>
        </form>
      )}
      <Status state={state} />
      <Status state={revokeState} />
    </Stack>
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
    action,
    initialMemberActionState,
  );
  const form = useRef<HTMLFormElement>(null);
  return (
    <form action={formAction} ref={form}>
      <Stack direction="column" gap={2}>
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
        <Status state={state} />
      </Stack>
    </form>
  );
}
