import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AcceptancePointer } from "./acceptance-pointer.js";

/**
 * The checked-in acceptance case table, read rather than restated.
 *
 * A case list hand-written into a spec is a chance to drift from the table CI
 * validates for every row it copies, and the drift would be silent in both
 * directions: a case the table demands and the suite never runs looks exactly
 * like a case that passed. So the suite has no case list of its own — it reads
 * this one, and `acceptance-runner-contract.test.ts` fails if it stops.
 */

export type AcceptanceViewport = Readonly<{ height: number; width: number }>;

export type AcceptanceCase = Readonly<{
  cleanupOwner: "browser-context" | "scenario-run";
  density: "compact" | "large" | "normal" | "ultra-compact";
  engine: "chromium" | "webkit";
  fixtureOwner: string;
  id: string;
  lane: "appearance" | "route-state";
  mode: "dark" | "light" | "system";
  pointer: AcceptancePointer;
  scheme: "dark" | "light";
  state: string;
  surface: string;
  theme: string;
  viewport: AcceptanceViewport;
}>;

type AcceptanceMatrix = Readonly<{
  cases: readonly AcceptanceCase[];
  engines: readonly string[];
  lanes: readonly string[];
  viewports: readonly AcceptanceViewport[];
}>;

const matrixPath = resolve(
  import.meta.dirname,
  "../../../../docs/implementation/acceptance/requestport-cue-reskin-matrix.json",
);

const acceptanceMatrix = JSON.parse(
  readFileSync(matrixPath, "utf8"),
) as AcceptanceMatrix;

export const acceptanceCases: readonly AcceptanceCase[] =
  acceptanceMatrix.cases;

/**
 * The tag `playwright.config.ts` shards on.
 *
 * The route/state project greps for it and the appearance project greps it
 * away, so the two lanes partition only while exactly one lane's titles carry
 * it. The runner puts it in a describe title, which is where the person writing
 * a case can see which shard it lands in.
 */
export const routeStateTag = "@route-state";
