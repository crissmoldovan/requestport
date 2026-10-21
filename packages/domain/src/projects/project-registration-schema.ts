import { z } from "zod";

import { normalizeName } from "../shared/validation.js";
import { canonicalizeGitHubRepository } from "./project-service.js";

/**
 * `register_project` is the one REST and MCP command that is not on the
 * command bus, and there was no domain-owned schema for its input. The REST
 * route hands the envelope's `input` to `projectRegistrationRepository.register`
 * unvalidated; the repository checks it with `normalizeName` and
 * `canonicalizeGitHubRepository` and binds it to the credential's own
 * organization and project. The MCP tool validates first, with its own
 * hand-written schema in `packages/mcp/src/server.ts`, which refuses some input
 * the repository accepts (see `capability-inventory.md` in plan 13). This is
 * the domain's schema, written to the repository's rules.
 *
 * It describes; nothing parses with it yet. The repository remains the only
 * validation on the request path, and this schema is held to it by a test that
 * replays the repository's checks over a table of inputs. It validates and does
 * not normalize, so it returns the input unchanged — trimming, NFC and the
 * canonical GitHub URL are the repository's.
 *
 * Unknown keys are accepted and ignored, because the repository reads only
 * these two fields from whatever object it is given.
 */
export const projectRegistrationCommandName = "register_project";

function passes(check: (value: unknown) => unknown) {
  return (value: unknown) => {
    try {
      check(value);
      return true;
    } catch {
      return false;
    }
  };
}

export const projectRegistrationInputSchema = z
  .object({
    alias: z
      .string()
      .refine(passes(normalizeName), "Name must contain 1 to 120 characters")
      .optional()
      .meta({
        description:
          "An alias for the credential's project: 1 to 120 characters after trimming, no control characters or secret-shaped content.",
      }),
    repositoryUrl: z
      .string()
      .refine(
        passes(canonicalizeGitHubRepository),
        "GitHub repository URL is invalid",
      )
      .optional()
      .meta({
        description:
          "A GitHub repository as https://github.com/<owner>/<repository>, optionally ending .git, with no query, fragment or credentials.",
      }),
  })
  .refine(
    (value) => value.alias !== undefined || value.repositoryUrl !== undefined,
    "An alias or GitHub repository URL is required",
  );

export type ProjectRegistrationInput = z.infer<
  typeof projectRegistrationInputSchema
>;
