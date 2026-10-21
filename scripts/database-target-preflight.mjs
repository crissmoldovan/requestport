import { createHash, timingSafeEqual } from "node:crypto";

import { databaseProjectVariables } from "./hosted-deployment.mjs";

const SUCCESS_MESSAGE = "RequestPort database target verified.";
const FAILURE_MESSAGE = "RequestPort database target verification failed.";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Whether the deployment's database project is the one it expects, where the
 * hosted deployment names its project's variables (`databaseProjectVariables`
 * in `hosted-deployment.mjs`): the expected id set, and equal to the
 * deployment's own, a Preview's under `VERCEL_ENV=preview` and production's
 * otherwise. A tree that names none, as the public variant does, has no
 * project to compare, and the host and database-name digests decide alone.
 */
function projectMatches(env, isPreviewTarget) {
  if (databaseProjectVariables === null) return true;

  const expectedProjectId = env[databaseProjectVariables.expected];
  const projectId = isPreviewTarget
    ? env[databaseProjectVariables.preview]
    : env[databaseProjectVariables.production];

  return (
    Boolean(expectedProjectId) &&
    Boolean(projectId) &&
    projectId === expectedProjectId
  );
}

function verifyDatabaseTarget(env) {
  const isPreviewTarget = env.VERCEL_ENV === "preview";
  const databaseUrl = isPreviewTarget
    ? env.REQUESTPORT_PREVIEW_DATABASE_URL
    : env.DATABASE_URL;
  const expectedHostHash = env.EXPECTED_DATABASE_HOST_SHA256;
  const expectedDatabaseNameHash = env.EXPECTED_DATABASE_NAME_SHA256;

  if (
    !databaseUrl ||
    !projectMatches(env, isPreviewTarget) ||
    !expectedHostHash ||
    !SHA256_PATTERN.test(expectedHostHash) ||
    !expectedDatabaseNameHash ||
    !SHA256_PATTERN.test(expectedDatabaseNameHash)
  ) {
    return false;
  }

  try {
    const url = new URL(databaseUrl);

    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      !url.pathname.startsWith("/")
    ) {
      return false;
    }

    const actualHostHash = createHash("sha256").update(url.hostname).digest();
    const expectedHostHashBytes = Buffer.from(expectedHostHash, "hex");
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    const actualDatabaseNameHash = createHash("sha256")
      .update(databaseName)
      .digest();
    const expectedDatabaseNameHashBytes = Buffer.from(
      expectedDatabaseNameHash,
      "hex",
    );

    return (
      databaseName.length > 0 &&
      !databaseName.includes("/") &&
      timingSafeEqual(actualHostHash, expectedHostHashBytes) &&
      timingSafeEqual(actualDatabaseNameHash, expectedDatabaseNameHashBytes)
    );
  } catch {
    return false;
  }
}

if (verifyDatabaseTarget(process.env)) {
  console.log(SUCCESS_MESSAGE);
} else {
  console.error(FAILURE_MESSAGE);
  process.exitCode = 1;
}
