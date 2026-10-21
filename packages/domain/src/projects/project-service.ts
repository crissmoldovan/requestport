import { v7 as uuidv7 } from "uuid";
import type {
  FoundationRepository,
  ProjectRepositoryRecord,
} from "../audit/audit-repository.js";
import { redactSensitiveText } from "../security/sensitive-content.js";
import {
  type CommandContext,
  validateCommandContext,
} from "../shared/context.js";
import { DomainError } from "../shared/errors.js";
import {
  hasControlCharacters,
  normalizeDescription,
  normalizeKeyPrefix,
  normalizeName,
  normalizeSlug,
  validateUuid,
  validationError,
} from "../shared/validation.js";

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const RAW_GITHUB_URL_PATTERN =
  /^https:\/\/github\.com(?::443)?\/([^/?#\\]+)\/([^/?#\\]+)$/iu;

function requireInputRecord(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("input", "Command input is invalid");
  }
  return input as Record<string, unknown>;
}

export type CanonicalGitHubRepository = {
  browseUrl: string;
  cloneUrl: string;
  repositorySlug: string;
};

export function canonicalizeGitHubRepository(
  input: unknown,
): CanonicalGitHubRepository {
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    hasControlCharacters(input) ||
    input.includes("%") ||
    !RAW_GITHUB_URL_PATTERN.test(input)
  ) {
    throw validationError("repositoryUrl", "GitHub repository URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw validationError("repositoryUrl", "GitHub repository URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw validationError("repositoryUrl", "GitHub repository URL is invalid");
  }
  const path = url.pathname.slice(1);
  const segments = path.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw validationError("repositoryUrl", "GitHub repository URL is invalid");
  }
  const [owner, repositoryInput] = segments as [string, string];
  const repository = repositoryInput.endsWith(".git")
    ? repositoryInput.slice(0, -4)
    : repositoryInput;
  if (
    !GITHUB_OWNER_PATTERN.test(owner) ||
    owner.includes("--") ||
    !GITHUB_REPOSITORY_PATTERN.test(repository) ||
    repository === "." ||
    repository === ".." ||
    repository.endsWith(".git")
  ) {
    throw validationError("repositoryUrl", "GitHub repository URL is invalid");
  }
  const repositorySlug = `${owner}/${repository}`;
  const browseUrl = `https://github.com/${repositorySlug}`;
  return { browseUrl, cloneUrl: `${browseUrl}.git`, repositorySlug };
}

export class ProjectService {
  constructor(private readonly repository: FoundationRepository) {}

  async create(
    context: CommandContext,
    input: {
      organizationId: string;
      name: string;
      slug: string;
      keyPrefix: string;
      description?: string | null;
      repositoryUrl?: string | null;
    },
  ) {
    validateCommandContext(context);
    if (context.actor.type === "unauthenticated") {
      throw new DomainError("unauthenticated", "Authentication is required");
    }
    if (context.actor.type !== "user") {
      throw new DomainError("forbidden", "A human user is required");
    }
    const actor = context.actor;
    const values = requireInputRecord(input);
    const organizationId = validateUuid(
      values.organizationId,
      "organizationId",
    );
    const name = normalizeName(values.name);
    const slug = normalizeSlug(values.slug);
    const keyPrefix = normalizeKeyPrefix(values.keyPrefix);
    const description = normalizeDescription(values.description);
    const canonicalRepository =
      values.repositoryUrl === undefined || values.repositoryUrl === null
        ? null
        : canonicalizeGitHubRepository(values.repositoryUrl);

    return this.repository.transaction(async (tx) => {
      const { organization, membership } =
        await tx.findOrganizationAuthorization(organizationId, actor.userId);
      if (organization?.status !== "active") {
        throw new DomainError(
          "forbidden",
          "An active organization is required",
        );
      }
      if (
        membership?.status !== "active" ||
        !(["owner", "admin"] as string[]).includes(membership.role)
      ) {
        throw new DomainError(
          "forbidden",
          "Organization administration is required",
        );
      }
      const project = await tx.createProject({
        organizationId,
        name,
        slug,
        keyPrefix,
        description,
      });
      let repository: ProjectRepositoryRecord | null = null;
      if (canonicalRepository) {
        repository = await tx.createProjectRepository({
          organizationId,
          projectId: project.id,
          ...canonicalRepository,
        });
      }
      await tx.appendAuditRecord({
        organizationId,
        actor,
        action: "project.created",
        targetType: "project",
        targetId: project.id,
        reason: "Project created",
        fieldNames: canonicalRepository
          ? ["name", "slug", "keyPrefix", "description", "repositoryUrl"]
          : ["name", "slug", "keyPrefix", "description"],
        correlationId: context.correlationId,
      });
      await tx.appendDomainEvent({
        id: uuidv7(),
        type: "project.registered.v1",
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        organizationId,
        projectId: project.id,
        aggregateType: "project",
        aggregateId: project.id,
        aggregateVersion: project.version,
        actor: { type: "user", id: actor.userId },
        correlationId: context.correlationId,
        causationId: context.correlationId,
        data: {
          projectId: project.id,
          name: redactSensitiveText(project.name),
          slug: project.slug,
          keyPrefix: project.keyPrefix,
          status: project.status,
        },
        links: {},
      });
      return { project, repository };
    });
  }
}
