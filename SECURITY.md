# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's private vulnerability
reporting on this repository:

<https://github.com/crissmoldovan/requestport/security/advisories/new>

You can also reach it from the repository's **Security** tab, with the
**Report a vulnerability** button.

This is the only way to report a vulnerability. There is no security email
address. Do not report a vulnerability in a public issue, a pull request, a
discussion or anywhere else in public.

Your report is read by the project's maintainer. A useful report says:

- which release or commit you tested;
- how to reproduce the problem, step by step;
- what an attacker could do with it.

This repository does not accept outside contributions at the moment. If you
know how to fix the problem, describe the fix in your report rather than
opening a pull request.

## What this policy covers

- The code in this repository: the published `@requestport/*` and
  `requestport` packages, the command-line tool and the self-hosted server.
- The hosted service at `requestport.com`, whose
  `/.well-known/security.txt` points to this policy.

## What you can expect

- We acknowledge your report within **5 business days**.
- We aim to fix a confirmed critical vulnerability in the **next release**.

## Supported versions

RequestPort is released as `0.x`. Every package carries the same version,
each release has one tag, and the repository has one changelog.

| Version | Security fixes |
| --- | --- |
| The latest `0.x` release | Yes |
| Any earlier release | No |

A fix ships in a new release. It is not backported to earlier ones, so
upgrade to the latest release to receive it.

## Coordinated disclosure

- **Embargo.** Keep the vulnerability private for **90 days** from your
  report, or until we publish its advisory if that comes first, unless we
  agree a different date with you.
- **Advisories.** We publish each vulnerability fixed in this repository's
  code as a GitHub Security Advisory on this repository, once the release
  that fixes it is out.
- **Credit.** We credit you in the advisory, unless you ask us not to.

## Safe harbour

If you act in good faith under this policy, we will treat your research as
authorised, and we will not take legal action against you for it, or ask
anyone else to.

Acting in good faith means that you:

- test only against your own installation, or against your own account on
  the hosted service;
- do not access, change or delete other people's data, beyond the least
  needed to show the problem, and stop as soon as you reach it;
- do not disrupt the hosted service or degrade it for other users, with
  automated scanning or in any other way;
- report the problem to us privately, as above, and keep it private as
  "Coordinated disclosure" describes.

We can only speak for ourselves. This statement does not bind anyone else,
such as the providers we host on or the maintainers of our dependencies.
