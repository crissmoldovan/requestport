import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import { readDataFile, writeFileAtomic } from "./atomic-file.js";
import { ConfigurationError } from "./configuration.js";

/**
 * `init.json`, the instance marker (manifest-h.md §2.3, §2.3.1 Rule 1): the
 * first file a first start writes, holding the instance id and nothing
 * passed. Its presence is what makes a start a resume rather than a first
 * start. Later it holds the bootstrap's email and organisation, written
 * before the bootstrap runs, so that a resume never asks again or with other
 * answers, and `complete`, written once the local credential has been
 * printed. Nothing in it is secret.
 */

export const INIT_FILE = "init.json";

/**
 * 16 of `0-9a-f`: within `@requestport/db`'s instance id rule (8 to 32 of
 * `a-z` and `0-9`), which names the instance's four logins.
 */
const INSTANCE_ID = /^[0-9a-f]{16}$/u;

const BootstrapSchema = z
  .object({
    email: z.string().min(1),
    organizationSlug: z.string().min(1),
    organizationName: z.string().min(1),
  })
  .strict();

const MarkerSchema = z
  .object({
    version: z.literal(1),
    instanceId: z.string().regex(INSTANCE_ID, {
      message: "must be 16 of 0-9 and a-f",
    }),
    bootstrap: BootstrapSchema.optional(),
    complete: z.literal(true).optional(),
  })
  .strict();

export type InstanceMarker = z.output<typeof MarkerSchema>;
export type BootstrapDetails = z.output<typeof BootstrapSchema>;

export function newInstanceId(
  random: (size: number) => Buffer = randomBytes,
): string {
  return random(8).toString("hex");
}

export function parseInstanceMarker(
  value: unknown,
  file = INIT_FILE,
): InstanceMarker {
  const result = MarkerSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`${file}: ${issues}.`);
  }
  return result.data;
}

/** The data directory's `init.json`, or `undefined` before a first start writes it. */
export function readInstanceMarker(
  directory: string,
  read: (directory: string, name: string) => string | undefined = readDataFile,
): InstanceMarker | undefined {
  const text = read(directory, INIT_FILE);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigurationError(
      `${join(directory, INIT_FILE)} is not valid JSON.`,
    );
  }
  return parseInstanceMarker(value, join(directory, INIT_FILE));
}

export function writeInstanceMarker(
  directory: string,
  marker: InstanceMarker,
): InstanceMarker {
  const checked = parseInstanceMarker(marker);
  writeFileAtomic(
    directory,
    INIT_FILE,
    `${JSON.stringify(checked, null, 2)}\n`,
  );
  return checked;
}
