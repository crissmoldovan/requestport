import { readCiCredential } from "./ci.js";
import { type CredentialStore, createCredentialStore } from "./credentials.js";
import {
  assertBoundProject,
  type ProjectBinding,
  readProjectBinding,
} from "./project.js";

/**
 * What an agent works out before it can do anything else.
 *
 * Two questions with two different answers in two different places: the
 * checkout says *which project*, and the store or the environment says whether
 * this machine may act on it. Neither half is asked to know the other's
 * business, which is exactly why one can be committed and the other cannot.
 */
export type ConnectionSource = "environment" | "store";

export type ResolvedConnection = Readonly<
  {
    binding: ProjectBinding;
    projectId: string;
    server: string;
  } & (
    | { source: ConnectionSource; status: "ready" }
    | { status: "authorization-required" }
  )
>;

export interface ResolveOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  from?: string;
  store?: CredentialStore;
}

/**
 * The returned value carries no credential, deliberately.
 *
 * A resolution is the sort of thing that gets logged when an agent starts, and
 * a shape holding a token is one `JSON.stringify` away from a log line nobody
 * meant to write. Callers that need a token ask a token source
 * (`token-source.ts`) for one at the moment they use it, which refreshes the
 * stored credential; everyone else gets to describe what happened safely.
 */
export function resolveConnection(
  options: ResolveOptions = {},
): ResolvedConnection {
  const {
    environment = process.env,
    from = process.cwd(),
    store = createCredentialStore(),
  } = options;

  const binding = readProjectBinding(from);
  const identity = {
    binding,
    projectId: binding.projectId,
    server: binding.server,
  };

  // CI wins over anything on disk. A runner whose image happens to carry a
  // stale developer credential must still use the secret it was handed, or the
  // pipeline authenticates as somebody who left.
  if (readCiCredential(environment) !== undefined) {
    return { ...identity, source: "environment", status: "ready" };
  }

  // The `mcp` audience's credential: the resolver connects an agent to
  // `/mcp`, which refuses a token minted for any other resource.
  return store.read(binding.server, binding.projectId, "mcp") === undefined
    ? { ...identity, status: "authorization-required" }
    : { ...identity, source: "store", status: "ready" };
}

export interface VerifyOptions {
  from?: string;
  identity: Readonly<{ projectId: string }>;
}

/**
 * Hold the credential and the checkout to the same answer.
 *
 * Called after `whoami`, because that is the first moment both answers exist.
 * A mismatch means a credential for another project, a `.requestport` copied
 * between checkouts, or a session that outlived a developer switching work —
 * and filing against the wrong project is silent where refusing is not.
 */
export function verifyConnection(options: VerifyOptions): ProjectBinding {
  const binding = readProjectBinding(options.from ?? process.cwd());
  assertBoundProject(binding, options.identity);

  return binding;
}
