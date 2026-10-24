import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

/**
 * Which RequestPort project a checkout belongs to.
 *
 * Committed, and carrying no secret — the same trust level as
 * `.vercel/project.json` and `.trigger/mcp.json`, which sit beside it in these
 * repositories for the same reason. A credential answers "may I", and this file
 * answers "which project", and keeping those apart is what lets the second
 * travel with the repository while the first stays with a person.
 */
export const PROJECT_DIRECTORY = ".requestport";
export const PROJECT_FILE = "project.json";

/**
 * Whether a host is this machine, by the issuer's rule.
 *
 * Restated from `isLoopbackHostname` in `packages/auth/src/server-options.ts`,
 * which decides the http URLs a RequestPort server may be its own issuer on.
 * This package may not import that one, so the rule is written twice. Both
 * copies are held to `origin-rule.cases.json`: this one by `project.test.ts`,
 * that one by `packages/auth/src/server-options.origin-rule.test.ts`
 * (manifest-h.md §2.8.1), so a change to either is checked against the same
 * rows.
 *
 * It is wider than the redirect rule in `oauth.ts`, on purpose. That rule
 * names the three hosts this process's own listener is reached by; this one
 * names every host a self-hosted server can start on, so that whatever a
 * self-host was started at can be bound.
 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
  );
}

/**
 * What can be wrong with a server URL, as a word from a fixed set.
 *
 * A word rather than a message so that the message is written once, below,
 * and so that nothing from the URL itself can reach it: a URL refused for
 * carrying a password is exactly the one whose text must not be repeated.
 */
type ServerProblem =
  | "credentials"
  | "not-a-url"
  | "path"
  | "query-or-fragment"
  | "scheme";

const SERVER_PROBLEMS: Readonly<Record<ServerProblem, string>> = {
  credentials: "server must carry no user name or password",
  "not-a-url": "server must be an absolute URL",
  path: "server must be an origin, with no path",
  "query-or-fragment": "server must carry no query or fragment",
  scheme: "server must be https, or http on a loopback host",
};

function serverProblem(value: string): ServerProblem | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not-a-url";
  }

  // First, because this file is committed: a password here is a secret in
  // the repository, whatever else is wrong with the URL.
  if (url.username !== "" || url.password !== "") return "credentials";

  // The raw string, not `search` and `hash`: an empty query or fragment
  // (`https://host/?`, `https://host/#`) leaves both empty, and the issuer
  // check refuses those spellings too.
  if (value.includes("?") || value.includes("#")) return "query-or-fragment";

  const servable =
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  if (!servable) return "scheme";

  // The agent resources are this origin plus `/mcp` and `/api/v1`, so a path
  // here would name resources no server publishes.
  if (url.pathname !== "/") return "path";

  return undefined;
}

/**
 * Whether a checkout may be bound to this server.
 *
 * https on any host, or http on a loopback host (`localhost`, `*.localhost`,
 * 127.0.0.0/8, `[::1]`); no user name, password, query or fragment, empty or
 * not; and no path. It gives every row of `origin-rule.cases.json` that
 * row's answer, and so does the issuer check (`isServableIssuerUrl` in
 * `packages/auth/src/server-options.ts`), which
 * `server-options.origin-rule.test.ts` holds to the same table. The path is
 * this function's alone: the issuer check allows one, which is why no row of
 * that table has a path.
 */
export function isBindableServer(value: string): boolean {
  return serverProblem(value) === undefined;
}

/*
  A string's length in UTF-16 code units: what zod 4.4.3 answered for the
  client at 0.2.0, kept on zod 4.6.7. `@requestport/domain`'s
  `shared/zod-compat.ts` holds the same helper and says what moved; this
  package depends on no other workspace, so its one use keeps a copy.
*/
function utf16Max(maximum: number) {
  const check = z.maxLength(maximum);
  const def = check._zod.def;
  check._zod.check = (payload) => {
    const input = payload.value;
    if (input.length <= def.maximum) return;
    payload.issues.push({
      origin: z.core.util.getLengthableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst: check,
      continue: !def.abort,
    });
  };
  return check;
}

/**
 * `strict()` rather than the default, and that is the point of the schema.
 *
 * An unknown key is refused, so a token cannot be added to this file without
 * also editing this line — which fails the test that says a binding carries no
 * secret. Documentation asking people not to put credentials here would erode
 * under the first "just add it, we'll fix it later"; this does not.
 */
const BindingSchema = z
  .object({
    organizationId: z.uuid(),
    projectId: z.uuid(),
    projectSlug: z.string().min(1).check(utf16Max(120)),
    server: z.string().superRefine((value, context) => {
      const problem = serverProblem(value);
      if (problem !== undefined) {
        context.addIssue({ code: "custom", message: SERVER_PROBLEMS[problem] });
      }
    }),
  })
  .strict();

export type ProjectBinding = z.infer<typeof BindingSchema>;

export class ProjectBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectBindingError";
  }
}

/**
 * Walk upward for the binding, the way git looks for its own directory.
 *
 * An agent is as likely to start in `apps/web` as at the root, and a developer
 * should not have to know which. The nearest file wins, so a vendored checkout
 * inside another one binds to itself.
 */
export function findProjectFile(from: string): string | undefined {
  let directory = resolve(from);

  for (;;) {
    const candidate = join(directory, PROJECT_DIRECTORY, PROJECT_FILE);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function readProjectBinding(from: string): ProjectBinding {
  const path = findProjectFile(from);
  if (path === undefined) {
    throw new ProjectBindingError(
      `No ${PROJECT_DIRECTORY}/${PROJECT_FILE} found in ${resolve(from)} or any parent directory.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The file's contents are never echoed. It is meant to hold no secret, and
    // a malformed one is exactly the case where that may not be true yet.
    throw new ProjectBindingError(`${path} is not valid JSON.`);
  }

  const result = BindingSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) =>
        issue.code === "unrecognized_keys"
          ? `unexpected key(s): ${issue.keys.join(", ")}`
          : `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("; ");

    throw new ProjectBindingError(
      `${path} is not a valid binding — ${detail}.`,
    );
  }

  return result.data;
}

/**
 * Refuse a credential that names a different project than the checkout does.
 *
 * Both answers available here are bad — file the work against the wrong
 * project, or stop — and stopping is the one a person can correct. It catches a
 * credential for the wrong project, a `.requestport` copied between checkouts,
 * and a session that outlived the developer switching projects.
 */
export function assertBoundProject(
  binding: ProjectBinding,
  identity: Readonly<{ projectId: string }>,
): void {
  if (identity.projectId === binding.projectId) return;

  throw new ProjectBindingError(
    `This checkout is bound to project ${binding.projectId} (${binding.projectSlug}), but the credential is for project ${identity.projectId}. Refusing rather than filing work against the wrong project.`,
  );
}
