"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PasswordInput,
} from "@cueplusplus/ui/forms";
import { CodeBlock } from "@cueplusplus/ui/instruments";
import { Collapsible, Stack } from "@cueplusplus/ui/layout";
import { Button, Separator } from "@cueplusplus/ui/primitives";
import { authClient } from "@requestport/auth/client";
import type { SignInMethods } from "@requestport/config/sign-in-methods";
import { GitBranch, KeyRound, Mail } from "lucide-react";
import { Fragment, type ReactNode, useActionState } from "react";

const neutralSuccessMessage =
  "If that address can sign in, a link is on its way.";
export const AUTH_SUCCESS_PATH = "/";

type MagicLinkStatus = "idle" | "sending" | "sent";

export function getMagicLinkStatusMessage(status: MagicLinkStatus) {
  return status === "sent" ? neutralSuccessMessage : null;
}

async function requestMagicLink(
  landing: string,
  _previous: boolean,
  formData: FormData,
) {
  const email = formData.get("email");
  if (typeof email !== "string") return false;

  try {
    await authClient.signIn.magicLink({
      email,
      callbackURL: landing,
      errorCallbackURL: "/auth-error",
      newUserCallbackURL: landing,
    });
  } catch {
    // A provider failure is deliberately indistinguishable from a delivered
    // link: telling the two apart would turn this form into an address oracle,
    // and the failing detail must never reach the page.
  }

  return true;
}

const credentialMismatchMessage = "That email and credential do not match.";

async function signInWithCredential(
  landing: string,
  _previous: boolean,
  formData: FormData,
) {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string") return false;

  try {
    // With a callback address the client follows the answer's redirect itself,
    // exactly as it does for GitHub; a refusal comes back as `error`.
    const result = await authClient.signIn.email({
      email,
      password,
      callbackURL: landing,
    });
    return Boolean(result?.error);
  } catch {
    return true;
  }
}

/**
 * The local owner credential: an address and the secret that
 * `requestport-operator bootstrap-owner --local-credential`, or a self-host's
 * first `requestport start`, printed. A refusal says only
 * that the pair did not match — Better Auth gives the same answer for an
 * unknown address and a wrong credential, and so does this — and says it on
 * the credential's own field.
 */
function LocalCredentialForm({
  landing,
  primary,
}: {
  landing: string;
  /** Whether this is the card's first way in, and so its primary button. */
  primary: boolean;
}) {
  const [refused, submit, pending] = useActionState(
    signInWithCredential.bind(null, landing),
    false,
  );

  return (
    <form action={submit}>
      <Stack direction="column" gap={3}>
        <Field name="email">
          <FieldLabel>Email</FieldLabel>
          <Input
            autoComplete="username"
            name="email"
            placeholder="you@example.com"
            required
            size="lg"
            type="email"
          />
        </Field>
        <Field invalid={refused && !pending} name="password">
          <FieldLabel>Credential</FieldLabel>
          <PasswordInput
            autoComplete="current-password"
            hideLabel="Hide credential"
            name="password"
            required
            revealLabel="Show credential"
            size="lg"
          />
          <FieldError
            issues={
              refused && !pending
                ? [{ message: credentialMismatchMessage }]
                : []
            }
            role="alert"
          />
          <FieldDescription>
            Printed once by requestport start, or issued by an operator or by
            requestport owner rotate-credential.
          </FieldDescription>
        </Field>
        <Button
          disabled={pending}
          icon={KeyRound}
          size="lg"
          type="submit"
          variant={primary ? "primary" : "secondary"}
        >
          {pending ? "Signing in…" : "Sign in with credential"}
        </Button>
      </Stack>
    </form>
  );
}

export function SignInForm({
  methods,
  resumeTo,
}: {
  methods: SignInMethods;
  resumeTo?: string;
}) {
  /*
    Where a successful sign-in lands.

    `/` for a person who came here to sign in. For a person who arrived because
    an agent asked for authorization, the authorization itself — otherwise the
    provider's request is discarded at the moment it is finally answerable,
    the consent screen is never drawn, and the agent waits on a callback that
    never comes.
  */
  const landing = resumeTo ?? AUTH_SUCCESS_PATH;
  // `useActionState` rather than a state flag inside the action: an update made
  // inside a form action runs in a transition and would not commit until the
  // request settles, so "Sending…" would never be painted.
  const [requested, submit, pending] = useActionState(
    requestMagicLink.bind(null, landing),
    false,
  );
  const status: MagicLinkStatus = pending
    ? "sending"
    : requested
      ? "sent"
      : "idle";

  async function signInWithGitHub() {
    await authClient.signIn.social({
      provider: "github",
      callbackURL: landing,
      errorCallbackURL: "/auth-error",
      newUserCallbackURL: landing,
    });
  }

  /*
    The ways in keep their order — GitHub, the emailed link, the local
    credential — and the first one offered carries the card's one primary
    button; the others are secondary.
  */
  const sections: { key: string; node: ReactNode }[] = [];
  if (methods.github) {
    sections.push({
      key: "github",
      node: (
        <Button
          icon={GitBranch}
          onClick={signInWithGitHub}
          size="lg"
          type="button"
          variant="primary"
        >
          Continue with GitHub
        </Button>
      ),
    });
  }
  if (methods.magicLink) {
    const primary = sections.length === 0;
    sections.push({
      key: "magic-link",
      node: (
        <>
          <form action={submit}>
            <Stack direction="column" gap={3}>
              <Field name="email">
                <FieldLabel>Work email</FieldLabel>
                <Input
                  autoComplete="email"
                  name="email"
                  placeholder="you@example.com"
                  required
                  size="lg"
                  type="email"
                />
                <FieldDescription>
                  We send a single-use link to an approved address.
                </FieldDescription>
              </Field>
              <Button
                disabled={status === "sending"}
                icon={Mail}
                size="lg"
                type="submit"
                variant={primary ? "primary" : "secondary"}
              >
                {status === "sending" ? "Sending…" : "Email me a sign-in link"}
              </Button>
            </Stack>
          </form>
          <p aria-live="polite" role="status">
            {getMagicLinkStatusMessage(status)}
          </p>
        </>
      ),
    });
  }
  if (methods.localCredential) {
    sections.push({
      key: "local-credential",
      node: (
        <LocalCredentialForm
          landing={landing}
          primary={sections.length === 0}
        />
      ),
    });
  }

  return (
    <Stack direction="column" gap={4}>
      {sections.map((section, index) => (
        <Fragment key={section.key}>
          {index > 0 ? <Separator /> : null}
          {section.node}
        </Fragment>
      ))}
    </Stack>
  );
}

/**
 * The way back from a lost credential, offered beside the card wherever the
 * local credential is a way in: the command a self-host's owner runs, exactly
 * as `apps/requestport` names it (`owner/rotate-credential.ts`, `PROGRAM`),
 * and what it costs, as that command's own usage says: the owner's sessions
 * and every operator credential the owner issued are revoked. The text names
 * `requestport start` because the credential is also offered on a local
 * deployment the operator CLI bootstrapped, where this command does not
 * apply. A client component because `Collapsible` is a client namespace.
 */
export function LostCredentialHelp() {
  return (
    <Collapsible.Root className="w-full">
      <Collapsible.Trigger>Lost your credential?</Collapsible.Trigger>
      <Collapsible.Panel bodyClassName="flex flex-col gap-(--cue-space-2) pt-(--cue-space-3) text-fg-muted">
        <p>
          If you run this RequestPort with requestport start, issue the owner a
          new credential on its machine. It is printed once and replaces the old
          one; the owner's sessions end, and every operator key the owner issued
          is revoked, so scripts using one need a new key. Otherwise, ask
          whoever runs it.
        </p>
        <CodeBlock code="requestport owner rotate-credential" language="sh" />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
